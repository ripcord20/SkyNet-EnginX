const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');
const WG = require('../controllers/WireguardController');

// ── SERVERS (interfaces) ─────────────────────────────────────────────
router.get('/servers',        authenticate, WG.serversIndex.bind(WG));
router.post('/servers',       authenticate, authorize('superadmin', 'admin'), logActivity('create', 'wireguard_server'), WG.serversCreate.bind(WG));
router.put('/servers/:id',    authenticate, authorize('superadmin', 'admin'), logActivity('update', 'wireguard_server'), WG.serversUpdate.bind(WG));
router.delete('/servers/:id', authenticate, authorize('superadmin', 'admin'), logActivity('delete', 'wireguard_server'), WG.serversDestroy.bind(WG));

// ── PEERS ─────────────────────────────────────────────────────────────
router.get('/peers',           authenticate, WG.peersIndex.bind(WG));
router.post('/peers/auto',     authenticate, authorize('superadmin', 'admin'), logActivity('auto_create', 'wireguard_peer'), WG.peersAutoCreate.bind(WG));
router.post('/peers',          authenticate, authorize('superadmin', 'admin'), logActivity('create', 'wireguard_peer'), WG.peersCreateManual.bind(WG));
router.put('/peers/:id',       authenticate, authorize('superadmin', 'admin'), logActivity('update', 'wireguard_peer'), WG.peersUpdate.bind(WG));
router.delete('/peers/:id',    authenticate, authorize('superadmin', 'admin'), logActivity('delete', 'wireguard_peer'), WG.peersDestroy.bind(WG));
router.get('/peers/:id/config', authenticate, WG.peersConfig.bind(WG));
router.get('/peers/:id/qr',     authenticate, WG.peersQr.bind(WG));

module.exports = router;
