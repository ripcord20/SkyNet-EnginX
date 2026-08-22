const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
  return sequelize.define('AppSetting', {
    id:          { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    key:         { type: DataTypes.STRING(100), allowNull: false, unique: true },
    value:       { type: DataTypes.TEXT('medium'), allowNull: true },
    type:        { type: DataTypes.STRING(30), defaultValue: 'string' },
    description: { type: DataTypes.STRING(255), allowNull: true }
  }, {
    tableName: 'app_settings', timestamps: false,
    updatedAt: 'updated_at', createdAt: false
  });
};
