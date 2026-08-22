/**
 * NmsInterface.js
 * ─────────────────────────────────────────────────────────────────
 * Interface MikroTik yang dipilih untuk dimonitor di halaman
 * "NMS · Interface Monitor".
 *
 * Setiap baris:
 *   - device_id     : perangkat MikroTik sumber (FK ke devices, nullable
 *                     untuk router default dari config)
 *   - if_name       : nama interface persis di RouterOS (mis. "ether1",
 *                     "vlan10-SERVER")
 *   - label         : nama tampilan custom (opsional; default = if_name)
 *   - color         : warna aksen kartu/grafik (hex)
 *   - position      : urutan tampil
 *   - is_active     : tampilkan / sembunyikan tanpa hapus
 *
 * Dikelola via /api/nms/interfaces (GET/POST/DELETE/PATCH).
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('NmsInterface', {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    device_id: { type: DataTypes.INTEGER, allowNull: true },
    if_name:   { type: DataTypes.STRING(128), allowNull: false },
    label:     { type: DataTypes.STRING(128), allowNull: true },
    color:     { type: DataTypes.STRING(16), allowNull: true, defaultValue: '#2563eb' },
    position:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
  }, {
    tableName: 'nms_interfaces',
    timestamps: true,
    indexes: [{ fields: ['device_id'] }]
  });
};
