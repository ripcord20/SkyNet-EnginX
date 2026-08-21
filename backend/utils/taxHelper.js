'use strict';

/**
 * Tax (PPN) Helper
 *
 * Single source of truth untuk perhitungan PPN. Dipakai di:
 *  - BillingController saat generate invoice
 *  - PaymentController saat render invoice-data ke client
 *  - Frontend lewat endpoint /app-settings/tax
 *
 * Settings keys di app_settings table:
 *  - tax_enabled  : '1' | '0'           (default: '0')
 *  - tax_rate     : string number e.g. '11' atau '12' (% dalam persen, default: '11')
 *  - tax_mode     : 'exclusive' | 'inclusive' (default: 'exclusive')
 *  - tax_label    : label custom untuk invoice, default 'PPN'
 */

const DEFAULTS = Object.freeze({
  enabled: false,
  rate:    11,           // 11% — PPN standar Indonesia 2022+
  mode:    'exclusive',  // harga paket dianggap belum termasuk PPN
  label:   'PPN'
});

/**
 * Load tax settings dari DB. Cache singkat 30 detik agar tidak hit DB tiap generate invoice.
 */
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 30_000;

async function loadTaxSettings(force = false) {
  if (!force && _cache && (Date.now() - _cacheAt < CACHE_MS)) {
    return _cache;
  }
  try {
    const { AppSetting } = require('../models');
    const rows = await AppSetting.findAll({
      where: { key: ['tax_enabled', 'tax_rate', 'tax_mode', 'tax_label'] }
    });
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });

    const cfg = {
      enabled: String(map.tax_enabled || '') === '1' || String(map.tax_enabled || '').toLowerCase() === 'true',
      rate:    Number.isFinite(parseFloat(map.tax_rate)) ? parseFloat(map.tax_rate) : DEFAULTS.rate,
      mode:    (map.tax_mode === 'inclusive') ? 'inclusive' : DEFAULTS.mode,
      label:   (map.tax_label && String(map.tax_label).trim()) || DEFAULTS.label
    };
    // Clamp rate 0..100
    if (cfg.rate < 0) cfg.rate = 0;
    if (cfg.rate > 100) cfg.rate = 100;

    _cache = cfg;
    _cacheAt = Date.now();
    return cfg;
  } catch (_) {
    return { ...DEFAULTS };
  }
}

/** Reset cache (dipanggil setelah saveSettings) */
function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Hitung breakdown PPN dari harga paket.
 *
 * @param {number} price — harga dasar (dari packages.price atau invoice.amount)
 * @param {object} cfg   — { enabled, rate, mode, label }
 * @returns {object} { subtotal, tax, total, rate, label, applied }
 *
 * Mode 'exclusive': price adalah subtotal sebelum pajak.
 *   subtotal = price
 *   tax      = round(price * rate / 100)
 *   total    = subtotal + tax
 *
 * Mode 'inclusive': price adalah harga akhir yang sudah termasuk pajak.
 *   total    = price
 *   tax      = round(price * rate / (100 + rate))
 *   subtotal = total - tax
 */
function computeTax(price, cfg = DEFAULTS) {
  const p = Math.max(0, parseFloat(price) || 0);
  const rate = Number.isFinite(cfg.rate) ? cfg.rate : DEFAULTS.rate;
  const label = cfg.label || DEFAULTS.label;

  if (!cfg.enabled || rate <= 0) {
    return { subtotal: p, tax: 0, total: p, rate: 0, label, applied: false };
  }

  let subtotal, tax, total;
  if (cfg.mode === 'inclusive') {
    total    = p;
    tax      = Math.round(p * rate / (100 + rate));
    subtotal = total - tax;
  } else {
    subtotal = p;
    tax      = Math.round(p * rate / 100);
    total    = subtotal + tax;
  }
  return { subtotal, tax, total, rate, label, applied: true };
}

module.exports = {
  DEFAULTS,
  loadTaxSettings,
  invalidateCache,
  computeTax,
  applyCurrentTaxSetting,
  applyTaxToInvoiceList
};

/**
 * Override field tax/total dari sebuah invoice (atau plain object) berdasarkan
 * setting PPN saat ini. Mutasi non-destructive — kembalikan plain object baru
 * dengan field tax/total yang sudah disesuaikan.
 *
 * Tujuan: ketika user menonaktifkan PPN di settings, semua invoice (lama & baru)
 * harus tampil tanpa pajak — tanpa harus mengubah data historis di DB.
 *
 * Behavior:
 *   - enabled=false → paksa tax=0, total=amount (subtotal). Field amount tidak diubah.
 *   - enabled=true  → biarkan kolom DB apa adanya (sumber kebenaran tetap DB).
 *
 * Bekerja untuk:
 *   - Sequelize instance (panggil .toJSON() dulu)
 *   - Plain object dari raw query (pakai field invoice_amount/invoice_tax/invoice_total)
 *   - Plain object dari Invoice.findAll (pakai field amount/tax/total)
 *
 * @param {object} inv      Invoice object atau raw row
 * @param {object} taxCfg   Output dari loadTaxSettings() — boleh dipre-load di caller
 * @returns {object}        Object baru dengan field tax/total yang sudah override
 */
function applyCurrentTaxSetting(inv, taxCfg) {
  if (!inv) return inv;
  const cfg = taxCfg || _cache || DEFAULTS;
  // Kalau Sequelize instance, convert ke plain
  const obj = (typeof inv.toJSON === 'function') ? inv.toJSON() : { ...inv };

  if (cfg.enabled) {
    // PPN aktif — biarkan data DB apa adanya
    return obj;
  }

  // PPN nonaktif — paksa tax=0, total=amount. Lakukan untuk kedua naming convention.
  // Naming standar (model Invoice): amount, tax, total
  if ('amount' in obj || 'tax' in obj || 'total' in obj) {
    const amt = parseFloat(obj.amount || 0);
    obj.tax   = 0;
    obj.total = amt > 0 ? amt : (parseFloat(obj.total || 0));
  }
  // Naming raw query (PaymentController): invoice_amount, invoice_tax, invoice_total
  if ('invoice_amount' in obj || 'invoice_tax' in obj || 'invoice_total' in obj) {
    const subAmt = parseFloat(obj.invoice_amount || 0);
    obj.invoice_tax   = 0;
    obj.invoice_total = subAmt > 0 ? subAmt : (parseFloat(obj.invoice_total || 0));
    obj.invoice_subtotal = subAmt > 0 ? subAmt : obj.invoice_subtotal;
    obj.tax_applied = false;
  }
  return obj;
}

/**
 * Convenience: apply ke array invoice (hasil findAll dll). Memanggil
 * loadTaxSettings sekali, lalu loop. Aman jika input bukan array.
 */
async function applyTaxToInvoiceList(invoices) {
  if (!Array.isArray(invoices)) return invoices;
  const cfg = await loadTaxSettings();
  return invoices.map(i => applyCurrentTaxSetting(i, cfg));
}