const { Notification } = require('../models');
const { Op } = require('sequelize');

class NotificationController {
  async index(req, res) {
    try {
      const { page = 1, limit = 20, unread } = req.query;
      const where = { user_id: req.user.id };
      if (unread === 'true') where.is_read = false;

      const offset = (page - 1) * limit;
      const { count, rows } = await Notification.findAndCountAll({
        where,
        offset,
        limit: parseInt(limit),
        order: [['created_at', 'DESC']]
      });

      // Normalisasi field waktu → selalu sediakan created_at (string ISO),
      // apa pun konfigurasi timestamp model, supaya frontend tidak dapat
      // "Invalid Date".
      const data = rows.map(r => {
        const o = (typeof r.toJSON === 'function') ? r.toJSON() : r;
        const ts = o.created_at || o.createdAt || r.get?.('created_at') || r.get?.('createdAt') || null;
        o.created_at = ts ? new Date(ts).toISOString() : null;
        return o;
      });

      res.json({
        success: true,
        data,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async unreadCount(req, res) {
    try {
      const count = await Notification.count({
        where: { user_id: req.user.id, is_read: false }
      });
      res.json({ success: true, data: { count } });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async markRead(req, res) {
    try {
      await Notification.update(
        { is_read: true },
        { where: { id: req.params.id, user_id: req.user.id } }
      );
      res.json({ success: true, message: 'Marked as read' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async markAllRead(req, res) {
    try {
      await Notification.update(
        { is_read: true },
        { where: { user_id: req.user.id, is_read: false } }
      );
      res.json({ success: true, message: 'All marked as read' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new NotificationController();
