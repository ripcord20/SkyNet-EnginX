const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
  return sequelize.define('WaBroadcast', {
    id:            { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    title:         { type: DataTypes.STRING(200), allowNull: false },
    template_id:   { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    message:       { type: DataTypes.TEXT, allowNull: false },
    target_type:   { type: DataTypes.ENUM('all','active','by_package','overdue','custom'), defaultValue: 'all' },
    target_filter: { type: DataTypes.JSON, allowNull: true },
    status:        { type: DataTypes.ENUM('draft','scheduled','running','completed','cancelled','failed'), defaultValue: 'draft' },
    scheduled_at:  { type: DataTypes.DATE, allowNull: true },
    started_at:    { type: DataTypes.DATE, allowNull: true },
    completed_at:  { type: DataTypes.DATE, allowNull: true },
    total_targets: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    total_sent:    { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    total_failed:  { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    send_interval: { type: DataTypes.SMALLINT.UNSIGNED, defaultValue: 10 },
    created_by:    { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
  }, { tableName: 'wa_broadcast', timestamps: true });
};
