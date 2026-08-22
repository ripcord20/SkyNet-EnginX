const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Package = sequelize.define('Package', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    speed_down: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Download speed in Mbps'
    },
    speed_up: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Upload speed in Mbps'
    },
    price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    category: {
      type: DataTypes.ENUM('home', 'business', 'enterprise', 'custom'),
      defaultValue: 'home',
      comment: 'Kategori paket untuk tampilan dan filter'
    },
    // ── Override komisi sales per paket (opsional) ─────────────
    // Prioritas hitung komisi: commission_flat > commission_percent >
    // default per-kategori di SalesProfile. 0 = pakai default kategori.
    commission_flat: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
      comment: 'Override komisi flat per paket (Rp)'
    },
    commission_percent: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
      comment: 'Override komisi persen dari harga bulanan'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    // ── Mapping paket → PPP profile MikroTik ───────────────────
    // Diisi sekali di master paket, lalu dipakai bulk provisioning untuk
    // menentukan profile mana yang dipasang ke tiap user PPPoE.
    // Kosong = pakai profile 'default' di router.
    mikrotik_profile: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: 'Nama PPP profile di MikroTik untuk paket ini'
    }
  }, {
    tableName: 'packages',
    timestamps: true
  });

  return Package;
};
