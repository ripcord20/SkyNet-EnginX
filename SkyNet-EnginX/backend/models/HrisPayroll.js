const { DataTypes } = require('sequelize');

/**
 * HrisPayroll
 * ──────────────────────────────────────────────────────────────────
 * Batch penggajian untuk satu periode (mis. bulan Juli 2026).
 * Menampung banyak HrisPayrollItem (satu per karyawan).
 *
 * Alur: draft → dihitung dari absensi → finalized → slip dikirim.
 */
module.exports = (sequelize) => {
  const HrisPayroll = sequelize.define('HrisPayroll', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    period_label: { type: DataTypes.STRING(30), allowNull: false, comment: 'Label periode, mis. Juli 2026' },
    period_start: { type: DataTypes.DATEONLY, allowNull: false },
    period_end:   { type: DataTypes.DATEONLY, allowNull: false },

    status: {
      type: DataTypes.ENUM('draft', 'finalized', 'paid'),
      allowNull: false,
      defaultValue: 'draft'
    },

    total_amount: { type: DataTypes.DECIMAL(16, 2), allowNull: false, defaultValue: 0 },
    employee_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    note:       { type: DataTypes.STRING(255), allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'users', key: 'id' } },
    finalized_at: { type: DataTypes.DATE, allowNull: true },
    paid_at:    { type: DataTypes.DATE, allowNull: true }
  }, {
    tableName: 'hris_payrolls',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['status'] },
      { fields: ['period_start', 'period_end'] }
    ]
  });

  return HrisPayroll;
};
