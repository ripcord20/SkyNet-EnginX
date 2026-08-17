const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const InfrastructureLink = sequelize.define('InfrastructureLink', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(100), allowNull: true },
    from_point_id: { type: DataTypes.INTEGER, allowNull: false },
    to_point_id:   { type: DataTypes.INTEGER, allowNull: false },
    link_type: {
      type: DataTypes.ENUM('fiber','copper','wireless','trunk'),
      defaultValue: 'fiber'
    },
    status: {
      type: DataTypes.ENUM('active','inactive','maintenance'),
      defaultValue: 'active'
    },
    distance_m: { type: DataTypes.INTEGER, allowNull: true },
    waypoints:  { type: DataTypes.JSON, allowNull: true, comment: 'Array of [lat,lng] intermediate points' },
    notes:      { type: DataTypes.TEXT, allowNull: true },
    metadata:   { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'infrastructure_links',
    timestamps: true,
    indexes: [
      { fields: ['from_point_id'] },
      { fields: ['to_point_id'] },
      { fields: ['status'] }
    ]
  });
  return InfrastructureLink;
};