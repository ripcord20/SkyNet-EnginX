const { DataTypes } = require('sequelize');

/**
 * PppoeProvisionItem
 * ─────────────────────────────────────────────────────────────────────────────
 * Satu baris = satu user PPPoE yang akan dibuat di router.
 *
 * `status` di sini adalah CHECKPOINT. Worker selalu mengambil item dengan
 * status='pending', jadi kalau proses mati di tengah jalan (server restart,
 * koneksi router putus), job bisa di-resume tanpa membuat duplikat — item
 * yang sudah 'ok' tidak akan disentuh lagi.
 *
 * `mikrotik_id` menyimpan .id secret hasil create. Ini yang dipakai fitur
 * rollback untuk menghapus kembali secret yang dibuat oleh job ini saja,
 * tanpa mengganggu secret lain yang sudah ada di router.
 */
module.exports = (sequelize) => {
  const PppoeProvisionItem = sequelize.define('PppoeProvisionItem', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    job_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    row_number: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Nomor baris di file Excel asal — untuk pesan error yang informatif'
    },

    // ── Referensi ke CRM (opsional) ──────────────────────────────
    // Diisi kalau item berasal dari customer yang sudah ada di DB.
    customer_id: {
      type: DataTypes.STRING(32),
      allowNull: true,
      comment: 'customers.customer_id (CID), bukan PK'
    },
    customer_name: {
      type: DataTypes.STRING(150),
      allowNull: true
    },

    // ── Payload PPPoE secret ─────────────────────────────────────
    username: {
      type: DataTypes.STRING(64),
      allowNull: false
    },
    password: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    profile: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: 'Nama PPP profile di router; kosong → "default"'
    },
    service: {
      type: DataTypes.STRING(16),
      defaultValue: 'pppoe'
    },
    local_address: {
      type: DataTypes.STRING(45),
      allowNull: true
    },
    remote_address: {
      type: DataTypes.STRING(45),
      allowNull: true,
      comment: 'IP static per-user (opsional)'
    },
    comment: {
      type: DataTypes.STRING(128),
      allowNull: true
    },

    // ── Hasil eksekusi ───────────────────────────────────────────
    status: {
      type: DataTypes.ENUM('pending', 'ok', 'skipped', 'failed'),
      defaultValue: 'pending'
    },
    mikrotik_id: {
      type: DataTypes.STRING(32),
      allowNull: true,
      comment: '.id secret hasil create di RouterOS — dipakai untuk rollback'
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    attempts: {
      type: DataTypes.TINYINT,
      defaultValue: 0,
      comment: 'Jumlah percobaan; retry otomatis hanya untuk error transient'
    },
    processed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
  }, {
    tableName: 'pppoe_provision_items',
    timestamps: true,
    underscored: true,
    indexes: [
      // Index utama worker: ambil item pending milik job ini
      { fields: ['job_id', 'status'] },
      // Cegah username kembar dalam satu job
      { unique: true, fields: ['job_id', 'username'], name: 'uq_job_username' },
    ]
  });

  return PppoeProvisionItem;
};
