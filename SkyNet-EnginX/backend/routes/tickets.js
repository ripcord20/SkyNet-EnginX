const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/TicketController');

router.get ('/stats',              authenticate, ctrl.stats);
router.get ('/customers/search',   authenticate, ctrl.searchCustomers);
router.get ('/infra/points',       authenticate, ctrl.infraPoints);
router.get ('/',                   authenticate, ctrl.index);
router.post('/',                   authenticate, ctrl.create);
router.get ('/:id',                authenticate, ctrl.show);
router.put ('/:id',                authenticate, ctrl.update);
router.delete('/:id',              authenticate, ctrl.destroy);
router.post('/:id/timeline',       authenticate, ctrl.uploadMiddleware, ctrl.addTimeline);

module.exports = router;