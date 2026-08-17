const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TrackingSession = sequelize.define('TrackingSession', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    session_id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      unique: true,
      comment: 'Unique session identifier'
    },
    technician_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'id' }
    },
    ticket_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'tickets', key: 'id' }
    },
    status: {
      type: DataTypes.ENUM('active', 'paused', 'completed', 'cancelled'),
      defaultValue: 'active',
      comment: 'Status sesi tracking'
    },
    start_latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: true,
      comment: 'Titik awal tracking'
    },
    start_longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: true
    },
    end_latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: true,
      comment: 'Titik akhir tracking'
    },
    end_longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: true
    },
    total_distance: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
      comment: 'Total jarak tempuh dalam meter'
    },
    total_duration: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Durasi total dalam detik'
    },
    points_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Jumlah titik GPS yang direkam'
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    ended_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Catatan sesi tracking'
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Data tambahan (route details, checkpoints, dll)'
    }
  }, {
    tableName: 'tracking_sessions',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['session_id'], unique: true },
      { fields: ['technician_id'] },
      { fields: ['ticket_id'] },
      { fields: ['status'] },
      { fields: ['started_at'] }
    ]
  });

  return TrackingSession;
};
