const { DataTypes } = require('sequelize');

/**
 * SalesCommission
 * ──────────────────────────────────────────────────────────────────
 * Catatan komisi sales. Satu record dibuat per aktivasi pelanggan
 * (saat Work Order instalasi berstatus done → registration activated).
 *
 * status:
 *   pending  → dihitung tapi belum memenuhi syarat (jaga-jaga)
 *   earned   → instalasi selesai, komisi siap dibayar
 *   paid     → sudah dibayarkan ke sales
 *   void     → dibatalkan (mis. pelanggan churn cepat)
 *
 * Field scheme menyimpan asal perhitungan agar transparan/auditable.
 */
module.exports = (sequelize) => {
  const SalesCommission = sequelize.define('SalesCommission', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    sales_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'id' }
    },

    registration_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'registration_requests', key: 'id' }
    },
    customer_id: { type: DataTypes.INTEGER, allowNull: true },
    package_id:  { type: DataTypes.INTEGER, allowNull: true },

    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0
    },

    scheme: {
      type: DataTypes.ENUM('flat_package', 'percent_monthly', 'category_default', 'manual'),
      defaultValue: 'category_default',
      comment: 'Dari mana nilai komisi dihitung'
    },
    scheme_detail: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Penjelasan singkat, mis. "10% x Rp300.000"'
    },

    status: {
      type: DataTypes.ENUM('pending', 'earned', 'approved', 'paid', 'void'),
      defaultValue: 'earned',
      allowNull: false
    },

    earned_at:    { type: DataTypes.DATE, allowNull: true },
    approved_at:  { type: DataTypes.DATE, allowNull: true },
    approved_by:  { type: DataTypes.INTEGER, allowNull: true },
    paid_at:   { type: DataTypes.DATE, allowNull: true },
    paid_by:   { type: DataTypes.INTEGER, allowNull: true },
    payment_method: { type: DataTypes.STRING(50),  allowNull: true },
    payment_proof:  { type: DataTypes.STRING(255), allowNull: true },
    notes:     { type: DataTypes.TEXT, allowNull: true }
  }, {
    tableName: 'sales_commissions',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['sales_id'] },
      { fields: ['status'] },
      { fields: ['registration_id'] }
    ]
  });

  return SalesCommission;
};
