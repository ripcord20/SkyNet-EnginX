const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Asset = sequelize.define('Asset', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    asset_code: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      comment: 'Kode unik asset, auto-generate'
    },
    name: { type: DataTypes.STRING(200), allowNull: false },
    category_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'asset_categories', key: 'id' }
    },
    brand: { type: DataTypes.STRING(100), allowNull: true },
    model: { type: DataTypes.STRING(100), allowNull: true },
    serial_number: { type: DataTypes.STRING(150), allowNull: true },

    status: {
      type: DataTypes.ENUM('active', 'inactive', 'damaged', 'repair', 'storage', 'disposed', 'lost'),
      defaultValue: 'storage',
      comment: 'active=terpasang, storage=gudang, repair=servis, damaged=rusak, disposed=dibuang'
    },
    condition: {
      type: DataTypes.ENUM('new', 'good', 'fair', 'poor'),
      defaultValue: 'good'
    },

    // Pembelian
    purchase_date: { type: DataTypes.DATEONLY, allowNull: true },
    purchase_price: { type: DataTypes.DECIMAL(15, 2), allowNull: true, defaultValue: 0 },
    purchase_vendor: { type: DataTypes.STRING(150), allowNull: true },
    warranty_until: { type: DataTypes.DATEONLY, allowNull: true },

    // Lokasi & penugasan
    location: { type: DataTypes.STRING(200), allowNull: true, comment: 'Lokasi fisik / keterangan lokasi' },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'customers', key: 'id' },
      comment: 'Jika asset dipasang di customer'
    },
    infrastructure_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'infrastructure_points', key: 'id' },
      comment: 'Jika asset berada di titik ODP/infrastruktur'
    },
    ont_device_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'ont_devices', key: 'id' },
      comment: 'Link ke ONT GenieACS jika asset adalah ONT'
    },

    // Foto
    photo_url: { type: DataTypes.STRING(500), allowNull: true },

    // Info tambahan
    notes: { type: DataTypes.TEXT, allowNull: true },
    specs: { type: DataTypes.JSON, allowNull: true, comment: 'Spesifikasi teknis dalam format JSON' },

    // Tracking
    assigned_at: { type: DataTypes.DATE, allowNull: true },
    assigned_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' }
    }
  }, {
    tableName: 'assets',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return Asset;
};
