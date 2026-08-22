/**
 * GenieACS Routes
 * Tambahkan ke backend/routes/api.js atau web.js
 *
 * Cara penggunaan:
 * Di api.js: const genieacsRoutes = require('./genieacs');
 *            router.use('/genieacs', genieacsRoutes);
 */

const express = require('express');
const router = express.Router();
const GenieacsController = require('../controllers/GenieacsController');
// const { authMiddleware } = require('../middleware/auth'); // uncomment jika pakai auth

// ---- Settings & Connection ----
router.post('/test', GenieacsController.testConnection);
router.post('/settings', GenieacsController.saveSettings);

// ---- Stats ----
router.get('/stats', GenieacsController.getStats);

// ---- Device List ----
router.get('/devices', GenieacsController.getDevices);

// ---- Device Detail ----
router.get('/devices/:id', GenieacsController.getDevice);

// ---- Device Actions ----
router.post('/devices/:id/wifi', GenieacsController.setWifi);
router.post('/devices/:id/reboot', GenieacsController.rebootDevice);
router.post('/devices/:id/factory-reset', GenieacsController.factoryReset);
router.post('/devices/:id/refresh', GenieacsController.refreshDevice);
router.post('/devices/:id/set-param', GenieacsController.setParam);
router.get('/devices/:id/faults', GenieacsController.getFaults);
router.get('/devices/:id/clients',   GenieacsController.getClients);
router.get('/devices/:id/bandwidth', GenieacsController.getBandwidth);
router.get('/devices/:id/rx-history',GenieacsController.getRxHistory);
router.get('/devices/:id/customer',  GenieacsController.getAssignedCustomer);
router.post('/devices/:id/assign',   GenieacsController.assignCustomer);
router.get('/customers/search',      GenieacsController.searchCustomers);
router.get('/settings/load',         GenieacsController.loadSettings);

// ---- Page Route (untuk EJS) ----
// Tambahkan ini di web.js / main router:
// router.get('/genieacs', authMiddleware, (req, res) => res.render('pages/genieacs', { title: 'ONT Management' }));

module.exports = router;