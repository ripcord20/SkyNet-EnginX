const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const QueueHistory = sequelize.define('QueueHistory', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    queue_id:   { type: DataTypes.STRING(50),  allowNull: false, comment: 'MikroTik queue .id' },
    queue_name: { type: DataTypes.STRING(200), allowNull: false },
    target:     { type: DataTypes.STRING(200), allowNull: true },
    rx_rate:    { type: DataTypes.BIGINT, defaultValue: 0, comment: 'bits/s download' },
    tx_rate:    { type: DataTypes.BIGINT, defaultValue: 0, comment: 'bits/s upload' },
    rx_bytes:   { type: DataTypes.BIGINT, defaultValue: 0, comment: 'cumulative download bytes' },
    tx_bytes:   { type: DataTypes.BIGINT, defaultValue: 0, comment: 'cumulative upload bytes' },
    recorded_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
  }, {
    tableName: 'queue_history',
    timestamps: false,
    indexes: [
      { fields: ['queue_id', 'recorded_at'] },
      { fields: ['recorded_at'] },
      { fields: ['queue_name'] }
    ]
  });
  return QueueHistory;
};