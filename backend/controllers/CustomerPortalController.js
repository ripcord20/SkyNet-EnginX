/**
 * CustomerPortalController.js
 * Backend API untuk Customer Portal / Self-Service
 * Updated: profil update, tiket, payment gateway (Midtrans/Xendit)
 */

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios  = require('axios');
const crypto = require('crypto');
const { Customer, Package, Invoice, Payment, Ticket, TicketTimeline,
        QueueHistory, AppSetting, sequelize } = require('../models');
const { Op } = require('sequelize');
const genieacs = require('../services/GenieacsService');
const { getMikrotikInstance } = require('../services/MikrotikService');
const logger = require('../utils/logger');

// ── helper: ambil setting dari DB ─────────────────────────────
async function getSetting(key, fallback = null) {
  try {
    const s = await AppSetting.findOne({ where: { key } });
    return s ? s.value : fallback;
  } catch { return fallback; }
}

// ── LOGIN ─────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { customer_id, password } = req.body;
    if (!customer_id || !password)
      return res.status(400).json({ success: false, message: 'ID Pelanggan dan password wajib diisi' });

    const customer = await Customer.findOne({
      where: {
        [Op.or]: [{ customer_id }, { phone: customer_id }],
        portal_enabled: true
      },
      include: [{ model: Package, as: 'package' }]
    });
    if (!customer)
      return res.status(401).json({ success: false, message: 'ID Pelanggan tidak ditemukan' });

    let valid = false;
    if (customer.portal_password) {
      valid = await bcrypt.compare(password, customer.portal_password);
    } else {
      // Fallback login pertama: pakai nomor HP terdaftar sebagai password.
      // Hindari bypass bila phone kosong (cleanPhone==='' & cleanInput===''
      // akan cocok). Wajibkan nomor HP minimal beberapa digit.
      const cleanPhone = (customer.phone || '').replace(/[^0-9]/g, '');
      const cleanInput = (password || '').replace(/[^0-9]/g, '');
      if (cleanPhone.length >= 6) {
        valid = cleanPhone === cleanInput || password === customer.phone;
      }
    }
    if (!valid)
      return res.status(401).json({ success: false, message: 'Password salah' });
    if (customer.status === 'suspended')
      return res.status(403).json({ success: false, message: 'Akun Anda telah di-suspend. Hubungi ISP.' });

    await customer.update({ last_portal_login: new Date() });

    // Portal tokens sign with JWT_PORTAL_SECRET (falls back to JWT_SECRET for
    // zero-downtime migration; set JWT_PORTAL_SECRET in .env to activate
    // domain separation between admin and portal tokens).
    const portalSecret = process.env.JWT_PORTAL_SECRET || process.env.JWT_SECRET;
    const token = jwt.sign(
      { id: customer.id, customer_id: customer.customer_id, type: 'customer' },
      portalSecret,
      { expiresIn: '24h' }
    );
    // Cookie is set for defense-in-depth (server-side httpOnly), but the
    // portal frontend also relies on the token in the response body to send
    // it as an Authorization: Bearer header. The token is the same in both
    // places; removing it from the body would break existing frontend JS.
    // sameSite=lax (not strict) so navigation from /portal/login → /portal/dashboard
    // still carries the cookie.
    res.cookie('portal_token', token, {
      httpOnly: true,
      secure: !!req.secure,
      sameSite: 'lax',
      path: '/portal',
      maxAge: 86400000
    });

    res.json({
      success: true,
      token,
      customer: { id: customer.id, customer_id: customer.customer_id, name: customer.name,
                  status: customer.status, package_name: customer.package?.name || '—' }
    });
  } catch (e) {
    logger.error('Portal login error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── LOGOUT ────────────────────────────────────────────────────
// POST /portal/api/auth/logout
// Clear HttpOnly cookie portal_token. Frontend tetap clear localStorage
// sendiri. Endpoint dibuat terpisah dari admin logout karena pakai cookie
// terpisah (portal_token) dengan path=/portal yang berbeda options.
exports.logout = async (req, res) => {
  try {
    // PENTING: clearCookie HARUS pakai opsi (httpOnly, sameSite, secure,
    // path) yang SAMA persis dengan saat cookie di-set di login. Kalau
    // beda, browser tidak akan recognize cookie yang di-clear sebagai
    // cookie yang sama → cookie tetap ada → route /portal/login akan
    // auto-redirect kembali ke dashboard (lihat patch session-persist).
    res.clearCookie('portal_token', {
      httpOnly: true,
      secure: !!req.secure,
      sameSite: 'lax',
      path: '/portal'
    });
    res.json({ success: true, message: 'Logged out' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
};

// ── RESTORE COOKIE ────────────────────────────────────────────
// POST /portal/api/auth/restore-cookie
// Pattern sama dengan AuthController.restoreCookie untuk admin — restore
// HttpOnly cookie dari Bearer token. Dipakai halaman /portal/login untuk
// auto-login kalau localStorage `portal_token` masih ada tapi cookie sudah
// expired/hilang.
exports.restoreCookie = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Bearer token required' });
    }
    const token = authHeader.substring(7);
    const portalSecret = process.env.JWT_PORTAL_SECRET || process.env.JWT_SECRET;
    const decoded = jwt.verify(token, portalSecret);
    if (decoded.type !== 'customer') {
      return res.status(401).json({ success: false, message: 'Invalid token type' });
    }
    const customer = await Customer.findByPk(decoded.id);
    if (!customer || !customer.portal_enabled) {
      return res.status(401).json({ success: false, message: 'Account disabled' });
    }
    if (customer.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Akun di-suspend' });
    }
    res.cookie('portal_token', token, {
      httpOnly: true,
      secure: !!req.secure,
      sameSite: 'lax',
      path: '/portal',
      maxAge: 86400000
    });
    return res.json({ success: true, redirect: '/portal/dashboard' });
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }
};

// ── CHANGE PASSWORD ───────────────────────────────────────────
exports.changePassword = async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!new_password || new_password.length < 6)
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter' });
    const customer = await Customer.findByPk(req.portalUser.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    if (customer.portal_password) {
      const valid = await bcrypt.compare(old_password, customer.portal_password);
      if (!valid) return res.status(400).json({ success: false, message: 'Password lama salah' });
    }
    const hashed = await bcrypt.hash(new_password, 10);
    await customer.update({ portal_password: hashed });
    res.json({ success: true, message: 'Password berhasil diubah' });
  } catch (e) {
    logger.error('Portal change password error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── UPDATE PROFIL ─────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.portalUser.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    const allowed = ['email', 'phone', 'address'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (!Object.keys(updates).length)
      return res.status(400).json({ success: false, message: 'Tidak ada data yang diubah' });
    await customer.update(updates);
    res.json({ success: true, message: 'Profil berhasil diperbarui' });
  } catch (e) {
    logger.error('Portal update profile error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUBLIC META (untuk halaman login, tidak butuh auth) ──────
exports.publicMeta = async (req, res) => {
  try {
    const [
      companyName, appName, tagline,
      heroImage, heroOverlay, welcomeTitle, welcomeSub,
      companyWa, logoUrl, logoMode, termsUrl, termsLabel
    ] = await Promise.all([
      getSetting('company_name', 'ISP'),
      getSetting('app_name', ''),
      getSetting('app_tagline', 'Akses layanan internet Anda'),
      getSetting('portal_hero_image', ''),
      getSetting('portal_hero_overlay', '0.55'),
      getSetting('portal_welcome_title', 'Welcome Back'),
      getSetting('portal_welcome_sub', 'Masukkan detail akun Anda'),
      getSetting('company_whatsapp', ''),
      getSetting('logo_url', ''),
      getSetting('portal_logo_mode', 'inline'),
      getSetting('portal_terms_url', ''),
      getSetting('portal_terms_label', 'Syarat & Ketentuan'),
    ]);
    res.json({
      success: true,
      data: {
        brand_name: appName || companyName + ' Portal',
        company_name: companyName,
        tagline,
        hero_image: heroImage,
        hero_overlay: parseFloat(heroOverlay) || 0.55,
        welcome_title: welcomeTitle,
        welcome_sub: welcomeSub,
        company_whatsapp: (companyWa || '').replace(/[^0-9]/g, ''),
        logo_url: logoUrl,
        logo_mode: logoMode || 'inline',
        terms_url: (termsUrl || '').trim(),
        terms_label: (termsLabel || '').trim() || 'Syarat & Ketentuan',
      }
    });
  } catch (e) {
    logger.error('Portal publicMeta error:', e);
    res.json({
      success: true,
      data: {
        brand_name: 'Customer Portal',
        tagline: 'Akses layanan internet Anda',
        hero_image: '', hero_overlay: 0.55,
        welcome_title: 'Welcome Back', welcome_sub: 'Masukkan detail akun Anda',
        company_whatsapp: '', logo_url: ''
      }
    });
  }
};

// ── DASHBOARD DATA ────────────────────────────────────────────
exports.dashboard = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.portalUser.id, {
      include: [{ model: Package, as: 'package' }]
    });
    if (!customer) return res.status(404).json({ success: false });

    const invoices = await Invoice.findAll({
      where: { customer_id: customer.id, status: { [Op.in]: ['unpaid', 'overdue'] } },
      order: [['due_date', 'ASC']],
      limit: 5
    });
    const payments = await sequelize.query(
      `SELECT p.id, p.amount, p.payment_method, p.payment_date, p.reference_number, p.notes,
              i.period_month, i.period_year
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.customer_id = :cid ORDER BY p.payment_date DESC LIMIT 10`,
      { replacements: { cid: customer.id }, type: sequelize.QueryTypes.SELECT }
    );
    const [totalUnpaid] = await sequelize.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE customer_id = :cid AND status IN ('unpaid','overdue')`,
      { replacements: { cid: customer.id }, type: sequelize.QueryTypes.SELECT }
    );
    const openTickets = await Ticket.count({
      where: { customer_id: customer.id, status: { [Op.in]: ['open','in_progress','pending'] } }
    });

    const gwEnabled   = await getSetting('payment_gateway_enabled', 'false');
    const gwProvider  = await getSetting('payment_gateway_provider', 'midtrans');
    const gwClientKey = await getSetting('payment_gateway_client_key', '');
    const companyName = await getSetting('company_name', 'ISP');
    const companyWa   = await getSetting('company_whatsapp', '');

    // Parse payment_accounts (stored as JSON string di AppSetting)
    const paymentAccountsRaw = await getSetting('payment_accounts', '[]');
    let paymentAccounts = [];
    try {
      const parsed = JSON.parse(paymentAccountsRaw || '[]');
      if (Array.isArray(parsed)) {
        // Kirim ke client hanya yang aktif
        paymentAccounts = parsed.filter(a => a && a.is_active !== false);
      }
    } catch { paymentAccounts = []; }

    res.json({
      success: true,
      data: {
        customer: {
          id: customer.id, customer_id: customer.customer_id, name: customer.name,
          address: customer.address, phone: customer.phone, email: customer.email,
          status: customer.status, isolir_status: customer.isolir_status,
          installation_date: customer.installation_date, pppoe_username: customer.pppoe_username,
          ont_sn: customer.ont_sn, static_ip: customer.static_ip,
          billing_date: customer.billing_date, due_date: customer.due_date,
          package_id: customer.package_id
        },
        package: customer.package ? {
          name: customer.package.name, speed_down: customer.package.speed_down,
          speed_up: customer.package.speed_up, price: customer.package.price,
          description: customer.package.description
        } : null,
        invoices, payments,
        total_unpaid: parseFloat(totalUnpaid.total || 0),
        open_tickets: openTickets,
        meta: {
          gateway_enabled: gwEnabled === 'true' || gwEnabled === '1',
          gateway_provider: gwProvider,
          gateway_client_key: gwClientKey,
          company_name: companyName,
          company_wa: companyWa,
          payment_accounts: paymentAccounts
        }
      }
    });
  } catch (e) {
    logger.error('Portal dashboard error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── TRAFFIC USAGE ─────────────────────────────────────────────
exports.traffic = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.portalUser.id, {
      include: [{ model: Package, as: 'package' }]
    });
    if (!customer)
      return res.json({ success: true, data: { history: [], current: null, queueName: null } });

    const range   = req.query.range || '1m';
    const pppoe   = customer.pppoe_username || '';
    const ip      = customer.static_ip || '';
    const Seq     = require('sequelize');
    const { literal, fn, col } = Seq;
    const moment  = require('moment');
    const rangeMap = {
      live: { minutes: 10,   interval: 60    },
      '1m': { minutes: 30,   interval: 60    },
      '1h': { minutes: 60,   interval: 60    },
      '3h': { minutes: 180,  interval: 300   },
      '24h':{ minutes: 1440, interval: 900   },
      '1d': { minutes: 1440, interval: 900   },
      '3d': { minutes: 4320, interval: 3600  },
      '30d':{ minutes: 43200,interval: 43200 },
    };
    const cfg       = rangeMap[range] || rangeMap['1m'];
    const startTime = moment().subtract(cfg.minutes, 'minutes').toDate();
    const bucketSec = cfg.interval;

    let queueName = null, current = null, mkDebug = { tried: false, queueCount: 0, error: null };
    try {
      mkDebug.tried = true;
      const mk = getMikrotikInstance();
      if (mk) {
        const queues = await mk.getQueues();
        mkDebug.queueCount = queues.length;
        const queueByTarget = {}, queueByName = {};
        queues.forEach(q => {
          (q.target || '').split(',').map(t => t.trim().split('/')[0])
            .forEach(tip => { if (tip) queueByTarget[tip] = q; });
          if (q.name) queueByName[q.name.toLowerCase()] = q;
        });
        let matched = null;
        if (ip && queueByTarget[ip]) matched = queueByTarget[ip];
        else if (pppoe && queueByName[pppoe.toLowerCase()]) matched = queueByName[pppoe.toLowerCase()];
        else if (pppoe) matched = queues.find(q =>
          (q.comment && q.comment.toLowerCase().includes(pppoe.toLowerCase())) ||
          (q.name && q.name.toLowerCase().includes(pppoe.toLowerCase()))
        ) || null;
        if (matched) {
          queueName = matched.name;
          const parseK = v => {
            v = v || '0';
            if (v.endsWith('M')) return parseFloat(v) * 1000000;
            if (v.endsWith('k') || v.endsWith('K')) return parseFloat(v) * 1000;
            return parseFloat(v) || 0;
          };
          const maxParts = (matched.maxLimit || '0/0').split('/');
          current = {
            name: matched.name,
            rateDown: parseInt(matched.rateIn || 0), rateUp: parseInt(matched.rateOut || 0),
            bytesDown: parseInt(matched.bytesIn || 0), bytesUp: parseInt(matched.bytesOut || 0),
            maxDown: parseK(maxParts[1] || maxParts[0]), maxUp: parseK(maxParts[0]),
          };
        }
      } else { mkDebug.error = 'MikroTik instance not available'; }
    } catch (e) { mkDebug.error = e.message; logger.error('Portal traffic MikroTik error:', e.message); }

    // ── Fallback: cari queueName dari queue_history jika MikroTik tidak available ──
    if (!queueName) {
      // Prioritas 1: match by target IP (paling akurat)
      // queue_history.target format: "192.168.1.10/32" atau "192.168.1.10"
      if (ip) {
        const [found] = await sequelize.query(
          `SELECT DISTINCT queue_name FROM queue_history
           WHERE (target = :ip OR target = :ipCidr OR target LIKE :ipLike)
             AND recorded_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
           ORDER BY recorded_at DESC LIMIT 1`,
          {
            replacements: { ip, ipCidr: ip + '/32', ipLike: ip + '%' },
            type: Seq.QueryTypes.SELECT
          }
        );
        if (found) queueName = found.queue_name;
      }

      // Prioritas 2: match by pppoe_username (exact atau LIKE)
      if (!queueName && pppoe) {
        const [found] = await sequelize.query(
          `SELECT DISTINCT queue_name FROM queue_history
           WHERE queue_name = :exact OR queue_name LIKE :like
           ORDER BY recorded_at DESC LIMIT 1`,
          { replacements: { exact: pppoe, like: '%' + pppoe + '%' }, type: Seq.QueryTypes.SELECT }
        );
        if (found) queueName = found.queue_name;
      }

      // Prioritas 3: match by nama customer (jika queue name mengandung nama)
      if (!queueName && customer.name) {
        const parts = customer.name.trim().split(/\s+/).filter(p => p.length > 3);
        for (const part of parts) {
          const [found] = await sequelize.query(
            `SELECT DISTINCT queue_name FROM queue_history
             WHERE queue_name LIKE :like
             ORDER BY recorded_at DESC LIMIT 1`,
            { replacements: { like: '%' + part + '%' }, type: Seq.QueryTypes.SELECT }
          );
          if (found) { queueName = found.queue_name; break; }
        }
      }
    }

    if (!queueName) {
      return res.json({
        success: true,
        data: { history: [], current, queueName: null },
        meta: {
          debug: {
            message: 'Queue tidak ditemukan. Pastikan static_ip atau pppoe_username di data pelanggan sesuai dengan target/nama queue di MikroTik.',
            customer_pppoe: pppoe || '(kosong)',
            customer_name: customer.name,
            customer_ip: ip || '(kosong)',
            mikrotik: mkDebug
          }
        }
      });
    }

    // Query sama persis seperti QueueHistoryController yang sudah terbukti jalan
    const rows = await QueueHistory.findAll({
      where: { queue_name: queueName, recorded_at: { [Op.gte]: startTime } },
      attributes: [
        [literal(`FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / ${bucketSec}) * ${bucketSec})`), 'bucket'],
        [fn('AVG', col('rx_rate')), 'avg_rx'],
        [fn('AVG', col('tx_rate')), 'avg_tx'],
        [fn('MAX', col('rx_rate')), 'max_rx'],
        [fn('MAX', col('tx_rate')), 'max_tx'],
        [fn('MAX', col('rx_bytes')), 'rx_bytes_end'],
        [fn('MIN', col('rx_bytes')), 'rx_bytes_start'],
        [fn('MAX', col('tx_bytes')), 'tx_bytes_end'],
        [fn('MIN', col('tx_bytes')), 'tx_bytes_start'],
        [fn('COUNT', col('id')), 'cnt']
      ],
      group: [literal(`FLOOR(UNIX_TIMESTAMP(recorded_at) / ${bucketSec})`)],
      order: [[literal('bucket'), 'ASC']],
      raw: true
    });

    const history = rows.map(r => ({
      time:        r.bucket,
      rx_mbps:     parseFloat(((r.avg_rx || 0) / 1e6).toFixed(3)),
      tx_mbps:     parseFloat(((r.avg_tx || 0) / 1e6).toFixed(3)),
      max_rx_mbps: parseFloat(((r.max_rx || 0) / 1e6).toFixed(3)),
      max_tx_mbps: parseFloat(((r.max_tx || 0) / 1e6).toFixed(3)),
    }));

    // Hitung total bytes: MAX(rx_bytes) - MIN(rx_bytes) dari seluruh range sekaligus
    // rx_bytes adalah cumulative counter — cukup ambil nilai tertinggi dikurangi terendah
    const [totals] = await sequelize.query(
      `SELECT
         MAX(rx_bytes) - MIN(rx_bytes) AS total_rx,
         MAX(tx_bytes) - MIN(tx_bytes) AS total_tx
       FROM queue_history
       WHERE queue_name = :qname AND recorded_at >= :start`,
      { replacements: { qname: queueName, start: startTime }, type: Seq.QueryTypes.SELECT }
    );
    const totalRxBytes = Math.max(0, parseInt(totals?.total_rx || 0));
    const totalTxBytes = Math.max(0, parseInt(totals?.total_tx || 0));

    // Utilization % terhadap max speed paket
    const pkg = customer.package;
    const maxDownBps = pkg ? (pkg.speed_down || 0) * 1e6 : 0; // speed_down dalam Mbps
    const maxUpBps   = pkg ? (pkg.speed_up   || 0) * 1e6 : 0;
    const avgRx = rows.length ? rows.reduce((s,r) => s + parseFloat(r.avg_rx||0), 0) / rows.length : 0;
    const avgTx = rows.length ? rows.reduce((s,r) => s + parseFloat(r.avg_tx||0), 0) / rows.length : 0;
    const utilDown = maxDownBps > 0 ? Math.min(100, Math.round((avgRx / maxDownBps) * 100)) : 0;
    const utilUp   = maxUpBps   > 0 ? Math.min(100, Math.round((avgTx / maxUpBps)   * 100)) : 0;

    // Jika current dari MikroTik tidak tersedia, fallback dari history terakhir
    if (!current && rows.length) {
      const last = rows[rows.length - 1];
      current = {
        rateDown: Math.round(parseFloat(last.avg_rx || 0)),
        rateUp:   Math.round(parseFloat(last.avg_tx || 0)),
        bytesDown: totalRxBytes,
        bytesUp:   totalTxBytes,
        maxDown: maxDownBps,
        maxUp:   maxUpBps,
      };
    }

    res.json({
      success: true,
      data: { history, current, queueName },
      usage: {
        total_rx_bytes: totalRxBytes,
        total_tx_bytes: totalTxBytes,
        util_down: utilDown,
        util_up:   utilUp,
        max_down:  maxDownBps,
        max_up:    maxUpBps,
        range_label: cfg.label || range
      },
      meta: {
        range, points: history.length,
        debug: {
          customer_pppoe: pppoe || null,
          customer_ip: ip || null,
          queue_matched: queueName,
          mikrotik: mkDebug
        }
      }
    });
  } catch (e) {
    logger.error('Portal traffic error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Cache device lookup (TTL 5 menit) ───────────────────────
const _deviceCache = new Map();
const DEVICE_CACHE_TTL = 5 * 60 * 1000;

/**
 * Konversi SN antara format ASCII Huawei (mis. "HWTCB9DDBD9F") dan
 * format hex 16-char yang disimpan GenieACS NBI (mis. "48575443B9DDBD9F").
 * Mengembalikan semua varian yang masuk akal untuk dicari.
 *
 * Catatan: konversi hanya dilakukan untuk Huawei (prefix HWTC). Vendor
 * lain (ZTE, FiberHome, dst) tidak menyimpan SN dalam format hex-encoded
 * di GenieACS, jadi tidak perlu varian.
 */
function _snVariants(snNorm) {
  const variants = new Set();
  if (!snNorm) return [];
  variants.add(snNorm);
  // Kasus 1: SN ASCII Huawei "HWTC" + 8 char hex → tambah varian hex penuh
  const m = snNorm.match(/^(HWTC)([0-9A-F]{8})$/i);
  if (m) {
    let hexPrefix = '';
    for (const ch of m[1]) hexPrefix += ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    variants.add((hexPrefix + m[2]).toUpperCase());
  }
  // Kasus 2: SN hex 16 char → coba decode prefix HWTC
  if (/^[0-9A-F]{16}$/i.test(snNorm)) {
    const prefixHex = snNorm.substring(0, 8).toUpperCase();
    if (prefixHex === '48575443') { // "HWTC" dalam hex
      variants.add('HWTC' + snNorm.substring(8).toUpperCase());
    }
  }
  return [...variants];
}

async function findDeviceBySN(sn) {
  if (!sn) return null;
  const snRaw   = sn.trim();
  const snNorm  = snRaw.replace(/[\s\-:]/g, '').toUpperCase();
  const snLower = snNorm.toLowerCase();

  // Cek cache dulu — hindari repeated query ke GenieACS
  const cached = _deviceCache.get(snNorm);
  if (cached && (Date.now() - cached.ts) < DEVICE_CACHE_TTL) {
    return cached.device;
  }

  // Generate semua varian SN (ASCII ↔ hex) untuk match Huawei dsb.
  const variants = _snVariants(snNorm);

  // Semua query jalan PARALEL sekaligus — ambil hasil pertama yang ada
  const queries = [
    genieacs.getDevices({ 'DeviceID.SerialNumber': snRaw }),
    genieacs.getDevices({ '_deviceId.SerialNumber': snRaw }),
    genieacs.getDevices({ '_id': { '$regex': snNorm } }),
  ];
  if (snNorm !== snRaw.toUpperCase()) {
    queries.push(genieacs.getDevices({ 'DeviceID.SerialNumber': snNorm }));
  }
  // Tambahkan query untuk varian hex / ASCII (Huawei)
  for (const v of variants) {
    if (v === snNorm) continue;
    queries.push(genieacs.getDevices({ '_deviceId.SerialNumber': v }));
    queries.push(genieacs.getDevices({ '_id': { '$regex': v } }));
  }

  const results = await Promise.all(queries);
  for (const result of results) {
    const devices = result?.data || [];
    if (devices.length) {
      _deviceCache.set(snNorm, { device: devices[0], ts: Date.now() });
      return devices[0];
    }
  }

  // Fallback: fetch all + filter manual
  const allResult  = await genieacs.getDevices({});
  const allDevices = allResult?.data || [];
  if (allDevices.length) {
    const variantSet = new Set(variants);
    const found = allDevices.find(d => {
      const rawId  = d['_id'] || '';
      const decoded = decodeURIComponent(rawId);
      const idSN   = decoded.split('-').slice(2).join('').toUpperCase();
      const devSN  = (d['DeviceID.SerialNumber']?._value || '').replace(/[\s\-:]/g, '').toUpperCase();
      const didSN  = (d['_deviceId']?.SerialNumber || '').replace(/[\s\-:]/g, '').toUpperCase();
      // Cek juga decoded ASCII version dari idSN/devSN/didSN agar SN ASCII di DB
      // tetap match dengan device hex di GenieACS.
      return rawId.toLowerCase().includes(snLower)
        || variantSet.has(idSN) || variantSet.has(devSN) || variantSet.has(didSN);
    });
    if (found) {
      _deviceCache.set(snNorm, { device: found, ts: Date.now() });
      return found;
    }
  }

  return null;
}

function invalidateDeviceCache(sn) {
  if (!sn) return;
  _deviceCache.delete(sn.trim().replace(/[\s\-:]/g, '').toUpperCase());
}

// ── ONT SIGNAL ────────────────────────────────────────────────
exports.signal = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.portalUser.id);
    if (!customer || !customer.ont_sn) return res.json({ success: true, data: null });
    const device = await findDeviceBySN(customer.ont_sn);
    if (!device)
      return res.json({ success: true, data: null, message: 'ONT tidak ditemukan' });
    const signal = genieacs.extractSignalInfo(device);
    res.json({ success: true, data: {
      device_id: device['_id'] || '', serial: customer.ont_sn,
      model: device['DeviceID.ProductClass']?._value || '—',
      manufacturer: device['DeviceID.Manufacturer']?._value || '—',
      uptime: signal.uptime_str || '—', rx_power: signal.rx_power || null,
      tx_power: signal.tx_power || null, temperature: signal.temperature || null,
      wan_ip: signal.wan_ip || null, online: !!device['_lastInform']
    }});
  } catch (e) {
    logger.error('Portal signal error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── REBOOT ONT ────────────────────────────────────────────────
exports.reboot = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.portalUser.id);
    if (!customer || !customer.ont_sn)
      return res.status(400).json({ success: false, message: 'ONT tidak terdaftar' });

    const device = await findDeviceBySN(customer.ont_sn);
    if (!device)
      return res.status(404).json({ success: false, message: 'ONT tidak ditemukan di sistem' });

    const deviceId = device['_id'];
    const result   = await genieacs.rebootDevice(deviceId);

    if (result && result.success === false) {
      logger.error('Portal reboot task error:', result.error);
      return res.status(500).json({
        success: false,
        message: 'Gagal membuat task reboot: ' + (typeof result.error === 'string' ? result.error : JSON.stringify(result.error))
      });
    }

    res.json({ success: true, message: 'Perintah reboot telah dikirim. ONT akan restart dalam beberapa detik.' });
    // Invalidate cache agar status terbaru dimuat setelah reboot
    invalidateDeviceCache(customer.ont_sn);
  } catch (e) {
    logger.error('Portal reboot error:', e);
    res.status(500).json({ success: false, message: 'Gagal reboot: ' + e.message });
  }
};

// ── BILLING HISTORY ───────────────────────────────────────────
exports.billing = async (req, res) => {
  try {
    const invoices = await Invoice.findAll({
      where: { customer_id: req.portalUser.id },
      order: [['period_year','DESC'],['period_month','DESC']],
      limit: 24
    });
    const payments = await sequelize.query(
      `SELECT p.id, p.amount, p.payment_method, p.payment_date, p.reference_number, p.notes,
              i.period_month, i.period_year, i.invoice_number
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.customer_id = :cid ORDER BY p.payment_date DESC LIMIT 24`,
      { replacements: { cid: req.portalUser.id }, type: sequelize.QueryTypes.SELECT }
    );
    res.json({ success: true, data: { invoices, payments } });
  } catch (e) {
    logger.error('Portal billing error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── TIKET: LIST ───────────────────────────────────────────────
exports.ticketList = async (req, res) => {
  try {
    const tickets = await Ticket.findAll({
      where: { customer_id: req.portalUser.id },
      order: [['created_at','DESC']],
      limit: 20,
      attributes: ['id','ticket_number','type','priority','status',
                   'title','description','created_at','updated_at','resolved_at','due_at']
    });
    res.json({ success: true, data: tickets });
  } catch (e) {
    logger.error('Portal ticket list error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── TIKET: SUBMIT ─────────────────────────────────────────────
exports.ticketCreate = async (req, res) => {
  try {
    const { title, description, type } = req.body;
    if (!title || !title.trim())
      return res.status(400).json({ success: false, message: 'Judul tiket wajib diisi' });
    const validTypes = ['gangguan','request','maintenance'];
    const ticketType = validTypes.includes(type) ? type : 'gangguan';
    // Anti-spam: max 3 tiket open dalam 1 jam
    const recentOpen = await Ticket.count({
      where: {
        customer_id: req.portalUser.id,
        status: { [Op.in]: ['open','in_progress'] },
        type: ticketType,
        created_at: { [Op.gte]: new Date(Date.now() - 3600000) }
      }
    });
    if (recentOpen >= 3)
      return res.status(429).json({ success: false, message: 'Terlalu banyak tiket. Tunggu beberapa saat.' });

    const ticket = await Ticket.create({
      title: title.trim().substring(0, 255),
      description: (description || '').trim(),
      type: ticketType, priority: 'medium', status: 'open',
      customer_id: req.portalUser.id, created_by: null, sla_hours: 24
    });

    // Notifikasi Telegram (event bisnis) — disubmit oleh pelanggan via portal.
    try {
      const c = await Customer.findByPk(req.portalUser.id, { attributes: ['name', 'customer_id'] });
      require('../services/TelegramEvents').newTicket({
        ticketNo: ticket.ticket_number,
        ticketId: ticket.id,
        subject: ticket.title,
        type: ticket.type,
        status: ticket.status,
        priority: ticket.priority,
        slaHours: ticket.sla_hours,
        dueAt: ticket.due_at,
        customerName: c?.name || null,
        customerCode: c?.customer_id || null,
        createdBy: (c?.name ? `${c.name} (Pelanggan via Portal)` : 'Pelanggan via Portal'),
        description: ticket.description,
        createdAt: ticket.created_at || ticket.createdAt,
      }).catch(() => {});
    } catch (_) {}

    res.status(201).json({
      success: true, message: 'Tiket berhasil dibuat',
      data: { id: ticket.id, ticket_number: ticket.ticket_number }
    });
  } catch (e) {
    logger.error('Portal ticket create error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PAYMENT GATEWAY: Create Transaction ──────────────────────
// body: { invoice_id, mode? }
//   mode='manual'  → return wa_url (konfirmasi via WA)
//   mode='gateway' → return snap_token (Midtrans) atau invoice_url (Xendit)
//   mode tidak diisi → fallback: kalau gateway aktif pakai gateway, kalau tidak pakai manual
// ── PAYMENT GATEWAY: Tripay daftar channel pembayaran ────────
// Closed Transaction Tripay WAJIB parameter `method` (mis. BRIVA, QRIS).
// Tanpa method, Tripay menolak dgn "Undefined parameter method".
// Endpoint ini dipakai portal utk menampilkan pilihan channel ke customer,
// lalu method terpilih dikirim balik ke /api/pay sebagai tripay_method.
exports.tripayChannels = async (req, res) => {
  try {
    const gwProvider = await getSetting('payment_gateway_provider', 'midtrans');
    if (gwProvider !== 'tripay') {
      return res.status(400).json({ success: false, message: 'Provider aktif bukan Tripay' });
    }
    const apiKey = await getSetting('payment_gateway_server_key', '');
    if (!apiKey || apiKey.length < 16) {
      return res.status(400).json({ success: false, message: 'API Key Tripay belum diisi. Cek Pengaturan → Payment Gateway.' });
    }
    const isProd  = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const apiBase = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';

    let r;
    try {
      r = await axios.get(`${apiBase}/merchant/payment-channel`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 12000,
        validateStatus: s => s < 500
      });
    } catch (e) {
      logger.error('Tripay channels error: ' + (e.message || e));
      return res.status(502).json({ success: false, message: 'Gagal menghubungi Tripay' });
    }

    if (r.status === 401 || (r.data && r.data.success === false)) {
      const msg = (r.data && r.data.message) || 'API Key ditolak';
      return res.status(400).json({ success: false, message: `Tripay: ${msg}` });
    }

    const list = Array.isArray(r.data && r.data.data) ? r.data.data : [];
    // Hanya channel aktif; bentuk ringkas utk UI.
    const channels = list
      .filter(c => c.active !== false)
      .map(c => ({
        code:  c.code,
        name:  c.name,
        group: c.group || '',
        icon:  c.icon_url || '',
        fee_flat:    (c.total_fee && Number(c.total_fee.flat))    || 0,
        fee_percent: (c.total_fee && c.total_fee.percent != null) ? c.total_fee.percent : '0'
      }));

    return res.json({
      success: true,
      env: isProd ? 'production' : 'sandbox',
      channels
    });
  } catch (e) {
    logger.error('tripayChannels error: ' + (e.message || e));
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.createPayment = async (req, res) => {
  try {
    const { invoice_id } = req.body;
    const reqMode = (req.body.mode || '').toLowerCase();
    if (!invoice_id)
      return res.status(400).json({ success: false, message: 'invoice_id wajib diisi' });

    const invoice = await Invoice.findOne({
      where: { id: invoice_id, customer_id: req.portalUser.id, status: { [Op.in]: ['unpaid','overdue'] } }
    });
    if (!invoice)
      return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan atau sudah lunas' });

    const customer = await Customer.findByPk(req.portalUser.id, {
      include: [{ model: Package, as: 'package' }]
    });

    const gwEnabled    = await getSetting('payment_gateway_enabled', 'false');
    const gwActive     = (gwEnabled === 'true' || gwEnabled === '1');
    const gwProvider   = await getSetting('payment_gateway_provider', 'midtrans');
    const gwKey        = await getSetting('payment_gateway_server_key', '');
    const gwClientKey  = await getSetting('payment_gateway_client_key', '');
    const companyName  = await getSetting('company_name', 'ISP');
    const companyWa    = await getSetting('company_whatsapp', '');

    // Tentukan mode efektif
    let mode = reqMode;
    if (!mode) mode = gwActive ? 'gateway' : 'manual';
    if (mode === 'gateway' && !gwActive) mode = 'manual'; // safety: gateway diminta tapi off

    // ── Mode Manual (WA confirm) ──────────────────────────────
    if (mode === 'manual') {
      const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni',
                          'Juli','Agustus','September','Oktober','November','Desember'];
      const periodeStr = `${monthNames[invoice.period_month] || invoice.period_month} ${invoice.period_year}`;

      const waMsg = encodeURIComponent(
        `*Konfirmasi Pembayaran*\n\n` +
        `Halo ${companyName},\n` +
        `Saya sudah transfer untuk tagihan internet berikut:\n\n` +
        `👤 Nama        : ${customer.name}\n` +
        `🆔 ID Pelanggan : ${customer.customer_id}\n` +
        `📄 No Invoice   : ${invoice.invoice_number}\n` +
        `📅 Periode      : ${periodeStr}\n` +
        `💰 Jumlah       : Rp ${parseFloat(invoice.total).toLocaleString('id-ID')}\n\n` +
        `Mohon verifikasi pembayarannya. Terima kasih 🙏`
      );
      const waUrl = companyWa
        ? `https://wa.me/${companyWa.replace(/[^0-9]/g, '')}?text=${waMsg}` : null;

      if (!waUrl) {
        return res.json({
          success: false,
          message: 'Nomor WhatsApp CS belum disetel. Hubungi admin.'
        });
      }

      return res.json({
        success: true,
        mode: 'manual',
        wa_url: waUrl,
        message: 'Buka WhatsApp untuk konfirmasi'
      });
    }

    // ── Mode Gateway ─────────────────────────────────────────
    if (!gwKey) {
      logger.warn(`Portal pay: gateway enabled but server_key kosong (customer ${customer.customer_id})`);
      return res.status(400).json({
        success: false,
        message: 'Pembayaran online belum aktif. Admin perlu mengisi Server Key di Pengaturan → Payment Gateway. Silakan gunakan Transfer Manual.'
      });
    }

    // Helper: sanitize customer details supaya lolos validasi Midtrans/Xendit
    // Midtrans reject empty email, phone tanpa digit, atau format invalid
    const sanitizedCustomer = (function() {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const rawEmail = (customer.email || '').trim();
      const cleanEmail = emailRe.test(rawEmail)
        ? rawEmail
        : `customer-${customer.id}@noreply.digsnet.local`;

      const rawPhone = (customer.phone || '').replace(/[^\d+]/g, '');
      const cleanPhone = rawPhone.length >= 8 ? rawPhone : '';

      // Split name jadi first + last (Midtrans max 20 char per field)
      const fullName = (customer.name || 'Customer').trim().slice(0, 40);
      const parts = fullName.split(/\s+/);
      const firstName = (parts[0] || 'Customer').slice(0, 20);
      const lastName  = parts.slice(1).join(' ').slice(0, 20);

      return { firstName, lastName, email: cleanEmail, phone: cleanPhone };
    })();

    // Midtrans Snap
    if (gwProvider === 'midtrans') {
      // Validasi format key Midtrans — terima prefix "Mid-server-" atau "SB-Mid-server-"
      // Catatan: Midtrans sandbox dashboard kadang menampilkan key tanpa prefix "SB-".
      // Environment ditentukan oleh URL endpoint (sandbox/prod), bukan prefix key.
      const isProd   = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
      const keyValid = /^(SB-)?Mid-server-/.test(gwKey);
      if (!keyValid) {
        logger.warn(`Portal pay: server_key Midtrans format tidak sesuai (prefix=${gwKey.slice(0,15)}...)`);
        return res.status(400).json({
          success: false,
          message: 'Server Key Midtrans tidak valid. Harus dimulai dengan "Mid-server-" atau "SB-Mid-server-". Cek Pengaturan → Payment Gateway.'
        });
      }

      const orderId  = `INV-${invoice.id}-${Date.now()}`;
      const snapUrl  = isProd
        ? 'https://app.midtrans.com/snap/v1/transactions'
        : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
      const baseUrl  = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

      // Hitung breakdown untuk item_details. Midtrans MEWAJIBKAN sum(item_details.price * qty) === gross_amount.
      // Kalau ada PPN, kita kirim 2 line item: paket internet + PPN, agar customer lihat breakdown jelas
      // di halaman Snap.
      const invSubtotal = Math.round(parseFloat(invoice.amount || invoice.total));
      const invTax      = Math.round(parseFloat(invoice.tax || 0));
      const invTotal    = Math.round(parseFloat(invoice.total));
      const taxLabel    = (await getSetting('tax_label', 'PPN')) || 'PPN';
      const taxRateStr  = await getSetting('tax_rate', '');
      const taxRateNum  = parseFloat(taxRateStr);
      const taxLabelFull = invTax > 0
        ? (taxLabel + (Number.isFinite(taxRateNum) && taxRateNum > 0
            ? ' ' + (Number.isInteger(taxRateNum) ? taxRateNum : taxRateNum.toFixed(1)) + '%'
            : ''))
        : taxLabel;

      const itemDetails = [{
        id: `invoice-${invoice.id}`,
        price: invTax > 0 ? invSubtotal : invTotal,
        quantity: 1,
        name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`
      }];
      if (invTax > 0) {
        itemDetails.push({
          id: `tax-${invoice.id}`,
          price: invTax,
          quantity: 1,
          name: taxLabelFull
        });
      }
      // Safety: kalau pembulatan bikin sum != total (mis. invoice.amount kosong di data lama),
      // koreksi otomatis dengan item adjustment Rp ±n
      const sumItems = itemDetails.reduce((s, it) => s + (it.price * it.quantity), 0);
      if (sumItems !== invTotal) {
        const diff = invTotal - sumItems;
        itemDetails.push({
          id: `adj-${invoice.id}`,
          price: diff,
          quantity: 1,
          name: diff > 0 ? 'Penyesuaian' : 'Diskon'
        });
      }

      const payload  = {
        transaction_details: { order_id: orderId, gross_amount: invTotal },
        customer_details: {
          first_name: sanitizedCustomer.firstName,
          last_name:  sanitizedCustomer.lastName || undefined,
          email:      sanitizedCustomer.email,
          phone:      sanitizedCustomer.phone || undefined
        },
        item_details: itemDetails,
        callbacks: {
          finish:  `${baseUrl}/portal/payment/finish?invoice=${invoice.id}`,
          error:   `${baseUrl}/portal/payment/finish?invoice=${invoice.id}&status=error`,
          pending: `${baseUrl}/portal/payment/pending?invoice=${invoice.id}`
        }
      };
      const auth = Buffer.from(gwKey + ':').toString('base64');
      let snap;
      try {
        snap = await axios.post(snapUrl, payload, {
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000
        });
      } catch (gwErr) {
        // Handle Midtrans specific errors
        if (gwErr.response) {
          const status = gwErr.response.status;
          const data   = gwErr.response.data;
          logger.error(`Midtrans ${status}: ${JSON.stringify(data)}`);
          if (status === 401) {
            return res.status(400).json({
              success: false,
              message: 'Server Key Midtrans tidak valid (401 Unauthorized). Cek ulang key di Pengaturan.'
            });
          }
          if (data?.error_messages?.length) {
            return res.status(400).json({
              success: false,
              message: 'Midtrans: ' + data.error_messages.join(', ')
            });
          }
          return res.status(400).json({
            success: false,
            message: `Midtrans error ${status}: ${data?.status_message || gwErr.message}`
          });
        }
        if (gwErr.code === 'ECONNABORTED') {
          return res.status(408).json({
            success: false,
            message: 'Koneksi ke Midtrans timeout. Coba lagi.'
          });
        }
        if (gwErr.code === 'ENOTFOUND' || gwErr.code === 'ECONNREFUSED') {
          return res.status(502).json({
            success: false,
            message: 'Tidak bisa terhubung ke server Midtrans. Cek koneksi internet server.'
          });
        }
        throw gwErr; // other unexpected errors go to outer catch
      }
      if (!snap?.data?.token) {
        return res.status(502).json({
          success: false,
          message: 'Midtrans response tidak valid (snap_token kosong)'
        });
      }
      await invoice.update({ notes: (invoice.notes||'') + `|midtrans_order:${orderId}` });
      return res.json({
        success: true, mode: 'midtrans',
        snap_token: snap.data.token, snap_url: snap.data.redirect_url,
        client_key: gwClientKey, env: isProd ? 'production' : 'sandbox',
        order_id: orderId, invoice_id: invoice.id
      });
    }

    // Xendit
    if (gwProvider === 'xendit') {
      // Validasi format key Xendit
      if (!gwKey.startsWith('xnd_')) {
        logger.warn(`Portal pay: server_key Xendit format tidak sesuai (prefix=${gwKey.slice(0,10)}...)`);
        return res.status(400).json({
          success: false,
          message: 'Secret API Key Xendit tidak valid. Harus dimulai dengan "xnd_development_" (sandbox) atau "xnd_production_" (live).'
        });
      }

      const externalId = `INV-${invoice.id}-${Date.now()}`;
      const baseUrl    = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

      // Breakdown untuk Xendit items — sama prinsipnya dgn Midtrans, tapi Xendit lebih lenient
      // (sum items tidak wajib = amount, tapi tetap kita konsistenkan demi kejelasan).
      const xenSubtotal = Math.round(parseFloat(invoice.amount || invoice.total));
      const xenTax      = Math.round(parseFloat(invoice.tax || 0));
      const xenTotal    = Math.round(parseFloat(invoice.total));
      const xenTaxLabel = (await getSetting('tax_label', 'PPN')) || 'PPN';
      const xenTaxRate  = parseFloat(await getSetting('tax_rate', ''));
      const xenTaxName  = xenTax > 0
        ? (xenTaxLabel + (Number.isFinite(xenTaxRate) && xenTaxRate > 0
            ? ' ' + (Number.isInteger(xenTaxRate) ? xenTaxRate : xenTaxRate.toFixed(1)) + '%'
            : ''))
        : xenTaxLabel;

      const xenItems = [{
        name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`,
        quantity: 1,
        price: xenTax > 0 ? xenSubtotal : xenTotal,
        category: 'Internet Service'
      }];
      if (xenTax > 0) {
        xenItems.push({
          name: xenTaxName,
          quantity: 1,
          price: xenTax,
          category: 'Tax'
        });
      }

      const payload = {
        external_id: externalId, amount: xenTotal,
        description: `Tagihan Internet ${invoice.period_month}/${invoice.period_year} - ${customer.name}`,
        customer: {
          given_names: sanitizedCustomer.firstName + (sanitizedCustomer.lastName ? ' ' + sanitizedCustomer.lastName : ''),
          email: sanitizedCustomer.email,
          mobile_number: sanitizedCustomer.phone || undefined
        },
        success_redirect_url: `${baseUrl}/portal/payment/finish?invoice=${invoice.id}`,
        failure_redirect_url: `${baseUrl}/portal/payment/finish?invoice=${invoice.id}&status=error`,
        currency: 'IDR',
        items: xenItems
      };
      const auth = Buffer.from(gwKey + ':').toString('base64');
      let xen;
      try {
        xen = await axios.post('https://api.xendit.co/v2/invoices', payload, {
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000
        });
      } catch (gwErr) {
        if (gwErr.response) {
          const status = gwErr.response.status;
          const data   = gwErr.response.data;
          logger.error(`Xendit ${status}: ${JSON.stringify(data)}`);
          if (status === 401) {
            return res.status(400).json({
              success: false,
              message: 'Secret API Key Xendit tidak valid (401 Unauthorized). Cek ulang key di Pengaturan.'
            });
          }
          return res.status(400).json({
            success: false,
            message: `Xendit error ${status}: ${data?.message || data?.error_code || gwErr.message}`
          });
        }
        if (gwErr.code === 'ECONNABORTED') {
          return res.status(408).json({ success: false, message: 'Koneksi ke Xendit timeout' });
        }
        if (gwErr.code === 'ENOTFOUND' || gwErr.code === 'ECONNREFUSED') {
          return res.status(502).json({ success: false, message: 'Tidak bisa terhubung ke server Xendit' });
        }
        throw gwErr;
      }
      if (!xen?.data?.invoice_url) {
        return res.status(502).json({ success: false, message: 'Xendit response tidak valid' });
      }
      await invoice.update({ notes: (invoice.notes||'') + `|xendit_id:${externalId}` });
      return res.json({
        success: true, mode: 'xendit',
        invoice_url: xen.data.invoice_url, external_id: externalId, invoice_id: invoice.id
      });
    }

    // ─────────────────────────────────────────────────────────────
    // Duitku — POP (Payment Outline Page) / createInvoice
    // Ref:
    //   https://docs.duitku.com/pop/en/
    //   https://github.com/duitkupg/sample-project-duitku-pop
    //
    // PENTING — endpoint POP berbeda dgn endpoint API Direct (v2/inquiry):
    //   • Host           : api-sandbox.duitku.com / api-prod.duitku.com
    //                      (BUKAN sandbox.duitku.com/webapi seperti v2/inquiry).
    //   • Path           : /api/merchant/createInvoice
    //   • Auth           : 3 header — x-duitku-merchantcode, x-duitku-timestamp,
    //                      x-duitku-signature.
    //   • Signature      : SHA256(merchantCode + timestamp + apiKey) — di header,
    //                      BUKAN MD5 di body seperti v2/inquiry.
    //   • Timestamp      : epoch ms (round(microtime(true)*1000) di PHP).
    //   • paymentMethod  : opsional (kalau diisi → direct payment).
    // Salah host atau salah signature → "An error has occurred" (500 generic).
    // ─────────────────────────────────────────────────────────────
    if (gwProvider === 'duitku') {
      // Duitku punya 2 credentials: merchantCode (DXXXXX) & apiKey (kita simpan di gwKey)
      const merchantCode = await getSetting('payment_gateway_merchant_code', '');
      if (!merchantCode) {
        logger.warn(`Portal pay: Duitku merchant_code kosong (customer ${customer.customer_id})`);
        return res.status(400).json({
          success: false,
          message: 'Merchant Code Duitku belum diisi. Cek Pengaturan → Payment Gateway.'
        });
      }
      // Validasi format merchantCode — biasanya prefix "D" + 4-6 digit (contoh: DS18020 / D14029).
      // Sandbox kadang pakai prefix "DS". Cukup pastikan alfanumerik.
      if (!/^[A-Z0-9]{3,15}$/i.test(merchantCode)) {
        return res.status(400).json({
          success: false,
          message: 'Merchant Code Duitku format tidak valid. Harus alfanumerik 3-15 karakter (contoh: DXXXXX).'
        });
      }
      // API Key Duitku biasanya hex string 32 karakter — kita longgar saja: minimum 16 char.
      if (gwKey.length < 16) {
        return res.status(400).json({
          success: false,
          message: 'API Key Duitku terlalu pendek. Cek ulang di Project Setting → API Key.'
        });
      }

      const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      // Duitku merchantOrderId max 50 char, alfanumerik (kita pakai INV-{id}-{ts})
      const merchantOrderId = `INV-${invoice.id}-${Date.now()}`;
      // Endpoint createInvoice (POP) — host & path BERBEDA dari v2/inquiry.
      const inquiryUrl = isProd
        ? 'https://api-prod.duitku.com/api/merchant/createInvoice'
        : 'https://api-sandbox.duitku.com/api/merchant/createInvoice';

      const dukSubtotal = Math.round(parseFloat(invoice.amount || invoice.total));
      const dukTax      = Math.round(parseFloat(invoice.tax || 0));
      const dukTotal    = Math.round(parseFloat(invoice.total));
      const dukTaxLabel = (await getSetting('tax_label', 'PPN')) || 'PPN';
      const dukTaxRate  = parseFloat(await getSetting('tax_rate', ''));
      const dukTaxName  = dukTax > 0
        ? (dukTaxLabel + (Number.isFinite(dukTaxRate) && dukTaxRate > 0
            ? ' ' + (Number.isInteger(dukTaxRate) ? dukTaxRate : dukTaxRate.toFixed(1)) + '%'
            : ''))
        : dukTaxLabel;

      // itemDetails: kita konsistenkan supaya breakdown jelas di halaman pembayaran.
      const itemDetails = [{
        name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`,
        price: dukTax > 0 ? dukSubtotal : dukTotal,
        quantity: 1
      }];
      if (dukTax > 0) {
        itemDetails.push({ name: dukTaxName, price: dukTax, quantity: 1 });
      }

      // Customer detail (nama dipisah first/last; address optional tapi kalau diisi
      // wajib lengkap — kita skip address detail karena data alamat customer ISP belum
      // ada postal code/country code yang baku).
      const billingAddress = {
        firstName: sanitizedCustomer.firstName,
        lastName:  sanitizedCustomer.lastName || '',
        address:   String(customer.address || '').slice(0, 200) || 'N/A',
        city:      'Indonesia',
        postalCode:'00000',
        phone:     sanitizedCustomer.phone || '',
        countryCode: 'ID'
      };
      const customerDetail = {
        firstName:    sanitizedCustomer.firstName,
        lastName:     sanitizedCustomer.lastName || '',
        email:        sanitizedCustomer.email,
        phoneNumber:  sanitizedCustomer.phone || '',
        billingAddress: billingAddress,
        shippingAddress: billingAddress
      };

      // Payload createInvoice — TIDAK perlu field `signature` di body (signature
      // dikirim via header `x-duitku-signature`). TIDAK perlu `merchantCode` di
      // body juga (dikirim via header `x-duitku-merchantcode`).
      const payload = {
        paymentAmount: dukTotal,
        merchantOrderId,
        productDetails: `Tagihan Internet ${invoice.period_month}/${invoice.period_year} - ${customer.name}`.slice(0, 200),
        email: sanitizedCustomer.email,
        phoneNumber: sanitizedCustomer.phone || '',
        additionalParam: '',
        merchantUserInfo: customer.customer_id || '',
        customerVaName: sanitizedCustomer.firstName.slice(0, 20),
        callbackUrl: `${baseUrl}/portal/webhook/duitku`,
        returnUrl:   `${baseUrl}/portal/payment/finish?invoice=${invoice.id}`,
        expiryPeriod: 60, // menit (1 jam)
        customerDetail,
        itemDetails
      };

      // Signature createInvoice: SHA256(merchantCode + timestamp + apiKey)
      // Timestamp adalah epoch milidetik (sesuai sample resmi PHP Duitku).
      const dukTimestamp = Date.now().toString();
      const dukSignature = crypto.createHash('sha256')
        .update(merchantCode + dukTimestamp + gwKey)
        .digest('hex');

      let duk;
      try {
        duk = await axios.post(inquiryUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'x-duitku-merchantcode': merchantCode,
            'x-duitku-timestamp':    dukTimestamp,
            'x-duitku-signature':    dukSignature
          },
          timeout: 15000
        });
      } catch (gwErr) {
        if (gwErr.response) {
          const status = gwErr.response.status;
          const data   = gwErr.response.data;
          logger.error(`Duitku ${status}: ${JSON.stringify(data)}`);
          // Duitku biasanya pakai HTTP 400/401/500 + body { Message: "...", statusCode: "01" }
          const dukMsg = data?.Message || data?.statusMessage || data?.message || gwErr.message;
          if (status === 401 || status === 403) {
            return res.status(400).json({
              success: false,
              message: `Duitku auth ditolak: ${dukMsg}. Cek Merchant Code & API Key.`
            });
          }
          return res.status(400).json({
            success: false,
            message: `Duitku error ${status}: ${dukMsg}`
          });
        }
        if (gwErr.code === 'ECONNABORTED') {
          return res.status(408).json({ success: false, message: 'Koneksi ke Duitku timeout' });
        }
        if (gwErr.code === 'ENOTFOUND' || gwErr.code === 'ECONNREFUSED') {
          return res.status(502).json({ success: false, message: 'Tidak bisa terhubung ke server Duitku' });
        }
        throw gwErr;
      }

      // Duitku response success: { merchantCode, reference, paymentUrl, vaNumber?, amount, statusCode:'00', statusMessage:'SUCCESS' }
      // statusCode '00' = success; selain itu = error.
      const dukData = duk?.data || {};
      if (dukData.statusCode && dukData.statusCode !== '00') {
        logger.error(`Duitku statusCode=${dukData.statusCode}: ${dukData.statusMessage}`);
        return res.status(400).json({
          success: false,
          message: `Duitku: ${dukData.statusMessage || 'transaksi gagal'} (kode ${dukData.statusCode})`
        });
      }
      if (!dukData.paymentUrl || !dukData.reference) {
        logger.error('Duitku response invalid: ' + JSON.stringify(dukData));
        return res.status(502).json({
          success: false,
          message: 'Duitku response tidak valid (paymentUrl/reference kosong)'
        });
      }

      // Simpan reference di notes invoice supaya webhook + transaction status
      // bisa cross-check kalau merchantOrderId tidak match.
      await invoice.update({
        notes: (invoice.notes || '') + `|duitku_order:${merchantOrderId}|duitku_ref:${dukData.reference}`
      });

      return res.json({
        success: true, mode: 'duitku',
        payment_url: dukData.paymentUrl,
        reference: dukData.reference,
        merchant_order_id: merchantOrderId,
        env: isProd ? 'production' : 'sandbox',
        invoice_id: invoice.id
      });
    }

    // ── Tripay (Closed Transaction) ──────────────────────────
    // Kredensial: API Key (gwKey/server_key), Merchant Code, Private Key.
    // Signature = HMAC-SHA256(merchantCode + merchantRef + amount, privateKey)
    // Ref: https://tripay.co.id/developer?tab=transaction-create
    if (gwProvider === 'tripay') {
      const merchantCode = await getSetting('payment_gateway_merchant_code', '');
      const privateKey   = await getSetting('payment_gateway_private_key', '');
      if (!merchantCode) {
        logger.warn(`Portal pay: Tripay merchant_code kosong (customer ${customer.customer_id})`);
        return res.status(400).json({
          success: false,
          message: 'Merchant Code Tripay belum diisi. Cek Pengaturan → Payment Gateway.'
        });
      }
      if (!privateKey || privateKey.length < 16) {
        logger.warn(`Portal pay: Tripay private_key kosong/pendek (customer ${customer.customer_id})`);
        return res.status(400).json({
          success: false,
          message: 'Private Key Tripay belum diisi atau terlalu pendek. Cek Pengaturan → Payment Gateway.'
        });
      }

      // Closed Transaction Tripay WAJIB punya `method` (mis. BRIVA, QRIS).
      // Customer memilih channel dulu di portal (via /api/tripay/channels),
      // lalu kode method dikirim sebagai tripay_method. Tanpa ini Tripay
      // menolak dgn "Undefined parameter method".
      const tripayMethod = (req.body && req.body.tripay_method) ? String(req.body.tripay_method).trim() : '';
      if (!tripayMethod) {
        return res.status(400).json({
          success: false,
          code: 'TRIPAY_METHOD_REQUIRED',
          message: 'Pilih metode pembayaran terlebih dahulu.'
        });
      }

      const isProd  = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const apiBase = isProd
        ? 'https://tripay.co.id/api'
        : 'https://tripay.co.id/api-sandbox';

      // merchant_ref unik per attempt (format konsisten dgn webhook: INV-{id}-{ts})
      const merchantRef = `INV-${invoice.id}-${Date.now()}`;
      const amount = Math.round(parseFloat(invoice.total));

      // Signature: HMAC-SHA256(merchantCode + merchantRef + amount) key=privateKey
      const signature = crypto.createHmac('sha256', privateKey)
        .update(merchantCode + merchantRef + amount)
        .digest('hex');

      // Order items (Tripay wajib name/price/quantity; subtotal = price*qty harus = amount)
      const orderItems = [{
        sku: `INV-${invoice.id}`,
        name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`.slice(0, 50),
        price: amount,
        quantity: 1
      }];

      // Closed transaction: kirim method terpilih (wajib).
      const payload = {
        method: tripayMethod,
        merchant_ref: merchantRef,
        amount,
        customer_name:  (customer.name || 'Customer').slice(0, 50),
        customer_email: sanitizedCustomer.email,
        customer_phone: sanitizedCustomer.phone || '',
        order_items: orderItems,
        callback_url: `${baseUrl}/portal/webhook/tripay`,
        return_url:   `${baseUrl}/portal/payment/finish?invoice=${invoice.id}`,
        expired_time: Math.floor(Date.now() / 1000) + (60 * 60), // 1 jam (unix)
        signature
      };
      // Buang key undefined supaya tidak mengganggu validasi Tripay
      Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

      let trx;
      try {
        trx = await axios.post(`${apiBase}/transaction/create`, payload, {
          headers: {
            'Authorization': `Bearer ${gwKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });
      } catch (gwErr) {
        if (gwErr.response) {
          const status = gwErr.response.status;
          const data   = gwErr.response.data;
          logger.error(`Tripay ${status}: ${JSON.stringify(data)}`);
          const tMsg = data?.message || gwErr.message;
          if (status === 401 || status === 403) {
            return res.status(400).json({
              success: false,
              message: `Tripay auth ditolak: ${tMsg}. Cek API Key & Private Key.`
            });
          }
          return res.status(400).json({
            success: false,
            message: `Tripay error: ${tMsg}`
          });
        }
        if (gwErr.code === 'ECONNABORTED') {
          return res.status(408).json({ success: false, message: 'Koneksi ke Tripay timeout' });
        }
        if (gwErr.code === 'ENOTFOUND' || gwErr.code === 'ECONNREFUSED') {
          return res.status(502).json({ success: false, message: 'Tidak bisa terhubung ke server Tripay' });
        }
        throw gwErr;
      }

      // Response sukses: { success:true, data:{ reference, checkout_url, ... } }
      const tBody = trx?.data || {};
      if (!tBody.success || !tBody.data) {
        logger.error('Tripay response invalid: ' + JSON.stringify(tBody));
        return res.status(400).json({
          success: false,
          message: `Tripay: ${tBody.message || 'transaksi gagal dibuat'}`
        });
      }
      const tData = tBody.data;
      if (!tData.checkout_url || !tData.reference) {
        logger.error('Tripay data invalid: ' + JSON.stringify(tData));
        return res.status(502).json({
          success: false,
          message: 'Tripay response tidak valid (checkout_url/reference kosong)'
        });
      }

      // Simpan ref di notes invoice utk cross-check webhook
      await invoice.update({
        notes: (invoice.notes || '') + `|tripay_ref:${merchantRef}|tripay_tref:${tData.reference}`
      });

      return res.json({
        success: true, mode: 'tripay',
        payment_url: tData.checkout_url,
        reference: tData.reference,
        merchant_ref: merchantRef,
        env: isProd ? 'production' : 'sandbox',
        invoice_id: invoice.id
      });
    }

    res.status(400).json({ success: false, message: 'Payment gateway provider tidak dikenali' });
  } catch (e) {
    logger.error('Portal createPayment error:', e.message);
    if (e.response) logger.error('GW response:', e.response.data);
    res.status(500).json({ success: false, message: 'Gagal membuat transaksi: ' + e.message });
  }
};

// ── PAYMENT GATEWAY: Midtrans Webhook ─────────────────────────
// Ref: https://docs.midtrans.com/reference/notification-webhooks
// Signature: SHA512(order_id + status_code + gross_amount + server_key)
exports.midtransNotif = async (req, res) => {
  try {
    const {
      order_id, transaction_status, fraud_status, status_code,
      gross_amount, signature_key, payment_type, transaction_id
    } = req.body;

    // 0. Routing terpusat: Midtrans hanya punya SATU Notification URL global.
    //    Top-up reseller memakai order_id berformat "RTOP-{id}-{ts}", sedangkan
    //    invoice pelanggan "INV-{id}-{ts}". Bila ini notifikasi top-up reseller,
    //    teruskan ke handler webhook reseller (yang meng-credit saldo otomatis).
    if (/^RTOP-\d+-\d+$/.test(order_id || '')) {
      const ResellerWebhookController = require('./ResellerWebhookController');
      return ResellerWebhookController.midtrans(req, res);
    }
    // Order voucher publik (halaman /beli) memakai prefix VPO-{id}-{ts}.
    if (/^VPO-\d+-\d+$/.test(order_id || '')) {
      const PublicVoucherWebhookController = require('./PublicVoucherWebhookController');
      return PublicVoucherWebhookController.midtrans(req, res);
    }

    // 1. Parse invoice id dari order_id (format: INV-{id}-{timestamp})
    const match = (order_id || '').match(/^INV-(\d+)-\d+$/);
    if (!match) {
      logger.warn(`Midtrans webhook: invalid order_id format "${order_id}"`);
      return res.status(400).json({ success: false, message: 'Invalid order_id' });
    }
    const invoiceId = parseInt(match[1]);

    // 2. Verifikasi signature (WAJIB untuk anti-fake-callback)
    const serverKey = await getSetting('payment_gateway_server_key', '');
    if (!serverKey) {
      logger.error('Midtrans webhook: server_key belum dikonfigurasi');
      return res.status(500).json({ success: false, message: 'Gateway not configured' });
    }
    const expected = crypto.createHash('sha512')
      .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
      .digest('hex');
    if (signature_key !== expected) {
      logger.warn(`Midtrans webhook: invalid signature for ${order_id}`);
      return res.status(403).json({ success: false, message: 'Invalid signature' });
    }

    // 3. Cek invoice exists
    const invoice = await Invoice.findByPk(invoiceId);
    if (!invoice) {
      logger.warn(`Midtrans webhook: invoice #${invoiceId} not found`);
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // 4. Idempotent: kalau sudah paid, langsung balas 200 (Midtrans bisa retry)
    if (invoice.status === 'paid') {
      logger.info(`Midtrans webhook: invoice #${invoiceId} sudah paid, skip`);
      return res.json({ success: true, message: 'Already paid' });
    }

    // 5. Handle status
    const isSuccess = transaction_status === 'settlement' ||
      (transaction_status === 'capture' && fraud_status === 'accept');
    const isFailed  = ['cancel','deny','expire','failure'].includes(transaction_status);

    if (isSuccess) {
      await Invoice.update(
        { status: 'paid', paid_date: new Date() },
        { where: { id: invoiceId } }
      );
      // Map payment_type Midtrans → enum Payment.payment_method
      const methodMap = {
        bank_transfer:'transfer', echannel:'transfer', permata_va:'transfer',
        bca_va:'transfer', bni_va:'transfer', bri_va:'transfer', mandiri_va:'transfer',
        gopay:'gopay', shopeepay:'ewallet', qris:'qris',
        credit_card:'gateway', cstore:'other', akulaku:'other'
      };
      const payMethod = methodMap[payment_type] || 'gateway';

      const newPayment = await Payment.create({
        invoice_id: invoiceId,
        amount: parseFloat(gross_amount) || parseFloat(invoice.total),
        payment_method: payMethod,
        payment_date: new Date().toISOString().slice(0, 10),
        reference_number: order_id,
        gateway: 'midtrans',
        notes: `Auto: Midtrans ${payment_type || ''} (${transaction_id || ''})`
      });
      logger.info(`Portal: Invoice #${invoiceId} PAID via Midtrans (${order_id}, ${payment_type})`);

      // ── Auto: aktifkan customer, sync Keuangan, restore isolir, kirim WA ──
      try {
        const { finalizePaidInvoice } = require('../utils/paymentFinalizer');
        const fin = await finalizePaidInvoice({
          invoiceId, paymentId: newPayment.id, channel: 'midtrans', referenceNo: order_id
        });
        logger.info(`Midtrans webhook finalize: invoice #${invoiceId} → ${JSON.stringify(fin)}`);
      } catch (finErr) {
        logger.error(`Midtrans webhook finalize error invoice #${invoiceId}: ${finErr.message}`);
        // Tidak fatal — payment & invoice sudah persist.
      }
    } else if (isFailed) {
      logger.info(`Midtrans webhook: invoice #${invoiceId} ${transaction_status} (${order_id})`);
      // Tidak update status invoice — tetap unpaid, biarkan customer bisa coba lagi
    } else {
      logger.info(`Midtrans webhook: invoice #${invoiceId} status=${transaction_status} (pending/in-progress)`);
    }

    res.json({ success: true });
  } catch (e) {
    logger.error('Midtrans notif error:', e);
    res.status(500).json({ success: false });
  }
};

// ── PAYMENT GATEWAY: Xendit Webhook ──────────────────────────
// Ref: https://docs.xendit.co/xenpayments/payments-api-overview/payment-receipt-webhooks
// Verification: header "x-callback-token" cocok dengan callback_token di dashboard Xendit
exports.xenditNotif = async (req, res) => {
  try {
    // 1. Verifikasi callback token dari header
    const expectedToken = await getSetting('payment_gateway_callback_token', '');
    if (expectedToken) {
      const incomingToken = req.headers['x-callback-token'] || '';
      if (incomingToken !== expectedToken) {
        logger.warn('Xendit webhook: invalid x-callback-token');
        return res.status(403).json({ success: false, message: 'Invalid callback token' });
      }
    } else {
      logger.warn('Xendit webhook: callback_token belum dikonfigurasi (TIDAK AMAN!)');
    }

    const { external_id, status, paid_amount, payment_method, payment_channel, id: xenInvoiceId } = req.body;

    const match = (external_id || '').match(/^INV-(\d+)-\d+$/);
    if (!match) {
      logger.warn(`Xendit webhook: invalid external_id "${external_id}"`);
      return res.status(400).json({ success: false, message: 'Invalid external_id' });
    }
    const invoiceId = parseInt(match[1]);

    const invoice = await Invoice.findByPk(invoiceId);
    if (!invoice) {
      logger.warn(`Xendit webhook: invoice #${invoiceId} not found`);
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // Idempotent
    if (invoice.status === 'paid') {
      logger.info(`Xendit webhook: invoice #${invoiceId} sudah paid, skip`);
      return res.json({ success: true, message: 'Already paid' });
    }

    if (status === 'PAID' || status === 'SETTLED') {
      await Invoice.update(
        { status: 'paid', paid_date: new Date() },
        { where: { id: invoiceId } }
      );

      const methodLower = (payment_method || '').toLowerCase();
      let payMethod = 'gateway';
      if (methodLower.includes('bank') || methodLower.includes('va'))      payMethod = 'transfer';
      else if (methodLower.includes('qr'))                                  payMethod = 'qris';
      else if (methodLower.includes('ewallet') || methodLower.includes('wallet')) payMethod = 'ewallet';
      else if (methodLower.includes('credit'))                              payMethod = 'gateway';

      const newPayment = await Payment.create({
        invoice_id: invoiceId,
        amount: parseFloat(paid_amount) || parseFloat(invoice.total),
        payment_method: payMethod,
        payment_date: new Date().toISOString().slice(0, 10),
        reference_number: external_id,
        notes: `Auto: Xendit ${payment_method || ''} ${payment_channel || ''} (${xenInvoiceId || ''})`,
        gateway: 'xendit'
      });
      logger.info(`Portal: Invoice #${invoiceId} PAID via Xendit (${external_id}, ${payment_method})`);

      // ── Auto: aktifkan customer, sync Keuangan, restore isolir, kirim WA ──
      try {
        const { finalizePaidInvoice } = require('../utils/paymentFinalizer');
        const fin = await finalizePaidInvoice({
          invoiceId, paymentId: newPayment.id, channel: 'xendit', referenceNo: external_id
        });
        logger.info(`Xendit webhook finalize: invoice #${invoiceId} → ${JSON.stringify(fin)}`);
      } catch (finErr) {
        logger.error(`Xendit webhook finalize error invoice #${invoiceId}: ${finErr.message}`);
      }
    } else if (status === 'EXPIRED' || status === 'FAILED') {
      logger.info(`Xendit webhook: invoice #${invoiceId} ${status} (${external_id})`);
    } else {
      logger.info(`Xendit webhook: invoice #${invoiceId} status=${status} (${external_id})`);
    }

    res.json({ success: true });
  } catch (e) {
    logger.error('Xendit notif error:', e);
    res.status(500).json({ success: false });
  }
};

// ── PAYMENT GATEWAY: Duitku Webhook ───────────────────────────
// Ref: https://docs.duitku.com/api/id/ (Callback section)
// Duitku POST callback as application/x-www-form-urlencoded dengan field:
//   merchantCode, amount, merchantOrderId, productDetail, additionalParam,
//   paymentCode (= paymentMethod yg dipilih user), resultCode, merchantUserId,
//   reference, signature, publisherOrderId, spUserHash?, settlementDate?, issuerCode?
// Signature: MD5(merchantCode + amount + merchantOrderId + apiKey)
// resultCode: '00' = success, '01' = pending/failed
exports.duitkuNotif = async (req, res) => {
  try {
    const {
      merchantCode, amount, merchantOrderId, productDetail, additionalParam,
      paymentCode, resultCode, merchantUserId, reference, signature,
      publisherOrderId, settlementDate, issuerCode
    } = req.body || {};

    // 1. Validasi field minimal
    if (!merchantCode || !amount || !merchantOrderId || !signature) {
      logger.warn(`Duitku webhook: missing required fields, body=${JSON.stringify(req.body)}`);
      return res.status(400).send('Invalid payload');
    }

    // Routing: top-up reseller (RTOP-) & order voucher publik (VPO-).
    if (/^RTOP-\d+-\d+$/.test(merchantOrderId)) {
      const ResellerWebhookController = require('./ResellerWebhookController');
      return ResellerWebhookController.duitku(req, res);
    }
    if (/^VPO-\d+-\d+$/.test(merchantOrderId)) {
      const PublicVoucherWebhookController = require('./PublicVoucherWebhookController');
      return PublicVoucherWebhookController.duitku(req, res);
    }

    // 2. Parse invoice id dari merchantOrderId (format: INV-{id}-{ts})
    const match = String(merchantOrderId).match(/^INV-(\d+)-\d+$/);
    if (!match) {
      logger.warn(`Duitku webhook: invalid merchantOrderId format "${merchantOrderId}"`);
      return res.status(400).send('Invalid merchantOrderId');
    }
    const invoiceId = parseInt(match[1]);

    // 3. Verifikasi signature: MD5(merchantCode + amount + merchantOrderId + apiKey)
    const apiKey = await getSetting('payment_gateway_server_key', '');
    const cfgMerchantCode = await getSetting('payment_gateway_merchant_code', '');
    if (!apiKey || !cfgMerchantCode) {
      logger.error('Duitku webhook: API key / merchant code belum dikonfigurasi');
      return res.status(500).send('Gateway not configured');
    }
    // Pastikan merchantCode di payload memang merchant kita (anti-spoof basic)
    if (String(merchantCode) !== String(cfgMerchantCode)) {
      logger.warn(`Duitku webhook: merchantCode mismatch (got=${merchantCode}, expected=${cfgMerchantCode})`);
      return res.status(403).send('Invalid merchantCode');
    }
    const expected = crypto.createHash('md5')
      .update(String(merchantCode) + String(amount) + String(merchantOrderId) + apiKey)
      .digest('hex');
    if (String(signature).toLowerCase() !== expected.toLowerCase()) {
      logger.warn(`Duitku webhook: invalid signature for ${merchantOrderId}`);
      return res.status(403).send('Invalid signature');
    }

    // 4. Cek invoice
    const invoice = await Invoice.findByPk(invoiceId);
    if (!invoice) {
      logger.warn(`Duitku webhook: invoice #${invoiceId} not found`);
      return res.status(404).send('Invoice not found');
    }

    // 5. Idempotent — Duitku bisa retry kalau merchant tidak balas 200
    if (invoice.status === 'paid') {
      logger.info(`Duitku webhook: invoice #${invoiceId} sudah paid, skip (resultCode=${resultCode})`);
      return res.status(200).send('Already paid');
    }

    // 6. Handle berdasarkan resultCode
    // '00' = SUCCESS, '01' = FAILED/PENDING (Duitku tidak kirim callback untuk pending,
    // jadi kalau '01' biasanya artinya transaksi expired/failed)
    if (String(resultCode) === '00') {
      // Verifikasi nominal amount sesuai invoice (anti-tampered)
      const expectedAmount = Math.round(parseFloat(invoice.total));
      const callbackAmount = Math.round(parseFloat(amount));
      if (callbackAmount !== expectedAmount) {
        logger.error(`Duitku webhook: amount mismatch invoice #${invoiceId} (callback=${callbackAmount}, expected=${expectedAmount})`);
        return res.status(400).send('Amount mismatch');
      }

      await Invoice.update(
        { status: 'paid', paid_date: new Date() },
        { where: { id: invoiceId } }
      );

      // Map paymentCode Duitku → enum Payment.payment_method.
      // Ref kode Duitku (paymentCode): VC=Credit Card, BC=BCA VA, M2=Mandiri VA,
      // VA=Maybank VA, I1=BNI VA, B1=CIMB VA, BT=Permata VA, A1=ATM Bersama,
      // AG=BRI VA, NC=BNC, BR=BRIVA, S1=Bank Sahabat Sampoerna,
      // DA=DANA, OV=OVO, SP=ShopeePay, LA=LinkAja, LF=LinkAja App, LQ=LinkAja QRIS,
      // SA=Shopee Linked, OL=OVO Linked, NQ=Nobu QRIS, DQ=DANA QRIS, GQ=Gudang Voucher QRIS,
      // SL=ShopeePay Linked, FT=Pegadaian/ALFA Indomaret, IR=Indomaret, AL=ALFAMART,
      // AO=ALFAMART (offline), Q1/Q2/SQ=QRIS variant, KP=KREDIVO, AT=ATOME,
      // IN=Indodana, T0=Indomart, etc.
      const code = String(paymentCode || '').toUpperCase();
      let payMethod = 'gateway';
      if (['VC'].includes(code)) {
        payMethod = 'gateway'; // credit card
      } else if (['BC','M2','VA','I1','B1','BT','A1','AG','NC','BR','S1','BK'].includes(code)) {
        payMethod = 'transfer'; // virtual account / bank transfer
      } else if (code.startsWith('Q') || code === 'SQ' || code === 'NQ' || code === 'DQ' || code === 'GQ' || code === 'LQ') {
        payMethod = 'qris';
      } else if (['DA','OV','SP','LA','LF','SA','OL','SL'].includes(code)) {
        // E-wallet detail: DANA → dana, OVO → ovo, GoPay (jika ada) → gopay,
        // ShopeePay/LinkAja/lainnya → ewallet (enum di DB tidak punya semua)
        if (code === 'DA') payMethod = 'dana';
        else if (code === 'OV' || code === 'OL') payMethod = 'ovo';
        else payMethod = 'ewallet';
      } else if (['FT','IR','AL','AO','T0','PI'].includes(code)) {
        payMethod = 'other'; // retail offline
      }

      const newPayment = await Payment.create({
        invoice_id: invoiceId,
        amount: callbackAmount,
        payment_method: payMethod,
        payment_date: new Date().toISOString().slice(0, 10),
        reference_number: reference || merchantOrderId,
        notes: `Auto: Duitku ${paymentCode || ''} (ref: ${reference || ''}${publisherOrderId ? ', pub: ' + publisherOrderId : ''}${settlementDate ? ', settle: ' + settlementDate : ''})`,
        gateway: 'duitku'
      });
      logger.info(`Portal: Invoice #${invoiceId} PAID via Duitku (${merchantOrderId}, paymentCode=${paymentCode}, ref=${reference})`);

      // ── Auto: aktifkan customer, sync Keuangan, restore isolir, kirim WA ──
      try {
        const { finalizePaidInvoice } = require('../utils/paymentFinalizer');
        const fin = await finalizePaidInvoice({
          invoiceId, paymentId: newPayment.id, channel: 'duitku', referenceNo: reference || merchantOrderId
        });
        logger.info(`Duitku webhook finalize: invoice #${invoiceId} → ${JSON.stringify(fin)}`);
      } catch (finErr) {
        logger.error(`Duitku webhook finalize error invoice #${invoiceId}: ${finErr.message}`);
      }
    } else {
      // resultCode '01' atau lainnya = failed/expired. Tidak update invoice — biarkan
      // customer bisa coba lagi.
      logger.info(`Duitku webhook: invoice #${invoiceId} resultCode=${resultCode} (failed/pending) ref=${reference}`);
    }

    // Duitku expects HTTP 200 with body "OK" atau apapun — yg penting status 200.
    res.status(200).send('OK');
  } catch (e) {
    logger.error('Duitku notif error:', e);
    res.status(500).send('Server error');
  }
};

// ── PAYMENT GATEWAY: Tripay Webhook (callback) ───────────────
// Verifikasi: header "X-Callback-Signature" = HMAC-SHA256(rawBody, privateKey)
// Body: { reference, merchant_ref, status: 'PAID'|'EXPIRED'|'FAILED'|'UNPAID',
//         total_amount, payment_method, ... }
// Ref: https://tripay.co.id/developer?tab=callback
exports.tripayNotif = async (req, res) => {
  try {
    const privateKey = await getSetting('payment_gateway_private_key', '');
    if (!privateKey) {
      logger.error('Tripay webhook: private_key belum dikonfigurasi');
      return res.status(500).json({ success: false, message: 'Gateway not configured' });
    }

    // 1. Verifikasi signature dari raw body ASLI.
    // req.rawBody ditangkap global via express.json({verify}) di server.js. HMAC HARUS
    // dihitung atas byte body asli — JANGAN JSON.stringify(req.body) (urutan/spasi bisa
    // berbeda dari yang Tripay tanda-tangani → signature pasti gagal).
    const rawBody = (typeof req.rawBody === 'string') ? req.rawBody : '';
    const incomingSig = req.headers['x-callback-signature'] || '';
    const expectedSig = crypto.createHmac('sha256', privateKey).update(rawBody).digest('hex');
    if (String(incomingSig).toLowerCase() !== expectedSig.toLowerCase()) {
      // Log diagnostik (tanpa membocorkan private key) untuk mempermudah audit.
      logger.warn(`Tripay webhook: invalid signature (rawBodyLen=${rawBody.length}, ` +
        `incoming=${String(incomingSig).slice(0, 12)}…, expected=${expectedSig.slice(0, 12)}…, ` +
        `ref=${(req.body && req.body.merchant_ref) || '-'})`);
      return res.status(403).json({ success: false, message: 'Invalid signature' });
    }

    // 2. Validasi event (Tripay kirim header X-Callback-Event = payment_status)
    const event = req.headers['x-callback-event'] || '';
    if (event && event !== 'payment_status') {
      logger.info(`Tripay webhook: event diabaikan (${event})`);
      return res.status(200).json({ success: true });
    }

    const b = req.body || {};
    const merchantRef = b.merchant_ref;
    const status      = String(b.status || '').toUpperCase();
    const reference   = b.reference;

    // Routing: top-up reseller (RTOP-) & order voucher publik (VPO-).
    if (/^RTOP-\d+-\d+$/.test(merchantRef || '')) {
      const ResellerWebhookController = require('./ResellerWebhookController');
      return ResellerWebhookController.tripay(req, res);
    }
    if (/^VPO-\d+-\d+$/.test(merchantRef || '')) {
      const PublicVoucherWebhookController = require('./PublicVoucherWebhookController');
      return PublicVoucherWebhookController.tripay(req, res);
    }

    // 3. Parse invoice id (format merchant_ref: INV-{id}-{ts})
    const match = String(merchantRef || '').match(/^INV-(\d+)-\d+$/);
    if (!match) {
      logger.warn(`Tripay webhook: invalid merchant_ref "${merchantRef}"`);
      return res.status(400).json({ success: false, message: 'Invalid merchant_ref' });
    }
    const invoiceId = parseInt(match[1]);

    const invoice = await Invoice.findByPk(invoiceId);
    if (!invoice) {
      logger.warn(`Tripay webhook: invoice #${invoiceId} not found`);
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // 4. Idempotent
    if (invoice.status === 'paid') {
      logger.info(`Tripay webhook: invoice #${invoiceId} sudah paid, skip (status=${status})`);
      return res.status(200).json({ success: true });
    }

    // 5. Hanya proses PAID
    if (status === 'PAID') {
      const expectedAmount = Math.round(parseFloat(invoice.total));
      // PENTING soal nominal Tripay:
      //   • b.amount         = nominal transaksi yg KITA kirim saat create (= invoice.total). Ini yg tepat utk validasi.
      //   • b.total_amount   = amount + fee yg DIBEBANKAN KE CUSTOMER (mis. Alfamart/VA fee tetap). SELALU ≥ amount,
      //                        jadi JANGAN dipakai utk cek kecocokan (pasti mismatch utk channel berfee-customer).
      //   • b.amount_received= nominal yg diterima merchant setelah potong fee merchant (bisa < amount).
      // Prioritaskan b.amount; fallback ke amount_received; total_amount hanya cadangan terakhir.
      const cbAmount   = Math.round(parseFloat(b.amount || 0));
      const cbReceived = Math.round(parseFloat(b.amount_received || 0));
      const cbTotal    = Math.round(parseFloat(b.total_amount || 0));
      // Nominal untuk dicatat sebagai pembayaran = nilai tagihan yg kita kirim (bukan termasuk fee customer).
      const callbackAmount = cbAmount || cbReceived || expectedAmount;
      // Validasi: cocok bila SALAH SATU dari (amount / amount_received / total_amount) == expected.
      // Ini toleran terhadap fee customer (total_amount > expected) maupun fee merchant (amount_received < expected).
      const anyMatch = [cbAmount, cbReceived, cbTotal].some(v => v && v === expectedAmount);
      const anyPresent = cbAmount || cbReceived || cbTotal;
      if (anyPresent && !anyMatch) {
        logger.error(`Tripay webhook: amount mismatch invoice #${invoiceId} ` +
          `(amount=${cbAmount}, amount_received=${cbReceived}, total_amount=${cbTotal}, expected=${expectedAmount})`);
        return res.status(400).json({ success: false, message: 'Amount mismatch' });
      }

      await Invoice.update(
        { status: 'paid', paid_date: new Date() },
        { where: { id: invoiceId } }
      );

      // Map payment_method Tripay → enum Payment.payment_method
      const pm = String(b.payment_method || '').toUpperCase();
      let payMethod = 'gateway';
      if (pm.includes('QRIS')) payMethod = 'qris';
      else if (pm.includes('VA') || pm.includes('VIRTUAL') || /BCA|BNI|BRI|MANDIRI|PERMATA|CIMB|MUAMALAT|BSI|DANAMON|SAMPOERNA/.test(pm)) payMethod = 'transfer';
      else if (pm.includes('OVO')) payMethod = 'ovo';
      else if (pm.includes('DANA')) payMethod = 'dana';
      else if (pm.includes('ALFA') || pm.includes('INDOMARET') || pm.includes('RETAIL')) payMethod = 'other';
      else if (pm.includes('SHOPEE') || pm.includes('LINKAJA') || pm.includes('WALLET')) payMethod = 'ewallet';

      const newPayment = await Payment.create({
        invoice_id: invoiceId,
        amount: callbackAmount || expectedAmount,
        payment_method: payMethod,
        payment_date: new Date().toISOString().slice(0, 10),
        reference_number: reference || merchantRef,
        gateway: 'tripay',
        notes: `Auto: Tripay ${b.payment_method || ''} (ref: ${reference || ''})`
      });
      logger.info(`Portal: Invoice #${invoiceId} PAID via Tripay (${merchantRef}, method=${b.payment_method}, ref=${reference})`);

      try {
        const { finalizePaidInvoice } = require('../utils/paymentFinalizer');
        const fin = await finalizePaidInvoice({
          invoiceId, paymentId: newPayment.id, channel: 'tripay', referenceNo: reference || merchantRef
        });
        logger.info(`Tripay webhook finalize: invoice #${invoiceId} → ${JSON.stringify(fin)}`);
      } catch (finErr) {
        logger.error(`Tripay webhook finalize error invoice #${invoiceId}: ${finErr.message}`);
      }
    } else {
      // EXPIRED / FAILED / UNPAID / REFUND — tidak ubah invoice, biar bisa coba lagi
      logger.info(`Tripay webhook: invoice #${invoiceId} status=${status} ref=${reference}`);
    }

    // Tripay mengharapkan JSON { success: true }
    return res.status(200).json({ success: true });
  } catch (e) {
    logger.error('Tripay notif error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PAYMENT: Cek status invoice (untuk halaman finish/pending polling) ──
exports.invoiceStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const invoice = await Invoice.findOne({
      where: { id, customer_id: req.portalUser.id },
      attributes: ['id','invoice_number','status','total','paid_date','period_month','period_year']
    });
    if (!invoice)
      return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });

    let lastPayment = null;
    if (invoice.status === 'paid') {
      lastPayment = await Payment.findOne({
        where: { invoice_id: invoice.id },
        order: [['createdAt', 'DESC']],
        attributes: ['id','amount','payment_method','payment_date','reference_number']
      });
    }
    res.json({ success: true, data: { invoice, payment: lastPayment } });
  } catch (e) {
    logger.error('Portal invoiceStatus error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUSH: Get VAPID public key ────────────────────────────────
exports.pushVapidKey = async (req, res) => {
  const PushService = require('../services/PushService');
  const key = PushService.getPublicKey();
  if (!key) return res.json({ success: false, message: 'Push notification tidak aktif' });
  res.json({ success: true, vapid_public_key: key });
};

// ── PUSH: Subscribe ───────────────────────────────────────────
exports.pushSubscribe = async (req, res) => {
  try {
    const { subscription, device_name } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys)
      return res.status(400).json({ success: false, message: 'Data subscription tidak valid' });

    const { CustomerPushSubscription } = require('../models');

    // Upsert: jika endpoint sudah ada untuk customer ini, update saja
    const [sub, created] = await CustomerPushSubscription.findOrCreate({
      where: {
        customer_id: req.portalUser.id,
        endpoint:    subscription.endpoint
      },
      defaults: {
        customer_id: req.portalUser.id,
        platform:    'web',
        endpoint:    subscription.endpoint,
        p256dh:      subscription.keys.p256dh,
        auth:        subscription.keys.auth,
        device_name: device_name || null,
        is_active:   true,
        last_used:   new Date()
      }
    });

    if (!created) {
      await sub.update({
        platform:    'web',
        p256dh:      subscription.keys.p256dh,
        auth:        subscription.keys.auth,
        device_name: device_name || sub.device_name,
        is_active:   true,
        last_used:   new Date()
      });
    }

    // Kirim push test langsung (optional, konfirmasi berhasil)
    const PushService = require('../services/PushService');
    if (PushService.isReady()) {
      PushService.sendToCustomer(req.portalUser.id, {
        title: '✅ Notifikasi Aktif',
        body:  'Push notification berhasil diaktifkan. Anda akan mendapat reminder tagihan.',
        tag:   'subscribe-confirm',
        url:   '/portal/dashboard'
      }).catch(() => {});
    }

    res.json({ success: true, message: 'Berhasil subscribe push notification', created });
  } catch (e) {
    logger.error('Portal pushSubscribe error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUSH: Register FCM token (Android APK) ────────────────────
// Called by Capacitor @capacitor/push-notifications after getToken() succeeds.
// Body: { fcm_token: string, device_name?: string }
exports.pushRegisterFcm = async (req, res) => {
  try {
    const { fcm_token, device_name } = req.body;
    if (!fcm_token || typeof fcm_token !== 'string' || fcm_token.length < 20) {
      return res.status(400).json({ success: false, message: 'FCM token tidak valid' });
    }

    const { CustomerPushSubscription } = require('../models');

    // Upsert by customer_id + fcm_token. If the same token already exists for
    // a different customer (rare: device handed between users), we re-bind it
    // to the current authenticated customer.
    let sub = await CustomerPushSubscription.findOne({
      where: { fcm_token }
    });

    if (sub) {
      await sub.update({
        customer_id: req.portalUser.id,
        platform:    'fcm',
        device_name: device_name || sub.device_name,
        is_active:   true,
        last_used:   new Date()
      });
    } else {
      sub = await CustomerPushSubscription.create({
        customer_id: req.portalUser.id,
        platform:    'fcm',
        fcm_token,
        device_name: device_name || 'Android App',
        is_active:   true,
        last_used:   new Date()
      });
    }

    // Optional confirmation push — sent async, don't block the response
    const PushService = require('../services/PushService');
    if (PushService.isFcmReady()) {
      PushService.sendToCustomer(req.portalUser.id, {
        title: '✅ Notifikasi Aktif',
        body:  'Push notification berhasil diaktifkan di aplikasi.',
        tag:   'subscribe-confirm',
        url:   '/portal/dashboard',
        data:  { type: 'subscribe_confirm' }
      }).catch(() => {});
    }

    res.json({ success: true, message: 'FCM token registered', id: sub.id });
  } catch (e) {
    logger.error('Portal pushRegisterFcm error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUSH: Unregister FCM token ────────────────────────────────
exports.pushUnregisterFcm = async (req, res) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token) {
      return res.status(400).json({ success: false, message: 'FCM token wajib diisi' });
    }
    const { CustomerPushSubscription } = require('../models');
    await CustomerPushSubscription.destroy({
      where: { customer_id: req.portalUser.id, platform: 'fcm', fcm_token }
    });
    res.json({ success: true, message: 'FCM token removed' });
  } catch (e) {
    logger.error('Portal pushUnregisterFcm error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUSH: Unsubscribe ─────────────────────────────────────────
exports.pushUnsubscribe = async (req, res) => {
  try {
    const { endpoint } = req.body;
    const { CustomerPushSubscription } = require('../models');

    if (endpoint) {
      await CustomerPushSubscription.destroy({
        where: { customer_id: req.portalUser.id, endpoint }
      });
    } else {
      // Hapus semua subscription milik customer ini
      await CustomerPushSubscription.destroy({
        where: { customer_id: req.portalUser.id }
      });
    }

    res.json({ success: true, message: 'Push notification dinonaktifkan' });
  } catch (e) {
    logger.error('Portal pushUnsubscribe error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUSH: Status (berapa device yang subscribe, per platform) ─
exports.pushStatus = async (req, res) => {
  try {
    const { CustomerPushSubscription, sequelize } = require('../models');
    // One query returns both platform counts — cheaper than two counts().
    const rows = await CustomerPushSubscription.findAll({
      where: { customer_id: req.portalUser.id, is_active: true },
      attributes: [
        'platform',
        [sequelize.fn('COUNT', sequelize.col('id')), 'n']
      ],
      group: ['platform'],
      raw: true
    });
    let webCount = 0, fcmCount = 0;
    rows.forEach(r => {
      if (r.platform === 'fcm') fcmCount = parseInt(r.n, 10) || 0;
      else                       webCount = parseInt(r.n, 10) || 0;
    });
    const total = webCount + fcmCount;

    const PushService = require('../services/PushService');
    res.json({
      success: true,
      subscribed:   total > 0,
      device_count: total,
      web_count:    webCount,
      fcm_count:    fcmCount,
      push_enabled: PushService.isReady(),
      web_ready:    PushService.isWebReady(),
      fcm_ready:    PushService.isFcmReady()
    });
  } catch (e) {
    res.status(500).json({ success: false });
  }
};

// ── WIFI: Get status + SSID ───────────────────────────────────
exports.wifiStatus = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.portalUser.id);
    if (!customer || !customer.ont_sn)
      return res.json({ success: true, data: null, message: 'ONT tidak terdaftar' });

    const device = await findDeviceBySN(customer.ont_sn);

    if (!device) {
      const allResult  = await genieacs.getDevices({});
      const allDevices = allResult?.data || [];
      return res.json({
        success: true, data: null, message: 'ONT tidak ditemukan',
        debug: {
          ont_sn: customer.ont_sn,
          genieacs_reachable: allResult?.success !== false,
          genieacs_error: allResult?.error || null,
          total_in_genieacs: allDevices.length,
          sample_serials: allDevices.slice(0, 8).map(d => ({
            id: d['_id'] || '?',
            sn: d['DeviceID.SerialNumber']?._value
              || d['_deviceId']?.SerialNumber
              || (d['_id'] || '').split('-').slice(2).join('-')
              || '?'
          }))
        }
      });
    }

    const signal = genieacs.extractSignalInfo(device);
    const wifi   = genieacs.extractWifiInfo(device);

    res.json({
      success: true,
      data: {
        device_id:    device['_id'] || '',
        serial:       customer.ont_sn,
        model:        device['DeviceID.ProductClass']?._value || '—',
        manufacturer: device['DeviceID.Manufacturer']?._value || '—',
        online:       !!device['_lastInform'],
        uptime:       signal.uptime_str || '—',
        wan_ip:       signal.wan_ip    || null,
        rx_power:     signal.rx_power  || null,
        temperature:  signal.temperature || null,
        wifi: {
          ssid_2g:     wifi.ssid_2g     || null,
          password_2g: wifi.password_2g || null,
          ssid_5g:     wifi.ssid_5g     || null,
          password_5g: wifi.password_5g || null,
        }
      }
    });
  } catch (e) {
    logger.error('Portal wifiStatus error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── WIFI: Set SSID & Password ─────────────────────────────────
exports.wifiSet = async (req, res) => {
  try {
    const { ssid_2g, password_2g, ssid_5g, password_5g } = req.body;

    // Validasi minimal
    if (ssid_2g && ssid_2g.length > 32)
      return res.status(400).json({ success: false, message: 'Nama WiFi maksimal 32 karakter' });
    if (password_2g && password_2g.length < 8)
      return res.status(400).json({ success: false, message: 'Password WiFi minimal 8 karakter' });
    if (ssid_5g && ssid_5g.length > 32)
      return res.status(400).json({ success: false, message: 'Nama WiFi 5GHz maksimal 32 karakter' });
    if (password_5g && password_5g.length < 8)
      return res.status(400).json({ success: false, message: 'Password WiFi 5GHz minimal 8 karakter' });

    const customer = await Customer.findByPk(req.portalUser.id);
    if (!customer || !customer.ont_sn)
      return res.status(400).json({ success: false, message: 'ONT tidak terdaftar' });

    const wifiDevice = await findDeviceBySN(customer.ont_sn);
    if (!wifiDevice)
      return res.status(404).json({ success: false, message: 'ONT tidak ditemukan' });

    const deviceId   = wifiDevice['_id'];
    const parameters = [];

    // 2.4GHz
    if (ssid_2g) {
      parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', ssid_2g, 'xsd:string']);
    }
    if (password_2g) {
      parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', password_2g, 'xsd:string']);
      parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', password_2g, 'xsd:string']);
    }

    // 5GHz
    if (ssid_5g) {
      parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', ssid_5g, 'xsd:string']);
    }
    if (password_5g) {
      parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase', password_5g, 'xsd:string']);
      parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey', password_5g, 'xsd:string']);
    }

    if (!parameters.length)
      return res.status(400).json({ success: false, message: 'Tidak ada perubahan' });

    await genieacs.setParameterValues(deviceId, parameters);

    res.json({ success: true, message: 'Pengaturan WiFi berhasil disimpan. Modem akan update dalam beberapa detik.' });
    invalidateDeviceCache(customer.ont_sn);
  } catch (e) {
    logger.error('Portal wifiSet error:', e);
    res.status(500).json({ success: false, message: 'Gagal: ' + e.message });
  }
};

// ── ANNOUNCEMENTS: List aktif ─────────────────────────────────
exports.announcements = async (req, res) => {
  try {
    const { Announcement } = require('../models');
    const now = new Date();
    const rows = await Announcement.findAll({
      where: {
        is_active: true,
        [Op.and]: [
          { [Op.or]: [{ show_from: null }, { show_from: { [Op.lte]: now } }] },
          { [Op.or]: [{ show_until: null }, { show_until: { [Op.gte]: now } }] }
        ]
      },
      order: [
        // Gangguan & maintenance tampil duluan
        [sequelize.literal("FIELD(type,'gangguan','maintenance','info','promo')"), 'ASC'],
        ['created_at', 'DESC']
      ],
      limit: 5,
      attributes: ['id','title','content','type','show_until','created_at']
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    logger.error('Portal announcements error:', e);
    res.status(500).json({ success: false, data: [] });
  }
};

// ── PACKAGES: list aktif untuk upgrade ───────────────────────
exports.packageList = async (req, res) => {
  try {
    const packages = await Package.findAll({
      attributes: ['id','name','speed_down','speed_up','price','description','is_active'],
      order: [['price', 'ASC']]
    });
    // Filter di JS untuk hindari issue boolean MySQL
    const active = packages.filter(p => p.is_active === true || p.is_active === 1);
    res.json({ success: true, data: active, debug_total: packages.length });
  } catch (e) {
    logger.error('Portal packageList error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ── UPGRADE REQUEST: kirim permintaan ganti paket ────────────
// ── CHECK: apakah ada permintaan upgrade aktif ───────────────
exports.checkUpgradeStatus = async (req, res) => {
  try {
    const BLOCKED_STATUSES = ['open', 'in_progress', 'pending', 'assigned', 'on_hold'];
    const active = await Ticket.findOne({
      where: {
        customer_id: req.portalUser.id,
        type:        'request',
        status:      { [Op.in]: BLOCKED_STATUSES },
        title:       { [Op.like]: 'Request Upgrade Paket:%' }
      },
      attributes: ['id', 'ticket_number', 'title', 'status', 'created_at'],
      order: [['created_at', 'DESC']]
    });
    res.json({ success: true, blocked: !!active, ticket: active || null });
  } catch (e) {
    logger.error('Portal checkUpgradeStatus error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.requestUpgrade = async (req, res) => {
  try {
    const { package_id, package_name } = req.body;
    if (!package_id) return res.status(400).json({ success: false, message: 'package_id wajib' });

    const customer = await Customer.findByPk(req.portalUser.id, {
      include: [{ model: Package, as: 'package' }]
    });
    if (!customer) return res.status(404).json({ success: false });

    // Cek apakah sudah ada permintaan upgrade/ganti paket yang masih aktif
    const BLOCKED_STATUSES = ['open', 'in_progress', 'pending', 'assigned', 'on_hold'];
    const activeRequest = await Ticket.findOne({
      where: {
        customer_id: customer.id,
        type:        'request',
        status:      { [Op.in]: BLOCKED_STATUSES },
        title:       { [Op.like]: 'Request Upgrade Paket:%' }
      },
      order: [['created_at', 'DESC']]
    });

    if (activeRequest) {
      return res.status(409).json({
        success: false,
        blocked: true,
        message: `Permintaan ganti paket sebelumnya (${activeRequest.ticket_number}) masih dalam proses dengan status "${activeRequest.status}". Tunggu hingga selesai sebelum mengajukan permintaan baru.`,
        existing_ticket: {
          ticket_number: activeRequest.ticket_number,
          status:        activeRequest.status,
          title:         activeRequest.title,
          created_at:    activeRequest.created_at
        }
      });
    }

    const companyName = await getSetting('company_name', 'ISP');
    const companyWa   = await getSetting('company_whatsapp', '');

    // Buat tiket otomatis sebagai request upgrade
    const ticket = await Ticket.create({
      title:       `Request Upgrade Paket: ${package_name}`,
      description: `Pelanggan ${customer.name} (${customer.customer_id}) mengajukan perubahan paket dari "${customer.package?.name || '-'}" ke "${package_name}".`,
      type:        'request',
      priority:    'medium',
      status:      'open',
      customer_id: customer.id,
      sla_hours:   48
    });

    // Notifikasi Telegram (event bisnis) — request upgrade oleh pelanggan via portal.
    try {
      require('../services/TelegramEvents').newTicket({
        ticketNo: ticket.ticket_number,
        ticketId: ticket.id,
        subject: ticket.title,
        type: ticket.type,
        status: ticket.status,
        priority: ticket.priority,
        slaHours: ticket.sla_hours,
        dueAt: ticket.due_at,
        customerName: customer.name,
        customerCode: customer.customer_id,
        createdBy: `${customer.name} (Pelanggan via Portal)`,
        description: ticket.description,
        createdAt: ticket.created_at || ticket.createdAt,
      }).catch(() => {});
    } catch (_) {}

    // Jika ada WA, buka juga WA sebagai notif ke admin
    const waMsg = encodeURIComponent(
      `[UPGRADE PAKET]\nNama: ${customer.name}\nID: ${customer.customer_id}\nPaket saat ini: ${customer.package?.name || '-'}\nPaket baru: ${package_name}\nNo HP: ${customer.phone || '-'}\n\nMohon diproses. Terima kasih.`
    );
    const waUrl = companyWa
      ? `https://wa.me/${companyWa.replace(/[^0-9]/g, '')}?text=${waMsg}` : null;

    res.json({
      success: true,
      message: `Permintaan upgrade ke "${package_name}" berhasil dikirim. Tim kami akan segera menghubungi Anda.`,
      ticket_number: ticket.ticket_number,
      wa_url: waUrl
    });
  } catch (e) {
    logger.error('Portal requestUpgrade error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
// ════════════════════════════════════════════════════════════════════
// PUBLIC INVOICE PAYMENT (TANPA LOGIN)
// ────────────────────────────────────────────────────────────────────
// Dipakai oleh halaman public invoice /pub/invoice/:token yang dibuka
// pelanggan dari link reminder WA. Tidak butuh portalAuth — otorisasi
// dilakukan lewat HMAC token invoice (verifyInvoiceToken). Pelanggan bisa
// langsung bayar tanpa harus login ke portal.
//
// Reuse penuh logika gateway via services/PublicPaymentService — merchant_ref
// memakai format INV-{id}-{ts} yang IDENTIK dgn jalur portal, sehingga webhook
// gateway yang sudah ada (tripayNotif/duitkuNotif/midtransNotif/xenditNotif)
// otomatis me-rekonsiliasi pembayaran tanpa bergantung pada sesi login.
// ════════════════════════════════════════════════════════════════════

// Helper: resolve invoice (+customer) dari HMAC token. Return { invoice, customer }
// atau null kalau token invalid / invoice tidak ditemukan.
async function _resolveInvoiceFromToken(token) {
  const { verifyInvoiceToken } = require('../utils/templateHelper');
  const invoiceId = verifyInvoiceToken(token);
  if (!invoiceId) return null;
  const invoice = await Invoice.findByPk(invoiceId);
  if (!invoice) return null;
  const customer = await Customer.findByPk(invoice.customer_id, {
    include: [{ model: Package, as: 'package' }]
  });
  if (!customer) return null;
  return { invoice, customer };
}

// ── PUBLIC: list channel Tripay (untuk halaman invoice publik) ──────
// GET /pub/invoice/:token/tripay-channels
// Token tetap diverifikasi supaya endpoint tidak bisa dipakai sembarangan.
exports.publicTripayChannels = async (req, res) => {
  try {
    const resolved = await _resolveInvoiceFromToken(req.params.token);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Link invoice tidak valid' });
    }
    const PublicPaymentService = require('../services/PublicPaymentService');
    const out = await PublicPaymentService.getTripayChannels();
    if (!out.success) return res.status(out.http || 400).json({ success: false, message: out.message });
    return res.json(out);
  } catch (e) {
    logger.error('publicTripayChannels error: ' + (e.message || e));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUBLIC: buat transaksi pembayaran (untuk halaman invoice publik) ─
// POST /pub/invoice/:token/pay   body: { tripay_method? }
exports.publicPay = async (req, res) => {
  try {
    const resolved = await _resolveInvoiceFromToken(req.params.token);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Link invoice tidak valid' });
    }
    const { invoice, customer } = resolved;

    // Hanya invoice yang masih harus dibayar
    if (!['unpaid', 'overdue'].includes(invoice.status)) {
      return res.status(400).json({ success: false, code: 'ALREADY_PAID', message: 'Invoice ini sudah lunas atau tidak bisa dibayar.' });
    }
    // Guard tambahan: kalau total pembayaran tercatat sudah menutupi tagihan
    // (status mungkin belum ter-update), tetap tolak supaya tidak dobel bayar.
    try {
      const [sumRow] = await sequelize.query(
        `SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE invoice_id = :id`,
        { replacements: { id: invoice.id }, type: sequelize.QueryTypes.SELECT }
      );
      const paid  = parseFloat(sumRow && sumRow.paid || 0);
      const total = parseFloat(invoice.total || 0);
      if (total > 0 && paid >= total) {
        return res.status(400).json({ success: false, code: 'ALREADY_PAID', message: 'Invoice ini sudah dibayar.' });
      }
    } catch (_) { /* non-fatal — lanjut, status check di atas sudah jadi guard utama */ }

    const baseUrl = process.env.BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const PublicPaymentService = require('../services/PublicPaymentService');

    // ── Mode Manual (konfirmasi via WhatsApp) ────────────────────
    // Dipakai tombol "Konfirmasi via WhatsApp" di halaman publik (transfer
    // bank / e-wallet / QRIS). Tidak membuat transaksi gateway, hanya
    // mengembalikan URL WA berisi detail tagihan.
    const reqMode = (req.body && req.body.mode || '').toLowerCase();
    if (reqMode === 'manual') {
      const waUrl = await PublicPaymentService.buildManualWaUrl(customer, invoice);
      if (!waUrl) {
        return res.json({ success: false, message: 'Nomor WhatsApp CS belum disetel. Hubungi admin.' });
      }
      return res.json({ success: true, mode: 'manual', wa_url: waUrl, message: 'Buka WhatsApp untuk konfirmasi' });
    }

    // ── Mode Gateway (Bayar Online) ──────────────────────────────
    // Pelanggan publik belum login → arahkan balik ke halaman invoice publik
    // (BUKAN /portal/payment/finish yang butuh token). Halaman invoice akan
    // refresh & menampilkan status "LUNAS" setelah webhook gateway memproses.
    const returnPath = `/pub/invoice/${encodeURIComponent(req.params.token)}`;
    const out = await PublicPaymentService.createGatewayTransaction({
      customer, invoice,
      tripayMethod: req.body && req.body.tripay_method,
      baseUrl, returnPath
    });
    if (!out.success) {
      return res.status(out.http || 400).json({ success: false, code: out.code, message: out.message });
    }
    // Log aktivitas (best-effort) untuk audit
    try {
      const { ActivityLog } = require('../models');
      await ActivityLog.create({
        user_id: null, action: 'public_pay_init', module: 'billing',
        description: `Customer init pembayaran publik ${out.mode} untuk invoice ${invoice.invoice_number}`,
        target_type: 'invoice', target_id: invoice.id
      });
    } catch (_) { /* non-fatal */ }
    return res.json(out);
  } catch (e) {
    logger.error('publicPay error: ' + (e.message || e));
    return res.status(500).json({ success: false, message: 'Gagal membuat transaksi: ' + e.message });
  }
};

// ── PUBLIC: status invoice (untuk polling halaman finish) ───────────
// GET /pub/invoice/:token/status
exports.publicInvoiceStatus = async (req, res) => {
  try {
    const resolved = await _resolveInvoiceFromToken(req.params.token);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Link invoice tidak valid' });
    }
    const inv = resolved.invoice;
    return res.json({ success: true, data: { id: inv.id, status: inv.status, paid_date: inv.paid_date, verification_status: inv.verification_status || 'none' } });
  } catch (e) {
    logger.error('publicInvoiceStatus error: ' + (e.message || e));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── PUBLIC: submit bukti pembayaran (jalur transfer MANUAL) ─────────
// POST /pub/invoice/:token/proof  (multipart: field "proof")
// Set verification_status='submitted' + simpan path bukti. TIDAK mengubah
// invoice.status — admin yang verifikasi & menandai lunas. Gateway tidak
// lewat sini sama sekali.
exports.publicSubmitProof = async (req, res) => {
  try {
    const resolved = await _resolveInvoiceFromToken(req.params.token);
    if (!resolved) {
      // Hapus file yatim kalau token invalid
      if (req.file && req.file.path) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} }
      return res.status(404).json({ success: false, message: 'Link invoice tidak valid' });
    }
    const { invoice, customer } = resolved;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'File bukti tidak ditemukan' });
    }

    // Tolak kalau invoice sudah lunas / dibatalkan — tidak perlu bukti.
    if (!['unpaid', 'overdue'].includes(invoice.status)) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ success: false, code: 'ALREADY_PAID', message: 'Invoice ini sudah tidak perlu pembayaran.' });
    }

    // Hapus bukti lama (kalau pelanggan upload ulang) supaya tidak menumpuk.
    if (invoice.proof_path) {
      try {
        const old = require('path').join(__dirname, '..', '..', invoice.proof_path.replace(/^\/+/, ''));
        if (require('fs').existsSync(old)) require('fs').unlinkSync(old);
      } catch (_) {}
    }

    // Simpan path relatif (dari root project) — TIDAK di-serve publik.
    const relPath = 'uploads/payment_proofs/' + require('path').basename(req.file.path);
    const note = (req.body && typeof req.body.note === 'string') ? req.body.note.slice(0, 255) : null;

    await invoice.update({
      verification_status: 'submitted',
      proof_path: relPath,
      proof_submitted_at: new Date(),
      proof_note: note
    });

    // Audit log (best-effort)
    try {
      const { ActivityLog } = require('../models');
      await ActivityLog.create({
        user_id: null, action: 'public_proof_submit', module: 'billing',
        description: `Bukti pembayaran diunggah untuk invoice ${invoice.invoice_number} (${customer.name})`,
        target_type: 'invoice', target_id: invoice.id
      });
    } catch (_) {}

    // Notifikasi admin via WA (best-effort, tidak blok response)
    try {
      const PublicPaymentService = require('../services/PublicPaymentService');
      if (typeof PublicPaymentService.notifyAdminProofSubmitted === 'function') {
        PublicPaymentService.notifyAdminProofSubmitted(customer, invoice).catch(() => {});
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Bukti pembayaran terkirim. Menunggu verifikasi admin.',
      data: { verification_status: 'submitted' }
    });
  } catch (e) {
    if (req.file && req.file.path) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} }
    logger.error('publicSubmitProof error: ' + (e.message || e));
    return res.status(500).json({ success: false, message: 'Gagal mengunggah bukti: ' + e.message });
  }
};
