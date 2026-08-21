'use strict';

const { DataTypes } = require('sequelize');

/**
 * OntSignalHistory - riwayat signal strength ONT
 * Diisi otomatis setiap sync dari GenieACS
 */
module.exports = (sequelize) => {
  const OntSignalHistory = sequelize.define('OntSignalHistory', {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    ont_device_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'ont_devices', key: 'id' },
      onDelete: 'CASCADE'
    },
    rx_power: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Receive power dBm'
    },
    tx_power: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Transmit power dBm'
    },
    olt_rx_power: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'OLT receive power dBm'
    },
    status: {
      type: DataTypes.ENUM('online', 'offline', 'warning', 'unknown'),
      defaultValue: 'unknown'
    },
    recorded_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'ont_signal_history',
    timestamps: false,
    indexes: [
      { fields: ['ont_device_id'] },
      { fields: ['recorded_at'] },
      { fields: ['ont_device_id', 'recorded_at'] }
    ]
  });

  return OntSignalHistory;
};
