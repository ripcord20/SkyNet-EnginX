const { DataTypes } = require('sequelize');

/**
 * CommissionPayment — catatan pembayaran komisi kolektor per periode.
 *
 * Mencegah dobel bayar (unik per collector_id + period_month + period_year)
 * dan dijadikan sumber kebenaran "komisi sudah dibayar". Saat dibuat, juga
 * dicatat sebagai pengeluaran di modul Keuangan (ref_number COMM-<id>) agar
 * laba bersih akurat.
 */
module.exports = (sequelize) => {
  const CommissionPayment = sequelize.define('CommissionPayment', {
    id:            { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    collector_id:  { type: DataTypes.INTEGER, allowNull: false },
    period_month:  { type: DataTypes.INTEGER, allowNull: false },
    period_year:   { type: DataTypes.INTEGER, allowNull: false },
    amount:        { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    paid_count:    { type: DataTypes.INTEGER, allowNull: true, comment: 'Jumlah invoice tertagih saat dibayarkan' },
    collected:     { type: DataTypes.DECIMAL(14, 2), allowNull: true, comment: 'Total terkumpul saat dibayarkan' },
    commission_type:  { type: DataTypes.STRING(20), allowNull: true },
    commission_value: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    keuangan_ref:  { type: DataTypes.STRING(50), allowNull: true, comment: 'ref_number entri keuangan terkait' },
    paid_by:       { type: DataTypes.INTEGER, allowNull: true, comment: 'Admin yang menandai dibayar' },
    note:          { type: DataTypes.STRING(255), allowNull: true },
  }, {
    tableName: 'commission_payments',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['collector_id', 'period_month', 'period_year'], name: 'uq_commission_period' },
      { fields: ['period_year', 'period_month'] },
    ]
  });

  return CommissionPayment;
};
