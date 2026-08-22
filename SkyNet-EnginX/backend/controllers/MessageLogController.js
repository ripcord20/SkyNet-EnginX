/**
 * MessageLogController.js
 * Global WA message logs dari tabel wa_messages (Baileys/NETOPS)
 */
const { WaMessage, Customer, WaSession, WaBroadcast, sequelize } = require('../models');
const { Op } = require('sequelize');
const moment = require('moment');

class MessageLogController {

  // ── Stats ─────────────────────────────────────────────────────
  async stats(req, res) {
    try {
      const today = moment().format('YYYY-MM-DD');

      const [[out]] = await sequelize.query(
        "SELECT COUNT(*) AS total, SUM(status='sent' OR status='delivered' OR status='read') AS sent, SUM(status='failed') AS failed FROM wa_messages WHERE direction='outbound'"
      );
      const [[outToday]] = await sequelize.query(
        "SELECT COUNT(*) AS total FROM wa_messages WHERE direction='outbound' AND DATE(created_at)=?",
        { replacements: [today] }
      );
      const [[inc]] = await sequelize.query(
        "SELECT COUNT(*) AS total, SUM(status='pending') AS unread FROM wa_messages WHERE direction='inbound'"
      );
      const [[incToday]] = await sequelize.query(
        "SELECT COUNT(*) AS total FROM wa_messages WHERE direction='inbound' AND DATE(created_at)=?",
        { replacements: [today] }
      );

      res.json({ success: true, data: {
        outgoing: {
          total:  parseInt(out?.total  || 0),
          sent:   parseInt(out?.sent   || 0),
          failed: parseInt(out?.failed || 0),
          today:  parseInt(outToday?.total || 0)
        },
        incoming: {
          total:  parseInt(inc?.total  || 0),
          unread: parseInt(inc?.unread || 0),
          today:  parseInt(incToday?.total || 0)
        }
      }});
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Outgoing list ─────────────────────────────────────────────
  async outgoing(req, res) {
    try {
      const { page=1, limit=50, status, type, phone, date_from, date_to, search } = req.query;
      const offset = (parseInt(page)-1) * parseInt(limit);
      const conds = ["direction='outbound'"];
      const params = [];

      if (status === 'sent')   conds.push("status IN ('sent','delivered','read')");
      else if (status === 'failed') conds.push("status='failed'");
      else if (status)         { conds.push("status=?"); params.push(status); }

      if (phone)     { conds.push("(to_number LIKE ? OR from_number LIKE ?)"); params.push('%'+phone+'%','%'+phone+'%'); }
      if (date_from) { conds.push("DATE(created_at)>=?"); params.push(date_from); }
      if (date_to)   { conds.push("DATE(created_at)<=?"); params.push(date_to); }
      if (search)    { conds.push("(to_number LIKE ? OR message LIKE ?)"); params.push('%'+search+'%','%'+search+'%'); }

      const where = 'WHERE ' + conds.join(' AND ');

      const [[{ total }]] = await sequelize.query(
        `SELECT COUNT(*) AS total FROM wa_messages ${where}`, { replacements: params }
      );
      const rows = await sequelize.query(
        `SELECT m.id, m.session_id, m.to_number AS phone,
                LEFT(m.message,250) AS message, m.message_type AS type,
                m.status, m.wa_message_id, m.created_at AS sent_at,
                c.name AS customer_name, c.customer_id AS cid
         FROM wa_messages m
         LEFT JOIN customers c ON c.id = m.customer_id
         ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
        { replacements: [...params, parseInt(limit), offset], type: sequelize.QueryTypes.SELECT }
      );

      res.json({ success: true, data: rows, total: parseInt(total), page: parseInt(page), limit: parseInt(limit) });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Full message detail ────────────────────────────────────────
  async getOutgoingDetail(req, res) {
    try {
      const rows = await sequelize.query(
        `SELECT m.*, c.name AS customer_name, c.customer_id AS cid
         FROM wa_messages m LEFT JOIN customers c ON c.id=m.customer_id
         WHERE m.id=?`,
        { replacements: [req.params.id], type: sequelize.QueryTypes.SELECT }
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
      res.json({ success: true, data: rows[0] });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Incoming list ──────────────────────────────────────────────
  async incoming(req, res) {
    try {
      const { page=1, limit=50, phone, date_from, date_to, search } = req.query;
      const offset = (parseInt(page)-1) * parseInt(limit);
      const conds = ["direction='inbound'"];
      const params = [];

      if (phone)     { conds.push("from_number LIKE ?"); params.push('%'+phone+'%'); }
      if (date_from) { conds.push("DATE(created_at)>=?"); params.push(date_from); }
      if (date_to)   { conds.push("DATE(created_at)<=?"); params.push(date_to); }
      if (search)    { conds.push("(from_number LIKE ? OR message LIKE ?)"); params.push('%'+search+'%','%'+search+'%'); }

      const where = 'WHERE ' + conds.join(' AND ');

      const [[{ total }]] = await sequelize.query(
        `SELECT COUNT(*) AS total FROM wa_messages ${where}`, { replacements: params }
      );
      const rows = await sequelize.query(
        `SELECT m.id, m.from_number, m.push_name, LEFT(m.message,250) AS message,
                m.status, m.created_at AS received_at,
                m.wa_message_id,
                c.name AS customer_name, c.customer_id AS cid,
                c.phone AS customer_phone
         FROM wa_messages m
         LEFT JOIN customers c ON c.id = m.customer_id
         ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
        { replacements: [...params, parseInt(limit), offset], type: sequelize.QueryTypes.SELECT }
      );

      // Resolve nama & nomor asli dari pushName yang tersimpan di wa_message_id
      // Format: msgId|jid:xxx@lid|name:NamaPengirim
      const data = rows.map(r => {
        let displayPhone = r.from_number || '';
        let displayName  = r.customer_name || '';

        // Coba ekstrak dari wa_message_id jika ada format |name: atau |jid:
        const waMsgId = r.wa_message_id || '';
        const nameMatch = waMsgId.match(/\|name:([^|]+)/);
        const jidMatch  = waMsgId.match(/\|jid:([^|@]+)/);

        // Prioritas: push_name kolom > extract dari wa_message_id > customer_name
        if (r.push_name && !displayName)  displayName = r.push_name;
        else if (nameMatch && !displayName) displayName = nameMatch[1];
        // Jika LID, coba pakai nomor dari customers jika ketemu
        if (r.customer_phone && (displayPhone.length > 13 || !displayPhone.startsWith('62'))) {
          displayPhone = r.customer_phone;
        }

        return { ...r, display_phone: displayPhone, display_name: displayName || '–', cid: r.cid || '' };
      });

      res.json({ success: true, data, total: parseInt(total), page: parseInt(page), limit: parseInt(limit) });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Chart (7/14/30 hari) ───────────────────────────────────────
  async chart(req, res) {
    try {
      const days = parseInt(req.query.days) || 7;
      const rows = await sequelize.query(
        `SELECT DATE(created_at) AS date,
                SUM(direction='outbound') AS sent,
                SUM(direction='inbound') AS incoming,
                SUM(direction='outbound' AND status='failed') AS failed
         FROM wa_messages
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY DATE(created_at) ORDER BY date ASC`,
        { replacements: [days], type: sequelize.QueryTypes.SELECT }
      );
      // Fill missing days
      const result = [];
      for (let i = days-1; i >= 0; i--) {
        const d = moment().subtract(i,'days').format('YYYY-MM-DD');
        const found = rows.find(r => moment(r.date).format('YYYY-MM-DD') === d);
        result.push({
          date:     d,
          sent:     parseInt(found?.sent     || 0),
          incoming: parseInt(found?.incoming || 0),
          failed:   parseInt(found?.failed   || 0)
        });
      }
      res.json({ success: true, data: result });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Status breakdown ───────────────────────────────────────────
  async typeBreakdown(req, res) {
    try {
      const rows = await sequelize.query(
        `SELECT status,
                SUM(direction='outbound') AS outbound,
                SUM(direction='inbound')  AS inbound,
                COUNT(*) AS total
         FROM wa_messages GROUP BY status ORDER BY total DESC`,
        { type: sequelize.QueryTypes.SELECT }
      );
      res.json({ success: true, data: rows });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }
}

module.exports = new MessageLogController();