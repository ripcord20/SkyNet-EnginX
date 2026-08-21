/**
 * ResellerPromo.js — Promo/bonus top-up untuk reseller (#10).
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin membuat kode promo. Saat reseller top-up & memasukkan kode (atau
 * promo auto-apply), reseller dapat bonus saldo.
 *
 * type:
 *   - 'percent' : bonus = amount * (value/100), dibatasi max_bonus (bila >0)
 *   - 'fixed'   : bonus = value (Rupiah), diberi bila amount >= min_topup
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResellerPromo = sequelize.define('ResellerPromo', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    // Kode promo (huruf besar, unik). Kosong + auto_apply = promo otomatis.
    code: { type: DataTypes.STRING(40), allowNull: true, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    type: { type: DataTypes.ENUM('percent', 'fixed'), allowNull: false, defaultValue: 'percent' },
    // Nilai bonus: persen (untuk 'percent') atau rupiah (untuk 'fixed').
    value: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    // Minimal nominal top-up agar promo berlaku.
    min_topup: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    // Batas bonus maksimal (untuk type 'percent'). 0 = tanpa batas.
    max_bonus: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    // Diterapkan otomatis tanpa kode (mis. "semua top-up bulan ini +5%").
    auto_apply: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Batas pemakaian total & per reseller. 0 = tak terbatas.
    quota_total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    quota_per_reseller: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    used_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Masa berlaku.
    starts_at: { type: DataTypes.DATE, allowNull: true },
    ends_at: { type: DataTypes.DATE, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
  }, {
    tableName: 'reseller_promos',
    timestamps: true,
    indexes: [{ fields: ['code'] }, { fields: ['is_active'] }, { fields: ['auto_apply'] }]
  });

  return ResellerPromo;
};
