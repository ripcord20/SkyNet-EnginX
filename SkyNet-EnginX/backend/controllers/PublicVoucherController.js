/**
 * PublicVoucherController.js — Endpoint halaman publik beli voucher (/beli).
 * ─────────────────────────────────────────────────────────────────────────────
 * Tanpa authentication. Dipakai oleh routes/publicVoucher.js.
 *
 *   GET  /beli-voucher                  → render landing page
 *   GET  /beli-voucher/status/:code             → render halaman status order
 *   GET  /pub/voucher/packages          → daftar paket publik (JSON)
 *   GET  /pub/voucher/config            → konfigurasi pembayaran (JSON)
 *   GET  /pub/voucher/tripay-channels   → channel Tripay (JSON)
 *   POST /pub/voucher/order             → buat order (return order_code)
 *   POST /pub/voucher/:code/pay         → mulai pembayaran (gateway / manual)
 *   POST /pub/voucher/:code/proof       → upload bukti transfer manual
 *   GET  /pub/voucher/:code/status      → status order (JSON, untuk polling)
 *   POST /pub/voucher/webhook/duitku    → callback Duitku
 *   POST /pub/voucher/webhook/tripay    → callback Tripay
 */
const { PublicVoucherOrder, AppSetting } = require('../models');
const { Op } = require('sequelize');
const PublicVoucherService = require('../services/PublicVoucherService');
const PublicPaymentService = require('../services/PublicPaymentService');
const PublicVoucherWebhook = require('./PublicVoucherWebhookController');
const logger = require('../utils/logger');

// Helper: base URL absolut (untuk callback/return gateway).
function baseUrlOf(req) {
  const env = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  return `${req.protocol}://${req.get('host')}`;
}

// Helper: muat info brand untuk header/footer halaman.
async function loadBrand() {
  const keys = ['company_name', 'app_name', 'company_address', 'company_phone',
                'company_whatsapp', 'company_email', 'logo_url', 'app_tagline', 'favicon_url',
                'register_bg_url',
                'monthly_cta_enabled', 'monthly_cta_url', 'monthly_cta_text', 'monthly_cta_slides'];
  const rows = await AppSetting.findAll({ where: { key: { [Op.in]: keys } } });
  const m = {};
  rows.forEach(r => { m[r.key] = r.value; });
  const wa = (m.company_whatsapp || m.company_phone || '').replace(/[^0-9]/g, '');
  // CTA "Pasang WiFi Bulanan": default mengarah ke halaman pendaftaran pelanggan,
  // atau bila admin set monthly_cta_url, pakai itu (mis. link WA). Default aktif.
  const ctaEnabled = m.monthly_cta_enabled == null ? true
    : (m.monthly_cta_enabled === 'true' || m.monthly_cta_enabled === '1');
  let ctaUrl = (m.monthly_cta_url || '').trim();
  if (!ctaUrl) {
    if (wa) {
      const text = encodeURIComponent('Halo, saya mau tanya paket pasang WiFi internet bulanan.');
      ctaUrl = `https://wa.me/${wa}?text=${text}`;
    } else {
      ctaUrl = '/registrasi-layanan';
    }
  }
  return {
    name: (m.company_name || m.app_name || 'WiFi Voucher').trim(),
    tagline: (m.app_tagline || 'Beli voucher internet, instan & praktis').trim(),
    address: (m.company_address || '').trim(),
    phone: (m.company_phone || '').trim(),
    whatsapp: wa,
    email: (m.company_email || '').trim(),
    logo: (m.logo_url || '').trim(),
    favicon: (m.favicon_url || '').trim(),
    // Foto background header — sumber sama dengan halaman login reseller &
    // halaman pendaftaran pelanggan (app_setting `register_bg_url`).
    bg: (m.register_bg_url || '').trim(),
    monthlyCta: {
      enabled: ctaEnabled,
      url: ctaUrl,
      text: (m.monthly_cta_text || 'Pasang WiFi Bulanan').trim(),
      slides: buildMonthlySlides(m.monthly_cta_slides)
    }
  };
}

// Bangun daftar slide promo "Pasang WiFi Bulanan".
// Admin bisa override via app_setting `monthly_cta_slides` (JSON array of
// { icon, title, subtitle }). Kalau kosong/invalid → pakai default.
function buildMonthlySlides(raw) {
  const defaults = [
    { icon: 'home',     title: 'Mau Pasang WiFi Bulanan?',        subtitle: 'Internet unlimited di rumah & kantor. Hubungi kami →' },
    { icon: 'gift',     title: 'Gratis Biaya Instalasi',          subtitle: 'Pasang sekarang, tanpa biaya pemasangan. Terbatas →' },
    { icon: 'infinity', title: 'Internet Unlimited Tanpa Batas',  subtitle: 'Streaming & gaming sepuasnya, tanpa FUP →' },
    { icon: 'bolt',     title: 'Koneksi Stabil & Ngebut',         subtitle: 'Fiber optic cepat untuk keluarga & usaha →' }
  ];
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        return arr
          .filter(s => s && (s.title || s.subtitle))
          .map(s => ({
            icon: String(s.icon || 'home'),
            title: String(s.title || '').slice(0, 80),
            subtitle: String(s.subtitle || '').slice(0, 140)
          }));
      }
    } catch (_) { /* fallback ke default */ }
  }
  return defaults;
}

// ── GET /beli — landing page ────────────────────────────────────────
exports.renderLanding = async (req, res, next) => {
  try {
    const brand = await loadBrand();
    res.render('pages/beli-voucher', { title: `Beli Voucher — ${brand.name}`, brand });
  } catch (e) { next(e); }
};

// ── GET /beli-voucher/status/:code — halaman status order ───────────────────
exports.renderStatus = async (req, res, next) => {
  try {
    const brand = await loadBrand();
    res.render('pages/beli-voucher-status', {
      title: `Status Order — ${brand.name}`, brand, orderCode: req.params.code
    });
  } catch (e) { next(e); }
};

// ── GET /pub/voucher/packages ───────────────────────────────────────
exports.packages = async (req, res) => {
  try {
    const list = await PublicVoucherService.listPublicPackages();
    res.json({ success: true, data: list });
  } catch (e) {
    logger.error('[PubVoucher] packages:', e.message);
    res.status(500).json({ success: false, message: 'Gagal memuat paket' });
  }
};

// ── GET /pub/voucher/config ─────────────────────────────────────────
exports.config = async (req, res) => {
  try {
    const cfg = await PublicPaymentService.buildPaymentConfig();
    res.json({ success: true, data: cfg });
  } catch (e) {
    logger.error('[PubVoucher] config:', e.message);
    res.status(500).json({ success: false, message: 'Gagal memuat konfigurasi' });
  }
};

// ── GET /pub/voucher/tripay-channels ────────────────────────────────
exports.tripayChannels = async (req, res) => {
  try {
    const channels = await PublicPaymentService.getTripayChannels();
    res.json({ success: true, data: channels });
  } catch (e) {
    res.json({ success: true, data: [] });
  }
};

// ── POST /pub/voucher/order ─────────────────────────────────────────
exports.createOrder = async (req, res) => {
  try {
    const { package_id, buyer_name, buyer_email, buyer_wa, payment_method } = req.body || {};
    if (!package_id) return res.status(400).json({ success: false, message: 'Paket wajib dipilih' });
    if (!buyer_name || !String(buyer_name).trim()) {
      return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
    }
    if (!buyer_wa && !buyer_email) {
      return res.status(400).json({ success: false, message: 'Isi minimal No. WhatsApp atau Email untuk pengiriman voucher' });
    }
    if (buyer_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(buyer_email).trim())) {
      return res.status(400).json({ success: false, message: 'Format email tidak valid' });
    }
    const r = await PublicVoucherService.createOrder({ package_id, buyer_name, buyer_email, buyer_wa, payment_method });
    if (!r.success) return res.status(r.http || 400).json({ success: false, message: r.message });
    res.json({
      success: true,
      data: {
        order_code: r.order.order_code,
        amount: Number(r.order.amount),
        package_name: r.order.package_name,
        payment_method: r.order.payment_method
      }
    });
  } catch (e) {
    logger.error('[PubVoucher] createOrder:', e.message);
    res.status(500).json({ success: false, message: 'Gagal membuat order' });
  }
};

// Helper: resolve order pending dari :code.
async function findPendingOrder(code) {
  if (!code) return null;
  return PublicVoucherOrder.findOne({ where: { order_code: String(code).trim() } });
}

// ── POST /pub/voucher/:code/pay ─────────────────────────────────────
exports.pay = async (req, res) => {
  try {
    const order = await findPendingOrder(req.params.code);
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    if (order.status === 'delivered') {
      return res.json({ success: true, mode: 'done', message: 'Voucher sudah dikirim', order_code: order.order_code });
    }

    const mode = (req.body && req.body.mode) || (order.payment_method === 'manual' ? 'manual' : 'gateway');

    // ── Jalur MANUAL: kembalikan info rekening + URL konfirmasi WA ──
    if (mode === 'manual') {
      await order.update({ payment_method: 'manual' });
      const cfg = await PublicPaymentService.buildPaymentConfig();
      const waUrl = await PublicVoucherService.buildManualConfirmWaUrl(order);
      // Beritahu admin ada order manual baru (best-effort).
      PublicVoucherService.notifyAdminManualOrder(order).catch(() => {});
      return res.json({
        success: true, mode: 'manual',
        order_code: order.order_code,
        amount: Number(order.amount),
        payment_accounts: cfg.payment_accounts,
        wa_url: waUrl
      });
    }

    // ── Jalur GATEWAY otomatis ──
    const r = await PublicVoucherService.createVoucherGatewayTxn({
      order, tripayMethod: req.body && req.body.tripay_method, baseUrl: baseUrlOf(req)
    });
    if (!r.success) return res.status(r.http || 400).json(r);
    res.json(r);
  } catch (e) {
    logger.error('[PubVoucher] pay:', e.message);
    res.status(500).json({ success: false, message: 'Gagal memproses pembayaran' });
  }
};

// ── POST /pub/voucher/:code/proof — upload bukti transfer manual ────
exports.submitProof = async (req, res) => {
  try {
    const order = await findPendingOrder(req.params.code);
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Bukti transfer wajib diunggah' });
    await order.update({
      payment_method: 'manual',
      proof_path: 'payment_proofs/' + req.file.filename
    });
    PublicVoucherService.notifyAdminManualOrder(order).catch(() => {});
    res.json({ success: true, message: 'Bukti diterima. Voucher akan dikirim setelah admin verifikasi.' });
  } catch (e) {
    logger.error('[PubVoucher] submitProof:', e.message);
    res.status(500).json({ success: false, message: 'Gagal mengunggah bukti' });
  }
};

// ── GET /pub/voucher/:code/status — polling status ──────────────────
exports.status = async (req, res) => {
  try {
    const order = await PublicVoucherOrder.findOne({ where: { order_code: String(req.params.code || '').trim() } });
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

    // Order gateway yang belum selesai → cek langsung ke gateway (auto-deliver
    // tanpa menunggu webhook, berguna saat callback URL tak terjangkau/testing).
    if (order.payment_method === 'gateway' && (order.status === 'pending' || order.status === 'paid')) {
      try {
        await PublicVoucherService.checkGatewayStatus(order);
        await order.reload();
      } catch (_) { /* abaikan — tetap balikan status terakhir */ }
    }

    const out = {
      order_code: order.order_code,
      status: order.status,
      package_name: order.package_name,
      amount: Number(order.amount),
      buyer_name: order.buyer_name
    };
    // Voucher hanya dibuka kalau sudah delivered.
    if (order.status === 'delivered') {
      out.voucher = {
        username: order.voucher_username,
        password: order.voucher_password
      };
      out.delivered_wa = !!order.delivered_wa;
      out.delivered_email = !!order.delivered_email;
    }
    res.json({ success: true, data: out });
  } catch (e) {
    logger.error('[PubVoucher] status:', e.message);
    res.status(500).json({ success: false, message: 'Gagal memuat status' });
  }
};

// ── Webhooks (delegasi ke PublicVoucherWebhookController) ────────────
exports.webhookDuitku = PublicVoucherWebhook.duitku;
exports.webhookTripay = PublicVoucherWebhook.tripay;
