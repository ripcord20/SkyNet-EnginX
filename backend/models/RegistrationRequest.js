const { DataTypes } = require('sequelize');

/**
 * RegistrationRequest
 * ──────────────────────────────────────────────────────────────────
 * Lead pendaftaran pelanggan baru. Masuk dari form publik yang dibuka
 * lewat link referral sales (/registrasi-layanan/:code) ATAU dibuat manual oleh
 * sales/admin.
 *
 * Lifecycle status:
 *   lead            → baru masuk dari form, belum diproses
 *   survey_request  → dijadwalkan survey lapangan
 *   surveyed        → survey selesai, hasil terisi
 *   survey_rejected → lokasi tidak layak / pelanggan batal
 *   approved        → survey disetujui, siap generate Work Order instalasi
 *   installing      → Work Order instalasi dibuat & assigned
 *   activated       → instalasi selesai + customer dibuat (komisi earned)
 *   cancelled       → dibatalkan
 *
 * Saat status menjadi 'activated', kolom customer_id terisi (link ke
 * Customer yang dibuat) dan SalesCommission dengan status 'earned' dibuat.
 */
module.exports = (sequelize) => {
  const RegistrationRequest = sequelize.define('RegistrationRequest', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    reg_number: {
      type: DataTypes.STRING(25),
      unique: true,
      comment: 'Auto-generated: REG-YYMMDD-XXXX'
    },

    // ── Data calon pelanggan ─────────────────────────────────────
    name:    { type: DataTypes.STRING(150), allowNull: false },
    phone:   { type: DataTypes.STRING(20),  allowNull: false },
    email:   { type: DataTypes.STRING(150), allowNull: true },
    id_card_number: { type: DataTypes.STRING(30), allowNull: true, comment: 'No. KTP' },
    ktp_photo:       { type: DataTypes.STRING(255), allowNull: true, comment: 'URL foto KTP' },
    house_photo:     { type: DataTypes.STRING(255), allowNull: true, comment: 'URL foto rumah pelanggan' },
    installed_photo: { type: DataTypes.STRING(255), allowNull: true, comment: 'URL foto after instalasi' },
    address: { type: DataTypes.TEXT, allowNull: false },

    latitude:  { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: true },

    // Paket yang diminta (opsional saat lead awal)
    package_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'packages', key: 'id' }
    },

    notes: { type: DataTypes.TEXT, allowNull: true, comment: 'Catatan calon pelanggan' },

    // ── Atribusi sales ───────────────────────────────────────────
    sales_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      comment: 'User sales pemilik referral (null jika daftar langsung)'
    },
    referral_code: { type: DataTypes.STRING(20), allowNull: true },
    source: {
      type: DataTypes.ENUM('referral_link', 'manual_sales', 'walk_in'),
      defaultValue: 'referral_link'
    },

    // ── Status & workflow ────────────────────────────────────────
    status: {
      type: DataTypes.ENUM(
        'lead', 'survey_request', 'surveyed', 'survey_rejected',
        'approved', 'installing', 'activated', 'cancelled'
      ),
      defaultValue: 'lead',
      allowNull: false
    },

    // ── Coverage Checker snapshot (diisi saat submit/cek) ────────
    coverage_status: {
      type: DataTypes.ENUM('available', 'not_covered', 'unknown'),
      defaultValue: 'unknown'
    },
    nearest_odp_id:       { type: DataTypes.INTEGER, allowNull: true },
    nearest_odp_distance: { type: DataTypes.INTEGER, allowNull: true, comment: 'Jarak udara ke ODP terdekat (meter)' },
    nearest_pop_id:       { type: DataTypes.INTEGER, allowNull: true },
    nearest_pop_distance: { type: DataTypes.INTEGER, allowNull: true, comment: 'Jarak udara ke POP terdekat (meter)' },
    cable_estimate:       { type: DataTypes.INTEGER, allowNull: true, comment: 'Estimasi panjang kabel drop (meter)' },

    // ── Hasil survey lapangan ────────────────────────────────────
    survey_request_at:    { type: DataTypes.DATE, allowNull: true },
    survey_scheduled_date:{ type: DataTypes.DATEONLY, allowNull: true },
    surveyed_at:          { type: DataTypes.DATE, allowNull: true },
    survey_by:            { type: DataTypes.INTEGER, allowNull: true, references: { model: 'users', key: 'id' } },
    survey_photos:        { type: DataTypes.JSON, defaultValue: [], comment: 'Array {url, caption}' },
    survey_cable_length:  { type: DataTypes.INTEGER, allowNull: true, comment: 'Estimasi kabel hasil survey (meter)' },
    survey_extra_material:{ type: DataTypes.TEXT, allowNull: true, comment: 'Material tambahan yang dibutuhkan' },
    survey_cost_estimate: { type: DataTypes.DECIMAL(12, 2), allowNull: true, comment: 'Estimasi biaya instalasi' },
    survey_notes:         { type: DataTypes.TEXT, allowNull: true, comment: 'Catatan teknisi' },
    survey_reject_reason: { type: DataTypes.TEXT, allowNull: true },

    // ── Link ke hasil ────────────────────────────────────────────
    work_order_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, comment: 'WO instalasi yang digenerate' },
    customer_id:   { type: DataTypes.INTEGER, allowNull: true, comment: 'Customer yang dibuat saat activated' },

    approved_by:   { type: DataTypes.INTEGER, allowNull: true },
    approved_at:   { type: DataTypes.DATE, allowNull: true },
    activated_at:  { type: DataTypes.DATE, allowNull: true },

    // ── Jejak audit penghapusan ──────────────────────────────────
    // Registrasi bisa terhubung ke Customer aktif dan komisi sales, jadi
    // penghapusan harus bisa dipertanggungjawabkan: siapa, kapan, kenapa.
    deleted_by:    { type: DataTypes.INTEGER, allowNull: true, comment: 'users.id yang menghapus' },
    delete_reason: { type: DataTypes.TEXT,    allowNull: true, comment: 'Alasan penghapusan' }
  }, {
    tableName: 'registration_requests',
    timestamps: true,
    underscored: true,
    // ── Soft delete ──────────────────────────────────────────────
    // paranoid:true membuat destroy() hanya mengisi deleted_at, dan SEMUA
    // query (findAll/findOne/count) otomatis menyaring baris terhapus.
    // Ini lebih aman daripada kolom flag manual: tidak ada query lama yang
    // perlu diubah, dan tidak ada risiko data terhapus ikut terhitung di
    // statistik atau laporan komisi.
    //
    // Untuk melihat data terhapus: findAll({ paranoid: false })
    // Untuk memulihkan: instance.restore()
    paranoid: true,
    deletedAt: 'deleted_at',
    indexes: [
      { fields: ['status'] },
      { fields: ['deleted_at'] },
      { fields: ['sales_id'] },
      { fields: ['referral_code'] },
      { fields: ['phone'] }
    ],
    hooks: {
      beforeCreate: async (reg) => {
        if (!reg.reg_number) {
          const d = new Date();
          const yy = String(d.getFullYear()).slice(-2);
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          const count = await sequelize.models.RegistrationRequest
            .count({ where: sequelize.literal(`DATE(created_at) = CURDATE()`) })
            .catch(() => 0);
          // Sufiks acak 2 digit untuk hindari tabrakan saat submit bersamaan
          const rand = String(Math.floor(Math.random() * 90) + 10);
          reg.reg_number = `REG-${yy}${mm}${dd}-${String(count + 1).padStart(4, '0')}${rand}`;
        }
      }
    }
  });

  return RegistrationRequest;
};
