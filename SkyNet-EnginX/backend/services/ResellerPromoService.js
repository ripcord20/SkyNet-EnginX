/**
 * ResellerPromoService.js — Logika promo/bonus top-up reseller (#10).
 * ─────────────────────────────────────────────────────────────────────────────
 * - validate(code, reseller, amount) → cek kode + kuota + masa berlaku,
 *   kembalikan { ok, promo, bonus, message }.
 * - bestAutoPromo(reseller, amount)  → cari promo auto_apply terbaik (bonus
 *   terbesar) bila reseller tidak memasukkan kode.
 * - recordRedemption(...)            → catat pemakaian (dipanggil saat kredit).
 *
 * Catatan: penegakan kuota final dilakukan saat redemption dicatat (atomik
 * di dalam transaksi creditTopup) untuk menghindari race.
 */
const { Op } = require('sequelize');
const {
  ResellerPromo, ResellerPromoRedemption
} = require('../models');

function computeBonus(promo, amount) {
  amount = Number(amount) || 0;
  if (amount < Number(promo.min_topup || 0)) return 0;
  let bonus = 0;
  if (promo.type === 'percent') {
    bonus = Math.round(amount * (Number(promo.value) / 100));
    const cap = Number(promo.max_bonus || 0);
    if (cap > 0) bonus = Math.min(bonus, cap);
  } else { // fixed
    bonus = Number(promo.value) || 0;
  }
  return Math.max(0, bonus);
}

function isWithinPeriod(promo, now = new Date()) {
  if (promo.starts_at && now < new Date(promo.starts_at)) return false;
  if (promo.ends_at && now > new Date(promo.ends_at)) return false;
  return true;
}

const ResellerPromoService = {
  computeBonus,

  /** Validasi kode promo untuk satu reseller + nominal top-up. */
  async validate(code, reseller, amount) {
    if (!code) return { ok: false, message: 'Kode promo kosong' };
    const promo = await ResellerPromo.findOne({ where: { code: String(code).trim().toUpperCase() } });
    if (!promo || !promo.is_active) return { ok: false, message: 'Kode promo tidak valid' };
    if (!isWithinPeriod(promo)) return { ok: false, message: 'Promo tidak dalam masa berlaku' };
    if (amount < Number(promo.min_topup || 0)) {
      return { ok: false, message: `Minimal top-up Rp ${Number(promo.min_topup).toLocaleString('id-ID')} untuk promo ini` };
    }
    // Kuota total
    if (promo.quota_total > 0 && promo.used_count >= promo.quota_total) {
      return { ok: false, message: 'Kuota promo sudah habis' };
    }
    // Kuota per reseller
    if (promo.quota_per_reseller > 0) {
      const used = await ResellerPromoRedemption.count({
        where: { promo_id: promo.id, reseller_id: reseller.id }
      });
      if (used >= promo.quota_per_reseller) {
        return { ok: false, message: 'Anda sudah memakai promo ini' };
      }
    }
    const bonus = computeBonus(promo, amount);
    if (bonus <= 0) return { ok: false, message: 'Promo tidak memberi bonus untuk nominal ini' };
    return { ok: true, promo, bonus, message: `Bonus Rp ${bonus.toLocaleString('id-ID')}` };
  },

  /** Cari promo auto_apply terbaik (tanpa kode) untuk reseller + nominal. */
  async bestAutoPromo(reseller, amount) {
    const promos = await ResellerPromo.findAll({
      where: { auto_apply: true, is_active: true }
    });
    let best = null;
    for (const p of promos) {
      if (!isWithinPeriod(p)) continue;
      if (amount < Number(p.min_topup || 0)) continue;
      if (p.quota_total > 0 && p.used_count >= p.quota_total) continue;
      if (p.quota_per_reseller > 0) {
        const used = await ResellerPromoRedemption.count({ where: { promo_id: p.id, reseller_id: reseller.id } });
        if (used >= p.quota_per_reseller) continue;
      }
      const bonus = computeBonus(p, amount);
      if (bonus > 0 && (!best || bonus > best.bonus)) best = { promo: p, bonus };
    }
    return best; // { promo, bonus } | null
  },

  /**
   * Catat redemption + naikkan used_count. WAJIB dipanggil di dalam transaksi
   * yang sama dengan kredit saldo (lewat param `transaction`).
   */
  async recordRedemption({ promo_id, reseller_id, topup_id, transaction_id, topup_amount, bonus_amount }, transaction) {
    await ResellerPromoRedemption.create({
      promo_id, reseller_id, topup_id, transaction_id,
      topup_amount, bonus_amount
    }, { transaction });
    await ResellerPromo.increment('used_count', { by: 1, where: { id: promo_id }, transaction });
  }
};

module.exports = ResellerPromoService;
