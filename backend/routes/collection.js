/**
 * routes/collection.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sub-router modul Field Collection (sisi ADMIN). Mount di routes/api.js:
 *
 *     const collectionRoutes = require('./collection');
 *     router.use('/collection', authenticate, demoGuard, collectionRoutes);
 *
 * Endpoint lapangan (kolektor) ditambahkan di Tahap 3-4.
 *
 * Catatan otorisasi: authenticate + demoGuard sudah dipasang saat mount.
 * Di sini kita batasi aksi tulis ke superadmin/admin. hasPermission dipakai
 * agar konsisten dengan modul lain (superadmin bypass otomatis).
 */
const express = require('express');
const router = express.Router();
const { authorize, hasPermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');
const CollectionController = require('../controllers/CollectionController');
const CashDepositController = require('../controllers/CashDepositController');

// ── Read (admin & superadmin) ─────────────────────────────────────
router.get('/stats',       authorize('superadmin', 'admin'), (r, s) => CollectionController.stats(r, s));
router.get('/report',      authorize('superadmin', 'admin'), (r, s) => CollectionController.collectorReport(r, s));
router.get('/report/excel', authorize('superadmin', 'admin'), (r, s) => CollectionController.reportExcel(r, s));
router.get('/report/pdf',   authorize('superadmin', 'admin'), (r, s) => CollectionController.reportPdf(r, s));
router.post('/commission/pay', authorize('superadmin', 'admin'), (r, s) => CollectionController.payCommission(r, s));
router.get('/map',         authorize('superadmin', 'admin'), (r, s) => CollectionController.mapData(r, s));
router.get('/assignments/:id/history', authorize('superadmin', 'admin'), (r, s) => CollectionController.assignmentHistory(r, s));
router.post('/assignments/:id/reassign', authorize('superadmin', 'admin'), (r, s) => CollectionController.reassign(r, s));
router.get('/assignments/:id/proof', authorize('superadmin', 'admin'), (r, s) => CollectionController.viewAssignmentProof(r, s));
router.get('/assignments', authorize('superadmin', 'admin'), (r, s) => CollectionController.listAssignments(r, s));
router.get('/collectors',  authorize('superadmin', 'admin'), (r, s) => CollectionController.listCollectors(r, s));

// ── Setoran kas (admin: review & rekonsiliasi) ────────────────────
router.get('/deposits',              authorize('superadmin', 'admin'), (r, s) => CashDepositController.adminList(r, s));
router.get('/deposits/:id/proof',    authorize('superadmin', 'admin'), (r, s) => CashDepositController.viewProof(r, s));
router.post('/deposits/:id/verify',  authorize('superadmin', 'admin'), logActivity('verify', 'cash_deposit'), (r, s) => CashDepositController.verify(r, s));
router.post('/deposits/:id/reject',  authorize('superadmin', 'admin'), logActivity('reject', 'cash_deposit'), (r, s) => CashDepositController.reject(r, s));

// ── Write (admin & superadmin) ────────────────────────────────────
router.post('/generate',    authorize('superadmin', 'admin'), logActivity('generate', 'collection_task'), (r, s) => CollectionController.generate(r, s));
router.post('/assign',      authorize('superadmin', 'admin'), logActivity('assign',   'collection_task'), (r, s) => CollectionController.assign(r, s));
router.post('/auto-assign', authorize('superadmin', 'admin'), logActivity('assign',   'collection_task'), (r, s) => CollectionController.autoAssign(r, s));
router.post('/collectors',  authorize('superadmin', 'admin'), logActivity('update',   'collector_profile'), (r, s) => CollectionController.upsertCollectorProfile(r, s));

module.exports = router;
