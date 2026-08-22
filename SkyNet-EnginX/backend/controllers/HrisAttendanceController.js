'use strict';
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const moment = require('moment');
const { Op } = require('sequelize');
const {
  Employee, HrisShift, HrisWorkLocation, HrisSchedule, HrisAttendance
} = require('../models');
const GeoService = require('../services/HrisGeoService');
const AttService = require('../services/HrisAttendanceService');
const logger = require('../utils/logger');

// ── Upload selfie absensi ─────────────────────────────────────
const selfieDir = path.join(__dirname, '../../uploads/media/hris/selfie');
if (!fs.existsSync(selfieDir)) fs.mkdirSync(selfieDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, selfieDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `sf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  }
});
exports.uploadSelfie = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp)$/i.test(path.extname(file.originalname)) || /image\//.test(file.mimetype);
    cb(ok ? null : new Error('Selfie harus berupa gambar'), ok);
  }
}).single('selfie');

// Cari karyawan dari req.user (via user_id) atau dari body employee_id (mode admin kiosk)
async function resolveEmployee(req) {
  if (req.body.employee_id) {
    const byId = await Employee.findByPk(req.body.employee_id);
    if (byId) return { emp: byId, source: 'admin' };
  }
  if (req.user && req.user.id) {
    const byUser = await Employee.findOne({ where: { user_id: req.user.id } });
    if (byUser) return { emp: byUser, source: 'mobile' };
  }
  return { emp: null, source: 'mobile' };
}

// Tentukan shift & lokasi efektif untuk tanggal tertentu:
// jadwal spesifik > default karyawan.
async function resolveShiftLocation(emp, workDate) {
  const sched = await HrisSchedule.findOne({ where: { employee_id: emp.id, work_date: workDate } });
  const shiftId = (sched && sched.shift_id) || emp.shift_id || null;
  const locId = (sched && sched.work_location_id) || emp.work_location_id || null;
  const shift = shiftId ? await HrisShift.findByPk(shiftId) : null;
  const location = locId ? await HrisWorkLocation.findByPk(locId) : null;
  return { shift, location, dayType: sched ? sched.day_type : 'kerja' };
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || req.ip || null;
}

// ═══════════════════════════════════════════════════════════════
// STATUS — apa yang harus ditampilkan tombolnya (masuk / pulang / selesai)
// ═══════════════════════════════════════════════════════════════
exports.myStatus = async (req, res) => {
  try {
    const { emp } = await resolveEmployee(req);
    if (!emp) return res.status(404).json({ success: false, message: 'Data karyawan tidak ditemukan untuk akun ini' });
    const today = moment().format('YYYY-MM-DD');
    const att = await HrisAttendance.findOne({ where: { employee_id: emp.id, work_date: today } });
    const { shift, location, dayType } = await resolveShiftLocation(emp, today);

    let state = 'need_check_in';
    if (att && att.check_in_at && !att.check_out_at) state = 'checked_in';
    else if (att && att.check_out_at) state = 'done';

    res.json({
      success: true,
      data: {
        employee: { id: emp.id, name: emp.full_name, no: emp.employee_no, photo: emp.photo },
        date: today,
        state,
        day_type: dayType,
        attendance: att,
        shift: shift ? { id: shift.id, name: shift.name, start_time: shift.start_time, end_time: shift.end_time } : null,
        location: location ? {
          id: location.id, name: location.name,
          latitude: location.latitude, longitude: location.longitude,
          radius_meters: location.radius_meters, allow_any_location: location.allow_any_location
        } : null
      }
    });
  } catch (e) {
    logger.error('[HRIS] myStatus: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// Core: proses satu event absen (masuk/pulang)
async function processPunch(req, res, kind /* 'in' | 'out' */) {
  try {
    const { emp, source } = await resolveEmployee(req);
    if (!emp) return res.status(404).json({ success: false, message: 'Data karyawan tidak ditemukan' });

    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    const accuracy = req.body.accuracy != null ? parseFloat(req.body.accuracy) : null;
    const isMock = req.body.is_mock === 'true' || req.body.is_mock === true;
    const deviceId = req.body.device_id || null;
    const note = req.body.note || null;

    const today = moment().format('YYYY-MM-DD');
    const { shift, location } = await resolveShiftLocation(emp, today);

    // ── Validasi anti-fake GPS ──
    const geo = GeoService.validateAttendance({
      location, lat, lng, accuracy, isMock,
      ip: clientIp(req), deviceId, userAgent: req.headers['user-agent']
    });

    if (geo.hard_fail) {
      // Hapus selfie yang terlanjur terupload
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      return res.status(422).json({
        success: false,
        message: 'Absensi ditolak: ' + geo.reasons.join('; '),
        data: { checks: geo.checks, reasons: geo.reasons }
      });
    }

    const selfiePath = req.file ? 'uploads/media/hris/selfie/' + req.file.filename : null;
    const nowTs = new Date();

    // Cari / buat record hari ini
    let att = await HrisAttendance.findOne({ where: { employee_id: emp.id, work_date: today } });
    const baseFields = {
      employee_id: emp.id, work_date: today,
      shift_id: shift ? shift.id : null,
      work_location_id: location ? location.id : null,
      ip_address: clientIp(req),
      user_agent: (req.headers['user-agent'] || '').slice(0, 250),
      device_id: deviceId,
      source: source === 'admin' ? 'admin' : 'mobile',
      is_valid: !geo.flagged
    };

    if (kind === 'in') {
      if (att && att.check_in_at) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
        return res.status(409).json({ success: false, message: 'Anda sudah check-in hari ini' });
      }
      const inFields = {
        ...baseFields,
        check_in_at: nowTs, check_in_lat: lat, check_in_lng: lng,
        check_in_accuracy: accuracy, check_in_distance: geo.distance,
        check_in_selfie: selfiePath, check_in_flags: geo.checks, check_in_note: note
      };
      // metrik keterlambatan
      const metrics = AttService.computeMetrics({ workDate: today, shift, checkIn: nowTs });
      inFields.late_minutes = metrics.late_minutes;
      inFields.status = metrics.status;
      if (att) await att.update(inFields);
      else att = await HrisAttendance.create(inFields);
    } else {
      if (!att || !att.check_in_at) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
        return res.status(409).json({ success: false, message: 'Belum check-in, tidak bisa check-out' });
      }
      if (att.check_out_at) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
        return res.status(409).json({ success: false, message: 'Anda sudah check-out hari ini' });
      }
      const outFields = {
        check_out_at: nowTs, check_out_lat: lat, check_out_lng: lng,
        check_out_accuracy: accuracy, check_out_distance: geo.distance,
        check_out_selfie: selfiePath, check_out_flags: geo.checks, check_out_note: note
      };
      const metrics = AttService.computeMetrics({
        workDate: today, shift,
        checkIn: att.check_in_at, checkOut: nowTs
      });
      outFields.late_minutes = metrics.late_minutes;
      outFields.early_leave_minutes = metrics.early_leave_minutes;
      outFields.work_minutes = metrics.work_minutes;
      outFields.overtime_minutes = metrics.overtime_minutes;
      // pertahankan status terlambat bila sudah begitu saat masuk
      outFields.status = att.status === 'terlambat' ? 'terlambat' : metrics.status;
      await att.update(outFields);
    }

    // Emit realtime ke dashboard admin
    try {
      if (global.__io) global.__io.emit('hris:attendance', {
        employee_id: emp.id, name: emp.full_name, kind, at: nowTs, status: att.status
      });
    } catch (_) {}

    res.json({
      success: true,
      message: kind === 'in' ? 'Check-in berhasil' : 'Check-out berhasil',
      data: { attendance: att, geo: { distance: geo.distance, flagged: geo.flagged, reasons: geo.reasons } }
    });
  } catch (e) {
    logger.error('[HRIS] processPunch(' + kind + '): ' + e.message);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    res.status(500).json({ success: false, message: e.message });
  }
}

exports.checkIn = (req, res) => processPunch(req, res, 'in');
exports.checkOut = (req, res) => processPunch(req, res, 'out');

// ═══════════════════════════════════════════════════════════════
// ADMIN — daftar & rekap absensi
// ═══════════════════════════════════════════════════════════════
exports.listAttendance = async (req, res) => {
  try {
    const { date, from, to, employee_id, status, flagged } = req.query;
    const where = {};
    if (date) where.work_date = date;
    else if (from && to) where.work_date = { [Op.between]: [from, to] };
    if (employee_id) where.employee_id = employee_id;
    if (status) where.status = status;
    if (flagged === 'true') where.is_valid = false;

    const rows = await HrisAttendance.findAll({
      where,
      include: [
        { model: Employee, as: 'employee', attributes: ['id', 'full_name', 'employee_no', 'department', 'photo'] },
        { model: HrisShift, as: 'shift', attributes: ['id', 'name'], required: false },
        { model: HrisWorkLocation, as: 'work_location', attributes: ['id', 'name'], required: false }
      ],
      order: [['work_date', 'DESC'], ['check_in_at', 'DESC']]
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    logger.error('[HRIS] listAttendance: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// Admin manual override / koreksi absensi
exports.updateAttendance = async (req, res) => {
  try {
    const att = await HrisAttendance.findByPk(req.params.id);
    if (!att) return res.status(404).json({ success: false, message: 'Data absensi tidak ditemukan' });
    const allowed = ['status', 'check_in_at', 'check_out_at', 'late_minutes', 'work_minutes', 'overtime_minutes', 'is_valid', 'check_in_note', 'check_out_note'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    await att.update(patch);
    res.json({ success: true, data: att, message: 'Absensi diperbarui' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
