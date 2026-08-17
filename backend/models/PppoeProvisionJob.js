const { DataTypes } = require('sequelize');

/**
 * PppoeProvisionJob
 * ─────────────────────────────────────────────────────────────────────────────
 * Header job untuk bulk provisioning user PPPoE ke MikroTik.
 * Satu job = satu batch pembuatan secret ke SATU router tujuan.
 *
 * Alur status:
 *   pending  → job dibuat dari preview, belum dieksekusi
 *   running  → worker sedang jalan
 *   paused   → di-pause user; item pending masih tersisa, bisa di-resume
 *   done     → semua item sudah diproses (ok/skipped/failed)
 *   failed   → job gagal total (mis. router tidak bisa dihubungi sama sekali)
 */
module.exports = (sequelize) => {
  const PppoeProvisionJob = sequelize.define('PppoeProvisionJob', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    // devices.id — router tujuan. Bukan mikrotik_devices.id.
    device_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'devices.id router tujuan provisioning'
    },
    device_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Snapshot nama router saat job dibuat (untuk display histori)'
    },
    source: {
      type: DataTypes.ENUM('excel', 'customers', 'manual'),
      defaultValue: 'excel',
      comment: 'Asal data: upload excel / pilih customer existing / input manual'
    },
    status: {
      // 'scheduled' = menunggu waktu yang ditentukan; scheduler akan
      // memindahkannya ke 'pending' lalu menjalankan worker.
      type: DataTypes.ENUM('scheduled', 'pending', 'running', 'paused', 'done', 'failed'),
      defaultValue: 'pending'
    },

    // Waktu eksekusi terjadwal. NULL = jalankan segera saat tombol ditekan.
    // Berguna untuk migrasi besar yang sebaiknya jalan di luar jam sibuk,
    // saat pelanggan tidak sedang aktif memakai jaringan.
    scheduled_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Jadwal eksekusi; NULL = jalankan segera'
    },
    total:     { type: DataTypes.INTEGER, defaultValue: 0 },
    succeeded: { type: DataTypes.INTEGER, defaultValue: 0 },
    failed:    { type: DataTypes.INTEGER, defaultValue: 0 },
    skipped:   { type: DataTypes.INTEGER, defaultValue: 0 },

    // Opsi eksekusi, disimpan JSON supaya fleksibel tanpa migrasi kolom baru:
    //   {
    //     dryRun:      bool   — simulasi, tidak menulis ke router
    //     onDuplicate: 'skip' | 'overwrite'
    //     concurrency: int    — request paralel (default 3)
    //     delayMs:     int    — jeda antar batch (default 120)
    //     syncToCrm:   bool   — update customers.pppoe_username & mikrotik_id
    //   }
    options: {
      type: DataTypes.JSON,
      allowNull: true
    },

    // Ringkasan error level-job (bukan level-item)
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    // Hasil verifikasi pasca-job: perbandingan item 'ok' dengan kondisi
    // nyata di router. { checked, confirmed, missing, idRecovered, ... }
    // Diisi otomatis di akhir runJob kecuali dry run.
    verification: {
      type: DataTypes.JSON,
      allowNull: true
    },

    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'users.id yang membuat job'
    },
    started_at:  { type: DataTypes.DATE, allowNull: true },
    finished_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'pppoe_provision_jobs',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['status'] },
      { fields: ['device_id'] },
      // Dipakai scheduler: cari job 'scheduled' yang waktunya sudah tiba
      { fields: ['status', 'scheduled_at'] },
    ]
  });

  return PppoeProvisionJob;
};
