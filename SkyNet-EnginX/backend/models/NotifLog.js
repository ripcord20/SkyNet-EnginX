const { DataTypes } = require('sequelize');

/**
 * NotifLog — riwayat notifikasi monitoring Telegram (audit jejak gangguan).
 *
 * Satu baris per transisi yang DIKIRIM (down/recover) atau ringkasan grouping.
 * Dipakai tab "Riwayat" di /telegram supaya admin bisa audit: apa down, kapan,
 * kapan pulih, terkirim ke berapa chat.
 *
 * kind   : 'device' | 'ont' | 'ip' | 'pppoe' | 'summary' | 'custom' | 'test'
 * event  : 'down' | 'recover' | 'summary'
 * status : 'sent' | 'failed' | 'held' (ditahan quiet-hours)
 */
module.exports = (sequelize) => {
  const NotifLog = sequelize.define('NotifLog', {
    id:          { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    kind:        { type: DataTypes.STRING(12), allowNull: false },
    event:       { type: DataTypes.STRING(12), allowNull: false },
    ref_id:      { type: DataTypes.STRING(40), allowNull: true },
    title:       { type: DataTypes.STRING(160), allowNull: true },   // mis. "Budi Santoso (CUST-00123)"
    detail:      { type: DataTypes.STRING(255), allowNull: true },   // ip/user/tipe ringkas
    chat_count:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ok_count:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status:      { type: DataTypes.ENUM('sent', 'failed', 'held'), allowNull: false, defaultValue: 'sent' },
    error_message: { type: DataTypes.STRING(255), allowNull: true },
  }, {
    tableName: 'notif_logs',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['created_at'] },
      { fields: ['kind'] },
      { fields: ['event'] },
    ],
  });

  return NotifLog;
};
