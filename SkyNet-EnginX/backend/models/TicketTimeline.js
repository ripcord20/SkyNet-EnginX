const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TicketTimeline = sequelize.define('TicketTimeline', {
    id:          { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    ticket_id:   { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    user_id:     { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    type: {
      type: DataTypes.ENUM('comment','status_change','assignment','photo','system'),
      defaultValue: 'comment'
    },
    content:     { type: DataTypes.TEXT, allowNull: true },
    old_value:   { type: DataTypes.STRING(100), allowNull: true },
    new_value:   { type: DataTypes.STRING(100), allowNull: true },
    attachments: { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'ticket_timelines',
    timestamps: true,
    underscored: true,
    updatedAt: false
  });
  return TicketTimeline;
};
