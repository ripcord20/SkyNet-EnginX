const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TechnicianLocation = sequelize.define('TechnicianLocation', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    technician_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      comment: 'ID teknisi yang sedang di-track'
    },
    ticket_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'tickets', key: 'id' },
      comment: 'ID ticket yang sedang dikerjakan'
    },
    latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: false,
      comment: 'Koordinat latitude GPS'
    },
    longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: false,
      comment: 'Koordinat longitude GPS'
    },
    accuracy: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Akurasi GPS dalam meter'
    },
    speed: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Kecepatan dalam m/s'
    },
    heading: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Arah pergerakan dalam derajat (0-360)'
    },
    altitude: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Ketinggian dalam meter'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Status tracking aktif atau tidak'
    },
    battery_level: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Level baterai device (0-100)'
    },
    device_info: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Info device teknisi (browser, OS, dll)'
    },
    recorded_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'Waktu GPS direkam'
    }
  }, {
    tableName: 'technician_locations',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['technician_id'] },
      { fields: ['ticket_id'] },
      { fields: ['is_active'] },
      { fields: ['recorded_at'] },
      { fields: ['technician_id', 'is_active'] }
    ],
    hooks: {
      beforeCreate: async (location) => {
        if (!location.recorded_at) {
          location.recorded_at = new Date();
        }
      }
    }
  });

  return TechnicianLocation;
};
