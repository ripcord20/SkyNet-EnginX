const { DataTypes } = require('sequelize');

/**
 * CashDeposit
 * ──────────────────────────────────────────────────────────────────
 * Setoran kas dari kolektor ke kantor + rekonsiliasi.
 *
 * Alur:
 *   1. Kolektor menerima uang tunai dari beberapa pelanggan → cash_held naik.
 *   2. Akhir hari/shift kolektor menyetor → buat record CashDeposit:
 *        expected_amount  = total yang seharusnya disetor (dihitung sistem)
 *        deposited_amount = nominal yang benar2 disetor (input kolektor)
 *        variance         = deposited - expected (auto; <0 berarti kurang)
 *   3. Admin verifikasi:
 *        verified  → cash_held kolektor dikurangi deposited_amount
 *        rejected  → setoran ditolak (mis. bukti tidak valid)
 *
 * proof_path = foto bukti setor (slip transfer / foto serah-terima).
 *
 * Semua nilai uang dalam Rupiah penuh.
 */
module.exports = (sequelize) => {
  const CashDeposit = sequelize.define('CashDeposit', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    collector_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'users', key: 'id' } },

    deposit_date: { type: DataTypes.DATEONLY, allowNull: false },

    expected_amount:  { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0, comment: 'Total yg seharusnya disetor (cash_held saat setor)' },
    deposited_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0, comment: 'Nominal yg benar2 disetor' },
    variance:         { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0, comment: 'deposited - expected (auto)' },

    status: {
      type: DataTypes.ENUM('pending', 'verified', 'rejected'),
      allowNull: false,
      defaultValue: 'pending'
    },

    proof_path:  { type: DataTypes.STRING(255), allowNull: true, comment: 'Foto bukti setor' },
    note:        { type: DataTypes.TEXT, allowNull: true },

    verified_at: { type: DataTypes.DATE, allowNull: true },
    verified_by: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'users', key: 'id' } },
    reject_reason: { type: DataTypes.STRING(255), allowNull: true }
  }, {
    tableName: 'cash_deposits',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['collector_id', 'status'] },
      { fields: ['deposit_date'] }
    ]
  });

  return CashDeposit;
};
