/**
 * ResellerVoucherPackage.js — Paket voucher yang boleh dijual reseller.
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin/owner mendefinisikan paket: nama, profile MikroTik yang dipakai,
 * harga modal (yang dipotong dari saldo reseller per voucher), dan harga jual
 * sugesti (untuk ditampilkan ke reseller sebagai panduan jual ke end-user).
 *
 * `mikrotik_profile` = nama hotspot user-profile di RouterOS (mis. "1jam",
 * "1hari"). Saat reseller generate, kita pakai profile ini.
 *
 * `cost_price` = harga yang dipotong dari saldo reseller per 1 voucher.
 * `sell_price` = harga jual sugesti ke pelanggan akhir (informatif saja).
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResellerVoucherPackage = sequelize.define('ResellerVoucherPackage', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    // Nama hotspot user-profile di MikroTik. Voucher dibuat dgn profile ini.
    mikrotik_profile: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    // Device/router tempat profile ini berada. null = berlaku untuk semua /
    // pakai device milik reseller. Kalau diisi, paket hanya tampil untuk
    // reseller di device yang sama.
    device_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'devices', key: 'id' }
    },
    // Durasi (informatif untuk UI, mis. "1 Jam", "1 Hari", "30 Hari").
    duration_label: {
      type: DataTypes.STRING(60),
      allowNull: true
    },
    // limit-uptime MikroTik (mis. "1h", "1d", "30d"). Di-inject ke user
    // saat generate supaya voucher kadaluarsa otomatis. Kosong = unlimited.
    limit_uptime: {
      type: DataTypes.STRING(40),
      allowNull: true,
      defaultValue: ''
    },
    // limit-bytes-total (0 = unlimited). Untuk paket kuota.
    limit_bytes_total: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    // Harga modal: dipotong dari saldo reseller per voucher.
    cost_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0
    },
    // Harga jual sugesti ke end-user (informatif).
    sell_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0
    },
    // Prefix username voucher (mis. "wifi"). Kosong → pakai default global.
    prefix: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: 'v'
    },
    // Panjang kode random username/password.
    code_length: {
      type: DataTypes.INTEGER,
      defaultValue: 5
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    // Apakah paket ini ditampilkan & boleh dibeli di landing page publik (/beli).
    is_public: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    // Harga jual ke pembeli publik. Kalau 0/null → fallback ke sell_price.
    public_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: null
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'reseller_voucher_packages',
    timestamps: true,
    indexes: [
      { fields: ['is_active'] },
      { fields: ['device_id'] }
    ]
  });

  return ResellerVoucherPackage;
};
