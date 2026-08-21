/**
 * routes/demo.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint khusus untuk sistem akun demo.
 *
 * Cara pasang di backend/routes/api.js:
 *
 *   const demoRoutes = require('./demo');
 *   router.use('/demo', demoRoutes);
 *
 * Letakkan SEBELUM `router.use(demoGuard)` kalau pakai mode B — supaya
 * /api/demo/provision bisa diakses tanpa login.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { authenticate } = require('../middleware/auth');
const DemoController = require('../controllers/DemoController');

// Rate limit ketat untuk endpoint provision — cegah penyalahgunaan
const provisionLimit = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 jam
  max: 5,                     // max 5 akun demo per IP per jam
  message: {
    success: false,
    message: 'Terlalu banyak permintaan akun demo dari IP ini. Coba lagi dalam 1 jam.'
  },
});

// Provision akun demo baru (tidak perlu login)
router.post('/provision', provisionLimit, DemoController.provision);

// Info akun demo aktif (butuh login)
router.get('/info', authenticate, DemoController.info);

// Extend masa berlaku (butuh login + user demo)
router.post('/extend', authenticate, DemoController.extend);

module.exports = router;
