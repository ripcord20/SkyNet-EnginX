const { Keuangan, User, RecurringExpense, sequelize } = require('../models');
const { Op }   = require('sequelize');
const moment   = require('moment');

const TYPE_LABEL = {
  pemasukan:  'Pemasukan',
  pengeluaran:'Pengeluaran',
  hutang:     'Hutang',
  piutang:    'Piutang',
  modal:      'Modal'
};

class KeuanganController {


  // ── POST /api/keuangan/sync-payments ──────────────────────
  // Impor pembayaran pelanggan bulan ini sebagai Pemasukan
  async syncPayments(req, res) {
    try {
      const month = parseInt(req.query.month) || moment().month() + 1;
      const year  = parseInt(req.query.year)  || moment().year();
      const start = moment(`${year}-${String(month).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
      const end   = moment(start).endOf('month').format('YYYY-MM-DD');

      // Ambil semua pembayaran bulan ini dengan data customer & invoice
      const payRows = await sequelize.query(
        `SELECT p.id AS payment_id,
                p.amount,
                p.payment_date,
                p.payment_method,
                p.reference_number,
                i.invoice_number,
                c.name AS cust_name,
                c.customer_id AS cid
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN customers c ON c.id = i.customer_id
         WHERE p.payment_date BETWEEN :start AND :end
         ORDER BY p.payment_date ASC`,
        { replacements:{start,end}, type: sequelize.QueryTypes.SELECT }
      );

      if (!payRows.length)
        return res.json({ success:true, message:'Tidak ada pembayaran di bulan ini', synced:0 });

      // Cek yang sudah pernah di-sync (ref_number format: PAY-{payment_id})
      const existingRefs = await Keuangan.findAll({
        where: {
          type: 'pemasukan',
          ref_number: { [require('sequelize').Op.in]: payRows.map(p=>`PAY-${p.payment_id}`) }
        },
        attributes: ['ref_number'],
        raw: true
      });
      const existingSet = new Set(existingRefs.map(r=>r.ref_number));

      // Filter yang belum di-sync
      const toSync = payRows.filter(p => !existingSet.has(`PAY-${p.payment_id}`));

      if (!toSync.length)
        return res.json({ success:true, message:'Semua pembayaran sudah tersinkronisasi', synced:0 });

      const { methodLabel: METHOD_LABEL_FN } = require('../utils/paymentMethodLabel');

      // Bulk insert
      const records = toSync.map(p => ({
        type:        'pemasukan',
        category:    'Pembayaran Pelanggan',
        description: `Pembayaran ${p.cust_name} (${p.cid})`,
        amount:      parseFloat(p.amount),
        date:        p.payment_date,
        ref_number:  `PAY-${p.payment_id}`,
        notes:       `Invoice: ${p.invoice_number || '-'} | Metode: ${METHOD_LABEL_FN(p.payment_method)}${p.reference_number ? ' | Ref: '+p.reference_number : ''}`,
        recorded_by: req.user?.id || null
      }));

      await Keuangan.bulkCreate(records);

      // Setelah pemasukan bertambah, perbarui pembukuan PNBP periode ini
      // (bila PNBP aktif) agar nilainya selalu sinkron dengan pendapatan.
      try { await this._materializePnbpExpense(month, year); } catch(_) {}

      res.json({
        success: true,
        message: `Berhasil sinkronisasi ${records.length} pembayaran sebagai Pemasukan`,
        synced:  records.length
      });
    } catch(e) {
      console.error('[Keuangan.syncPayments]', e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── GET /api/keuangan/summary ──────────────────────────────
  async summary(req, res) {
    try {
      const isYear = String(req.query.period || '').toLowerCase() === 'year';
      const month = parseInt(req.query.month) || moment().month() + 1;
      const year  = parseInt(req.query.year)  || moment().year();
      // Mode tahunan → rentang 1 Jan s/d 31 Des; mode bulanan → 1 bulan
      const start = isYear
        ? moment(`${year}-01-01`).startOf('year').format('YYYY-MM-DD')
        : moment(`${year}-${String(month).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
      const end   = isYear
        ? moment(`${year}-12-31`).endOf('year').format('YYYY-MM-DD')
        : moment(start).endOf('month').format('YYYY-MM-DD');

      const rows = await sequelize.query(
        `SELECT type,
                COALESCE(SUM(amount),0) AS total,
                COUNT(*) AS cnt
         FROM keuangan
         WHERE date BETWEEN :start AND :end
         GROUP BY type`,
        { replacements:{start,end}, type: sequelize.QueryTypes.SELECT }
      );

      // Aggregate per type
      const agg = { pemasukan:0, pengeluaran:0, hutang:0, piutang:0, modal:0 };
      const cnt = { pemasukan:0, pengeluaran:0, hutang:0, piutang:0, modal:0 };
      (Array.isArray(rows) ? rows : [rows]).filter(Boolean).forEach(r => {
        if (agg[r.type] !== undefined) {
          agg[r.type]  = parseFloat(r.total);
          cnt[r.type]  = parseInt(r.cnt);
        }
      });

      // Outstanding hutang & piutang (all time, belum lunas)
      const [hutangOut] = await sequelize.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM keuangan WHERE type='hutang' AND (status='belum_lunas' OR status='cicilan')`,
        { type: sequelize.QueryTypes.SELECT }
      ) || [{}];
      const [piutangOut] = await sequelize.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM keuangan WHERE type='piutang' AND (status='belum_lunas' OR status='cicilan')`,
        { type: sequelize.QueryTypes.SELECT }
      ) || [{}];

      // Cash flow = pemasukan + modal_masuk - pengeluaran (bulan ini)
      const cashflow = agg.pemasukan + agg.modal - agg.pengeluaran;

      // 6 month trend
      const trend = [];
      for (let i = 5; i >= 0; i--) {
        const ts = moment().year(year).month(month - 1).subtract(i, 'months');
        const s  = ts.clone().startOf('month').format('YYYY-MM-DD');
        const e  = ts.clone().endOf('month').format('YYYY-MM-DD');
        const trRows = await sequelize.query(
          `SELECT
             COALESCE(SUM(CASE WHEN type='pemasukan' THEN amount ELSE 0 END),0) AS pemasukan,
             COALESCE(SUM(CASE WHEN type='pengeluaran' THEN amount ELSE 0 END),0) AS pengeluaran
           FROM keuangan WHERE date BETWEEN :s AND :e`,
          { replacements:{s,e}, type: sequelize.QueryTypes.SELECT }
        );
        const tr = (Array.isArray(trRows) ? trRows[0] : trRows) || {};
        trend.push({
          label:      ts.format('MMM'),
          pemasukan:  parseFloat(tr.pemasukan||0),
          pengeluaran:parseFloat(tr.pengeluaran||0)
        });
      }

      // Category breakdown (pengeluaran) this month
      const catRows = await sequelize.query(
        `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM keuangan
         WHERE type='pengeluaran' AND date BETWEEN :start AND :end
         GROUP BY category ORDER BY total DESC LIMIT 8`,
        { replacements:{start,end}, type: sequelize.QueryTypes.SELECT }
      );

      // ── PNBP ISP (BHP Telekomunikasi + Kontribusi USO) ──────
      // Dasar = pendapatan BASIS PERIODE INVOICE (seragam dgn dashboard Finance):
      // pembayaran atas invoice periode terpilih, kapan pun dibayar. Bukan basis
      // kas (keuangan.date), supaya pembayaran periode lain tidak ikut terhitung.
      // Persentase diatur via AppSetting (key pnbp_*); default BHP 0,5%, USO 1,25%.
      let pnbpBase = agg.pemasukan;
      try {
        const wInv = isYear ? `i.period_year=:year` : `i.period_year=:year AND i.period_month=:month`;
        const pr = await sequelize.query(
          `SELECT COALESCE(SUM(p.amount),0) AS gross
             FROM payments p JOIN invoices i ON i.id = p.invoice_id
            WHERE ${wInv}`,
          { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
        );
        pnbpBase = parseFloat((pr[0] && pr[0].gross) || 0);
      } catch (_) { /* fallback ke agg.pemasukan bila query gagal */ }
      const pnbp = await this._computePnbp(pnbpBase);

      res.json({
        success: true,
        data: {
          month, year, start, end,
          pemasukan:  agg.pemasukan,
          pengeluaran:agg.pengeluaran,
          modal:      agg.modal,
          hutangBulan:agg.hutang,
          piutangBulan:agg.piutang,
          hutangOutstanding:    parseFloat(hutangOut?.total||0),
          hutangOutstandingCnt: parseInt(hutangOut?.cnt||0),
          piutangOutstanding:   parseFloat(piutangOut?.total||0),
          piutangOutstandingCnt:parseInt(piutangOut?.cnt||0),
          cashflow,
          trend,
          catRows,
          pnbp,
        }
      });
    } catch(e) {
      console.error('[Keuangan.summary]', e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── Helper: muat persentase PNBP/pajak dari AppSetting (dengan default) ──
  async _loadPnbpRates() {
    const { AppSetting } = require('../models');
    const { Op } = require('sequelize');
    const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'pnbp_%' } } });
    const raw = {};
    rows.forEach(r => { raw[r.key] = r.value; });
    const num = (v, def) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : def;
    };
    return {
      // Aktifkan/nonaktifkan PNBP. Bila aktif, nilai PNBP dibukukan sebagai
      // PENGELUARAN di modul Keuangan → ikut Arus Kas & Laporan Keuangan.
      // Default OFF agar tidak membukukan biaya tanpa sepengetahuan admin.
      enabled: String(raw.pnbp_enabled) === '1' || String(raw.pnbp_enabled).toLowerCase() === 'true',
      bhp_percent: num(raw.pnbp_bhp_percent, 0.5),   // BHP Telekomunikasi (%)
      uso_percent: num(raw.pnbp_uso_percent, 1.25),  // Kontribusi KPU/USO (%)
      // Basis penghitungan: 'gross' = seluruh pemasukan; bila ISP punya
      // pendapatan non-telekomunikasi, bisa dipakai faktor telco_ratio (0-100%).
      telco_ratio: num(raw.pnbp_telco_ratio, 100),   // % pemasukan yang dihitung
    };
  }

  // ── Helper: hitung BHP/USO dari pemasukan kotor ──────────────────────
  async _computePnbp(grossIncome) {
    const rates = await this._loadPnbpRates();
    const gross = parseFloat(grossIncome) || 0;
    // Dasar penghitungan = pemasukan kotor × rasio telekomunikasi.
    const base = gross * (rates.telco_ratio / 100);
    const bhp  = base * (rates.bhp_percent / 100);
    const uso  = base * (rates.uso_percent / 100);
    const pnbpTotal = bhp + uso;                    // total PNBP (BHP + USO)
    return {
      rates,
      enabled: !!rates.enabled,
      gross_income:  gross,
      base,                 // dasar penghitungan
      bhp,                  // BHP Telekomunikasi
      uso,                  // Kontribusi USO
      pnbp_total: pnbpTotal,
      grand_total: pnbpTotal,
    };
  }

  // ── Helper: bukukan / hapus PNBP sebagai PENGELUARAN di Keuangan ─────
  // Saat PNBP AKTIF, nilai BHP+USO periode dicatat sbg pengeluaran (kategori
  // "PNBP (BHP & USO)") sehingga otomatis muncul di Laporan Keuangan, Laba Rugi
  // (Opex), dan Arus Kas (kas keluar). Idempotent via ref_number per-periode.
  // Saat NONAKTIF, entri PNBP periode tsb dihapus agar tidak membebani kas.
  //
  // @param {number} month  (1-12)  @param {number} year
  // @param {object} [opts] { rates } untuk hindari re-load
  async _materializePnbpExpense(month, year, opts = {}) {
    const { Keuangan } = require('../models');
    const m   = parseInt(month) || (moment().month() + 1);
    const y   = parseInt(year)  || moment().year();
    const ref = `PNBP-${y}-${String(m).padStart(2, '0')}`;
    // Tanggal pembukuan = akhir bulan periode (saat kewajiban dihitung).
    const dateStr = moment(`${y}-${String(m).padStart(2,'0')}-01`).endOf('month').format('YYYY-MM-DD');

    try {
      const rates = opts.rates || await this._loadPnbpRates();

      // Hitung pemasukan kotor periode → dasar PNBP.
      const start = moment(`${y}-${String(m).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
      const end   = moment(start).endOf('month').format('YYYY-MM-DD');
      const [gr] = await sequelize.query(
        `SELECT COALESCE(SUM(amount),0) AS gross
           FROM keuangan WHERE type='pemasukan' AND date BETWEEN :start AND :end`,
        { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
      );
      const gross = parseFloat((gr && gr.gross) || 0);
      const pnbp  = await this._computePnbp(gross);
      const amount = parseFloat(pnbp.grand_total) || 0;

      const existing = await Keuangan.findOne({ where: { type: 'pengeluaran', ref_number: ref } });

      // PNBP nonaktif ATAU nilai 0 → hapus entri bila ada.
      if (!rates.enabled || amount <= 0) {
        if (existing) { await existing.destroy(); return { action: 'removed', ref }; }
        return { action: 'none', ref };
      }

      const payload = {
        type:        'pengeluaran',
        category:    'PNBP (BHP & USO)',
        description: `PNBP ISP — BHP ${rates.bhp_percent}% + USO ${rates.uso_percent}% (dari pendapatan kotor ${moment(start).format('MMMM YYYY')})`,
        amount,
        date:        dateStr,
        ref_number:  ref,
        notes:       `Otomatis dari modul Keuangan. BHP: Rp${Math.round(pnbp.bhp).toLocaleString('id-ID')} | USO: Rp${Math.round(pnbp.uso).toLocaleString('id-ID')} | Dasar: Rp${Math.round(pnbp.base).toLocaleString('id-ID')}`,
        recorded_by: null,
      };

      if (existing) {
        // Perbarui nominal bila pemasukan/persentase berubah.
        await existing.update({ amount: payload.amount, description: payload.description, notes: payload.notes, date: payload.date });
        return { action: 'updated', ref, amount };
      }
      await Keuangan.create(payload);
      return { action: 'created', ref, amount };
    } catch (e) {
      console.error('[Keuangan._materializePnbpExpense]', e.message);
      return { action: 'error', ref, error: e.message };
    }
  }

  // ── GET /api/keuangan/pnbp-settings ──────────────────────────────────
  async pnbpSettings(req, res) {
    try {
      const rates = await this._loadPnbpRates();
      res.json({ success: true, data: rates });
    } catch(e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── PUT /api/keuangan/pnbp-settings ──────────────────────────────────
  async pnbpSettingsUpdate(req, res) {
    try {
      const { AppSetting } = require('../models');
      const body = req.body || {};
      const map = {
        pnbp_bhp_percent: body.bhp_percent,
        pnbp_uso_percent: body.uso_percent,
        pnbp_telco_ratio: body.telco_ratio,
      };
      let saved = 0;
      for (const [key, val] of Object.entries(map)) {
        if (val === undefined || val === null || val === '') continue;
        const n = parseFloat(val);
        if (!Number.isFinite(n) || n < 0) continue;
        await AppSetting.upsert({ key, value: String(n), type: 'string' });
        saved++;
      }

      // Toggle aktif/nonaktif (boolean) — simpan terpisah.
      if (body.enabled !== undefined) {
        const on = (body.enabled === true || body.enabled === 'true' || body.enabled === 1 || body.enabled === '1');
        await AppSetting.upsert({ key: 'pnbp_enabled', value: on ? '1' : '0', type: 'string' });
        saved++;
      }

      const rates = await this._loadPnbpRates();

      // Sinkronkan pembukuan PNBP ke Keuangan untuk periode terkait.
      // Default: bulan & tahun berjalan; bisa di-override via body.month/year.
      const m = parseInt(body.month) || (moment().month() + 1);
      const y = parseInt(body.year)  || moment().year();
      const materialize = await this._materializePnbpExpense(m, y, { rates });

      res.json({
        success: true,
        message: rates.enabled
          ? 'PNBP aktif — biaya BHP & USO dibukukan & tersinkron dengan Arus Kas.'
          : 'PNBP nonaktif — biaya BHP & USO tidak dibukukan ke Arus Kas.',
        data: rates, saved, materialize
      });
    } catch(e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }


  // ── GET /api/keuangan/:id ──────────────────────────────────
  async show(req, res) {
    try {
      const record = await Keuangan.findByPk(req.params.id, {
        include: [{ model: User, as: 'recorder', attributes: ['id','name'], required: false }]
      });
      if (!record) return res.status(404).json({ success:false, message:'Data tidak ditemukan' });
      res.json({ success:true, data:record });
    } catch(e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── GET /api/keuangan ──────────────────────────────────────
  async index(req, res) {
    try {
      const { type, month, year, page=1, limit=50, search='' } = req.query;
      const where = {};

      if (type && type !== 'semua') where.type = type;

      if (month && year) {
        const start = moment(`${year}-${String(month).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
        const end   = moment(start).endOf('month').format('YYYY-MM-DD');
        where.date  = { [Op.between]: [start, end] };
      } else if (year) {
        where.date = { [Op.between]: [`${year}-01-01`, `${year}-12-31`] };
      }

      if (search) {
        where[Op.or] = [
          { description: { [Op.like]: `%${search}%` } },
          { category:    { [Op.like]: `%${search}%` } },
          { party_name:  { [Op.like]: `%${search}%` } },
          { ref_number:  { [Op.like]: `%${search}%` } }
        ];
      }

      const offset = (parseInt(page)-1) * parseInt(limit);
      const { count, rows } = await Keuangan.findAndCountAll({
        where,
        include: [{ model: User, as: 'recorder', attributes: ['id','name'], required: false }],
        order: [['date','DESC'],['id','DESC']],
        limit:  parseInt(limit),
        offset
      });

      res.json({ success:true, data:rows, total:count, page:parseInt(page), limit:parseInt(limit) });
    } catch(e) {
      console.error('[Keuangan.index]', e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── POST /api/keuangan ─────────────────────────────────────
  async store(req, res) {
    try {
      const {
        type, category, description, amount, date,
        due_date, party_name, status, source,
        ref_number, notes
      } = req.body;

      if (!type || !category || !description || !amount || !date)
        return res.status(400).json({ success:false, message:'Field wajib: type, category, description, amount, date' });

      if (!Object.keys(TYPE_LABEL).includes(type))
        return res.status(400).json({ success:false, message:'Type tidak valid' });

      const record = await Keuangan.create({
        type, category: category.trim(),
        description: description.trim(),
        amount: parseFloat(String(amount).replace(/[.,]/g,'')||0) || parseFloat(amount),
        date,
        due_date:   due_date   || null,
        party_name: party_name || null,
        status:     status     || null,
        source:     source     || null,
        ref_number: ref_number || null,
        notes:      notes      || null,
        recorded_by: req.user?.id || null
      });

      res.status(201).json({ success:true, message:`${TYPE_LABEL[type]} berhasil dicatat`, data:record });
    } catch(e) {
      console.error('[Keuangan.store]', e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── PUT /api/keuangan/:id ──────────────────────────────────
  async update(req, res) {
    try {
      const record = await Keuangan.findByPk(req.params.id);
      if (!record) return res.status(404).json({ success:false, message:'Data tidak ditemukan' });

      const {
        type, category, description, amount, date,
        due_date, party_name, status, source,
        ref_number, notes
      } = req.body;

      await record.update({
        type:        type        || record.type,
        category:    category    ? category.trim()    : record.category,
        description: description ? description.trim() : record.description,
        amount:      amount ? (parseFloat(String(amount).replace(/[.,]/g,'')) || parseFloat(amount)) : record.amount,
        date:        date        || record.date,
        due_date:    due_date    !== undefined ? (due_date||null)    : record.due_date,
        party_name:  party_name  !== undefined ? (party_name||null)  : record.party_name,
        status:      status      !== undefined ? (status||null)      : record.status,
        source:      source      !== undefined ? (source||null)      : record.source,
        ref_number:  ref_number  !== undefined ? (ref_number||null)  : record.ref_number,
        notes:       notes       !== undefined ? (notes||null)       : record.notes
      });

      res.json({ success:true, message:'Data berhasil diperbarui', data:record });
    } catch(e) {
      console.error('[Keuangan.update]', e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── DELETE /api/keuangan/:id ───────────────────────────────
  async destroy(req, res) {
    const t = await sequelize.transaction();
    try {
      const record = await Keuangan.findByPk(req.params.id, { transaction: t });
      if (!record) {
        await t.rollback();
        return res.status(404).json({ success:false, message:'Data tidak ditemukan' });
      }

      // ═══════════════════════════════════════════════════════════
      // Cek apakah ini entry hasil sync dari Payment
      // Format ref_number: PAY-{payment_id}
      // ═══════════════════════════════════════════════════════════
      let paymentDeletedMsg = '';
      if (record.ref_number && record.ref_number.startsWith('PAY-')) {
        const paymentId = record.ref_number.replace('PAY-', '');
        
        try {
          const { Payment, Invoice } = require('../models');
          const payment = await Payment.findByPk(paymentId, { transaction: t });
          
          if (payment) {
            // Revert invoice ke unpaid
            await Invoice.update(
              { status: 'unpaid', paid_date: null }, 
              { where: { id: payment.invoice_id }, transaction: t }
            );
            
            // Hapus payment
            await payment.destroy({ transaction: t });
            paymentDeletedMsg = ' Payment terkait juga telah dihapus.';
            
            console.log(`[Keuangan] Auto-delete Payment ID ${paymentId} karena entry keuangan dihapus`);
          }
        } catch(paymentErr) {
          console.error('[Keuangan] Gagal delete payment terkait:', paymentErr.message);
          // Lanjutkan hapus entry keuangan meskipun delete payment gagal
        }
      }
      // ═══════════════════════════════════════════════════════════

      await record.destroy({ transaction: t });
      await t.commit();
      
      res.json({ 
        success:true, 
        message: 'Data berhasil dihapus.' + paymentDeletedMsg 
      });
    } catch(e) {
      await t.rollback();
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── PUT /api/keuangan/:id/lunas ────────────────────────────
  async markLunas(req, res) {
    try {
      const record = await Keuangan.findByPk(req.params.id);
      if (!record) return res.status(404).json({ success:false, message:'Data tidak ditemukan' });
      if (!['hutang','piutang'].includes(record.type))
        return res.status(400).json({ success:false, message:'Hanya hutang/piutang yang bisa ditandai lunas' });
      await record.update({ status:'lunas' });
      res.json({ success:true, message:'Ditandai lunas', data:record });
    } catch(e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── GET /api/keuangan/categories ──────────────────────────
  async categories(req, res) {
    try {
      const rows = await Keuangan.findAll({
        attributes: [[sequelize.fn('DISTINCT', sequelize.col('category')), 'category']],
        where: req.query.type ? { type: req.query.type } : {},
        raw: true
      });
      const cats = rows.map(r => r.category).filter(Boolean).sort();
      res.json({ success:true, data:cats });
    } catch(e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ══════════ RECURRING EXPENSE (pengeluaran berulang) ══════════

  // GET /api/keuangan/recurring — daftar template
  async recurringList(req, res) {
    try {
      const rows = await RecurringExpense.findAll({ order: [['active','DESC'], ['day_of_month','ASC']] });
      const data = rows.map(r => {
        const o = r.toJSON();
        o.amount = parseFloat(o.amount || 0);
        return o;
      });
      const monthlyTotal = data.filter(d => d.active).reduce((s, d) => s + d.amount, 0);
      res.json({ success:true, data, monthly_total: monthlyTotal });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // POST /api/keuangan/recurring — buat template
  async recurringStore(req, res) {
    try {
      const { name, category, amount, day_of_month, party_name, notes, active } = req.body;
      if (!name || !amount) return res.status(400).json({ success:false, message:'Nama & jumlah wajib diisi' });
      const row = await RecurringExpense.create({
        name: String(name).trim(),
        category: (category || 'Operasional').trim(),
        amount: parseFloat(amount) || 0,
        day_of_month: Math.min(Math.max(parseInt(day_of_month) || 1, 1), 28),
        party_name: party_name || null,
        notes: notes || null,
        active: active === false ? false : true,
        created_by: req.user?.id || null
      });
      res.json({ success:true, message:'Pengeluaran berulang ditambahkan', data: row });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // PUT /api/keuangan/recurring/:id
  async recurringUpdate(req, res) {
    try {
      const row = await RecurringExpense.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success:false, message:'Template tidak ditemukan' });
      const f = req.body;
      const patch = {};
      if (f.name        !== undefined) patch.name = String(f.name).trim();
      if (f.category    !== undefined) patch.category = (f.category || 'Operasional').trim();
      if (f.amount      !== undefined) patch.amount = parseFloat(f.amount) || 0;
      if (f.day_of_month!== undefined) patch.day_of_month = Math.min(Math.max(parseInt(f.day_of_month) || 1, 1), 28);
      if (f.party_name  !== undefined) patch.party_name = f.party_name || null;
      if (f.notes       !== undefined) patch.notes = f.notes || null;
      if (f.active      !== undefined) patch.active = !!f.active;
      await row.update(patch);
      res.json({ success:true, message:'Tersimpan', data: row });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // DELETE /api/keuangan/recurring/:id
  async recurringDestroy(req, res) {
    try {
      const row = await RecurringExpense.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success:false, message:'Template tidak ditemukan' });
      await row.destroy();
      res.json({ success:true, message:'Template dihapus' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // POST /api/keuangan/recurring/generate — generate manual utk bulan berjalan
  async recurringGenerate(req, res) {
    try {
      const svc = require('../services/RecurringExpenseService');
      // forDate dipaksa ke sekarang supaya entri dibuat tanpa menunggu tanggal
      const result = await svc.generate(new Date());
      res.json({ success:true, message:`${result.created} pengeluaran dibuat, ${result.skipped} dilewati`, data: result });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }
}

module.exports = new KeuanganController();