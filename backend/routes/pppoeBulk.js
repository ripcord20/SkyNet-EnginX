/**
 * routes/pppoeBulk.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Route bulk provisioning user PPPoE.
 *
 * Cara mount di backend/routes/api.js — tambahkan 2 baris ini
 * (letakkan setelah blok "Customer Import / Export"):
 *
 *     const pppoeBulkRoutes = require('./pppoeBulk');
 *     router.use('/pppoe/bulk', pppoeBulkRoutes);
 *
 * Semua endpoint jadi tersedia di /api/pppoe/bulk/...
 *
 * CATATAN URUTAN: route statis ('/template') didaftarkan SEBELUM route
 * berparameter ('/:id') supaya tidak tertangkap sebagai id.
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const router = express.Router();

const { authenticate, authorize, hasPermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');
const { demoGuard }   = require('../middleware/demoGuard');

const Ctrl = require('../controllers/PppoeBulkController');

// ── Upload handler ───────────────────────────────────────────────────────────
// Limit 10MB — cukup untuk ~50.000 baris .xlsx.
const bulkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/imports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `pppoe-bulk-${Date.now()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const bulkUpload = multer({
  storage: bulkStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan .xlsx atau .xls'));
  }
});

// ── Read-only ────────────────────────────────────────────────────────────────
router.get('/template',
  authenticate,
  Ctrl.downloadTemplate);

router.get('/',
  authenticate,
  Ctrl.list);

// ── Pembuatan job ────────────────────────────────────────────────────────────
router.post('/preview',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  bulkUpload.single('file'),
  Ctrl.preview);

router.post('/from-customers',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  Ctrl.fromCustomers);

// Buat PPP profile yang belum ada di router, langsung dari dialog pratinjau.
// Route statis — daftarkan sebelum '/:id/...' agar tidak tertangkap sebagai id.
router.post('/create-profiles',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  logActivity('create', 'ppp_profile'),
  Ctrl.createProfiles);

// ── Kontrol job ──────────────────────────────────────────────────────────────
// Operasi tulis ke router dibatasi superadmin/admin — salah pakai bisa
// membuat ribuan secret di router produksi.
router.post('/:id/start',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  logActivity('bulk_provision', 'pppoe_secret'),
  Ctrl.start);

router.post('/:id/pause',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  Ctrl.pause);

router.post('/:id/retry',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  logActivity('bulk_retry', 'pppoe_secret'),
  Ctrl.retry);

router.post('/:id/revalidate',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  Ctrl.revalidate);

router.post('/:id/unschedule',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  Ctrl.unschedule);

router.post('/:id/verify',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  Ctrl.verify);

router.post('/:id/rollback',
  authenticate, demoGuard, authorize('superadmin'),
  logActivity('bulk_rollback', 'pppoe_secret'),
  Ctrl.rollback);

// ── Monitoring & laporan ─────────────────────────────────────────────────────
router.get('/:id/status',
  authenticate,
  Ctrl.status);

router.get('/:id/items',
  authenticate,
  Ctrl.items);

router.get('/:id/report',
  authenticate,
  Ctrl.report);

router.delete('/:id',
  authenticate, demoGuard, authorize('superadmin', 'admin'),
  Ctrl.destroy);

module.exports = router;
