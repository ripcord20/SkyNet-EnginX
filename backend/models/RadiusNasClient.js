const { DataTypes } = require('sequelize');

// RADIUS NAS (Network Access Server) client — router/device yang diizinkan
// mengirim Access-Request / Accounting-Request ke RADIUS server embedded kita.
// Konsepnya sama seperti tabel `nas` di FreeRADIUS: setiap NAS punya shared
// secret sendiri, dicocokkan berdasarkan IP sumber paket UDP yang masuk.
module.exports = (sequelize) => {
  return sequelize.define('RadiusNasClient', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    nas_ip_address: { type: DataTypes.STRING(45), allowNull: false, unique: true },
    // Shared secret disimpan terenkripsi (ConfigCrypto, AES-256-GCM) — lihat
    // RadiusServer.js untuk enkripsi/dekripsi saat load/save.
    secret: { type: DataTypes.STRING(255), allowNull: false },
    nas_type: { type: DataTypes.STRING(30), defaultValue: 'mikrotik' },
    description: { type: DataTypes.STRING(255), allowNull: true },
    // Label bebas untuk pengelompokan NAS per lokasi/site di UI (mis. "Kampung Mandar").
    // Kalau NAS terhubung ke Device, ini di-autofill dari device.location saat dibuat
    // (tetap bisa diedit terpisah — tidak selalu 1:1 dengan lokasi device).
    site_name: { type: DataTypes.STRING(150), allowNull: true },
    // 'direct'    = admin isi nas_ip_address manual (harus IP publik/reachable)
    // 'wireguard' = NAS di-provision otomatis lewat WireguardPeer; nas_ip_address
    //               diisi otomatis dari IP tunnel peer tsb — router TIDAK perlu IP publik.
    // 'vpn'       = NAS connect lewat L2TP/PPTP (pola INETmedia); nas_ip_address
    //               = IP tunnel PPP remote. Script MikroTik disembunyikan setelah online.
    connection_mode: { type: DataTypes.ENUM('direct', 'wireguard', 'vpn'), defaultValue: 'direct' },
    device_id: { type: DataTypes.INTEGER, allowNull: true },
    wireguard_peer_id: { type: DataTypes.INTEGER, allowNull: true },
    vpn_username: { type: DataTypes.STRING(80), allowNull: true },
    vpn_password: { type: DataTypes.STRING(255), allowNull: true },
    vpn_local_ip: { type: DataTypes.STRING(45), allowNull: true },
    vpn_remote_ip: { type: DataTypes.STRING(45), allowNull: true },
    vpn_protocols: { type: DataTypes.STRING(40), allowNull: true },
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'radius_nas_clients',
    timestamps: true,
    indexes: [
      { fields: ['nas_ip_address'] }, { fields: ['is_active'] },
      { fields: ['site_name'] }, { fields: ['device_id'] }, { fields: ['wireguard_peer_id'] },
    ]
  });
};
