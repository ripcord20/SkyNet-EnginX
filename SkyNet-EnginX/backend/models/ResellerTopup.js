/**
 * ResellerTopup.js — Permintaan isi saldo (top-up) oleh reseller.
 * ─────────────────────────────────────────────────────────────────────────────
 * Reseller bisa isi saldo sendiri lewat 3 metode:
 *   - 'manual'  : transfer bank / e-wallet manual → upload bukti → verifikasi admin
 *   - 'qris'    : scan QRIS statis ISP → upload bukti → verifikasi admin
 *   - 'gateway' : payment gateway otomatis (Tripay/Midtrans/Duitku/Xendit)
 *                 → saldo masuk OTOMATIS via webhook saat status PAID
 *
 * status:
 *   - 'pending'              : dibuat, menunggu aksi (gateway: menunggu bayar)
 *   - 'waiting_verification' : manual/qris sudah upload bukti, tunggu admin
 *   - 'paid'                 : lunas → saldo sudah dikreditkan (1x, idempotent)
 *   - 'rejected'             : ditolak admin (manual/qris)
 *   - 'expired'              : kedaluwarsa (gateway)
 *
 * Saat status menjadi 'paid', controller membuat ResellerTransaction type='topup'
 * dan menambah saldo reseller secara atomik. Kolom `credited` mencegah double-credit.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResellerTopup = sequelize.define('ResellerTopup', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    // Kode unik untuk referensi (mis. "RTOP-12-1718270000000").
    ref: {
      type: DataTypes.STRING(60),
      allowNull: false,
      unique: true
    },
    reseller_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'resellers', key: 'id' }
    },
    method: {
      type: DataTypes.ENUM('manual', 'qris', 'gateway'),
      allowNull: false
    },
    amount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('pending', 'waiting_verification', 'paid', 'rejected', 'expired'),
      allowNull: false,
      defaultValue: 'pending'
    },
    // ── Manual / QRIS ───────────────────────────────────────────────────
    // Tujuan transfer yang dipilih reseller (snapshot, supaya tetap valid
    // walau admin mengubah daftar rekening). Format bebas (mis. "BCA 123 a.n X").
    target_account: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // Path file bukti transfer di uploads/payment_proofs (relatif). null = belum upload.
    proof_path: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // Catatan dari reseller saat upload (mis. nama pengirim, jam transfer).
    note: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // ── Gateway otomatis ────────────────────────────────────────────────
    gateway_provider: {
      type: DataTypes.STRING(30),
      allowNull: true
    },
    // Referensi dari provider (Tripay reference, Midtrans order_id, dll).
    gateway_ref: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    // URL checkout / pembayaran yang dikembalikan provider.
    payment_url: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    // Metode pembayaran spesifik gateway (mis. "QRIS", "BCAVA").
    gateway_method: {
      type: DataTypes.STRING(60),
      allowNull: true
    },
    // ── Promo top-up (#10) ──────────────────────────────────────────────
    // Kode promo yang dipakai (bila ada) + bonus saldo yang akan ditambahkan
    // saat top-up dikreditkan. promo_id untuk relasi & penegakan kuota.
    promo_code: {
      type: DataTypes.STRING(40),
      allowNull: true
    },
    promo_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    bonus_amount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0
    },
    // ── Verifikasi & kredit ─────────────────────────────────────────────
    // true setelah saldo dikreditkan. Guard anti double-credit.
    credited: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    verified_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    },
    verified_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    reject_reason: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // Link ke transaksi ledger yang dihasilkan (audit).
    transaction_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'reseller_transactions', key: 'id' }
    },
    paid_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'reseller_topups',
    timestamps: true,
    indexes: [
      { fields: ['reseller_id'] },
      { fields: ['status'] },
      { fields: ['method'] },
      { unique: true, fields: ['ref'] }
    ]
  });

  return ResellerTopup;
};
