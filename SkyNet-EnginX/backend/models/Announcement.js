/**
 * Announcement.js
 * Pengumuman / pemberitahuan untuk portal pelanggan
 * Contoh: gangguan massal, maintenance terjadwal, promo, info
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('Announcement', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: false
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    type: {
      // gangguan = merah, maintenance = kuning, info = biru, promo = hijau
      type: DataTypes.ENUM('gangguan', 'maintenance', 'info', 'promo'),
      defaultValue: 'info'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    show_from: {
      type: DataTypes.DATE,
      allowNull: true
    },
    show_until: {
      type: DataTypes.DATE,
      allowNull: true   // null = tidak ada batas waktu
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    tableName: 'announcements',
    timestamps: true,
    indexes: [
      { fields: ['is_active', 'show_until'] }
    ]
  });
};
