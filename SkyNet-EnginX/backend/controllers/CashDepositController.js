/**
 * CashDepositController
 * ─────────────────────────────────────────────────────────────────────────────
 * Modul setoran kas (cash deposit) + rekonsiliasi. Dipakai dua sisi:
 *
 *   SISI KOLEKTOR (role collector):
 *     - POST /api/field/deposit        buat setoran (input nominal + foto bukti)
 *     - GET  /api/field/deposits       riwayat setoran milik kolektor
 *
 *   SISI ADMIN (superadmin/admin):
 *     - GET  /api/collection/deposits          daftar setoran (filter status)
 *     - GET  /api/collection/deposits/:id/proof  stream foto bukti (ber-auth)
 *     - POST /api/collection/deposits/:id/verify reconcile → verified
 *     - POST /api/collection/deposits/:id/reject ditolak
 *
 * Logika kas:
 *   - cash_held kolektor = SUM(payment field_collection) - SUM(deposit verified)
 *   - expected_amount setoran di-snapshot dari cash_held saat setor.
 *   - variance = deposited_amount - expected_amount (auto). <0 = kurang setor.
 *   - Saat admin verifikasi: cash_held dikurangi deposited_amount.
 *     (Bukan expected — yang nyata berpindah tangan adalah yang disetor;
 *      selisih tetap tercatat sebagai variance untuk ditindaklanjuti.)
 *
 * Semua uang Rupiah penuh.
 */
const { Op } = require('sequelize');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const {
  sequelize, CashDeposit, CollectorProfile, User
} = require('../models');
const { paginateResponse } = require('../utils/helpers');

class CashDepositController {
  // ── KOLEKTOR: buat setoran ────────────────────────────────────────
  async create(req, res) {
    const t = await sequelize.transaction();
    try {
      const uid = req.user.id;
      const { amount, deposit_date, note } = req.body;

      const profile = await CollectorProfile.findOne({ where: { user_id: uid }, transaction: t });
      const expected = parseFloat(profile?.cash_held || 0);

      const deposited = parseFloat(String(amount).replace(/[.,]/g, '')) || parseFloat(amount);
      if (!deposited || deposited <= 0) {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Nominal setoran tidak valid' });
      }

      const variance = deposited - expected;
      let proofPath = null;
      if (req.file) proofPath = 'uploads/payment_proofs/' + req.file.filename;

      const dep = await CashDeposit.create({
        collector_id: uid,
        deposit_date: deposit_date || moment().format('YYYY-MM-DD'),
        expected_amount: expected,
        deposited_amount: deposited,
        variance,
        status: 'pending',
        proof_path: proofPath,
        note: note || null
      }, { transaction: t });

      await t.commit();

      // Notifikasi admin (WA + Telegram) — best-effort, non-blocking.
      setImmediate(async () => {
        try {
          const u = await require('../models').User.findByPk(uid, { attributes: ['name'] });
          await require('../services/CollectNotifier').notifyDepositCreated(dep, u ? u.name : null);
        } catch (_) {}
      });

      res.json({
        success: true,
        message: 'Setoran dikirim. Menunggu verifikasi admin.',
        data: { id: dep.id, expected, deposited, variance }
      });
    } catch (e) {
      try { await t.rollback(); } catch (_) {}
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── KOLEKTOR: riwayat setoran sendiri ─────────────────────────────
  async myDeposits(req, res) {
    try {
      const uid = req.user.id;
      const rows = await CashDeposit.findAll({
        where: { collector_id: uid },
        order: [['created_at', 'DESC']],
        limit: 50
      });
      const profile = await CollectorProfile.findOne({ where: { user_id: uid } });

      // Rincian kas di tangan: pembayaran field_collection oleh kolektor ini
      // SEJAK setoran terverifikasi terakhir (yang membentuk cash_on_hand).
      let breakdown = [];
      try {
        const { Payment, Invoice, Customer } = require('../models');
        const lastVerified = await CashDeposit.findOne({
          where: { collector_id: uid, status: 'verified' },
          order: [['created_at', 'DESC']]
        });
        const since = lastVerified ? lastVerified.created_at : null;
        const wherePay = { collected_by: uid, payment_method: 'field_collection' };
        if (since) wherePay.created_at = { [require('sequelize').Op.gt]: since };
        const pays = await Payment.findAll({
          where: wherePay,
          attributes: ['id', 'amount', 'payment_date', 'created_at', 'invoice_id'],
          include: [{
            model: Invoice, as: 'invoice', attributes: ['invoice_number'],
            include: [{ model: Customer, as: 'customer', attributes: ['name', 'customer_id'] }]
          }],
          order: [['created_at', 'DESC']],
          limit: 200
        });
        breakdown = pays.map(p => ({
          id: p.id,
          amount: parseFloat(p.amount || 0),
          date: p.payment_date,
          invoice: p.invoice ? p.invoice.invoice_number : null,
          customer: (p.invoice && p.invoice.customer) ? p.invoice.customer.name : null,
          customer_id: (p.invoice && p.invoice.customer) ? p.invoice.customer.customer_id : null
        }));
      } catch (e) { /* breakdown best-effort */ }

      res.json({
        success: true,
        data: {
          cash_on_hand: parseFloat(profile?.cash_held || 0),
          breakdown,
          deposits: rows.map(d => ({
            id: d.id, deposit_date: d.deposit_date,
            expected_amount: parseFloat(d.expected_amount),
            deposited_amount: parseFloat(d.deposited_amount),
            variance: parseFloat(d.variance),
            status: d.status, note: d.note,
            reject_reason: d.reject_reason,
            has_proof: !!d.proof_path,
            created_at: d.created_at
          }))
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── ADMIN: daftar setoran (filter status/kolektor) ────────────────
  async adminList(req, res) {
    try {
      const { page = 1, limit = 20, status, collector_id } = req.query;
      const where = {};
      if (status && ['pending', 'verified', 'rejected'].includes(status)) where.status = status;
      if (collector_id) where.collector_id = collector_id;

      const result = await CashDeposit.findAndCountAll({
        where,
        include: [
          { model: User, as: 'collector', attributes: ['id', 'name'] },
          { model: User, as: 'verifier', attributes: ['id', 'name'], required: false }
        ],
        offset: (page - 1) * limit,
        limit: parseInt(limit, 10),
        order: [['status', 'ASC'], ['created_at', 'DESC']]
      });

      // Ringkasan cepat
      const pendingRow = await CashDeposit.findOne({
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'cnt'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('deposited_amount')), 0), 'sum']
        ],
        where: { status: 'pending' }, raw: true
      });

      res.json({
        success: true,
        summary: {
          pending_count: parseInt(pendingRow?.cnt, 10) || 0,
          pending_amount: parseFloat(pendingRow?.sum) || 0
        },
        ...paginateResponse(result.rows, result.count, page, limit)
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── KOLEKTOR: lihat bukti setoran milik sendiri (ber-auth) ────────
  async myDepositProof(req, res) {
    try {
      const dep = await CashDeposit.findByPk(req.params.id);
      if (!dep || !dep.proof_path) return res.status(404).json({ success: false, message: 'Bukti tidak ditemukan' });
      if (dep.collector_id !== req.user.id) return res.status(403).json({ success: false, message: 'Bukan setoran Anda' });
      const safeRel = dep.proof_path.replace(/^\/+/, '');
      if (!safeRel.startsWith('uploads/payment_proofs/') || safeRel.includes('..')) {
        return res.status(400).json({ success: false, message: 'Path tidak valid' });
      }
      const abs = path.join(__dirname, '..', '..', safeRel);
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, message: 'File bukti tidak ada di server' });
      return res.sendFile(abs);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── ADMIN: stream foto bukti setor (ber-auth) ─────────────────────
  async viewProof(req, res) {
    try {
      const dep = await CashDeposit.findByPk(req.params.id);
      if (!dep || !dep.proof_path) return res.status(404).json({ success: false, message: 'Bukti tidak ditemukan' });
      const safeRel = dep.proof_path.replace(/^\/+/, '');
      if (!safeRel.startsWith('uploads/payment_proofs/') || safeRel.includes('..')) {
        return res.status(400).json({ success: false, message: 'Path tidak valid' });
      }
      const abs = path.join(__dirname, '..', '..', safeRel);
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, message: 'File bukti tidak ada di server' });
      return res.sendFile(abs);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── ADMIN: verifikasi setoran → kurangi cash_held kolektor ────────
  async verify(req, res) {
    const t = await sequelize.transaction();
    try {
      const dep = await CashDeposit.findByPk(req.params.id, { transaction: t });
      if (!dep) { await t.rollback(); return res.status(404).json({ success: false, message: 'Setoran tidak ditemukan' }); }
      if (dep.status === 'verified') { await t.rollback(); return res.status(409).json({ success: false, message: 'Setoran sudah diverifikasi.' }); }

      await dep.update({ status: 'verified', verified_at: new Date(), verified_by: req.user?.id || null }, { transaction: t });

      // Kurangi cash_held kolektor sebesar yang DISETOR.
      const profile = await CollectorProfile.findOne({ where: { user_id: dep.collector_id }, transaction: t });
      if (profile) {
        const newHeld = parseFloat(profile.cash_held || 0) - parseFloat(dep.deposited_amount);
        await profile.update({ cash_held: newHeld }, { transaction: t });
      }

      await t.commit();

      // Notifikasi kolektor (WA) — best-effort.
      setImmediate(async () => {
        try {
          const { User, CollectorProfile } = require('../models');
          const u = await User.findByPk(dep.collector_id, { attributes: ['phone'] });
          let phone = u && u.phone ? u.phone : null;
          if (!phone) {
            const prof = await CollectorProfile.findOne({ where: { user_id: dep.collector_id }, attributes: ['phone'] });
            phone = prof && prof.phone ? prof.phone : null;
          }
          await require('../services/CollectNotifier').notifyDepositVerified(dep, phone);
        } catch (_) {}
      });

      res.json({
        success: true,
        message: parseFloat(dep.variance) !== 0
          ? `Setoran diverifikasi. Catatan: ada selisih Rp${Math.abs(parseFloat(dep.variance)).toLocaleString('id-ID')} (${parseFloat(dep.variance) < 0 ? 'kurang' : 'lebih'} setor).`
          : 'Setoran diverifikasi.',
        data: { id: dep.id }
      });
    } catch (e) {
      try { await t.rollback(); } catch (_) {}
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── ADMIN: tolak setoran ──────────────────────────────────────────
  async reject(req, res) {
    try {
      const dep = await CashDeposit.findByPk(req.params.id);
      if (!dep) return res.status(404).json({ success: false, message: 'Setoran tidak ditemukan' });
      if (dep.status === 'verified') return res.status(409).json({ success: false, message: 'Setoran sudah diverifikasi, tidak bisa ditolak.' });
      const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.slice(0, 255) : null;
      await dep.update({ status: 'rejected', reject_reason: reason });
      // cash_held TIDAK diubah saat reject — uang dianggap masih di tangan kolektor.

      // Notifikasi kolektor (WA) — best-effort.
      setImmediate(async () => {
        try {
          const { User, CollectorProfile } = require('../models');
          const u = await User.findByPk(dep.collector_id, { attributes: ['phone'] });
          let phone = u && u.phone ? u.phone : null;
          if (!phone) {
            const prof = await CollectorProfile.findOne({ where: { user_id: dep.collector_id }, attributes: ['phone'] });
            phone = prof && prof.phone ? prof.phone : null;
          }
          await require('../services/CollectNotifier').notifyDepositRejected(dep, phone);
        } catch (_) {}
      });

      res.json({ success: true, message: 'Setoran ditolak.', data: { id: dep.id } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new CashDepositController();
