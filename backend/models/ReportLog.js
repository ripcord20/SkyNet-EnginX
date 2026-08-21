const { DataTypes } = require('sequelize');

/**
 * ReportLog — riwayat pengiriman Telegram Report (terjadwal & manual).
 *
 * Dua fungsi (mengikuti pola ReminderLog):
 *   1. HISTORY → tampilkan di tab "Riwayat" pada /telegram/report supaya admin
 *                tahu apa yang terkirim, kapan, ke berapa chat, status, & ukuran.
 *   2. DEDUP   → kombinasi (run_key) UNIQUE mencegah kirim ganda untuk slot
 *                jadwal yang sama (mis. restart server tepat di menit kirim).
 *
 * run_key disusun di TelegramReportService sebagai
 *   `${frequency}:${YYYY-MM-DD}:${HH}` → granular per-frekuensi & jam.
 */
module.exports = (sequelize) => {
  const ReportLog = sequelize.define('ReportLog', {
    id:            { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    // Sumber: 'schedule' (cron) atau 'manual' (tombol Kirim Sekarang).
    source:        { type: DataTypes.ENUM('schedule', 'manual'), allowNull: false, defaultValue: 'schedule' },
    frequency:     { type: DataTypes.STRING(12), allowNull: true },   // daily/weekly/monthly
    period:        { type: DataTypes.STRING(12), allowNull: true },   // yesterday/week/month
    // Kunci dedup slot jadwal. NULL untuk manual (boleh berkali-kali).
    run_key:       { type: DataTypes.STRING(40), allowNull: true },
    chat_count:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ok_count:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    char_len:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status:        { type: DataTypes.ENUM('sent', 'partial', 'failed'), allowNull: false, defaultValue: 'sent' },
    summary:       { type: DataTypes.STRING(255), allowNull: true },
    error_message: { type: DataTypes.STRING(255), allowNull: true },
  }, {
    tableName: 'report_logs',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, name: 'uniq_report_run_key', fields: ['run_key'] },
      { fields: ['created_at'] },
      { fields: ['status'] },
    ],
  });

  return ReportLog;
};
