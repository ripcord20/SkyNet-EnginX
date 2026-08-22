/**
 * IsolirPublicController.js
 * ──────────────────────────────────────────────────────────────────
 * Controller untuk halaman publik /p/isolir.
 *
 * DESAIN: Halaman GLOBAL (generik) — tidak ada lookup customer.
 * Halaman cuma menampilkan:
 *   - Brand info (logo, nama)
 *   - Pesan pemberitahuan (judul, subtitle dari Pengaturan)
 *   - Rekening pembayaran (dari Settings)
 *   - CTA ke portal pelanggan + WhatsApp admin
 *
 * Pelanggan login ke portal sendiri untuk lihat detail tagihan & bayar.
 *
 * Keuntungan vs lookup approach:
 *   - Zero DB query untuk customer
 *   - Zero query MikroTik
 *   - Robust di semua topology (double NAT, PPPoE dinamis, dll)
 *   - Cacheable
 *   - Tidak perlu maintain data static_ip / pppoe_username / ont_mac
 *     untuk identifikasi halaman isolir
 * ──────────────────────────────────────────────────────────────────
 */

const { AppSetting } = require('../models');
const logger = require('../utils/logger');

async function getSetting(key, fallback = '') {
  try {
    const s = await AppSetting.findOne({ where: { key } });
    return s ? (s.value || fallback) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeIp(rawIp, xff) {
  let ip = String(rawIp || '').trim();
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) ip = first;
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(':')[0];
  return ip;
}

/**
 * GET /p/isolir
 * Render halaman pemberitahuan isolir (global, tanpa lookup).
 */
exports.renderPage = async (req, res) => {
  const xff = req.headers['x-forwarded-for'] || '';
  const clientIp = normalizeIp(req.ip || req.connection?.remoteAddress || '', xff);

  // ── Ambil brand & customisasi halaman ──
  const [
    companyName, appName, logoUrl, companyWa,
    pageTitle, pageSubtitle, pageColor,
    pageFooter, pageHelpText
  ] = await Promise.all([
    getSetting('company_name', ''),
    getSetting('app_name', ''),
    getSetting('logo_url', ''),
    getSetting('company_whatsapp', ''),
    getSetting('isolir_page_title', ''),
    getSetting('isolir_page_subtitle', ''),
    getSetting('isolir_page_color', ''),
    getSetting('isolir_page_footer', ''),
    getSetting('isolir_page_help_text', ''),
  ]);

  const brand = {
    company_name:     companyName,
    app_name:         appName,
    logo_url:         logoUrl,
    company_whatsapp: companyWa,
  };
  const pageConfig = {
    title:     pageTitle,
    subtitle:  pageSubtitle,
    color:     pageColor,
    footer:    pageFooter,
    help_text: pageHelpText,
  };

  // Anti-cache: pelanggan yang sudah dipulihkan tetap dapat halaman
  // refresh, tidak ke-cache halaman lama.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  res.status(200).render('pages/isolir-public', {
    title:    'Layanan Terisolir',
    appName:  appName || companyName || 'ISP NetOps',
    brand,
    pageConfig,
    clientIp,
    layout:   false,
  });
};

/**
 * GET /p/isolir/payment-accounts
 * Public read-only list rekening pembayaran.
 * Dipakai client JS untuk render daftar bank/e-wallet/QRIS.
 */
exports.getPaymentAccounts = async (req, res) => {
  try {
    const row = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
    let list = [];
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) {
          list = parsed
            .filter(a => a && a.is_active !== false)
            .map(a => ({
              type:           a.type || 'bank',
              provider:       a.provider || '',
              account_number: a.account_number || '',
              account_owner:  a.account_owner || '',
              logo_url:       a.logo_url || '',
            }));
        }
      } catch { list = []; }
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ accounts: list });
  } catch (e) {
    logger.warn(`[payment-accounts] error: ${e.message}`);
    res.json({ accounts: [] });
  }
};
