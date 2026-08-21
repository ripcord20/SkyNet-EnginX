const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
  return sequelize.define('WaLog', {
    id:           { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    queue_id:     { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    device_id:    { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    phone:        { type: DataTypes.STRING(20), allowNull: false },
    message:      { type: DataTypes.TEXT, allowNull: false },
    type:         { type: DataTypes.ENUM('reminder','broadcast','manual','otp'), defaultValue: 'manual' },
    status:       { type: DataTypes.ENUM('sent','failed'), defaultValue: 'sent' },
    api_response: { type: DataTypes.TEXT, allowNull: true },
    api_status:   { type: DataTypes.STRING(10), allowNull: true },
    duration_ms:  { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    sent_at:      { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
  }, { tableName: 'wa_logs', timestamps: false });
};
