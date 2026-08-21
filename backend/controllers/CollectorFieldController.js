/**
 * CollectorFieldController (LAPANGAN)
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint sisi kolektor (role 'collector') untuk halaman lapangan /collect/field:
 *   - GET  /api/field/me            ringkasan + profil kolektor login
 *   - GET  /api/field/tasks         daftar kunjungan (assignment) milik kolektor
 *   - POST /api/field/checkin       check-in GPS + foto lokasi/rumah
 *   - POST /api/field/visit-result  simpan hasil kunjungan (non-payment)
 *   - POST /api/field/pay           catat pembayaran (lunas / partial)
 *   - POST /api/field/send-link     kirim payment link permanen via WA
 *
 * Prinsip pembayaran lapangan (mirror dari PaymentController.recordPayment,
 * versi ringkas khusus collection):
 *   1. Buat Payment (payment_method='field_collection', collected_by=kolektor,
 *      assignment_id terisi).
 *   2. LUNAS  → invoice.status='paid', advance due_date pelanggan +1 bulan,
 *               status pelanggan 'active', auto-restore MikroTik bila terisolir.
 *      PARTIAL→ invoice tetap 'paid' utk periode ini (kebijakan: sisa di-carry),
 *               customer.carry_over_amount += sisa, due_date tetap advance.
 *   3. cash_held kolektor += jumlah diterima.
 *   4. assignment.status = 'paid' / 'partial_paid', amount_collected & carry_over
 *      terisi, collected_at = now.
 *
 * Semua uang Rupiah penuh.
 */
const { Op } = require('sequelize');
const moment = require('moment');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const {
  sequelize, CollectionAssignment, CollectorProfile, Customer, Invoice,
  Payment, Package, User, Keuangan
} = require('../models');

function addOneMonthKeepDay(dateInput) {
  if (!dateInput) return null;
  const m = moment(dateInput);
  if (!m.isValid()) return null;
  return m.add(1, 'month').format('YYYY-MM-DD');
}

// Status assignment yang masih perlu dikunjungi (tampil di daftar tugas aktif).
const OPEN_STATUSES = ['assigned', 'in_progress', 'not_home', 'promise_to_pay'];

class CollectorFieldController {
  // Pastikan user adalah kolektor; kembalikan profilnya (auto-create bila belum ada).
  async _profile(userId) {
    let profile = await CollectorProfile.findOne({ where: { user_id: userId } });
    if (!profile) {
      profile = await CollectorProfile.create({ user_id: userId, commission_type: 'flat', commission_value: 5000 });
    }
    return profile;
  }

  // ── Ringkasan kolektor login ──────────────────────────────────────
  async me(req, res) {
    try {
      const uid = req.user.id;
      const profile = await this._profile(uid);

      // Hitung agregat tugas milik kolektor (periode berjalan & keseluruhan aktif).
      const rows = await CollectionAssignment.findAll({
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'cnt'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_due')), 0), 'sum_due'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_collected')), 0), 'sum_col']
        ],
        where: { collector_id: uid },
        group: ['status'],
        raw: true
      });

      let totalTask = 0, totalDue = 0, totalCollected = 0, paidCount = 0, promiseCount = 0, openCount = 0;
      for (const r of rows) {
        const cnt = parseInt(r.cnt, 10) || 0;
        totalTask += cnt;
        totalDue += parseFloat(r.sum_due) || 0;
        totalCollected += parseFloat(r.sum_col) || 0;
        if (r.status === 'paid' || r.status === 'partial_paid') paidCount += cnt;
        if (r.status === 'promise_to_pay') promiseCount += cnt;
        if (OPEN_STATUSES.includes(r.status)) openCount += cnt;
      }

      res.json({
        success: true,
        data: {
          name: req.user.name,
          profile: {
            region: profile.region,
            commission_type: profile.commission_type,
            commission_value: parseFloat(profile.commission_value),
            cash_held: parseFloat(profile.cash_held)
          },
          summary: {
            total_task: totalTask,
            total_due: totalDue,
            total_collected: totalCollected,
            outstanding: Math.max(totalDue - totalCollected, 0),
            paid_count: paidCount,
            promise_count: promiseCount,
            open_count: openCount,
            cash_on_hand: parseFloat(profile.cash_held)
          }
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Profil: ambil data untuk halaman Manage Profile ──────────────
  async profile(req, res) {
    try {
      const uid = req.user.id;
      const user = await User.findByPk(uid, { attributes: ['id', 'name', 'email', 'phone', 'avatar'] });
      const profile = await this._profile(uid);
      res.json({
        success: true,
        data: {
          name: user?.name || req.user.name,
          email: user?.email || null,
          avatar: user?.avatar || null,
          // Nomor telepon: prioritas profil kolektor, fallback ke user.
          phone: profile.phone || user?.phone || '',
          region: profile.region || null,
          commission_type: profile.commission_type,
          commission_value: parseFloat(profile.commission_value)
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Ubah nomor telepon ────────────────────────────────────────────
  async updatePhone(req, res) {
    try {
      const uid = req.user.id;
      let phone = (req.body.phone || '').toString().trim();
      // Normalisasi sederhana: hanya digit, +, spasi, strip.
      if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) {
        return res.status(400).json({ success: false, message: 'Format nomor telepon tidak valid' });
      }
      const profile = await this._profile(uid);
      await profile.update({ phone: phone || null });
      // Sinkronkan juga ke User agar konsisten.
      try { await User.update({ phone: phone || null }, { where: { id: uid } }); } catch (_) {}
      res.json({ success: true, message: 'Nomor telepon diperbarui', data: { phone: phone || '' } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Ubah sandi ────────────────────────────────────────────────────
  async changePassword(req, res) {
    try {
      const uid = req.user.id;
      const { current_password, new_password } = req.body;
      if (!current_password || !new_password) {
        return res.status(400).json({ success: false, message: 'Sandi lama & baru wajib diisi' });
      }
      if (String(new_password).length < 6) {
        return res.status(400).json({ success: false, message: 'Sandi baru minimal 6 karakter' });
      }
      const user = await User.findByPk(uid);
      if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

      const ok = await user.validatePassword(String(current_password));
      if (!ok) return res.status(400).json({ success: false, message: 'Sandi lama salah' });

      // Hook beforeUpdate akan otomatis hash saat field password berubah.
      user.password = String(new_password);
      await user.save();
      res.json({ success: true, message: 'Sandi berhasil diubah' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Performa collection kolektor ──────────────────────────────────
  async performance(req, res) {
    try {
      const uid = req.user.id;
      const profile = await this._profile(uid);
      const ctype = profile.commission_type || 'flat';
      const cval  = parseFloat(profile.commission_value || 0);

      // Agregat keseluruhan (semua periode) per status.
      const rows = await CollectionAssignment.findAll({
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'cnt'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_due')), 0), 'sum_due'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_collected')), 0), 'sum_col']
        ],
        where: { collector_id: uid },
        group: ['status'],
        raw: true
      });

      let totalTask = 0, totalDue = 0, totalCollected = 0, paidCount = 0, openCount = 0;
      for (const r of rows) {
        const cnt = parseInt(r.cnt, 10) || 0;
        totalTask += cnt;
        totalDue += parseFloat(r.sum_due) || 0;
        if (r.status === 'paid' || r.status === 'partial_paid') {
          paidCount += cnt;
          totalCollected += parseFloat(r.sum_col) || 0;
        }
        if (OPEN_STATUSES.includes(r.status)) openCount += cnt;
      }

      // Komisi total estimasi (keseluruhan periode).
      let commission = 0;
      if (ctype === 'flat') commission = cval * paidCount;
      else if (ctype === 'percent') commission = Math.round(totalCollected * cval / 100);

      // Breakdown 6 bulan terakhir.
      const monthly = await CollectionAssignment.findAll({
        attributes: [
          'period_year', 'period_month',
          [sequelize.fn('SUM', sequelize.literal(`CASE WHEN status IN ('paid','partial_paid') THEN 1 ELSE 0 END`)), 'paid_count'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.literal(`CASE WHEN status IN ('paid','partial_paid') THEN amount_collected ELSE 0 END`)), 0), 'collected']
        ],
        where: { collector_id: uid },
        group: ['period_year', 'period_month'],
        order: [['period_year', 'DESC'], ['period_month', 'DESC']],
        limit: 6,
        raw: true
      });

      const monthlyOut = monthly.map(m => {
        const pc = parseInt(m.paid_count, 10) || 0;
        const col = parseFloat(m.collected) || 0;
        let comm = 0;
        if (ctype === 'flat') comm = cval * pc;
        else if (ctype === 'percent') comm = Math.round(col * cval / 100);
        return {
          year: m.period_year, month: m.period_month,
          paid_count: pc, collected: col, commission: comm
        };
      }).reverse();

      // Success rate = paid / total task.
      const successRate = totalTask > 0 ? Math.round((paidCount / totalTask) * 100) : 0;

      res.json({
        success: true,
        data: {
          commission_type: ctype,
          commission_value: cval,
          totals: {
            total_task: totalTask,
            paid_count: paidCount,
            open_count: openCount,
            collected: totalCollected,
            outstanding: Math.max(totalDue - totalCollected, 0),
            commission: commission,
            success_rate: successRate,
            cash_on_hand: parseFloat(profile.cash_held || 0)
          },
          monthly: monthlyOut
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Daftar kunjungan milik kolektor ───────────────────────────────
  async tasks(req, res) {
    try {
      const uid = req.user.id;
      const { status, search, scope } = req.query;
      const where = { collector_id: uid };

      if (status) where.status = status;
      else if (scope === 'open') where.status = { [Op.in]: OPEN_STATUSES };
      // scope 'all' → tanpa filter status

      const customerWhere = search ? {
        [Op.or]: [
          { name: { [Op.like]: '%' + search + '%' } },
          { customer_id: { [Op.like]: '%' + search + '%' } }
        ]
      } : undefined;

      const rows = await CollectionAssignment.findAll({
        where,
        include: [
          {
            model: Customer, as: 'customer',
            attributes: ['id', 'customer_id', 'name', 'phone', 'address', 'latitude', 'longitude',
                         'regency', 'district', 'village', 'public_link_token'],
            where: customerWhere, required: !!search
          },
          { model: Invoice, as: 'invoice', attributes: ['id', 'invoice_number', 'total', 'status', 'due_date'] }
        ],
        order: [['status', 'ASC'], ['scheduled_date', 'ASC']]
      });

      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // Helper: ambil assignment milik kolektor (guard kepemilikan).
  async _ownedAssignment(assignmentId, userId, t) {
    const a = await CollectionAssignment.findByPk(assignmentId, {
      include: [
        { model: Customer, as: 'customer', include: [{ model: Package, as: 'package' }] },
        { model: Invoice, as: 'invoice' }
      ],
      transaction: t
    });
    if (!a) throw new Error('Tugas tidak ditemukan');
    if (a.collector_id !== userId) throw new Error('Tugas ini bukan milik Anda');
    return a;
  }

  // ── Check-in GPS + foto ───────────────────────────────────────────
  // ── Lihat foto bukti pembayaran milik tugas sendiri ──────────────
  async paymentProof(req, res) {
    try {
      const uid = req.user.id;
      const id = parseInt(req.params.id, 10);
      const a = await CollectionAssignment.findByPk(id);
      if (!a) return res.status(404).json({ success: false, message: 'Tugas tidak ditemukan' });
      if (a.collector_id !== uid) return res.status(403).json({ success: false, message: 'Bukan tugas Anda' });

      let filename = a.payment_proof || null;
      // Fallback: parse dari notes payment terkait (proof:<file>).
      if (!filename) {
        const pay = await Payment.findOne({ where: { assignment_id: id }, order: [['id', 'DESC']] });
        if (pay && pay.notes) {
          const m = pay.notes.match(/proof:([A-Za-z0-9._-]+)/);
          if (m) filename = m[1];
        }
      }
      if (!filename) return res.status(404).json({ success: false, message: 'Bukti pembayaran tidak tersedia' });
      if (/[\/\\]/.test(filename) || filename.includes('..')) {
        return res.status(400).json({ success: false, message: 'Nama file tidak valid' });
      }
      const abs = path.join(__dirname, '..', '..', 'uploads/payment_proofs/', filename);
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, message: 'File bukti tidak ada di server' });
      return res.sendFile(abs);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async checkin(req, res) {
    try {
      const uid = req.user.id;
      const { assignment_id, lat, lng } = req.body;
      const a = await this._ownedAssignment(parseInt(assignment_id, 10), uid);

      const patch = { visited_at: new Date() };
      if (lat) patch.visit_lat = parseFloat(lat);
      if (lng) patch.visit_lng = parseFloat(lng);
      if (req.files?.photo_location?.[0]) patch.photo_location = 'payment_proofs/' + req.files.photo_location[0].filename;
      if (req.files?.photo_house?.[0])    patch.photo_house    = 'payment_proofs/' + req.files.photo_house[0].filename;
      // Hanya naikkan ke in_progress kalau masih assigned (jangan turunkan status lain).
      if (a.status === 'assigned') patch.status = 'in_progress';

      await a.update(patch);
      res.json({ success: true, message: 'Check-in tersimpan.', data: { status: a.status } });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── Hasil kunjungan non-pembayaran ────────────────────────────────
  // not_home / refused / promise_to_pay / request_termination
  async visitResult(req, res) {
    try {
      const uid = req.user.id;
      const { assignment_id, result, promise_date, note, lat, lng } = req.body;
      const ALLOWED = ['not_home', 'refused', 'promise_to_pay', 'request_termination', 'in_progress'];
      if (!ALLOWED.includes(result)) {
        return res.status(400).json({ success: false, message: 'Hasil kunjungan tidak valid' });
      }
      const a = await this._ownedAssignment(parseInt(assignment_id, 10), uid);

      const patch = { status: result, visited_at: a.visited_at || new Date(), note: note || a.note };
      if (lat) patch.visit_lat = parseFloat(lat);
      if (lng) patch.visit_lng = parseFloat(lng);
      if (result === 'promise_to_pay') {
        if (!promise_date) return res.status(400).json({ success: false, message: 'Tanggal janji bayar wajib diisi' });
        patch.promise_date = promise_date;
      }
      await a.update(patch);
      res.json({ success: true, message: 'Hasil kunjungan tersimpan.', data: { status: result } });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── Catat pembayaran lapangan (lunas / partial) ───────────────────
  async pay(req, res) {
    const t = await sequelize.transaction();
    try {
      const uid = req.user.id;
      const { assignment_id, amount, payment_date, notes, send_wa } = req.body;

      const a = await this._ownedAssignment(parseInt(assignment_id, 10), uid, t);
      const invoice  = a.invoice;
      const customer = a.customer;
      if (!invoice)  throw new Error('Invoice tidak ditemukan untuk tugas ini');
      if (!customer) throw new Error('Pelanggan tidak ditemukan untuk tugas ini');

      // Foto bukti (opsional) — disimpan di payment_proofs, path dilekatkan ke notes.
      let payNotes = notes || null;
      let proofFilename = null;
      if (req.file && req.file.filename) {
        proofFilename = req.file.filename;
        const proofRef = 'proof:' + proofFilename;
        payNotes = payNotes ? (payNotes + ' | ' + proofRef) : proofRef;
      }

      // Sudah lunas? cegah double-pay.
      if (invoice.status === 'paid') {
        await t.rollback();
        return res.status(409).json({ success: false, message: 'Invoice ini sudah lunas.' });
      }

      // Idempotensi: tugas yang sudah berstatus dibayar tidak boleh diproses lagi
      // (mencegah double-submit dari tap ganda / retry saat sinyal lambat).
      if (a.status === 'paid' || a.status === 'partial_paid') {
        await t.rollback();
        return res.status(409).json({ success: false, message: 'Pembayaran untuk tugas ini sudah tercatat.' });
      }

      const payAmount = parseFloat(String(amount).replace(/[.,]/g, '')) || parseFloat(amount);
      if (!payAmount || payAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid' });
      }
      const invoiceTotal = parseFloat(invoice.total);
      const isPartial = payAmount < invoiceTotal;
      const carryOver = isPartial ? Math.max(invoiceTotal - payAmount, 0) : 0;
      const payDate = payment_date || moment().format('YYYY-MM-DD');

      // 1) Payment record (field_collection)
      const payment = await Payment.create({
        invoice_id: invoice.id,
        amount: payAmount,
        payment_method: 'field_collection',
        payment_date: payDate,
        reference_number: isPartial ? `PARTIAL (sisa Rp${carryOver.toLocaleString('id-ID')})` : null,
        recorded_by: uid,
        collected_by: uid,
        assignment_id: a.id,
        notes: payNotes
      }, { transaction: t });

      // 2) Invoice → paid untuk periode ini (kebijakan partial: sisa di-carry).
      await invoice.update({ status: 'paid', paid_date: payDate }, { transaction: t });

      // 3) Advance due_date pelanggan + status active + carry-over (bila partial).
      const baseDue = customer.due_date || invoice.due_date || payDate;
      const nextDue = addOneMonthKeepDay(baseDue);
      const custPatch = {
        status: 'active',
        due_date: nextDue || customer.due_date,
        installation_date: customer.installation_date || payDate
      };
      const newDueDay = moment(nextDue || baseDue).date();
      if (newDueDay >= 1 && newDueDay <= 28) custPatch.billing_date = newDueDay;
      if (carryOver > 0) {
        custPatch.carry_over_amount = parseFloat(customer.carry_over_amount || 0) + carryOver;
      }
      await customer.update(custPatch, { transaction: t });

      // 4) cash_held kolektor += diterima
      const profile = await CollectorProfile.findOne({ where: { user_id: uid }, transaction: t });
      if (profile) {
        await profile.update({ cash_held: parseFloat(profile.cash_held || 0) + payAmount }, { transaction: t });
      }

      // 4b) Sync ke Keuangan (pemasukan) — agar pembayaran Cash Collect masuk
      //     ke modul Keuangan & Laporan Keuangan (idempotent via ref_number).
      if (Keuangan) {
        try {
          const ref = `PAY-${payment.id}`;
          const exist = await Keuangan.findOne({ where: { type: 'pemasukan', ref_number: ref }, transaction: t });
          if (!exist) {
            await Keuangan.create({
              type:        'pemasukan',
              category:    'Pembayaran Pelanggan',
              description: `Pembayaran ${customer.name} (${customer.customer_id})`,
              amount:      payAmount,
              date:        payDate,
              ref_number:  ref,
              notes:       `Invoice: ${invoice.invoice_number || '-'} | Metode: Cash Collect (field)`
                           + (isPartial ? ` | PARTIAL (sisa Rp${carryOver.toLocaleString('id-ID')})` : ''),
              recorded_by: uid
            }, { transaction: t });
          }
        } catch (e) {
          // Jangan gagalkan pembayaran hanya karena sync Keuangan; cukup catat.
          console.error('[Field] Sync Keuangan gagal:', e.message);
        }
      }

      // 5) assignment result
      const assignPatch = {
        status: isPartial ? 'partial_paid' : 'paid',
        amount_collected: payAmount,
        carry_over: carryOver,
        collected_at: new Date()
      };
      // Simpan koordinat GPS saat catat bayar (bila dikirim & kolom tersedia).
      const payLat = parseFloat(req.body.pay_lat);
      const payLng = parseFloat(req.body.pay_lng);
      if (isFinite(payLat) && isFinite(payLng)) {
        if (a.constructor.rawAttributes.pay_lat) assignPatch.pay_lat = payLat;
        if (a.constructor.rawAttributes.pay_lng) assignPatch.pay_lng = payLng;
      }
      // Simpan nama file bukti bila kolom payment_proof tersedia (migrasi opsional).
      if (proofFilename && a.constructor.rawAttributes.payment_proof) {
        assignPatch.payment_proof = proofFilename;
      }
      await a.update(assignPatch, { transaction: t });

      await t.commit();

      // ── Auto-restore MikroTik bila pelanggan terisolir (after commit) ──
      if (customer.isolir_status === 'isolated' || customer.isolir_status === 'restoring') {
        const restoreId = customer.id, restoreCode = customer.customer_id;
        setImmediate(async () => {
          try {
            const IsolirSvc = require('../services/IsolirService');
            await IsolirSvc.restoreAfterPayment(restoreId);
          } catch (e) {
            console.error(`[Field] Auto-restore gagal customer ${restoreCode}:`, e.message);
          }
        });
      }

      // ── WA struk (background) — pakai GatewayService + template payment_confirm
      if ((send_wa === true || send_wa === '1' || send_wa === 'true') && customer.phone) {
        const ctx = {
          phone: customer.phone, customerName: customer.name, customerId: customer.customer_id,
          packageName: customer.package?.name, amount: payAmount, payDate,
          dueDate: custPatch.due_date, invoiceNumber: invoice.invoice_number,
          collectorName: req.user.name, isPartial, carryOver
        };
        setImmediate(() => this._sendReceiptWA(ctx).catch(() => {}));
      }

      res.json({
        success: true,
        message: isPartial
          ? `Pembayaran sebagian dicatat. Sisa Rp${carryOver.toLocaleString('id-ID')} di-carry ke bulan depan.`
          : 'Pembayaran lunas dicatat.',
        data: {
          payment_id: payment.id, partial: isPartial, carry_over: carryOver,
          assignment_status: isPartial ? 'partial_paid' : 'paid'
        }
      });
    } catch (e) {
      try { await t.rollback(); } catch (_) {}
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // Kirim struk WA (dipakai background). Best-effort, swallow error.
  async _sendReceiptWA(ctx) {
    const GatewayService = require('../services/GatewayService');
    const session = await GatewayService.getDefaultSendingSession();
    if (!session) return;
    await GatewayService.warmSession(session.session_id);
    if (!GatewayService.isConnected(session.session_id)) return;

    let companyName = '';
    try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}

    const fmtAmt = 'Rp ' + parseFloat(ctx.amount).toLocaleString('id-ID');
    const fmtDue = moment(ctx.dueDate).format('DD/MM/YYYY');
    const fmtPay = moment(ctx.payDate).format('DD/MM/YYYY');
    const lines = [
      `*Konfirmasi Pembayaran*${companyName ? ' — ' + companyName : ''}`,
      ``,
      `Halo ${ctx.customerName},`,
      ctx.isPartial
        ? `Pembayaran *sebagian* sebesar ${fmtAmt} telah kami terima.`
        : `Pembayaran *LUNAS* sebesar ${fmtAmt} telah kami terima.`,
      ``,
      `No. Invoice : ${ctx.invoiceNumber}`,
      `Tgl Bayar   : ${fmtPay}`,
      ctx.isPartial ? `Sisa Tagihan: Rp ${Number(ctx.carryOver).toLocaleString('id-ID')} (ditagih bln depan)` : null,
      `Jatuh Tempo Berikutnya: ${fmtDue}`,
      `Ditagih oleh: ${ctx.collectorName}`,
      ``,
      `Terima kasih atas pembayaran Anda.`
    ].filter(Boolean);
    await GatewayService.sendMessage(session.session_id, ctx.phone, lines.join('\n'), null);
  }

  // ── Kirim payment link permanen via WA ────────────────────────────
  async sendLink(req, res) {
    try {
      const uid = req.user.id;
      const { assignment_id } = req.body;
      const a = await this._ownedAssignment(parseInt(assignment_id, 10), uid);
      const customer = a.customer;
      if (!customer.phone) return res.status(400).json({ success: false, message: 'Pelanggan tidak punya nomor WhatsApp' });

      const { generateCustomerLinkToken, buildCustomerLink } = require('../utils/templateHelper');
      // Pastikan token permanen ada.
      let token = customer.public_link_token;
      if (!token) {
        for (let i = 0; i < 5; i++) {
          const cand = generateCustomerLinkToken();
          const exists = await Customer.findOne({ where: { public_link_token: cand } });
          if (!exists) { token = cand; break; }
        }
        if (token) { customer.public_link_token = token; await customer.save(); }
      }
      if (!token) return res.status(500).json({ success: false, message: 'Gagal membuat link pembayaran' });
      const url = buildCustomerLink(token);

      // Kirim WA berisi link.
      const GatewayService = require('../services/GatewayService');
      const session = await GatewayService.getDefaultSendingSession();
      let sent = false;
      if (session) {
        await GatewayService.warmSession(session.session_id);
        if (GatewayService.isConnected(session.session_id)) {
          const amt = 'Rp ' + parseFloat(a.amount_due).toLocaleString('id-ID');
          const msg = [
            `Halo ${customer.name},`,
            ``,
            `Berikut link pembayaran tagihan Anda sebesar ${amt}:`,
            url,
            ``,
            `Silakan bayar melalui link di atas. Terima kasih.`
          ].join('\n');
          await GatewayService.sendMessage(session.session_id, customer.phone, msg, null);
          sent = true;
        }
      }

      res.json({
        success: true,
        message: sent ? 'Link pembayaran terkirim via WhatsApp.' : 'Link dibuat, tapi WA gateway belum terhubung. Salin link manual.',
        data: { url, sent }
      });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }
}

module.exports = new CollectorFieldController();
module.exports.OPEN_STATUSES = OPEN_STATUSES;
