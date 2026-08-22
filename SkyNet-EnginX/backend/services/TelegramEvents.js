'use strict';

/**
 * TelegramEvents.js — Notifikasi event bisnis ke Telegram (Paket B)
 * ─────────────────────────────────────────────────────────────────────
 * Selain monitoring gangguan, kirim notif untuk kejadian operasional/bisnis:
 *   - Pembayaran masuk      (telegram_evt_payment)
 *   - Pelanggan baru        (telegram_evt_newcust)
 *   - Tiket baru            (telegram_evt_ticket)
 *   - Voucher terjual       (telegram_evt_voucher)
 *
 * Dipanggil FIRE-AND-FORGET dari controller terkait — tidak boleh memblok atau
 * melempar error ke alur utama (mis. proses pembayaran tetap sukses walau
 * notif gagal). Setiap event dicatat ke notif_logs (kind='event').
 *
 * Tujuan chat: telegram_chat_event (opsional) → fallback telegram_chat_id global.
 *
 * CATATAN GAYA: pesan TIDAK memakai emoji/ikon sama sekali (permintaan klien).
 * Hanya tag HTML Telegram (<b>, <code>) yang dipakai untuk penekanan.
 *
 * Setting app_settings:
 *   telegram_evt_payment  0/1
 *   telegram_evt_newcust  0/1
 *   telegram_evt_ticket   0/1
 *   telegram_evt_voucher  0/1
 *   telegram_chat_event   chat tujuan event (multi koma; kosong = global)
 *   app_base_url          base URL dashboard (untuk link tiket)
 */

const logger = require('../utils/logger');

const fmtRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Format tanggal+jam Indonesia (Asia/Jakarta).
function fmtDateTime(d) {
  try {
    const dt = d ? new Date(d) : new Date();
    if (isNaN(dt)) return '-';
    return dt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) { return '-'; }
}
// Tanggal saja (tanpa jam).
function fmtDate(d) {
  try {
    const dt = d ? new Date(d) : new Date();
    if (isNaN(dt)) return '-';
    return dt.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric' });
  } catch (_) { return '-'; }
}

// Label periode tagihan "Bulan YYYY" dari period_month (1-12) + period_year.
const BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function fmtPeriode(month, year) {
  const m = parseInt(month, 10);
  if (!m || m < 1 || m > 12 || !year) return '';
  return `${BULAN[m - 1]} ${year}`;
}

// Label prioritas, status, jenis tiket dalam Bahasa Indonesia.
const PRIO_LABEL = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi', critical: 'Kritis' };
const STATUS_LABEL = { open: 'Terbuka', in_progress: 'Dikerjakan', pending: 'Tertunda', resolved: 'Selesai', closed: 'Ditutup' };
const TYPE_LABEL = { gangguan: 'Gangguan', request: 'Permintaan', installation: 'Instalasi', maintenance: 'Perawatan' };

async function _cfg() {
  try { return await require('./TelegramService')._getConfig(); }
  catch (_) { return {}; }
}

// Ambil app_base_url (disimpan terpisah dari prefix telegram_).
async function _getBaseUrl() {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'app_base_url' } });
    const v = (row && row.value || '').trim();
    return /^https?:\/\//i.test(v) ? v.replace(/\/+$/, '') : '';
  } catch (_) { return ''; }
}

async function _writeLog(o) {
  try {
    const { NotifLog } = require('../models');
    if (!NotifLog) return;
    await NotifLog.create({
      kind: 'event', event: o.event, ref_id: o.refId != null ? String(o.refId) : null,
      title: o.title || null, detail: o.detail || null,
      chat_count: o.chatCount || 0, ok_count: o.okCount || 0,
      status: o.status || 'sent', error_message: o.error || null,
    });
  } catch (_) {}
}

// Kirim 1 event bila toggle-nya aktif. Tidak melempar (best-effort).
// buttons opsional: array of array tombol inline → sendMessageWithButtons.
async function _emit(toggleKey, event, text, meta = {}, buttons = null) {
  try {
    const cfg = await _cfg();
    const Telegram = require('./TelegramService');
    if (!Telegram.isEnabled(cfg)) return;
    if (String(cfg[toggleKey]) !== '1') return;

    const target = (cfg.telegram_chat_event || '').trim();
    let res;
    if (buttons && buttons.length) {
      res = await Telegram.sendMessageWithButtons(text, target || cfg.telegram_chat_id, buttons, cfg);
    } else {
      res = target
        ? await Telegram.sendMessageTo(text, target, cfg)
        : await Telegram.sendMessage(text, cfg);
    }

    const okCount = (res.results || []).filter(r => r.ok).length;
    const total = (res.results || []).length;
    const firstErr = (res.results || []).find(r => r && r.ok === false && r.error);
    await _writeLog({
      event, refId: meta.refId, title: meta.title, detail: meta.detail,
      chatCount: total, okCount, status: res.ok ? 'sent' : 'failed',
      error: res.ok ? null : (res.reason || res.error || (firstErr && firstErr.error) || 'gagal'),
    });
  } catch (e) {
    logger.debug('[TGEvents] emit ' + event + ' gagal: ' + (e.message || e));
  }
}

// ── API publik (dipanggil controller) ──────────────────────────────────

/** Pembayaran masuk. */
async function paymentReceived({
  customerName, customerCode, amount, method, invoiceNo, customerId,
  periode, periodeMonth, periodeYear, dueDate, recordedBy, paidAt, packageName,
} = {}) {
  const periodLabel = periode || fmtPeriode(periodeMonth, periodeYear);
  const lines = [
    '<b>Pembayaran Masuk</b>',
    '',
    `Pelanggan : <b>${esc(customerName || '-')}</b>${customerCode ? ` (${esc(customerCode)})` : ''}`,
    packageName ? `Paket     : ${esc(packageName)}` : '',
    `Jumlah    : <b>${fmtRp(amount)}</b>`,
    method ? `Metode    : ${esc(method)}` : '',
    invoiceNo ? `Invoice   : <code>${esc(invoiceNo)}</code>` : '',
    periodLabel ? `Periode   : ${esc(periodLabel)}` : '',
    dueDate ? `Tempo berikutnya : ${esc(fmtDate(dueDate))}` : '',
    recordedBy ? `Dicatat oleh : ${esc(recordedBy)}` : '',
    `Waktu     : ${esc(fmtDateTime(paidAt))}`,
  ].filter(Boolean).join('\n');

  return _emit('telegram_evt_payment', 'payment', lines, {
    refId: customerId, title: customerName, detail: fmtRp(amount) + (periodLabel ? ` · ${periodLabel}` : ''),
  });
}

/** Pelanggan baru. */
async function newCustomer({
  name, customerId, customerCode, packageName, phone, email, address,
  area, connType, staticIp, pppoeUser, price, createdBy, createdAt,
} = {}) {
  const connLabel = connType
    ? ({ pppoe: 'PPPoE', static: 'IP Statis', dhcp: 'DHCP', hotspot: 'Hotspot' }[String(connType).toLowerCase()] || connType)
    : '';
  const lines = [
    '<b>Pelanggan Baru</b>',
    '',
    `Nama    : <b>${esc(name || '-')}</b>`,
    customerCode ? `ID      : <code>${esc(customerCode)}</code>` : '',
    packageName ? `Paket   : ${esc(packageName)}${price ? ` (${fmtRp(price)})` : ''}` : '',
    phone ? `HP      : ${esc(phone)}` : '',
    email ? `Email   : ${esc(email)}` : '',
    address ? `Alamat  : ${esc(address)}` : '',
    area ? `Wilayah : ${esc(area)}` : '',
    connLabel ? `Koneksi : ${esc(connLabel)}` : '',
    staticIp ? `IP      : <code>${esc(staticIp)}</code>` : '',
    pppoeUser ? `User    : <code>${esc(pppoeUser)}</code>` : '',
    createdBy ? `Didaftar oleh : ${esc(createdBy)}` : '',
    `Waktu   : ${esc(fmtDateTime(createdAt))}`,
  ].filter(Boolean).join('\n');

  return _emit('telegram_evt_newcust', 'newcust', lines, {
    refId: customerCode || customerId, title: name, detail: [packageName, area].filter(Boolean).join(' · '),
  });
}

/** Tiket baru. */
async function newTicket({
  ticketNo, ticketId, subject, customerName, customerCode, priority, type, status,
  slaHours, dueAt, assignedTo, locationNote, createdAt, description, createdBy,
} = {}) {
  const prioLabel = priority ? (PRIO_LABEL[String(priority).toLowerCase()] || priority) : '';
  const statusLabel = status ? (STATUS_LABEL[String(status).toLowerCase()] || status) : '';
  const typeLabel = type ? (TYPE_LABEL[String(type).toLowerCase()] || type) : '';

  let descShort = '';
  if (description) {
    const d = String(description).replace(/\s+/g, ' ').trim();
    descShort = d.length > 140 ? d.slice(0, 137) + '…' : d;
  }

  const slaLine = (() => {
    if (dueAt) return `Target SLA : ${esc(fmtDateTime(dueAt))}` + (slaHours ? ` (${slaHours} jam)` : '');
    if (slaHours) return `Target SLA : ${slaHours} jam`;
    return '';
  })();

  const lines = [
    '<b>Tiket Baru</b>',
    '',
    ticketNo ? `No      : <code>${esc(ticketNo)}</code>` : '',
    subject ? `Perihal : <b>${esc(subject)}</b>` : '',
    typeLabel ? `Jenis   : ${esc(typeLabel)}` : '',
    prioLabel ? `Prioritas : ${esc(prioLabel)}` : '',
    statusLabel ? `Status  : ${esc(statusLabel)}` : '',
    (customerName || customerCode) ? `Pelanggan : ${esc(customerName || '-')}${customerCode ? ` (${esc(customerCode)})` : ''}` : '',
    assignedTo ? `Ditugaskan : ${esc(assignedTo)}` : '',
    locationNote ? `Lokasi  : ${esc(locationNote)}` : '',
    slaLine,
    descShort ? `Keterangan : ${esc(descShort)}` : '',
    createdBy ? `Dibuat oleh : ${esc(createdBy)}` : '',
    `Dibuat  : ${esc(fmtDateTime(createdAt))}`,
  ].filter(Boolean).join('\n');

  let buttons = null;
  try {
    const base = await _getBaseUrl();
    if (base && ticketId) {
      buttons = [[{ text: 'Buka Tiket', url: `${base}/tickets?id=${encodeURIComponent(ticketId)}` }]];
    }
  } catch (_) {}

  return _emit('telegram_evt_ticket', 'ticket', lines, {
    refId: ticketNo || ticketId, title: subject || 'Tiket', detail: [prioLabel, customerName].filter(Boolean).join(' · '),
  }, buttons);
}

/** Voucher terjual. */
async function voucherSold({ count, amount, source, packageName, buyer, method, orderCode, soldAt } = {}) {
  const lines = [
    '<b>Voucher Terjual</b>',
    '',
    `Jumlah  : <b>${count || 0}</b> voucher`,
    `Nilai   : <b>${fmtRp(amount)}</b>`,
    (packageName || source) ? `Paket   : ${esc(packageName || source)}` : '',
    buyer ? `Pembeli : ${esc(buyer)}` : '',
    method ? `Metode  : ${esc(method)}` : '',
    orderCode ? `Order   : <code>${esc(orderCode)}</code>` : '',
    `Waktu   : ${esc(fmtDateTime(soldAt))}`,
  ].filter(Boolean).join('\n');

  return _emit('telegram_evt_voucher', 'voucher', lines, {
    refId: orderCode || null, title: `${count || 0} voucher`, detail: [packageName || source, fmtRp(amount)].filter(Boolean).join(' · '),
  });
}

module.exports = { paymentReceived, newCustomer, newTicket, voucherSold };
