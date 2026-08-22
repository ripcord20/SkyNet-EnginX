const { DataTypes } = require('sequelize');

/**
 * ReminderLog — catatan pengiriman WA reminder otomatis.
 *
 * Dua fungsi:
 *  1. DEDUP  → cegah kirim ganda. Kombinasi (reminder_id, invoice_id, send_date)
 *              dibuat UNIQUE, jadi reminder yang sama untuk invoice yang sama
 *              pada hari yang sama hanya bisa tercatat sekali.
 *  2. HISTORY→ ditampilkan di UI /wa/reminder supaya admin tahu apa yang
 *              terkirim, ke siapa, kapan, dan status (sent/failed).
 */
module.exports = (sequelize) => {
  const ReminderLog = sequelize.define('ReminderLog', {
    id:           { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    reminder_id:  { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    invoice_id:   { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    customer_id:  { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    // Tanggal kirim (YYYY-MM-DD) di timezone aplikasi — basis dedup harian.
    send_date:    { type: DataTypes.DATEONLY, allowNull: false },
    reminder_type:{ type: DataTypes.STRING(20), allowNull: true },   // before/due/overdue
    phone:        { type: DataTypes.STRING(20), allowNull: true },
    status:       { type: DataTypes.ENUM('sent', 'failed'), allowNull: false, defaultValue: 'sent' },
    error_message:{ type: DataTypes.STRING(255), allowNull: true },
  }, {
    tableName: 'reminder_logs',
    timestamps: true,
    indexes: [
      // Kunci dedup: satu reminder per invoice per hari.
      { unique: true, name: 'uniq_reminder_invoice_date_type', fields: ['reminder_id', 'invoice_id', 'send_date', 'reminder_type'] },
      { fields: ['send_date'] },
      { fields: ['customer_id'] },
      { fields: ['status'] },
    ]
  });

  return ReminderLog;
};
