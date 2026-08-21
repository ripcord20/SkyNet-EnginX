const { DataTypes } = require('sequelize');

/**
 * MonitorState — persistensi status monitoring Telegram lintas restart.
 *
 * Masalah lama: state transisi (_state/_baseline) hanya di-memori, hilang saat
 * pm2 restart/deploy. Akibatnya device yang DOWN tepat saat restart tidak
 * pernah memicu notifikasi "down" (polling pertama jadi baseline).
 *
 * Solusi: simpan status terakhir tiap entitas di tabel ini. Saat startup,
 * MonitoringService memuatnya kembali → transisi tetap akurat tanpa baseline
 * massal & tanpa notif palsu.
 *
 * kind  : 'device' | 'ont' | 'ip' | 'pppoe'
 * ref_id: id entitas (deviceId/ontId/customerId) — string agar generik.
 * status: 'up' | 'down'
 * pending_status / pending_since : untuk flapping guard (status calon yang
 *   belum stabil; baru dipromosikan jadi `status` setelah stabil N detik).
 */
module.exports = (sequelize) => {
  const MonitorState = sequelize.define('MonitorState', {
    id:             { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    kind:           { type: DataTypes.STRING(12), allowNull: false },
    ref_id:         { type: DataTypes.STRING(40), allowNull: false },
    status:         { type: DataTypes.ENUM('up', 'down'), allowNull: false, defaultValue: 'up' },
    pending_status: { type: DataTypes.ENUM('up', 'down'), allowNull: true },
    pending_since:  { type: DataTypes.DATE, allowNull: true },
    last_change_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'monitor_states',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, name: 'uniq_monitor_kind_ref', fields: ['kind', 'ref_id'] },
      { fields: ['kind'] },
    ],
  });

  return MonitorState;
};
