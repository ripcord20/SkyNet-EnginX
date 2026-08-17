/**
 * AnnouncementController.js
 * CRUD pengumuman untuk admin dashboard
 */
const { Announcement } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

// GET /api/announcements — semua (admin)
exports.list = async (req, res) => {
  try {
    const rows = await Announcement.findAll({
      order: [['created_at', 'DESC']],
      limit: 50
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    logger.error('Announcement list error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/announcements — buat baru
exports.create = async (req, res) => {
  try {
    const { title, content, type, is_active, show_from, show_until } = req.body;
    if (!title || !title.trim())
      return res.status(400).json({ success: false, message: 'Judul wajib diisi' });

    const row = await Announcement.create({
      title:      title.trim(),
      content:    content || null,
      type:       ['gangguan','maintenance','info','promo'].includes(type) ? type : 'info',
      is_active:  is_active === true || is_active === 1 || is_active === '1',
      show_from:  show_from || null,
      show_until: show_until || null,
      created_by: req.user?.id || null
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    logger.error('Announcement create error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// PUT /api/announcements/:id — update
exports.update = async (req, res) => {
  try {
    const row = await Announcement.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });

    const { title, content, type, is_active, show_from, show_until } = req.body;
    await row.update({
      title:      title?.trim() || row.title,
      content:    content !== undefined ? (content || null) : row.content,
      type:       ['gangguan','maintenance','info','promo'].includes(type) ? type : row.type,
      is_active:  is_active !== undefined ? (is_active === true || is_active === 1 || is_active === '1') : row.is_active,
      show_from:  show_from !== undefined ? (show_from || null) : row.show_from,
      show_until: show_until !== undefined ? (show_until || null) : row.show_until,
    });
    res.json({ success: true, data: row });
  } catch (e) {
    logger.error('Announcement update error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// DELETE /api/announcements/:id
exports.destroy = async (req, res) => {
  try {
    const row = await Announcement.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    await row.destroy();
    res.json({ success: true });
  } catch (e) {
    logger.error('Announcement delete error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// PATCH /api/announcements/:id/toggle — toggle aktif/nonaktif
exports.toggle = async (req, res) => {
  try {
    const row = await Announcement.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    await row.update({ is_active: !row.is_active });
    res.json({ success: true, is_active: row.is_active });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
