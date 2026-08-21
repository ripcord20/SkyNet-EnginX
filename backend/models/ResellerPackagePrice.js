/**
 * ResellerPackagePrice.js — Override harga modal per reseller per paket (#2).
 * ─────────────────────────────────────────────────────────────────────────────
 * Bila ada baris di sini untuk (reseller_id, package_id), maka cost_price
 * paket DI-OVERRIDE oleh `cost_price` ini khusus untuk reseller tsb.
 *
 * Urutan penentuan harga modal saat generate (lihat ResellerController.generate):
 *   1) Override paket spesifik (tabel ini)            ← prioritas tertinggi
 *   2) Diskon global reseller (Reseller.price_discount_percent)
 *   3) cost_price paket (default)                     ← fallback
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResellerPackagePrice = sequelize.define('ResellerPackagePrice', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    reseller_id: {
      type: DataTypes.INTEGER, allowNull: false,
      references: { model: 'resellers', key: 'id' }
    },
    package_id: {
      type: DataTypes.INTEGER, allowNull: false,
      references: { model: 'reseller_voucher_packages', key: 'id' }
    },
    // Harga modal khusus (Rupiah) yang dipotong dari saldo reseller.
    cost_price: {
      type: DataTypes.DECIMAL(12, 2), allowNull: false
    }
  }, {
    tableName: 'reseller_package_prices',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['reseller_id', 'package_id'] },
      { fields: ['reseller_id'] }
    ]
  });

  return ResellerPackagePrice;
};
