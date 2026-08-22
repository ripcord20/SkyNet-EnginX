'use strict';
const { RegistrationRequest, SalesProfile, User, Package } = require('../models');
const CoverageService = require('../services/CoverageService');

/**
 * PublicRegistrationController
 * ──────────────────────────────────────────────────────────────────
 * Endpoint & halaman PUBLIK (tanpa login) untuk pendaftaran pelanggan
 * baru via link referral sales: /registrasi-layanan/:code
 *
 * Flow:
 *   GET  /registrasi-layanan/:code  → render halaman form (resolve sales)
 *   GET  /pub/reg/packages          → daftar paket aktif (JSON)
 *   POST /pub/reg/coverage          → cek coverage by koordinat
 *   POST /pub/reg/submit            → submit pendaftaran (buat lead)
 */

// Resolve referral code → sales user (atau null kalau invalid)
async function resolveSales(code) {
  if (!code) return null;
  const profile = await SalesProfile.findOne({
    where: { referral_code: code, is_active: true },
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'is_active'] }]
  });
  if (!profile || !profile.user || !profile.user.is_active) return null;
  return { sales_id: profile.user.id, sales_name: profile.user.name, referral_code: code };
}

// ── Halaman form publik ───────────────────────────────────────
exports.renderPage = async (req, res, next) => {
  try {
    const sales = await resolveSales(req.params.code);
    // Ambil pengaturan background halaman pendaftaran (opsional)
    let bgUrl = '', bgOverlay = '';
    try {
      const { AppSetting } = require('../models');
      const rows = await AppSetting.findAll({ where: { key: ['register_bg_url', 'register_bg_overlay'] } });
      rows.forEach(r => { if (r.key === 'register_bg_url') bgUrl = r.value || ''; if (r.key === 'register_bg_overlay') bgOverlay = r.value || ''; });
    } catch (_) {}
    // Walau kode invalid, tetap render form (daftar langsung tanpa atribusi)
    res.render('pages/public-register', {
      title: 'Pendaftaran Pelanggan Baru',
      layout: false,
      referralCode: req.params.code || '',
      salesName: sales?.sales_name || null,
      validCode: !!sales,
      bgUrl,
      bgOverlay
    });
  } catch (e) { next(e); }
};

// ── Daftar paket aktif ────────────────────────────────────────
exports.packages = async (req, res) => {
  try {
    const rows = await Package.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'speed_down', 'speed_up', 'price', 'category', 'description'],
      order: [['price', 'ASC']]
    });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Coverage check publik ─────────────────────────────────────
exports.coverage = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const r = await CoverageService.check(latitude, longitude);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    // Ke publik kita sembunyikan detail teknis ODP; cukup status + estimasi
    res.json({
      success: true,
      data: {
        coverage_status: r.coverage_status,
        message: r.message,
        cable_estimate: r.cable_estimate,
        nearest_odp_distance: r.nearest_odp?.distance ?? null
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Submit pendaftaran ────────────────────────────────────────
exports.submit = async (req, res) => {
  try {
    const b = req.body || {};

    // 1) Honeypot anti-bot: field tersembunyi 'website' harus kosong.
    //    Bot biasanya mengisi semua field; manusia tidak melihat field ini.
    if (b.website || b.url || b.company_website) {
      // Pura-pura sukses agar bot tidak tahu terdeteksi (silent drop).
      return res.json({ success: true, data: { reg_number: 'REG-PENDING' }, message: 'Pendaftaran diterima.' });
    }

    // 2) Validasi & normalisasi input (longgar tapi cukup untuk cegah sampah)
    const clean = s => (typeof s === 'string' ? s.trim() : (s == null ? '' : String(s).trim()));
    const name = clean(b.name);
    let phone = clean(b.phone).replace(/[\s\-().]/g, ''); // buang spasi/strip/kurung
    const address = clean(b.address);

    if (!name || !phone || !address)
      return res.status(400).json({ success: false, message: 'Nama, nomor WhatsApp, dan alamat wajib diisi' });

    if (name.length < 2)
      return res.status(400).json({ success: false, message: 'Nama terlalu pendek (minimal 2 huruf)' });
    if (name.length > 100)
      return res.status(400).json({ success: false, message: 'Nama terlalu panjang (maksimal 100 huruf)' });
    if (address.length < 3)
      return res.status(400).json({ success: false, message: 'Alamat terlalu pendek, mohon lebih lengkap' });
    if (address.length > 1000)
      return res.status(400).json({ success: false, message: 'Alamat terlalu panjang' });

    // Nomor telepon: ambil digit saja (boleh +62). Terima 7–15 digit.
    const phoneDigits = phone.replace(/^\+/, '').replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15)
      return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid (7–15 digit)' });
    phone = phoneDigits;

    // Email opsional: validasi format ringan bila diisi
    const email = clean(b.email) || null;
    if (email && (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))
      return res.status(400).json({ success: false, message: 'Format email tidak valid' });

    // KTP opsional: hanya digit, maks 30
    const idCard = clean(b.id_card_number).replace(/\D/g, '') || null;

    // package_id → integer atau null (cegah SequelizeValidationError)
    let packageId = null;
    if (b.package_id != null && b.package_id !== '') {
      const pid = parseInt(b.package_id, 10);
      packageId = isNaN(pid) ? null : pid;
    }

    // Koordinat opsional: validasi rentang bila diisi
    let lat = null, lng = null;
    if (b.latitude != null && b.latitude !== '') {
      const v = parseFloat(b.latitude);
      if (!isNaN(v) && v >= -90 && v <= 90) lat = v;
    }
    if (b.longitude != null && b.longitude !== '') {
      const v = parseFloat(b.longitude);
      if (!isNaN(v) && v >= -180 && v <= 180) lng = v;
    }
    const notes = clean(b.notes).slice(0, 500) || null;

    // 3) Anti-spam: tolak duplikat phone yang masih lead < 24 jam
    const { Op } = require('sequelize');
    const dup = await RegistrationRequest.findOne({
      where: {
        phone: phone,
        status: { [Op.in]: ['lead', 'survey_request'] },
        created_at: { [Op.gte]: new Date(Date.now() - 24 * 3600 * 1000) }
      }
    });
    if (dup) return res.status(409).json({ success: false, message: 'Pendaftaran dengan nomor ini sudah masuk dan sedang diproses.' });

    let sales = await resolveSales(b.referral_code || req.params.code);

    // Auto-assign berdasarkan AREA bila tidak ada kode referral & ada koordinat.
    // Cocokkan kecamatan/kota dari titik lead dengan region sales.
    let assignedByArea = false;
    if (!sales && lat != null && lng != null) {
      try {
        const AreaAssign = require('../services/AreaAssignService');
        const m = await AreaAssign.assignByArea(lat, lng);
        if (m) { sales = m; assignedByArea = true; }
      } catch (_) { /* abaikan — lead tetap masuk tanpa sales */ }
    }

    // Validasi package_id benar-benar ada (cegah FK error). Jika tidak ada, abaikan.
    if (packageId != null) {
      try {
        const Package = require('../models').Package;
        const pkg = await Package.findByPk(packageId);
        if (!pkg) packageId = null;
      } catch (_) { packageId = null; }
    }

    const baseData = {
      name: name, phone: phone, email: email,
      id_card_number: idCard,
      address: address,
      latitude: lat, longitude: lng,
      package_id: packageId, notes: notes,
      sales_id: sales?.sales_id || null,
      referral_code: sales?.referral_code || null,
      source: assignedByArea ? 'walk_in' : 'referral_link', status: 'lead'
    };

    let reg;
    try {
      reg = await RegistrationRequest.create(baseData);
    } catch (createErr) {
      // Fallback: kalau gagal karena package_id/koordinat, coba tanpa keduanya
      if (createErr && (createErr.name === 'SequelizeForeignKeyConstraintError' ||
                        createErr.name === 'SequelizeValidationError')) {
        reg = await RegistrationRequest.create({ ...baseData, package_id: null, latitude: null, longitude: null });
      } else {
        throw createErr;
      }
    }

    // Auto coverage snapshot — JANGAN sampai gagal coverage membatalkan pendaftaran
    let coverage = null;
    try {
      if (reg.latitude && reg.longitude) {
        const r = await CoverageService.check(reg.latitude, reg.longitude);
        if (r && r.ok) {
          await reg.update({
            coverage_status: r.coverage_status,
            nearest_odp_id: r.nearest_odp?.id || null,
            nearest_odp_distance: r.nearest_odp?.distance || null,
            nearest_pop_id: r.nearest_pop?.id || null,
            nearest_pop_distance: r.nearest_pop?.distance || null,
            cable_estimate: r.cable_estimate || null
          });
          coverage = { status: r.coverage_status, message: r.message };
        }
      }
    } catch (covErr) {
      // abaikan — pendaftaran tetap berhasil walau cek coverage gagal
    }

    // Notifikasi in-app ke sales bila lead ter-assign (referral / auto-area)
    if (sales && sales.sales_id) {
      try {
        const { Notification } = require('../models');
        const n = await Notification.create({
          user_id: sales.sales_id, type: 'sales',
          title: assignedByArea ? 'Lead baru (area Anda)' : 'Lead baru dari link Anda',
          message: `${name}${address ? ' · ' + address : ''} baru mendaftar (${reg.reg_number}).`,
          severity: 'info', link: '/sales#pipeline'
        });
        if (global.__io) global.__io.emit('notification:new', { id: n.id, type: 'sales', title: 'Lead baru', message: name, severity: 'info' });
      } catch (_) {}
    }

    res.status(201).json({
      success: true,
      message: 'Pendaftaran berhasil! Tim kami akan menghubungi Anda untuk proses survey & instalasi.',
      data: { reg_number: reg.reg_number, coverage }
    });
  } catch (e) {
    // Sequelize menyimpan detail di e.errors; e.message hanya "Validation error".
    let msg = e.message;
    if (e && Array.isArray(e.errors) && e.errors.length) {
      msg = e.errors.map(x => x.message).join(', ');
    }
    if (e && e.name === 'SequelizeUniqueConstraintError') {
      msg = 'Data sudah terdaftar. Coba lagi.';
    }
    console.error('[public submit error]', e && e.name, msg);
    res.status(400).json({ success: false, message: msg || 'Gagal memproses pendaftaran' });
  }
};
