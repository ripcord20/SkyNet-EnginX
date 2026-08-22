const { DataTypes } = require('sequelize');

// RADIUS accounting — mirip `radacct` di FreeRADIUS, disederhanakan. Satu
// baris per sesi (Acct-Session-Id + NAS), di-upsert oleh Start/Interim-Update/
// Stop. Sesi "live" = stopped_at IS NULL.
module.exports = (sequelize) => {
  return sequelize.define('RadiusAccounting', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    acct_session_id: { type: DataTypes.STRING(80), allowNull: false },
    username: { type: DataTypes.STRING(100), allowNull: true },
    nas_ip_address: { type: DataTypes.STRING(45), allowNull: false },
    framed_ip_address: { type: DataTypes.STRING(45), allowNull: true },
    calling_station_id: { type: DataTypes.STRING(50), allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    stopped_at: { type: DataTypes.DATE, allowNull: true },
    terminate_cause: { type: DataTypes.STRING(50), allowNull: true },
    // BIGINT via string-safe DataTypes.BIGINT — Acct-Input/Output-Octets +
    // Gigawords overflow counter digabung jadi satu angka byte total (lihat
    // helper octetsFromAttrs di RadiusServer.js).
    input_octets: { type: DataTypes.BIGINT, defaultValue: 0 },
    output_octets: { type: DataTypes.BIGINT, defaultValue: 0 },
    session_time: { type: DataTypes.INTEGER, defaultValue: 0 },
    last_update_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'radius_accounting',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['acct_session_id', 'nas_ip_address'], name: 'uniq_radius_acct_session' },
      { fields: ['username'] },
      { fields: ['stopped_at'] },
    ]
  });
};
