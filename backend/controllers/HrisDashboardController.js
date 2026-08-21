'use strict';
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const { Op, fn, col, literal } = require('sequelize');
const {
  sequelize, Employee, HrisAttendance, HrisLeaveRequest,
  HrisPayroll, HrisPayrollItem
} = require('../models');
const PayrollService = require('../services/HrisPayrollService');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════════════
// DASHBOARD — statistik ringkas
// ═══════════════════════════════════════════════════════════════
exports.stats = async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');
    const monthStart = moment().startOf('month').format('YYYY-MM-DD');

    const [totalEmp, activeEmp] = await Promise.all([
      Employee.count(),
      Employee.count({ where: { status: 'active' } })
    ]);

    // Rekap absensi hari ini per status
    const todayRows = await HrisAttendance.findAll({
      where: { work_date: today },
      attributes: ['status', [fn('COUNT', col('id')), 'cnt']],
      group: ['status'], raw: true
    });
    const todayMap = {};
    todayRows.forEach(r => { todayMap[r.status] = Number(r.cnt); });

    const presentToday = (todayMap.hadir || 0) + (todayMap.terlambat || 0) + (todayMap.pulang_cepat || 0);
    const lateToday = todayMap.terlambat || 0;
    // Karyawan aktif yang belum ada record hadir hari ini → belum absen
    const notYet = Math.max(0, activeEmp - Object.values(todayMap).reduce((a, b) => a + b, 0));

    const pendingLeave = await HrisLeaveRequest.count({ where: { status: 'pending' } });
    const flaggedToday = await HrisAttendance.count({ where: { work_date: today, is_valid: false } });

    // Tren kehadiran 7 hari terakhir
    const from7 = moment().subtract(6, 'days').format('YYYY-MM-DD');
    const trendRows = await HrisAttendance.findAll({
      where: { work_date: { [Op.between]: [from7, today] } },
      attributes: [
        'work_date',
        [fn('SUM', literal("CASE WHEN status IN ('hadir','terlambat','pulang_cepat') THEN 1 ELSE 0 END")), 'present'],
        [fn('SUM', literal("CASE WHEN status = 'terlambat' THEN 1 ELSE 0 END")), 'late']
      ],
      group: ['work_date'], order: [['work_date', 'ASC']], raw: true
    });

    res.json({
      success: true,
      data: {
        employees: { total: totalEmp, active: activeEmp },
        today: {
          present: presentToday, late: lateToday,
          absent: todayMap.alfa || 0,
          leave: (todayMap.izin || 0) + (todayMap.cuti || 0) + (todayMap.sakit || 0),
          not_checked_in: notYet,
          flagged: flaggedToday
        },
        pending_leave: pendingLeave,
        trend: trendRows.map(r => ({ date: r.work_date, present: Number(r.present), late: Number(r.late) }))
      }
    });
  } catch (e) {
    logger.error('[HRIS] stats: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ═══════════════════════════════════════════════════════════════
// LEAVE REQUESTS
// ═══════════════════════════════════════════════════════════════
exports.listLeave = async (req, res) => {
  try {
    const { status, employee_id } = req.query;
    const where = {};
    if (status) where.status = status;
    if (employee_id) where.employee_id = employee_id;
    const rows = await HrisLeaveRequest.findAll({
      where,
      include: [{ model: Employee, as: 'employee', attributes: ['id', 'full_name', 'employee_no'] }],
      order: [['created_at', 'DESC']]
    });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createLeave = async (req, res) => {
  try {
    const body = { ...req.body };
    // Kalau dari karyawan (mobile), resolve employee_id dari akun
    if (!body.employee_id && req.user) {
      const emp = await Employee.findOne({ where: { user_id: req.user.id } });
      if (emp) body.employee_id = emp.id;
    }
    if (!body.employee_id) return res.status(400).json({ success: false, message: 'employee_id wajib' });
    if (body.start_date && body.end_date) {
      const d = Math.round((new Date(body.end_date) - new Date(body.start_date)) / 86400000) + 1;
      body.days = Math.max(1, d);
    }
    const row = await HrisLeaveRequest.create(body);
    res.status(201).json({ success: true, data: row, message: 'Pengajuan izin dibuat' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.reviewLeave = async (req, res) => {
  try {
    const row = await HrisLeaveRequest.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Pengajuan tidak ditemukan' });
    const { status, review_note } = req.body; // 'approved' | 'rejected'
    if (!['approved', 'rejected', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status tidak valid' });
    }
    await row.update({ status, review_note: review_note || null, reviewed_by: req.user?.id || null, reviewed_at: new Date() });

    // Bila approved, tandai jadwal/absensi di rentang sebagai izin/cuti/sakit
    if (status === 'approved') {
      const typeMap = { cuti: 'cuti', izin: 'izin', sakit: 'sakit', dinas: 'hadir' };
      const attStatus = typeMap[row.type] || 'izin';
      let d = moment(row.start_date);
      const end = moment(row.end_date);
      while (d.isSameOrBefore(end)) {
        const wd = d.format('YYYY-MM-DD');
        const [att] = await HrisAttendance.findOrCreate({
          where: { employee_id: row.employee_id, work_date: wd },
          defaults: { employee_id: row.employee_id, work_date: wd, status: attStatus, source: 'admin' }
        });
        if (att && att.status === 'alfa') await att.update({ status: attStatus });
        d.add(1, 'day');
      }
    }
    res.json({ success: true, data: row, message: 'Pengajuan diperbarui' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ═══════════════════════════════════════════════════════════════
// PAYROLL
// ═══════════════════════════════════════════════════════════════
exports.listPayrolls = async (req, res) => {
  try {
    const rows = await HrisPayroll.findAll({ order: [['period_start', 'DESC']] });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createPayroll = async (req, res) => {
  try {
    const { period_label, period_start, period_end, note } = req.body;
    if (!period_start || !period_end) return res.status(400).json({ success: false, message: 'Periode wajib diisi' });
    const label = period_label || moment(period_start).format('MMMM YYYY');
    const row = await HrisPayroll.create({
      period_label: label, period_start, period_end, note: note || null,
      created_by: req.user?.id || null
    });
    res.status(201).json({ success: true, data: row, message: 'Batch payroll dibuat' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getPayroll = async (req, res) => {
  try {
    const row = await HrisPayroll.findByPk(req.params.id, {
      include: [{
        model: HrisPayrollItem, as: 'items',
        include: [{ model: Employee, as: 'employee', attributes: ['id', 'full_name', 'employee_no', 'email', 'phone', 'department'] }]
      }]
    });
    if (!row) return res.status(404).json({ success: false, message: 'Payroll tidak ditemukan' });
    res.json({ success: true, data: row });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.calculatePayroll = async (req, res) => {
  try {
    const result = await PayrollService.calculatePayroll(req.params.id, {
      employeeIds: req.body.employee_ids
    });
    res.json({ success: true, message: 'Payroll dihitung dari absensi', data: { total: result.payroll.total_amount, count: result.items.length } });
  } catch (e) {
    logger.error('[HRIS] calculatePayroll: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// Update komponen manual (allowances/deductions) satu item
exports.updatePayrollItem = async (req, res) => {
  try {
    const item = await HrisPayrollItem.findByPk(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, message: 'Item tidak ditemukan' });
    const { allowances, deductions } = req.body;
    const patch = {};
    if (Array.isArray(allowances)) patch.allowances = allowances;
    if (Array.isArray(deductions)) patch.deductions = deductions;

    // recompute total
    const allow = (patch.allowances || item.allowances || []);
    const ded = (patch.deductions || item.deductions || []);
    const totalAllow = allow.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const totalDed = ded.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    patch.total_allowances = totalAllow;
    patch.total_deductions = totalDed;
    patch.gross_salary = Number(item.base_salary) + totalAllow + Number(item.overtime_pay || 0);
    patch.net_salary = patch.gross_salary - totalDed;
    await item.update(patch);

    // refresh total payroll
    const items = await HrisPayrollItem.findAll({ where: { payroll_id: item.payroll_id } });
    const total = items.reduce((s, it) => s + Number(it.net_salary), 0);
    await HrisPayroll.update({ total_amount: total }, { where: { id: item.payroll_id } });

    res.json({ success: true, data: item, message: 'Item payroll diperbarui' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.finalizePayroll = async (req, res) => {
  try {
    const row = await HrisPayroll.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Payroll tidak ditemukan' });
    await row.update({ status: 'finalized', finalized_at: new Date() });
    res.json({ success: true, message: 'Payroll difinalisasi', data: row });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// Preview / download slip PDF satu item
exports.slipPdf = async (req, res) => {
  try {
    const fpath = await PayrollService.generateSlipPdf(req.params.itemId);
    res.download(fpath, path.basename(fpath));
  } catch (e) {
    logger.error('[HRIS] slipPdf: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// Kirim slip satu item (email + WA)
exports.sendSlip = async (req, res) => {
  try {
    const result = await PayrollService.sendSlip(req.params.itemId, { io: global.__io });
    res.json({ success: true, message: 'Slip dikirim', data: result });
  } catch (e) {
    logger.error('[HRIS] sendSlip: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// Kirim seluruh slip dalam batch (background-ish, tapi tetap await ringkas)
exports.sendAllSlips = async (req, res) => {
  try {
    const row = await HrisPayroll.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Payroll tidak ditemukan' });
    if (row.status === 'draft') return res.status(400).json({ success: false, message: 'Finalisasi payroll dulu sebelum kirim slip' });
    // Jalankan async, balas cepat supaya request tidak timeout untuk banyak karyawan
    res.json({ success: true, message: 'Pengiriman slip dimulai di latar belakang' });
    PayrollService.sendAllSlips(req.params.id, { io: global.__io })
      .then(sum => {
        logger.info('[HRIS] sendAllSlips selesai: ' + JSON.stringify(sum));
        if (global.__io) global.__io.emit('hris:payroll-sent', { payroll_id: Number(req.params.id), ...sum });
      })
      .catch(e => logger.error('[HRIS] sendAllSlips bg: ' + e.message));
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
