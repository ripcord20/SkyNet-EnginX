/**
 * routes/hris.js — Modul HRIS
 * ──────────────────────────────────────────────────────────────────
 * Dimount di server via routes/api.js:  router.use('/hris', hrisRoutes)
 * sehingga semua endpoint di sini berada di bawah prefix /api/hris.
 *
 * Dua kelompok akses:
 *   - /me/*  : endpoint karyawan (absensi mandiri) — cukup authenticate,
 *              controller resolve Employee dari req.user.
 *   - selain itu : admin HRIS (superadmin/admin/hr) via apiAllowHrisAdmin.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { demoGuard } = require('../middleware/demoGuard');
const { apiAllowHrisAdmin } = require('../middleware/hrisAccess');

const Emp = require('../controllers/HrisEmployeeController');
const Att = require('../controllers/HrisAttendanceController');
const Dash = require('../controllers/HrisDashboardController');

// ── Semua endpoint HRIS butuh login ──
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════
// KARYAWAN (self-service absensi) — semua user login yang tertaut Employee
// ═══════════════════════════════════════════════════════════════
router.get('/me/status', Att.myStatus);
router.post('/me/check-in', Att.uploadSelfie, Att.checkIn);
router.post('/me/check-out', Att.uploadSelfie, Att.checkOut);
router.post('/me/leave', Dash.createLeave);

// ═══════════════════════════════════════════════════════════════
// ADMIN HRIS
// ═══════════════════════════════════════════════════════════════
router.use(apiAllowHrisAdmin);

// Dashboard
router.get('/stats', Dash.stats);

// Employees
router.get('/employees', Emp.listEmployees);
router.get('/employees/:id', Emp.getEmployee);
router.post('/employees', demoGuard, Emp.uploadPhoto, Emp.createEmployee);
router.put('/employees/:id', demoGuard, Emp.uploadPhoto, Emp.updateEmployee);
router.delete('/employees/:id', demoGuard, Emp.deleteEmployee);

// Shifts
router.get('/shifts', Emp.listShifts);
router.post('/shifts', demoGuard, Emp.saveShift);
router.put('/shifts/:id', demoGuard, Emp.saveShift);
router.delete('/shifts/:id', demoGuard, Emp.deleteShift);

// Work locations
router.get('/locations', Emp.listLocations);
router.post('/locations', demoGuard, Emp.saveLocation);
router.put('/locations/:id', demoGuard, Emp.saveLocation);
router.delete('/locations/:id', demoGuard, Emp.deleteLocation);

// Schedules
router.get('/schedules', Emp.listSchedules);
router.post('/schedules/bulk', demoGuard, Emp.bulkAssignSchedule);
router.delete('/schedules/:id', demoGuard, Emp.deleteSchedule);

// Attendance (admin view + koreksi + kiosk punch)
router.get('/attendance', Att.listAttendance);
router.put('/attendance/:id', demoGuard, Att.updateAttendance);
router.post('/attendance/kiosk/check-in', demoGuard, Att.uploadSelfie, Att.checkIn);
router.post('/attendance/kiosk/check-out', demoGuard, Att.uploadSelfie, Att.checkOut);

// Leave management
router.get('/leave', Dash.listLeave);
router.post('/leave', demoGuard, Dash.createLeave);
router.put('/leave/:id/review', demoGuard, Dash.reviewLeave);

// Payroll
router.get('/payrolls', Dash.listPayrolls);
router.post('/payrolls', demoGuard, Dash.createPayroll);
router.get('/payrolls/:id', Dash.getPayroll);
router.post('/payrolls/:id/calculate', demoGuard, Dash.calculatePayroll);
router.put('/payrolls/items/:itemId', demoGuard, Dash.updatePayrollItem);
router.post('/payrolls/:id/finalize', demoGuard, Dash.finalizePayroll);
router.get('/payrolls/items/:itemId/slip.pdf', Dash.slipPdf);
router.post('/payrolls/items/:itemId/send', demoGuard, Dash.sendSlip);
router.post('/payrolls/:id/send-all', demoGuard, Dash.sendAllSlips);

module.exports = router;
