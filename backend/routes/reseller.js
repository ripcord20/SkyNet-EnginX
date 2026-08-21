/**
 * reseller.js — Routes Dashboard Reseller Voucher Hotspot.
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount di server.js: app.use('/reseller', resellerRoutes);
 * Pola mengikuti routes/portal.js.
 */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { resellerAuth, resellerSecret } = require('../middleware/resellerAuth');
const Ctrl = require('../controllers/ResellerController');
const WebhookCtrl = require('../controllers/ResellerWebhookController');
const { Reseller, AppSetting } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

// ── Multer untuk bukti transfer top-up (manual/qris) ─────────────
// Disimpan di uploads/payment_proofs (folder yang sama dengan bukti invoice,
// diblokir dari static serving). Hanya gambar / PDF, maks 5 MB.
const PROOF_DIR = path.join(__dirname, '..', '..', 'uploads', 'payment_proofs');
function ensureProofDir() { try { if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true }); } catch (_) {} }
const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => { ensureProofDir(); cb(null, PROOF_DIR); },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const rand = require('crypto').randomBytes(16).toString('hex');
    cb(null, 'rtop_' + Date.now() + '_' + rand + (ext || '.jpg'));
  }
});
const proofUpload = multer({
  storage: proofStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Wajib: mimetype valid (image/* atau pdf) DAN ekstensi cocok.
    const mime = (file.mimetype || '').toLowerCase();
    const nameOk = /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(file.originalname || '');
    const mimeOk = /^image\/(jpe?g|png|webp|heic|heif)$/.test(mime) || mime === 'application/pdf';
    if (mimeOk && nameOk) return cb(null, true);
    cb(new Error('Format file tidak didukung (hanya gambar JPG/PNG/WebP/HEIC atau PDF).'));
  }
});

// ── Login page (auto-redirect kalau cookie masih valid) ──────────
router.get('/login', async (req, res) => {
  try {
    const token = req.cookies && req.cookies.reseller_token;
    if (token) {
      try {
        const decoded = jwt.verify(token, resellerSecret());
        if (decoded.type === 'reseller') {
          const r = await Reseller.findByPk(decoded.id);
          if (r && r.is_active) return res.redirect('/reseller/dashboard');
        }
        res.clearCookie('reseller_token', { path: '/reseller' });
      } catch (_) {
        res.clearCookie('reseller_token', { path: '/reseller' });
      }
    }
  } catch (_) { /* defensive */ }
  // Ambil data perusahaan untuk branding & copyright footer.
  let company = { name: 'FLAYNET', address: '', phone: '', whatsapp: '', bg: '' };
  try {
    const keys = ['company_name', 'app_name', 'company_address', 'company_phone', 'company_whatsapp', 'register_bg_url'];
    const rows = await AppSetting.findAll({ where: { key: { [Op.in]: keys } } });
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    company = {
      name: (map.company_name || map.app_name || 'FLAYNET').trim() || 'FLAYNET',
      address: (map.company_address || '').trim(),
      phone: (map.company_phone || '').trim(),
      // nomor CS untuk WhatsApp (fallback ke telepon perusahaan bila kosong)
      whatsapp: (map.company_whatsapp || map.company_phone || '').trim(),
      // background foto header (sama dengan halaman pendaftaran)
      bg: (map.register_bg_url || '').trim()
    };
  } catch (e) {
    if (typeof logger !== 'undefined') logger.warn('Reseller login company settings:', e.message);
  }
  res.render('reseller/login', { title: 'Reseller Voucher', layout: false, company });
});

// ── Auth API ─────────────────────────────────────────────────────
// Anti brute-force: batasi percobaan login per IP (skip yang sukses).
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10 menit
  max: 10,                    // maks 10 percobaan gagal per IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi dalam beberapa menit.' }
});
router.post('/api/auth/login', loginLimiter, Ctrl.login);
router.post('/api/auth/logout', Ctrl.logout);
router.post('/api/auth/restore-cookie', Ctrl.restoreCookie);

// ── Protected pages ──────────────────────────────────────────────
router.get('/', resellerAuth, (req, res) =>
  res.render('reseller/dashboard', { title: 'Dashboard Reseller', layout: false, reseller: req.reseller }));
router.get('/dashboard', resellerAuth, (req, res) =>
  res.render('reseller/dashboard', { title: 'Dashboard Reseller', layout: false, reseller: req.reseller }));

// Halaman cetak voucher (thermal/print-friendly)
router.get('/print/:id', resellerAuth, (req, res) =>
  res.render('reseller/voucher-print', { title: 'Cetak Voucher', layout: false, txId: req.params.id }));

// Halaman cetak voucher berdasarkan status (mis. semua "belum dipakai").
router.get('/print-scope/:scope', resellerAuth, (req, res) => {
  const scope = ['unused', 'active', 'used', 'expired'].includes(req.params.scope) ? req.params.scope : 'unused';
  res.render('reseller/voucher-print', { title: 'Cetak Voucher', layout: false, txId: '', scope, selMode: false });
});

// Halaman cetak voucher berdasarkan PILIHAN (daftar username dari sessionStorage klien).
router.get('/print-sel', resellerAuth, (req, res) => {
  res.render('reseller/voucher-print', { title: 'Cetak Voucher', layout: false, txId: '', scope: '', selMode: true });
});

// Halaman hasil setelah bayar gateway (return_url provider). Polling status.
router.get('/topup/result', (req, res) =>
  res.render('reseller/topup-result', { title: 'Status Top-up', layout: false, ref: req.query.ref || '' }));

// ── Protected API ────────────────────────────────────────────────
router.get('/api/dashboard', resellerAuth, Ctrl.dashboard);
router.get('/api/packages', resellerAuth, Ctrl.packages);
router.post('/api/generate', resellerAuth, Ctrl.generate);
router.get('/api/history', resellerAuth, Ctrl.history);
router.get('/api/transactions/:id', resellerAuth, Ctrl.transactionDetail);
router.get('/api/report', resellerAuth, Ctrl.report);
router.get('/api/chart', resellerAuth, Ctrl.chartData);
router.get('/api/vouchers', resellerAuth, Ctrl.vouchers);
router.get('/api/monitor', resellerAuth, Ctrl.activeMonitor);
router.post('/api/vouchers/action', resellerAuth, Ctrl.voucherAction);
router.post('/api/vouchers/bulk', resellerAuth, Ctrl.voucherBulkAction);
router.post('/api/vouchers/print-data', resellerAuth, Ctrl.voucherPrintData);
router.put('/api/password', resellerAuth, Ctrl.changePassword);

// ── Top-up API ───────────────────────────────────────────────────
router.get('/api/topup/config', resellerAuth, Ctrl.topupConfig);
router.get('/api/topup/promo-check', resellerAuth, Ctrl.checkPromo);
router.post('/api/topup', resellerAuth, Ctrl.topupCreate);
router.post('/api/topup/:id/proof', resellerAuth, (req, res, next) =>
  proofUpload.single('proof')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  }), Ctrl.topupUploadProof);
router.get('/api/topup/:id/status', resellerAuth, Ctrl.topupStatus);
router.post('/api/topup/:id/cancel', resellerAuth, Ctrl.topupCancel);
router.get('/api/topups', resellerAuth, Ctrl.topupHistory);

// ── Webhook gateway TOP-UP (public, tanpa auth) ──────────────────
// Signature Tripay = HMAC-SHA256(rawBody, privateKey). req.rawBody sudah ditangkap
// global via express.json({verify}) di server.js; req.body sudah jadi objek. Tidak
// perlu express.raw (justru merusak: body sudah dikonsumsi json global → buffer kosong).
router.post('/webhook/tripay', WebhookCtrl.tripay);
router.post('/webhook/midtrans', WebhookCtrl.midtrans);
router.post('/webhook/xendit', WebhookCtrl.xendit);
router.post('/webhook/duitku', WebhookCtrl.duitku);

module.exports = router;
