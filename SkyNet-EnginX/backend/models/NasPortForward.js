const { DataTypes } = require('sequelize');

// Port forwarding per-NAS lewat tunnel WireGuard — mis. supaya admin bisa buka
// Winbox/SSH ke router yang IP publiknya tidak ada (di belakang CGNAT), dengan
// meneruskan port di interface publik server ke IP tunnel router tsb.
// Hanya relevan untuk RadiusNasClient dengan connection_mode='wireguard'.
module.exports = (sequelize) => {
  return sequelize.define('NasPortForward', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nas_client_id: { type: DataTypes.INTEGER, allowNull: false },
    public_port: { type: DataTypes.INTEGER, allowNull: false },
    target_port: { type: DataTypes.INTEGER, allowNull: false },
    protocol: { type: DataTypes.ENUM('tcp', 'udp'), defaultValue: 'tcp' },
    description: { type: DataTypes.STRING(150), allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'nas_port_forwards',
    timestamps: true,
    indexes: [
      { fields: ['nas_client_id'] },
      { unique: true, fields: ['public_port', 'protocol'], name: 'uniq_nas_portforward_public_port' },
    ]
  });
};
