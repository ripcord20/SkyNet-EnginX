const { DataTypes } = require('sequelize');

// RADIUS AAA user (mirip `radcheck` di FreeRADIUS, disederhanakan).
// Password disimpan terenkripsi-reversibel (bukan bcrypt) karena RADIUS PAP
// *dan* CHAP butuh plaintext di sisi server untuk verifikasi — CHAP secara
// matematis tidak bisa diverifikasi dari one-way hash. Lihat RadiusServer.js.
module.exports = (sequelize) => {
  return sequelize.define('RadiusUser', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    username: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    password: { type: DataTypes.STRING(255), allowNull: false },
    // Link opsional ke pelanggan — hanya untuk kemudahan referensi/autofill
    // username di UI. TIDAK dipakai untuk auth (customers tidak menyimpan
    // password PPPoE di DB aplikasi, itu hidup di router).
    customer_id: { type: DataTypes.INTEGER, allowNull: true },
    group_name: { type: DataTypes.STRING(50), allowNull: true },
    // Reply attributes opsional yang dikirim balik saat Access-Accept
    reply_framed_ip: { type: DataTypes.STRING(45), allowNull: true },
    // Format "upload/download", mis. "5M/2M" — dikirim sbg Mikrotik-Rate-Limit VSA
    reply_rate_limit: { type: DataTypes.STRING(50), allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    last_auth_at: { type: DataTypes.DATE, allowNull: true },
    last_auth_nas: { type: DataTypes.STRING(45), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'radius_users',
    timestamps: true,
    indexes: [{ fields: ['username'] }, { fields: ['is_active'] }, { fields: ['customer_id'] }]
  });
};
