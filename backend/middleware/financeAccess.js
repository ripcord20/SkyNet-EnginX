/**
 * financeAccess.js
 * Middleware role-based access control untuk modul keuangan.
 *
 * Konsep:
 *   - Role 'finance' adalah role baru yang HANYA punya akses ke modul billing,
 *     payments, customers (read), packages (read), keuangan, dan laporan.
 *   - Role lain (technician, demo, role custom yang tidak whitelisted) DITOLAK
 *     untuk halaman /finance/* dan API keuangan.
 *   - Role superadmin & admin tetap bisa akses semua (tidak terbatas).
 *
 * Helpers yang diekspor:
 *   - allowFinanceArea  : middleware untuk page /finance/* dan halaman yang
 *                         dipakai bersama (mis. /billing, /payments). Izinkan
 *                         superadmin/admin/finance, tolak yang lain.
 *   - blockFinanceArea  : middleware untuk page yang TIDAK boleh diakses role
 *                         finance (mis. /monitoring/*, /settings, /isolir).
 *                         Role finance akan di-redirect ke /finance.
 *   - isFinanceRole     : utility check role.
 *   - isFinanceAreaUser : utility — return true untuk admin/superadmin/finance.
 */

function _roleName(req) {
  return (req.user?.role?.name || '').toLowerCase();
}

function isFinanceRole(req) {
  return _roleName(req) === 'finance';
}

function isFinanceAreaUser(req) {
  const r = _roleName(req);
  return r === 'superadmin' || r === 'admin' || r === 'finance';
}

/**
 * Page-level guard: izinkan superadmin/admin/finance, tolak yang lain.
 * Dipakai di route /finance/*.
 */
function allowFinanceArea(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (isFinanceAreaUser(req)) return next();

  // Technician → arahkan ke dashboard technician
  if (_roleName(req) === 'technician') return res.redirect('/technician');
  return res.status(403).render('pages/403', {
    title: 'Akses Ditolak',
    layout: false,
    message: 'Anda tidak punya akses ke modul Finance.'
  });
}

/**
 * Page-level guard: BLOK role finance dari halaman ini.
 * Dipakai untuk halaman admin yang tidak boleh diakses finance (monitoring,
 * settings, dll). Admin & superadmin tetap lewat.
 */
function blockFinanceArea(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (isFinanceRole(req)) return res.redirect('/finance');
  next();
}

/**
 * API-level guard: tolak (403 JSON) kalau bukan superadmin/admin/finance.
 * Dipakai untuk endpoint API yang dipanggil dari halaman finance.
 */
function apiAllowFinanceArea(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isFinanceAreaUser(req)) return next();
  return res.status(403).json({ success: false, message: 'Akses ditolak untuk role Anda' });
}

/**
 * API-level guard: blok role finance dari endpoint admin-only.
 */
function apiBlockFinanceArea(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isFinanceRole(req)) {
    return res.status(403).json({ success: false, message: 'Modul ini tidak tersedia untuk role Finance' });
  }
  next();
}

module.exports = {
  isFinanceRole,
  isFinanceAreaUser,
  allowFinanceArea,
  blockFinanceArea,
  apiAllowFinanceArea,
  apiBlockFinanceArea,
};
