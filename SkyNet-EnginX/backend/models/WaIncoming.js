const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
  return sequelize.define('WaIncoming', {
    id:          { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    device_id:   { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    from_phone:  { type: DataTypes.STRING(20), allowNull: false },
    from_name:   { type: DataTypes.STRING(100), allowNull: true },
    message:     { type: DataTypes.TEXT, allowNull: false },
    message_id:  { type: DataTypes.STRING(100), allowNull: true },
    direction:   { type: DataTypes.ENUM('in','out'), defaultValue: 'in' },
    media_type:  { type: DataTypes.STRING(30), allowNull: true },
    media_url:   { type: DataTypes.TEXT, allowNull: true },
    is_read:     { type: DataTypes.BOOLEAN, defaultValue: false },
    is_replied:  { type: DataTypes.BOOLEAN, defaultValue: false },
    replied_at:  { type: DataTypes.DATE, allowNull: true },
    received_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    is_auto:     { type: DataTypes.BOOLEAN, defaultValue: false }
  }, { tableName: 'wa_incoming', timestamps: false });
};
