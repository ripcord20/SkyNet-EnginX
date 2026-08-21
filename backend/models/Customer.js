const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Customer = sequelize.define('Customer', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    customer_id: {
      type: DataTypes.STRING(20),
      unique: true,
      allowNull: false
    },
    name: {
      type: DataTypes.STRING(150),
      allowNull: false
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    nik: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    // ── Komponen wilayah terstruktur (untuk filter per-area) ──
    province: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    regency: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    district: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    village: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    portal_password: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    portal_enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    last_portal_login: {
      type: DataTypes.DATE,
      allowNull: true
    },
    package_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'packages', key: 'id' }
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive', 'isolated', 'suspended'),
      defaultValue: 'active'
    },
    latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: true
    },
    longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: true
    },
    // Parent ODP/ODC/POP untuk auto-sync ke InfrastructurePoint type='customer'.
    // Saat customer disimpan dgn lat/lng, sistem akan otomatis membuat/update
    // record InfrastructurePoint dengan parent_id = nilai ini. Boleh NULL kalau
    // customer belum ditentukan ODP induknya — admin bisa set belakangan dari
    // halaman /infrastructure dengan drag/edit.
    infra_parent_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'infrastructure_points', key: 'id' }
    },
    ont_sn: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    ont_mac: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    installation_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    documents: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: []
    },
    static_ip: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    connection_type: {
      type: DataTypes.ENUM('pppoe','static','hotspot'),
      allowNull: true
    },
    mac_address: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    mikrotik_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true
    },
    isolir_status: {
      type: DataTypes.ENUM('active','isolated','restoring'),
      defaultValue: 'active'
    },
    isolir_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    pppoe_username: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    billing_date: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      validate: { min: 1, max: 28 }
    },
    due_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    // Token acak untuk link pembayaran PERMANEN per-pelanggan (/pub/cust/:token).
    // Bisa di-revoke dengan generate ulang. NULL = belum pernah dibuat.
    public_link_token: {
      type: DataTypes.STRING(64),
      allowNull: true,
      unique: true
    },
    // ── Carry-over tagihan (dari partial payment lapangan) ───────────
    // Saat kolektor menerima pembayaran SEBAGIAN, invoice periode ini
    // ditandai lunas dan sisa kurang bayar disimpan di sini. Saat generate
    // invoice bulan berikutnya, nilai ini DITAMBAHKAN ke total tagihan baru
    // lalu di-reset ke 0. Default 0 = tidak ada tunggakan carry-over.
    carry_over_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0
    }
  }, {
    tableName: 'customers',
    timestamps: true,
    indexes: [
      { fields: ['customer_id'] },
      { fields: ['status'] },
      { fields: ['name'] },
      { fields: ['phone'] }
    ]
  });

  return Customer;
};