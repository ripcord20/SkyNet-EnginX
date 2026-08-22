/**
 * companyInfo.js
 * Helper terpusat untuk mengambil identitas perusahaan/ISP dari halaman Settings
 * (tabel `app_settings`), dengan fallback berjenjang:
 *   1. `app_name`        ← diisi dari halaman /settings (Tampilan & Brand)
 *   2. `company_name`    ← diisi dari halaman /settings (Umum)
 *   3. env COMPANY_NAME / APP_NAME
 *   4. 'ISP Provider' (default akhir)
 *
 * Pakai cache in-memory TTL 30 detik supaya tidak query DB setiap kali render
 * template/preview WA. Bila admin mengubah nama lewat halaman settings, dalam
 * <=30 detik perubahan akan ikut ter-apply ke semua template WA.
 *
 * Dipakai oleh:
 *   - WaFeaturesController (preview, kirim reminder, testSend)
 *   - WAController         (cron reminder invoice)
 *   - BillingController    (sendReminder per invoice)
 *   - CustomerController   (welcome message saat tambah pelanggan)
 *   - IsolirService        (notifikasi isolir / restore)
 */
const { AppSetting } = require('../models');

let _cache = { value: null, expires: 0 };
const TTL_MS = 30 * 1000; // 30 detik

async function _readFromDb() {
  try {
    const rows = await AppSetting.findAll({
      where: { key: ['app_name', 'company_name'] },
      attributes: ['key', 'value']
    });
    const map = {};
    for (const r of rows) map[r.key] = (r.value || '').trim();
    // app_name diprioritaskan (judul aplikasi di sidebar), lalu company_name
    return map.app_name || map.company_name || '';
  } catch (e) {
    // DB belum siap / tabel belum migrate — fallback ke env
    return '';
  }
}

/**
 * Ambil nama perusahaan yang aktif (async, dengan cache).
 * @returns {Promise<string>}
 */
async function getCompanyName() {
  const now = Date.now();
  if (_cache.value !== null && now < _cache.expires) return _cache.value;

  const fromDb = await _readFromDb();
  const value  = fromDb
    || process.env.COMPANY_NAME
    || process.env.APP_NAME
    || 'ISP Provider';

  _cache = { value, expires: now + TTL_MS };
  return value;
}

/**
 * Reset cache — dipanggil setelah admin save halaman settings supaya
 * perubahan langsung ter-apply tanpa menunggu TTL habis.
 */
function clearCompanyNameCache() {
  _cache = { value: null, expires: 0 };
}

/**
 * Versi sinkron (best-effort) — kalau cache sudah terisi pakai cache,
 * kalau belum pakai env / default. Hanya dipakai oleh kode lama yang
 * tidak bisa di-await (mis. di dalam Object.assign).
 */
function getCompanyNameSync() {
  if (_cache.value !== null) return _cache.value;
  return process.env.COMPANY_NAME || process.env.APP_NAME || 'ISP Provider';
}

module.exports = {
  getCompanyName,
  getCompanyNameSync,
  clearCompanyNameCache,
};
