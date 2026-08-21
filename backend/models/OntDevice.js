const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const OntDevice = sequelize.define('OntDevice', {

    // ── Primary Key ─────────────────────────────────────────
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },

    // ── Identitas Device ────────────────────────────────────
    serial_number: {
      type: DataTypes.STRING(64),
      unique: true,
      allowNull: false,
      comment: 'Serial number ONT (unik)'
    },
    device_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'GenieACS device ID (untuk source=genieacs)'
    },

    // ── Relasi Pelanggan ────────────────────────────────────
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'customers', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    },

    // ── Info Perangkat ──────────────────────────────────────
    manufacturer: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    firmware: {
      type: DataTypes.STRING(100),
      allowNull: true
    },

    // ── Status & Sinyal ─────────────────────────────────────
    status: {
      type: DataTypes.ENUM('online', 'offline', 'warning', 'unknown'),
      defaultValue: 'unknown',
      comment: 'online | offline | warning (sinyal lemah) | unknown'
    },
    signal_strength: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'RX Power dalam dBm (misal: -22.5)'
    },
    uptime: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Uptime dalam format human-readable (misal: 5d 3h 12m)'
    },

    // ── Jaringan ────────────────────────────────────────────
    ip_address: {
      type: DataTypes.STRING(45),
      allowNull: true,
      comment: 'IP Address ONT (IPv4 atau IPv6)'
    },
    mac_address: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: 'MAC Address ONT (format: AA:BB:CC:DD:EE:FF)'
    },

    // ── Timestamps Sinkronisasi ─────────────────────────────
    last_inform: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Waktu terakhir ONT melapor (inform/poll)'
    },
    last_synced: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Waktu terakhir data di-sync dari sumber'
    },

    // ── Parameter TR-069 / SNMP ─────────────────────────────
    tr069_params: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Parameter detail: rx_power, tx_power, olt_rx_power, dll'
    },

    // ══════════════════════════════════════════════════════════
    // FIELD BARU — Sumber Data & Info OLT
    // ══════════════════════════════════════════════════════════

    // ── Sumber Data ─────────────────────────────────────────
    source: {
      type: DataTypes.STRING(50),
      defaultValue: 'genieacs',
      allowNull: false,
      comment: 'Sumber data: genieacs | snmp_hsgq | snmp_zte | snmp_huawei | manual'
    },

    // ── Referensi OLT (untuk source SNMP) ──────────────────
    olt_source_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'ID OLT di olt_config.json (hanya untuk source SNMP)'
    },
    olt_index: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: 'Index ONU di OLT SNMP (format: pon_port.onu_id, misal: 1.3)'
    },

    // ── Posisi di OLT ───────────────────────────────────────
    pon_port: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: true,
      comment: 'PON Port di OLT (1-4 untuk HSGQ E04I 4-port)'
    },
    onu_id: {
      type: DataTypes.SMALLINT.UNSIGNED,
      allowNull: true,
      comment: 'ONU ID di dalam PON port (biasanya 1-128)'
    },

    // ── Jarak ───────────────────────────────────────────────
    distance_m: {
      type: DataTypes.SMALLINT.UNSIGNED,
      allowNull: true,
      comment: 'Jarak fisik ONT ke OLT dalam meter (dari SNMP)'
    },

  }, {
    tableName: 'ont_devices',
    timestamps: true,   // createdAt, updatedAt otomatis
    indexes: [
      { fields: ['serial_number'] },
      { fields: ['customer_id'] },
      { fields: ['status'] },
      // Index baru
      { fields: ['source'] },
      { fields: ['olt_source_id'] },
      { fields: ['pon_port'] },
      { fields: ['last_inform'] },
    ]
  });

  return OntDevice;
};