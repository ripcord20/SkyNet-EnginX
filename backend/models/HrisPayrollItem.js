const { DataTypes } = require('sequelize');

/**
 * HrisPayrollItem
 * ──────────────────────────────────────────────────────────────────
 * Slip gaji satu karyawan dalam satu batch payroll.
 *
 * Komponen tunjangan (allowances) dan potongan (deductions) disimpan
 * sebagai JSON array [{label, amount}] supaya fleksibel tanpa migrasi
 * tabel tiap ada komponen baru. net_salary = gross - total_deductions.
 *
 * Snapshot rekap absensi (present_days, late_count, dst) disimpan agar
 * slip tetap konsisten walau data absensi berubah setelahnya.
 */
module.exports = (sequelize) => {
  const HrisPayrollItem = sequelize.define('HrisPayrollItem', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    payroll_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'hris_payrolls', key: 'id' }
    },
    employee_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'hris_employees', key: 'id' }
    },

    // ── Snapshot rekap absensi ──────────────────────────────────
    present_days:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    absent_days:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    leave_days:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    late_count:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    late_minutes:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    overtime_minutes:{ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // ── Komponen gaji ───────────────────────────────────────────
    base_salary:      { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    allowances:       { type: DataTypes.JSON, allowNull: true, comment: 'Array [{label, amount}]' },
    deductions:       { type: DataTypes.JSON, allowNull: true, comment: 'Array [{label, amount}]' },
    overtime_pay:     { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },

    gross_salary:     { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    total_allowances: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    total_deductions: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    net_salary:       { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },

    // ── Pengiriman slip ─────────────────────────────────────────
    slip_pdf_path:  { type: DataTypes.STRING(255), allowNull: true },
    email_status:   { type: DataTypes.ENUM('pending', 'sent', 'failed', 'skipped'), allowNull: false, defaultValue: 'pending' },
    wa_status:      { type: DataTypes.ENUM('pending', 'sent', 'failed', 'skipped'), allowNull: false, defaultValue: 'pending' },
    sent_at:        { type: DataTypes.DATE, allowNull: true },

    note: { type: DataTypes.STRING(255), allowNull: true }
  }, {
    tableName: 'hris_payroll_items',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['payroll_id', 'employee_id'], name: 'uniq_payroll_emp' },
      { fields: ['employee_id'] }
    ]
  });

  return HrisPayrollItem;
};
