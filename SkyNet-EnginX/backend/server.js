require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs   = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const logger = require('./utils/logger');
const db = require('./models');
const apiRoutes = require('./routes/api');
const webRoutes = require('./routes/web');
const portalRoutes = require('./routes/portal');
const resellerRoutes = require('./routes/reseller');
const publicPagesRoutes = require('./routes/publicPages');
const publicRegisterRoutes = require('./routes/publicRegister');
const publicVoucherRoutes = require('./routes/publicVoucher');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { demoGuard } = require('./middleware/demoGuard');
const { demoDataMasker } = require('./middleware/demoDataMasker');
const { demoResourceCaps } = require('./middleware/demoResourceCaps');
const SNMPService = require('./services/SNMPService');
const CronService = require('./services/CronService');
const setupSocket = require('./services/SocketHandler');

const app = express();

// Trust proxy — wajib aktif kalau di belakang nginx/CDN supaya req.ip
// dapat IP pelanggan asli (dari X-Forwarded-For), bukan IP nginx (127.0.0.1).
// Ini penting untuk halaman publik isolir (/p/isolir) yang lookup customer
// berdasarkan static_ip dari req.ip.
// PENTING: bukan `true` (percaya rantai proxy TANPA BATAS) — itu bikin
// rate-limiter di bawah trivially di-bypass (siapapun bisa spoof header
// X-Forwarded-For dan dianggap IP baru terus). `1` = percaya HANYA hop
// paling dekat (nginx/reverse proxy langsung di depan Node ini), yang
// tetap kasih req.ip = IP pelanggan asli, tanpa lubang keamanan itu.
app.set('trust proxy', 1);

const server = http.createServer(app);

// Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.APP_URL || 'http://localhost:3002',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Setup Socket handlers
setupSocket(io);

// Make io available in controllers
app.set('io', io);
global.__io = io;

// Hubungkan poller traffic terpusat ke Socket.IO (broadcast snapshot ke admin)
require('./services/CustomerTrafficPoller').attachIo(io);
// Pre-warm: isi snapshot awal di latar belakang + keep-warm idle polling,
// supaya status online sudah siap saat admin pertama membuka halaman
// (tidak menunggu computeSnapshot dari nol). Ditunda sedikit agar tidak
// menambah beban saat boot (router & DB sudah pasti siap setelah listen).
setTimeout(() => {
  try { require('./services/CustomerTrafficPoller').prewarm(); } catch (_) {}
}, 8000);

// Connect NotificationService to socket.io
require('./services/NotificationService').setIO(io);

// Init Web Push (VAPID) — opsional, aktif jika VAPID_PUBLIC_KEY di .env
require('./services/PushService').init();

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'frontend', 'views'));

// Middleware
app.use(helmet({
  // HSTS mengirim Strict-Transport-Security walau koneksi masih HTTP biasa (server
  // ini tidak terminasi TLS sendiri — itu tugas reverse proxy/Cloudflare di depan
  // kalau ada). Tanpa baris ini, browser yang pernah terima header ini akan
  // "mengunci" host ke HTTPS selamanya (sampai HSTS cache dibersihkan manual),
  // sehingga semua request berikutnya gagal connect di deployment tanpa TLS.
  hsts: false,
  contentSecurityPolicy: process.env.APP_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", "'unsafe-inline'", "'unsafe-eval'",
        "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com",
        "static.cloudflareinsights.com",
        "app.midtrans.com", "app.sandbox.midtrans.com", "*.midtrans.com",
        "app-prod.duitku.com", "app-sandbox.duitku.com", "*.duitku.com"
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: [
        "'self'", "'unsafe-inline'",
        "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com", "unpkg.com",
        "app.midtrans.com", "app.sandbox.midtrans.com",
        "app-prod.duitku.com", "app-sandbox.duitku.com", "*.duitku.com"
      ],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdn.jsdelivr.net"],
      imgSrc: [
        "'self'", "data:", "blob:",
        "*.tile.openstreetmap.org", "*.basemaps.cartocdn.com",
        "mt0.google.com", "mt1.google.com", "mt2.google.com", "mt3.google.com",
        "*.googleapis.com", "*.ggpht.com",
        // Tile satelit Esri (World Imagery) untuk mode satelit peta.
        "server.arcgisonline.com", "*.arcgisonline.com",
        "unpkg.com", "*.midtrans.com", "*.duitku.com",
        // Logo channel/bank Tripay di-host di domain Tripay (mis. assets.tripay.co.id).
        "*.tripay.co.id", "tripay.co.id"
      ],
      connectSrc: [
        "'self'", "ws:", "wss:",
        "cdn.jsdelivr.net", "unpkg.com",
        "*.tile.openstreetmap.org", "*.basemaps.cartocdn.com",
        "server.arcgisonline.com", "*.arcgisonline.com",
        "nominatim.openstreetmap.org",
        "mt0.google.com", "mt1.google.com", "mt2.google.com", "mt3.google.com",
        "*.midtrans.com", "api.midtrans.com", "api.sandbox.midtrans.com",
        "*.duitku.com", "passport.duitku.com", "sandbox.duitku.com",
        "*.tripay.co.id", "tripay.co.id"
      ],
      frameSrc: [
        "'self'",
        "app.midtrans.com", "app.sandbox.midtrans.com", "*.midtrans.com",
        "app-prod.duitku.com", "app-sandbox.duitku.com", "*.duitku.com",
        "passport.duitku.com", "sandbox.duitku.com",
        // Halaman checkout Tripay (bila dibuka via iframe/redirect).
        "*.tripay.co.id", "tripay.co.id"
      ]
    }
  } : false
}));
// ── CORS khusus endpoint publik yang dipanggil dari landing page ──
// HARUS dipasang SEBELUM CORS global di bawah. Alasannya: paket `cors` global
// dikonfigurasi hanya untuk APP_URL dan ia menangani preflight OPTIONS sendiri
// lalu langsung membalas — sehingga handler CORS di router publicPages tidak
// pernah dieksekusi untuk OPTIONS, dan preflight dari landing selalu ditolak.
// Middleware ini menangani origin landing (LANDING_URL) lebih awal.
app.use([
  '/pub/cek-tagihan', '/p/cek-tagihan',   // cek tagihan
  '/pub/reg/packages',                     // daftar paket utk form pendaftaran
  '/pub/reg/coverage',                     // cek jangkauan
  '/pub/reg/submit',                       // kirim pendaftaran
  '/api/regions/provinces',                // dropdown alamat berjenjang
  '/api/regions/regencies',
  '/api/regions/districts',
  '/api/regions/villages',
], (req, res, next) => {
  const allowed = String(process.env.LANDING_URL || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = (req.headers.origin || '').replace(/\/+$/, '');
  if (allowed.length && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    // Helmet memasang Cross-Origin-Resource-Policy: same-origin yang membuat
    // BROWSER menolak respons lintas origin meski header CORS sudah benar.
    // curl tidak terpengaruh, sehingga gejalanya tidak terlihat dari terminal.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.setHeader('X-Landing-Cors', 'active');

    // PENTING: `cors()` global di bawah berjalan SETELAH middleware ini dan akan
    // MENIMPA Access-Control-Allow-Origin dengan APP_URL. Untuk preflight kita
    // aman (dibalas lebih awal), tapi untuk POST tidak. Karena itu nilai origin
    // dikunci: setiap upaya menulis ulang header tersebut diabaikan.
    const lockedOrigin = origin;
    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name, value) {
      if (String(name).toLowerCase() === 'access-control-allow-origin') {
        return origSetHeader('Access-Control-Allow-Origin', lockedOrigin);
      }
      // Jangan biarkan credentials:true dari CORS global bentrok dengan
      // origin spesifik (browser menolak kombinasi yang tidak konsisten).
      if (String(name).toLowerCase() === 'access-control-allow-credentials') {
        return res;
      }
      return origSetHeader(name, value);
    };

    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } else {
    // Bantu diagnosa bila origin tidak cocok dengan LANDING_URL.
    res.setHeader('X-Landing-Cors', allowed.length
      ? ('origin-mismatch; got=' + (origin || 'none'))
      : 'LANDING_URL-empty');
  }
  next();
});
app.use(cors({ origin: process.env.APP_URL, credentials: true }));
app.use(compression());
// PENTING: simpan raw body mentah untuk verifikasi signature webhook (Tripay HMAC-SHA256).
// express.json() global mengonsumsi stream body, sehingga express.raw() per-route TIDAK
// akan kebagian body lagi (stream sudah habis) → rawBody kosong → signature selalu gagal.
// Solusi: tangkap raw body di sini via opsi `verify`, tersedia sebagai req.rawBody untuk
// SEMUA route tanpa mengganggu parsing JSON biasa.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf && buf.length ? buf.toString('utf8') : ''; }
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// Rate limiting — general API
// 500/15min terlalu sedikit untuk dashboard yang aktif (socket + polling + charts).
// Per-user dashboard normal bisa 50-100 req/menit, jadi naikkan ke 2000/15min (≈130/menit).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  // Skip endpoint polling yang sangat sering dipanggil (notifikasi badge, dashboard stats)
  // supaya tidak menghabiskan kuota.
  skip: (req) => {
    const path = req.path || '';
    return /^\/(notifications\/unread-count|dashboard\/stats|auth\/profile)/.test(path);
  },
  message: { success: false, message: 'Too many requests' }
});

// Stricter limiter for authentication endpoints to resist brute-force/credential-stuffing
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                       // 10 attempts per 15 min per IP
  skipSuccessfulRequests: true,  // only count failed logins toward the limit
  message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi nanti.' }
});
app.use(['/api/auth/login', '/api/auth/register', '/portal/api/auth/login', '/reseller/api/auth/login'], authLimiter);
app.use('/api', apiLimiter);

// ── Demo-specific rate limiter (60 req/min untuk role demo) ─────────
const demoApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  skip: (req) => {
    const token = req.cookies?.token;
    if (!token) return true;
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return decoded.role !== 'demo';
    } catch { return true; }
  },
  message: { success: false, message: 'Demo rate limit reached.' }
});
app.use('/api', demoApiLimiter);


// Static files
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

// ── Guard: block direct access to *.json / *.env / dotfiles under /uploads ──
// The uploads folder is serve-as-static for user-uploaded media (photos, etc.),
// but legacy code also writes runtime config (mikrotik_config.json, acs_config.json,
// olt_config.json, wa_auth/) to the same dir. We 403 any path that could leak them.
app.use('/uploads', (req, res, next) => {
  const p = req.path.toLowerCase();
  if (p.endsWith('.json') || p.endsWith('.env') || p.includes('/wa_auth/') ||
      p.includes('/payment_proofs/') ||
      p.split('/').some(seg => seg.startsWith('.'))) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  next();
});
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'frontend', 'public', 'uploads')));

// Service Worker — harus bisa diakses dari root path
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, '..', 'frontend', 'public', 'sw.js'));
});

// Favicon — dynamic dari app_settings, dengan fallback ke default
// Browser auto-request /favicon.ico di root, jadi tidak perlu edit semua page.
app.get('/favicon.ico', async (req, res) => {
  try {
    const { AppSetting } = require('./models');
    const setting = await AppSetting.findOne({ where: { key: 'favicon_url' } });
    if (setting && setting.value) {
      // Strip query string (?v=cache-bust) sebelum resolve path filesystem.
      // URL di DB bisa berbentuk "/uploads/favicon.png?v=1715600000".
      const cleanUrl = String(setting.value).split('?')[0];
      const filePath = path.join(__dirname, '..', 'frontend', 'public', cleanUrl);
      if (fs.existsSync(filePath)) {
        // Cache 1 jam supaya browser tidak hit DB tiap request.
        // Karena URL favicon punya cache-bust ?v=..., refresh tetap mulus saat diganti.
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.sendFile(filePath);
      }
    }
  } catch (e) { /* fall through ke default */ }

  // Default fallback
  const defaultPath = path.join(__dirname, '..', 'frontend', 'public', 'favicon.ico');
  if (fs.existsSync(defaultPath)) {
    return res.sendFile(defaultPath);
  }
  // Tidak ada default → 204 supaya browser tidak terus-menerus retry
  res.status(204).end();
});

// ── Global app settings middleware ──────────────────────────────────
// Cache hasil query selama 60 detik supaya tidak hit DB setiap request.
// Cache di-bust otomatis saat admin save setting via API
// (lihat SettingsController — invalidate via global._appSettingsCache = null).
let _appSettingsCache = null;
let _appSettingsCacheAt = 0;
const APP_SETTINGS_CACHE_TTL = 60 * 1000; // 60 detik
// Ekspos cache supaya bisa di-invalidate dari controller setting:
global._invalidateAppSettingsCache = () => { _appSettingsCache = null; _appSettingsCacheAt = 0; };

app.use(async (req, res, next) => {
  try {
    let cfg;
    const now = Date.now();
    // Pakai cache kalau masih valid
    if (_appSettingsCache && (now - _appSettingsCacheAt) < APP_SETTINGS_CACHE_TTL) {
      cfg = _appSettingsCache;
    } else {
      const { AppSetting } = require('./models');
      const keys = ['brand_mode','app_name','app_tagline','logo_url','favicon_url',
        'theme_primary_color','theme_accent_color','theme_enabled',
        'locale_timezone','locale_date_format','locale_currency'];
      const rows = await AppSetting.findAll({ where: { key: keys } });
      cfg = {};
      rows.forEach(r => { cfg[r.key] = r.value; });
      _appSettingsCache = cfg;
      _appSettingsCacheAt = now;
    }
    res.locals.appSettings = cfg;
    res.locals.brandMode   = cfg.brand_mode  || 'name_tagline';
    res.locals.appName     = cfg.app_name    || 'DIGSnet';
    res.locals.appTagline  = cfg.app_tagline || '';
    res.locals.logoUrl     = cfg.logo_url    || '';
    res.locals.faviconUrl  = cfg.favicon_url || '';
    res.locals.themePrimary = (cfg.theme_enabled === '1' && cfg.theme_primary_color) ? cfg.theme_primary_color : '';
    res.locals.themeAccent  = (cfg.theme_enabled === '1' && cfg.theme_accent_color)  ? cfg.theme_accent_color  : '';
    res.locals.localeTimezone   = cfg.locale_timezone   || 'Asia/Jakarta';
    res.locals.localeDateFormat = cfg.locale_date_format || 'DD/MM/YYYY';
    res.locals.localeCurrency   = cfg.locale_currency   || 'IDR';
  } catch(e) {
    res.locals.appSettings = {};
    res.locals.brandMode   = 'name_tagline';
    res.locals.appName     = 'DIGSnet';
    res.locals.appTagline  = '';
    res.locals.logoUrl     = '';
    res.locals.faviconUrl  = '';
    res.locals.themePrimary = '';
    res.locals.themeAccent  = '';
    res.locals.localeTimezone   = 'Asia/Jakarta';
    res.locals.localeDateFormat = 'DD/MM/YYYY';
    res.locals.localeCurrency   = 'IDR';
  }
  next();
});

const NotificationService = require('./services/NotificationService');

// Demo data masker — wrap res.json supaya field sensitif di-mask untuk demo user.
// Lazy: dia hanya bekerja kalau req.user.role.name === 'demo' saat response dikirim.
app.use('/api', demoDataMasker);

app.use('/api', apiRoutes);
app.use('/portal', portalRoutes);
// ── Dashboard Reseller Voucher Hotspot ──────────────────────────
// Akun reseller terpisah (tabel resellers), token JWT type='reseller',
// cookie reseller_token (path=/reseller). Halaman mobile-friendly untuk
// generate voucher dengan sistem deposit saldo.
app.use('/reseller', resellerRoutes);
// ── Halaman publik (TANPA authenticate) ─────────────────────────
// Harus di-mount sebelum webRoutes karena webRoutes pakai authenticate
// pada hampir semua endpoint. /p/isolir adalah target dst-nat redirect
// dari MikroTik untuk pelanggan terisolir — wajib bisa diakses tanpa
// login.
app.use('/p', publicPagesRoutes);
// Mount juga di /pub — link public invoice memakai prefix /pub/invoice/:token
// (dibuat oleh buildInvoiceLink di templateHelper). Router yang sama menangani
// /pub/invoice/:token tanpa authenticate.
app.use('/pub', publicPagesRoutes);

// ── Pendaftaran pelanggan publik via link referral sales ────────
// /registrasi-layanan/:code → halaman form ; /pub/reg/* → endpoint JSON.
// Wajib sebelum webRoutes (tanpa authenticate). /daftar dipertahankan
// sebagai alias agar link lama yang sudah tersebar tetap berfungsi.
app.use('/registrasi-layanan', publicRegisterRoutes.pageRouter);
app.use('/daftar', publicRegisterRoutes.pageRouter);
app.use('/pub/reg', publicRegisterRoutes.apiRouter);

// ── Halaman publik beli voucher hotspot (TANPA login) ───────────
// /beli-voucher → landing page pembelian ; /pub/voucher/* → API + webhook gateway.
// Wajib sebelum webRoutes (tanpa authenticate).
app.use('/beli-voucher', publicVoucherRoutes.pageRouter);
app.use('/pub/voucher', publicVoucherRoutes.apiRouter);

// ── Isolir redirect guard ───────────────────────────────────────
// DISABLED: file controllers/IsolirPublicController.js belum dibuat
// atau belum export `isolirRedirectGuard`. Kalau sudah siap, uncomment
// 2 baris di bawah dan pastikan controller punya export bernama itu.
// const { isolirRedirectGuard } = require('./controllers/IsolirPublicController');
// app.use(isolirRedirectGuard);

app.use('/', webRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────
const PORT = process.env.APP_PORT || 3002;

const startServer = async () => {
  try {
    await db.sequelize.authenticate();
    logger.info('Database connection established');

    if (process.env.APP_ENV === 'development') {
      await db.sequelize.sync({ alter: false });
      logger.info('Database models synced');
    }

    // Pastikan role bawaan (finance) ada di DB. Idempotent — aman dipanggil
    // tiap kali server start.
    try {
      const { Role } = require('./models');
      await Role.findOrCreate({
        where: { name: 'finance' },
        defaults: {
          name: 'finance',
          display_name: 'Admin Finance',
          description: 'Akses khusus modul billing, pembayaran, keuangan, dan laporan keuangan.',
          is_system: true
        }
      });
      // Role NOC (Network Operations Center) — fokus monitoring jaringan
      await Role.findOrCreate({
        where: { name: 'noc' },
        defaults: {
          name: 'noc',
          display_name: 'Admin NOC',
          description: 'Akses khusus monitoring jaringan: traffic, PPPoE, OLT/ONT, devices, dan infrastructure.',
          is_system: true
        }
      });
    } catch (e) {
      logger.warn('Failed to ensure finance role: ' + (e.message || e));
    }

    // Idempotent ALTER untuk kolom tracking reminder WA — aman dipanggil
    // setiap server start. MySQL: cek dulu lewat information_schema agar
    // tidak throw "duplicate column" di restart kedua.
    try {
      const [colRows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'invoices'
            AND column_name = 'last_wa_reminder_at'`
      );
      const exists = (colRows && colRows[0] && parseInt(colRows[0].c) > 0);
      if (!exists) {
        await db.sequelize.query(
          `ALTER TABLE invoices ADD COLUMN last_wa_reminder_at DATETIME NULL AFTER status`
        );
        logger.info('Migrated: invoices.last_wa_reminder_at column added');
      }
    } catch (e) {
      logger.warn('Failed to migrate invoices.last_wa_reminder_at: ' + (e.message || e));
    }

    // Idempotent ALTER untuk payments.gateway — kolom baru penanda gateway
    // online (tripay/midtrans/xendit/duitku). NULL utk pembayaran non-gateway.
    // Cek information_schema dulu agar tidak throw "duplicate column" di restart.
    try {
      const [gwCol] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'payments'
            AND column_name = 'gateway'`
      );
      const gwExists = (gwCol && gwCol[0] && parseInt(gwCol[0].c) > 0);
      if (!gwExists) {
        await db.sequelize.query(
          `ALTER TABLE payments ADD COLUMN gateway VARCHAR(20) NULL AFTER reference_number`
        );
        logger.info('Migrated: payments.gateway column added');

        // Backfill data lama dari kolom notes ("Auto: <Gateway> ..." atau
        // "Rekonsiliasi: <Gateway> ..."). Sekali jalan, hanya untuk baris gateway=NULL.
        const gwMap = { tripay: 'Tripay', midtrans: 'Midtrans', xendit: 'Xendit', duitku: 'Duitku' };
        for (const [key, name] of Object.entries(gwMap)) {
          await db.sequelize.query(
            `UPDATE payments SET gateway = :key
              WHERE gateway IS NULL
                AND (notes LIKE :autoPat OR notes LIKE :reconPat)`,
            { replacements: {
                key,
                autoPat:  `%Auto: ${name}%`,
                reconPat: `%Rekonsiliasi: ${name}%`
            } }
          );
        }
        logger.info('Backfilled: payments.gateway dari notes untuk data lama');
      }
    } catch (e) {
      logger.warn('Failed to migrate payments.gateway: ' + (e.message || e));
    }

    // Idempotent ALTER untuk wa_templates.category — expand ENUM agar
    // mencakup 'invoice_unpaid' & 'invoice_paid' yang dipakai oleh tombol
    // "Kirim via WA" di halaman invoice (PaymentController.sendWaInvoiceByInvoice).
    // Cek lewat information_schema dulu supaya tidak menjalankan ALTER yang
    // mahal kalau ENUM sudah lengkap. Mempertahankan SEMUA nilai existing
    // termasuk yang ditambahkan oleh patch sebelumnya (welcome, isolir, restore).
    try {
      const [enumRow] = await db.sequelize.query(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wa_templates' AND COLUMN_NAME = 'category'`,
        { type: db.sequelize.QueryTypes.SELECT }
      );
      const colType = String(enumRow?.COLUMN_TYPE || '');
      const needsUnpaid = !colType.includes("'invoice_unpaid'");
      const needsPaid   = !colType.includes("'invoice_paid'");
      if (needsUnpaid || needsPaid) {
        await db.sequelize.query(
          `ALTER TABLE wa_templates MODIFY COLUMN category
           ENUM('reminder_before','reminder_due','reminder_overdue',
                'broadcast','custom','payment_confirm',
                'isolir','restore','welcome',
                'invoice_unpaid','invoice_paid')
           NOT NULL DEFAULT 'custom'`
        );
        logger.info('Migrated: wa_templates.category ENUM expanded with invoice_unpaid & invoice_paid');
      }
    } catch (e) {
      logger.warn('Failed to expand wa_templates.category ENUM: ' + (e.message || e));
    }

    // ── Migrasi: wa_sessions.provider & wa_sessions.fonnte_token ────────────
    // Dibutuhkan fitur multi-provider gateway (Baileys / Fonnte). Idempotent.
    try {
      const [provRows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'wa_sessions'
            AND column_name = 'provider'`
      );
      if (!(provRows && provRows[0] && parseInt(provRows[0].c) > 0)) {
        await db.sequelize.query(
          `ALTER TABLE wa_sessions
             ADD COLUMN provider ENUM('baileys','fonnte') NOT NULL DEFAULT 'baileys' AFTER notes`
        );
        logger.info('Migrated: wa_sessions.provider column added');
      }
    } catch (e) {
      logger.warn('Failed to migrate wa_sessions.provider: ' + (e.message || e));
    }
    try {
      const [tokRows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'wa_sessions'
            AND column_name = 'fonnte_token'`
      );
      if (!(tokRows && tokRows[0] && parseInt(tokRows[0].c) > 0)) {
        await db.sequelize.query(
          `ALTER TABLE wa_sessions ADD COLUMN fonnte_token VARCHAR(255) NULL AFTER provider`
        );
        logger.info('Migrated: wa_sessions.fonnte_token column added');
      }
    } catch (e) {
      logger.warn('Failed to migrate wa_sessions.fonnte_token: ' + (e.message || e));
    }

    // ── Migrasi: provider WAHA (ENUM + kolom config) ─────────────────────────
    // Provider gateway ke-3: WAHA self-hosted. Idempotent — cek dulu sebelum ALTER.
    try {
      const [colType] = await db.sequelize.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'wa_sessions'
            AND column_name = 'provider'`
      );
      const enumDef = colType && colType[0] ? String(colType[0].t) : '';
      if (enumDef && !enumDef.includes("'waha'")) {
        await db.sequelize.query(
          `ALTER TABLE wa_sessions
             MODIFY COLUMN provider ENUM('baileys','fonnte','waha') NOT NULL DEFAULT 'baileys'`
        );
        logger.info("Migrated: wa_sessions.provider ENUM expanded with 'waha'");
      }
    } catch (e) {
      logger.warn('Failed to expand wa_sessions.provider ENUM: ' + (e.message || e));
    }
    // ── Migrasi: kolom reply/quote di wa_messages ──
    for (const col of [
      { name: 'reply_to_id',   ddl: `ADD COLUMN reply_to_id VARCHAR(255) NULL AFTER wa_message_id`,  table: 'wa_messages' },
      { name: 'reply_to_text', ddl: `ADD COLUMN reply_to_text VARCHAR(500) NULL AFTER reply_to_id`, table: 'wa_messages' },
    ]) {
      try {
        const [rows] = await db.sequelize.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = '${col.table}' AND column_name = '${col.name}'`
        );
        if (!(rows && rows[0] && parseInt(rows[0].c) > 0)) {
          await db.sequelize.query(`ALTER TABLE ${col.table} ${col.ddl}`);
          logger.info('Migrated: ' + col.table + '.' + col.name + ' column added');
        }
      } catch (e) {
        logger.warn('Failed to migrate ' + col.table + '.' + col.name + ': ' + (e.message || e));
      }
    }

    for (const col of [
      { name: 'waha_url',     ddl: `ADD COLUMN waha_url VARCHAR(255) NULL AFTER fonnte_token` },
      { name: 'waha_api_key', ddl: `ADD COLUMN waha_api_key VARCHAR(255) NULL AFTER waha_url` },
      { name: 'waha_session', ddl: `ADD COLUMN waha_session VARCHAR(100) NULL AFTER waha_api_key` },
    ]) {
      try {
        const [rows] = await db.sequelize.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'wa_sessions'
              AND column_name = '${col.name}'`
        );
        if (!(rows && rows[0] && parseInt(rows[0].c) > 0)) {
          await db.sequelize.query(`ALTER TABLE wa_sessions ${col.ddl}`);
          logger.info('Migrated: wa_sessions.' + col.name + ' column added');
        }
      } catch (e) {
        logger.warn('Failed to migrate wa_sessions.' + col.name + ': ' + (e.message || e));
      }
    }

    // Idempotent ALTER untuk kolom customers.infra_parent_id — kolom baru
    // untuk fitur auto-sync customer → InfrastructurePoint. Saat customer
    // punya lat/lng, sistem otomatis bikin titik di peta infrastruktur dengan
    // parent_id = nilai kolom ini. Boleh NULL.
    try {
      const [colRows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'customers'
            AND column_name = 'infra_parent_id'`
      );
      const exists = (colRows && colRows[0] && parseInt(colRows[0].c) > 0);
      if (!exists) {
        await db.sequelize.query(
          `ALTER TABLE customers ADD COLUMN infra_parent_id INT NULL AFTER longitude`
        );
        // Tambah FK ke infrastructure_points (ON DELETE SET NULL agar
        // kalau ODP induk dihapus, customer tidak ikut error — link saja
        // di-clear). Wrap di try terpisah supaya kalau FK gagal (mis. tabel
        // belum ada di env lama), kolom-nya tetap terbuat.
        try {
          await db.sequelize.query(
            `ALTER TABLE customers
              ADD CONSTRAINT fk_customers_infra_parent
              FOREIGN KEY (infra_parent_id) REFERENCES infrastructure_points(id)
              ON DELETE SET NULL ON UPDATE CASCADE`
          );
        } catch (fkErr) {
          logger.warn('FK fk_customers_infra_parent tidak terpasang: ' + (fkErr.message || fkErr));
        }
        logger.info('Migrated: customers.infra_parent_id column added');
      }
    } catch (e) {
      logger.warn('Failed to migrate customers.infra_parent_id: ' + (e.message || e));
    }

    // ── Migrasi: customers.nik (No. KTP / NIK) ──────────────────────────────
    // Kolom baru untuk menyimpan nomor KTP pelanggan. Idempotent.
    try {
      const [nikRows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'customers'
            AND column_name = 'nik'`
      );
      if (!(nikRows && nikRows[0] && parseInt(nikRows[0].c) > 0)) {
        await db.sequelize.query(
          `ALTER TABLE customers ADD COLUMN nik VARCHAR(20) NULL AFTER address`
        );
        logger.info('Migrated: customers.nik column added');
      }
    } catch (e) {
      logger.warn('Failed to migrate customers.nik: ' + (e.message || e));
    }

    // ── Migrasi: kolom wilayah terstruktur untuk filter per-area ────────────
    // province, regency (kab/kota), district (kecamatan), village (desa/kel).
    // Idempotent — cek tiap kolom sebelum ALTER.
    try {
      const areaCols = [
        { name: 'province', after: 'nik' },
        { name: 'regency',  after: 'province' },
        { name: 'district', after: 'regency' },
        { name: 'village',  after: 'district' },
      ];
      for (const col of areaCols) {
        const [rows] = await db.sequelize.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'customers'
              AND column_name = '${col.name}'`
        );
        if (!(rows && rows[0] && parseInt(rows[0].c) > 0)) {
          await db.sequelize.query(
            `ALTER TABLE customers ADD COLUMN ${col.name} VARCHAR(100) NULL AFTER ${col.after}`
          );
          logger.info('Migrated: customers.' + col.name + ' column added');
        }
      }
    } catch (e) {
      logger.warn('Failed to migrate customers area columns: ' + (e.message || e));
    }

    // ── Migrasi: customers.public_link_token (link pembayaran permanen) ─────
    // Token acak per-pelanggan untuk /pub/cust/:token. Bisa di-revoke. Idempotent.
    try {
      const [rows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'customers'
            AND column_name = 'public_link_token'`
      );
      if (!(rows && rows[0] && parseInt(rows[0].c) > 0)) {
        await db.sequelize.query(
          `ALTER TABLE customers ADD COLUMN public_link_token VARCHAR(64) NULL UNIQUE AFTER due_date`
        );
        logger.info('Migrated: customers.public_link_token column added');
      }
    } catch (e) {
      logger.warn('Failed to migrate customers.public_link_token: ' + (e.message || e));
    }

    // ── Migrasi: kolom verifikasi pembayaran manual (invoices) ──────────────
    // verification_status: alur konfirmasi MANUAL saja (transfer bank + bukti).
    //   none      = belum ada pengajuan
    //   submitted = pelanggan sudah upload bukti / konfirmasi, menunggu admin
    //   verified  = admin sudah verifikasi (biasanya bersamaan invoice → paid)
    //   rejected  = admin menolak bukti
    // CATATAN: ini TERPISAH dari invoices.status. Pembayaran gateway TIDAK
    // menyentuh kolom ini (langsung paid via webhook). Idempotent.
    try {
      const vcols = [
        { name: 'verification_status', ddl: `ENUM('none','submitted','verified','rejected') NOT NULL DEFAULT 'none'`, after: 'status' },
        { name: 'proof_path',          ddl: `VARCHAR(255) NULL`, after: 'verification_status' },
        { name: 'proof_submitted_at',  ddl: `DATETIME NULL`,     after: 'proof_path' },
        { name: 'proof_note',          ddl: `VARCHAR(255) NULL`, after: 'proof_submitted_at' },
      ];
      for (const col of vcols) {
        const [rows] = await db.sequelize.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'invoices'
              AND column_name = '${col.name}'`
        );
        if (!(rows && rows[0] && parseInt(rows[0].c) > 0)) {
          await db.sequelize.query(
            `ALTER TABLE invoices ADD COLUMN ${col.name} ${col.ddl} AFTER ${col.after}`
          );
          logger.info('Migrated: invoices.' + col.name + ' column added');
        }
      }
    } catch (e) {
      logger.warn('Failed to migrate invoices verification columns: ' + (e.message || e));
    }

    // Migrasi index unik reminder_logs: dari (reminder_id,invoice_id,send_date)
    // ke (reminder_id,invoice_id,send_date,reminder_type) agar reminder WA &
    // Email bisa hidup berdampingan di hari yang sama (dedup per kanal).
    try {
      const [idxRows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c FROM information_schema.statistics
          WHERE table_schema = DATABASE()
            AND table_name = 'reminder_logs'
            AND index_name = 'uniq_reminder_invoice_date_type'`
      );
      if (!(idxRows && idxRows[0] && parseInt(idxRows[0].c) > 0)) {
        // Drop index lama bila ada (abaikan error kalau tidak ada)
        try { await db.sequelize.query('ALTER TABLE reminder_logs DROP INDEX uniq_reminder_invoice_date'); } catch (_) {}
        await db.sequelize.query(
          'ALTER TABLE reminder_logs ADD UNIQUE INDEX uniq_reminder_invoice_date_type (reminder_id, invoice_id, send_date, reminder_type)'
        );
        logger.info('Migrated: reminder_logs unique index → includes reminder_type');
      }
    } catch (e) {
      logger.warn('Failed to migrate reminder_logs index: ' + (e.message || e));
    }

    // Sync noc_monitor_presets table — pakai Sequelize sync supaya kolom JSON
    // dan index ke-handle dengan benar tanpa SQL manual. Idempotent.
    try {
      await db.NocMonitorPreset.sync();
      if (db.NmsInterfacePreset) await db.NmsInterfacePreset.sync();
      logger.info('Synced: noc_monitor_presets table');
    } catch (e) {
      logger.warn('Failed to sync noc_monitor_presets: ' + (e.message || e));
    }

    // Sync reminder_logs (dedup + history pengiriman WA reminder). Idempotent.
    try {
      if (db.ReminderLog) {
        await db.ReminderLog.sync();
        logger.info('Synced: reminder_logs table');
      }
    } catch (e) {
      logger.warn('Failed to sync reminder_logs: ' + (e.message || e));
    }

    // ═══════════════════════════════════════════════════════════════
    // RADIUS + WIREGUARD MODULES — buat tabel baru kalau belum ada.
    // sync() = CREATE TABLE IF NOT EXISTS, tidak menyentuh kolom existing.
    // ═══════════════════════════════════════════════════════════════
    for (const [label, model] of [
      ['radius_nas_clients', db.RadiusNasClient],
      ['radius_users', db.RadiusUser],
      ['radius_accounting', db.RadiusAccounting],
      ['nas_port_forwards', db.NasPortForward],
      ['wireguard_servers', db.WireguardServer],
      ['wireguard_peers', db.WireguardPeer],
    ]) {
      try {
        if (model) { await model.sync(); logger.info('Synced: ' + label + ' table'); }
      } catch (e) {
        logger.warn('Failed to sync ' + label + ': ' + (e.message || e));
      }
    }

    // ── Migrasi kolom baru di radius_nas_clients (NAS lewat WireGuard tunnel,
    //    grouping per site, link ke Device) — tabel-nya sendiri sudah dibuat
    //    lewat safeSync di atas, ini menambah kolom untuk instance yang tabelnya
    //    sudah ada duluan dari versi sebelumnya. Idempotent.
    try {
      const nasCols = [
        { name: 'site_name',         ddl: `VARCHAR(150) NULL` },
        { name: 'connection_mode',   ddl: `ENUM('direct','wireguard') NOT NULL DEFAULT 'direct'` },
        { name: 'device_id',         ddl: `INT NULL` },
        { name: 'wireguard_peer_id', ddl: `INT NULL` },
      ];
      for (const col of nasCols) {
        const [rows] = await db.sequelize.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'radius_nas_clients' AND column_name = '${col.name}'`
        );
        if (!(rows && rows[0] && parseInt(rows[0].c) > 0)) {
          await db.sequelize.query(`ALTER TABLE radius_nas_clients ADD COLUMN ${col.name} ${col.ddl}`);
          logger.info('Migrated: radius_nas_clients.' + col.name + ' column added');
        }
      }
    } catch (e) {
      logger.warn('Failed to migrate radius_nas_clients columns: ' + (e.message || e));
    }

    // ═══════════════════════════════════════════════════════════════
    // SALES MODULE — auto-migration idempotent saat boot.
    // Membuat tabel sales (jika belum ada), kolom komisi di packages,
    // kolom foto di registration_requests, dan role 'sales'. Aman diulang.
    // ═══════════════════════════════════════════════════════════════
    try {
      // 1) Tabel sales — sync (create if not exists). Tidak alter kolom existing.
      if (db.SalesProfile)        await db.SalesProfile.sync();
      if (db.RegistrationRequest) await db.RegistrationRequest.sync();
      if (db.SalesCommission)     await db.SalesCommission.sync();

      // helper cek kolom
      const hasColumn = async (table, col) => {
        const [rows] = await db.sequelize.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${col}'`
        );
        return rows && rows[0] && parseInt(rows[0].c) > 0;
      };

      // 2) Kolom komisi di packages
      if (!(await hasColumn('packages', 'commission_flat'))) {
        await db.sequelize.query(`ALTER TABLE packages ADD COLUMN commission_flat DECIMAL(12,2) NOT NULL DEFAULT 0`);
        logger.info('Migrated: packages.commission_flat added');
      }
      if (!(await hasColumn('packages', 'commission_percent'))) {
        await db.sequelize.query(`ALTER TABLE packages ADD COLUMN commission_percent DECIMAL(5,2) NOT NULL DEFAULT 0`);
        logger.info('Migrated: packages.commission_percent added');
      }

      // 3) Kolom foto di registration_requests (penyebab error "Unknown column 'ktp_photo'")
      if (!(await hasColumn('registration_requests', 'ktp_photo'))) {
        await db.sequelize.query(`ALTER TABLE registration_requests ADD COLUMN ktp_photo VARCHAR(255) NULL AFTER id_card_number`);
        logger.info('Migrated: registration_requests.ktp_photo added');
      }
      if (!(await hasColumn('registration_requests', 'house_photo'))) {
        await db.sequelize.query(`ALTER TABLE registration_requests ADD COLUMN house_photo VARCHAR(255) NULL`);
        logger.info('Migrated: registration_requests.house_photo added');
      }
      if (!(await hasColumn('registration_requests', 'installed_photo'))) {
        await db.sequelize.query(`ALTER TABLE registration_requests ADD COLUMN installed_photo VARCHAR(255) NULL`);
        logger.info('Migrated: registration_requests.installed_photo added');
      }

      // 3b) Backfill created_at/updated_at yang NULL (penyebab "Invalid Date").
      //     Pakai updated_at bila ada, jika tidak pakai NOW().
      try {
        await db.sequelize.query(
          `UPDATE registration_requests
             SET created_at = COALESCE(created_at, updated_at, NOW())
           WHERE created_at IS NULL`
        );
        await db.sequelize.query(
          `UPDATE registration_requests
             SET updated_at = COALESCE(updated_at, created_at, NOW())
           WHERE updated_at IS NULL`
        );
        logger.info('Backfilled: registration_requests timestamps (if any NULL)');
      } catch (bfErr) {
        logger.warn('Backfill timestamps skipped: ' + bfErr.message);
      }

      // 4) Role 'sales' — pakai model findOrCreate supaya penamaan kolom
      // timestamp (created_at/updated_at, underscored) ditangani otomatis.
      try {
        const { Role } = require('./models');
        await Role.findOrCreate({
          where: { name: 'sales' },
          defaults: {
            name: 'sales',
            display_name: 'Sales',
            description: 'Tim penjualan: registrasi pelanggan baru, survey, komisi',
            is_system: false
          }
        });
        logger.info('Ensured: role sales');
      } catch (roleErr) {
        logger.warn('Failed to ensure sales role: ' + (roleErr.message || roleErr));
      }

      // 5) Unique index pada sales_commissions.registration_id — cegah komisi
      //    dobel di level DB (lebih kuat dari cek aplikasi yang rawan race).
      //    Bersihkan duplikat lama dulu (sisakan baris paling awal per registrasi).
      try {
        // Kolom detail pembayaran komisi (bukti transfer, metode)
        if (!(await hasColumn('sales_commissions', 'payment_method'))) {
          await db.sequelize.query(`ALTER TABLE sales_commissions ADD COLUMN payment_method VARCHAR(50) NULL`);
          logger.info('Migrated: sales_commissions.payment_method added');
        }
        if (!(await hasColumn('sales_commissions', 'payment_proof'))) {
          await db.sequelize.query(`ALTER TABLE sales_commissions ADD COLUMN payment_proof VARCHAR(255) NULL`);
          logger.info('Migrated: sales_commissions.payment_proof added');
        }
        // Approval workflow: kolom approved_at / approved_by + tambah nilai enum 'approved'
        if (!(await hasColumn('sales_commissions', 'approved_at'))) {
          await db.sequelize.query(`ALTER TABLE sales_commissions ADD COLUMN approved_at DATETIME NULL`);
          logger.info('Migrated: sales_commissions.approved_at added');
        }
        if (!(await hasColumn('sales_commissions', 'approved_by'))) {
          await db.sequelize.query(`ALTER TABLE sales_commissions ADD COLUMN approved_by INT NULL`);
          logger.info('Migrated: sales_commissions.approved_by added');
        }
        try {
          await db.sequelize.query(`ALTER TABLE sales_commissions MODIFY COLUMN status ENUM('pending','earned','approved','paid','void') NOT NULL DEFAULT 'earned'`);
          logger.info('Migrated: sales_commissions.status enum +approved');
        } catch (e) { logger.warn('Enum migrate status: ' + e.message); }
        const idxName = 'uniq_commission_registration';
        const [idx] = await db.sequelize.query(
          `SELECT COUNT(1) AS c FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'sales_commissions'
              AND index_name = '${idxName}'`
        );
        const exists = idx && idx[0] && Number(idx[0].c) > 0;
        if (!exists) {
          // Hapus duplikat (pertahankan id terkecil per registration_id non-null)
          await db.sequelize.query(
            `DELETE c1 FROM sales_commissions c1
               INNER JOIN sales_commissions c2
               ON c1.registration_id = c2.registration_id
              AND c1.registration_id IS NOT NULL
              AND c1.id > c2.id`
          ).catch(e => logger.warn('Dedup commissions skipped: ' + e.message));
          await db.sequelize.query(
            `ALTER TABLE sales_commissions
               ADD UNIQUE INDEX ${idxName} (registration_id)`
          );
          logger.info('Migrated: unique index on sales_commissions.registration_id');
        }
      } catch (idxErr) {
        logger.warn('Commission unique index skipped: ' + (idxErr.message || idxErr));
      }

      logger.info('Sales module migration OK');
    } catch (e) {
      logger.warn('Failed sales module migration: ' + (e.message || e));
    }

    // ═══════════════════════════════════════════════════════════════
    // Migrasi fitur Reseller Voucher lanjutan (#2,#4,#7,#10).
    // Buat tabel baru + tambah kolom baru. Aman diulang (idempotent).
    // ═══════════════════════════════════════════════════════════════
    try {
      const hasCol = async (table, col) => {
        const [rows] = await db.sequelize.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${col}'`
        );
        return rows && rows[0] && parseInt(rows[0].c) > 0;
      };

      // 1) Tabel baru (create if not exists). Bungkus per-model agar bila satu
      //    gagal (mis. index lama bermasalah), startup tetap jalan.
      const safeSync = async (model, label) => {
        if (!model) return;
        try { await model.sync(); }
        catch (e) { logger.warn(`Sync ${label} skipped: ` + e.message); }
      };
      await safeSync(db.ResellerPackagePrice,    'reseller_package_prices');
      await safeSync(db.ResellerVoucherLog,      'reseller_voucher_logs');
      await safeSync(db.ResellerPromo,           'reseller_promos');
      await safeSync(db.ResellerPromoRedemption, 'reseller_promo_redemptions');
      await safeSync(db.EmailLog,                'email_logs');
      await safeSync(db.ReportLog,               'report_logs');
      await safeSync(db.MonitorState,            'monitor_states');
      await safeSync(db.NotifLog,                'notif_logs');
      await safeSync(db.BotCommand,              'bot_commands');
      // Seed perintah bot bawaan (idempotent — hanya menambah yang belum ada).
      try { await require('./services/BotCommandSeed').seedDefaults(); }
      catch (e) { logger.warn('Seed bot_commands skipped: ' + e.message); }

      // 2) Kolom baru di resellers (#2 markup, #4 keagenan).
      if (!(await hasCol('resellers', 'parent_id'))) {
        await db.sequelize.query(`ALTER TABLE resellers ADD COLUMN parent_id INT NULL`);
        logger.info('Migrated: resellers.parent_id added');
      }
      if (!(await hasCol('resellers', 'commission_percent'))) {
        await db.sequelize.query(`ALTER TABLE resellers ADD COLUMN commission_percent DECIMAL(5,2) NOT NULL DEFAULT 0`);
        logger.info('Migrated: resellers.commission_percent added');
      }
      if (!(await hasCol('resellers', 'price_discount_percent'))) {
        await db.sequelize.query(`ALTER TABLE resellers ADD COLUMN price_discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0`);
        logger.info('Migrated: resellers.price_discount_percent added');
      }
      if (!(await hasCol('resellers', 'price_tier'))) {
        await db.sequelize.query(`ALTER TABLE resellers ADD COLUMN price_tier VARCHAR(20) NULL`);
        logger.info('Migrated: resellers.price_tier added');
      }

      // 3) Kolom promo di reseller_topups (#10).
      if (!(await hasCol('reseller_topups', 'promo_code'))) {
        await db.sequelize.query(`ALTER TABLE reseller_topups ADD COLUMN promo_code VARCHAR(40) NULL`);
        logger.info('Migrated: reseller_topups.promo_code added');
      }
      if (!(await hasCol('reseller_topups', 'promo_id'))) {
        await db.sequelize.query(`ALTER TABLE reseller_topups ADD COLUMN promo_id INT NULL`);
        logger.info('Migrated: reseller_topups.promo_id added');
      }
      if (!(await hasCol('reseller_topups', 'bonus_amount'))) {
        await db.sequelize.query(`ALTER TABLE reseller_topups ADD COLUMN bonus_amount DECIMAL(14,2) NOT NULL DEFAULT 0`);
        logger.info('Migrated: reseller_topups.bonus_amount added');
      }

      logger.info('Reseller voucher feature migration OK');
    } catch (e) {
      logger.warn('Failed reseller voucher migration: ' + (e.message || e));
    }

    // Start SNMP monitoring
    const snmpService = new SNMPService(io);
    SNMPService.setInstance(snmpService);
    snmpService.startAll();

    // Muat state monitoring Telegram yang dipersist (agar transisi down/up
    // tetap akurat setelah restart — tidak ada notif hilang/dobel).
    try { await require('./services/MonitoringService').init(); }
    catch (e) { logger.warn('MonitoringService.init gagal: ' + (e.message || e)); }

    // Bot Telegram 2-arah (long-polling). Hanya aktif bila telegram_bot_enabled=1.
    try { await require('./services/TelegramBotService').start(); }
    catch (e) { logger.warn('TelegramBotService.start gagal: ' + (e.message || e)); }

    // RADIUS server embedded (UDP 1812/1813) — opt-in, hanya start otomatis
    // kalau sebelumnya pernah diaktifkan admin lewat halaman RADIUS (persisted
    // di app_settings.radius_enabled). Idem seperti pola Telegram bot di atas.
    try {
      const radiusSetting = await db.AppSetting.findOne({ where: { key: 'radius_enabled' } });
      if (radiusSetting && radiusSetting.value === '1') {
        await require('./services/RadiusServer').start();
        logger.info('RADIUS server auto-started (radius_enabled=1)');
      }
    } catch (e) {
      logger.warn('RadiusServer auto-start gagal: ' + (e.message || e));
    }

    // WireGuard — kernel interface TIDAK bertahan lewat restart host/container,
    // jadi tiap boot kita re-apply semua interface yang statusnya aktif di DB
    // (best-effort; gagal kalau binary `wg` tidak ada, tidak menghentikan boot).
    try {
      if (db.WireguardServer) {
        const wgServers = await db.WireguardServer.findAll({ where: { is_active: true } });
        const WireGuardService = require('./services/WireGuardService');
        for (const s of wgServers) {
          const r = await WireGuardService.applyLive(s);
          logger.info(`WireGuard ${s.interface_name}: ${r.applied ? 're-applied' : 'skip (' + r.error + ')'}`);
        }
      }
    } catch (e) {
      logger.warn('WireGuard re-apply gagal: ' + (e.message || e));
    }

    // Pulihkan job bulk PPPoE yang terputus saat restart.
    // Worker hidup di memori proses, jadi job yang sedang jalan saat PM2
    // restart akan tertinggal di status 'running' selamanya kalau tidak
    // ditangani. Checkpoint per-item membuat resume aman: hanya item
    // berstatus 'pending' yang diproses, jadi tidak ada secret dobel.
    try {
      const PppoeBulk = require('./services/PppoeBulkProvisionService');
      const rec = await PppoeBulk.recoverStaleJobs({ autoResume: true, maxJobs: 3 });
      if (rec.found) {
        logger.info(`[PppoeBulk] recovery — ${rec.found} job tertinggal, ${rec.resumed} dilanjutkan, ${rec.closed} ditutup`);
      }
    } catch (e) {
      logger.warn('PppoeBulk recovery gagal: ' + (e.message || e));
    }

    // Start cron jobs
    CronService.start();

    // Start NOC Alerts Service — polling untuk Live Alerts di dashboard NOC.
    // In-memory state, retention 24 jam. Hilang saat pm2 restart (intended).
    const NocAlertsService = require('./services/NocAlertsService');
    NocAlertsService.start(io);

    // Restore WA sessions
    const WAService = require('./services/WAService');
    WAService.restoreAllSessions(io);

    // Start main HTTP server
    server.listen(PORT, () => {
      logger.info(`FLAYNET.COM CRM running on http://localhost:${PORT}`);
      console.log(`\n FLAYNET.COM CRM running on http://localhost:${PORT}\n`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down...');
      snmpService.stopAll();
      CronService.stop();
      try { require('./services/TelegramBotService').stop(); } catch (_) {}
      try { require('./services/RadiusServer').stop(); } catch (_) {}
      NocAlertsService.stop();
      await db.sequelize.close();
      server.close(() => process.exit(0));
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = { app, server, io };