const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AssetCategory = sequelize.define('AssetCategory', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    slug: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    icon: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'device' },
    description: { type: DataTypes.TEXT, allowNull: true },
    color: { type: DataTypes.STRING(20), allowNull: true, defaultValue: '#3b82f6' }
  }, {
    tableName: 'asset_categories',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return AssetCategory;
};
