const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Keuangan = sequelize.define('Keuangan', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    type: {
      // pemasukan, pengeluaran, hutang, piutang, modal
      type: DataTypes.ENUM('pemasukan','pengeluaran','hutang','piutang','modal'),
      allowNull: false
    },
    category: {
      // e.g. 'Operasional','Gaji','Peralatan','Sewa','Lain-lain'
      type: DataTypes.STRING(100),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    // untuk hutang/piutang: tanggal jatuh tempo
    due_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    // hutang/piutang: nama pihak (vendor/customer)
    party_name: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    // hutang/piutang: status
    status: {
      type: DataTypes.ENUM('lunas','belum_lunas','cicilan'),
      allowNull: true,
      defaultValue: null
    },
    // untuk modal: keterangan sumber modal
    source: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    // bukti/attachment filename
    attachment: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // referensi nomor (no invoice, no kwitansi)
    ref_number: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    recorded_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'keuangan',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['type'] },
      { fields: ['date'] },
      { fields: ['status'] },
      { fields: ['category'] }
    ]
  });

  return Keuangan;
};