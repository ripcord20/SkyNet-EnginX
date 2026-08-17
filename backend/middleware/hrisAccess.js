/**
 * hrisAccess.js
 * Middleware role-based access control untuk modul HRIS.
 *
 * Konsep:
 *   - Admin panel HRIS (data karyawan, master, payroll, rekap absensi)
 *     hanya untuk superadmin / admin / hr.
 *   - Endpoint absensi karyawan (myStatus, checkIn, checkOut, ajukan izin)
 *     boleh diakses oleh SEMUA user login yang tertaut ke Employee
 *     (via Employee.user_id) — dicek di controller (resolveEmployee).
 *
 * Helpers:
 *   - isHrAdmin(req)        : true untuk superadmin/admin/hr.
 *   - allowHrisAdmin        : page guard admin HRIS (redirect non-admin).
 *   - apiAllowHrisAdmin     : API guard admin HRIS (403 JSON).
 */

function _roleName(req) {
  return (req.user?.role?.name || '').toLowerCase();
}

function isHrAdmin(req) {
  const r = _roleName(req);
  return r === 'superadmin' || r === 'admin' || r === 'hr';
}

// Page-level guard admin HRIS
function allowHrisAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (isHrAdmin(req)) return next();
  return res.status(403).render('pages/403', {
    title: 'Akses Ditolak',
    layout: false,
    message: 'Anda tidak punya akses ke panel admin HRIS.'
  });
}

// API-level guard admin HRIS
function apiAllowHrisAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isHrAdmin(req)) return next();
  return res.status(403).json({ success: false, message: 'Akses HRIS admin ditolak untuk role Anda' });
}

module.exports = { isHrAdmin, allowHrisAdmin, apiAllowHrisAdmin };
