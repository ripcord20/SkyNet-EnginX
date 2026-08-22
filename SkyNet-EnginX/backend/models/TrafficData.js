const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TrafficData = sequelize.define('TrafficData', {
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
    interface_name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    rx_bytes: {
      type: DataTypes.BIGINT,
      defaultValue: 0
    },
    tx_bytes: {
      type: DataTypes.BIGINT,
      defaultValue: 0
    },
    rx_rate: {
      type: DataTypes.BIGINT,
      defaultValue: 0,
      comment: 'bits per second'
    },
    tx_rate: {
      type: DataTypes.BIGINT,
      defaultValue: 0,
      comment: 'bits per second'
    },
    recorded_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'traffic_data',
    timestamps: false,
    indexes: [
      { fields: ['device_id', 'interface_name'] },
      { fields: ['recorded_at'] },
      { fields: ['device_id', 'recorded_at'] }
    ]
  });

  return TrafficData;
};
