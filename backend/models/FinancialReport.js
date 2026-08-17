const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FinancialReport = sequelize.define('FinancialReport', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    report_type: {
      type: DataTypes.ENUM('monthly', 'yearly'),
      allowNull: false
    },
    period_month: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    period_year: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    total_revenue: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0
    },
    total_invoiced: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0
    },
    total_outstanding: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0
    },
    total_customers: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    new_customers: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    churned_customers: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    report_data: {
      type: DataTypes.JSON,
      allowNull: true
    },
    generated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'financial_reports',
    timestamps: true,
    indexes: [
      { fields: ['report_type'] },
      { fields: ['period_year', 'period_month'] }
    ]
  });

  return FinancialReport;
};
