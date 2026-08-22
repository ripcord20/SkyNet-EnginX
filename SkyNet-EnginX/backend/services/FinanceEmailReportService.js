/**
 * FinanceEmailReportService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Merakit laporan keuangan dan mengirimnya via email. Dipakai oleh:
 *   - Endpoint kirim-manual dari halaman Laporan (POST /api/finance/report/email)
 *   - Cron penjadwalan otomatis (harian/mingguan/bulanan)
 *
 * Isi laporan: Ringkasan, Pembayaran (lunas / belum bayar / menunggak),
 * Laba-Rugi, serta Pemasukan & Pengeluaran per kategori.
 */

const moment = require('moment');
const { sequelize, Invoice, Payment } = require('../models');
const { Op } = require('sequelize');

// Kategori biaya yang dianggap COGS (selaras dgn FinanceReportController).
const COGS_KW = /(bandwidth|upstream|transit|sewa|colocation|pop|backbone|ip transit|server|listrik|maintenance)/i;

const fmtRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/**
 * buildReportData({ period:'month'|'year', month, year })
 * → objek berisi seluruh angka laporan.
 */
async function buildReportData({ period = 'month', month, year } = {}) {
  const isYear = String(period).toLowerCase() === 'year';
  const m = parseInt(month) || (moment().month() + 1);
  const y = parseInt(year) || moment().year();
  const start = isYear
    ? moment(`${y}-01-01`).startOf('year').format('YYYY-MM-DD')
    : moment(`${y}-${String(m).padStart(2, '0')}-01`).startOf('month').format('YYYY-MM-DD');
  const end = isYear
    ? moment(`${y}-12-31`).endOf('year').format('YYYY-MM-DD')
    : moment(start).endOf('month').format('YYYY-MM-DD');
  const periodLabel = isYear ? `Tahun ${y}` : moment(start).format('MMMM YYYY');

  // ── Pemasukan & pengeluaran per kategori (tabel keuangan) ──
  const incomeRows = await sequelize.query(
    `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM keuangan WHERE type='pemasukan' AND date BETWEEN :start AND :end
      GROUP BY category ORDER BY total DESC`,
    { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
  );
  const expenseRows = await sequelize.query(
    `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM keuangan WHERE type='pengeluaran' AND date BETWEEN :start AND :end
      GROUP BY category ORDER BY total DESC`,
    { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
  );

  const revenue = incomeRows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
  let cogs = 0, opex = 0;
  for (const r of expenseRows) {
    const amt = parseFloat(r.total || 0);
    if (COGS_KW.test(r.category || '')) cogs += amt; else opex += amt;
  }
  const totalExpense = cogs + opex;
  const grossProfit = revenue - cogs;
  const netProfit = grossProfit - opex;

  // ── Pembayaran: lunas / belum bayar / menunggak ──
  // Periode invoice memakai period_year (+ period_month bila bulanan).
  const invWhere = isYear
    ? `period_year = :y`
    : `period_year = :y AND period_month = :m`;
  const repl = { y, m };

  const paidAgg = await sequelize.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total
       FROM invoices WHERE ${invWhere} AND status='paid'`,
    { replacements: repl, type: sequelize.QueryTypes.SELECT }
  );
  const unpaidAgg = await sequelize.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total
       FROM invoices WHERE ${invWhere} AND status='unpaid' AND (due_date IS NULL OR due_date >= CURDATE())`,
    { replacements: repl, type: sequelize.QueryTypes.SELECT }
  );
  // Menunggak = unpaid yang sudah lewat jatuh tempo, atau status overdue.
  const overdueAgg = await sequelize.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total
       FROM invoices WHERE ${invWhere} AND (status='overdue' OR (status='unpaid' AND due_date < CURDATE()))`,
    { replacements: repl, type: sequelize.QueryTypes.SELECT }
  );

  const paid    = { cnt: +paidAgg[0].cnt,    total: parseFloat(paidAgg[0].total || 0) };
  const unpaid  = { cnt: +unpaidAgg[0].cnt,  total: parseFloat(unpaidAgg[0].total || 0) };
  const overdue = { cnt: +overdueAgg[0].cnt, total: parseFloat(overdueAgg[0].total || 0) };
  const totalInvoiced = paid.total + unpaid.total + overdue.total;
  const totalInvoiceCnt = paid.cnt + unpaid.cnt + overdue.cnt;
  const collectionRate = totalInvoiced > 0 ? (paid.total / totalInvoiced * 100) : 0;

  // Pembayaran aktual (uang masuk) periode tsb.
  const paymentSum = await sequelize.query(
    `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM payments WHERE payment_date BETWEEN :start AND :end`,
    { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
  );
  const totalPaymentsIn = parseFloat(paymentSum[0].total || 0);

  return {
    periodLabel, start, end, isYear, month: m, year: y,
    income: incomeRows.map(r => ({ category: r.category || '(lainnya)', amount: parseFloat(r.total || 0), cnt: +r.cnt })),
    expense: expenseRows.map(r => ({ category: r.category || '(lainnya)', amount: parseFloat(r.total || 0), cnt: +r.cnt })),
    revenue, cogs, opex, totalExpense, grossProfit, netProfit,
    grossMargin: revenue > 0 ? grossProfit / revenue * 100 : 0,
    netMargin: revenue > 0 ? netProfit / revenue * 100 : 0,
    payment: { paid, unpaid, overdue, totalInvoiced, totalInvoiceCnt, collectionRate, totalPaymentsIn }
  };
}

// Baris tabel 2-kolom (label, nilai).
function row(label, value, opt = {}) {
  const color = opt.color || '#1f2937';
  const bg = opt.bg ? ' background:#f8faff;' : '';
  const bold = opt.bold ? '800' : '700';
  return `<tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;${bg}">${esc(label)}</td>
    <td align="right" style="padding:9px 14px;font-weight:${bold};color:${color};border-top:1px solid #eef3fb;${bg}">${esc(value)}</td></tr>`;
}
function sectionTitle(t) {
  return `<tr><td colspan="2" style="padding:16px 14px 6px;font-size:13px;font-weight:800;color:#0d1b3e;letter-spacing:-.2px;">${esc(t)}</td></tr>`;
}

/**
 * buildEmailHtml(data, { companyName, accent })
 * → HTML email laporan keuangan yang rapi & responsif.
 */
function buildEmailHtml(data, { companyName = 'ISP', accent = '#1f8bff' } = {}) {
  const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : '#1f8bff';
  const p = data.payment;

  const incomeRowsHtml = data.income.length
    ? data.income.map(r => row(r.category, fmtRp(r.amount))).join('')
    : `<tr><td colspan="2" style="padding:9px 14px;color:#94a3b8;font-size:12.5px;border-top:1px solid #eef3fb;">Tidak ada pemasukan tercatat.</td></tr>`;
  const expenseRowsHtml = data.expense.length
    ? data.expense.map(r => row(r.category, fmtRp(r.amount))).join('')
    : `<tr><td colspan="2" style="padding:9px 14px;color:#94a3b8;font-size:12.5px;border-top:1px solid #eef3fb;">Tidak ada pengeluaran tercatat.</td></tr>`;

  const netColor = data.netProfit >= 0 ? '#16a34a' : '#dc2626';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef3fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fb;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e8eef9;font-family:Arial,Helvetica,sans-serif;">

    <!-- Header -->
    <tr><td style="background:${safeAccent};padding:24px 26px;">
      <div style="color:#fff;font-size:19px;font-weight:800;">${esc(companyName)}</div>
      <div style="color:rgba(255,255,255,.92);font-size:14px;margin-top:4px;font-weight:600;">Laporan Keuangan — ${esc(data.periodLabel)}</div>
      <div style="color:rgba(255,255,255,.75);font-size:11.5px;margin-top:2px;">Periode ${esc(moment(data.start).format('D MMM YYYY'))} – ${esc(moment(data.end).format('D MMM YYYY'))}</div>
    </td></tr>

    <!-- Ringkasan: 3 kartu -->
    <tr><td style="padding:20px 18px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="33%" style="padding:4px;">
          <div style="background:#f0f9ff;border:1px solid #d6ecff;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:10.5px;color:#1565e0;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Pemasukan</div>
            <div style="font-size:17px;font-weight:800;color:#1565e0;margin-top:5px;">${fmtRp(data.revenue)}</div>
          </div>
        </td>
        <td width="33%" style="padding:4px;">
          <div style="background:#fef6f0;border:1px solid #ffe0cc;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:10.5px;color:#c2562a;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Pengeluaran</div>
            <div style="font-size:17px;font-weight:800;color:#c2562a;margin-top:5px;">${fmtRp(data.totalExpense)}</div>
          </div>
        </td>
        <td width="33%" style="padding:4px;">
          <div style="background:${data.netProfit>=0?'#f0fdf4':'#fef2f2'};border:1px solid ${data.netProfit>=0?'#c6f0d5':'#fecaca'};border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:10.5px;color:${netColor};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Laba Bersih</div>
            <div style="font-size:17px;font-weight:800;color:${netColor};margin-top:5px;">${fmtRp(data.netProfit)}</div>
          </div>
        </td>
      </tr></table>
    </td></tr>

    <!-- Pembayaran Pelanggan -->
    <tr><td style="padding:6px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:12px;overflow:hidden;font-size:13px;">
        ${sectionTitle('Pembayaran Pelanggan')}
        <tr>
          <td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#16a34a;margin-right:7px;"></span>Lunas (${p.paid.cnt} invoice)</td>
          <td align="right" style="padding:9px 14px;font-weight:700;color:#16a34a;border-top:1px solid #eef3fb;">${fmtRp(p.paid.total)}</td>
        </tr>
        <tr>
          <td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;background:#f8faff;">
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#e08a00;margin-right:7px;"></span>Belum Bayar (${p.unpaid.cnt} invoice)</td>
          <td align="right" style="padding:9px 14px;font-weight:700;color:#e08a00;border-top:1px solid #eef3fb;background:#f8faff;">${fmtRp(p.unpaid.total)}</td>
        </tr>
        <tr>
          <td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#dc2626;margin-right:7px;"></span>Menunggak (${p.overdue.cnt} invoice)</td>
          <td align="right" style="padding:9px 14px;font-weight:700;color:#dc2626;border-top:1px solid #eef3fb;">${fmtRp(p.overdue.total)}</td>
        </tr>
        ${row('Total Tertagih', fmtRp(p.totalInvoiced), { bold: true, bg: true })}
        ${row('Tingkat Penagihan', p.collectionRate.toFixed(1) + '%', { color: safeAccent })}
        ${row('Uang Masuk (Pembayaran)', fmtRp(p.totalPaymentsIn), { color: '#16a34a' })}
      </table>
    </td></tr>

    <!-- Laba Rugi -->
    <tr><td style="padding:6px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:12px;overflow:hidden;font-size:13px;">
        ${sectionTitle('Laba Rugi')}
        ${row('Pendapatan', fmtRp(data.revenue))}
        ${row('HPP / Biaya Langsung', '− ' + fmtRp(data.cogs), { bg: true })}
        ${row('Laba Kotor', fmtRp(data.grossProfit), { color: safeAccent, bold: true })}
        ${row('Biaya Operasional', '− ' + fmtRp(data.opex))}
        ${row('Laba Bersih', fmtRp(data.netProfit), { color: netColor, bold: true, bg: true })}
        ${row('Margin Bersih', data.netMargin.toFixed(1) + '%', { color: netColor })}
      </table>
    </td></tr>

    <!-- Pemasukan per kategori -->
    <tr><td style="padding:6px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:12px;overflow:hidden;font-size:13px;">
        ${sectionTitle('Pemasukan per Kategori')}
        ${incomeRowsHtml}
        ${row('Total Pemasukan', fmtRp(data.revenue), { bold: true, bg: true, color: '#1565e0' })}
      </table>
    </td></tr>

    <!-- Pengeluaran per kategori -->
    <tr><td style="padding:6px 18px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:12px;overflow:hidden;font-size:13px;">
        ${sectionTitle('Pengeluaran per Kategori')}
        ${expenseRowsHtml}
        ${row('Total Pengeluaran', fmtRp(data.totalExpense), { bold: true, bg: true, color: '#c2562a' })}
      </table>
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:6px 26px 24px;">
      <div style="border-top:1px solid #eef2f9;padding-top:14px;color:#94a3b8;font-size:11.5px;line-height:1.7;">
        Laporan ini dibuat otomatis oleh sistem ${esc(companyName)} pada ${esc(moment().format('D MMMM YYYY HH:mm'))}.<br>
        Angka berdasarkan data yang tercatat di sistem dan dapat berubah bila ada transaksi/pembayaran baru.
      </div>
    </td></tr>

  </table>
  <div style="font-size:11px;color:#aab3c6;margin-top:12px;font-family:Arial,Helvetica,sans-serif;">${esc(companyName)}</div>
</td></tr>
</table>
</body></html>`;
}

/**
 * sendReport({ to, period, month, year }) → { ok, reason, data }
 * Merakit + mengirim laporan ke satu/lebih email (dipisah koma).
 */
async function sendReport({ to, period, month, year } = {}) {
  const EmailService = require('./EmailService');
  let companyName = '';
  try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
  companyName = companyName || 'ISP';

  const data = await buildReportData({ period, month, year });
  const html = buildEmailHtml(data, { companyName });
  const subject = `Laporan Keuangan ${data.periodLabel} — ${companyName}`;
  const text = `Laporan Keuangan ${data.periodLabel}\n`
    + `Pemasukan: ${fmtRp(data.revenue)}\nPengeluaran: ${fmtRp(data.totalExpense)}\n`
    + `Laba Bersih: ${fmtRp(data.netProfit)}\n`
    + `Lunas: ${fmtRp(data.payment.paid.total)} | Belum Bayar: ${fmtRp(data.payment.unpaid.total)} | Menunggak: ${fmtRp(data.payment.overdue.total)}`;

  const recipients = String(to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return { ok: false, reason: 'Alamat email tujuan kosong', data };

  let okAll = true, lastReason = '';
  for (const rcpt of recipients) {
    const r = await EmailService.sendWithReason({ to: rcpt, subject, html, text, type: 'finance_report' });
    if (!r.ok) { okAll = false; lastReason = r.reason; }
  }
  return { ok: okAll, reason: okAll ? '' : lastReason, data, recipients };
}

module.exports = { buildReportData, buildEmailHtml, sendReport, fmtRp };
