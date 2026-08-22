const { DataTypes } = require('sequelize');

// ════════════════════════════════════════════════════════════════
//  RecurringExpense — template pengeluaran berulang (sewa, gaji,
//  bandwidth upstream, listrik, dll). Cron tiap awal bulan membuat
//  entri 'pengeluaran' di tabel keuangan berdasarkan template ini.
// ════════════════════════════════════════════════════════════════
module.exports = (sequelize) => {
  const RecurringExpense = sequelize.define('RecurringExpense', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: {                       // mis. "Sewa Kantor", "Gaji Teknisi"
      type: DataTypes.STRING(150),
      allowNull: false
    },
    category: {                   // mis. "Operasional", "Gaji", "Bandwidth"
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: 'Operasional'
    },
    amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0
    },
    // Tanggal jatuh tempo dalam sebulan (1-28). Entri dibuat pada tanggal ini.
    day_of_month: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    party_name: {                 // penerima (vendor, karyawan, dll)
      type: DataTypes.STRING(150),
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    active: {                     // bisa di-pause tanpa hapus
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    // Penanda kapan terakhir di-generate (format 'YYYY-MM') supaya tidak dobel
    last_generated_period: {
      type: DataTypes.STRING(7),
      allowNull: true
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    }
  }, {
    tableName: 'recurring_expenses',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['active'] },
      { fields: ['day_of_month'] }
    ]
  });

  return RecurringExpense;
};
