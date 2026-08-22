const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Invoice = sequelize.define('Invoice', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    invoice_number: {
      type: DataTypes.STRING(30),
      unique: true,
      allowNull: false
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'customers', key: 'id' }
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false
    },
    tax: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0
    },
    total: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('unpaid', 'paid', 'overdue', 'cancelled'),
      defaultValue: 'unpaid'
    },
    // ── Verifikasi pembayaran MANUAL (transfer + bukti) ──────────────
    // Terpisah dari `status`. Gateway tidak menyentuh kolom ini.
    verification_status: {
      type: DataTypes.ENUM('none', 'submitted', 'verified', 'rejected'),
      defaultValue: 'none'
    },
    proof_path: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    proof_submitted_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    proof_note: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    last_wa_reminder_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    due_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    paid_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    period_month: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    period_year: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    pdf_path: {
      type: DataTypes.STRING(255),
      allowNull: true
    }
  }, {
    tableName: 'invoices',
    timestamps: true,
    indexes: [
      { fields: ['invoice_number'] },
      { fields: ['customer_id'] },
      { fields: ['status'] },
      { fields: ['due_date'] },
      { fields: ['period_month', 'period_year'] }
    ]
  });

  return Invoice;
};
