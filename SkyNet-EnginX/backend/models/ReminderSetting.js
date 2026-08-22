const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
  return sequelize.define('ReminderSetting', {
    id:          { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    type:        { type: DataTypes.ENUM('before','due','overdue'), allowNull: false },
    days_offset: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    template_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    send_time:   { type: DataTypes.TIME, allowNull: false, defaultValue: '08:00:00' },
    is_active:   { type: DataTypes.BOOLEAN, defaultValue: true }
  }, { tableName: 'reminder_settings', timestamps: true });
};
