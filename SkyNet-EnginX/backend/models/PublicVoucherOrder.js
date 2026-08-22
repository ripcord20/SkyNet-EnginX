/**
 * PublicVoucherOrder.js — Order pembelian voucher hotspot dari halaman publik.
 * ─────────────────────────────────────────────────────────────────────────────
 * Halaman /beli (landing page publik, TANPA login) memungkinkan siapa pun
 * membeli voucher hotspot. Alur:
 *   1. Pembeli pilih paket → isi nama / email / no. WA.
 *   2. Pilih metode bayar: gateway otomatis (QRIS/VA) atau transfer manual.
 *   3a. Gateway → webhook (VPO-{id}-{ts}) menandai 'paid' → voucher digenerate
 *       otomatis di MikroTik & dikirim ke WA + Email pembeli.
 *   3b. Manual → pembeli upload bukti / konfirmasi WA → admin verifikasi →
 *       voucher digenerate & dikirim.
 *
 * Paket yang dijual diambil dari ResellerVoucherPackage (reuse) yang ditandai
 * `is_public = true` (lihat migrasi kolom di server bootstrap) ATAU dari paket
 * khusus publik bila nanti dipisah. Untuk sekarang reuse + flag publik.
 *
 * Voucher hasil generate disnapshot ke kolom voucher_username/password supaya
 * bisa dikirim ulang & ditampilkan di halaman status tanpa query MikroTik lagi.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PublicVoucherOrder = sequelize.define('PublicVoucherOrder', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Kode order publik unik (mis. "VC-A1B2C3"). Dipakai di URL status.
    order_code: { type: DataTypes.STRING(40), allowNull: false, unique: true },

    // Paket voucher (FK ke reseller_voucher_packages — paket di-reuse).
    package_id:   { type: DataTypes.INTEGER, allowNull: false },
    package_name: { type: DataTypes.STRING(120), allowNull: true },

    // Snapshot harga jual ke pembeli (per 1 voucher). Tidak ikut berubah
    // walau harga paket diedit kemudian.
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },

    // Data pembeli.
    buyer_name:  { type: DataTypes.STRING(120), allowNull: false },
    buyer_email: { type: DataTypes.STRING(160), allowNull: true },
    buyer_wa:    { type: DataTypes.STRING(30),  allowNull: true },

    // Metode pembayaran yang dipilih pembeli.
    //   'gateway' = payment gateway otomatis (midtrans/duitku/tripay)
    //   'manual'  = transfer bank/ewallet + konfirmasi WA admin
    payment_method: {
      type: DataTypes.ENUM('gateway', 'manual'),
      allowNull: false, defaultValue: 'gateway'
    },

    // Status order.
    //   pending   → menunggu pembayaran
    //   paid      → pembayaran terkonfirmasi (gateway/manual) — siap fulfill
    //   delivered → voucher sudah digenerate & dikirim ke pembeli
    //   failed    → pembayaran gagal / kadaluarsa / generate gagal permanen
    //   expired   → pembeli tidak menyelesaikan pembayaran
    status: {
      type: DataTypes.ENUM('pending', 'paid', 'delivered', 'failed', 'expired'),
      allowNull: false, defaultValue: 'pending'
    },

    // Referensi transaksi gateway (order_id midtrans / merchantOrderId duitku /
    // merchant_ref tripay). Untuk rekonsiliasi webhook.
    gateway_provider: { type: DataTypes.STRING(20),  allowNull: true },
    gateway_ref:      { type: DataTypes.STRING(120), allowNull: true },
    gateway_reference:{ type: DataTypes.STRING(120), allowNull: true }, // ref balik dari gateway

    // Bukti transfer manual (path relatif di uploads/payment_proofs).
    proof_path: { type: DataTypes.STRING(255), allowNull: true },

    // Voucher hasil generate (snapshot). Diisi saat fulfill.
    voucher_username: { type: DataTypes.STRING(80), allowNull: true },
    voucher_password: { type: DataTypes.STRING(80), allowNull: true },
    voucher_profile:  { type: DataTypes.STRING(80), allowNull: true },

    // Flag pengiriman (best-effort, untuk audit).
    delivered_wa:    { type: DataTypes.BOOLEAN, defaultValue: false },
    delivered_email: { type: DataTypes.BOOLEAN, defaultValue: false },

    paid_at:      { type: DataTypes.DATE, allowNull: true },
    delivered_at: { type: DataTypes.DATE, allowNull: true },

    // Catatan internal (error fulfill, dll).
    notes: { type: DataTypes.TEXT, allowNull: true }
  }, {
    tableName: 'public_voucher_orders',
    timestamps: true,
    indexes: [
      { fields: ['order_code'] },
      { fields: ['status'] },
      { fields: ['package_id'] },
      { fields: ['gateway_ref'] },
      { fields: ['created_at'] }
    ]
  });

  return PublicVoucherOrder;
};
