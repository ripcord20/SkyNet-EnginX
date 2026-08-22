/**
 * ResellerTransaction.js — Buku besar (ledger) saldo reseller.
 * ─────────────────────────────────────────────────────────────────────────────
 * SETIAP perubahan saldo reseller tercatat di sini. Sumber audit tunggal.
 *
 * type:
 *   - 'topup'    : admin isi saldo (amount positif menambah balance)
 *   - 'purchase' : reseller generate voucher (amount negatif memotong balance)
 *   - 'adjust'   : koreksi manual oleh admin (bisa + / -)
 *   - 'refund'   : pengembalian (mis. generate gagal sebagian)
 *
 * balance_before / balance_after = snapshot saldo untuk rekonsiliasi.
 *
 * Untuk transaksi 'purchase', kita simpan metadata voucher: jumlah, paket,
 * harga satuan, dan daftar username yang dibuat (JSON) supaya reseller bisa
 * lihat & cetak ulang dari Riwayat.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResellerTransaction = sequelize.define('ResellerTransaction', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    reseller_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'resellers', key: 'id' }
    },
    type: {
      type: DataTypes.ENUM('topup', 'purchase', 'adjust', 'refund'),
      allowNull: false
    },
    // Nilai transaksi. Positif menambah saldo, negatif mengurangi.
    amount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false
    },
    balance_before: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0
    },
    balance_after: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // ── Metadata khusus 'purchase' (voucher) ────────────────────────────
    package_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'reseller_voucher_packages', key: 'id' }
    },
    package_name: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    voucher_count: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    unit_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true
    },
    // Daftar voucher yang dibuat: [{username,password,profile}] (JSON string).
    vouchers: {
      type: DataTypes.TEXT('long'),
      allowNull: true
    },
    // Siapa yang melakukan (untuk topup/adjust = user_id admin).
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    }
  }, {
    tableName: 'reseller_transactions',
    timestamps: true,
    indexes: [
      { fields: ['reseller_id'] },
      { fields: ['type'] },
      { fields: ['createdAt'] }
    ]
  });

  return ResellerTransaction;
};
