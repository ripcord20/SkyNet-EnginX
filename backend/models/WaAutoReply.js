const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('WaAutoReply', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    session_id: { type: DataTypes.STRING(50), allowNull: false },
    keyword: { type: DataTypes.STRING(200), allowNull: false },
    match_type: {
      type: DataTypes.ENUM('exact', 'contains', 'startswith'),
      defaultValue: 'contains'
    },
    reply_message: { type: DataTypes.TEXT, allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    hit_count: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: 'wa_auto_replies',
    timestamps: true,
    indexes: [{ fields: ['session_id'] }, { fields: ['is_active'] }]
  });
};
