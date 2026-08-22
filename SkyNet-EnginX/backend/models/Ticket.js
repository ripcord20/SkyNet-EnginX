const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Ticket = sequelize.define('Ticket', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    ticket_number: { type: DataTypes.STRING(20), unique: true },
    type: {
      type: DataTypes.ENUM('gangguan','request','installation','maintenance'),
      defaultValue: 'gangguan'
    },
    priority: {
      type: DataTypes.ENUM('low','medium','high','critical'),
      defaultValue: 'medium'
    },
    status: {
      type: DataTypes.ENUM('open','in_progress','pending','resolved','closed'),
      defaultValue: 'open'
    },
    title:          { type: DataTypes.STRING(255), allowNull: false },
    description:    { type: DataTypes.TEXT },
    customer_id:    { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    infra_point_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    assigned_to:    { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    created_by:     { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    latitude:       { type: DataTypes.DECIMAL(10,8), allowNull: true },
    longitude:      { type: DataTypes.DECIMAL(11,8), allowNull: true },
    location_note:  { type: DataTypes.STRING(255), allowNull: true },
    sla_hours:      { type: DataTypes.INTEGER, defaultValue: 24 },
    resolved_at:    { type: DataTypes.DATE, allowNull: true },
    closed_at:      { type: DataTypes.DATE, allowNull: true },
    due_at:         { type: DataTypes.DATE, allowNull: true },
    tags:           { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'tickets',
    timestamps: true,
    underscored: true,
    hooks: {
      beforeCreate: async (ticket) => {
        if (!ticket.ticket_number) {
          const prefix = ticket.type.substring(0,3).toUpperCase();
          const date   = new Date();
          const ymd    = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
          const count  = await sequelize.models.Ticket.count({ where: sequelize.literal(`DATE(created_at) = CURDATE()`) }).catch(() => 0);
          ticket.ticket_number = `${prefix}-${ymd}-${String(count+1).padStart(4,'0')}`;
        }
        if (!ticket.due_at && ticket.sla_hours) {
          ticket.due_at = new Date(Date.now() + ticket.sla_hours * 3600000);
        }
      }
    }
  });
  return Ticket;
};
