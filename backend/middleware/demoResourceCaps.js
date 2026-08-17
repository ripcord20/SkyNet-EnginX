/**
 * demoResourceCaps.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pembatasan resource untuk akun demo:
 *
 *   1. Pagination cap — paksa limit max 50 item per request, supaya demo user
 *      tidak bisa scrape seluruh database via ?limit=999999.
 *   2. Upload size cap — file upload dibatasi 1 MB (vs default 10 MB).
 *   3. Export disabled — endpoint /export/* dilarang total untuk demo.
 *   4. Search query length cap — query string max 200 char untuk cegah ReDoS.
 *
 * Pasang SETELAH authenticate (perlu req.user) dan demoGuard.
 */

const isDemoUser = (req) => {
  const roleName = req.user?.role?.name;
  return typeof roleName === 'string' && roleName.toLowerCase() === 'demo';
};

// Maks item per page untuk demo user
const DEMO_MAX_LIMIT = parseInt(process.env.DEMO_MAX_LIMIT || '50', 10);

// Maks ukuran upload untuk demo (bytes)
const DEMO_MAX_UPLOAD_BYTES = parseInt(process.env.DEMO_MAX_UPLOAD || '1048576', 10); // 1MB

// Maks panjang query string param
const DEMO_MAX_QUERY_LEN = 200;

// Endpoint yang dianggap "export bulk" dan dilarang untuk demo
const EXPORT_PATTERNS = [
  /\/export(\/|$)/i,
  /\/download\/(all|bulk|full)/i,
  /\/report\/.*\/(pdf|xlsx|csv)$/i,
];

/**
 * Middleware utama — pasang sekali di level app/api setelah authenticate.
 */
function demoResourceCaps(req, res, next) {
  if (!isDemoUser(req)) return next();

  const path = req.path || req.originalUrl.split('?')[0];

  // --- 1. Block export bulk ---
  if (EXPORT_PATTERNS.some(re => re.test(path))) {
    return res.status(403).json({
      success: false,
      code: 'DEMO_EXPORT_DISABLED',
      message: 'Export dan download bulk dinonaktifkan pada akun demo.'
    });
  }

  // --- 2. Cap pagination ---
  // Cek query param yang umum dipakai untuk paging
  const limitKeys = ['limit', 'per_page', 'perPage', 'pageSize', 'page_size', 'size'];
  for (const k of limitKeys) {
    if (req.query[k] != null) {
      const n = parseInt(req.query[k], 10);
      if (isNaN(n) || n > DEMO_MAX_LIMIT) {
        req.query[k] = String(DEMO_MAX_LIMIT);
      }
    }
  }
  // Body limit (untuk POST search)
  if (req.body && typeof req.body === 'object') {
    for (const k of limitKeys) {
      if (req.body[k] != null) {
        const n = parseInt(req.body[k], 10);
        if (isNaN(n) || n > DEMO_MAX_LIMIT) {
          req.body[k] = DEMO_MAX_LIMIT;
        }
      }
    }
  }

  // --- 3. Cap query string length ---
  // Cegah serangan dengan query super panjang (DOS / ReDoS)
  for (const k of Object.keys(req.query || {})) {
    const v = req.query[k];
    if (typeof v === 'string' && v.length > DEMO_MAX_QUERY_LEN) {
      req.query[k] = v.slice(0, DEMO_MAX_QUERY_LEN);
    }
  }

  // --- 4. Cap content-length untuk upload ---
  // Cek header content-length dulu untuk reject early
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');

  if (isMultipart && contentLength > DEMO_MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      success: false,
      code: 'DEMO_UPLOAD_TOO_LARGE',
      message: `Upload pada akun demo dibatasi ${Math.round(DEMO_MAX_UPLOAD_BYTES / 1024)} KB.`
    });
  }

  // Tandai req supaya multer/formidable bisa cek caps ini juga
  req.demoLimits = {
    maxUploadBytes: DEMO_MAX_UPLOAD_BYTES,
    maxLimit: DEMO_MAX_LIMIT,
  };

  next();
}

/**
 * Helper untuk integrasi dengan multer kalau dipakai per-route.
 * Penggunaan:
 *   const upload = multer({ limits: getMulterLimits(req) });
 */
function getMulterLimits(req) {
  if (isDemoUser(req)) {
    return { fileSize: DEMO_MAX_UPLOAD_BYTES };
  }
  return { fileSize: 10 * 1024 * 1024 }; // 10MB default
}

module.exports = {
  demoResourceCaps,
  getMulterLimits,
  isDemoUser,
  DEMO_MAX_LIMIT,
  DEMO_MAX_UPLOAD_BYTES,
};
