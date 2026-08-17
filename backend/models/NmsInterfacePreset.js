/**
 * NmsInterfacePreset.js
 * ─────────────────────────────────────────────────────────────────
 * FlayNMS — preset interface yang dimonitoring di halaman NMS.
 *
 * Berbeda dengan NocMonitorPreset (private per-user, untuk panel NOC),
 * preset ini bersifat GLOBAL / shared: dipilih sekali, tampil sama di
 * semua device/browser (sinkron lintas device). Setiap baris = satu
 * interface pada satu router yang ditandai untuk dipantau.
 *
 * CRUD via /api/nms/interfaces (GET list, POST add, DELETE remove,
 * PATCH reorder). Lihat NmsController.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const NmsInterfacePreset = sequelize.define('NmsInterfacePreset', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    router_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Device.id router MikroTik'
    },
    iface_name: {
      type: DataTypes.STRING(120),
      allowNull: false,
      comment: 'Nama interface MikroTik (e.g. ether1, sfp-sfpplus1, vlan100)'
    },
    label: {
      type: DataTypes.STRING(120),
      allowNull: true,
      comment: 'Label custom opsional untuk ditampilkan di panel'
    },
    color: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: '#3b82f6',
      comment: 'Warna aksen panel (hex)'
    },
    position: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Urutan render — lower first'
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'User.id yang menambahkan (audit ringan)'
    }
  }, {
    tableName: 'nms_interface_presets',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['router_id'] },
      { unique: true, fields: ['router_id', 'iface_name'] }
    ]
  });

  return NmsInterfacePreset;
};
