const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/DeviceMonitorController');

// Helper: wrap undefined controller dengan 501 fallback
const safe = (fn) => fn || ((req, res) => res.status(501).json({ success: false, message: 'Not implemented' }));

// ── Device list & CRUD ───────────────────────────────────────
router.get   ('/devices',               authenticate, safe(ctrl.listDevices));
router.post  ('/devices',               authenticate, safe(ctrl.createDevice));
router.put   ('/devices/:id',           authenticate, safe(ctrl.updateDevice));
router.delete('/devices/:id',           authenticate, safe(ctrl.deleteDevice));

// ── Test connection ──────────────────────────────────────────
router.post  ('/test-connection',       authenticate, safe(ctrl.testConnection));

// ── Per-device monitoring ────────────────────────────────────
router.get   ('/:id/summary',           authenticate, safe(ctrl.summary));
router.get   ('/:id/realtime',          authenticate, safe(ctrl.realtimeMetrics));
router.get   ('/:id/history',           authenticate, safe(ctrl.history));
router.get   ('/:id/interfaces',        authenticate, safe(ctrl.interfaces));
router.get   ('/:id/interface-history', authenticate, safe(ctrl.interfaceHistory));

module.exports = router;