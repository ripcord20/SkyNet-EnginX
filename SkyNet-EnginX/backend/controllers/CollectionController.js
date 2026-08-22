/**
 * CollectionController (ADMIN)
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint sisi admin untuk modul Field Collection:
 *   - GET  /api/collection/stats           ringkasan dashboard
 *   - GET  /api/collection/assignments     daftar penugasan (filter+paging)
 *   - POST /api/collection/generate        generate task dari invoice belum lunas
 *   - POST /api/collection/assign          tugaskan assignment ke kolektor
 *   - POST /api/collection/auto-assign     bagi otomatis berdasar area
 *   - GET  /api/collection/collectors      daftar kolektor + ringkas kas
 *   - POST /api/collection/collectors      buat/utak profil kolektor
 *
 * Sisi lapangan (input pembayaran, hasil kunjungan, setoran) ada di
 * CollectorFieldController (Tahap 3-4).
 */
const { Op } = require('sequelize');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const {
  CollectionAssignment, CollectorProfile, Customer, Invoice, User, Role, Payment, CollectionAssignmentLog, CommissionPayment, Keuangan, sequelize
} = require('../models');
const { paginateResponse } = require('../utils/helpers');
const CollectionService = require('../services/CollectionService');

const PROOF_DIR_REL = 'uploads/payment_proofs/';

class CollectionController {
  // ── Ringkasan dashboard ───────────────────────────────────────────
  async stats(req, res) {
    try {
      const month = req.query.month ? parseInt(req.query.month, 10) : undefined;
      const year  = req.query.year  ? parseInt(req.query.year, 10)  : undefined;
      const data = await CollectionService.adminStats({ month, year });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Laporan per kolektor + komisi ─────────────────────────────────
  async collectorReport(req, res) {
    try {
      const month = req.query.month ? parseInt(req.query.month, 10) : undefined;
      const year  = req.query.year  ? parseInt(req.query.year, 10)  : undefined;
      const data = await CollectionService.collectorReport({ month, year });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Export rekap kolektor: Excel ─────────────────────────────────
  async reportExcel(req, res) {
    try {
      const ExcelJS = require('exceljs');
      const month = req.query.month ? parseInt(req.query.month, 10) : undefined;
      const year  = req.query.year  ? parseInt(req.query.year, 10)  : undefined;
      const collectorId = req.query.collector_id ? parseInt(req.query.collector_id, 10) : null;
      const data = await CollectionService.collectorReport({ month, year });
      let rows = data.rows || [];
      if (collectorId) rows = rows.filter(r => String(r.collector_id) === String(collectorId));

      const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      const periodLabel = (MONTHS[(data.period.month || 1) - 1] || data.period.month) + ' ' + data.period.year;
      const COMM = { flat: 'Flat / invoice', percent: 'Persentase', none: 'Tanpa komisi' };

      const wb = new ExcelJS.Workbook();
      wb.creator = 'FLAYNET';
      const ws = wb.addWorksheet('Rekap Kolektor');
      ws.columns = [{ width: 26 }, { width: 12 }, { width: 18 }, { width: 22 }, { width: 16 }, { width: 16 }, { width: 16 }];

      ws.addRow(['Rekap Penagihan & Komisi Kolektor']).font = { size: 15, bold: true };
      ws.addRow([`Periode: ${periodLabel}`]).font = { size: 10, color: { argb: 'FF64748B' } };
      ws.addRow([]);

      const hr = ws.addRow(['Kolektor', 'Tertagih', 'Terkumpul', 'Skema Komisi', 'Komisi', 'Cash Pegang', 'Status Komisi']);
      hr.font = { bold: true };
      hr.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } });

      rows.forEach(r => {
        const scheme = r.commission_type === 'percent' ? (r.commission_value + '%')
          : r.commission_type === 'none' ? '-'
          : ('Rp' + Number(r.commission_value || 0).toLocaleString('id-ID'));
        const rr = ws.addRow([
          r.name, r.paid_count || 0, Number(r.collected || 0),
          (COMM[r.commission_type] || r.commission_type) + ' · ' + scheme,
          Number(r.commission || 0), Number(r.cash_held || 0),
          r.commission_paid ? 'Sudah Dibayar' : 'Belum'
        ]);
        rr.getCell(3).numFmt = '#,##0';
        rr.getCell(5).numFmt = '#,##0';
        rr.getCell(6).numFmt = '#,##0';
      });

      const t = data.totals || {};
      const tot = ws.addRow(['TOTAL', t.paid_count || 0, Number(t.collected || 0), '', Number(t.commission || 0), '', '']);
      tot.font = { bold: true };
      tot.getCell(3).numFmt = '#,##0'; tot.getCell(5).numFmt = '#,##0';

      const fname = `Rekap-Kolektor-${periodLabel.replace(/\s+/g, '-')}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Export rekap kolektor: PDF ───────────────────────────────────
  async reportPdf(req, res) {
    try {
      const PDFDocument = require('pdfkit');
      const month = req.query.month ? parseInt(req.query.month, 10) : undefined;
      const year  = req.query.year  ? parseInt(req.query.year, 10)  : undefined;
      const collectorId = req.query.collector_id ? parseInt(req.query.collector_id, 10) : null;
      const data = await CollectionService.collectorReport({ month, year });
      let rows = data.rows || [];
      if (collectorId) rows = rows.filter(r => String(r.collector_id) === String(collectorId));

      const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      const periodLabel = (MONTHS[(data.period.month || 1) - 1] || data.period.month) + ' ' + data.period.year;
      const COMM = { flat: 'Flat', percent: '%', none: '-' };
      const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

      const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
      const fname = `Rekap-Kolektor-${periodLabel.replace(/\s+/g, '-')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      doc.pipe(res);

      const dark = '#1a1a1a', muted = '#697386', navy = '#1e3a8a', line = '#e5e7eb';
      const left = 40, pageW = doc.page.width - 80;

      doc.fillColor(dark).fontSize(18).font('Helvetica-Bold').text('Rekap Penagihan & Komisi Kolektor');
      doc.fillColor(muted).fontSize(10).font('Helvetica').text('Periode: ' + periodLabel);
      doc.moveDown(0.5);
      doc.strokeColor(line).lineWidth(1).moveTo(left, doc.y).lineTo(left + pageW, doc.y).stroke();
      doc.moveDown(0.6);

      // Kolom: Kolektor | Tertagih | Terkumpul | Skema | Komisi | Cash Pegang | Status
      const cols = [
        { t: 'Kolektor',   w: 150, a: 'left'  },
        { t: 'Tertagih',   w: 60,  a: 'center'},
        { t: 'Terkumpul',  w: 110, a: 'right' },
        { t: 'Skema',      w: 120, a: 'left'  },
        { t: 'Komisi',     w: 100, a: 'right' },
        { t: 'Cash Pegang',w: 100, a: 'right' },
        { t: 'Status',     w: 90,  a: 'left'  },
      ];
      const drawRow = (vals, opts = {}) => {
        const y = doc.y; let x = left;
        doc.fontSize(opts.size || 9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(opts.color || dark);
        cols.forEach((c, i) => { doc.text(String(vals[i]), x + 4, y, { width: c.w - 8, align: c.a }); x += c.w; });
        doc.moveDown(opts.gap != null ? opts.gap : 0.5);
      };

      const hy = doc.y;
      doc.rect(left, hy - 2, pageW, 18).fill('#eff6ff');
      doc.y = hy;
      drawRow(cols.map(c => c.t), { bold: true, color: navy });
      doc.strokeColor(line).moveTo(left, doc.y).lineTo(left + pageW, doc.y).stroke();
      doc.moveDown(0.3);

      rows.forEach(r => {
        const scheme = r.commission_type === 'percent' ? (r.commission_value + '%')
          : r.commission_type === 'none' ? '-' : ('Rp' + Number(r.commission_value || 0).toLocaleString('id-ID'));
        if (doc.y > doc.page.height - 70) { doc.addPage(); }
        drawRow([
          r.name, r.paid_count || 0, rp(r.collected),
          (COMM[r.commission_type] || '') + ' ' + scheme,
          rp(r.commission), rp(r.cash_held),
          r.commission_paid ? 'Sudah Dibayar' : 'Belum'
        ]);
      });

      doc.moveDown(0.2);
      doc.strokeColor(line).moveTo(left, doc.y).lineTo(left + pageW, doc.y).stroke();
      doc.moveDown(0.3);
      const t = data.totals || {};
      drawRow(['TOTAL', t.paid_count || 0, rp(t.collected), '', rp(t.commission), '', ''], { bold: true });

      doc.moveDown(1.2);
      doc.fillColor(muted).fontSize(8).font('Helvetica')
        .text('Dicetak otomatis oleh FLAYNET — ' + new Date().toLocaleString('id-ID'), left, doc.y);

      doc.end();
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Tandai komisi kolektor (periode) sudah dibayar ───────────────
  async payCommission(req, res) {
    const t = await sequelize.transaction();
    try {
      const collectorId = parseInt(req.body.collector_id, 10);
      const month = parseInt(req.body.month, 10);
      const year  = parseInt(req.body.year, 10);
      const note  = (req.body.note || '').toString().trim().slice(0, 255) || null;
      if (!collectorId || !month || !year) {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Parameter kolektor/periode tidak lengkap' });
      }

      // Idempotensi: cegah dobel bayar untuk periode yang sama.
      const exist = await CommissionPayment.findOne({
        where: { collector_id: collectorId, period_month: month, period_year: year },
        transaction: t
      });
      if (exist) {
        await t.rollback();
        return res.status(409).json({ success: false, message: 'Komisi periode ini sudah ditandai dibayar.' });
      }

      // Hitung komisi terkini dari laporan (sumber kebenaran).
      const report = await CollectionService.collectorReport({ month, year });
      const row = (report.rows || []).find(r => String(r.collector_id) === String(collectorId));
      if (!row || row.commission <= 0) {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Tidak ada komisi untuk dibayarkan pada periode ini.' });
      }

      const user = await User.findByPk(collectorId, { transaction: t });
      const collectorName = user ? user.name : ('User #' + collectorId);
      const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      const periodLabel = (MONTHS[month - 1] || month) + ' ' + year;

      // 1) Catat pembayaran komisi.
      const cp = await CommissionPayment.create({
        collector_id: collectorId,
        period_month: month,
        period_year: year,
        amount: row.commission,
        paid_count: row.paid_count,
        collected: row.collected,
        commission_type: row.commission_type,
        commission_value: row.commission_value,
        paid_by: req.user?.id || null,
        note
      }, { transaction: t });

      // 2) Catat sebagai pengeluaran di Keuangan agar laba bersih akurat.
      let keuRef = null;
      if (Keuangan) {
        keuRef = `COMM-${cp.id}`;
        await Keuangan.create({
          type:        'pengeluaran',
          category:    'Komisi Kolektor',
          description: `Komisi penagihan ${collectorName} — ${periodLabel}`,
          amount:      row.commission,
          date:        moment().format('YYYY-MM-DD'),
          ref_number:  keuRef,
          notes:       `Periode ${periodLabel} | ${row.paid_count} invoice tertagih | terkumpul Rp${Number(row.collected).toLocaleString('id-ID')}`
                       + (note ? ` | ${note}` : ''),
          recorded_by: req.user?.id || null
        }, { transaction: t });
        await cp.update({ keuangan_ref: keuRef }, { transaction: t });
      }

      await t.commit();
      res.json({
        success: true,
        message: `Komisi ${collectorName} (${periodLabel}) sebesar Rp${Number(row.commission).toLocaleString('id-ID')} ditandai dibayar.`,
        data: { id: cp.id, amount: row.commission, keuangan_ref: keuRef }
      });
    } catch (e) {
      try { await t.rollback(); } catch (_) {}
      // Tangani error unik (race condition dobel klik).
      if (e.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Komisi periode ini sudah ditandai dibayar.' });
      }
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Stream foto bukti pembayaran lapangan (ber-auth) ──────────────
  async viewAssignmentProof(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const a = await CollectionAssignment.findByPk(id);
      if (!a) return res.status(404).json({ success: false, message: 'Tugas tidak ditemukan' });

      // Sumber 1: kolom payment_proof pada assignment.
      let filename = a.payment_proof || null;

      // Sumber 2 (fallback): parse dari notes payment terkait (proof:<file>).
      if (!filename) {
        const pay = await Payment.findOne({
          where: { assignment_id: id },
          order: [['id', 'DESC']]
        });
        if (pay && pay.notes) {
          const m = pay.notes.match(/proof:([A-Za-z0-9._-]+)/);
          if (m) filename = m[1];
        }
      }

      if (!filename) return res.status(404).json({ success: false, message: 'Bukti pembayaran tidak tersedia' });

      // Cegah path traversal — hanya nama file polos yang diizinkan.
      if (/[\/\\]/.test(filename) || filename.includes('..')) {
        return res.status(400).json({ success: false, message: 'Nama file tidak valid' });
      }
      const abs = path.join(__dirname, '..', '..', PROOF_DIR_REL, filename);
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, message: 'File bukti tidak ada di server' });
      return res.sendFile(abs);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Daftar penugasan ──────────────────────────────────────────────
  async listAssignments(req, res) {
    try {
      const { page = 1, limit = 20, status, collector_id, area, search, month, year, unassigned } = req.query;
      const where = {};

      if (status) where.status = status;
      if (unassigned === '1' || unassigned === 'true') where.collector_id = { [Op.is]: null };
      else if (collector_id) where.collector_id = collector_id;
      if (month) where.period_month = parseInt(month, 10);
      if (year)  where.period_year  = parseInt(year, 10);
      if (area) {
        where[Op.or] = [
          { area_regency:  { [Op.like]: '%' + area + '%' } },
          { area_district: { [Op.like]: '%' + area + '%' } },
          { area_village:  { [Op.like]: '%' + area + '%' } }
        ];
      }

      const customerWhere = search ? {
        [Op.or]: [
          { name:        { [Op.like]: '%' + search + '%' } },
          { customer_id: { [Op.like]: '%' + search + '%' } }
        ]
      } : undefined;

      const result = await CollectionAssignment.findAndCountAll({
        where,
        include: [
          {
            model: Customer, as: 'customer',
            attributes: ['id', 'customer_id', 'name', 'phone', 'address', 'regency', 'district', 'village', 'latitude', 'longitude'],
            where: customerWhere,
            required: !!search
          },
          { model: Invoice, as: 'invoice', attributes: ['id', 'invoice_number', 'total', 'status', 'due_date'] },
          { model: User, as: 'collector', attributes: ['id', 'name'], required: false }
        ],
        offset: (page - 1) * limit,
        limit: parseInt(limit, 10),
        order: [['scheduled_date', 'ASC'], ['created_at', 'DESC']]
      });

      res.json({ success: true, ...paginateResponse(result.rows, result.count, page, limit) });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Generate task dari invoice belum lunas ────────────────────────
  async generate(req, res) {
    try {
      const month = req.body.month ? parseInt(req.body.month, 10) : undefined;
      const year  = req.body.year  ? parseInt(req.body.year, 10)  : undefined;
      const onlyOverdue = req.body.only_overdue === true || req.body.only_overdue === '1';
      const result = await CollectionService.generateTasks({ month, year, onlyOverdue });
      res.json({
        success: true,
        message: `${result.created} task dibuat, ${result.skipped} dilewati (sudah ada).`,
        data: result
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Assign ke kolektor ────────────────────────────────────────────
  async assign(req, res) {
    try {
      const { assignment_ids, collector_id } = req.body;
      const ids = Array.isArray(assignment_ids) ? assignment_ids.map(Number) : [];
      const result = await CollectionService.assign(ids, parseInt(collector_id, 10), req.user?.id || null);
      res.json({ success: true, message: `${result.assigned} penugasan diberikan ke kolektor.`, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── Auto-assign berdasar area ─────────────────────────────────────
  async autoAssign(req, res) {
    try {
      const result = await CollectionService.autoAssignByArea(req.user?.id || null);
      res.json({ success: true, message: `${result.assigned} dari ${result.pending_total} task ter-assign otomatis.`, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Data peta sebaran tugas (titik koordinat customer) ────────────
  async mapData(req, res) {
    try {
      const { month, year, status, collector_id } = req.query;
      const where = {};
      if (month) where.period_month = parseInt(month, 10);
      if (year)  where.period_year  = parseInt(year, 10);
      if (status) where.status = status;
      if (collector_id) where.collector_id = parseInt(collector_id, 10);

      const rows = await CollectionAssignment.findAll({
        where,
        include: [
          {
            model: Customer, as: 'customer',
            attributes: ['id', 'customer_id', 'name', 'phone', 'address', 'regency', 'district', 'village', 'latitude', 'longitude'],
            required: true,
            // Hanya yang punya koordinat valid.
            where: {
              latitude:  { [Op.ne]: null },
              longitude: { [Op.ne]: null }
            }
          },
          { model: Invoice, as: 'invoice', attributes: ['id', 'invoice_number', 'total', 'due_date'] },
          { model: User, as: 'collector', attributes: ['id', 'name'], required: false }
        ],
        order: [['id', 'DESC']],
        limit: 2000
      });

      const points = [];
      for (const a of rows) {
        const c = a.customer;
        const lat = parseFloat(c.latitude), lng = parseFloat(c.longitude);
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
        points.push({
          id: a.id,
          lat, lng,
          status: a.status,
          amount_due: parseFloat(a.amount_due || 0),
          customer_name: c.name,
          customer_code: c.customer_id,
          phone: c.phone,
          address: [c.address, c.village, c.district, c.regency].filter(Boolean).join(', '),
          invoice_number: a.invoice ? a.invoice.invoice_number : null,
          collector_id: a.collector_id,
          collector_name: a.collector ? a.collector.name : null
        });
      }
      res.json({ success: true, data: { points, total: points.length } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Reassign tugas ke kolektor lain (dengan audit) ────────────────
  async reassign(req, res) {
    const t = await sequelize.transaction();
    try {
      const id = parseInt(req.params.id, 10);
      const toCollector = req.body.collector_id ? parseInt(req.body.collector_id, 10) : null;
      const reason = (req.body.reason || '').toString().trim().slice(0, 255) || null;

      const a = await CollectionAssignment.findByPk(id, { transaction: t });
      if (!a) { await t.rollback(); return res.status(404).json({ success: false, message: 'Tugas tidak ditemukan' }); }

      // Tidak boleh memindahkan tugas yang sudah selesai dibayar.
      if (a.status === 'paid') {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Tugas sudah lunas, tidak bisa dipindahkan' });
      }

      const fromCollector = a.collector_id || null;
      if (toCollector) {
        const u = await User.findByPk(toCollector, { transaction: t });
        if (!u) { await t.rollback(); return res.status(400).json({ success: false, message: 'Kolektor tujuan tidak ditemukan' }); }
      }
      if (fromCollector === toCollector) {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Kolektor tujuan sama dengan saat ini' });
      }

      // Tentukan jenis aksi + status baru.
      let action = 'reassign';
      let newStatus = a.status;
      if (!toCollector) {
        action = 'unassign';
        newStatus = 'pending';
      } else if (!fromCollector) {
        action = 'assign';
        if (a.status === 'pending') newStatus = 'assigned';
      } else {
        // Reassign dari kolektor lama; reset status kerja ke 'assigned' bila masih open.
        if (['assigned', 'in_progress', 'not_home', 'promise_to_pay'].includes(a.status)) newStatus = 'assigned';
      }

      await a.update({
        collector_id: toCollector,
        status: newStatus,
        assigned_by: req.user?.id || null,
        assigned_at: new Date()
      }, { transaction: t });

      await CollectionAssignmentLog.create({
        assignment_id: id,
        action,
        from_collector_id: fromCollector,
        to_collector_id: toCollector,
        changed_by: req.user?.id || null,
        reason
      }, { transaction: t });

      await t.commit();

      // Sinkronkan cash_held kedua kolektor (best-effort, non-blocking).
      try {
        if (fromCollector) await CollectionService.recomputeCashHeld(fromCollector);
        if (toCollector)   await CollectionService.recomputeCashHeld(toCollector);
      } catch (_) {}

      const labelMap = { assign: 'ditugaskan', reassign: 'dipindahkan', unassign: 'dilepas' };
      res.json({ success: true, message: `Tugas berhasil ${labelMap[action]}.`, data: { id, action, status: newStatus } });
    } catch (e) {
      try { await t.rollback(); } catch (_) {}
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Riwayat penugasan satu tugas ──────────────────────────────────
  async assignmentHistory(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const logs = await CollectionAssignmentLog.findAll({
        where: { assignment_id: id },
        include: [
          { model: User, as: 'from_collector', attributes: ['id', 'name'], required: false },
          { model: User, as: 'to_collector',   attributes: ['id', 'name'], required: false },
          { model: User, as: 'changer',         attributes: ['id', 'name'], required: false }
        ],
        order: [['id', 'DESC']]
      });
      const out = logs.map(l => ({
        id: l.id,
        action: l.action,
        from: l.from_collector ? l.from_collector.name : null,
        to: l.to_collector ? l.to_collector.name : null,
        by: l.changer ? l.changer.name : null,
        reason: l.reason,
        at: l.createdAt
      }));
      res.json({ success: true, data: { logs: out } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Daftar kolektor + ringkas kas ─────────────────────────────────
  async listCollectors(req, res) {
    try {
      const collectorRole = await Role.findOne({ where: { name: 'collector' } });
      if (!collectorRole) return res.json({ success: true, data: [] });

      const users = await User.findAll({
        where: { role_id: collectorRole.id, is_active: true },
        attributes: ['id', 'name', 'email', 'phone'],
        include: [{ model: CollectorProfile, as: 'collector_profile', required: false }],
        order: [['name', 'ASC']]
      });

      const data = users.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.collector_profile?.phone || u.phone || null,
        region: u.collector_profile?.region || null,
        commission_type: u.collector_profile?.commission_type || 'flat',
        commission_value: parseFloat(u.collector_profile?.commission_value || 0),
        cash_held: parseFloat(u.collector_profile?.cash_held || 0),
        has_profile: !!u.collector_profile
      }));

      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Buat / update profil kolektor ─────────────────────────────────
  async upsertCollectorProfile(req, res) {
    try {
      const { user_id, phone, region, commission_type, commission_value } = req.body;
      const uid = parseInt(user_id, 10);
      if (!uid) return res.status(400).json({ success: false, message: 'user_id wajib diisi' });

      const user = await User.findByPk(uid, { include: [{ model: Role, as: 'role' }] });
      if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
      if ((user.role?.name || '').toLowerCase() !== 'collector') {
        return res.status(400).json({ success: false, message: 'User bukan ber-role kolektor' });
      }

      const ctype = ['flat', 'percent', 'none'].includes(commission_type) ? commission_type : 'flat';
      const cval  = parseFloat(commission_value);

      const [profile, created] = await CollectorProfile.findOrCreate({
        where: { user_id: uid },
        defaults: {
          user_id: uid,
          phone: phone || null,
          region: region || null,
          commission_type: ctype,
          commission_value: isNaN(cval) ? 5000 : cval
        }
      });
      if (!created) {
        await profile.update({
          phone: phone ?? profile.phone,
          region: region ?? profile.region,
          commission_type: ctype,
          commission_value: isNaN(cval) ? profile.commission_value : cval
        });
      }
      res.json({ success: true, message: created ? 'Profil kolektor dibuat.' : 'Profil kolektor diperbarui.', data: profile });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new CollectionController();
