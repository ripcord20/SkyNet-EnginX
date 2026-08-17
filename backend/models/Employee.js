const { DataTypes } = require('sequelize');

/**
 * Employee (HRIS)
 * ──────────────────────────────────────────────────────────────────
 * Data karyawan — tabel MANDIRI. Tidak wajib punya akun login.
 *
 * Relasi ke sistem:
 *   - user_id (nullable, unique): OPSIONAL. Kalau diisi, karyawan ini
 *     bisa login pakai akun User yang sudah ada (mis. teknisi/sales
 *     yang juga karyawan). Kalau null, karyawan tetap tercatat di HRIS
 *     tanpa bisa login (mis. staf lapangan yang absen via kiosk admin).
 *
 * Semua nilai gaji dalam Rupiah penuh (tanpa desimal sen kecuali perlu).
 */
module.exports = (sequelize) => {
  const Employee = sequelize.define('Employee', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    uuid: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      unique: true
    },

    // ── Link opsional ke akun login ─────────────────────────────
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      unique: true,
      references: { model: 'users', key: 'id' },
      comment: 'Opsional — link ke akun User untuk login. Null = karyawan tanpa login.'
    },

    // ── Identitas ────────────────────────────────────────────────
    employee_no: {
      type: DataTypes.STRING(30),
      allowNull: false,
      unique: true,
      comment: 'Nomor Induk Karyawan (NIK internal), mis. EMP-0001'
    },
    full_name:   { type: DataTypes.STRING(120), allowNull: false },
    email:       { type: DataTypes.STRING(150), allowNull: true, validate: { isEmailOrEmpty(v){ if(v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error('email tidak valid'); } } },
    phone:       { type: DataTypes.STRING(20),  allowNull: true, comment: 'Nomor WA untuk kirim slip gaji' },
    nik_ktp:     { type: DataTypes.STRING(20),  allowNull: true, comment: 'NIK KTP (opsional)' },
    gender:      { type: DataTypes.ENUM('L', 'P'), allowNull: true },
    birth_date:  { type: DataTypes.DATEONLY, allowNull: true },
    address:     { type: DataTypes.TEXT, allowNull: true },
    photo:       { type: DataTypes.STRING(255), allowNull: true, comment: 'Path foto profil karyawan' },

    // ── Kepegawaian ──────────────────────────────────────────────
    position:    { type: DataTypes.STRING(80),  allowNull: true, comment: 'Jabatan' },
    department:  { type: DataTypes.STRING(80),  allowNull: true, comment: 'Departemen / divisi' },
    employment_type: {
      type: DataTypes.ENUM('tetap', 'kontrak', 'harian', 'magang', 'freelance'),
      allowNull: false,
      defaultValue: 'tetap'
    },
    join_date:   { type: DataTypes.DATEONLY, allowNull: true },
    resign_date: { type: DataTypes.DATEONLY, allowNull: true },

    // ── Penempatan default ──────────────────────────────────────
    work_location_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'hris_work_locations', key: 'id' },
      comment: 'Lokasi kerja default (untuk validasi absensi)'
    },
    shift_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'hris_shifts', key: 'id' },
      comment: 'Shift default bila tidak ada jadwal spesifik'
    },

    // ── Payroll dasar ────────────────────────────────────────────
    base_salary: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0,
      comment: 'Gaji pokok per periode (bulanan)'
    },
    salary_type: {
      type: DataTypes.ENUM('bulanan', 'harian', 'per_jam'),
      allowNull: false,
      defaultValue: 'bulanan'
    },
    bank_name:    { type: DataTypes.STRING(60), allowNull: true },
    bank_account: { type: DataTypes.STRING(40), allowNull: true },

    status: {
      type: DataTypes.ENUM('active', 'inactive', 'resigned'),
      allowNull: false,
      defaultValue: 'active'
    }
  }, {
    tableName: 'hris_employees',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['employee_no'] },
      { fields: ['status'] },
      { fields: ['work_location_id'] },
      { fields: ['shift_id'] },
      { fields: ['department'] }
    ]
  });

  return Employee;
};
