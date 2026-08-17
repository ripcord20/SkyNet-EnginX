const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Todo = sequelize.define('Todo', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM('todo','in_progress','done'),
      defaultValue: 'todo'
    },
    priority: {
      type: DataTypes.ENUM('low','medium','high','critical'),
      defaultValue: 'medium'
    },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    assigned_to: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    position: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Sort order dalam kolom' },
    tags: { type: DataTypes.JSON, allowNull: true },
    color: { type: DataTypes.STRING(20), defaultValue: 'blue' }
  }, {
    tableName: 'todos',
    timestamps: true,
    underscored: true
  });

  return Todo;
};
