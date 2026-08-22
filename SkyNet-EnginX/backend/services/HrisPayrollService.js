/**
 * HrisPayrollService
 * ──────────────────────────────────────────────────────────────────
 * Hitung payroll dari absensi dan kirim slip gaji (PDF) via email + WA.
 *
 *   calculatePayroll(payrollId)  → generate/refresh item per karyawan
 *                                  dari rekap absensi dalam periode.
 *   generateSlipPdf(itemId)      → buat file PDF slip, simpan path.
 *   sendSlip(itemId, {io})       → kirim slip via email & WhatsApp.
 *   sendAllSlips(payrollId,{io}) → kirim ke seluruh item finalized.
 *
 * Aturan gaji sederhana (bisa disesuaikan di halaman admin):
 *   - gaji pokok proporsional? Untuk v1: base_salary penuh untuk salary_type
 *     'bulanan'. Potongan absen = (base/expected_days) * absent_days.
 *   - overtime_pay = (base/expected_days/8jam) * jam_lembur * 1.5 (default).
 */

const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'uploads', 'media', 'payslips');

function ensureDir() {
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (_) {}
}

function daysBetween(start, end) {
  const s = new Date(start), e = new Date(end);
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

/**
 * Hitung ulang seluruh item payroll dari absensi.
 * Tidak menimpa allowances/deductions manual yang sudah diisi admin
 * (kecuali komponen otomatis "Potongan Absen" yang di-recompute).
 */
async function calculatePayroll(payrollId, opts = {}) {
  const models = require('../models');
  const { Employee, HrisAttendance, HrisPayroll, HrisPayrollItem, HrisLeaveRequest } = models;

  const payroll = await HrisPayroll.findByPk(payrollId);
  if (!payroll) throw new Error('Payroll tidak ditemukan');
  if (payroll.status === 'paid') throw new Error('Payroll sudah dibayar, tidak bisa dihitung ulang');

  const { period_start, period_end } = payroll;
  const totalDays = daysBetween(period_start, period_end);

  // Karyawan aktif (atau yang di-scope). Default: semua active.
  const empWhere = { status: 'active' };
  if (Array.isArray(opts.employeeIds) && opts.employeeIds.length) {
    empWhere.id = { [Op.in]: opts.employeeIds };
  }
  const employees = await Employee.findAll({ where: empWhere });

  let total = 0;
  const results = [];

  for (const emp of employees) {
    // Rekap absensi periode ini
    const atts = await HrisAttendance.findAll({
      where: {
        employee_id: emp.id,
        work_date: { [Op.between]: [period_start, period_end] }
      }
    });

    let present = 0, absent = 0, lateCount = 0, lateMin = 0, otMin = 0;
    for (const a of atts) {
      if (['hadir', 'terlambat', 'pulang_cepat'].includes(a.status)) present++;
      if (a.status === 'alfa') absent++;
      if (a.status === 'terlambat') { lateCount++; lateMin += a.late_minutes || 0; }
      otMin += a.overtime_minutes || 0;
    }

    // Hari izin/cuti/sakit approved dalam periode
    const leaves = await HrisLeaveRequest.findAll({
      where: {
        employee_id: emp.id,
        status: 'approved',
        start_date: { [Op.lte]: period_end },
        end_date: { [Op.gte]: period_start }
      }
    });
    let leaveDays = 0;
    for (const lv of leaves) {
      const s = new Date(Math.max(new Date(lv.start_date), new Date(period_start)));
      const e = new Date(Math.min(new Date(lv.end_date), new Date(period_end)));
      leaveDays += Math.max(0, Math.round((e - s) / 86400000) + 1);
    }

    const base = Number(emp.base_salary) || 0;
    const perDay = base / totalDays;

    // Komponen otomatis
    const absentDeduction = Math.round(perDay * absent);
    const overtimePay = Math.round((perDay / 8) * (otMin / 60) * 1.5);

    // Cari item existing untuk pertahankan allowances/deductions manual
    let item = await HrisPayrollItem.findOne({
      where: { payroll_id: payrollId, employee_id: emp.id }
    });

    // Deductions: pertahankan yang manual, ganti "Potongan Absen" otomatis
    let manualDeductions = [];
    let manualAllowances = [];
    if (item) {
      manualDeductions = (item.deductions || []).filter(d => d.label !== 'Potongan Absen');
      manualAllowances = item.allowances || [];
    }
    const deductions = [...manualDeductions];
    if (absentDeduction > 0) deductions.push({ label: 'Potongan Absen', amount: absentDeduction });

    const allowances = manualAllowances;
    const totalAllow = allowances.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const totalDed = deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    const gross = base + totalAllow + overtimePay;
    const net = gross - totalDed;

    const payload = {
      payroll_id: payrollId,
      employee_id: emp.id,
      present_days: present,
      absent_days: absent,
      leave_days: leaveDays,
      late_count: lateCount,
      late_minutes: lateMin,
      overtime_minutes: otMin,
      base_salary: base,
      allowances,
      deductions,
      overtime_pay: overtimePay,
      gross_salary: gross,
      total_allowances: totalAllow,
      total_deductions: totalDed,
      net_salary: net
    };

    if (item) { await item.update(payload); }
    else { item = await HrisPayrollItem.create(payload); }

    total += net;
    results.push(item);
  }

  await payroll.update({ total_amount: total, employee_count: results.length });
  return { payroll, items: results };
}

/** Buat PDF slip untuk satu item, simpan ke disk, kembalikan path. */
async function generateSlipPdf(itemId) {
  const models = require('../models');
  const { HrisPayrollItem, HrisPayroll, Employee } = models;
  const buildPayslipPdf = require('../utils/buildPayslipPdf');
  const { getCompanyName } = require('../utils/companyInfo');

  const item = await HrisPayrollItem.findByPk(itemId, {
    include: [
      { model: Employee, as: 'employee' },
      { model: HrisPayroll, as: 'payroll' }
    ]
  });
  if (!item) throw new Error('Item payroll tidak ditemukan');

  const companyName = await getCompanyName().catch(() => 'Perusahaan');
  // Logo brand (bila ada) — samakan dengan konvensi invoice
  let logoPath = null;
  for (const cand of ['brand-logo.png', 'logo.png']) {
    const p = path.join(__dirname, '..', '..', 'frontend', 'public', 'uploads', cand);
    if (fs.existsSync(p)) { logoPath = p; break; }
  }

  const buf = await buildPayslipPdf({
    companyName,
    logoPath,
    periodLabel: item.payroll?.period_label || '-',
    employee: item.employee ? item.employee.toJSON() : {},
    item: item.toJSON()
  });

  ensureDir();
  const fname = `slip-${item.payroll_id}-${item.employee_id}-${Date.now()}.pdf`;
  const fpath = path.join(OUTPUT_DIR, fname);
  fs.writeFileSync(fpath, buf);
  await item.update({ slip_pdf_path: `uploads/media/payslips/${fname}` });
  return fpath;
}

/** Kirim slip via email + WhatsApp untuk satu item. */
async function sendSlip(itemId, opts = {}) {
  const models = require('../models');
  const { HrisPayrollItem, HrisPayroll, Employee } = models;

  const item = await HrisPayrollItem.findByPk(itemId, {
    include: [
      { model: Employee, as: 'employee' },
      { model: HrisPayroll, as: 'payroll' }
    ]
  });
  if (!item) throw new Error('Item payroll tidak ditemukan');
  const emp = item.employee;
  if (!emp) throw new Error('Karyawan tidak ditemukan');

  // Pastikan PDF ada
  let absPdf;
  if (item.slip_pdf_path && fs.existsSync(path.join(__dirname, '..', '..', item.slip_pdf_path))) {
    absPdf = path.join(__dirname, '..', '..', item.slip_pdf_path);
  } else {
    absPdf = await generateSlipPdf(itemId);
  }

  const period = item.payroll?.period_label || '';
  const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const result = { email: 'skipped', wa: 'skipped' };

  // ── EMAIL ──
  if (emp.email) {
    try {
      const EmailService = require('./EmailService');
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
          <h2 style="color:#2563eb;margin:0 0 8px">Slip Gaji — ${period}</h2>
          <p>Halo <b>${emp.full_name}</b>,</p>
          <p>Berikut slip gaji Anda untuk periode <b>${period}</b>. Gaji bersih:
            <b style="color:#16a34a">${fmt(item.net_salary)}</b>.</p>
          <p>Detail lengkap terlampir dalam file PDF.</p>
          <p style="color:#6b7280;font-size:12px">Email ini dikirim otomatis oleh sistem HRIS.</p>
        </div>`;
      const r = await EmailService.sendWithReason({
        to: emp.email,
        subject: `Slip Gaji ${period} — ${emp.full_name}`,
        html,
        type: 'payslip',
        attachments: [{ filename: `slip-gaji-${period}.pdf`, path: absPdf }]
      });
      result.email = (r && r.ok) ? 'sent' : 'failed';
    } catch (e) {
      logger.error('[HRIS Payroll] email slip gagal: ' + e.message);
      result.email = 'failed';
    }
  }

  // ── WHATSAPP ──
  if (emp.phone) {
    try {
      const GatewayService = require('./GatewayService');
      const sessionId = await GatewayService.getDefaultSendingSessionId();
      if (sessionId) {
        const caption = `*Slip Gaji ${period}*\n\nHalo ${emp.full_name},\nGaji bersih Anda: *${fmt(item.net_salary)}*.\nDetail lengkap ada di file PDF terlampir.`;
        await GatewayService.sendMedia(sessionId, {
          to: emp.phone,
          mediaPath: absPdf,
          mediaType: 'document',
          mimeType: 'application/pdf',
          fileName: `Slip-Gaji-${period}.pdf`,
          caption
        }, opts.io);
        result.wa = 'sent';
      } else {
        result.wa = 'failed';
      }
    } catch (e) {
      logger.error('[HRIS Payroll] WA slip gagal: ' + e.message);
      result.wa = 'failed';
    }
  }

  await item.update({
    email_status: result.email,
    wa_status: result.wa,
    sent_at: new Date()
  });
  return result;
}

/** Kirim slip untuk seluruh item dalam payroll (finalized). */
async function sendAllSlips(payrollId, opts = {}) {
  const models = require('../models');
  const { HrisPayrollItem } = models;
  const items = await HrisPayrollItem.findAll({ where: { payroll_id: payrollId } });
  const summary = { total: items.length, email_sent: 0, wa_sent: 0, failed: 0 };
  for (const it of items) {
    try {
      const r = await sendSlip(it.id, opts);
      if (r.email === 'sent') summary.email_sent++;
      if (r.wa === 'sent') summary.wa_sent++;
      // jeda antar kirim supaya WA gateway tidak kena rate limit
      await new Promise(res => setTimeout(res, 1200));
    } catch (e) {
      summary.failed++;
      logger.error('[HRIS Payroll] sendAllSlips item ' + it.id + ': ' + e.message);
    }
  }
  return summary;
}

module.exports = { calculatePayroll, generateSlipPdf, sendSlip, sendAllSlips, OUTPUT_DIR };
