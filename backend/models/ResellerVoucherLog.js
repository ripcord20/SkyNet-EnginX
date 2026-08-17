/**
 * ResellerVoucherLog.js — Audit/jejak voucher (#7).
 * ─────────────────────────────────────────────────────────────────────────────
 * Mencatat setiap voucher yang DIBUAT reseller (1 baris per voucher) supaya:
 *   - bisa dilacak siapa generate apa & kapan,
 *   - menelusuri sengketa "voucher tidak bisa dipakai",
 *   - laporan status terpakai/expired akurat per-voucher.
 *
 * Diisi saat generate sukses. Status default 'created' dan bisa diperbarui
 * (best-effort) saat sinkronisasi dengan MikroTik (used/expired/deleted).
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResellerVoucherLog = sequelize.define('ResellerVoucherLog', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    reseller_id: {
      type: DataTypes.INTEGER, allowNull: false,
      references: { model: 'resellers', key: 'id' }
    },
    // Transaksi pembelian (batch) tempat voucher ini dibuat.
    transaction_id: {
      type: DataTypes.INTEGER, allowNull: true,
      references: { model: 'reseller_transactions', key: 'id' }
    },
    package_id: { type: DataTypes.INTEGER, allowNull: true },
    package_name: { type: DataTypes.STRING(100), allowNull: true },
    username: { type: DataTypes.STRING(80), allowNull: false },
    password: { type: DataTypes.STRING(80), allowNull: true },
    profile:  { type: DataTypes.STRING(80), allowNull: true },
    server:   { type: DataTypes.STRING(60), allowNull: true },
    device_id: { type: DataTypes.INTEGER, allowNull: true },
    // Harga jual & modal saat dibuat (snapshot).
    sell_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    cost_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    // Status terakhir diketahui.
    status: {
      type: DataTypes.ENUM('created', 'used', 'expired', 'deleted', 'unknown'),
      allowNull: false, defaultValue: 'created'
    },
    last_synced_at: { type: DataTypes.DATE, allowNull: true }
  }, {
    tableName: 'reseller_voucher_logs',
    timestamps: true,
    indexes: [
      { fields: ['reseller_id'] },
      { fields: ['transaction_id'] },
      { fields: ['username'] },
      { fields: ['status'] },
      { fields: ['created_at'] }
    ]
  });

  return ResellerVoucherLog;
};
