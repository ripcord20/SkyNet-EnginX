/**
 * publicVoucher.js — Routes halaman publik beli voucher hotspot.
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount di server.js:
 *   app.use('/beli', publicVoucherRoutes.pageRouter);     // halaman
 *   app.use('/pub/voucher', publicVoucherRoutes.apiRouter); // API + webhook
 *
 * Semua TANPA authentication (halaman publik).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Ctrl = require('../controllers/PublicVoucherController');

// ── Upload bukti transfer manual → uploads/payment_proofs (diblokir static) ──
const PROOF_DIR = path.join(__dirname, '..', '..', 'uploads', 'payment_proofs');
function ensureProofDir() { try { if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true }); } catch (_) {} }
const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => { ensureProofDir(); cb(null, PROOF_DIR); },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const rand = require('crypto').randomBytes(16).toString('hex');
    cb(null, 'vproof_' + Date.now() + '_' + rand + (ext || '.jpg'));
  }
});
const proofUpload = multer({
  storage: proofStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype || '')
            || /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(file.originalname || '');
    const isPdf = /pdf$/i.test(file.mimetype || '') || /\.pdf$/i.test(file.originalname || '');
    if (ok || isPdf) return cb(null, true);
    cb(new Error('Format file tidak didukung (hanya gambar atau PDF)'));
  }
});

// Rate limiter untuk endpoint publik (order/pay) — cegah abuse.
const pubLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak permintaan. Coba lagi nanti.' }
});

// ── Page router (mount di /beli) ────────────────────────────────────
const pageRouter = express.Router();
pageRouter.get('/', Ctrl.renderLanding);
pageRouter.get('/status/:code', Ctrl.renderStatus);

// ── API router (mount di /pub/voucher) ──────────────────────────────
const apiRouter = express.Router();
apiRouter.get('/packages', Ctrl.packages);
apiRouter.get('/config', Ctrl.config);
apiRouter.get('/tripay-channels', Ctrl.tripayChannels);
apiRouter.post('/order', pubLimiter, Ctrl.createOrder);
apiRouter.post('/:code/pay', pubLimiter, Ctrl.pay);
apiRouter.post('/:code/proof',
  pubLimiter,
  (req, res, next) => proofUpload.single('proof')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'Upload gagal' });
    next();
  }),
  Ctrl.submitProof);
apiRouter.get('/:code/status', Ctrl.status);

// Webhook gateway (dedicated callback URL untuk Duitku & Tripay).
apiRouter.post('/webhook/duitku', Ctrl.webhookDuitku);
apiRouter.post('/webhook/tripay', Ctrl.webhookTripay);

module.exports = { pageRouter, apiRouter };
