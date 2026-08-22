const { DataTypes } = require('sequelize');

/**
 * HrisWorkLocation
 * ──────────────────────────────────────────────────────────────────
 * Lokasi kerja / titik geofence untuk validasi absensi.
 *
 * Absensi karyawan hanya sah bila koordinat GPS-nya berada dalam
 * radius_meters dari (latitude, longitude) lokasi ini. Satu karyawan
 * punya lokasi default (Employee.work_location_id), tapi bisa juga
 * dibolehkan absen di beberapa lokasi lewat jadwal kerja.
 *
 * allow_any_location: bila true, karyawan di lokasi ini boleh absen
 * dari mana saja (mis. untuk pekerja lapangan / WFH). Radius diabaikan.
 */
module.exports = (sequelize) => {
  const HrisWorkLocation = sequelize.define('HrisWorkLocation', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    name:    { type: DataTypes.STRING(100), allowNull: false, comment: 'Nama lokasi, mis. Kantor Pusat' },
    address: { type: DataTypes.TEXT, allowNull: true },

    latitude:  { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },

    radius_meters: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
      comment: 'Radius geofence (meter) — absensi valid bila dalam radius ini'
    },

    allow_any_location: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'true = boleh absen dari mana saja (radius diabaikan)'
    },

    // ── Kebijakan anti-fake GPS per lokasi ──────────────────────
    max_accuracy_meters: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 50,
      comment: 'Tolak absensi bila akurasi GPS lebih buruk (angka lebih besar) dari ini'
    },
    reject_mock_location: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Tolak bila perangkat melaporkan mock/fake GPS'
    },

    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
  }, {
    tableName: 'hris_work_locations',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['is_active'] }
    ]
  });

  return HrisWorkLocation;
};
