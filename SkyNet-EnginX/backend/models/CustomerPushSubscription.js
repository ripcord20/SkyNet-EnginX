/**
 * CustomerPushSubscription.js
 * Menyimpan push subscription per pelanggan.
 *
 * Dua platform didukung:
 *  - platform='web'  → Web Push (VAPID). Uses endpoint + p256dh + auth.
 *  - platform='fcm'  → Firebase Cloud Messaging (Android APK via Capacitor).
 *                      Uses fcm_token. endpoint/p256dh/auth null.
 *
 * Satu pelanggan bisa punya banyak subscription (multi device + mix platform).
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('CustomerPushSubscription', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'customers', key: 'id' }
    },
    platform: {
      type: DataTypes.ENUM('web', 'fcm'),
      allowNull: false,
      defaultValue: 'web'
    },
    // Web Push fields (nullable when platform='fcm')
    endpoint: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    p256dh: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    auth: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // FCM field (nullable when platform='web')
    fcm_token: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    device_name: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    last_used: {
      type: DataTypes.DATE,
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    tableName: 'customer_push_subscriptions',
    timestamps: true,
    indexes: [
      { fields: ['customer_id'] },
      { fields: ['customer_id', 'is_active'] },
      { fields: ['customer_id', 'platform'] }
    ]
  });
};
