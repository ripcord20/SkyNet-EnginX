/**
 * PushNotification.js
 * Log + Queue untuk push notification.
 *
 * status:
 *   - scheduled : menunggu jadwal kirim (scheduled_at > now)
 *   - pending   : sedang diproses (lock oleh worker)
 *   - sent      : berhasil terkirim (lihat sent_count / failed_count)
 *   - failed    : seluruh proses gagal (error_message diisi)
 *   - cancelled : dibatalkan admin sebelum dikirim
 *
 * filters: JSON {
 *   packages: [1,2,3],         // package_id (optional)
 *   bill_status: ['overdue','unpaid','paid','due_soon'],  // (optional)
 *   customer_status: ['active','inactive'],               // (optional)
 *   isolir_status: ['normal','isolir'],                   // (optional)
 *   area: 'string',                                       // partial match address (optional)
 *   customer_ids: [1,2,3]      // manual pick (optional — kalau ada, override semua filter lain)
 * }
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('PushNotification', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    title: {
      type: DataTypes.STRING(120),
      allowNull: false
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    icon: {
      type: DataTypes.STRING(10),      // emoji
      allowNull: true
    },
    url: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    tag: {
      type: DataTypes.STRING(60),
      allowNull: true
    },
    filters: {
      type: DataTypes.JSON,            // target filter snapshot
      allowNull: true
    },
    target_count: {
      type: DataTypes.INTEGER,         // berapa customer ter-match saat compose
      defaultValue: 0
    },
    sent_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    failed_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    status: {
      type: DataTypes.ENUM('scheduled', 'pending', 'sent', 'failed', 'cancelled'),
      defaultValue: 'pending'
    },
    scheduled_at: {
      type: DataTypes.DATE,            // kalau null → kirim sekarang
      allowNull: true
    },
    sent_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    template_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    }
  }, {
    tableName: 'push_notifications',
    timestamps: true,
    indexes: [
      { fields: ['status'] },
      { fields: ['scheduled_at'] },
      { fields: ['status', 'scheduled_at'] }
    ]
  });
};
