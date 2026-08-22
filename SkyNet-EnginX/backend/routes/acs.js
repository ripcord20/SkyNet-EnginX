'use strict';

const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ACSController = require('../controllers/ACSController');

// ── Status & Stats ──────────────────────────────────────────────────
router.get('/status',   authenticate, ACSController.status.bind(ACSController));
router.get('/stats',    authenticate, ACSController.stats.bind(ACSController));
router.get('/sessions', authenticate, ACSController.sessions.bind(ACSController));

// ── Devices ─────────────────────────────────────────────────────────
router.get('/devices',      authenticate, ACSController.devices.bind(ACSController));
router.get('/devices/:id',  authenticate, ACSController.deviceDetail.bind(ACSController));

// ── Config ACS ─────────────────────────────────────────────────────
router.get('/config',  authenticate, ACSController.getConfig.bind(ACSController));
router.post('/config', authenticate, authorize('superadmin','admin'), ACSController.saveConfig.bind(ACSController));

// ── Actions per device ──────────────────────────────────────────────
router.post('/devices/:sn/reboot',       authenticate, authorize('superadmin','admin'), ACSController.reboot.bind(ACSController));
router.get ('/devices/:sn/wifi',         authenticate, ACSController.getWifi.bind(ACSController));
router.post('/devices/:sn/wifi/refresh', authenticate, authorize('superadmin','admin'), ACSController.refreshWifi.bind(ACSController));
router.post('/devices/:sn/wifi',         authenticate, authorize('superadmin','admin'), ACSController.setWifi.bind(ACSController));
router.post('/devices/:sn/get-param',    authenticate, authorize('superadmin','admin'), ACSController.getParam.bind(ACSController));
router.post('/devices/:sn/set-param',    authenticate, authorize('superadmin','admin'), ACSController.setParam.bind(ACSController));

module.exports = router;