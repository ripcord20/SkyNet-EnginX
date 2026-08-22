const { DataTypes } = require('sequelize');

/**
 * CollectorProfile
 * ──────────────────────────────────────────────────────────────────
 * Profil tambahan untuk user ber-role "collector" (petugas penagih
 * lapangan). Satu user collector = satu CollectorProfile (1:1).
 *
 * Menyimpan:
 *   - area/wilayah kerja (untuk auto-assign per area)
 *   - skema komisi (flat per invoice lunas ATAU persen dari nominal)
 *   - cash_held: saldo tunai yang SEDANG dipegang kolektor (belum disetor)
 *
 * cash_held adalah angka turunan tapi disimpan (denormalized) supaya
 * dashboard cepat. Sumber kebenaran tetap:
 *   cash_held = SUM(payment cash via collector) - SUM(deposit verified)
 * Helper rekonsiliasi di CollectionService akan menghitung ulang bila perlu.
 *
 * Semua nilai uang dalam Rupiah penuh (tanpa desimal sen).
 */
module.exports = (sequelize) => {
  const CollectorProfile = sequelize.define('CollectorProfile', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: 'users', key: 'id' }
    },

    phone:  { type: DataTypes.STRING(20),  allowNull: true },
    region: { type: DataTypes.STRING(100), allowNull: true, comment: 'Wilayah / area kerja kolektor' },

    // ── Skema komisi ────────────────────────────────────────────
    // 'flat'    : Rp commission_value per invoice yang berhasil lunas
    // 'percent' : commission_value % dari nominal pembayaran yang ditagih
    // 'none'    : tanpa komisi
    commission_type: {
      type: DataTypes.ENUM('flat', 'percent', 'none'),
      allowNull: false,
      defaultValue: 'flat',
      comment: 'Skema komisi kolektor'
    },
    commission_value: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 5000,
      comment: 'Nominal flat (Rp) atau persen (%) tergantung commission_type'
    },

    // ── Kas yang dipegang (denormalized, untuk dashboard cepat) ──
    cash_held: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0,
      comment: 'Saldo tunai yang sedang dipegang kolektor (cash on hand)'
    },

    is_active: { type: DataTypes.BOOLEAN, defaultValue: true }
  }, {
    tableName: 'collector_profiles',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['region'] }
    ]
  });

  return CollectorProfile;
};
