/**
 * nocAccess.js
 * Middleware role-based access control untuk modul NOC (Network Operations Center).
 *
 * Konsep:
 *   - Role 'noc' adalah role baru yang fokus ke MONITORING JARINGAN:
 *     traffic, PPPoE sessions, OLT/ONT health, devices, infrastructure map,
 *     queue, IP pool, firewall (read-only), host monitor.
 *   - Role NOC TIDAK boleh akses: billing, payments, customers (full),
 *     packages, keuangan, settings, user management, WA gateway.
 *   - Role superadmin & admin tetap bisa akses semua.
 *
 * Helpers:
 *   - allowNocArea  : page-level guard, izinkan superadmin/admin/noc.
 *   - blockNocArea  : page-level guard, blok role noc (redirect ke /noc).
 *   - isNocRole     : check role helper.
 *   - apiAllowNocArea / apiBlockNocArea : API-level variant (return 403 JSON).
 */

function _roleName(req) {
  return (req.user?.role?.name || '').toLowerCase();
}

function isNocRole(req) {
  return _roleName(req) === 'noc';
}

function isNocAreaUser(req) {
  const r = _roleName(req);
  return r === 'superadmin' || r === 'admin' || r === 'noc';
}

/**
 * Page-level guard: izinkan superadmin/admin/noc, tolak yang lain.
 * Dipakai di route /noc/*.
 */
function allowNocArea(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (isNocAreaUser(req)) return next();

  // Role lain → redirect ke dashboard masing-masing
  const r = _roleName(req);
  if (r === 'technician') return res.redirect('/technician');
  if (r === 'finance')    return res.redirect('/finance');
  return res.status(403).render('pages/403', {
    title: 'Akses Ditolak',
    layout: false,
    message: 'Anda tidak punya akses ke modul NOC.'
  });
}

/**
 * Page-level guard: BLOK role noc dari halaman ini.
 * Dipakai untuk halaman yang tidak boleh diakses noc (billing, settings, dll).
 */
function blockNocArea(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (isNocRole(req)) return res.redirect('/noc');
  next();
}

/**
 * API-level guard: tolak kalau bukan superadmin/admin/noc.
 */
function apiAllowNocArea(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isNocAreaUser(req)) return next();
  return res.status(403).json({ success: false, message: 'Akses ditolak untuk role Anda' });
}

/**
 * API-level guard: blok role noc dari endpoint admin-only.
 */
function apiBlockNocArea(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isNocRole(req)) {
    return res.status(403).json({ success: false, message: 'Modul ini tidak tersedia untuk role NOC' });
  }
  next();
}

module.exports = {
  isNocRole,
  isNocAreaUser,
  allowNocArea,
  blockNocArea,
  apiAllowNocArea,
  apiBlockNocArea,
};
