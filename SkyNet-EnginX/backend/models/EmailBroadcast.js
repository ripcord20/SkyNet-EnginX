const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
  return sequelize.define('EmailBroadcast', {
    id:            { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    title:         { type: DataTypes.STRING(200), allowNull: false },
    subject:       { type: DataTypes.STRING(255), allowNull: false },
    // Kategori menentukan banner/badge warna di template email branded:
    //   gangguan    → merah   (informasi gangguan jaringan)
    //   maintenance → amber   (jadwal pemeliharaan)
    //   promo       → hijau   (promosi/penawaran)
    //   billing     → biru    (informasi tagihan)
    //   info        → navy    (informasi umum)
    category:      { type: DataTypes.ENUM('gangguan','maintenance','promo','billing','info'), defaultValue: 'info' },
    message:       { type: DataTypes.TEXT('medium'), allowNull: false },
    target_type:   { type: DataTypes.ENUM('all','active','overdue','by_package','custom'), defaultValue: 'all' },
    target_filter: { type: DataTypes.JSON, allowNull: true },
    status:        { type: DataTypes.ENUM('draft','scheduled','running','completed','cancelled','failed'), defaultValue: 'draft' },
    scheduled_at:  { type: DataTypes.DATE, allowNull: true },
    started_at:    { type: DataTypes.DATE, allowNull: true },
    completed_at:  { type: DataTypes.DATE, allowNull: true },
    total_targets: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    total_sent:    { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    total_failed:  { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    // Interval antar email (detik). Default 2s — SMTP umumnya jauh lebih toleran
    // dari WA, tapi tetap perlu throttle untuk hindari rate-limit provider
    // (Gmail ±20 email/menit untuk akun gratis).
    send_interval: { type: DataTypes.SMALLINT.UNSIGNED, defaultValue: 2 },
    created_by:    { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
  }, { tableName: 'email_broadcast', timestamps: true });
};
