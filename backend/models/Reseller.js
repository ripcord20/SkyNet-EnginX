/**
 * Reseller.js — Akun reseller voucher hotspot (mis. warung / kios).
 * ─────────────────────────────────────────────────────────────────────────────
 * Reseller punya login terpisah (bukan tabel users) dengan token JWT
 * type='reseller'. Saldo deposit dipotong otomatis tiap generate voucher.
 *
 * Saldo disimpan sebagai DECIMAL(14,2) — sumber kebenaran tunggal. Setiap
 * perubahan saldo WAJIB lewat ResellerTransaction (ledger) supaya bisa diaudit.
 */
const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');

module.exports = (sequelize) => {
  const Reseller = sequelize.define('Reseller', {
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
    // Kode login unik (mis. "WARUNG01"). Dipakai sebagai username login.
    code: {
      type: DataTypes.STRING(40),
      allowNull: false,
      unique: true
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false
    },
    phone: {
      type: DataTypes.STRING(25),
      allowNull: true
    },
    address: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    // Saldo deposit (Rupiah). Tidak boleh negatif (di-guard di controller).
    balance: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0
    },
    // Router MikroTik yang dipakai reseller ini. null = pakai default env.
    // Penting untuk multi-MikroTik: voucher reseller A digenerate di router A.
    device_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'devices', key: 'id' }
    },
    // ── Keagenan bertingkat (#4) ────────────────────────────────────────
    // Reseller induk (master agen). null = reseller langsung di bawah admin.
    parent_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'resellers', key: 'id' }
    },
    // Persen komisi yang didapat induk dari penjualan sub-reseller (0-100).
    commission_percent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0
    },
    // ── Markup / harga modal fleksibel (#2) ─────────────────────────────
    // Diskon global (persen) dari cost_price paket untuk reseller ini.
    // Mis. 10 = reseller bayar 90% dari cost_price. Override spesifik per
    // paket diatur di tabel reseller_package_prices.
    price_discount_percent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0
    },
    // Label tier (informasi: 'bronze'/'silver'/'gold'/'platinum' dsb).
    price_tier: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    // Hotspot server tempat voucher dibuat (mis. "hotspot1"). 'all' = default.
    hotspot_server: {
      type: DataTypes.STRING(60),
      allowNull: true,
      defaultValue: 'all'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    // Batas maksimal voucher per sekali generate (anti-fraud / anti-typo).
    max_per_batch: {
      type: DataTypes.INTEGER,
      defaultValue: 100
    },
    last_login: {
      type: DataTypes.DATE,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'resellers',
    timestamps: true,
    hooks: {
      beforeCreate: async (r) => {
        if (r.password) r.password = await bcrypt.hash(r.password, 12);
      },
      beforeUpdate: async (r) => {
        if (r.changed('password')) r.password = await bcrypt.hash(r.password, 12);
      }
    }
  });

  Reseller.prototype.validatePassword = async function (password) {
    return bcrypt.compare(password, this.password);
  };

  Reseller.prototype.toJSON = function () {
    const v = Object.assign({}, this.get());
    delete v.password;
    return v;
  };

  return Reseller;
};
