const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('WaMessage', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    session_id: { type: DataTypes.STRING(50), allowNull: false },
    direction: { type: DataTypes.ENUM('inbound', 'outbound'), allowNull: false },
    from_number: { type: DataTypes.STRING(30), allowNull: false },
    push_name:   { type: DataTypes.STRING(100), allowNull: true },
    to_number: { type: DataTypes.STRING(30), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    message_type: {
      type: DataTypes.ENUM('text', 'image', 'document', 'audio', 'template'),
      defaultValue: 'text'
    },
    // ── Reply/quote: pesan ini membalas pesan lain ──
    reply_to_id:   { type: DataTypes.STRING(255), allowNull: true }, // wa_message_id yang dibalas
    reply_to_text: { type: DataTypes.STRING(500), allowNull: true }, // snapshot isi (utk render quote)
    status: {
      type: DataTypes.ENUM('pending', 'sent', 'delivered', 'read', 'failed'),
      defaultValue: 'pending'
    },
    wa_message_id: { type: DataTypes.STRING(100), allowNull: true },
    media_url: { type: DataTypes.STRING(500), allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    customer_id: { type: DataTypes.INTEGER, allowNull: true },
    is_auto_reply: { type: DataTypes.BOOLEAN, defaultValue: false },
    sent_at: { type: DataTypes.DATE, allowNull: true }
  }, {
    tableName: 'wa_messages',
    timestamps: true,
    indexes: [
      { fields: ['session_id'] },
      { fields: ['direction'] },
      { fields: ['from_number'] },
      { fields: ['status'] },
      { fields: ['customer_id'] }
    ]
  });
};