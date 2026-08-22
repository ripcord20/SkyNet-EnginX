const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('WaSession', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    session_id: { type: DataTypes.STRING(50), unique: true, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    phone_number: { type: DataTypes.STRING(20), allowNull: true },
    status: {
      type: DataTypes.ENUM('disconnected', 'connecting', 'connected', 'banned'),
      defaultValue: 'disconnected'
    },
    qr_code: { type: DataTypes.TEXT, allowNull: true },
    last_seen: { type: DataTypes.DATE, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    webhook_url: { type: DataTypes.STRING(255), allowNull: true },
    auto_reply_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    // ── Provider gateway: 'baileys' (default, scan QR), 'fonnte' (API token),
    //    atau 'waha' (self-hosted WAHA, HTTP API + QR via WAHA) ──
    provider: {
      type: DataTypes.ENUM('baileys', 'fonnte', 'waha'),
      defaultValue: 'baileys'
    },
    // Token API Fonnte (hanya dipakai kalau provider='fonnte'). Bisa multi-token
    // dipisah koma → Fonnte pakai sebagai rotator device.
    fonnte_token: { type: DataTypes.STRING(255), allowNull: true },
    // ── Config WAHA (hanya dipakai kalau provider='waha') ──
    // Base URL instance WAHA, mis. http://127.0.0.1:3001
    waha_url: { type: DataTypes.STRING(255), allowNull: true },
    // API key (env WHATSAPP_API_KEY di container WAHA)
    waha_api_key: { type: DataTypes.STRING(255), allowNull: true },
    // Nama session di sisi WAHA (1 instance WAHA bisa multi session)
    waha_session: { type: DataTypes.STRING(100), allowNull: true }
  }, {
    tableName: 'wa_sessions',
    timestamps: true,
    indexes: [{ fields: ['session_id'] }, { fields: ['status'] }]
  });
};
