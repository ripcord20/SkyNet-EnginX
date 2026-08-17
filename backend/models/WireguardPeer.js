const { DataTypes } = require('sequelize');

// Satu peer WireGuard (client) di bawah sebuah WireguardServer (interface).
// private_key/preshared_key NULL berarti peer dibuat manual dari public key
// milik client sendiri — kita tidak bisa menerbitkan file konfigurasi utuh
// untuk peer semacam itu (client sudah generate & simpan key-nya sendiri).
module.exports = (sequelize) => {
  return sequelize.define('WireguardPeer', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    server_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    customer_id: { type: DataTypes.INTEGER, allowNull: true },
    public_key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    private_key: { type: DataTypes.STRING(255), allowNull: true },
    preshared_key: { type: DataTypes.STRING(255), allowNull: true },
    // IP tunnel milik peer ini, mis. "10.66.66.5/32" — dipakai di sisi SERVER
    // sebagai AllowedIPs peer tsb (menentukan routing masuk). Unik per server.
    allocated_ip: { type: DataTypes.STRING(45), allowNull: false },
    // AllowedIPs di sisi CLIENT (apa yang di-route lewat tunnel) — default
    // subnet interface (split-tunnel), bisa diubah admin mis. "0.0.0.0/0".
    client_allowed_ips: { type: DataTypes.STRING(255), allowNull: false },
    // Endpoint opsional — hanya relevan utk peer site-to-site (mis. router
    // cabang yang juga listen), kosong utk peer road-warrior biasa.
    endpoint: { type: DataTypes.STRING(255), allowNull: true },
    persistent_keepalive: { type: DataTypes.INTEGER, defaultValue: 25 },
    is_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    last_handshake_at: { type: DataTypes.DATE, allowNull: true },
    transfer_rx: { type: DataTypes.BIGINT, defaultValue: 0 },
    transfer_tx: { type: DataTypes.BIGINT, defaultValue: 0 },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'wireguard_peers',
    timestamps: true,
    indexes: [
      { fields: ['server_id'] },
      { unique: true, fields: ['server_id', 'allocated_ip'], name: 'uniq_wg_peer_ip_per_server' },
    ]
  });
};
