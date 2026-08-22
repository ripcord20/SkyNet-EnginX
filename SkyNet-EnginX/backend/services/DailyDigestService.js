/**
 * DailyDigestService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Pulse operasional" ISP yang dikirim ke email admin & (versi Telegram) ke grup.
 * Berbeda dari Laporan Keuangan (fokus angka rupiah): digest ini ringkas &
 * operasional — pelanggan baru, penunggak, uang masuk, tiket terbuka,
 * perangkat offline, churn, voucher, setoran kolektor.
 *
 * ★ v2 — PERIODE-AWARE
 *   buildDigestData(period) mendukung:
 *     'yesterday' (default, kompatibel lama) | 'today' | 'week' | 'month'
 *   + blok perbandingan vs periode sebelumnya (delta %), dipakai untuk
 *     Telegram Report mingguan/bulanan agar angka sesuai frekuensi.
 *
 * Gaya HTML email mengikuti FinanceEmailReportService.
 */

const moment = require('moment');
const { sequelize } = require('../models');
const { Op } = require('sequelize');

const fmtRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const QT = sequelize.QueryTypes.SELECT;
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QT });

/**
 * Resolusi rentang periode → { start, end, label, prevStart, prevEnd }.
 * Semua rentang inklusif (HH:mm:ss) di timezone server aplikasi.
 */
function resolveRange(period = 'yesterday') {
  let start, end, label, prevStart, prevEnd;

  switch (period) {
    case 'today': {
      const d = moment().startOf('day');
      start = d.clone();
      end   = moment().endOf('day');
      label = d.format('dddd, D MMMM YYYY');
      prevStart = d.clone().subtract(1, 'day');
      prevEnd   = d.clone().subtract(1, 'day').endOf('day');
      break;
    }
    case 'week': {
      // 7 hari penuh terakhir (kemarin mundur 6 hari) — bukan minggu kalender,
      // supaya report mingguan kapan pun dikirim tetap mencakup 7 hari penuh.
      end   = moment().subtract(1, 'day').endOf('day');
      start = moment().subtract(7, 'day').startOf('day');
      label = `${start.format('D MMM')} – ${end.format('D MMM YYYY')}`;
      prevEnd   = start.clone().subtract(1, 'day').endOf('day');
      prevStart = start.clone().subtract(7, 'day').startOf('day');
      break;
    }
    case 'month': {
      // Bulan berjalan s/d kemarin (atau bulan penuh bila dikirim tgl 1).
      start = moment().startOf('month');
      end   = moment().subtract(1, 'day').endOf('day');
      if (end.isBefore(start)) { end = start.clone().endOf('day'); }
      label = start.format('MMMM YYYY');
      prevStart = start.clone().subtract(1, 'month').startOf('month');
      prevEnd   = start.clone().subtract(1, 'day').endOf('day');
      break;
    }
    case 'yesterday':
    default: {
      const d = moment().subtract(1, 'day').startOf('day');
      start = d.clone();
      end   = moment().subtract(1, 'day').endOf('day');
      label = d.format('dddd, D MMMM YYYY');
      prevStart = d.clone().subtract(1, 'day');
      prevEnd   = d.clone().subtract(1, 'day').endOf('day');
      break;
    }
  }

  const f = (m) => m.format('YYYY-MM-DD HH:mm:ss');
  return {
    start: f(start), end: f(end), label,
    prevStart: f(prevStart), prevEnd: f(prevEnd),
    periodKey: period,
  };
}

// Hitung delta persen (untuk blok perbandingan). null bila tak relevan.
function pct(curr, prev) {
  curr = Number(curr || 0); prev = Number(prev || 0);
  if (prev === 0) return curr === 0 ? 0 : 100;
  return Math.round(((curr - prev) / prev) * 100);
}

// ── Query atomik tiap metrik (range start/end) ───────────────────────────────
async function _newCustomers(start, end) {
  const r = await q(`SELECT COUNT(*) AS cnt FROM customers WHERE created_at BETWEEN :start AND :end`, { start, end });
  return +(r[0]?.cnt || 0);
}
async function _activeCustomers() {
  const r = await q(`SELECT COUNT(*) AS cnt FROM customers WHERE status='active'`);
  return +(r[0]?.cnt || 0);
}
async function _churn(start, end) {
  // Pelanggan yang berhenti pada rentang: status berubah ke inactive/suspended.
  // Tanpa kolom terminated khusus → pakai updated_at + status non-aktif.
  const r = await q(
    `SELECT COUNT(*) AS cnt FROM customers
      WHERE status IN ('inactive','suspended')
        AND updated_at BETWEEN :start AND :end`,
    { start, end }
  );
  return +(r[0]?.cnt || 0);
}
async function _overdue() {
  const r = await q(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total FROM invoices
      WHERE (status='overdue' OR (status='unpaid' AND due_date < CURDATE()))`
  );
  return { cnt: +(r[0]?.cnt || 0), total: parseFloat(r[0]?.total || 0) };
}
async function _topOverdue(limit = 3) {
  const r = await q(
    `SELECT c.name AS name, COUNT(i.id) AS cnt, COALESCE(SUM(i.total),0) AS total
       FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE (i.status='overdue' OR (i.status='unpaid' AND i.due_date < CURDATE()))
      GROUP BY i.customer_id, c.name ORDER BY total DESC LIMIT :limit`,
    { limit }
  );
  return (r || []).map(x => ({ name: x.name, cnt: +x.cnt, total: parseFloat(x.total || 0) }));
}
async function _payments(start, end) {
  const r = await q(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
       FROM payments WHERE payment_date BETWEEN :start AND :end`,
    { start, end }
  );
  return { cnt: +(r[0]?.cnt || 0), total: parseFloat(r[0]?.total || 0) };
}
async function _tickets() {
  const r = await q(`SELECT COUNT(*) AS cnt FROM tickets WHERE status IN ('open','in_progress','pending')`);
  return +(r[0]?.cnt || 0);
}
async function _newTickets(start, end) {
  const r = await q(`SELECT COUNT(*) AS cnt FROM tickets WHERE created_at BETWEEN :start AND :end`, { start, end });
  return +(r[0]?.cnt || 0);
}
async function _devices() {
  const r = await q(
    `SELECT SUM(CASE WHEN status='offline' THEN 1 ELSE 0 END) AS offline, COUNT(*) AS total FROM devices`
  );
  return { offline: +(r[0]?.offline || 0), total: +(r[0]?.total || 0) };
}
// Voucher terjual = reseller purchase + order publik delivered/paid pada rentang.
async function _vouchers(start, end) {
  let resellerCnt = 0, resellerRev = 0, publicCnt = 0, publicRev = 0;
  try {
    const r = await q(
      `SELECT COALESCE(SUM(voucher_count),0) AS cnt, COALESCE(SUM(ABS(amount)),0) AS rev
         FROM reseller_transactions
        WHERE type='purchase' AND created_at BETWEEN :start AND :end`,
      { start, end }
    );
    resellerCnt = +(r[0]?.cnt || 0); resellerRev = parseFloat(r[0]?.rev || 0);
  } catch (_) {}
  try {
    const r = await q(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS rev
         FROM public_voucher_orders
        WHERE status IN ('paid','delivered') AND created_at BETWEEN :start AND :end`,
      { start, end }
    );
    publicCnt = +(r[0]?.cnt || 0); publicRev = parseFloat(r[0]?.rev || 0);
  } catch (_) {}
  return {
    cnt: resellerCnt + publicCnt,
    revenue: resellerRev + publicRev,
    reseller: resellerCnt, public: publicCnt,
  };
}
// Setoran kolektor (cash deposit) terverifikasi pada rentang.
async function _deposits(start, end) {
  try {
    const r = await q(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(deposited_amount),0) AS total
         FROM cash_deposits
        WHERE status='verified' AND updated_at BETWEEN :start AND :end`,
      { start, end }
    );
    return { cnt: +(r[0]?.cnt || 0), total: parseFloat(r[0]?.total || 0) };
  } catch (_) { return { cnt: 0, total: 0 }; }
}
// ARPU sederhana = uang masuk periode / pelanggan aktif.
function _arpu(paymentsTotal, activeCustomers) {
  if (!activeCustomers) return 0;
  return Math.round(Number(paymentsTotal || 0) / activeCustomers);
}

/**
 * buildDigestData(period='yesterday', opts={ withCompare:false, withExtras:false })
 *   → objek angka digest untuk rentang terkait.
 */
async function buildDigestData(period = 'yesterday', opts = {}) {
  const R = resolveRange(period);

  const [
    newCustomers, activeCustomers, overdue, paymentsIn,
    openTickets, newTickets, dev,
  ] = await Promise.all([
    _newCustomers(R.start, R.end),
    _activeCustomers(),
    _overdue(),
    _payments(R.start, R.end),
    _tickets(),
    _newTickets(R.start, R.end),
    _devices(),
  ]);

  const data = {
    period: R.periodKey,
    dateLabel: R.label,
    start: R.start, end: R.end,
    newCustomers, activeCustomers,
    overdue, paymentsIn,
    openTickets, newTickets,
    devicesOffline: dev.offline, devicesTotal: dev.total,
  };

  if (opts.withExtras) {
    const [churn, topOverdue, vouchers, deposits] = await Promise.all([
      _churn(R.start, R.end),
      _topOverdue(3),
      _vouchers(R.start, R.end),
      _deposits(R.start, R.end),
    ]);
    data.churn = churn;
    data.topOverdue = topOverdue;
    data.vouchers = vouchers;
    data.deposits = deposits;
    data.arpu = _arpu(paymentsIn.total, activeCustomers);
  }

  if (opts.withCompare) {
    const [prevPay, prevNew] = await Promise.all([
      _payments(R.prevStart, R.prevEnd),
      _newCustomers(R.prevStart, R.prevEnd),
    ]);
    data.compare = {
      income:    { curr: paymentsIn.total, prev: prevPay.total, pct: pct(paymentsIn.total, prevPay.total) },
      payments:  { curr: paymentsIn.cnt,   prev: prevPay.cnt,   pct: pct(paymentsIn.cnt,   prevPay.cnt) },
      newcust:   { curr: newCustomers,     prev: prevNew,       pct: pct(newCustomers,     prevNew) },
    };
  }

  return data;
}

// Kartu metrik kecil untuk grid ringkasan (email).
function metricCard(label, value, sub, accent) {
  const a = accent || '#1f8bff';
  return `<td width="33%" style="padding:4px;">
    <div style="background:#f8fafe;border:1px solid #e8eef9;border-radius:12px;padding:14px;text-align:center;">
      <div style="font-size:10.5px;color:${a};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
      <div style="font-size:20px;font-weight:800;color:#0d1b3e;margin-top:5px;">${esc(value)}</div>
      ${sub ? `<div style="font-size:10.5px;color:#94a3b8;margin-top:3px;">${esc(sub)}</div>` : ''}
    </div>
  </td>`;
}

function row(label, value, opt = {}) {
  const color = opt.color || '#1f2937';
  const bg = opt.bg ? ' background:#f8faff;' : '';
  const dot = opt.dot ? `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${opt.dot};margin-right:7px;"></span>` : '';
  return `<tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;${bg}">${dot}${esc(label)}</td>
    <td align="right" style="padding:9px 14px;font-weight:700;color:${color};border-top:1px solid #eef3fb;${bg}">${esc(value)}</td></tr>`;
}

/**
 * buildEmailHtml(data, { companyName, accent })
 */
function buildEmailHtml(data, { companyName = 'ISP', accent = '#1f8bff' } = {}) {
  const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : '#1f8bff';
  const devColor = data.devicesOffline > 0 ? '#dc2626' : '#16a34a';
  const ticketColor = data.openTickets > 0 ? '#e08a00' : '#16a34a';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef3fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fb;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e8eef9;font-family:Arial,Helvetica,sans-serif;">

    <tr><td style="background:${safeAccent};padding:24px 26px;">
      <div style="color:#fff;font-size:19px;font-weight:800;">${esc(companyName)}</div>
      <div style="color:rgba(255,255,255,.92);font-size:14px;margin-top:4px;font-weight:600;">Ringkasan Operasional</div>
      <div style="color:rgba(255,255,255,.75);font-size:11.5px;margin-top:2px;">${esc(data.dateLabel)}</div>
    </td></tr>

    <tr><td style="padding:20px 18px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${metricCard('Pelanggan Baru', '+' + data.newCustomers, data.activeCustomers + ' aktif', '#1565e0')}
        ${metricCard('Uang Masuk', fmtRp(data.paymentsIn.total), data.paymentsIn.cnt + ' pembayaran', '#16a34a')}
        ${metricCard('Penunggak', data.overdue.cnt, fmtRp(data.overdue.total), '#dc2626')}
      </tr></table>
    </td></tr>

    <tr><td style="padding:4px 18px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${metricCard('Tiket Terbuka', data.openTickets, data.newTickets + ' baru', '#e08a00')}
        ${metricCard('Perangkat Offline', data.devicesOffline, 'dari ' + data.devicesTotal + ' perangkat', data.devicesOffline > 0 ? '#dc2626' : '#16a34a')}
        ${metricCard('Pelanggan Aktif', data.activeCustomers, 'total langganan', '#1f8bff')}
      </tr></table>
    </td></tr>

    <tr><td style="padding:6px 18px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:12px;overflow:hidden;font-size:13px;">
        <tr><td colspan="2" style="padding:14px 14px 6px;font-size:13px;font-weight:800;color:#0d1b3e;">Rincian</td></tr>
        ${row('Pelanggan baru', '+' + data.newCustomers, { dot: '#1565e0' })}
        ${row('Uang masuk', fmtRp(data.paymentsIn.total), { color: '#16a34a', dot: '#16a34a', bg: true })}
        ${row('Invoice menunggak', data.overdue.cnt + ' invoice · ' + fmtRp(data.overdue.total), { color: '#dc2626', dot: '#dc2626' })}
        ${row('Tiket terbuka', data.openTickets + ' tiket', { color: ticketColor, dot: '#e08a00', bg: true })}
        ${row('Perangkat offline', data.devicesOffline + ' / ' + data.devicesTotal, { color: devColor, dot: devColor })}
        ${data.vouchers ? row('Voucher terjual', data.vouchers.cnt + ' · ' + fmtRp(data.vouchers.revenue), { color: '#0e7490', dot: '#06b6d4', bg: true }) : ''}
        ${data.deposits ? row('Setoran kolektor', data.deposits.cnt + ' · ' + fmtRp(data.deposits.total), { color: '#7c3a00', dot: '#f59e0b' }) : ''}
      </table>
      <div style="font-size:11px;color:#94a3b8;margin-top:12px;text-align:center;line-height:1.6;">
        Ringkasan ini dikirim otomatis sesuai jadwal. Atur di menu <b>Email Schedule</b> / <b>Telegram Report</b>.
      </div>
    </td></tr>

    <tr><td style="background:#fafcff;border-top:1px solid #eef3fb;padding:14px 18px;text-align:center;">
      <div style="font-size:11px;color:#94a3b8;">— ${esc(companyName)} · Operational Digest</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

/**
 * sendDigest({ to, period }) → { ok, reason, data, recipients }
 */
async function sendDigest({ to, period = 'yesterday' } = {}) {
  const EmailService = require('./EmailService');
  let companyName = '';
  let accent = '#1f8bff';
  try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
  companyName = companyName || 'ISP';
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'theme_primary_color' } });
    if (row && /^#[0-9a-fA-F]{3,8}$/.test(String(row.value || '').trim())) accent = row.value.trim();
  } catch (_) {}

  const data = await buildDigestData(period, { withExtras: true });
  const html = buildEmailHtml(data, { companyName, accent });
  const subject = `Ringkasan ${data.dateLabel} — ${companyName}`;
  const text = `Ringkasan ${data.dateLabel}\n`
    + `Pelanggan baru: +${data.newCustomers}\n`
    + `Uang masuk: ${fmtRp(data.paymentsIn.total)} (${data.paymentsIn.cnt} pembayaran)\n`
    + `Penunggak: ${data.overdue.cnt} invoice (${fmtRp(data.overdue.total)})\n`
    + `Tiket terbuka: ${data.openTickets}\n`
    + `Perangkat offline: ${data.devicesOffline}/${data.devicesTotal}`;

  const recipients = String(to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return { ok: false, reason: 'Alamat email tujuan kosong', data };

  let okAll = true, lastReason = '';
  for (const rcpt of recipients) {
    const r = await EmailService.sendWithReason({ to: rcpt, subject, html, text, type: 'daily_digest' });
    if (!r.ok) { okAll = false; lastReason = r.reason; }
  }
  return { ok: okAll, reason: okAll ? '' : lastReason, data, recipients };
}

module.exports = {
  buildDigestData, buildEmailHtml, sendDigest, fmtRp,
  resolveRange,
};
