const { DataTypes } = require('sequelize');

/**
 * HrisAttendance
 * ──────────────────────────────────────────────────────────────────
 * Satu baris = satu hari absensi seorang karyawan (check-in & check-out).
 *
 * Menyimpan selfie + koordinat GPS + hasil validasi anti-fake GPS untuk
 * BAIK check-in maupun check-out. Field *_flags menyimpan JSON detail
 * pemeriksaan (radius, mock, accuracy, ip/device) supaya bisa diaudit.
 *
 * status  : hasil rekap harian (hadir / terlambat / alfa / izin / ...).
 * is_valid: false bila ada pelanggaran anti-fake yang memblokir absensi.
 */
module.exports = (sequelize) => {
  const HrisAttendance = sequelize.define('HrisAttendance', {
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

    // ── CHECK-IN ────────────────────────────────────────────────
    check_in_at:        { type: DataTypes.DATE, allowNull: true },
    check_in_lat:       { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    check_in_lng:       { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    check_in_accuracy:  { type: DataTypes.FLOAT, allowNull: true, comment: 'Akurasi GPS (meter)' },
    check_in_distance:  { type: DataTypes.FLOAT, allowNull: true, comment: 'Jarak ke lokasi kerja (meter)' },
    check_in_selfie:    { type: DataTypes.STRING(255), allowNull: true, comment: 'Path foto selfie masuk' },
    check_in_flags:     { type: DataTypes.JSON, allowNull: true, comment: 'Detail hasil anti-fake GPS check-in' },
    check_in_note:      { type: DataTypes.STRING(255), allowNull: true },

    // ── CHECK-OUT ───────────────────────────────────────────────
    check_out_at:       { type: DataTypes.DATE, allowNull: true },
    check_out_lat:      { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    check_out_lng:      { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    check_out_accuracy: { type: DataTypes.FLOAT, allowNull: true },
    check_out_distance: { type: DataTypes.FLOAT, allowNull: true },
    check_out_selfie:   { type: DataTypes.STRING(255), allowNull: true },
    check_out_flags:    { type: DataTypes.JSON, allowNull: true },
    check_out_note:     { type: DataTypes.STRING(255), allowNull: true },

    // ── Rekap turunan ───────────────────────────────────────────
    late_minutes:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    early_leave_minutes:{ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    work_minutes:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: 'Total menit kerja bersih' },
    overtime_minutes:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    status: {
      type: DataTypes.ENUM('hadir', 'terlambat', 'pulang_cepat', 'alfa', 'izin', 'sakit', 'cuti', 'libur'),
      allowNull: false,
      defaultValue: 'hadir'
    },

    is_valid: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'false bila absensi diblokir/ditandai karena pelanggaran anti-fake'
    },

    // ── Konteks perangkat (audit anti-fake) ─────────────────────
    ip_address: { type: DataTypes.STRING(64), allowNull: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
    device_id:  { type: DataTypes.STRING(120), allowNull: true, comment: 'Fingerprint perangkat (opsional)' },

    // Sumber input: 'mobile' (karyawan), 'admin' (kiosk admin)
    source: {
      type: DataTypes.ENUM('mobile', 'admin', 'web'),
      allowNull: false,
      defaultValue: 'mobile'
    }
  }, {
    tableName: 'hris_attendances',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['employee_id', 'work_date'], name: 'uniq_att_emp_date' },
      { fields: ['work_date'] },
      { fields: ['status'] },
      { fields: ['is_valid'] }
    ]
  });

  return HrisAttendance;
};
