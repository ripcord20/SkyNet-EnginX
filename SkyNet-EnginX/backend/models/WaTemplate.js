const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
  return sequelize.define('WaTemplate', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    category: {
      type: DataTypes.ENUM(
        'reminder_before','reminder_due','reminder_overdue',
        'broadcast','custom','payment_confirm',
        'isolir','restore','welcome',
        // Kategori untuk tombol "Kirim via WA" di halaman invoice.
        // Backend (PaymentController._sendWaInvoiceImpl) memilih otomatis:
        //   invoice PAID            → 'invoice_paid'   (fallback ke 'payment_confirm')
        //   invoice UNPAID/OVERDUE  → 'invoice_unpaid' (fallback ke template default)
        'invoice_unpaid','invoice_paid'
      ),
      defaultValue: 'custom'
    },
    content:    { type: DataTypes.TEXT, allowNull: true },
    message:    { type: DataTypes.TEXT, allowNull: true },  // backward compat
    variables:  { type: DataTypes.JSON, defaultValue: [] },
    is_active:  { type: DataTypes.BOOLEAN, defaultValue: true },
    usage_count:{ type: DataTypes.INTEGER, defaultValue: 0 },
    created_by: { type: DataTypes.INTEGER, allowNull: true }
  }, { tableName: 'wa_templates', timestamps: true });
};