const { DataTypes } = require('sequelize');

/**
 * EmailLog — riwayat setiap email yang dikirim sistem.
 * ─────────────────────────────────────────────────────────────────────────────
 * Ditulis oleh EmailService._log() (best-effort, tak boleh menggagalkan kirim).
 * Dibaca oleh halaman "Riwayat Email", "Email Statistic", dan API /email-log.
 *
 * Catatan kolom waktu:
 *   Memakai timestamps Sequelize, tetapi createdAt dipetakan ke kolom `sent_at`
 *   agar selaras dengan query lama (order/filter by sent_at). updatedAt dipakai
 *   untuk menandai kapan status terakhir berubah (mis. setelah retry sukses).
 *
 * Kolom retry (fitur retry otomatis email gagal):
 *   - retry_count   : berapa kali sudah dicoba ulang
 *   - next_retry_at : kapan boleh dicoba lagi (NULL = tidak dijadwalkan retry)
 *   - last_error    : alasan kegagalan terakhir (untuk diagnosa)
 *   - payload       : data minimal untuk mengirim ulang (to/subject/html/text/...)
 */
module.exports = (sequelize) => {
  return sequelize.define('EmailLog', {
    id:            { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    recipient:     { type: DataTypes.STRING(160), allowNull: false },
    subject:       { type: DataTypes.STRING(255), allowNull: true },
    type:          { type: DataTypes.STRING(40), defaultValue: 'other' },
    status:        { type: DataTypes.ENUM('sent', 'failed', 'pending', 'retrying'), defaultValue: 'sent' },
    error_message: { type: DataTypes.STRING(255), allowNull: true },
    duration_ms:   { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    has_attachment:{ type: DataTypes.BOOLEAN, defaultValue: false },

    // ── Retry otomatis ──
    retry_count:   { type: DataTypes.SMALLINT.UNSIGNED, defaultValue: 0 },
    next_retry_at: { type: DataTypes.DATE, allowNull: true },
    last_error:    { type: DataTypes.STRING(255), allowNull: true },
    // Payload disimpan agar bisa dikirim ulang tanpa membangun ulang isi email.
    // Hanya diisi untuk email yang layak diretry (punya html/text).
    payload:       { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'email_logs',
    timestamps: true,
    // createdAt → sent_at (selaras query lama), updatedAt aktif.
    createdAt: 'sent_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['status'] },
      { fields: ['type'] },
      { fields: ['sent_at'] },
      { fields: ['next_retry_at'] }
    ]
  });
};
