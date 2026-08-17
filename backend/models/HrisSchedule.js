const { DataTypes } = require('sequelize');

/**
 * HrisSchedule
 * ──────────────────────────────────────────────────────────────────
 * Jadwal kerja: karyawan X pada tanggal Y bekerja di shift Z, lokasi L.
 *
 * Satu baris = satu hari kerja terjadwal. Bila tidak ada jadwal untuk
 * suatu tanggal, sistem jatuh ke shift & lokasi default karyawan
 * (Employee.shift_id / work_location_id).
 *
 * day_type membedakan hari kerja / libur / cuti / izin — dipakai saat
 * merekap absensi dan menghitung payroll.
 */
module.exports = (sequelize) => {
  const HrisSchedule = sequelize.define('HrisSchedule', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    employee_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'hris_employees', key: 'id' }
    },
    work_date: { type: DataTypes.DATEONLY, allowNull: false },

    shift_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'hris_shifts', key: 'id' }
    },
    work_location_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'hris_work_locations', key: 'id' }
    },

    day_type: {
      type: DataTypes.ENUM('kerja', 'libur', 'cuti', 'izin', 'sakit'),
      allowNull: false,
      defaultValue: 'kerja'
    },

    note: { type: DataTypes.STRING(255), allowNull: true }
  }, {
    tableName: 'hris_schedules',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['employee_id', 'work_date'], name: 'uniq_emp_date' },
      { fields: ['work_date'] },
      { fields: ['shift_id'] }
    ]
  });

  return HrisSchedule;
};
