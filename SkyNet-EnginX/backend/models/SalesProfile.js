const { DataTypes } = require('sequelize');
const crypto = require('crypto');

/**
 * SalesProfile
 * ──────────────────────────────────────────────────────────────────
 * Profil tambahan untuk user ber-role "sales". Menyimpan kode referral
 * unik (dipakai di link registrasi), target bulanan, dan skema komisi
 * default. Satu user sales = satu SalesProfile (1:1).
 *
 * Catatan skema komisi (urutan prioritas saat menghitung komisi):
 *   1. Package.commission_flat   (override per paket, jika > 0)
 *   2. Package.commission_percent (override per paket, % dari harga bulanan)
 *   3. category default di tabel ini (commission_home/business/enterprise)
 *
 * Semua nilai uang dalam Rupiah penuh (tanpa desimal sen).
 */
module.exports = (sequelize) => {
  const SalesProfile = sequelize.define('SalesProfile', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: 'users', key: 'id' }
    },

    // Kode unik untuk link referral. Contoh: SLS-AB12CD
    referral_code: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true
    },

    phone:  { type: DataTypes.STRING(20),  allowNull: true },
    region: { type: DataTypes.STRING(100), allowNull: true, comment: 'Wilayah / area kerja sales' },

    // ── Target & bonus ──────────────────────────────────────────
    monthly_target: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Target jumlah aktivasi pelanggan baru per bulan'
    },
    target_bonus: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
      comment: 'Bonus rupiah jika target bulanan tercapai'
    },

    // ── Skema komisi default per kategori produk ─────────────────
    commission_home: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 50000,
      comment: 'Komisi flat default untuk paket kategori home'
    },
    commission_business: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 250000,
      comment: 'Komisi flat default untuk paket kategori business'
    },
    commission_enterprise: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 1000000,
      comment: 'Komisi flat default untuk paket kategori enterprise/dedicated'
    },
    commission_custom: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
      comment: 'Komisi flat default untuk paket kategori custom'
    },

    is_active: { type: DataTypes.BOOLEAN, defaultValue: true }
  }, {
    tableName: 'sales_profiles',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['referral_code'] },
      { fields: ['user_id'] }
    ],
    hooks: {
      beforeValidate: (profile) => {
        if (!profile.referral_code) {
          profile.referral_code = SalesProfile.generateCode();
        }
      }
    }
  });

  // Generate kode referral acak yang mudah dibaca (tanpa karakter ambigu)
  SalesProfile.generateCode = function () {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa 0/O/1/I
    let s = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) s += chars[bytes[i] % chars.length];
    return `SLS-${s}`;
  };

  return SalesProfile;
};
