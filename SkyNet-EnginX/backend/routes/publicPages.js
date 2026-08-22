/**
 * publicPages.js
 * ──────────────────────────────────────────────────────────────────
 * Route untuk halaman publik (tanpa authentication).
 *
 * Endpoints:
 *   GET /p/isolir                  → halaman pemberitahuan isolir
 *   GET /p/isolir/payment-accounts → list rekening pembayaran (JSON)
 *
 * Mounted di server.js sebelum webRoutes supaya tidak ke-intercept
 * authenticate middleware.
 * ──────────────────────────────────────────────────────────────────
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const IsolirPublicCtrl = require('../controllers/IsolirPublicController');
const PortalCtrl       = require('../controllers/CustomerPortalController');

// Upload bukti pembayaran (jalur transfer MANUAL). Disimpan di
// uploads/payment_proofs/ dengan nama acak; folder ini DIBLOKIR dari static
// serving (lihat server.js) dan hanya bisa diakses admin via endpoint ber-auth.
const PROOF_DIR = path.join(__dirname, '..', '..', 'uploads', 'payment_proofs');
function ensureProofDir() { try { if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true }); } catch (_) {} }
const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => { ensureProofDir(); cb(null, PROOF_DIR); },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const rand = require('crypto').randomBytes(16).toString('hex');
    cb(null, 'proof_' + Date.now() + '_' + rand + (ext || '.jpg'));
  }
});
const proofUpload = multer({
  storage: proofStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype || '')
            || /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(file.originalname || '');
    const isPdf = /pdf$/i.test(file.mimetype || '') || /\.pdf$/i.test(file.originalname || '');
    if (ok || isPdf) return cb(null, true);
    cb(new Error('Format file tidak didukung (hanya gambar atau PDF)'));
  }
});

// Rate limiter untuk endpoint pembayaran publik (TANPA login). Mencegah
// abuse: pembuatan transaksi gateway / enumerasi channel secara beruntun.
// 20 request / 5 menit / IP cukup longgar untuk pelanggan normal (retry,
// ganti metode) tapi membatasi penyalahgunaan.
const pubPayLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.' }
});

// ── Cek Tagihan dari landing page (CID + 4 digit HP) ───────────────────
// Endpoint publik dipanggil dari landing page ISP yang berada di DOMAIN LAIN
// (mis. domain.com), sedangkan billing di billing.domain.com. Karena beda
// origin, endpoint ini butuh CORS sendiri yang mengizinkan LANDING_URL.
// Rate limit lebih ketat (anti brute-force tebak CID): 10 / menit / IP.
const PublicLookupCtrl = require('../controllers/PublicLookupController');
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.' }
});
// CORS khusus endpoint lookup: izinkan domain landing (boleh >1, pisah koma).
function lookupCors(req, res, next) {
  const allowed = String(process.env.LANDING_URL || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = (req.headers.origin || '').replace(/\/+$/, '');
  if (allowed.length && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // PENTING: Helmet secara default memasang
    //   Cross-Origin-Resource-Policy: same-origin
    // yang membuat BROWSER menolak respons ini meski header CORS sudah benar.
    // (curl tidak terpengaruh, sehingga masalahnya tidak terlihat saat diuji
    // lewat terminal.) Endpoint ini memang dirancang untuk diakses lintas
    // origin dari landing page, jadi kebijakannya dilonggarkan khusus di sini.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    // Cache preflight 10 menit agar browser tidak mengulang OPTIONS terus.
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
router.options('/cek-tagihan', lookupCors);
router.post('/cek-tagihan', lookupCors, lookupLimiter, PublicLookupCtrl.checkBill);

// ── Cakupan jaringan untuk halaman /coverage di landing page ───────────
// Mengirim titik ODP/ODC aktif dengan koordinat yang sudah dibulatkan.
// Lihat PublicCoverageController untuk alasan tiap kolom yang dibuang.
//
// Limit lebih longgar dari cek-tagihan karena ini hanya data baca yang
// sudah di-cache, bukan lookup identitas yang rawan brute-force.
const PublicCoverageCtrl = require('../controllers/PublicCoverageController');
const coverageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak permintaan.' }
});
// lookupCors hanya mengizinkan method POST; coverage dibaca lewat GET,
// jadi header-nya perlu disesuaikan.
function coverageCors(req, res, next) {
  const allowed = String(process.env.LANDING_URL || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = (req.headers.origin || '').replace(/\/+$/, '');
  if (allowed.length && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
router.options('/coverage', coverageCors);
router.get('/coverage', coverageCors, coverageLimiter, PublicCoverageCtrl.points);
router.options('/coverage/check', coverageCors);
router.get('/coverage/check', coverageCors, coverageLimiter, PublicCoverageCtrl.check);

// Landing page
router.get('/isolir', IsolirPublicCtrl.renderPage);

// Alias untuk URL lama
router.get('/blocked', IsolirPublicCtrl.renderPage);

// Daftar rekening pembayaran (untuk fetch dari client JS)
router.get('/isolir/payment-accounts', IsolirPublicCtrl.getPaymentAccounts);

// Helper: muat template invoice (warna/label/show-hide) + fallback brand global.
async function loadInvoiceTpl() {
  const { AppSetting } = require('../models');
  const { Op } = require('sequelize');
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'invtpl_%' } } });
  const tpl = {};
  rows.forEach(r => { tpl[r.key.replace('invtpl_', '')] = r.value; });
  if (!tpl.logo_url) {
    const g = await AppSetting.findOne({ where: { key: 'logo_url' } });
    if (g && g.value) tpl.logo_url = g.value;
  }
  if (!tpl.company_name) {
    const cn = await AppSetting.findOne({ where: { key: 'company_name' } })
            || await AppSetting.findOne({ where: { key: 'app_name' } });
    if (cn && cn.value) tpl.company_name = cn.value;
  }
  if (!tpl.company_phone) {
    const cp = await AppSetting.findOne({ where: { key: 'company_whatsapp' } });
    if (cp && cp.value) tpl.company_phone = cp.value;
  }
  if (!tpl.company_tagline) {
    const tl = await AppSetting.findOne({ where: { key: 'app_tagline' } });
    if (tl && tl.value) tpl.company_tagline = tl.value;
  }
  return tpl;
}

// Helper: dari customers.public_link_token → invoice "aktif" yang ditampilkan.
// Aturan pemilihan:
//   1. Invoice belum lunas TERLAMA (unpaid/overdue) → ditagih duluan.
//   2. Kalau semua sudah lunas / tidak ada yang nunggak → invoice TERBARU
//      (biar pelanggan tetap lihat status terakhir).
// Return { customer, invoice } atau null bila token tak dikenal / tak ada invoice.
async function resolveCustomerActiveInvoice(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const { Customer, Invoice } = require('../models');
  const customer = await Customer.findOne({ where: { public_link_token: token } });
  if (!customer) return null;

  // 1) Tagihan belum lunas terlama
  let invoice = await Invoice.findOne({
    where: { customer_id: customer.id, status: ['unpaid', 'overdue'] },
    order: [['period_year', 'ASC'], ['period_month', 'ASC'], ['id', 'ASC']]
  });
  // 2) Fallback: invoice terbaru apa pun statusnya
  if (!invoice) {
    invoice = await Invoice.findOne({
      where: { customer_id: customer.id },
      order: [['period_year', 'DESC'], ['period_month', 'DESC'], ['id', 'DESC']]
    });
  }
  if (!invoice) return null;
  return { customer, invoice };
}

// ── Public invoice page (TANPA login) ──────────────────────────────
// Dibuka pelanggan dari link WA: /pub/invoice/<invoiceId>.<sig>
// Render pages/invoice dengan flag publicMode; data diambil client-side
// via GET /api/pub/invoice/:token/data (juga tanpa auth).
// Token diverifikasi di sini agar token invalid langsung 404 (tidak render).
router.get('/invoice/:token', async (req, res, next) => {
  try {
    const { verifyInvoiceToken } = require('../utils/templateHelper');
    const invoiceId = verifyInvoiceToken(req.params.token);
    if (!invoiceId) return next(); // -> 404 handler

    const tpl = await loadInvoiceTpl();

    res.render('pages/invoice', {
      title: 'Invoice',
      user: null,
      active: '',
      tpl,
      publicMode: true,
      publicToken: req.params.token
    });
  } catch (e) {
    next(e);
  }
});

// ── Permanent customer link (TANPA login) ───────────────────────────
// /pub/cust/<randomToken> → selalu tampilkan invoice aktif terbaru pelanggan.
// URL tetap (permanen) walau invoice berganti tiap periode. Halaman dirender
// dengan publicToken = token INVOICE hasil resolve, sehingga semua endpoint
// data/pay/status (/pub/invoice/:token/...) yang sudah ada bekerja tanpa ubahan.
router.get('/cust/:token', async (req, res, next) => {
  try {
    const resolved = await resolveCustomerActiveInvoice(req.params.token);
    if (!resolved) return next(); // token tak dikenal / tak ada invoice → 404

    const { generateInvoiceToken } = require('../utils/templateHelper');
    const invoiceToken = generateInvoiceToken(resolved.invoice.id);
    const tpl = await loadInvoiceTpl();

    res.render('pages/invoice', {
      title: 'Invoice',
      user: null,
      active: '',
      tpl,
      publicMode: true,
      publicToken: invoiceToken
    });
  } catch (e) {
    next(e);
  }
});

// ── Public payment endpoints (TANPA login) ──────────────────────────
// Dipakai tombol Bayar di halaman /pub/invoice/:token. Otorisasi lewat HMAC
// token invoice (diverifikasi di controller). merchant_ref INV-{id}-{ts}
// identik dgn jalur portal → webhook gateway yang ada otomatis rekonsiliasi.
router.get ('/invoice/:token/tripay-channels', pubPayLimiter, PortalCtrl.publicTripayChannels);
router.post('/invoice/:token/pay',             pubPayLimiter, PortalCtrl.publicPay);
router.get ('/invoice/:token/status',          PortalCtrl.publicInvoiceStatus);
// Upload bukti transfer (jalur manual). multer error → tangani jadi JSON rapi.
router.post('/invoice/:token/proof',
  pubPayLimiter,
  (req, res, next) => proofUpload.single('proof')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'Upload gagal' });
    next();
  }),
  PortalCtrl.publicSubmitProof);

module.exports = router;
