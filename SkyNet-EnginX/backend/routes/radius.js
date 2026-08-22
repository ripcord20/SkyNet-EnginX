const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');
const RadiusCtrl = require('../controllers/RadiusController');

// ── SERVER LIFECYCLE ────────────────────────────────────────────────
router.get('/server/status', authenticate, RadiusCtrl.serverStatus.bind(RadiusCtrl));
router.post('/server/start', authenticate, authorize('superadmin', 'admin'), logActivity('start', 'radius_server'), RadiusCtrl.serverStart.bind(RadiusCtrl));
router.post('/server/stop',  authenticate, authorize('superadmin', 'admin'), logActivity('stop', 'radius_server'),  RadiusCtrl.serverStop.bind(RadiusCtrl));

// ── STATS ────────────────────────────────────────────────────────────
router.get('/stats', authenticate, RadiusCtrl.stats.bind(RadiusCtrl));

// ── NAS CLIENTS ──────────────────────────────────────────────────────
router.get('/nas',              authenticate, RadiusCtrl.nasIndex.bind(RadiusCtrl));
router.post('/nas',             authenticate, authorize('superadmin', 'admin'), logActivity('create', 'radius_nas'), RadiusCtrl.nasCreate.bind(RadiusCtrl));
router.post('/nas/via-wireguard', authenticate, authorize('superadmin', 'admin'), logActivity('create', 'radius_nas_wireguard'), RadiusCtrl.nasCreateViaWireguard.bind(RadiusCtrl));
router.put('/nas/:id',          authenticate, authorize('superadmin', 'admin'), logActivity('update', 'radius_nas'), RadiusCtrl.nasUpdate.bind(RadiusCtrl));
router.delete('/nas/:id',       authenticate, authorize('superadmin', 'admin'), logActivity('delete', 'radius_nas'), RadiusCtrl.nasDestroy.bind(RadiusCtrl));
router.get('/nas/:id/wireguard-config', authenticate, RadiusCtrl.nasWireguardConfig.bind(RadiusCtrl));
router.get('/nas/:id/secret', authenticate, authorize('superadmin', 'admin'), logActivity('reveal', 'radius_nas_secret'), RadiusCtrl.nasRevealSecret.bind(RadiusCtrl));

// ── PORT FORWARDING ──────────────────────────────────────────────────
router.get('/port-forwards',                      authenticate, RadiusCtrl.portForwardsAllIndex.bind(RadiusCtrl));
router.get('/nas/:id/port-forwards',              authenticate, RadiusCtrl.portForwardsIndex.bind(RadiusCtrl));
router.post('/nas/:id/port-forwards',             authenticate, authorize('superadmin', 'admin'), logActivity('create', 'nas_port_forward'), RadiusCtrl.portForwardCreate.bind(RadiusCtrl));
router.delete('/nas/:nasId/port-forwards/:id',    authenticate, authorize('superadmin', 'admin'), logActivity('delete', 'nas_port_forward'), RadiusCtrl.portForwardDestroy.bind(RadiusCtrl));

// ── RADIUS USERS ─────────────────────────────────────────────────────
router.get('/users',        authenticate, RadiusCtrl.usersIndex.bind(RadiusCtrl));
router.post('/users',       authenticate, authorize('superadmin', 'admin'), logActivity('create', 'radius_user'), RadiusCtrl.usersCreate.bind(RadiusCtrl));
router.put('/users/:id',    authenticate, authorize('superadmin', 'admin'), logActivity('update', 'radius_user'), RadiusCtrl.usersUpdate.bind(RadiusCtrl));
router.delete('/users/:id', authenticate, authorize('superadmin', 'admin'), logActivity('delete', 'radius_user'), RadiusCtrl.usersDestroy.bind(RadiusCtrl));

// ── SESSIONS ─────────────────────────────────────────────────────────
router.get('/sessions', authenticate, RadiusCtrl.sessions.bind(RadiusCtrl));

module.exports = router;
