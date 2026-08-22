/**
 * Tenant.js — Model untuk Multi-Tenant System (ISP Billing Reseller)
 * ─────────────────────────────────────────────────────────────────────────────
 * Setiap tenant adalah penyedia internet terpisah yang menggunakan sistem ini.
 * Data mereka diisolasi dengan kolom `tenant_id` di setiap tabel transaksional.
 * 
 * Fitur:
 * - Subdomain unik (misal: tenant1.billing-saya.com)
 * - Paket harga sewa bulanan
 * - Status aktif/non-aktif
 * - Tanggal expired langganan
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Tenant = sequelize.define('Tenant', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    uuid: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      unique: true
    },
    // Nama perusahaan/ISP tenant
    name: {
      type: DataTypes.STRING(150),
      allowNull: false
    },
    // Email admin tenant (untuk login & notifikasi)
    email: {
      type: DataTypes.STRING(150),
      allowNull: false,
      unique: true,
      validate: { isEmail: true }
    },
    // Subdomain unik (lowercase, alphanumeric + hyphen)
    subdomain: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      validate: {
        is: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i
      }
    },
    // Password hash untuk login admin tenant
    password: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    // Nama kontak person
    contact_name: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    // Nomor telepon/WA kontak
    contact_phone: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    // Alamat lengkap tenant
    address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    // Paket sewa: 'basic', 'standard', 'premium'
    // Atau bisa custom price per tenant
    subscription_plan: {
      type: DataTypes.ENUM('basic', 'standard', 'premium', 'custom'),
      defaultValue: 'basic'
    },
    // Harga sewa bulanan (Rp)
    monthly_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0
    },
    // Batas maksimal pelanggan (berdasarkan paket)
    max_customers: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100
    },
    // Batas maksimal user/staff
    max_users: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5
    },
    // Status aktif/non-aktif (non-aktif = suspend)
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    // Tanggal langganan dimulai
    subscription_start: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    // Tanggal langganan expired
    subscription_expires: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    // Token API untuk integrasi webhook (opsional)
    api_token: {
      type: DataTypes.STRING(64),
      allowNull: true,
      unique: true
    },
    // Logo tenant (path file)
    logo_path: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // Konfigurasi custom (JSON)
    settings: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {}
    },
    // Catatan internal admin super
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    last_login: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'tenants',
    timestamps: true,
    hooks: {
      beforeCreate: async (tenant) => {
        if (tenant.password) {
          const bcrypt = require('bcryptjs');
          tenant.password = await bcrypt.hash(tenant.password, 12);
        }
        if (!tenant.api_token) {
          tenant.api_token = require('crypto').randomBytes(32).toString('hex');
        }
      },
      beforeUpdate: async (tenant) => {
        if (tenant.changed('password')) {
          const bcrypt = require('bcryptjs');
          tenant.password = await bcrypt.hash(tenant.password, 12);
        }
      }
    }
  });

  Tenant.prototype.validatePassword = async function(password) {
    const bcrypt = require('bcryptjs');
    return bcrypt.compare(password, this.password);
  };

  Tenant.prototype.toJSON = function() {
    const values = Object.assign({}, this.get());
    delete values.password;
    delete values.api_token;
    return values;
  };

  return Tenant;
};
