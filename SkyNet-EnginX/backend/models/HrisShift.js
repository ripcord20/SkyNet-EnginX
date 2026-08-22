const { DataTypes } = require('sequelize');

/**
 * HrisShift
 * ──────────────────────────────────────────────────────────────────
 * Definisi shift kerja (mis. Pagi 08:00–17:00, Malam 20:00–05:00).
 *
 * Waktu disimpan sebagai TIME 'HH:MM:SS' zona lokal (APP_TIMEZONE).
 * Shift lintas-hari (malam) ditandai crosses_midnight = true, di mana
 * end_time < start_time berarti selesai di keesokan harinya.
 *
 * grace_late_minutes  : toleransi menit sebelum dianggap terlambat.
 * break_minutes       : durasi istirahat (dikurangi dari jam kerja).
 */
module.exports = (sequelize) => {
  const HrisShift = sequelize.define('HrisShift', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    name:  { type: DataTypes.STRING(60), allowNull: false, comment: 'Nama shift, mis. Pagi / Malam' },
    code:  { type: DataTypes.STRING(20), allowNull: true, unique: true, comment: 'Kode singkat, mis. P / M' },

    start_time: { type: DataTypes.TIME, allowNull: false, comment: 'Jam masuk (HH:MM:SS)' },
    end_time:   { type: DataTypes.TIME, allowNull: false, comment: 'Jam pulang (HH:MM:SS)' },

    crosses_midnight: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'true jika shift berakhir di hari berikutnya (shift malam)'
    },

    grace_late_minutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 10,
      comment: 'Toleransi keterlambatan (menit)'
    },
    early_leave_minutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Toleransi pulang cepat (menit)'
    },
    break_minutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 60,
      comment: 'Durasi istirahat (menit)'
    },

    color:     { type: DataTypes.STRING(9), allowNull: true, defaultValue: '#2563eb', comment: 'Warna label di kalender jadwal' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
  }, {
    tableName: 'hris_shifts',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['code'] },
      { fields: ['is_active'] }
    ]
  });

  return HrisShift;
};
