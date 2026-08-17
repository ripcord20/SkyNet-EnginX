const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const InfrastructurePoint = sequelize.define('InfrastructurePoint', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('odp', 'odc', 'ont', 'customer', 'pop', 'tower'),
      allowNull: false
    },
    latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: false
    },
    longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: false
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive', 'maintenance'),
      defaultValue: 'active'
    },
    capacity: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    used_ports: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    parent_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'infrastructure_points', key: 'id' }
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'infrastructure_points',
    timestamps: true,
    indexes: [
      { fields: ['type'] },
      { fields: ['status'] },
      { fields: ['latitude', 'longitude'] }
    ]
  });

  InfrastructurePoint.hasMany(InfrastructurePoint, { foreignKey: 'parent_id', as: 'children' });
  InfrastructurePoint.belongsTo(InfrastructurePoint, { foreignKey: 'parent_id', as: 'parent' });

  return InfrastructurePoint;
};
