const { ActivityLog, User } = require('../models');
const { Op } = require('sequelize');
const { paginateResponse } = require('../utils/helpers');

class ActivityLogController {
  async index(req, res) {
    try {
      const { page = 1, limit = 50, user_id, module, action, from, to } = req.query;
      const where = {};
      if (user_id) where.user_id = user_id;
      if (module) where.module = module;
      if (action) where.action = action;
      if (from || to) {
        where.created_at = {};
        if (from) where.created_at[Op.gte] = new Date(from);
        if (to) where.created_at[Op.lte] = new Date(to);
      }

      const offset = (page - 1) * limit;
      const { count, rows } = await ActivityLog.findAndCountAll({
        where,
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
        offset,
        limit: parseInt(limit),
        // Exclude old_data/new_data from list — large JSON, only loaded di detail endpoint
        attributes: { exclude: ['old_data', 'new_data', 'user_agent'] },
        order: [['created_at', 'DESC']]
      });

      res.json({ success: true, ...paginateResponse(rows, count, page, limit) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/activity-logs/:id
   * Detail satu log entry — termasuk old_data, new_data, user_agent.
   */
  async detail(req, res) {
    try {
      const log = await ActivityLog.findByPk(req.params.id, {
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      });
      if (!log) {
        return res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
      }
      res.json({ success: true, data: log });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new ActivityLogController();
