const { DataTypes } = require('sequelize');

/**
 * Data wilayah Indonesia (provinsi → kabupaten → kecamatan → desa).
 * Disimpan di server sendiri agar tidak bergantung API pihak ketiga.
 * Kode/ID mengikuti skema emsifa (string) supaya kompatibel dengan data
 * pelanggan lama yang sudah menyimpan kode wilayah.
 */
module.exports = (sequelize) => {
  const Province = sequelize.define('Province', {
    id:   { type: DataTypes.STRING(2),  primaryKey: true },   // "32"
    name: { type: DataTypes.STRING(100), allowNull: false },
  }, { tableName: 'regions_provinces', timestamps: false });

  const Regency = sequelize.define('Regency', {
    id:          { type: DataTypes.STRING(5),  primaryKey: true },  // "3201"
    province_id: { type: DataTypes.STRING(2),  allowNull: false },
    name:        { type: DataTypes.STRING(100), allowNull: false },
  }, { tableName: 'regions_regencies', timestamps: false,
       indexes: [{ fields: ['province_id'] }] });

  const District = sequelize.define('District', {
    id:         { type: DataTypes.STRING(8),  primaryKey: true },   // "3201010"
    regency_id: { type: DataTypes.STRING(5),  allowNull: false },
    name:       { type: DataTypes.STRING(100), allowNull: false },
  }, { tableName: 'regions_districts', timestamps: false,
       indexes: [{ fields: ['regency_id'] }] });

  const Village = sequelize.define('Village', {
    id:          { type: DataTypes.STRING(13), primaryKey: true },  // "3201010001"
    district_id: { type: DataTypes.STRING(8),  allowNull: false },
    name:        { type: DataTypes.STRING(100), allowNull: false },
  }, { tableName: 'regions_villages', timestamps: false,
       indexes: [{ fields: ['district_id'] }] });

  return { Province, Regency, District, Village };
};
