/**
 * demoGuard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Safety net untuk akun demo. Harus dipasang SETELAH `authenticate` supaya
 * `req.user` sudah tersedia.
 *
 * Pertahanan berlapis:
 *   1. Block semua HTTP method mutasi (POST/PUT/PATCH/DELETE) kecuali whitelist
 *   2. Block route "berbahaya" (Mikrotik config, OLT exec, WA send, dsb) secara
 *      eksplisit — bahkan walau methodnya GET
 *   3. Inject flag `req.isDemo` agar controller lain bisa melakukan data masking
 *
 * Role demo tidak boleh lolos dari middleware ini walau dia punya permission
 * yang sesuai — ini adalah "deny overrides allow".
 */

const logger = require('../utils/logger');

// Route yang BOLEH di-POST oleh demo (minimal sekali — hanya untuk UX dasar)
const DEMO_POST_WHITELIST = [
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/dashboard-layout',   // user boleh simpan layout dashboardnya sendiri
];

// Path prefix yang DILARANG total untuk demo (baik GET maupun mutasi)
// Ini melindungi endpoint yang mengeksekusi perintah ke perangkat riil.
const DEMO_BLOCKED_PREFIXES = [
  '/api/mikrotik/exec',       // eksekusi command Mikrotik
  '/api/mikrotik/config',     // ubah konfigurasi Mikrotik
  '/api/genieacs/reboot',     // reboot ONT
  '/api/genieacs/reset',      // factory reset ONT
  '/api/genieacs/task',       // kirim task TR-069
  '/api/olt/exec',            // eksekusi command OLT
  '/api/wa/send',             // kirim pesan WhatsApp
  '/api/wa/broadcast',        // broadcast WhatsApp
  '/api/broadcast',           // broadcast apapun
  '/api/isolir/apply',        // isolir pelanggan
  '/api/settings/test',       // test koneksi pakai kredensial beneran
  '/api/users',               // manajemen user
  '/api/roles',               // manajemen role
  '/api/permissions',         // manajemen permission
];

// Cek apakah user saat ini role demo
function isDemoUser(req) {
  const roleName = (req.user?.role?.name || '').toLowerCase();
  return roleName === 'demo';
}

// Middleware utama — pasang di app.use sebelum route API mutasi
function demoGuard(req, res, next) {
  // Kalau belum login atau bukan demo → lanjut normal
  if (!req.user) return next();

  req.isDemo = isDemoUser(req);
  if (!req.isDemo) return next();

  const method = req.method.toUpperCase();
  const path = req.path || req.originalUrl.split('?')[0];

  // 1. Cek blocked prefixes lebih dulu (berlaku untuk semua method)
  const blocked = DEMO_BLOCKED_PREFIXES.some(p => path.startsWith(p));
  if (blocked) {
    logger.warn(`[DEMO-GUARD] Blocked ${method} ${path} for demo user ${req.user.email}`);
    return res.status(403).json({
      success: false,
      code: 'DEMO_FORBIDDEN',
      message: 'Fitur ini dinonaktifkan pada akun demo. Silakan hubungi admin untuk akses penuh.'
    });
  }

  // 2. Apply resource caps (pagination, upload size, export block)
  // Try-load supaya tidak break kalau file tidak ada
  try {
    const { demoResourceCaps } = require('./demoResourceCaps');
    return demoResourceCaps(req, res, () => continueGuard(req, res, next, method, path));
  } catch (e) {
    // Fallback kalau resource caps belum dipasang
    return continueGuard(req, res, next, method, path);
  }
}

// Lanjutan demoGuard setelah resource caps lolos
function continueGuard(req, res, next, method, path) {
  // 3. Method read-only (GET, HEAD, OPTIONS) selalu boleh
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return next();
  }

  // 4. Cek whitelist untuk method mutasi
  const isWhitelisted = DEMO_POST_WHITELIST.some(p =>
    path === p || path.startsWith(p + '/')
  );
  if (isWhitelisted) return next();

  // 5. Default: tolak
  logger.warn(`[DEMO-GUARD] Blocked ${method} ${path} for demo user ${req.user.email}`);
  return res.status(403).json({
    success: false,
    code: 'DEMO_READONLY',
    message: 'Akun demo bersifat read-only. Aksi ini tidak tersedia.'
  });
}

// Helper untuk dipakai di controller: mask data sensitif
function maskSensitiveFields(obj, fields = []) {
  if (!obj) return obj;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  if (Array.isArray(clone)) {
    return clone.map(item => maskSensitiveFields(item, fields));
  }
  fields.forEach(f => {
    if (clone[f] != null && clone[f] !== '') {
      const str = String(clone[f]);
      if (str.length <= 4) {
        clone[f] = '***';
      } else {
        // Tampilkan 2 karakter awal + 2 karakter akhir
        clone[f] = str.slice(0, 2) + '*'.repeat(Math.max(3, str.length - 4)) + str.slice(-2);
      }
    }
  });
  return clone;
}

// Middleware yang melampirkan helper masking ke response — dipakai kalau mau
// ubah response JSON secara global untuk demo user.
function demoMaskResponse(sensitiveFields = []) {
  return (req, res, next) => {
    if (!req.isDemo) return next();
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (body && body.data) {
        body.data = maskSensitiveFields(body.data, sensitiveFields);
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = {
  demoGuard,
  demoMaskResponse,
  maskSensitiveFields,
  isDemoUser,
  DEMO_BLOCKED_PREFIXES,
  DEMO_POST_WHITELIST,
};
