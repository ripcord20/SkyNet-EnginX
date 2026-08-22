/**
 * resellerAdmin.js — Routes manajemen reseller (sisi admin/owner).
 * ─────────────────────────────────────────────────────────────────────────────
 * Di-mount di api.js:
 *   const resellerAdminRoutes = require('./resellerAdmin');
 *   router.use('/reseller-admin', resellerAdminRoutes);
 *
 * Semua endpoint butuh authenticate + role admin/superadmin.
 */
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const Ctrl = require('../controllers/ResellerAdminController');

// Guard: semua route di sini hanya untuk admin & superadmin.
router.use(authenticate, authorize('superadmin', 'admin'));

// ── Reseller CRUD ────────────────────────────────────────────────
router.get('/resellers', Ctrl.list);
router.get('/resellers/:id', Ctrl.detail);
router.post('/resellers', Ctrl.create);
router.put('/resellers/:id', Ctrl.update);
router.delete('/resellers/:id', Ctrl.remove);

// ── Saldo ────────────────────────────────────────────────────────
router.post('/resellers/:id/topup', Ctrl.topup);
router.get('/resellers/:id/transactions', Ctrl.transactions);

// ── Paket voucher ────────────────────────────────────────────────
router.get('/packages', Ctrl.packageList);
router.post('/packages', Ctrl.packageCreate);
router.put('/packages/:id', Ctrl.packageUpdate);
router.delete('/packages/:id', Ctrl.packageRemove);

// ── Top-up requests (verifikasi manual/qris, auto-gateway hanya tampil) ──
router.get('/topups', Ctrl.topupList);
router.get('/topups/:id', Ctrl.topupDetail);
router.get('/topups/:id/proof', Ctrl.topupProof);
router.post('/topups/:id/verify', Ctrl.topupVerify);
router.post('/topups/:id/reject', Ctrl.topupReject);
router.get('/topup-settings', Ctrl.topupSettings);
router.put('/topup-settings', Ctrl.topupSettings);
router.get('/hotspot-servers', Ctrl.hotspotServers);
router.get('/hotspot-profiles', Ctrl.hotspotProfiles);
router.get('/resellers/:id/vouchers', Ctrl.resellerVouchers);
router.post('/resellers/:id/vouchers/action', Ctrl.resellerVoucherAction);
router.post('/resellers/:id/vouchers/bulk', Ctrl.resellerVoucherBulk);
router.get('/resellers/:id/voucher-logs', Ctrl.resellerVoucherLogs);
router.get('/resellers/:id/prices', Ctrl.resellerPrices);
router.put('/resellers/:id/prices', Ctrl.resellerPrices);
router.get('/resellers/:id/sub-resellers', Ctrl.subResellers);
router.get('/voucher-logs', Ctrl.resellerVoucherLogs);

// #10 Promo top-up
router.get('/promos', Ctrl.promoList);
router.post('/promos', Ctrl.promoSave);
router.put('/promos/:id', Ctrl.promoSave);
router.delete('/promos/:id', Ctrl.promoRemove);

// ── Laporan global ───────────────────────────────────────────────
router.get('/report', Ctrl.globalReport);

// ── Order voucher publik (halaman /beli) ─────────────────────────
router.get('/public-orders', Ctrl.publicOrderList);
router.get('/public-orders/:id/proof', Ctrl.publicOrderProof);
router.post('/public-orders/:id/verify', Ctrl.publicOrderVerify);
router.post('/public-orders/:id/reject', Ctrl.publicOrderReject);

module.exports = router;
