const express = require('express');
const router = express.Router();
const TrackingController = require('../controllers/TrackingController');
const { authenticate } = require('../middleware/auth');

// Semua routes memerlukan authentication
router.use(authenticate);

// ══════════════════════════════════════════════════════════════
// GPS TRACKING ROUTES
// ══════════════════════════════════════════════════════════════

// Start tracking session
router.post('/start', TrackingController.startTracking);

// Update location real-time
router.post('/update', TrackingController.updateLocation);

// Stop tracking session
router.post('/stop', TrackingController.stopTracking);

// Get all active tracking sessions
router.get('/active', TrackingController.getActiveSessions);

// Get tracking history by ticket ID
router.get('/history/:ticket_id', TrackingController.getTrackingHistory);

// Get location trail by session ID
router.get('/trail/:session_id', TrackingController.getLocationTrail);

// Get my active session (untuk teknisi)
router.get('/my-session', TrackingController.getMyActiveSession);

// Get tracking statistics
router.get('/stats', TrackingController.getStats);

module.exports = router;