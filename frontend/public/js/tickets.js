'use strict';
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { Op }  = require('sequelize');
const { Ticket, TicketTimeline, Customer, User, InfrastructurePoint } = require('../models');

// ── Upload setup ──────────────────────────────────────────────
const uploadDir = path.join(__dirname, '../../frontend/public/uploads/tickets');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `ticket-${Date.now()}-${Math.random().toString(36).slice(2,7)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|pdf|doc|docx/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});
exports.uploadMiddleware = upload.array('attachments', 5);

// ── Helpers ───────────────────────────────────────────────────
const TYPE_LABELS  = { gangguan:'Gangguan', request:'Request', installation:'Instalasi', maintenance:'Maintenance' };
const STATUS_LABELS= { open:'Open', in_progress:'In Progress', pending:'Pending', resolved:'Resolved', closed:'Closed' };
const PRIO_SLA     = { low:72, medium:24, high:8, critical:2 };

function includeBase() {
  return [
    { model: Customer, as: 'customer', attributes: ['id','name','phone','address','latitude','longitude'] },
    { model: User,     as: 'assignee', attributes: ['id','name','email'] },
    { model: User,     as: 'creator',  attributes: ['id','name'] },
    { model: InfrastructurePoint, as: 'infraPoint', attributes: ['id','name','type','latitude','longitude','address'] }
  ];
}

// ─────────────────────────────────────────────────────────────
// GET /api/tickets  — list with filter/pagination
// FIXED: Explicitly select created_at
// ─────────────────────────────────────────────────────────────
exports.index = async (req, res) => {
  try {
    const { status, type, priority, assigned_to, search, page = 1, limit = 20 } = req.query;
    const where = {};
    if (status)      where.status      = status;
    if (type)        where.type        = type;
    if (priority)    where.priority    = priority;
    if (assigned_to) where.assigned_to = assigned_to;
    if (search)      where.title       = { [Op.like]: `%${search}%` };

    const { count, rows } = await Ticket.findAndCountAll({
      where, 
      include: includeBase(),
      attributes: [
        'id', 'ticket_number', 'title', 'description', 'type', 'priority', 'status',
        'customer_id', 'assigned_to', 'created_by', 'infra_point_id',
        'latitude', 'longitude', 'location_note', 'sla_hours', 'due_at',
        'resolved_at', 'closed_at', 'tags',
        'created_at', 'updated_at'  // ← PENTING: Explicitly include created_at
      ],
      order:  [['created_at', 'DESC']],
      limit:  parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    res.json({ success: true, data: rows, total: count, page: parseInt(page), pages: Math.ceil(count / limit) });
  } catch(e) { 
    console.error('Error in tickets index:', e);
    res.status(500).json({ success: false, message: e.message }); 
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/tickets/stats
// ─────────────────────────────────────────────────────────────
exports.stats = async (req, res) => {
  try {
    const [total, open, in_progress, pending, resolved, closed, overdue] = await Promise.all([
      Ticket.count(),
      Ticket.count({ where: { status: 'open' } }),
      Ticket.count({ where: { status: 'in_progress' } }),
      Ticket.count({ where: { status: 'pending' } }),
      Ticket.count({ where: { status: 'resolved' } }),
      Ticket.count({ where: { status: 'closed' } }),
      Ticket.count({ where: { status: ['open','in_progress','pending'], due_at: { [Op.lt]: new Date() } } })
    ]);
    res.json({ success: true, data: { total, open, in_progress, pending, resolved, closed, overdue } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ─────────────────────────────────────────────────────────────
// GET /api/tickets/:id
// ─────────────────────────────────────────────────────────────
exports.show = async (req, res) => {
  try {
    const ticket = await Ticket.findByPk(req.params.id, {
      include: [
        ...includeBase(),
        {
          model: TicketTimeline, as: 'timelines',
          include: [{ model: User, as: 'user', attributes: ['id','name','email'] }],
          order: [['created_at', 'ASC']]
        }
      ]
    });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket tidak ditemukan' });
    res.json({ success: true, data: ticket });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ─────────────────────────────────────────────────────────────
// POST /api/tickets
// ─────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { title, type, priority, description, customer_id, infra_point_id,
            latitude, longitude, location_note, assigned_to, tags } = req.body;

    if (!title) return res.status(400).json({ success: false, message: 'Judul wajib diisi' });

    const ticket = await Ticket.create({
      title, type: type || 'gangguan',
      priority: priority || 'medium',
      description, customer_id: customer_id || null,
      infra_point_id: infra_point_id || null,
      latitude: latitude || null,
      longitude: longitude || null,
      location_note,
      assigned_to: assigned_to || null,
      created_by: req.user?.id || null,
      sla_hours: PRIO_SLA[priority || 'medium'],
      tags: tags ? JSON.parse(tags) : null
    });

    // System timeline: ticket created
    await TicketTimeline.create({
      ticket_id: ticket.id,
      user_id:   req.user?.id || null,
      type:      'system',
      content:   `Ticket ${ticket.ticket_number} dibuat`
    });

    // If assigned, log it
    if (assigned_to) {
      const assignee = await User.findByPk(assigned_to, { attributes: ['name'] });
      await TicketTimeline.create({
        ticket_id: ticket.id, user_id: req.user?.id,
        type: 'assignment', new_value: assignee?.name || assigned_to,
        content: `Ditugaskan kepada ${assignee?.name || 'teknisi'}`
      });
    }

    res.status(201).json({ success: true, data: ticket, message: 'Ticket berhasil dibuat' });
  } catch(e) { res.status(400).json({ success: false, message: e.message }); }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/tickets/:id
// ─────────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const ticket = await Ticket.findByPk(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket tidak ditemukan' });

    const oldStatus   = ticket.status;
    const oldAssigned = ticket.assigned_to;

    await ticket.update(req.body);

    // Log status change
    if (req.body.status && req.body.status !== oldStatus) {
      if (req.body.status === 'resolved') ticket.resolved_at = new Date();
      if (req.body.status === 'closed')   ticket.closed_at   = new Date();
      await ticket.save();
      await TicketTimeline.create({
        ticket_id: ticket.id, user_id: req.user?.id,
        type: 'status_change',
        old_value: oldStatus, new_value: req.body.status,
        content: `Status berubah dari ${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[req.body.status]}`
      });
    }

    // Log assignment change
    if (req.body.assigned_to && req.body.assigned_to != oldAssigned) {
      const assignee = await User.findByPk(req.body.assigned_to, { attributes: ['name'] });
      await TicketTimeline.create({
        ticket_id: ticket.id, user_id: req.user?.id,
        type: 'assignment', new_value: assignee?.name,
        content: `Ditugaskan ulang kepada ${assignee?.name || req.body.assigned_to}`
      });
    }

    res.json({ success: true, data: ticket, message: 'Ticket berhasil diperbarui' });
  } catch(e) { res.status(400).json({ success: false, message: e.message }); }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/tickets/:id
// ─────────────────────────────────────────────────────────────
exports.destroy = async (req, res) => {
  try {
    const ticket = await Ticket.findByPk(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket tidak ditemukan' });
    await TicketTimeline.destroy({ where: { ticket_id: ticket.id } });
    await ticket.destroy();
    res.json({ success: true, message: 'Ticket berhasil dihapus' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ─────────────────────────────────────────────────────────────
// POST /api/tickets/:id/timeline  — add comment/photo update
// ─────────────────────────────────────────────────────────────
exports.addTimeline = async (req, res) => {
  try {
    const ticket = await Ticket.findByPk(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket tidak ditemukan' });

    const { content, type = 'comment' } = req.body;
    const attachments = (req.files || []).map(f => ({
      url:      '/uploads/tickets/' + f.filename,
      filename: f.originalname,
      size:     f.size,
      mimetype: f.mimetype
    }));

    const entry = await TicketTimeline.create({
      ticket_id:   ticket.id,
      user_id:     req.user?.id || null,
      type:        attachments.length > 0 ? 'photo' : type,
      content,
      attachments: attachments.length > 0 ? attachments : null
    });

    // Reload with user
    const full = await TicketTimeline.findByPk(entry.id, {
      include: [{ model: User, as: 'user', attributes: ['id','name','email'] }]
    });

    // Auto-set to in_progress if still open
    if (ticket.status === 'open' && type === 'comment') {
      await ticket.update({ status: 'in_progress' });
    }

    res.status(201).json({ success: true, data: full });
  } catch(e) { res.status(400).json({ success: false, message: e.message }); }
};

// ─────────────────────────────────────────────────────────────
// GET /api/tickets/customers/search?q=
// ─────────────────────────────────────────────────────────────
exports.searchCustomers = async (req, res) => {
  try {
    const q = req.query.q || '';
    const customers = await Customer.findAll({
      where: { name: { [Op.like]: `%${q}%` } },
      attributes: ['id','name','phone','address','latitude','longitude'],
      limit: 15
    });
    res.json({ success: true, data: customers });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ─────────────────────────────────────────────────────────────
// GET /api/tickets/infra/points — for location picker
// ─────────────────────────────────────────────────────────────
exports.infraPoints = async (req, res) => {
  try {
    const points = await InfrastructurePoint.findAll({
      attributes: ['id','name','type','latitude','longitude','address'],
      where: { status: 'active' }
    });
    res.json({ success: true, data: points });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};