/**
 * salesAccess.js
 * Middleware role-based access control untuk modul Sales.
 *
 * Konsep:
 *   - Role 'sales' HANYA punya akses ke modul Sales (registrasi pelanggan,
 *     survey, instalasi, coverage checker, komisi) di halaman /sales.
 *   - Role 'sales' DITOLAK dari halaman admin lain (dashboard monitoring,
 *     settings, billing, devices, dll) — akan di-redirect ke /sales.
 *   - Role superadmin & admin tetap bisa akses semua, termasuk /sales.
 *
 * Helpers:
 *   - allowSalesArea  : page-level guard, izinkan superadmin/admin/sales.
 *   - blockSalesArea  : page-level guard, blok role sales (redirect ke /sales).
 *   - isSalesRole     : utility check role.
 *   - isSalesAreaUser : utility — true untuk admin/superadmin/sales.
 *   - apiAllowSalesArea / apiBlockSalesArea : API-level variant (403 JSON).
 */

function _roleName(req) {
  return (req.user?.role?.name || '').toLowerCase();
}

function isSalesRole(req) {
  return _roleName(req) === 'sales';
}

function isSalesAreaUser(req) {
  const r = _roleName(req);
  return r === 'superadmin' || r === 'admin' || r === 'sales';
}

/**
 * Page-level guard: izinkan superadmin/admin/sales, tolak yang lain.
 * Dipakai di route /sales.
 */
function allowSalesArea(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (isSalesAreaUser(req)) return next();

  // Role lain diarahkan ke home masing-masing
  const r = _roleName(req);
  if (r === 'technician') return res.redirect('/technician');
  if (r === 'finance')    return res.redirect('/finance');
  if (r === 'noc')        return res.redirect('/noc');
  return res.status(403).render('pages/403', {
    title: 'Akses Ditolak',
    layout: false,
    message: 'Anda tidak punya akses ke modul Sales.'
  });
}

/**
 * Page-level guard: BLOK role sales dari halaman ini (admin area).
 * Admin & superadmin tetap lewat.
 */
function blockSalesArea(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (isSalesRole(req)) return res.redirect('/sales');
  next();
}

/**
 * API-level guard: izinkan hanya superadmin/admin/sales.
 */
function apiAllowSalesArea(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isSalesAreaUser(req)) return next();
  return res.status(403).json({ success: false, message: 'Akses ditolak untuk role Anda' });
}

/**
 * API-level guard: blok role sales dari endpoint admin-only.
 */
function apiBlockSalesArea(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isSalesRole(req)) {
    return res.status(403).json({ success: false, message: 'Modul ini tidak tersedia untuk role Sales' });
  }
  next();
}

module.exports = {
  isSalesRole,
  isSalesAreaUser,
  allowSalesArea,
  blockSalesArea,
  apiAllowSalesArea,
  apiBlockSalesArea,
};
