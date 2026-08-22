'use strict';
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Op } = require('sequelize');
const {
  sequelize, Employee, HrisShift, HrisWorkLocation, HrisSchedule,
  HrisAttendance, User
} = require('../models');
const logger = require('../utils/logger');

// ── Upload storage (foto profil karyawan) ─────────────────────
const uploadDir = path.join(__dirname, '../../uploads/media/hris');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `emp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  }
});
exports.uploadPhoto = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp)$/i.test(path.extname(file.originalname));
    cb(ok ? null : new Error('Hanya file gambar yang diizinkan'), ok);
  }
}).single('photo');

const EMP_INCLUDE = [
  { model: HrisShift, as: 'shift', attributes: ['id', 'name', 'start_time', 'end_time'], required: false },
  { model: HrisWorkLocation, as: 'work_location', attributes: ['id', 'name'], required: false },
  { model: User, as: 'user', attributes: ['id', 'name', 'email'], required: false }
];

// Auto-generate nomor karyawan berikutnya (EMP-0001, ...)
async function nextEmployeeNo() {
  const last = await Employee.findOne({ order: [['id', 'DESC']] });
  const n = (last ? last.id : 0) + 1;
  return 'EMP-' + String(n).padStart(4, '0');
}

// ═══════════════════════════════════════════════════════════════
// EMPLOYEES
// ═══════════════════════════════════════════════════════════════

exports.listEmployees = async (req, res) => {
  try {
    const { search, status, department, page = 1, limit = 25 } = req.query;
    const where = {};
    if (status) where.status = status;
    if (department) where.department = department;
    if (search) {
      where[Op.or] = [
        { full_name: { [Op.like]: `%${search}%` } },
        { employee_no: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } }
      ];
    }
    const offset = (Number(page) - 1) * Number(limit);
    const { rows, count } = await Employee.findAndCountAll({
      where, include: EMP_INCLUDE,
      order: [['full_name', 'ASC']],
      limit: Number(limit), offset
    });
    res.json({ success: true, data: rows, total: count, page: Number(page), limit: Number(limit) });
  } catch (e) {
    logger.error('[HRIS] listEmployees: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getEmployee = async (req, res) => {
  try {
    const emp = await Employee.findByPk(req.params.id, { include: EMP_INCLUDE });
    if (!emp) return res.status(404).json({ success: false, message: 'Karyawan tidak ditemukan' });
    res.json({ success: true, data: emp });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.createEmployee = async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.employee_no) body.employee_no = await nextEmployeeNo();
    if (req.file) body.photo = 'uploads/media/hris/' + req.file.filename;
    // Normalisasi tipe kosong
    ['user_id', 'work_location_id', 'shift_id'].forEach(k => {
      if (body[k] === '' || body[k] === undefined) body[k] = null;
    });
    if (!body.full_name) return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
    const emp = await Employee.create(body);
    res.status(201).json({ success: true, data: emp, message: 'Karyawan ditambahkan' });
  } catch (e) {
    logger.error('[HRIS] createEmployee: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.updateEmployee = async (req, res) => {
  try {
    const emp = await Employee.findByPk(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Karyawan tidak ditemukan' });
    const body = { ...req.body };
    if (req.file) body.photo = 'uploads/media/hris/' + req.file.filename;
    ['user_id', 'work_location_id', 'shift_id'].forEach(k => {
      if (body[k] === '') body[k] = null;
    });
    await emp.update(body);
    res.json({ success: true, data: emp, message: 'Karyawan diperbarui' });
  } catch (e) {
    logger.error('[HRIS] updateEmployee: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.deleteEmployee = async (req, res) => {
  try {
    const emp = await Employee.findByPk(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Karyawan tidak ditemukan' });
    await emp.destroy();
    res.json({ success: true, message: 'Karyawan dihapus' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ═══════════════════════════════════════════════════════════════
// SHIFTS
// ═══════════════════════════════════════════════════════════════

exports.listShifts = async (req, res) => {
  try {
    const rows = await HrisShift.findAll({ order: [['start_time', 'ASC']] });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.saveShift = async (req, res) => {
  try {
    const body = { ...req.body };
    let row;
    if (req.params.id) {
      row = await HrisShift.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'Shift tidak ditemukan' });
      await row.update(body);
    } else {
      row = await HrisShift.create(body);
    }
    res.json({ success: true, data: row, message: 'Shift disimpan' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteShift = async (req, res) => {
  try {
    const row = await HrisShift.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Shift tidak ditemukan' });
    await row.destroy();
    res.json({ success: true, message: 'Shift dihapus' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// WORK LOCATIONS
// ═══════════════════════════════════════════════════════════════

exports.listLocations = async (req, res) => {
  try {
    const rows = await HrisWorkLocation.findAll({ order: [['name', 'ASC']] });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.saveLocation = async (req, res) => {
  try {
    const body = { ...req.body };
    let row;
    if (req.params.id) {
      row = await HrisWorkLocation.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'Lokasi tidak ditemukan' });
      await row.update(body);
    } else {
      row = await HrisWorkLocation.create(body);
    }
    res.json({ success: true, data: row, message: 'Lokasi disimpan' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteLocation = async (req, res) => {
  try {
    const row = await HrisWorkLocation.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Lokasi tidak ditemukan' });
    await row.destroy();
    res.json({ success: true, message: 'Lokasi dihapus' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// SCHEDULES
// ═══════════════════════════════════════════════════════════════

exports.listSchedules = async (req, res) => {
  try {
    const { employee_id, from, to } = req.query;
    const where = {};
    if (employee_id) where.employee_id = employee_id;
    if (from && to) where.work_date = { [Op.between]: [from, to] };
    const rows = await HrisSchedule.findAll({
      where,
      include: [
        { model: HrisShift, as: 'shift', attributes: ['id', 'name', 'color'], required: false },
        { model: Employee, as: 'employee', attributes: ['id', 'full_name'], required: false }
      ],
      order: [['work_date', 'ASC']]
    });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// Bulk assign: satu karyawan, rentang tanggal, shift+lokasi tertentu.
exports.bulkAssignSchedule = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { employee_id, dates = [], shift_id, work_location_id, day_type = 'kerja' } = req.body;
    if (!employee_id || !dates.length) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'employee_id & dates wajib' });
    }
    for (const d of dates) {
      await HrisSchedule.upsert({
        employee_id, work_date: d,
        shift_id: shift_id || null,
        work_location_id: work_location_id || null,
        day_type
      }, { transaction: t });
    }
    await t.commit();
    res.json({ success: true, message: `${dates.length} jadwal disimpan` });
  } catch (e) {
    await t.rollback();
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.deleteSchedule = async (req, res) => {
  try {
    const row = await HrisSchedule.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Jadwal tidak ditemukan' });
    await row.destroy();
    res.json({ success: true, message: 'Jadwal dihapus' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
