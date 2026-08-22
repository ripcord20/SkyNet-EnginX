/**
 * publicRegister.js
 * ──────────────────────────────────────────────────────────────────
 * Route PUBLIK (tanpa login) untuk pendaftaran pelanggan via referral.
 *
 * Mounted di server.js:
 *   app.use('/registrasi-layanan', publicRegisterRoutes.pageRouter) → halaman form
 *   app.use('/pub/reg', publicRegisterRoutes.apiRouter) → endpoint JSON
 *
 * KEAMANAN (endpoint terbuka ke internet, tanpa auth):
 *   - Rate limiting per IP (ketat untuk submit, longgar untuk read).
 *   - Honeypot field anti-bot (lihat PublicRegistrationController.submit).
 *   - Validasi input ketat di controller.
 * ──────────────────────────────────────────────────────────────────
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const PubCtrl = require('../controllers/PublicRegistrationController');

// ── Rate limiters khusus endpoint publik ──────────────────────────
// Submit: menulis ke DB → ketat tapi tidak mengganggu pemakaian normal.
// 15 kiriman / 10 menit / IP (cukup longgar untuk keluarga/warnet ber-IP sama).
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak percobaan pendaftaran. Mohon tunggu beberapa menit lalu coba lagi.' }
});

// Read publik (cek coverage, daftar paket): lebih longgar. 60 / 10 menit / IP.
const readLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak permintaan. Coba lagi nanti.' }
});

// Halaman form (GET render): batasi wajar agar tidak di-scrape brutal. 120 / 10 menit / IP.
const pageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Terlalu banyak permintaan halaman. Coba lagi nanti.'
});

// Halaman form: /:code dan / (tanpa kode) — di-mount di /registrasi-layanan (+ alias /daftar)
const pageRouter = express.Router();
pageRouter.get('/', pageLimiter, PubCtrl.renderPage);
pageRouter.get('/:code', pageLimiter, PubCtrl.renderPage);

// API publik: /pub/reg/*
const apiRouter = express.Router();
apiRouter.get('/packages', readLimiter, PubCtrl.packages);
apiRouter.post('/coverage', readLimiter, PubCtrl.coverage);
apiRouter.post('/submit/:code', submitLimiter, PubCtrl.submit);
apiRouter.post('/submit', submitLimiter, PubCtrl.submit);

module.exports = { pageRouter, apiRouter };
