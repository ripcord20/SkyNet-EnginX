/**
 * ResellerAdminController.js — Manajemen Reseller (sisi admin/owner).
 * ─────────────────────────────────────────────────────────────────────────────
 * Dipakai dari panel admin (mounted di /api/reseller-admin, butuh authenticate
 * + role superadmin/admin). Fungsi:
 *   - CRUD akun reseller
 *   - Top-up / adjust saldo (tercatat di ledger)
 *   - CRUD paket voucher reseller
 *   - Laporan agregat semua reseller
 */
const { Op, fn, col, literal } = require('sequelize');
const {
  sequelize, Reseller, ResellerVoucherPackage, ResellerTransaction, ResellerTopup, Device,
  ResellerPackagePrice, ResellerVoucherLog, ResellerPromo, ResellerPromoRedemption,
  PublicVoucherOrder
} = require('../models');
const ResellerTopupService = require('../services/ResellerTopupService');
const ResellerPricingService = require('../services/ResellerPricingService');
const PublicVoucherService = require('../services/PublicVoucherService');
const HotspotService = require('../services/HotspotService');
const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

// ── Helper status voucher hotspot (selaras dengan ResellerController) ──
function _isResellerUser(u, code) {
  if (!code) return false;
  return (u.comment || '').indexOf('Reseller: ' + code) !== -1;
}
function _voucherUsed(u) {
  const up = String(u.uptime || '0s');
  const hasUptime = up && up !== '0s' && up !== '00:00:00' && up !== '0';
  const bytes = (Number(u.bytesIn) || 0) + (Number(u.bytesOut) || 0);
  return hasUptime || bytes > 0;
}
function _parseMtDuration(str) {
  if (!str) return 0;
  str = String(str).trim();
  if (!str || str === '0s' || str === '0') return 0;
  if (/^\d{1,3}:\d{2}:\d{2}$/.test(str)) {
    const [h, m, s] = str.split(':').map(Number); return h * 3600 + m * 60 + s;
  }
  let total = 0; const re = /(\d+)([wdhms])/g; let m;
  const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  while ((m = re.exec(str)) !== null) total += parseInt(m[1]) * (mult[m[2]] || 0);
  return total;
}
function _voucherStatus(u, isActive) {
  if (isActive) return 'active';
  if (!_voucherUsed(u)) return 'unused';
  const limit = _parseMtDuration(u.limitUptime);
  const consumed = _parseMtDuration(u.uptime);
  if (limit > 0 && consumed > 0 && consumed >= (limit - 2)) return 'expired';
  if (u.disabled) return 'expired';
  return 'used';
}

const ResellerAdminController = {

  // ─── RESELLER CRUD ──────────────────────────────────────────
  async list(req, res) {
    try {
      const q = (req.query.q || '').trim();
      const where = {};
      if (q) {
        where[Op.or] = [
          { name: { [Op.like]: `%${q}%` } },
          { code: { [Op.like]: `%${q}%` } },
          { phone: { [Op.like]: `%${q}%` } }
        ];
      }
      const list = await Reseller.findAll({
        where, order: [['createdAt', 'DESC']],
        include: [{ model: Device, as: 'device', required: false, attributes: ['id', 'name'] }]
      });
      res.json({
        success: true,
        data: list.map(r => ({
          id: r.id, code: r.code, name: r.name, phone: r.phone, address: r.address,
          balance: Number(r.balance), is_active: r.is_active,
          device_id: r.device_id, device_name: r.device ? r.device.name : null,
          hotspot_server: r.hotspot_server, max_per_batch: r.max_per_batch,
          last_login: r.last_login, created_at: r.createdAt
        }))
      });
    } catch (e) {
      logger.error('Admin reseller list error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async detail(req, res) {
    try {
      const r = await Reseller.findByPk(req.params.id, {
        include: [{ model: Device, as: 'device', required: false, attributes: ['id', 'name'] }]
      });
      if (!r) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });

      // Statistik ringkas
      const agg = await ResellerTransaction.findOne({
        where: { reseller_id: r.id, type: 'purchase' },
        attributes: [
          [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
          [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'total']
        ], raw: true
      });
      res.json({
        success: true,
        data: {
          id: r.id, code: r.code, name: r.name, phone: r.phone, address: r.address,
          balance: Number(r.balance), is_active: r.is_active,
          device_id: r.device_id, device_name: r.device ? r.device.name : null,
          hotspot_server: r.hotspot_server, max_per_batch: r.max_per_batch,
          notes: r.notes, last_login: r.last_login, created_at: r.createdAt,
          stats: { total_vouchers: Number(agg.vcount), total_modal: Number(agg.total) }
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async create(req, res) {
    try {
      const { code, name, phone, address, password, device_id, hotspot_server,
              max_per_batch, initial_balance, notes,
              parent_id, commission_percent, price_discount_percent, price_tier } = req.body;
      if (!code || !name || !password) {
        return res.status(400).json({ success: false, message: 'Kode, nama, dan password wajib diisi' });
      }
      const exists = await Reseller.findOne({ where: { code: String(code).trim() } });
      if (exists) return res.status(409).json({ success: false, message: 'Kode reseller sudah dipakai' });

      const reseller = await sequelize.transaction(async (t) => {
        const r = await Reseller.create({
          code: String(code).trim(), name: name.trim(), phone, address, password,
          device_id: device_id || null, hotspot_server: hotspot_server || 'all',
          max_per_batch: parseInt(max_per_batch) || 100,
          parent_id: parent_id || null,
          commission_percent: Number(commission_percent) || 0,
          price_discount_percent: Number(price_discount_percent) || 0,
          price_tier: price_tier || null,
          balance: 0, notes
        }, { transaction: t });

        const init = Number(initial_balance) || 0;
        if (init > 0) {
          await r.update({ balance: init }, { transaction: t });
          await ResellerTransaction.create({
            reseller_id: r.id, type: 'topup', amount: init,
            balance_before: 0, balance_after: init,
            description: 'Saldo awal saat pembuatan akun',
            created_by: req.user?.id || null
          }, { transaction: t });
        }
        return r;
      });

      res.json({ success: true, message: 'Reseller berhasil dibuat', data: { id: reseller.id, code: reseller.code } });
    } catch (e) {
      logger.error('Admin reseller create error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async update(req, res) {
    try {
      const r = await Reseller.findByPk(req.params.id);
      if (!r) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });

      const { name, phone, address, device_id, hotspot_server, max_per_batch,
              is_active, notes, password,
              parent_id, commission_percent, price_discount_percent, price_tier } = req.body;

      const patch = {};
      if (name !== undefined) patch.name = name;
      if (phone !== undefined) patch.phone = phone;
      if (address !== undefined) patch.address = address;
      if (device_id !== undefined) patch.device_id = device_id || null;
      if (hotspot_server !== undefined) patch.hotspot_server = hotspot_server || 'all';
      if (max_per_batch !== undefined) patch.max_per_batch = parseInt(max_per_batch) || 100;
      if (is_active !== undefined) patch.is_active = !!is_active;
      if (notes !== undefined) patch.notes = notes;
      if (password) patch.password = password; // hook akan hash ulang
      if (parent_id !== undefined) patch.parent_id = (parent_id && Number(parent_id) !== r.id) ? parent_id : null;
      if (commission_percent !== undefined) patch.commission_percent = Number(commission_percent) || 0;
      if (price_discount_percent !== undefined) patch.price_discount_percent = Number(price_discount_percent) || 0;
      if (price_tier !== undefined) patch.price_tier = price_tier || null;

      await r.update(patch);
      res.json({ success: true, message: 'Reseller berhasil diperbarui' });
    } catch (e) {
      logger.error('Admin reseller update error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async remove(req, res) {
    try {
      const r = await Reseller.findByPk(req.params.id);
      if (!r) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });
      // Soft-disable lebih aman daripada hapus (transaksi tetap punya FK).
      // Hapus penuh hanya kalau belum ada transaksi.
      const txCount = await ResellerTransaction.count({ where: { reseller_id: r.id } });
      if (txCount > 0) {
        await r.update({ is_active: false });
        return res.json({ success: true, message: 'Reseller dinonaktifkan (punya riwayat transaksi)' });
      }
      await r.destroy();
      res.json({ success: true, message: 'Reseller dihapus' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── TOP-UP / ADJUST SALDO ──────────────────────────────────
  async topup(req, res) {
    try {
      const r = await Reseller.findByPk(req.params.id);
      if (!r) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });

      const amount = Number(req.body.amount);
      const type = req.body.type === 'adjust' ? 'adjust' : 'topup';
      const description = (req.body.description || '').trim() ||
        (type === 'topup' ? 'Top-up saldo' : 'Penyesuaian saldo');

      if (!amount || isNaN(amount) || amount === 0) {
        return res.status(400).json({ success: false, message: 'Nominal tidak valid' });
      }
      // topup harus positif; adjust boleh +/-.
      if (type === 'topup' && amount < 0) {
        return res.status(400).json({ success: false, message: 'Top-up harus bernilai positif' });
      }

      let after;
      await sequelize.transaction(async (t) => {
        const locked = await Reseller.findByPk(r.id, { lock: t.LOCK.UPDATE, transaction: t });
        const before = Number(locked.balance);
        after = before + amount;
        if (after < 0) {
          const err = new Error('Penyesuaian membuat saldo negatif. Ditolak.');
          err.code = 'NEG'; throw err;
        }
        await locked.update({ balance: after }, { transaction: t });
        await ResellerTransaction.create({
          reseller_id: r.id, type, amount,
          balance_before: before, balance_after: after,
          description, created_by: req.user?.id || null
        }, { transaction: t });
      });

      res.json({ success: true, message: 'Saldo diperbarui', data: { balance: after } });
    } catch (e) {
      if (e.code === 'NEG') return res.status(400).json({ success: false, message: e.message });
      logger.error('Admin topup error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Riwayat transaksi seorang reseller (sisi admin)
  async transactions(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 30);
      const { count, rows } = await ResellerTransaction.findAndCountAll({
        where: { reseller_id: req.params.id },
        order: [['createdAt', 'DESC']],
        limit, offset: (page - 1) * limit
      });
      res.json({
        success: true,
        data: rows.map(tx => ({
          id: tx.id, type: tx.type, amount: Number(tx.amount),
          balance_after: Number(tx.balance_after), description: tx.description,
          package_name: tx.package_name, voucher_count: tx.voucher_count,
          created_at: tx.createdAt
        })),
        pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── PAKET VOUCHER CRUD ─────────────────────────────────────
  async packageList(req, res) {
    try {
      const list = await ResellerVoucherPackage.findAll({
        order: [['sort_order', 'ASC'], ['cost_price', 'ASC']],
        include: [{ model: Device, as: 'device', required: false, attributes: ['id', 'name'] }]
      });
      res.json({
        success: true,
        data: list.map(p => ({
          id: p.id, name: p.name, mikrotik_profile: p.mikrotik_profile,
          device_id: p.device_id, device_name: p.device ? p.device.name : null,
          duration_label: p.duration_label, limit_uptime: p.limit_uptime,
          limit_bytes_total: Number(p.limit_bytes_total),
          cost_price: Number(p.cost_price), sell_price: Number(p.sell_price),
          prefix: p.prefix, code_length: p.code_length,
          is_active: p.is_active, sort_order: p.sort_order,
          is_public: !!p.is_public, public_price: p.public_price != null ? Number(p.public_price) : null
        }))
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async packageCreate(req, res) {
    try {
      const b = req.body;
      if (!b.name || !b.mikrotik_profile) {
        return res.status(400).json({ success: false, message: 'Nama & profile MikroTik wajib diisi' });
      }
      const p = await ResellerVoucherPackage.create({
        name: b.name.trim(), mikrotik_profile: b.mikrotik_profile.trim(),
        device_id: b.device_id || null,
        duration_label: b.duration_label || null,
        limit_uptime: b.limit_uptime || '',
        limit_bytes_total: parseInt(b.limit_bytes_total) || 0,
        cost_price: Number(b.cost_price) || 0,
        sell_price: Number(b.sell_price) || 0,
        prefix: b.prefix || 'v', code_length: parseInt(b.code_length) || 5,
        is_active: b.is_active !== undefined ? !!b.is_active : true,
        is_public: b.is_public !== undefined ? !!b.is_public : false,
        public_price: (b.public_price !== undefined && b.public_price !== null && b.public_price !== '')
          ? Number(b.public_price) || 0 : null,
        sort_order: parseInt(b.sort_order) || 0
      });
      res.json({ success: true, message: 'Paket dibuat', data: { id: p.id } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async packageUpdate(req, res) {
    try {
      const p = await ResellerVoucherPackage.findByPk(req.params.id);
      if (!p) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });
      const b = req.body;
      const patch = {};
      ['name', 'mikrotik_profile', 'duration_label', 'limit_uptime', 'prefix'].forEach(k => {
        if (b[k] !== undefined) patch[k] = b[k];
      });
      if (b.device_id !== undefined) patch.device_id = b.device_id || null;
      if (b.limit_bytes_total !== undefined) patch.limit_bytes_total = parseInt(b.limit_bytes_total) || 0;
      if (b.cost_price !== undefined) patch.cost_price = Number(b.cost_price) || 0;
      if (b.sell_price !== undefined) patch.sell_price = Number(b.sell_price) || 0;
      if (b.code_length !== undefined) patch.code_length = parseInt(b.code_length) || 5;
      if (b.is_active !== undefined) patch.is_active = !!b.is_active;
      if (b.is_public !== undefined) patch.is_public = !!b.is_public;
      if (b.public_price !== undefined) {
        patch.public_price = (b.public_price === null || b.public_price === '')
          ? null : Number(b.public_price) || 0;
      }
      if (b.sort_order !== undefined) patch.sort_order = parseInt(b.sort_order) || 0;
      await p.update(patch);
      res.json({ success: true, message: 'Paket diperbarui' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async packageRemove(req, res) {
    try {
      const p = await ResellerVoucherPackage.findByPk(req.params.id);
      if (!p) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });
      await p.destroy();
      res.json({ success: true, message: 'Paket dihapus' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── TOP-UP REQUESTS (verifikasi manual/qris) ───────────────
  async topupList(req, res) {
    try {
      const status = req.query.status; // optional filter
      const where = {};
      if (status && ['pending', 'waiting_verification', 'paid', 'rejected', 'expired'].includes(status)) {
        where.status = status;
      }
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 30);
      const { count, rows } = await ResellerTopup.findAndCountAll({
        where, order: [['createdAt', 'DESC']], limit, offset: (page - 1) * limit,
        include: [{ model: Reseller, as: 'reseller', attributes: ['id', 'code', 'name', 'phone'] }]
      });
      res.json({
        success: true,
        data: rows.map(t => ({
          id: t.id, ref: t.ref, method: t.method, amount: Number(t.amount),
          status: t.status, target_account: t.target_account, note: t.note,
          has_proof: !!t.proof_path, gateway_provider: t.gateway_provider,
          reseller: t.reseller ? { id: t.reseller.id, code: t.reseller.code, name: t.reseller.name, phone: t.reseller.phone } : null,
          created_at: t.createdAt, paid_at: t.paid_at, reject_reason: t.reject_reason
        })),
        pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
      });
    } catch (e) {
      logger.error('Admin topupList error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Lihat file bukti transfer (stream, hanya admin).
  async topupProof(req, res) {
    try {
      const t = await ResellerTopup.findByPk(req.params.id);
      if (!t || !t.proof_path) return res.status(404).send('Bukti tidak ditemukan');
      const PROOF_DIR = path.join(__dirname, '..', '..', 'uploads', 'payment_proofs');
      const filePath = path.join(PROOF_DIR, path.basename(t.proof_path));
      if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ada');
      return res.sendFile(filePath);
    } catch (e) {
      res.status(500).send('Error');
    }
  },

  // Detail satu top-up (untuk modal detail yang lengkap di admin).
  async topupDetail(req, res) {
    try {
      const t = await ResellerTopup.findByPk(req.params.id, {
        include: [
          { model: Reseller, as: 'reseller', attributes: ['id', 'code', 'name', 'phone'] },
          { model: require('../models').User, as: 'verifier', attributes: ['id', 'name', 'username'] }
        ]
      });
      if (!t) return res.status(404).json({ success: false, message: 'Top-up tidak ditemukan' });
      res.json({
        success: true,
        data: {
          id: t.id, ref: t.ref, method: t.method, amount: Number(t.amount),
          status: t.status, target_account: t.target_account, note: t.note,
          has_proof: !!t.proof_path,
          proof_url: t.proof_path ? `/api/reseller-admin/topups/${t.id}/proof` : null,
          gateway_provider: t.gateway_provider, gateway_ref: t.gateway_ref,
          gateway_method: t.gateway_method, payment_url: t.payment_url,
          reject_reason: t.reject_reason,
          reseller: t.reseller ? { id: t.reseller.id, code: t.reseller.code, name: t.reseller.name, phone: t.reseller.phone } : null,
          verifier: t.verifier ? { name: t.verifier.name || t.verifier.username } : null,
          created_at: t.createdAt, paid_at: t.paid_at, verified_at: t.verified_at, expires_at: t.expires_at
        }
      });
    } catch (e) {
      logger.error('Admin topupDetail error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── HOTSPOT SERVERS (untuk dropdown server saat tambah/edit reseller) ──
  // Ambil daftar hotspot server dari MikroTik milik device terpilih.
  async hotspotServers(req, res) {
    try {
      const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
      const mt = await getMikrotikInstanceByDevice(deviceId || null);
      const svc = new HotspotService(mt);
      const servers = await svc.getServers();
      // Selalu sediakan opsi "all" + nama-nama server hotspot.
      const names = (servers || []).map(s => s.name).filter(Boolean);
      res.json({ success: true, data: { servers: names } });
    } catch (e) {
      logger.warn('Admin hotspotServers error:', e.message);
      // Best-effort: kalau router tak terjangkau, kembalikan list kosong
      // supaya UI tetap bisa fallback ke input manual.
      res.json({ success: false, message: 'Gagal mengambil server hotspot dari router: ' + e.message, data: { servers: [] } });
    }
  },

  // Daftar user-profile hotspot dari router (untuk setup paket voucher publik).
  async hotspotProfiles(req, res) {
    try {
      const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
      const mt = await getMikrotikInstanceByDevice(deviceId || null);
      const svc = new HotspotService(mt);
      const profiles = await svc.getUserProfiles();
      const data = (profiles || []).map(p => ({
        name: p.name || '',
        rateLimit: p.rateLimit || p['rate-limit'] || '',
        sessionTimeout: p.sessionTimeout || p['session-timeout'] || ''
      })).filter(p => p.name);
      res.json({ success: true, data });
    } catch (e) {
      logger.warn('Admin hotspotProfiles error:', e.message);
      res.json({ success: false, message: 'Gagal mengambil profile hotspot dari router: ' + e.message, data: [] });
    }
  },

  // ─── VOUCHER HOTSPOT per RESELLER (admin) ───────────────────
  // Daftar user hotspot milik 1 reseller + status online/expired/dll.
  async resellerVouchers(req, res) {
    try {
      const reseller = await Reseller.findByPk(req.params.id, { include: [{ model: Device, as: 'device' }] });
      if (!reseller) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });

      const filter = (req.query.status || '').toLowerCase();
      const q = (req.query.q || '').trim().toLowerCase();

      const mt = await getMikrotikInstanceByDevice(reseller.device_id || null);
      const svc = new HotspotService(mt);
      const [users, sessions] = await Promise.all([
        svc.getUsers({}).catch(() => []),
        svc.getActiveSessions().catch(() => [])
      ]);
      const mine = (users || []).filter(u => _isResellerUser(u, reseller.code));
      const activeSet = new Set((sessions || []).map(s => s.user));

      let out = mine.map(u => ({
        id: u.id, username: u.name, password: u.password, profile: u.profile, server: u.server,
        uptime: u.uptime, bytes_total: (Number(u.bytesIn) || 0) + (Number(u.bytesOut) || 0),
        limit_uptime: u.limitUptime, disabled: u.disabled,
        status: _voucherStatus(u, activeSet.has(u.name))
      }));
      if (['active', 'expired', 'used', 'unused'].includes(filter)) out = out.filter(v => v.status === filter);
      if (q) out = out.filter(v => v.username.toLowerCase().includes(q) || (v.profile || '').toLowerCase().includes(q));

      const counts = { total: mine.length, active: 0, expired: 0, used: 0, unused: 0 };
      mine.forEach(u => { const st = _voucherStatus(u, activeSet.has(u.name)); counts[st] = (counts[st] || 0) + 1; });

      res.json({
        success: true,
        reseller: { id: reseller.id, code: reseller.code, name: reseller.name, device_name: reseller.device ? reseller.device.name : 'Default' },
        data: out, counts
      });
    } catch (e) {
      logger.error('Admin resellerVouchers error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal memuat voucher dari router: ' + e.message });
    }
  },

  // Aksi voucher (admin): hapus / putus sesi. Hanya user milik reseller terkait.
  async resellerVoucherAction(req, res) {
    try {
      const reseller = await Reseller.findByPk(req.params.id);
      if (!reseller) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });
      const action = req.body.action;
      const username = (req.body.username || '').trim();
      if (!username) return res.status(400).json({ success: false, message: 'Username wajib diisi' });
      if (!['delete', 'disconnect'].includes(action)) return res.status(400).json({ success: false, message: 'Aksi tidak dikenal' });

      const mt = await getMikrotikInstanceByDevice(reseller.device_id || null);
      const svc = new HotspotService(mt);
      const users = await svc.getUsers({});
      const target = (users || []).find(u => u.name === username && _isResellerUser(u, reseller.code));
      if (!target) return res.status(404).json({ success: false, message: 'Voucher tidak ditemukan / bukan milik reseller ini' });

      if (action === 'disconnect') {
        const sessions = await svc.getActiveSessions();
        const sess = (sessions || []).find(s => s.user === username);
        if (!sess) return res.json({ success: true, message: 'Tidak ada sesi aktif' });
        await svc.disconnectSession(sess.id);
        return res.json({ success: true, message: 'Sesi diputus' });
      }
      // delete
      try {
        const sessions = await svc.getActiveSessions();
        const sess = (sessions || []).find(s => s.user === username);
        if (sess) await svc.disconnectSession(sess.id);
      } catch (_) {}
      await svc.deleteUser(target.id);
      res.json({ success: true, message: 'Voucher dihapus' });
    } catch (e) {
      logger.error('Admin resellerVoucherAction error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal: ' + e.message });
    }
  },

  // ─── #8 BULK ACTION VOUCHER (hapus/disconnect banyak sekaligus) ──
  // body: { usernames:[], action:'delete'|'disconnect', status?:'expired' }
  // Bila `status` diisi & usernames kosong → ambil semua voucher berstatus itu.
  async resellerVoucherBulk(req, res) {
    try {
      const reseller = await Reseller.findByPk(req.params.id);
      if (!reseller) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });
      const action = req.body.action;
      if (!['delete', 'disconnect', 'disable'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Aksi tidak dikenal' });
      }

      const mt = await getMikrotikInstanceByDevice(reseller.device_id || null);
      const svc = new HotspotService(mt);
      const [users, sessions] = await Promise.all([
        svc.getUsers({}).catch(() => []),
        svc.getActiveSessions().catch(() => [])
      ]);
      const activeSet = new Set((sessions || []).map(s => s.user));
      let mine = (users || []).filter(u => _isResellerUser(u, reseller.code));

      // Target: berdasarkan daftar username, atau berdasarkan status.
      let targets;
      if (Array.isArray(req.body.usernames) && req.body.usernames.length) {
        const set = new Set(req.body.usernames);
        targets = mine.filter(u => set.has(u.name));
      } else if (req.body.status) {
        targets = mine.filter(u => _voucherStatus(u, activeSet.has(u.name)) === req.body.status);
      } else {
        return res.status(400).json({ success: false, message: 'Pilih voucher atau status terlebih dahulu' });
      }
      if (!targets.length) return res.json({ success: true, message: 'Tidak ada voucher yang cocok', affected: 0 });

      let ok = 0, fail = 0;
      for (const u of targets) {
        try {
          if (action === 'disconnect') {
            const sess = (sessions || []).find(s => s.user === u.name);
            if (sess) await svc.disconnectSession(sess.id);
          } else if (action === 'disable') {
            await svc.disableUser(u.id);
          } else { // delete
            const sess = (sessions || []).find(s => s.user === u.name);
            if (sess) { try { await svc.disconnectSession(sess.id); } catch (_) {} }
            await svc.deleteUser(u.id);
            // tandai di audit log bila ada
            try { await ResellerVoucherLog.update({ status: 'deleted' }, { where: { reseller_id: reseller.id, username: u.name } }); } catch (_) {}
          }
          ok++;
        } catch (_) { fail++; }
      }
      res.json({ success: true, message: `${ok} voucher diproses${fail ? `, ${fail} gagal` : ''}`, affected: ok, failed: fail });
    } catch (e) {
      logger.error('resellerVoucherBulk error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal: ' + e.message });
    }
  },

  // ─── #7 AUDIT LOG VOUCHER ───────────────────────────────────
  async resellerVoucherLogs(req, res) {
    try {
      const where = {};
      if (req.params.id) where.reseller_id = req.params.id;
      if (req.query.status) where.status = req.query.status;
      if (req.query.q) where.username = { [Op.like]: `%${req.query.q}%` };
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(200, parseInt(req.query.limit) || 50);
      const { rows, count } = await ResellerVoucherLog.findAndCountAll({
        where, order: [['createdAt', 'DESC']],
        limit, offset: (page - 1) * limit,
        include: [{ model: Reseller, as: 'reseller', attributes: ['code', 'name'] }]
      });
      res.json({
        success: true, total: count, page, limit,
        data: rows.map(v => ({
          id: v.id, username: v.username, password: v.password, profile: v.profile,
          package_name: v.package_name, sell_price: Number(v.sell_price || 0),
          cost_price: Number(v.cost_price || 0), status: v.status,
          created_at: v.createdAt,
          reseller: v.reseller ? { code: v.reseller.code, name: v.reseller.name } : null
        }))
      });
    } catch (e) {
      logger.error('resellerVoucherLogs error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── #2 HARGA MODAL PER RESELLER (override per paket) ────────
  // GET: daftar paket + harga efektif untuk reseller; PUT: simpan override.
  async resellerPrices(req, res) {
    try {
      const reseller = await Reseller.findByPk(req.params.id);
      if (!reseller) return res.status(404).json({ success: false, message: 'Reseller tidak ditemukan' });

      if (req.method === 'GET') {
        const packages = await ResellerVoucherPackage.findAll({
          where: { is_active: true }, order: [['sort_order', 'ASC'], ['name', 'ASC']]
        });
        const costMap = await ResellerPricingService.effectiveCostMap(reseller, packages);
        const overrides = await ResellerPackagePrice.findAll({ where: { reseller_id: reseller.id }, raw: true });
        const ovrMap = {}; overrides.forEach(o => { ovrMap[o.package_id] = Number(o.cost_price); });
        return res.json({
          success: true,
          reseller: { id: reseller.id, code: reseller.code, name: reseller.name, discount_percent: Number(reseller.price_discount_percent), tier: reseller.price_tier },
          data: packages.map(p => ({
            package_id: p.id, name: p.name,
            base_cost: Number(p.cost_price), sell_price: Number(p.sell_price),
            effective_cost: costMap[p.id].effective, source: costMap[p.id].source,
            override: ovrMap[p.id] != null ? ovrMap[p.id] : null
          }))
        });
      }

      // PUT — body: { discount_percent?, tier?, overrides: [{package_id, cost_price|null}] }
      if (req.body.discount_percent !== undefined || req.body.tier !== undefined) {
        await reseller.update({
          price_discount_percent: req.body.discount_percent !== undefined ? Number(req.body.discount_percent) || 0 : reseller.price_discount_percent,
          price_tier: req.body.tier !== undefined ? (req.body.tier || null) : reseller.price_tier
        });
      }
      if (Array.isArray(req.body.overrides)) {
        for (const o of req.body.overrides) {
          if (!o.package_id) continue;
          if (o.cost_price === null || o.cost_price === '' || o.cost_price === undefined) {
            await ResellerPackagePrice.destroy({ where: { reseller_id: reseller.id, package_id: o.package_id } });
          } else {
            const val = Math.max(0, Number(o.cost_price) || 0);
            const [row, created] = await ResellerPackagePrice.findOrCreate({
              where: { reseller_id: reseller.id, package_id: o.package_id },
              defaults: { cost_price: val }
            });
            if (!created) await row.update({ cost_price: val });
          }
        }
      }
      res.json({ success: true, message: 'Harga reseller diperbarui' });
    } catch (e) {
      logger.error('resellerPrices error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── #4 SUB-RESELLER (keagenan bertingkat) ──────────────────
  async subResellers(req, res) {
    try {
      const parentId = req.params.id;
      const children = await Reseller.findAll({
        where: { parent_id: parentId },
        attributes: ['id', 'code', 'name', 'phone', 'balance', 'is_active', 'commission_percent'],
        order: [['name', 'ASC']]
      });
      res.json({ success: true, data: children.map(c => ({
        id: c.id, code: c.code, name: c.name, phone: c.phone,
        balance: Number(c.balance), is_active: c.is_active,
        commission_percent: Number(c.commission_percent)
      })) });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── #10 PROMO TOP-UP (CRUD admin) ──────────────────────────
  async promoList(req, res) {
    try {
      const promos = await ResellerPromo.findAll({ order: [['createdAt', 'DESC']] });
      res.json({ success: true, data: promos });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },
  async promoSave(req, res) {
    try {
      const b = req.body;
      const payload = {
        code: b.code ? String(b.code).trim().toUpperCase() : null,
        name: b.name || 'Promo',
        type: ['percent', 'fixed'].includes(b.type) ? b.type : 'percent',
        value: Number(b.value) || 0,
        min_topup: Number(b.min_topup) || 0,
        max_bonus: Number(b.max_bonus) || 0,
        auto_apply: !!b.auto_apply,
        quota_total: parseInt(b.quota_total) || 0,
        quota_per_reseller: parseInt(b.quota_per_reseller) || 1,
        starts_at: b.starts_at || null,
        ends_at: b.ends_at || null,
        is_active: b.is_active !== undefined ? !!b.is_active : true
      };
      let promo;
      if (req.params.id) {
        promo = await ResellerPromo.findByPk(req.params.id);
        if (!promo) return res.status(404).json({ success: false, message: 'Promo tidak ditemukan' });
        await promo.update(payload);
      } else {
        promo = await ResellerPromo.create(payload);
      }
      res.json({ success: true, message: 'Promo disimpan', data: promo });
    } catch (e) {
      if (e.name === 'SequelizeUniqueConstraintError') {
        return res.status(400).json({ success: false, message: 'Kode promo sudah dipakai' });
      }
      logger.error('promoSave error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },
  async promoRemove(req, res) {
    try {
      const promo = await ResellerPromo.findByPk(req.params.id);
      if (!promo) return res.status(404).json({ success: false, message: 'Promo tidak ditemukan' });
      await promo.destroy();
      res.json({ success: true, message: 'Promo dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  // Verifikasi (setujui) top-up manual/qris → kredit saldo.
  async topupVerify(req, res) {
    try {
      const t = await ResellerTopup.findByPk(req.params.id);
      if (!t) return res.status(404).json({ success: false, message: 'Top-up tidak ditemukan' });
      if (t.credited || t.status === 'paid') {
        return res.status(400).json({ success: false, message: 'Top-up ini sudah lunas.' });
      }
      if (t.method === 'gateway') {
        return res.status(400).json({ success: false, message: 'Top-up gateway diproses otomatis, tidak perlu verifikasi manual.' });
      }
      const result = await ResellerTopupService.creditTopup(t.id, { verified_by: req.user?.id });
      res.json({ success: true, message: 'Top-up disetujui & saldo dikreditkan', data: { balance: result.balance } });
    } catch (e) {
      logger.error('Admin topupVerify error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Tolak top-up manual/qris.
  async topupReject(req, res) {
    try {
      const t = await ResellerTopup.findByPk(req.params.id);
      if (!t) return res.status(404).json({ success: false, message: 'Top-up tidak ditemukan' });
      if (t.credited || t.status === 'paid') {
        return res.status(400).json({ success: false, message: 'Top-up sudah lunas, tidak bisa ditolak.' });
      }
      await t.update({
        status: 'rejected',
        reject_reason: (req.body.reason || '').toString().slice(0, 255) || 'Bukti tidak valid',
        verified_by: req.user?.id || null, verified_at: new Date()
      });
      res.json({ success: true, message: 'Top-up ditolak' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Pengaturan metode top-up reseller (aktif/nonaktif, minimal).
  async topupSettings(req, res) {
    try {
      const { AppSetting } = require('../models');
      if (req.method === 'GET') {
        const cfg = await ResellerTopupService.getTopupConfig();
        return res.json({ success: true, data: cfg });
      }
      // POST/PUT — simpan
      const upsert = async (key, val) => {
        const [row, created] = await AppSetting.findOrCreate({ where: { key }, defaults: { key, value: String(val) } });
        if (!created) await row.update({ value: String(val) });
      };
      const b = req.body || {};
      if (b.manual_enabled !== undefined) await upsert('reseller_topup_manual_enabled', b.manual_enabled ? 'true' : 'false');
      if (b.gateway_enabled !== undefined) await upsert('reseller_topup_gateway_enabled', b.gateway_enabled ? 'true' : 'false');
      if (b.min_topup !== undefined) await upsert('reseller_topup_min', parseInt(b.min_topup) || 10000);
      res.json({ success: true, message: 'Pengaturan top-up disimpan' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── LAPORAN GLOBAL (semua reseller) ────────────────────────
  async globalReport(req, res) {
    try {
      const from = req.query.from ? new Date(req.query.from + 'T00:00:00') : null;
      const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59') : null;
      const purchaseWhere = { type: 'purchase' };
      if (from || to) {
        purchaseWhere.createdAt = {};
        if (from) purchaseWhere.createdAt[Op.gte] = from;
        if (to)   purchaseWhere.createdAt[Op.lte] = to;
      }

      // Penjualan voucher per reseller (modal = ABS(amount) yang dipotong).
      const perReseller = await ResellerTransaction.findAll({
        where: purchaseWhere,
        attributes: [
          'reseller_id',
          [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
          [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'total']
        ],
        group: ['reseller_id'],
        order: [[literal('total'), 'DESC']],
        include: [{ model: Reseller, as: 'reseller', attributes: ['code', 'name'] }]
      });

      // Hitung omzet + keuntungan per paket → estimasi profit global.
      // (sell-cost) * qty, pakai harga paket saat ini. Modal selalu akurat.
      const perPackage = await ResellerTransaction.findAll({
        where: purchaseWhere,
        attributes: [
          'package_id',
          [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
          [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'modal']
        ],
        group: ['package_id'], raw: true
      });
      const pkgIds = perPackage.map(p => p.package_id).filter(Boolean);
      let sellMap = {};
      if (pkgIds.length) {
        const pkgs = await ResellerVoucherPackage.findAll({
          where: { id: { [Op.in]: pkgIds } }, attributes: ['id', 'sell_price', 'cost_price'], raw: true
        });
        pkgs.forEach(p => { sellMap[p.id] = { sell: Number(p.sell_price), cost: Number(p.cost_price) }; });
      }
      let totalRevenue = 0, totalProfit = 0, totalModal = 0, totalVouchers = 0;
      perPackage.forEach(p => {
        const v = Number(p.vcount), m = Number(p.modal);
        const sp = sellMap[p.package_id];
        const rev = sp ? sp.sell * v : m;
        totalRevenue += rev; totalProfit += Math.max(0, rev - m);
        totalModal += m; totalVouchers += v;
      });

      // Pemasukan dari deposit (top-up yang berhasil masuk saldo).
      const topupWhere = { type: 'topup' };
      if (purchaseWhere.createdAt) topupWhere.createdAt = purchaseWhere.createdAt;
      const topupAgg = await ResellerTransaction.findOne({
        where: topupWhere,
        attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total'], [fn('COUNT', col('id')), 'cnt']],
        raw: true
      });

      const totalBalances = await Reseller.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('balance')), 0), 'total']], raw: true
      });
      const resellerCount = await Reseller.count();

      // Deret harian (untuk chart): voucher terjual + modal per hari.
      const startChart = new Date();
      startChart.setHours(0, 0, 0, 0);
      startChart.setDate(startChart.getDate() - 13);
      const daily = await ResellerTransaction.findAll({
        where: { type: 'purchase', createdAt: { [Op.gte]: (from || startChart) } },
        attributes: [
          [fn('DATE', col('created_at')), 'd'],
          [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
          [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'modal']
        ],
        group: [literal('DATE(created_at)')],
        order: [[literal('DATE(created_at)'), 'ASC']],
        raw: true
      });
      const dailyTopup = await ResellerTransaction.findAll({
        where: { type: 'topup', createdAt: { [Op.gte]: (from || startChart) } },
        attributes: [
          [fn('DATE', col('created_at')), 'd'],
          [fn('COALESCE', fn('SUM', col('amount')), 0), 'topup']
        ],
        group: [literal('DATE(created_at)')], raw: true
      });
      const topupByDay = {};
      dailyTopup.forEach(x => { topupByDay[String(x.d)] = Number(x.topup); });

      // Bangun deret penuh dari from..to (atau 14 hari terakhir).
      const rangeStart = from || startChart;
      const rangeEnd = to || new Date();
      const labels = [], chartVouchers = [], chartModal = [], chartTopup = [];
      const dayMap = {};
      daily.forEach(x => { dayMap[String(x.d)] = { v: Number(x.vcount), m: Number(x.modal) }; });
      const cur = new Date(rangeStart); cur.setHours(0, 0, 0, 0);
      let guard = 0;
      while (cur <= rangeEnd && guard < 120) {
        const key = cur.toISOString().slice(0, 10);
        labels.push(key);
        chartVouchers.push(dayMap[key] ? dayMap[key].v : 0);
        chartModal.push(dayMap[key] ? dayMap[key].m : 0);
        chartTopup.push(topupByDay[key] || 0);
        cur.setDate(cur.getDate() + 1); guard++;
      }

      // Ranking reseller + estimasi omzet/profit per reseller (proporsional
      // berdasarkan paket; di sini pakai pendekatan sederhana: modal → profit
      // mengikuti rasio global agar konsisten dengan total).
      const profitRatio = totalModal > 0 ? (totalProfit / totalModal) : 0;
      const revRatio = totalModal > 0 ? (totalRevenue / totalModal) : 1;
      const ranking = perReseller.map(row => {
        const modal = Number(row.get('total'));
        return {
          reseller_id: row.reseller_id,
          code: row.reseller ? row.reseller.code : '-',
          name: row.reseller ? row.reseller.name : '-',
          vouchers: Number(row.get('vcount')),
          modal,
          revenue: Math.round(modal * revRatio),
          profit: Math.round(modal * profitRatio)
        };
      });

      res.json({
        success: true,
        data: {
          summary: {
            reseller_count: resellerCount,
            total_vouchers: totalVouchers,
            total_modal: totalModal,
            total_revenue: totalRevenue,
            total_profit: totalProfit,
            total_topup: Number(topupAgg.total),
            topup_count: Number(topupAgg.cnt),
            total_outstanding_balance: Number(totalBalances.total)
          },
          chart: { labels, vouchers: chartVouchers, modal: chartModal, topup: chartTopup },
          ranking,
          // kompatibel mundur dengan UI lama:
          total_outstanding_balance: Number(totalBalances.total),
          per_reseller: ranking.map(r => ({
            reseller_id: r.reseller_id, code: r.code, name: r.name,
            vouchers: r.vouchers, modal: r.modal
          }))
        }
      });
    } catch (e) {
      logger.error('Admin global report error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Order voucher publik (halaman /beli) ─────────────────────────
  // Daftar order; filter status opsional (?status=paid|pending|delivered|...).
  async publicOrderList(req, res) {
    try {
      const where = {};
      if (req.query.status) where.status = String(req.query.status);
      if (req.query.q) {
        const q = `%${String(req.query.q).trim()}%`;
        where[Op.or] = [
          { order_code: { [Op.like]: q } },
          { buyer_name: { [Op.like]: q } },
          { buyer_wa: { [Op.like]: q } }
        ];
      }
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const rows = await PublicVoucherOrder.findAll({
        where, order: [['created_at', 'DESC']], limit
      });
      res.json({
        success: true,
        data: rows.map(o => ({
          id: o.id, order_code: o.order_code, package_name: o.package_name,
          amount: Number(o.amount), buyer_name: o.buyer_name, buyer_wa: o.buyer_wa,
          buyer_email: o.buyer_email, payment_method: o.payment_method, status: o.status,
          gateway_provider: o.gateway_provider, has_proof: !!o.proof_path,
          voucher_username: o.voucher_username, voucher_password: o.voucher_password,
          delivered_wa: !!o.delivered_wa, delivered_email: !!o.delivered_email,
          paid_at: o.paid_at, delivered_at: o.delivered_at, created_at: o.created_at
        }))
      });
    } catch (e) {
      logger.error('Admin publicOrderList error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Lihat bukti transfer manual (stream file dari folder terproteksi).
  async publicOrderProof(req, res) {
    try {
      const o = await PublicVoucherOrder.findByPk(req.params.id);
      if (!o || !o.proof_path) return res.status(404).json({ success: false, message: 'Bukti tidak ditemukan' });
      const filePath = path.join(__dirname, '..', '..', 'uploads', o.proof_path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'File tidak ada' });
      res.sendFile(filePath);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Verifikasi manual → tandai paid & fulfill (generate voucher + kirim).
  async publicOrderVerify(req, res) {
    try {
      const o = await PublicVoucherOrder.findByPk(req.params.id);
      if (!o) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
      if (o.status === 'delivered') {
        return res.json({ success: true, message: 'Order sudah diproses sebelumnya', already: true });
      }
      if (!['pending', 'paid'].includes(o.status)) {
        return res.status(400).json({ success: false, message: `Order berstatus ${o.status}, tidak bisa diverifikasi` });
      }
      const r = await PublicVoucherService.markPaidAndFulfill(o.id, 'manual-admin');
      if (!r.success) return res.status(502).json({ success: false, message: r.message });
      await o.reload();
      res.json({
        success: true,
        message: 'Voucher dibuat & dikirim ke pembeli',
        data: {
          voucher_username: o.voucher_username, voucher_password: o.voucher_password,
          delivered_wa: !!o.delivered_wa, delivered_email: !!o.delivered_email
        }
      });
    } catch (e) {
      logger.error('Admin publicOrderVerify error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Tolak order manual.
  async publicOrderReject(req, res) {
    try {
      const o = await PublicVoucherOrder.findByPk(req.params.id);
      if (!o) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
      if (o.status === 'delivered') {
        return res.status(400).json({ success: false, message: 'Order sudah dikirim, tidak bisa ditolak' });
      }
      await o.update({ status: 'failed', notes: (o.notes || '') + ` | Ditolak admin: ${(req.body && req.body.reason) || '-'}` });
      res.json({ success: true, message: 'Order ditolak' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
};

module.exports = ResellerAdminController;
