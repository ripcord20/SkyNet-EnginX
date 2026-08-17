/**
 * NocMonitorPreset.js
 * ─────────────────────────────────────────────────────────────────
 * Stored preset untuk panel "Bandwidth Timeline" di NOC dashboard.
 *
 * Setiap preset:
 *   - Punya nama custom (mis. "WAN 1", "Distribusi Bandung")
 *   - Belong to router tertentu
 *   - Berisi daftar nama interface yang dipantau bareng (JSON array)
 *   - Berisi warna untuk grafik (hex string)
 *   - Belong to user (private per user, supaya tiap NOC operator bisa
 *     punya layout sendiri)
 *   - Punya position number untuk urutan render
 *
 * Created via /api/noc/monitors POST, list via GET, update via PATCH,
 * delete via DELETE. Lihat NocController untuk handler.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const NocMonitorPreset = sequelize.define('NocMonitorPreset', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Owner — preset bersifat private per user'
    },
    router_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Device.id dari router yang dipantau'
    },
    name: {
      type: DataTypes.STRING(80),
      allowNull: false,
      comment: 'Label custom yang ditampilkan di header panel'
    },
    ifaces: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
      comment: 'Array<string> nama interface MikroTik (e.g. ["ether1","sfp1"])',
      // MySQL kadang mengembalikan kolom JSON sebagai string mentah. Getter ini
      // menjamin nilai yang dibaca dari instance selalu berupa array.
      get() {
        const v = this.getDataValue('ifaces');
        if (Array.isArray(v)) return v;
        if (typeof v === 'string' && v.trim()) {
          try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; }
          catch (_) { return v.split(',').map(s => s.trim()).filter(Boolean); }
        }
        return [];
      }
    },
    color: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: '#3b82f6',
      comment: 'Hex warna utama chart (RX line). TX otomatis turunan.'
    },
    position: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Urutan render — lower first'
    },
  }, {
    tableName: 'noc_monitor_presets',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['user_id', 'router_id'] },
    ]
  });

  return NocMonitorPreset;
};
