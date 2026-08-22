/**
 * PushTemplate.js
 * Template pesan push notification yang reusable.
 * Dipakai untuk promo, info, maintenance, dll.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('PushTemplate', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    category: {
      type: DataTypes.ENUM('promo', 'info', 'maintenance', 'warning', 'greeting', 'other'),
      defaultValue: 'info'
    },
    icon: {
      type: DataTypes.STRING(10),         // emoji
      allowNull: true
    },
    title: {
      type: DataTypes.STRING(120),
      allowNull: false
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    url: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    tag: {
      type: DataTypes.STRING(60),
      allowNull: true
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    }
  }, {
    tableName: 'push_templates',
    timestamps: true,
    indexes: [
      { fields: ['category'] }
    ]
  });
};
