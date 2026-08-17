const { DataTypes } = require('sequelize');

/**
 * HrisLeaveRequest
 * ──────────────────────────────────────────────────────────────────
 * Pengajuan izin / cuti / sakit oleh karyawan. Setelah di-approve,
 * tanggal-tanggal dalam rentang ini memengaruhi rekap absensi & payroll
 * (tidak dihitung alfa).
 */
module.exports = (sequelize) => {
  const HrisLeaveRequest = sequelize.define('HrisLeaveRequest', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    employee_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'hris_employees', key: 'id' }
    },

    type: {
      type: DataTypes.ENUM('cuti', 'izin', 'sakit', 'dinas'),
      allowNull: false,
      defaultValue: 'izin'
    },
    start_date: { type: DataTypes.DATEONLY, allowNull: false },
    end_date:   { type: DataTypes.DATEONLY, allowNull: false },
    days:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    reason:     { type: DataTypes.TEXT, allowNull: true },
    attachment: { type: DataTypes.STRING(255), allowNull: true, comment: 'Path lampiran (surat dokter dll)' },

    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending'
    },
    reviewed_by:   { type: DataTypes.INTEGER, allowNull: true, references: { model: 'users', key: 'id' } },
    reviewed_at:   { type: DataTypes.DATE, allowNull: true },
    review_note:   { type: DataTypes.STRING(255), allowNull: true }
  }, {
    tableName: 'hris_leave_requests',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['employee_id'] },
      { fields: ['status'] },
      { fields: ['start_date'] }
    ]
  });

  return HrisLeaveRequest;
};
