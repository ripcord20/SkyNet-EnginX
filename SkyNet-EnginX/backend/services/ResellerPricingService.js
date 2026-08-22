/**
 * ResellerPricingService.js — Resolusi harga modal efektif per reseller (#2).
 * ─────────────────────────────────────────────────────────────────────────────
 * Harga modal (cost_price) = nilai yang dipotong dari saldo reseller tiap
 * generate 1 voucher. Urutan prioritas:
 *
 *   1) Override paket spesifik  → reseller_package_prices.cost_price
 *   2) Diskon global reseller   → cost_price * (1 - price_discount_percent/100)
 *   3) cost_price default paket
 *
 * Harga jual (sell_price) ke end-customer tetap dari paket (tidak di-markup
 * di sini) — itu yang tercetak di voucher. Markup hanya pada sisi MODAL,
 * sehingga margin admin = (cost_price default - cost efektif reseller) bila ada
 * diskon, atau admin bisa menaikkan cost efektif > default untuk untung lebih.
 */
const { ResellerPackagePrice } = require('../models');

const ResellerPricingService = {
  /**
   * Hitung harga modal efektif untuk satu paket bagi satu reseller.
   * @param {object} reseller  - instance/objek Reseller (perlu id + price_discount_percent)
   * @param {object} pkg       - instance ResellerVoucherPackage (perlu id + cost_price)
   * @param {ResellerPackagePrice|null} override - opsional, bila sudah di-fetch
   * @returns {Promise<{ effective:number, base:number, source:string }>}
   */
  async effectiveCost(reseller, pkg, override = undefined) {
    const base = Number(pkg.cost_price) || 0;

    // 1) Override spesifik paket
    let ovr = override;
    if (ovr === undefined) {
      ovr = await ResellerPackagePrice.findOne({
        where: { reseller_id: reseller.id, package_id: pkg.id }
      });
    }
    if (ovr) {
      return { effective: Number(ovr.cost_price) || 0, base, source: 'override' };
    }

    // 2) Diskon global reseller
    const disc = Number(reseller.price_discount_percent) || 0;
    if (disc > 0) {
      const eff = Math.max(0, Math.round(base * (1 - disc / 100)));
      return { effective: eff, base, source: 'discount' };
    }

    // 3) Default paket
    return { effective: base, base, source: 'default' };
  },

  /**
   * Versi batch: kembalikan map { package_id: {effective, base, source} }
   * untuk seluruh paket aktif milik reseller. Hanya 1 query override.
   */
  async effectiveCostMap(reseller, packages) {
    const overrides = await ResellerPackagePrice.findAll({
      where: { reseller_id: reseller.id }
    });
    const ovrMap = {};
    overrides.forEach(o => { ovrMap[o.package_id] = o; });

    const out = {};
    for (const pkg of packages) {
      out[pkg.id] = await this.effectiveCost(reseller, pkg, ovrMap[pkg.id] || null);
    }
    return out;
  }
};

module.exports = ResellerPricingService;
