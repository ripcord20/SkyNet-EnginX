'use strict';
const { Todo, User } = require('../models');
const { Op } = require('sequelize');

const INCLUDE_ASSIGNEE = {
  model: User,
  as: 'assignee',
  attributes: ['id', 'name', 'email']
};
const INCLUDE_CREATOR = {
  model: User,
  as: 'creator',
  attributes: ['id', 'name', 'email']
};

class TodoController {

  async index(req, res) {
    try {
      const where = {};
      if (req.query.status)   where.status   = req.query.status;
      if (req.query.priority) where.priority  = req.query.priority;
      if (req.query.assigned_to) where.assigned_to = req.query.assigned_to;

      const todos = await Todo.findAll({
        where,
        include: [INCLUDE_ASSIGNEE, INCLUDE_CREATOR],
        order: [['position','ASC'],['created_at','DESC']]
      });
      res.json({ success: true, data: todos });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async stats(req, res) {
    try {
      const [total, todo, inProgress, done] = await Promise.all([
        Todo.count(),
        Todo.count({ where: { status: 'todo' } }),
        Todo.count({ where: { status: 'in_progress' } }),
        Todo.count({ where: { status: 'done' } })
      ]);
      // Overdue
      const today = new Date().toISOString().slice(0,10);
      const overdue = await Todo.count({
        where: { status: { [Op.in]: ['todo','in_progress'] }, due_date: { [Op.lt]: today } }
      });
      res.json({ success: true, data: { total, todo, inProgress, done, overdue } });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async create(req, res) {
    try {
      const { title, description, status, priority, due_date, assigned_to, tags, color } = req.body;
      if (!title) return res.status(400).json({ success: false, message: 'Judul task wajib diisi' });

      // Set position = max + 1 dalam kolom yang sama
      const maxPos = await Todo.max('position', { where: { status: status || 'todo' } }) || 0;

      const todo = await Todo.create({
        title, description, status: status || 'todo',
        priority: priority || 'medium',
        due_date: due_date || null,
        assigned_to: assigned_to || null,
        created_by: req.user?.id || null,
        position: (maxPos || 0) + 1,
        tags: tags || [],
        color: color || 'blue'
      });

      const result = await Todo.findByPk(todo.id, { include: [INCLUDE_ASSIGNEE, INCLUDE_CREATOR] });
      res.status(201).json({ success: true, data: result, message: 'Task berhasil dibuat' });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async show(req, res) {
    try {
      const todo = await Todo.findByPk(req.params.id, { include: [INCLUDE_ASSIGNEE, INCLUDE_CREATOR] });
      if (!todo) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });
      res.json({ success: true, data: todo });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async update(req, res) {
    try {
      const todo = await Todo.findByPk(req.params.id);
      if (!todo) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });

      const allowed = ['title','description','status','priority','due_date','assigned_to','position','tags','color'];
      const fields  = {};
      allowed.forEach(k => { if (k in req.body) fields[k] = req.body[k]; });

      // Jika status berubah ke done, set resolved_at
      if (fields.status === 'done' && todo.status !== 'done') {
        fields.resolved_at = new Date();
      }

      await todo.update(fields);
      const result = await Todo.findByPk(todo.id, { include: [INCLUDE_ASSIGNEE, INCLUDE_CREATOR] });
      res.json({ success: true, data: result, message: 'Task berhasil diperbarui' });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async updateStatus(req, res) {
    try {
      const todo = await Todo.findByPk(req.params.id);
      if (!todo) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });
      const { status, position } = req.body;
      const fields = { status };
      if (position !== undefined) fields.position = position;
      if (status === 'done' && todo.status !== 'done') fields.resolved_at = new Date();
      await todo.update(fields);
      res.json({ success: true, message: 'Status diperbarui' });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async destroy(req, res) {
    try {
      const todo = await Todo.findByPk(req.params.id);
      if (!todo) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });
      await todo.destroy();
      res.json({ success: true, message: 'Task berhasil dihapus' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }
}

module.exports = new TodoController();