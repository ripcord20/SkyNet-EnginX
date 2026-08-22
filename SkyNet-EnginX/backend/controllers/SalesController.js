'use strict';
const path = require('path');
const fs   = require('fs');
const multer = require('multer');
const { Op } = require('sequelize');
const {
  sequelize, User, Role, Package, Customer, WorkOrder,
  SalesProfile, RegistrationRequest, SalesCommission, InfrastructurePoint, Notification
} = require('../models');
const { generateUniqueCustomerId } = require('../utils/helpers');
const logger = require('../utils/logger');
const CoverageService   = require('../services/CoverageService');
const CommissionService = require('../services/CommissionService');

// Helper: kirim notifikasi in-app ke user (sales/admin). Tidak melempar error.
async function notifySales(userId, { title, message, severity = 'info', link = '/sales' }) {
  if (!userId || !Notification) return;
  try {
    const n = await Notification.create({ user_id: userId, type: 'sales', title, message, severity, link });
    if (global.__io) global.__io.emit('notification:new', { id: n.id, type: 'sales', title, message, severity });
    return n;
  } catch (e) { console.error('[notifySales]', e.message); }
}

// ── Upload storage (foto survey) ──────────────────────────────
const uploadDir = path.join(__dirname, '../../frontend/public/uploads/sales');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `srv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  }
});
const _multerCfg = {
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp)$/i.test(path.extname(file.originalname));
    cb(ok ? null : new Error('Hanya file gambar yang diizinkan'), ok);
  }
};
exports.uploadMiddleware = multer(_multerCfg).array('photos', 12);
// Single named photo (ktp/house/installed) → field name 'photo'
exports.uploadSingle = multer(_multerCfg).single('photo');
// Bukti pembayaran komisi → field name 'proof'
exports.uploadProof = multer(_multerCfg).single('proof');

// ── Helpers ───────────────────────────────────────────────────
function isSalesRole(req)      { return (req.user?.role?.name || '').toLowerCase() === 'sales'; }
function isPrivileged(req)     { const r = (req.user?.role?.name || '').toLowerCase(); return ['superadmin', 'admin'].includes(r); }

// Sales hanya boleh melihat data miliknya; admin/superadmin lihat semua.
function salesScope(req, base = {}) {
  if (isSalesRole(req)) return { ...base, sales_id: req.user.id };
  return base;
}

const REG_INCLUDE = [
  { model: Package, as: 'package', attributes: ['id', 'name', 'price', 'category'], required: false },
  { model: User,    as: 'sales',   attributes: ['id', 'name'], required: false }
];

// ═══════════════════════════════════════════════════════════════
// SALES PROFILE (referral code, target, skema komisi)
// ═══════════════════════════════════════════════════════════════

// Pastikan user sales punya SalesProfile; auto-create kalau belum ada.
async function ensureProfile(userId) {
  let p = await SalesProfile.findOne({ where: { user_id: userId } });
  if (!p) {
    p = await SalesProfile.create({ user_id: userId, referral_code: SalesProfile.generateCode() });
  }
  return p;
}

// GET /api/sales/me  — profil + link referral milik sales yang login
exports.myProfile = async (req, res) => {
  try {
    const profile = await ensureProfile(req.user.id);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      data: {
        ...profile.toJSON(),
        referral_link: `${base}/registrasi-layanan/${profile.referral_code}`
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// PUT /api/sales/me — update sebagian field profil (sales boleh ubah phone/region)
exports.updateMyProfile = async (req, res) => {
  try {
    const profile = await ensureProfile(req.user.id);
    const allowed = ['phone', 'region'];
    const fields = {};
    allowed.forEach(k => { if (k in req.body) fields[k] = req.body[k]; });
    await profile.update(fields);
    res.json({ success: true, data: profile });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// ── Admin: kelola semua sales & skema komisinya ───────────────
// GET /api/sales/team
exports.listSales = async (req, res) => {
  try {
    const salesRole = await Role.findOne({ where: { name: 'sales' } });
    if (!salesRole) return res.json({ success: true, data: [] });
    const users = await User.findAll({
      where: { role_id: salesRole.id },
      attributes: ['id', 'name', 'email', 'phone', 'is_active'],
      order: [['name', 'ASC']]
    });
    const profiles = await SalesProfile.findAll();
    const pMap = {}; profiles.forEach(p => { pMap[p.user_id] = p; });

    const data = await Promise.all(users.map(async (u) => {
      let prof = pMap[u.id];
      if (!prof) prof = await ensureProfile(u.id);
      const [activated, earned, paid] = await Promise.all([
        RegistrationRequest.count({ where: { sales_id: u.id, status: 'activated' } }),
        SalesCommission.sum('amount', { where: { sales_id: u.id, status: { [Op.in]: ['earned', 'approved'] } } }),
        SalesCommission.sum('amount', { where: { sales_id: u.id, status: 'paid' } })
      ]);
      return {
        ...u.toJSON(),
        profile: prof,
        total_activated: activated,
        commission_earned: Number(earned || 0),
        commission_paid: Number(paid || 0)
      };
    }));
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// POST /api/sales/team — admin/owner buat akun sales baru sekaligus profil + area.
// Body: { name, email, password, phone, region, monthly_target, target_bonus,
//         commission_home, commission_business, commission_enterprise, commission_custom }
exports.createSalesUser = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    const email = (b.email || '').trim().toLowerCase();
    const password = b.password || '';
    if (!name || !email || !password) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Nama, email, dan password wajib diisi' });
    }
    if (password.length < 6) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Format email tidak valid' });
    }

    // Email unik
    const exists = await User.findOne({ where: { email } });
    if (exists) {
      await t.rollback();
      return res.status(409).json({ success: false, message: 'Email sudah terdaftar' });
    }

    // Role sales
    const salesRole = await Role.findOne({ where: { name: 'sales' } });
    if (!salesRole) {
      await t.rollback();
      return res.status(400).json({ success: false, message: "Role 'sales' belum ada. Restart server untuk auto-migrasi." });
    }

    // Buat user (hook bcrypt di model User akan hash password)
    const user = await User.create({
      name, email, password,
      phone: (b.phone || '').trim() || null,
      role_id: salesRole.id,
      is_active: true
    }, { transaction: t });

    // Buat profil sales + area + skema komisi
    const profile = await SalesProfile.create({
      user_id: user.id,
      referral_code: SalesProfile.generateCode(),
      phone: (b.phone || '').trim() || null,
      region: (b.region || '').trim() || null,
      monthly_target: b.monthly_target || 0,
      target_bonus: b.target_bonus || 0,
      commission_home: b.commission_home || 0,
      commission_business: b.commission_business || 0,
      commission_enterprise: b.commission_enterprise || 0,
      commission_custom: b.commission_custom || 0,
      is_active: true
    }, { transaction: t });

    await t.commit();
    res.status(201).json({
      success: true,
      message: 'Akun sales berhasil dibuat',
      data: { id: user.id, name: user.name, email: user.email, referral_code: profile.referral_code }
    });
  } catch (e) {
    await t.rollback();
    res.status(500).json({ success: false, message: e.message });
  }
};

// PUT /api/sales/team/:userId/profile — admin set target & skema komisi
exports.updateSalesProfile = async (req, res) => {
  try {
    const profile = await ensureProfile(parseInt(req.params.userId));
    const allowed = [
      'phone', 'region', 'monthly_target', 'target_bonus',
      'commission_home', 'commission_business', 'commission_enterprise', 'commission_custom',
      'is_active'
    ];
    const fields = {};
    allowed.forEach(k => { if (k in req.body) fields[k] = req.body[k]; });
    await profile.update(fields);
    res.json({ success: true, data: profile });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// POST /api/sales/team/:userId/regenerate-code
exports.regenerateCode = async (req, res) => {
  try {
    const profile = await ensureProfile(parseInt(req.params.userId));
    let code, tries = 0;
    do { code = SalesProfile.generateCode(); tries++; }
    while (await SalesProfile.findOne({ where: { referral_code: code } }) && tries < 10);
    await profile.update({ referral_code: code });
    res.json({ success: true, data: profile });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════
// GET /api/sales/referral-links — daftar semua sales + link referral + statistik
// berapa pendaftar & aktivasi via link tsb. Admin lihat semua; sales hanya dirinya.
exports.listReferralLinks = async (req, res) => {
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const profWhere = {};
    if (isSalesRole(req)) profWhere.user_id = req.user.id;

    const profiles = await SalesProfile.findAll({
      where: profWhere,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'is_active'] }],
      order: [['created_at', 'ASC']]
    });

    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const data = await Promise.all(profiles.map(async (p) => {
      const code = p.referral_code;
      // Hitung registrasi via link ini (punya referral_code = kode sales)
      const [total, activated, thisMonth] = await Promise.all([
        RegistrationRequest.count({ where: { referral_code: code } }),
        RegistrationRequest.count({ where: { referral_code: code, status: 'activated' } }),
        RegistrationRequest.count({ where: { referral_code: code, created_at: { [Op.gte]: monthStart } } })
      ]);
      const conv = total > 0 ? Math.round((activated / total) * 100) : 0;
      return {
        sales_id: p.user ? p.user.id : null,
        sales_name: p.user ? p.user.name : '-',
        sales_email: p.user ? p.user.email : null,
        is_active: p.user ? p.user.is_active !== false : true,
        region: p.region || null,
        referral_code: code,
        referral_link: `${base}/registrasi-layanan/${code}`,
        total_registrations: total,
        activated, conversion: conv,
        new_this_month: thisMonth
      };
    }));

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.dashboardStats = async (req, res) => {
  try {
    const where = salesScope(req);
    const startMonth = new Date(); startMonth.setDate(1); startMonth.setHours(0, 0, 0, 0);

    const [leads, surveying, installing, activatedMonth, activatedTotal] = await Promise.all([
      RegistrationRequest.count({ where: { ...where, status: 'lead' } }),
      RegistrationRequest.count({ where: { ...where, status: { [Op.in]: ['survey_request', 'surveyed'] } } }),
      RegistrationRequest.count({ where: { ...where, status: { [Op.in]: ['approved', 'installing'] } } }),
      RegistrationRequest.count({ where: { ...where, status: 'activated', activated_at: { [Op.gte]: startMonth } } }),
      RegistrationRequest.count({ where: { ...where, status: 'activated' } })
    ]);

    const commWhere = isSalesRole(req) ? { sales_id: req.user.id } : {};
    const [earned, paid, pendingPay] = await Promise.all([
      SalesCommission.sum('amount', { where: { ...commWhere, status: { [Op.in]: ['earned', 'approved'] } } }),
      SalesCommission.sum('amount', { where: { ...commWhere, status: 'paid' } }),
      SalesCommission.sum('amount', { where: { ...commWhere, status: { [Op.in]: ['earned', 'approved'] }, earned_at: { [Op.gte]: startMonth } } })
    ]);

    // Target (khusus sales)
    let target = null;
    if (isSalesRole(req)) {
      const prof = await ensureProfile(req.user.id);
      target = {
        monthly_target: prof.monthly_target,
        achieved: activatedMonth,
        bonus: Number(prof.target_bonus || 0),
        percent: prof.monthly_target > 0 ? Math.round((activatedMonth / prof.monthly_target) * 100) : 0
      };
    }

    res.json({
      success: true,
      data: {
        leads, surveying, installing,
        activated_month: activatedMonth,
        activated_total: activatedTotal,
        commission_earned: Number(earned || 0),
        commission_paid: Number(paid || 0),
        commission_this_month: Number(pendingPay || 0),
        target
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// GET /api/sales/analytics — data untuk grafik dashboard (7 hari terakhir)
// Mengembalikan: deret harian registrasi & aktivasi, komisi harian,
// distribusi status (funnel), dan heatmap hari×jam dari registrasi.
exports.analytics = async (req, res) => {
  try {
    const where = salesScope(req);
    const commWhere = isSalesRole(req) ? { sales_id: req.user.id } : {};

    // Rentang 7 hari terakhir (termasuk hari ini)
    const days = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push(d);
    }
    const startRange = days[0];

    // Ambil registrasi 7 hari (untuk deret harian + heatmap)
    const regs = await RegistrationRequest.findAll({
      where: { ...where, created_at: { [Op.gte]: startRange } },
      attributes: ['id', 'created_at', 'activated_at', 'status'],
      raw: true
    });
    // Komisi 7 hari
    const comms = await SalesCommission.findAll({
      where: { ...commWhere, earned_at: { [Op.gte]: startRange } },
      attributes: ['amount', 'earned_at'],
      raw: true
    });

    const dayKey = (dt) => {
      const d = new Date(dt); d.setHours(0, 0, 0, 0); return d.getTime();
    };
    const labels = days.map(d => d.toLocaleDateString('id-ID', { weekday: 'short' }));
    const regSeries = days.map(() => 0);
    const actSeries = days.map(() => 0);
    const commSeries = days.map(() => 0);
    const idx = {}; days.forEach((d, i) => { idx[d.getTime()] = i; });

    regs.forEach(r => {
      const k = dayKey(r.created_at);
      if (k in idx) regSeries[idx[k]]++;
      if (r.activated_at) { const ka = dayKey(r.activated_at); if (ka in idx) actSeries[idx[ka]]++; }
    });
    comms.forEach(c => {
      if (!c.earned_at) return;
      const k = dayKey(c.earned_at);
      if (k in idx) commSeries[idx[k]] += Number(c.amount || 0);
    });

    // Distribusi status (funnel)
    const statusCounts = {};
    for (const s of ['lead', 'survey_request', 'surveyed', 'approved', 'installing', 'activated', 'survey_rejected', 'cancelled']) {
      statusCounts[s] = 0;
    }
    const allByStatus = await RegistrationRequest.findAll({
      where, attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'cnt']],
      group: ['status'], raw: true
    });
    allByStatus.forEach(r => { statusCounts[r.status] = Number(r.cnt); });

    // Heatmap hari×blok-jam (4 blok: pagi 6-12, siang 12-17, sore 17-21, malam 21-6)
    const buckets = ['06–12', '12–17', '17–21', '21–06'];
    const bucketOf = (h) => h >= 6 && h < 12 ? 0 : h >= 12 && h < 17 ? 1 : h >= 17 && h < 21 ? 2 : 3;
    const heat = labels.map(() => buckets.map(() => 0));
    regs.forEach(r => {
      const d = new Date(r.created_at); const k = dayKey(r.created_at);
      if (!(k in idx)) return;
      heat[idx[k]][bucketOf(d.getHours())]++;
    });

    // ── Insight lokasi: area terbanyak, belum tercover, sudah activated ──
    const allRegs = await RegistrationRequest.findAll({
      where, attributes: ['id', 'name', 'address', 'status', 'coverage_status', 'latitude', 'longitude', 'activated_at', 'created_at'],
      order: [['created_at', 'DESC']], raw: true, limit: 2000
    });

    // Ekstrak "area" dari alamat: ambil segmen kecamatan/kota (2 segmen terakhir
    // sebelum provinsi bila ada). Fallback: segmen terakhir non-kosong.
    const areaOf = (addr) => {
      if (!addr) return null;
      const parts = String(addr).split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      // cari segmen yang diawali "Kec." dulu (paling representatif)
      const kec = parts.find(p => /^kec\.?\s/i.test(p));
      if (kec) return kec.replace(/^kec\.?\s*/i, 'Kec. ');
      // kalau tidak ada, ambil segmen ke-2 dari belakang (umumnya kecamatan/kota)
      return parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
    };
    const areaCount = {};
    allRegs.forEach(r => {
      const a = areaOf(r.address);
      if (!a) return;
      areaCount[a] = (areaCount[a] || 0) + 1;
    });
    const top_areas = Object.entries(areaCount)
      .map(([area, count]) => ({ area, count }))
      .sort((a, b) => b.count - a.count).slice(0, 8);

    // Permintaan belum tercover (coverage_status not_covered ATAU status masih lead/survey
    // dan tidak available). Tampilkan daftar ringkas.
    const uncovered = allRegs
      .filter(r => r.coverage_status === 'not_covered' || (r.coverage_status && r.coverage_status !== 'available' && ['lead', 'survey_request', 'surveyed'].includes(r.status)))
      .slice(0, 30)
      .map(r => ({ id: r.id, name: r.name, address: r.address, status: r.status, coverage_status: r.coverage_status, latitude: r.latitude, longitude: r.longitude, created_at: r.created_at }));

    // Sudah activated (pelanggan aktif hasil registrasi)
    const activatedList = allRegs
      .filter(r => r.status === 'activated')
      .slice(0, 30)
      .map(r => ({ id: r.id, name: r.name, address: r.address, latitude: r.latitude, longitude: r.longitude, activated_at: r.activated_at }));

    res.json({
      success: true,
      data: {
        labels, reg_series: regSeries, act_series: actSeries, commission_series: commSeries,
        status_counts: statusCounts,
        heatmap: { day_labels: labels, bucket_labels: buckets, matrix: heat },
        top_areas,
        uncovered, uncovered_total: allRegs.filter(r => r.coverage_status === 'not_covered' || (r.coverage_status && r.coverage_status !== 'available' && ['lead', 'survey_request', 'surveyed'].includes(r.status))).length,
        activated: activatedList, activated_total: allRegs.filter(r => r.status === 'activated').length
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// GET /api/sales/potential-areas — Area Potensi.
// Cari titik registrasi/lead yang JAUH dari ODP terdekat (peluang ekspansi):
// kalau banyak calon pelanggan menumpuk di area tanpa ODP, itu kandidat
// pembangunan infrastruktur baru. Mengembalikan titik lead + jarak ke ODP
// terdekat + cluster sederhana (grid ~0.01° ≈ 1.1km).
exports.potentialAreas = async (req, res) => {
  try {
    const where = { ...salesScope(req), latitude: { [Op.ne]: null }, longitude: { [Op.ne]: null } };
    const regs = await RegistrationRequest.findAll({
      where, attributes: ['id', 'name', 'latitude', 'longitude', 'status', 'coverage_status', 'created_at'], raw: true
    });
    // Ambil ODP/ODC aktif utk hitung jarak
    const odps = await InfrastructurePoint.findAll({
      where: { type: { [Op.in]: ['odp', 'odc'] }, latitude: { [Op.ne]: null }, longitude: { [Op.ne]: null } },
      attributes: ['latitude', 'longitude'], raw: true
    });
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dist = (a1, o1, a2, o2) => {
      const dLat = toRad(a2 - a1), dLon = toRad(o2 - o1);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dLon / 2) ** 2;
      return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
    };
    const NEAR = 500; // dianggap ter-cover bila ada ODP <500m
    const points = regs.map(r => {
      const la = parseFloat(r.latitude), lo = parseFloat(r.longitude);
      let nearest = null;
      for (const o of odps) {
        const d = dist(la, lo, parseFloat(o.latitude), parseFloat(o.longitude));
        if (nearest == null || d < nearest) nearest = d;
      }
      return { id: r.id, name: r.name, lat: la, lng: lo, status: r.status,
        nearest_odp_m: nearest, uncovered: nearest == null || nearest > NEAR };
    });

    // Cluster grid: kumpulkan titik uncovered ke sel ~0.01°
    const cells = {};
    points.filter(p => p.uncovered).forEach(p => {
      const key = Math.round(p.lat / 0.01) + ':' + Math.round(p.lng / 0.01);
      if (!cells[key]) cells[key] = { count: 0, sumLat: 0, sumLng: 0, far: 0 };
      const c = cells[key]; c.count++; c.sumLat += p.lat; c.sumLng += p.lng;
      if (p.nearest_odp_m != null) c.far += p.nearest_odp_m;
    });
    const clusters = Object.values(cells).map(c => ({
      lat: c.sumLat / c.count, lng: c.sumLng / c.count, count: c.count,
      avg_distance_m: c.count ? Math.round(c.far / c.count) : null
    })).sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      data: {
        points,
        clusters,
        total_leads: points.length,
        uncovered_leads: points.filter(p => p.uncovered).length,
        hotspots: clusters.filter(c => c.count >= 2)
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// GET /api/sales/kpi — Target & KPI (read-only untuk sales; target diatur admin).
// Progress target bulan ini + ringkasan funnel + tren 6 bulan aktivasi.
exports.kpi = async (req, res) => {
  try {
    const where = salesScope(req);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const prof = isSalesRole(req) ? await ensureProfile(req.user.id) : null;
    const monthlyTarget = prof ? (prof.monthly_target || 0) : 0;
    const targetBonus = prof ? Number(prof.target_bonus || 0) : 0;

    const activatedMonth = await RegistrationRequest.count({
      where: { ...where, status: 'activated', activated_at: { [Op.gte]: monthStart } }
    });
    const leadsMonth = await RegistrationRequest.count({
      where: { ...where, created_at: { [Op.gte]: monthStart } }
    });
    const surveyMonth = await RegistrationRequest.count({
      where: { ...where, status: { [Op.in]: ['surveyed', 'survey_request'] } }
    });
    const totalReg = await RegistrationRequest.count({ where });
    const totalActivated = await RegistrationRequest.count({ where: { ...where, status: 'activated' } });
    const conversion = totalReg > 0 ? Math.round((totalActivated / totalReg) * 100) : 0;

    // Tren 6 bulan (aktivasi per bulan)
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    const trend = [];
    for (let i = 0; i < months.length; i++) {
      const start = months[i];
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      const c = await RegistrationRequest.count({
        where: { ...where, status: 'activated', activated_at: { [Op.gte]: start, [Op.lt]: end } }
      });
      trend.push({ label: start.toLocaleDateString('id-ID', { month: 'short' }), value: c });
    }

    const percent = monthlyTarget > 0 ? Math.round((activatedMonth / monthlyTarget) * 100) : 0;
    res.json({
      success: true,
      data: {
        monthly_target: monthlyTarget,
        achieved: activatedMonth,
        remaining: Math.max(0, monthlyTarget - activatedMonth),
        percent,
        target_bonus: targetBonus,
        target_reached: monthlyTarget > 0 && activatedMonth >= monthlyTarget,
        leads_month: leadsMonth,
        survey_active: surveyMonth,
        conversion_rate: conversion,
        total_activated: totalActivated,
        trend
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// REGISTRATIONS (Installation / Work Order pipeline)
// ═══════════════════════════════════════════════════════════════

// PUT /api/sales/registrations/:id/assign — admin assign/reassign lead ke sales.
// Body: { sales_id } (kosong = lepas), atau { auto:true } utk auto-area.
exports.assignSales = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });

    let salesId = (req.body.sales_id != null && req.body.sales_id !== '') ? parseInt(req.body.sales_id) : null;
    let refCode = null, matchedArea = null;

    if (req.body.auto && reg.latitude && reg.longitude) {
      const AreaAssign = require('../services/AreaAssignService');
      const m = await AreaAssign.assignByArea(parseFloat(reg.latitude), parseFloat(reg.longitude));
      if (!m) return res.json({ success: false, message: 'Tidak ada sales dengan area yang cocok untuk lokasi lead ini.' });
      salesId = m.sales_id; refCode = m.referral_code; matchedArea = m.matched_area;
    } else if (salesId) {
      const prof = await SalesProfile.findOne({ where: { user_id: salesId } });
      refCode = prof?.referral_code || null;
    }

    await reg.update({ sales_id: salesId, referral_code: refCode });
    // Notifikasi ke sales yang baru ditugaskan
    if (salesId) {
      notifySales(salesId, {
        title: 'Lead baru ditugaskan ke Anda',
        message: `${reg.name}${reg.address ? ' · ' + reg.address : ''}${matchedArea ? ' (area: ' + matchedArea + ')' : ''}`,
        severity: 'info', link: '/sales#pipeline'
      });
    }
    res.json({
      success: true,
      message: salesId ? `Lead ditugaskan ke sales${matchedArea ? ' (area: ' + matchedArea + ')' : ''}` : 'Penugasan sales dilepas',
      data: { sales_id: salesId, matched_area: matchedArea }
    });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// GET /api/sales/customers — daftar pelanggan hasil aktivasi (dari registrasi sales).
// Sumber: registrasi berstatus 'activated' (punya customer_id). Sales hanya lihat
// pelanggannya sendiri; admin lihat semua. Filter: ?q= & ?from= & ?to=
exports.listCustomers = async (req, res) => {
  try {
    const where = { status: 'activated', customer_id: { [Op.ne]: null } };
    if (isSalesRole(req)) where.sales_id = req.user.id;
    else if (req.query.sales_id) where.sales_id = parseInt(req.query.sales_id);
    if (req.query.q) {
      where[Op.or] = [
        { name:  { [Op.like]: `%${req.query.q}%` } },
        { phone: { [Op.like]: `%${req.query.q}%` } },
        { address: { [Op.like]: `%${req.query.q}%` } }
      ];
    }
    if (req.query.from || req.query.to) {
      where.activated_at = {};
      if (req.query.from) where.activated_at[Op.gte] = new Date(req.query.from + 'T00:00:00');
      if (req.query.to)   where.activated_at[Op.lte] = new Date(req.query.to + 'T23:59:59');
    }

    const regs = await RegistrationRequest.findAll({
      where, include: REG_INCLUDE, order: [['activated_at', 'DESC']], limit: 1000
    });

    // Ambil data Customer (status real-time + customer_id + installation_date)
    const cids = regs.map(r => r.customer_id).filter(Boolean);
    const customers = cids.length
      ? await Customer.findAll({ where: { id: { [Op.in]: cids } },
          attributes: ['id', 'customer_id', 'status', 'installation_date', 'pppoe_username'] })
      : [];
    const cmap = {};
    customers.forEach(c => { cmap[c.id] = c; });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let newThisMonth = 0;

    const data = regs.map(r => {
      const cust = cmap[r.customer_id] || null;
      const isNew = r.activated_at && new Date(r.activated_at) >= monthStart;
      if (isNew) newThisMonth++;
      return {
        id: r.id,
        customer_db_id: r.customer_id,
        customer_id: cust ? cust.customer_id : null,
        reg_number: r.reg_number,
        name: r.name, phone: r.phone, email: r.email,
        address: r.address,
        latitude: r.latitude, longitude: r.longitude,
        region: r.referral_code ? null : null, // area diturunkan dari sales bila perlu
        package: r.package ? { name: r.package.name, price: r.package.price, category: r.package.category } : null,
        sales: r.sales ? { id: r.sales.id, name: r.sales.name } : null,
        status: cust ? cust.status : 'active',
        pppoe_username: cust ? cust.pppoe_username : null,
        activated_at: r.activated_at,
        installation_date: cust ? cust.installation_date : r.activated_at,
        is_new: isNew
      };
    });

    res.json({
      success: true,
      data,
      summary: {
        total: data.length,
        new_this_month: newThisMonth,
        active: data.filter(d => d.status === 'active').length
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.listRegistrations = async (req, res) => {
  try {
    const where = salesScope(req);
    if (req.query.status) where.status = req.query.status;
    if (req.query.q) {
      where[Op.or] = [
        { name:  { [Op.like]: `%${req.query.q}%` } },
        { phone: { [Op.like]: `%${req.query.q}%` } },
        { reg_number: { [Op.like]: `%${req.query.q}%` } }
      ];
    }
    const rows = await RegistrationRequest.findAll({
      where, include: REG_INCLUDE, order: [['created_at', 'DESC']], limit: 500
    });
    // Normalisasi: pastikan created_at selalu ada di JSON (fallback ke updated_at)
    const data = rows.map(r => {
      const o = r.toJSON();
      o.created_at = o.created_at || o.createdAt || o.updated_at || o.updatedAt || null;
      return o;
    });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.showRegistration = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id, { include: REG_INCLUDE });
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    if (isSalesRole(req) && reg.sales_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    res.json({ success: true, data: reg });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// Sales/Admin buat lead manual (mis. walk-in / telepon)
exports.createRegistration = async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !b.phone || !b.address)
      return res.status(400).json({ success: false, message: 'Nama, telepon, dan alamat wajib diisi' });

    const sales_id = isSalesRole(req) ? req.user.id : (b.sales_id || null);
    let referral_code = null;
    if (sales_id) {
      const prof = await ensureProfile(sales_id);
      referral_code = prof.referral_code;
    }

    const reg = await RegistrationRequest.create({
      name: b.name, phone: b.phone, email: b.email || null,
      id_card_number: b.id_card_number || null,
      address: b.address, latitude: b.latitude || null, longitude: b.longitude || null,
      package_id: b.package_id || null, notes: b.notes || null,
      sales_id, referral_code,
      source: isSalesRole(req) ? 'manual_sales' : (b.source || 'walk_in'),
      status: 'lead'
    });

    // Auto coverage check kalau ada koordinat
    if (reg.latitude && reg.longitude) await runCoverage(reg);

    res.status(201).json({ success: true, data: reg, message: 'Registrasi dibuat' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// Jalankan coverage check & simpan snapshot ke registrasi
async function runCoverage(reg) {
  const r = await CoverageService.check(reg.latitude, reg.longitude);
  if (!r.ok) return r;
  await reg.update({
    coverage_status: r.coverage_status,
    nearest_odp_id: r.nearest_odp?.id || null,
    nearest_odp_distance: r.nearest_odp?.distance || null,
    nearest_pop_id: r.nearest_pop?.id || null,
    nearest_pop_distance: r.nearest_pop?.distance || null,
    cable_estimate: r.cable_estimate || null
  });
  return r;
}

// ── Coverage Checker endpoint (standalone) ────────────────────
// POST /api/sales/coverage-check { latitude, longitude }
exports.coverageCheck = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const r = await CoverageService.check(latitude, longitude);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// GET /api/sales/coverage-points — titik ODP/ODC/POP utk peta coverage.
// Sales diblok dari /api/infrastructure, jadi data disajikan via endpoint ini
// (hanya field aman: nama, tipe, koordinat, kapasitas/port).
exports.coveragePoints = async (req, res) => {
  try {
    const points = await InfrastructurePoint.findAll({
      where: {
        type: { [Op.in]: ['odp', 'odc', 'pop', 'tower'] },
        status: { [Op.ne]: 'inactive' },
        latitude:  { [Op.ne]: null },
        longitude: { [Op.ne]: null }
      },
      attributes: ['id', 'name', 'type', 'latitude', 'longitude', 'capacity', 'used_ports', 'status'],
      limit: 1000
    });
    const data = points.map(p => ({
      id: p.id, name: p.name, type: p.type,
      latitude: Number(p.latitude), longitude: Number(p.longitude),
      capacity: p.capacity, used_ports: p.used_ports || 0,
      free_ports: p.capacity == null ? null : Math.max(0, p.capacity - (p.used_ports || 0)),
      status: p.status
    }));
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// GET /api/sales/customer-points
// Titik sebaran pelanggan (yang punya koordinat) untuk peta clustering di
// tab Analytics. Ringan: hanya field yang dibutuhkan marker + popup.
exports.customerPoints = async (req, res) => {
  try {
    const customers = await Customer.findAll({
      where: {
        latitude:  { [Op.ne]: null },
        longitude: { [Op.ne]: null },
      },
      attributes: ['id', 'customer_id', 'name', 'address', 'status', 'latitude', 'longitude', 'regency', 'district'],
      limit: 5000,
    });
    const data = customers
      .map(c => ({
        id: c.id,
        customer_id: c.customer_id,
        name: c.name,
        address: c.address || '',
        status: c.status,
        regency: c.regency || '',
        district: c.district || '',
        latitude:  Number(c.latitude),
        longitude: Number(c.longitude),
      }))
      .filter(c => !isNaN(c.latitude) && !isNaN(c.longitude));
    res.json({ success: true, data, total: data.length });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
// Body field 'kind' = ktp | house | installed
exports.uploadRegistrationPhoto = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    if (isSalesRole(req) && reg.sales_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });

    const kind = (req.body.kind || '').toLowerCase();
    const fieldMap = { ktp: 'ktp_photo', house: 'house_photo', installed: 'installed_photo' };
    const field = fieldMap[kind];
    if (!field) return res.status(400).json({ success: false, message: 'Jenis foto tidak valid' });

    const url = `/uploads/sales/${req.file.filename}`;
    await reg.update({ [field]: url });
    res.json({ success: true, data: { kind, url }, message: 'Foto tersimpan' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// SURVEY workflow
// ═══════════════════════════════════════════════════════════════

// POST /api/sales/registrations/:id/request-survey { survey_scheduled_date }
exports.requestSurvey = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    await reg.update({
      status: 'survey_request',
      survey_request_at: new Date(),
      survey_scheduled_date: req.body.survey_scheduled_date || null
    });
    res.json({ success: true, data: reg, message: 'Survey diminta' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// PUT /api/sales/registrations/:id/survey-result
exports.submitSurvey = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    const b = req.body;
    await reg.update({
      status: 'surveyed',
      surveyed_at: new Date(),
      survey_by: req.user.id,
      survey_cable_length: b.survey_cable_length || null,
      survey_extra_material: b.survey_extra_material || null,
      survey_cost_estimate: b.survey_cost_estimate || null,
      survey_notes: b.survey_notes || null
    });
    res.json({ success: true, data: reg, message: 'Hasil survey disimpan' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// POST /api/sales/registrations/:id/survey-photos
exports.uploadSurveyPhotos = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    if (!req.files?.length) return res.status(400).json({ success: false, message: 'Tidak ada file' });
    const photos = Array.isArray(reg.survey_photos) ? reg.survey_photos : [];
    req.files.forEach(f => photos.push({ url: `/uploads/sales/${f.filename}`, caption: '', uploaded_at: new Date() }));
    await reg.update({ survey_photos: photos });
    res.json({ success: true, data: reg.survey_photos });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// PUT /api/sales/registrations/:id/reject-survey { reason }
exports.rejectSurvey = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    await reg.update({ status: 'survey_rejected', survey_reject_reason: req.body.reason || null });
    res.json({ success: true, data: reg, message: 'Survey ditolak' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// INSTALLATION workflow — approve → generate Work Order
// ═══════════════════════════════════════════════════════════════

// POST /api/sales/registrations/:id/approve
exports.approve = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    await reg.update({ status: 'approved', approved_by: req.user.id, approved_at: new Date() });
    res.json({ success: true, data: reg, message: 'Registrasi disetujui, siap generate Work Order' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// POST /api/sales/registrations/:id/generate-wo
// Membuat WorkOrder type=installation yang terhubung ke registrasi.
exports.generateWorkOrder = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id, { include: REG_INCLUDE, transaction: t });
    if (!reg) { await t.rollback(); return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' }); }
    if (reg.work_order_id) { await t.rollback(); return res.status(400).json({ success: false, message: 'Work Order sudah dibuat sebelumnya' }); }

    const wo = await WorkOrder.create({
      type: 'installation',
      status: req.body.assigned_user_id ? 'assigned' : 'pending',
      priority: req.body.priority || 'medium',
      title: `Instalasi Baru — ${reg.name}`,
      description: `Registrasi ${reg.reg_number}\nPaket: ${reg.package?.name || '-'}\nCatatan: ${reg.notes || '-'}`,
      assigned_user_id: req.body.assigned_user_id || null,
      technician_name: req.body.technician_name || null,
      technician_phone: req.body.technician_phone || null,
      scheduled_date: req.body.scheduled_date || null,
      location_address: reg.address,
      latitude: reg.latitude, longitude: reg.longitude,
      notes: reg.survey_notes || null,
      created_by: req.user.id
    }, { transaction: t });

    await reg.update({ status: 'installing', work_order_id: wo.id }, { transaction: t });
    await t.commit();
    res.status(201).json({ success: true, data: { registration: reg, work_order: wo }, message: 'Work Order instalasi dibuat' });
  } catch (e) { await t.rollback(); res.status(400).json({ success: false, message: e.message }); }
};

// POST /api/sales/registrations/:id/activate
// Dipanggil manual ATAU otomatis oleh hook WorkOrder.done.
// Membuat Customer + komisi 'earned'. Idempoten.
exports.activate = async (req, res) => {
  try {
    const result = await activateRegistration(parseInt(req.params.id), { activated_by: req.user.id });
    if (!result.ok) return res.status(400).json({ success: false, message: result.message });
    res.json({ success: true, data: result, message: 'Pelanggan diaktifkan & komisi tercatat' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

/**
 * activateRegistration — dipakai controller & WorkOrder hook.
 * Membuat Customer dari data registrasi lalu mencatat komisi.
 */
async function activateRegistration(regId, { activated_by = null } = {}) {
  const t = await sequelize.transaction();
  try {
    const reg = await RegistrationRequest.findByPk(regId, { transaction: t });
    if (!reg) { await t.rollback(); return { ok: false, message: 'Registrasi tidak ditemukan' }; }
    if (reg.status === 'activated' && reg.customer_id) { await t.rollback(); return { ok: true, message: 'Sudah aktif', already: true }; }

    // Buat customer baru
    const newCid = await generateUniqueCustomerId(Customer);
    const customer = await Customer.create({
      customer_id: newCid,
      name: reg.name, phone: reg.phone, email: reg.email,
      address: reg.address, latitude: reg.latitude, longitude: reg.longitude,
      package_id: reg.package_id,
      status: 'active',
      installation_date: new Date(),
      notes: `Dari registrasi ${reg.reg_number}` + (reg.referral_code ? ` (sales ${reg.referral_code})` : '')
    }, { transaction: t });

    await reg.update({
      status: 'activated', customer_id: customer.id, activated_at: new Date()
    }, { transaction: t });

    // Catat komisi (earned)
    let commission = null;
    if (reg.sales_id) {
      commission = await CommissionService.createForActivation({
        sales_id: reg.sales_id,
        registration_id: reg.id,
        customer_id: customer.id,
        package_id: reg.package_id,
        transaction: t
      });
    }

    await t.commit();
    // Notifikasi in-app ke sales (setelah commit; gagal notif tak membatalkan aktivasi)
    if (reg.sales_id) {
      const amt = commission ? Number(commission.amount || 0) : 0;
      notifySales(reg.sales_id, {
        title: 'Komisi baru tercatat 🎉',
        message: `Pelanggan ${reg.name} (${reg.reg_number}) aktif. Komisi Rp${amt.toLocaleString('id-ID')} masuk status earned.`,
        severity: 'info', link: '/sales#commission'
      });
    }
    return { ok: true, customer, commission };
  } catch (e) { await t.rollback(); return { ok: false, message: e.message }; }
}
exports.activateRegistration = activateRegistration;

// ═══════════════════════════════════════════════════════════════
// COMMISSIONS
// ═══════════════════════════════════════════════════════════════
exports.listCommissions = async (req, res) => {
  try {
    const where = isSalesRole(req) ? { sales_id: req.user.id } : {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.sales_id && !isSalesRole(req)) where.sales_id = req.query.sales_id;
    const rows = await SalesCommission.findAll({
      where,
      include: [
        { model: User, as: 'sales', attributes: ['id', 'name'], required: false },
        { model: User, as: 'paidBy', attributes: ['id', 'name'], required: false },
        { model: User, as: 'approvedBy', attributes: ['id', 'name'], required: false },
        { model: RegistrationRequest, as: 'registration', attributes: ['id', 'reg_number', 'name'], required: false }
      ],
      order: [['created_at', 'DESC']], limit: 500
    });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// GET /api/sales/commissions/history — riwayat pembayaran komisi (status paid).
// Filter opsional: ?sales_id= & ?from=YYYY-MM-DD & ?to=YYYY-MM-DD
exports.commissionHistory = async (req, res) => {
  try {
    const where = { status: 'paid' };
    if (isSalesRole(req)) where.sales_id = req.user.id;
    else if (req.query.sales_id) where.sales_id = parseInt(req.query.sales_id);
    if (req.query.from || req.query.to) {
      where.paid_at = {};
      if (req.query.from) where.paid_at[Op.gte] = new Date(req.query.from + 'T00:00:00');
      if (req.query.to)   where.paid_at[Op.lte] = new Date(req.query.to + 'T23:59:59');
    }
    const rows = await SalesCommission.findAll({
      where,
      include: [
        { model: User, as: 'sales',  attributes: ['id', 'name'], required: false },
        { model: User, as: 'paidBy', attributes: ['id', 'name'], required: false },
        { model: RegistrationRequest, as: 'registration', attributes: ['id', 'reg_number', 'name'], required: false }
      ],
      order: [['paid_at', 'DESC']], limit: 1000
    });
    const total = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
    res.json({ success: true, data: rows, summary: { count: rows.length, total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// GET /api/sales/report — data laporan komisi (untuk print/export).
// Query: ?sales_id= (opsional, kosong=semua) & ?from= & ?to= & ?status= (earned|paid|all)
exports.commissionReport = async (req, res) => {
  try {
    const where = {};
    if (isSalesRole(req)) where.sales_id = req.user.id;
    else if (req.query.sales_id) where.sales_id = parseInt(req.query.sales_id);

    const status = req.query.status || 'all';
    if (status === 'earned' || status === 'paid' || status === 'pending') where.status = status;

    // Rentang tanggal berlaku ke earned_at (acuan kapan komisi terjadi)
    const dateCol = status === 'paid' ? 'paid_at' : 'earned_at';
    if (req.query.from || req.query.to) {
      where[dateCol] = {};
      if (req.query.from) where[dateCol][Op.gte] = new Date(req.query.from + 'T00:00:00');
      if (req.query.to)   where[dateCol][Op.lte] = new Date(req.query.to + 'T23:59:59');
    }

    const rows = await SalesCommission.findAll({
      where,
      include: [
        { model: User, as: 'sales',  attributes: ['id', 'name', 'email'], required: false },
        { model: User, as: 'paidBy', attributes: ['id', 'name'], required: false },
        { model: RegistrationRequest, as: 'registration', attributes: ['id', 'reg_number', 'name', 'phone'], required: false }
      ],
      order: [['earned_at', 'DESC']], limit: 5000
    });

    // Ringkasan + agregasi per sales
    const bySales = {};
    let totEarned = 0, totPaid = 0, totPending = 0, totAll = 0;
    rows.forEach(r => {
      const amt = Number(r.amount || 0);
      totAll += amt;
      if (r.status === 'paid') totPaid += amt;
      else if (r.status === 'earned') totEarned += amt;
      else if (r.status === 'pending') totPending += amt;
      const sid = r.sales_id || 0;
      const sname = r.sales?.name || 'Tanpa Sales';
      if (!bySales[sid]) bySales[sid] = { sales_id: sid, sales_name: sname, count: 0, earned: 0, paid: 0, pending: 0, total: 0 };
      const g = bySales[sid];
      g.count++; g.total += amt;
      if (r.status === 'paid') g.paid += amt;
      else if (r.status === 'earned') g.earned += amt;
      else if (r.status === 'pending') g.pending += amt;
    });

    res.json({
      success: true,
      data: rows,
      summary: {
        count: rows.length,
        total: totAll, total_earned: totEarned, total_paid: totPaid, total_pending: totPending,
        by_sales: Object.values(bySales).sort((a, b) => b.total - a.total)
      },
      filters: {
        sales_id: req.query.sales_id || null,
        from: req.query.from || null, to: req.query.to || null, status
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// POST /api/sales/commissions/:id/pay — admin tandai komisi sudah dibayar
exports.payCommission = async (req, res) => {
  try {
    const c = await SalesCommission.findByPk(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Komisi tidak ditemukan' });
    if (c.status === 'paid') return res.status(400).json({ success: false, message: 'Komisi sudah dibayar' });
    // Approval workflow: komisi WAJIB sudah disetujui sebelum bisa dibayar.
    if (c.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Komisi belum disetujui. Setujui dulu sebelum dibayar.' });
    }

    const b = req.body || {};
    let paidAt = new Date();
    if (b.paid_at) { const d = new Date(b.paid_at); if (!isNaN(d.getTime())) paidAt = d; }
    const update = {
      status: 'paid',
      paid_at: paidAt,
      paid_by: req.user.id,
      payment_method: (b.payment_method || '').trim() || null,
      notes: (b.notes || '').trim() || c.notes
    };
    if (req.file) update.payment_proof = `/uploads/sales/${req.file.filename}`;

    await c.update(update);
    if (c.sales_id) notifySales(c.sales_id, {
      title: 'Komisi dibayar 💰',
      message: `Komisi Rp${Number(c.amount||0).toLocaleString('id-ID')} telah dibayarkan.`,
      severity: 'info', link: '/sales#commission'
    });
    res.json({ success: true, data: c, message: 'Pembayaran komisi tercatat' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// POST /api/sales/commissions/:id/approve — setujui komisi (earned → approved)
exports.approveCommission = async (req, res) => {
  try {
    const c = await SalesCommission.findByPk(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Komisi tidak ditemukan' });
    if (c.status === 'paid') return res.status(400).json({ success: false, message: 'Komisi sudah dibayar' });
    if (c.status === 'approved') return res.status(400).json({ success: false, message: 'Komisi sudah disetujui' });
    if (c.status !== 'earned') return res.status(400).json({ success: false, message: 'Hanya komisi berstatus earned yang bisa disetujui' });

    await c.update({ status: 'approved', approved_at: new Date(), approved_by: req.user.id,
      notes: (req.body && req.body.notes ? String(req.body.notes).trim() : c.notes) });
    if (c.sales_id) notifySales(c.sales_id, {
      title: 'Komisi disetujui ✅',
      message: `Komisi Rp${Number(c.amount||0).toLocaleString('id-ID')} disetujui & menunggu pembayaran.`,
      severity: 'info', link: '/sales#commission'
    });
    res.json({ success: true, data: c, message: 'Komisi disetujui' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// POST /api/sales/commissions/approve-bulk { ids: [] }
exports.approveCommissionsBulk = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'Tidak ada komisi dipilih' });
    const [n] = await SalesCommission.update(
      { status: 'approved', approved_at: new Date(), approved_by: req.user.id },
      { where: { id: { [Op.in]: ids }, status: 'earned' } }
    );
    res.json({ success: true, message: `${n} komisi disetujui` });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// POST /api/sales/commissions/pay-bulk { ids: [] } — hanya yang sudah approved
exports.payCommissionsBulk = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'Tidak ada komisi dipilih' });
    const [n] = await SalesCommission.update(
      { status: 'paid', paid_at: new Date(), paid_by: req.user.id },
      { where: { id: { [Op.in]: ids }, status: 'approved' } }
    );
    res.json({ success: true, message: `${n} komisi ditandai dibayar`, skipped: ids.length - n });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

// ── Daftar paket untuk dropdown (digunakan form publik & sales) ──
exports.publicPackages = async (req, res) => {
  try {
    const rows = await Package.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'speed_down', 'speed_up', 'price', 'category', 'description'],
      order: [['price', 'ASC']]
    });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// PENGHAPUSAN REGISTRASI (soft delete)
// ═══════════════════════════════════════════════════════════════
//
// Model RegistrationRequest memakai paranoid:true, jadi destroy() hanya
// mengisi kolom deleted_at. Data tetap ada di tabel dan bisa dipulihkan,
// tapi otomatis hilang dari semua query normal — termasuk statistik
// dashboard dan laporan komisi, tanpa perlu mengubah query yang sudah ada.
//
// ATURAN AKSES:
//   - Sales    : hanya boleh menghapus lead miliknya sendiri
//   - Admin    : boleh menghapus semua KECUALI yang sudah activated
//   - Superadmin: boleh menghapus semua, termasuk activated
//
// Registrasi 'activated' sudah terhubung ke Customer dan komisi sales,
// jadi dibatasi superadmin. Data Customer-nya TIDAK ikut terhapus —
// pelanggan tetap aktif dan tetap ditagih; yang hilang hanya catatan
// pipeline-nya.

// Status yang butuh hak superadmin untuk dihapus.
const PROTECTED_STATUSES = ['activated'];

/**
 * Periksa apakah user boleh menghapus satu registrasi.
 * Mengembalikan { ok: true } atau { ok: false, code, message }.
 */
function canDeleteRegistration(req, reg) {
  const role = (req.user?.role?.name || '').toLowerCase();

  if (!reg) {
    return { ok: false, code: 404, message: 'Registrasi tidak ditemukan' };
  }

  // Sales hanya boleh menyentuh datanya sendiri
  if (isSalesRole(req)) {
    if (reg.sales_id !== req.user.id) {
      return { ok: false, code: 403, message: 'Anda hanya bisa menghapus registrasi milik sendiri' };
    }
    // Sales tidak boleh menghapus yang sudah masuk proses instalasi ke atas —
    // di titik itu sudah ada WO dan pekerjaan teknisi yang tercatat.
    if (['installing', 'activated'].includes(reg.status)) {
      return {
        ok: false, code: 403,
        message: 'Registrasi yang sudah masuk tahap instalasi hanya bisa dihapus admin'
      };
    }
    return { ok: true };
  }

  // Activated hanya boleh dihapus superadmin
  if (PROTECTED_STATUSES.includes(reg.status) && role !== 'superadmin') {
    return {
      ok: false, code: 403,
      message: 'Registrasi yang sudah aktivasi hanya bisa dihapus oleh superadmin'
    };
  }

  if (!isPrivileged(req)) {
    return { ok: false, code: 403, message: 'Akses ditolak' };
  }

  return { ok: true };
}

/**
 * Rangkum dampak penghapusan supaya UI bisa memberi peringatan yang akurat,
 * bukan sekadar "yakin ingin menghapus?".
 */
async function describeImpact(reg) {
  const impact = { customer: null, workOrder: null, commissions: 0 };

  if (reg.customer_id) {
    try {
      const c = await Customer.findByPk(reg.customer_id, { attributes: ['id', 'customer_id', 'name'] });
      if (c) impact.customer = { id: c.id, customer_id: c.customer_id, name: c.name };
    } catch (e) { /* non-fatal */ }
  }

  if (reg.work_order_id) {
    impact.workOrder = { id: reg.work_order_id };
  }

  try {
    impact.commissions = await SalesCommission.count({ where: { registration_id: reg.id } });
  } catch (e) { /* tabel/kolom mungkin belum ada di instalasi lama */ }

  return impact;
}

// GET /api/sales/registrations/:id/delete-impact
// Dipanggil sebelum menampilkan dialog konfirmasi, supaya user tahu
// persis apa yang terpengaruh sebelum menekan Hapus.
exports.registrationDeleteImpact = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    const guard = canDeleteRegistration(req, reg);
    if (!guard.ok) return res.status(guard.code).json({ success: false, message: guard.message });

    const impact = await describeImpact(reg);
    res.json({
      success: true,
      data: {
        id: reg.id,
        reg_number: reg.reg_number,
        name: reg.name,
        status: reg.status,
        protected: PROTECTED_STATUSES.includes(reg.status),
        impact,
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// DELETE /api/sales/registrations/:id
exports.deleteRegistration = async (req, res) => {
  try {
    const reg = await RegistrationRequest.findByPk(req.params.id);
    const guard = canDeleteRegistration(req, reg);
    if (!guard.ok) return res.status(guard.code).json({ success: false, message: guard.message });

    const reason = (req.body?.reason || '').trim();

    // Untuk data yang sudah aktivasi, alasan wajib diisi — ini jejak audit
    // untuk keputusan yang menyentuh pelanggan aktif.
    if (PROTECTED_STATUSES.includes(reg.status) && !reason) {
      return res.status(400).json({
        success: false,
        message: 'Alasan penghapusan wajib diisi untuk registrasi yang sudah aktivasi'
      });
    }

    const impact = await describeImpact(reg);

    // Catat siapa & kenapa SEBELUM destroy, karena setelah soft delete
    // baris tidak lagi terjangkau oleh update biasa.
    await reg.update({
      deleted_by: req.user?.id || null,
      delete_reason: reason || null,
    });
    await reg.destroy(); // paranoid → hanya mengisi deleted_at

    logger.info(
      `[Sales] registrasi #${reg.id} (${reg.reg_number}, status=${reg.status}) ` +
      `dihapus oleh user#${req.user?.id}` + (reason ? ` — alasan: ${reason}` : '')
    );

    res.json({
      success: true,
      message: `Registrasi ${reg.reg_number || '#' + reg.id} dihapus`,
      data: { id: reg.id, impact },
    });
  } catch (e) {
    logger.error('[Sales] deleteRegistration: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/sales/registrations/bulk-delete   { ids: [], reason }
// Setiap baris dicek izinnya sendiri-sendiri; yang tidak lolos dilewati
// dan dilaporkan, bukan membatalkan seluruh operasi.
exports.bulkDeleteRegistrations = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'Tidak ada registrasi dipilih' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ success: false, message: 'Maksimal 200 registrasi per operasi' });
    }

    const reason = (req.body?.reason || '').trim();
    const rows = await RegistrationRequest.findAll({ where: { id: ids } });

    const result = { deleted: 0, skipped: 0, errors: [] };

    for (const reg of rows) {
      const guard = canDeleteRegistration(req, reg);
      if (!guard.ok) {
        result.skipped++;
        result.errors.push({ id: reg.id, reg_number: reg.reg_number, message: guard.message });
        continue;
      }
      if (PROTECTED_STATUSES.includes(reg.status) && !reason) {
        result.skipped++;
        result.errors.push({
          id: reg.id, reg_number: reg.reg_number,
          message: 'Alasan wajib diisi untuk registrasi yang sudah aktivasi'
        });
        continue;
      }
      try {
        await reg.update({ deleted_by: req.user?.id || null, delete_reason: reason || null });
        await reg.destroy();
        result.deleted++;
      } catch (e) {
        result.skipped++;
        result.errors.push({ id: reg.id, reg_number: reg.reg_number, message: e.message });
      }
    }

    // ID yang diminta tapi tidak ditemukan (mis. sudah terhapus sebelumnya)
    const foundIds = new Set(rows.map(r => r.id));
    ids.filter(i => !foundIds.has(i)).forEach(i => {
      result.skipped++;
      result.errors.push({ id: i, message: 'Tidak ditemukan' });
    });

    logger.info(`[Sales] bulk delete — ${result.deleted} dihapus, ${result.skipped} dilewati (user#${req.user?.id})`);

    res.json({
      success: result.deleted > 0,
      message: result.deleted
        ? `${result.deleted} registrasi dihapus` + (result.skipped ? `, ${result.skipped} dilewati` : '')
        : 'Tidak ada registrasi yang bisa dihapus',
      data: result,
    });
  } catch (e) {
    logger.error('[Sales] bulkDeleteRegistrations: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// GET /api/sales/registrations-trash — daftar yang sudah dihapus
exports.listDeletedRegistrations = async (req, res) => {
  try {
    if (!isPrivileged(req)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }
    const rows = await RegistrationRequest.findAll({
      where: { deleted_at: { [Op.ne]: null } },
      include: REG_INCLUDE,
      paranoid: false,            // wajib, kalau tidak baris terhapus ikut tersaring
      order: [['deleted_at', 'DESC']],
      limit: 300,
    });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// POST /api/sales/registrations/:id/restore
exports.restoreRegistration = async (req, res) => {
  try {
    if (!isPrivileged(req)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }
    const reg = await RegistrationRequest.findByPk(req.params.id, { paranoid: false });
    if (!reg) return res.status(404).json({ success: false, message: 'Registrasi tidak ditemukan' });
    if (!reg.deleted_at) {
      return res.status(400).json({ success: false, message: 'Registrasi ini tidak dalam status terhapus' });
    }

    await reg.restore();
    await reg.update({ deleted_by: null, delete_reason: null });

    logger.info(`[Sales] registrasi #${reg.id} dipulihkan oleh user#${req.user?.id}`);
    res.json({ success: true, message: `Registrasi ${reg.reg_number || '#' + reg.id} dipulihkan` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
