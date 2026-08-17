const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AssetHistory = sequelize.define('AssetHistory', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    asset_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'assets', key: 'id' }
    },
    action: {
      type: DataTypes.ENUM(
        'created', 'updated', 'status_change', 'assigned', 'unassigned',
        'moved', 'repaired', 'disposed', 'photo_updated'
      ),
      allowNull: false
    },
    old_value: { type: DataTypes.TEXT, allowNull: true, comment: 'JSON string nilai sebelumnya' },
    new_value: { type: DataTypes.TEXT, allowNull: true, comment: 'JSON string nilai sesudahnya' },
    note: { type: DataTypes.TEXT, allowNull: true },
    performed_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    }
  }, {
    tableName: 'asset_history',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  return AssetHistory;
};
