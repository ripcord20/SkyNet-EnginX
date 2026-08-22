const { DataTypes } = require('sequelize');

/**
 * CollectionAssignment
 * ──────────────────────────────────────────────────────────────────
 * Satu baris = satu invoice yang ditugaskan untuk ditagih langsung oleh
 * seorang kolektor di lapangan. Dibuat saat:
 *   - Generate otomatis tiap periode (cron) untuk invoice belum lunas
 *   - Generate manual oleh admin dari dashboard /collect
 *
 * Sebuah assignment awalnya bisa 'pending' (belum ada kolektor) lalu
 * 'assigned' setelah admin menugaskan kolektor.
 *
 * status lapangan mengikuti spesifikasi bisnis (9 status):
 *   pending             → task dibuat, belum ditugaskan ke kolektor
 *   assigned            → sudah ditugaskan ke kolektor
 *   in_progress         → kolektor sudah check-in / sedang menagih
 *   paid                → berhasil ditagih lunas
 *   partial_paid        → bayar sebagian (sisa carry-over ke bulan depan)
 *   promise_to_pay      → pelanggan janji bayar (promise_date diisi)
 *   not_home            → pelanggan tidak ditemui
 *   refused             → pelanggan menolak membayar
 *   request_termination → pelanggan minta berhenti berlangganan
 *
 * Bukti GPS & foto disimpan saat check-in / input hasil kunjungan untuk
 * audit aktivitas lapangan dan mengurangi fraud.
 *
 * amount_due = snapshot nominal tagihan saat assignment dibuat (invoice
 * bisa berubah, snapshot menjaga histori akurat).
 */
module.exports = (sequelize) => {
  const CollectionAssignment = sequelize.define('CollectionAssignment', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    invoice_id:   { type: DataTypes.INTEGER, allowNull: false, references: { model: 'invoices',  key: 'id' } },
    customer_id:  { type: DataTypes.INTEGER, allowNull: false, references: { model: 'customers', key: 'id' } },

    // Kolektor yang ditugaskan. NULL = masih 'pending' (belum di-assign).
    collector_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'users', key: 'id' } },

    // Admin yang melakukan assignment.
    assigned_by:  { type: DataTypes.INTEGER, allowNull: true, references: { model: 'users', key: 'id' } },

    status: {
      type: DataTypes.ENUM(
        'pending', 'assigned', 'in_progress', 'paid', 'partial_paid',
        'promise_to_pay', 'not_home', 'refused', 'request_termination', 'cancelled'
      ),
      allowNull: false,
      defaultValue: 'pending'
    },

    // Snapshot tagihan & periode (untuk filter & histori)
    amount_due:   { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    period_month: { type: DataTypes.INTEGER, allowNull: true },
    period_year:  { type: DataTypes.INTEGER, allowNull: true },

    // Snapshot area (untuk route optimization & filter, tanpa join Customer)
    area_regency:  { type: DataTypes.STRING(100), allowNull: true },
    area_district: { type: DataTypes.STRING(100), allowNull: true },
    area_village:  { type: DataTypes.STRING(100), allowNull: true },

    scheduled_date: { type: DataTypes.DATEONLY, allowNull: true },

    // ── Hasil kunjungan ─────────────────────────────────────────
    visited_at:    { type: DataTypes.DATE, allowNull: true },
    collected_at:  { type: DataTypes.DATE, allowNull: true },

    amount_collected: { type: DataTypes.DECIMAL(12, 2), allowNull: true, comment: 'Nominal yang benar2 ditagih (partial/lunas)' },
    carry_over:       { type: DataTypes.DECIMAL(12, 2), allowNull: true, comment: 'Sisa kurang bayar yg di-carry ke bulan depan' },

    promise_date:  { type: DataTypes.DATEONLY, allowNull: true, comment: 'Tanggal janji bayar (status promise_to_pay)' },

    // ── Bukti GPS & foto (anti-fraud) ───────────────────────────
    visit_lat:   { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    visit_lng:   { type: DataTypes.DECIMAL(11, 8), allowNull: true },
    pay_lat:     { type: DataTypes.DECIMAL(10, 8), allowNull: true, comment: 'Latitude saat catat pembayaran' },
    pay_lng:     { type: DataTypes.DECIMAL(11, 8), allowNull: true, comment: 'Longitude saat catat pembayaran' },
    photo_location: { type: DataTypes.STRING(255), allowNull: true, comment: 'Foto lokasi/selfie saat check-in' },
    photo_house:    { type: DataTypes.STRING(255), allowNull: true, comment: 'Foto rumah pelanggan' },
    payment_proof:  { type: DataTypes.STRING(255), allowNull: true, comment: 'Foto bukti pembayaran (transfer/cash) saat catat bayar' },

    note: { type: DataTypes.TEXT, allowNull: true }
  }, {
    tableName: 'collection_assignments',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['collector_id', 'status'] },
      { fields: ['invoice_id'] },
      { fields: ['customer_id'] },
      { fields: ['scheduled_date'] },
      { fields: ['period_month', 'period_year'] }
    ]
  });

  return CollectionAssignment;
};
