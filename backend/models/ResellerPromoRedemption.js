/**
 * ResellerPromoRedemption.js — Catatan pemakaian promo (#10).
 * ─────────────────────────────────────────────────────────────────────────────
 * Satu baris tiap kali promo dipakai pada sebuah top-up. Dipakai untuk
 * menegakkan quota_per_reseller & quota_total dan audit bonus yang diberikan.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResellerPromoRedemption = sequelize.define('ResellerPromoRedemption', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    promo_id: {
      type: DataTypes.INTEGER, allowNull: false,
      references: { model: 'reseller_promos', key: 'id' }
    },
    reseller_id: {
      type: DataTypes.INTEGER, allowNull: false,
      references: { model: 'resellers', key: 'id' }
    },
    topup_id: { type: DataTypes.INTEGER, allowNull: true },
    transaction_id: { type: DataTypes.INTEGER, allowNull: true },
    topup_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    bonus_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 }
  }, {
    tableName: 'reseller_promo_redemptions',
    timestamps: true,
    indexes: [
      { fields: ['promo_id'] },
      { fields: ['reseller_id'] },
      { fields: ['promo_id', 'reseller_id'] }
    ]
  });

  return ResellerPromoRedemption;
};
