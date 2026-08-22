const { DataTypes } = require('sequelize');

// Interface WireGuard yang dikelola aplikasi ini (mis. "wg0") — server tunnel
// yang jalan di host yang sama dengan aplikasi. Private key disimpan
// terenkripsi (ConfigCrypto). Peer di-manage lewat WireguardPeer.
module.exports = (sequelize) => {
  return sequelize.define('WireguardServer', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    interface_name: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    private_key: { type: DataTypes.STRING(255), allowNull: false },
    public_key: { type: DataTypes.STRING(64), allowNull: false },
    listen_port: { type: DataTypes.INTEGER, defaultValue: 51820 },
    // CIDR interface itu sendiri, mis. "10.66.66.1/24" — .1 = alamat server,
    // /24 = ruang alamat yang dipakai untuk alokasi otomatis peer.
    address_cidr: { type: DataTypes.STRING(45), allowNull: false },
    // Host/IP publik yang dipakai client utk connect balik (Endpoint di conf client)
    endpoint_host: { type: DataTypes.STRING(255), allowNull: true },
    dns: { type: DataTypes.STRING(100), allowNull: true, defaultValue: '1.1.1.1' },
    mtu: { type: DataTypes.INTEGER, allowNull: true },
    // Status yang KITA inginkan (desired state). Status live sebenarnya dicek
    // via `ip link show` — lihat WireGuardService.getInterfaceState().
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'wireguard_servers',
    timestamps: true,
  });
};
