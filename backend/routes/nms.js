/**
 * routes/nms.js
 * ─────────────────────────────────────────────────────────────────
 * FlayNMS — Interface Monitor. Mengekspos NmsController.
 * Di-mount di api.js: router.use('/nms', authenticate, demoGuard, nmsRoutes)
 * sehingga path final = /api/nms/...
 *
 * Endpoint:
 *   GET    /api/nms/routers                    → daftar router API-capable
 *   GET    /api/nms/routers/:id/interfaces     → list interface live (picker)
 *   GET    /api/nms/interfaces                 → daftar preset yang dipantau
 *   POST   /api/nms/interfaces                 → tambah interface ke monitoring
 *   PATCH  /api/nms/interfaces/reorder         → ubah urutan
 *   DELETE /api/nms/interfaces/:id             → hapus dari monitoring
 *   GET    /api/nms/interfaces/:id/detail      → detail satu interface (popup)
 *   GET    /api/nms/interfaces/:id/history     → history traffic (range)
 *   PATCH  /api/nms/interfaces/:id/color       → ubah warna chart
 *   GET    /api/nms/live                       → live bitrate semua preset (poll)
 */
const express = require('express');
const router = express.Router();
const Nms = require('../controllers/NmsController');

// Routers / picker
router.get('/routers',                   Nms.routers);
router.get('/routers/:id/interfaces',     Nms.routerInterfaces);

// Live polling (taruh sebelum :id agar tidak bentrok)
router.get('/live',                       Nms.live);

// Presets (interface yang dipantau)
// Catatan: '/interfaces/reorder' harus didefinisikan SEBELUM '/interfaces/:id'
// agar 'reorder' tidak tertangkap sebagai :id.
router.get('/interfaces',                 Nms.listPresets);
router.post('/interfaces',                Nms.addPreset);
router.patch('/interfaces/reorder',       Nms.reorder);
router.get('/interfaces/:id/detail',      Nms.detail);
router.get('/interfaces/:id/history',     Nms.historyRange);
router.patch('/interfaces/:id/color',     Nms.setColor);
router.delete('/interfaces/:id',          Nms.removePreset);

module.exports = router;
