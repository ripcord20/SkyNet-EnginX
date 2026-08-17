const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const DeviceLog = sequelize.define('DeviceLog', {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    device_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'devices', key: 'id' }
    },
    cpu_load: {
      type: DataTypes.FLOAT,
      allowNull: true
    },
    memory_usage: {
      type: DataTypes.FLOAT,
      allowNull: true
    },
    uptime: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('online', 'offline', 'warning'),
      defaultValue: 'offline'
    },
    interfaces: {
      type: DataTypes.JSON,
      allowNull: true
    },
    raw_data: {
      type: DataTypes.JSON,
      allowNull: true
    },
    polled_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'device_logs',
    timestamps: true,
    indexes: [
      { fields: ['device_id'] },
      { fields: ['polled_at'] },
      { fields: ['device_id', 'polled_at'] }
    ]
  });

  return DeviceLog;
};
