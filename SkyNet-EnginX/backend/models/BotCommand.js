const { DataTypes } = require('sequelize');

/**
 * BotCommand — definisi perintah bot Telegram yang bisa diedit via UI.
 * ─────────────────────────────────────────────────────────────────────
 * Menggantikan switch hardcoded di TelegramBotService dengan registry DB,
 * sehingga admin bisa menambah/mengubah keyword, balasan, aktif/nonaktif,
 * dan deskripsi lewat halaman Telegram Center → tab "Perintah Bot".
 *
 * type:
 *   'builtin' — fungsi tetap di kode (status/down/cek/isolir/restore).
 *               Yang bisa diedit: keyword, aliases, enabled, description,
 *               require_control, dan reply_template untuk command yang
 *               mendukung template (mis. header/format pesan cek).
 *   'reply'   — balasan STATIS: kirim reply_template apa adanya (boleh
 *               placeholder umum seperti {perusahaan}, {waktu}).
 *   'data'    — balasan + AKSI DATA: ambil data via data_source lalu render
 *               reply_template dengan field hasil (mis. cek tagihan pelanggan).
 *
 * handler  : untuk builtin → nama fungsi internal ('status','down','cek',
 *            'isolir','restore'). Tidak dipakai untuk reply/data.
 * data_source : untuk type='data' → kunci sumber data terdaftar di
 *            BotDataSources (mis. 'customer_billing', 'customer_status').
 * aliases  : daftar keyword alternatif, dipisah koma (mis. "cari,find").
 */
module.exports = (sequelize) => {
  const BotCommand = sequelize.define('BotCommand', {
    id:        { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    keyword:   { type: DataTypes.STRING(40), allowNull: false, comment: 'tanpa slash, mis. "status"' },
    aliases:   { type: DataTypes.STRING(160), allowNull: true, comment: 'alias dipisah koma' },
    type:      { type: DataTypes.ENUM('builtin', 'reply', 'data'), allowNull: false, defaultValue: 'reply' },
    handler:   { type: DataTypes.STRING(40), allowNull: true, comment: 'untuk builtin: nama fungsi' },
    data_source: { type: DataTypes.STRING(40), allowNull: true, comment: 'untuk type=data' },
    description: { type: DataTypes.STRING(255), allowNull: true },
    reply_template: { type: DataTypes.TEXT, allowNull: true },
    require_control: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: 'butuh izin kontrol' },
    enabled:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: 'bawaan, tak bisa dihapus' },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
  }, {
    tableName: 'bot_commands',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['keyword'] },
      { fields: ['enabled'] },
      { fields: ['type'] },
    ],
  });

  return BotCommand;
};
