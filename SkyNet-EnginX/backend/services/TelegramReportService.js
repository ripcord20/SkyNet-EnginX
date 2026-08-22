'use strict';

/**
 * TelegramReportService.js  ★ v2
 * ─────────────────────────────────────────────────────────────────────
 * Kirim ringkasan operasional ISP ke Telegram secara terjadwal.
 * Versi Telegram dari Daily Digest — reuse DailyDigestService (angka konsisten).
 *
 * ★ PENINGKATAN v2:
 *   1. PERIODE-AWARE — frekuensi weekly/monthly mengambil data 7-hari / bulan
 *      berjalan (bukan lagi selalu "kemarin"). Pemetaan otomatis:
 *        daily→yesterday, weekly→week, monthly→month (bisa di-override per panggilan).
 *   2. BLOK KONTEN BARU — churn, top penunggak, voucher terjual, setoran kolektor,
 *      ARPU, dan blok perbandingan (vs periode lalu, ▲▼ %).
 *   3. DEDUP KUAT — run_key granular `${freq}:${YYYY-MM-DD}:${HH}` via ReportLog
 *      (UNIQUE) + fallback app_settings, tahan duplikasi multi-proses/restart.
 *   4. RETRY + ERROR VISIBILITY — kirim diulang (3x backoff). Bila gagal,
 *      notifikasi balik ke admin (telegram_chat_id global).
 *   5. RIWAYAT — setiap kiriman dicatat di ReportLog (tab Riwayat di UI).
 *   6. TOMBOL — inline keyboard "Lihat Dashboard" (deep-link) opsional.
 *   7. BATAS PANJANG — sadar limit Telegram 4096 char (preview & guard).
 *
 * Setting app_settings (prefix `tgreport_`):
 *   tgreport_enabled        0/1
 *   tgreport_frequency      daily | weekly | monthly
 *   tgreport_period         (opsional override) yesterday|today|week|month
 *   tgreport_hour           0-23 (default 7)
 *   tgreport_minute         0-59 (default 0)
 *   tgreport_day_of_week    0-6 (Minggu=0; weekly)
 *   tgreport_day_of_month   1-28 (monthly)
 *   tgreport_chat_id        tujuan (multi, koma). Kosong = telegram_chat_id global.
 *   tgreport_blocks         CSV blok aktif
 *   tgreport_template       template custom (opsional)
 *   tgreport_compare        0/1 — sertakan blok perbandingan
 *   tgreport_show_button    0/1 — sertakan tombol "Lihat Dashboard"
 *   tgreport_notify_fail    0/1 — kirim notif ke admin saat gagal
 *   tgreport_last_run_key / _last_at / _last_status / _last_summary
 * ─────────────────────────────────────────────────────────────────────
 */

const moment = require('moment');
const logger = require('../utils/logger');

// Blok konten yang bisa dipilih. label = judul di pesan.
const BLOCKS = [
  { key: 'newcust',   label: 'Pelanggan Baru' },
  { key: 'income',    label: 'Uang Masuk' },
  { key: 'overdue',   label: 'Penunggak' },
  { key: 'topdebt',   label: 'Top Penunggak (3)' },
  { key: 'tickets',   label: 'Tiket Terbuka' },
  { key: 'devices',   label: 'Perangkat Offline' },
  { key: 'churn',     label: 'Pelanggan Berhenti' },
  { key: 'vouchers',  label: 'Voucher Terjual' },
  { key: 'deposits',  label: 'Setoran Kolektor' },
  { key: 'arpu',      label: 'ARPU' },
  { key: 'compare',   label: 'Perbandingan Periode' },
];
const DEFAULT_BLOCKS = ['newcust', 'income', 'overdue', 'tickets', 'devices'];

// Blok yang butuh data extras (churn/topOverdue/vouchers/deposits/arpu).
const EXTRA_BLOCKS = ['topdebt', 'churn', 'vouchers', 'deposits', 'arpu'];

const TG_LIMIT = 4096;

const fmtRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const arrow = (p) => p > 0 ? `▲ ${p}%` : p < 0 ? `▼ ${Math.abs(p)}%` : `▬ 0%`;

async function getSetting(key, def = '') {
  const { AppSetting } = require('../models');
  const row = await AppSetting.findOne({ where: { key } });
  return (row && row.value != null && row.value !== '') ? row.value : def;
}
async function setSetting(key, value) {
  const { AppSetting } = require('../models');
  await AppSetting.upsert({ key, value: String(value == null ? '' : value), type: 'string' });
}

async function loadSettings() {
  const { AppSetting } = require('../models');
  const { Op } = require('sequelize');
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'tgreport_%' } } });
  const raw = {};
  rows.forEach(r => { raw[r.key] = r.value; });
  return {
    enabled:       String(raw.tgreport_enabled) === '1',
    frequency:     raw.tgreport_frequency || 'daily',
    period:        raw.tgreport_period || '',   // override opsional
    hour:          parseInt(raw.tgreport_hour, 10) >= 0 ? parseInt(raw.tgreport_hour, 10) : 7,
    minute:        parseInt(raw.tgreport_minute, 10) >= 0 ? parseInt(raw.tgreport_minute, 10) : 0,
    day_of_week:   parseInt(raw.tgreport_day_of_week, 10) >= 0 ? parseInt(raw.tgreport_day_of_week, 10) : 1,
    day_of_month:  parseInt(raw.tgreport_day_of_month, 10) >= 1 ? parseInt(raw.tgreport_day_of_month, 10) : 1,
    chat_id:       raw.tgreport_chat_id || '',
    blocks:        (raw.tgreport_blocks != null && raw.tgreport_blocks !== '')
                     ? String(raw.tgreport_blocks).split(',').map(s => s.trim()).filter(Boolean)
                     : DEFAULT_BLOCKS.slice(),
    template:      raw.tgreport_template || '',
    compare:       String(raw.tgreport_compare) === '1',
    show_button:   String(raw.tgreport_show_button) === '1',
    notify_fail:   String(raw.tgreport_notify_fail) === '1',
  };
}

// Map frekuensi → periode data default.
function periodForFrequency(frequency, override) {
  if (override) return override;
  if (frequency === 'weekly')  return 'week';
  if (frequency === 'monthly') return 'month';
  return 'yesterday';
}

/**
 * Bangun teks pesan Telegram (HTML) dari data digest + pilihan blok.
 * Template custom → replace placeholder. Tanpa template → format bawaan rapi.
 */
function buildMessage(data, opts = {}) {
  const blocks = opts.blocks && opts.blocks.length ? opts.blocks : DEFAULT_BLOCKS;
  const company = opts.companyName || 'ISP';
  const has = (k) => blocks.includes(k);

  // Placeholder untuk template custom.
  const cmp = data.compare || {};
  const vars = {
    '{perusahaan}':        company,
    '{tanggal}':           data.dateLabel,
    '{periode}':           ({ yesterday: 'Harian', today: 'Hari Ini', week: 'Mingguan', month: 'Bulanan' }[data.period] || 'Harian'),
    '{pelanggan_baru}':    '+' + data.newCustomers,
    '{pelanggan_aktif}':   String(data.activeCustomers),
    '{uang_masuk}':        fmtRp(data.paymentsIn.total),
    '{jml_pembayaran}':    String(data.paymentsIn.cnt),
    '{penunggak}':         String(data.overdue.cnt),
    '{nilai_tunggakan}':   fmtRp(data.overdue.total),
    '{tiket_terbuka}':     String(data.openTickets),
    '{tiket_baru}':        String(data.newTickets),
    '{perangkat_offline}': String(data.devicesOffline),
    '{perangkat_total}':   String(data.devicesTotal),
    '{churn}':             String(data.churn != null ? data.churn : 0),
    '{voucher_terjual}':   String(data.vouchers ? data.vouchers.cnt : 0),
    '{voucher_omzet}':     fmtRp(data.vouchers ? data.vouchers.revenue : 0),
    '{setoran_jml}':       String(data.deposits ? data.deposits.cnt : 0),
    '{setoran_total}':     fmtRp(data.deposits ? data.deposits.total : 0),
    '{arpu}':              fmtRp(data.arpu || 0),
    '{income_delta}':      cmp.income ? arrow(cmp.income.pct) : '',
  };

  if (opts.template && opts.template.trim()) {
    return Object.keys(vars).reduce((acc, k) => acc.split(k).join(vars[k]), opts.template);
  }

  // Format bawaan.
  const periodLabel = { yesterday: 'Ringkasan Harian', today: 'Ringkasan Hari Ini', week: 'Ringkasan Mingguan', month: 'Ringkasan Bulanan' }[data.period] || 'Ringkasan Harian';
  const lines = [];
  lines.push(`📊 <b>${esc(periodLabel)} — ${esc(company)}</b>`);
  lines.push(`<i>${esc(data.dateLabel)}</i>`);
  lines.push('');
  if (has('newcust')) lines.push(`👥 Pelanggan baru: <b>+${data.newCustomers}</b>  (${data.activeCustomers} aktif)`);
  if (has('income'))  lines.push(`💰 Uang masuk: <b>${fmtRp(data.paymentsIn.total)}</b>  (${data.paymentsIn.cnt} bayar)`);
  if (has('arpu') && data.arpu != null) lines.push(`📈 ARPU: <b>${fmtRp(data.arpu)}</b>  / pelanggan`);
  if (has('overdue')) lines.push(`⚠️ Penunggak: <b>${data.overdue.cnt}</b> invoice  (${fmtRp(data.overdue.total)})`);
  if (has('topdebt') && Array.isArray(data.topOverdue) && data.topOverdue.length) {
    lines.push(`🔝 <b>Top penunggak:</b>`);
    data.topOverdue.forEach((t, i) => {
      lines.push(`   ${i + 1}. ${esc(t.name || '-')} — ${fmtRp(t.total)}`);
    });
  }
  if (has('churn') && data.churn != null) {
    const icon = data.churn > 0 ? '📉' : '✅';
    lines.push(`${icon} Pelanggan berhenti: <b>${data.churn}</b>`);
  }
  if (has('vouchers') && data.vouchers) {
    lines.push(`🎟️ Voucher terjual: <b>${data.vouchers.cnt}</b>  (${fmtRp(data.vouchers.revenue)})`);
  }
  if (has('deposits') && data.deposits) {
    lines.push(`🧾 Setoran kolektor: <b>${data.deposits.cnt}</b>  (${fmtRp(data.deposits.total)})`);
  }
  if (has('tickets')) lines.push(`🎫 Tiket terbuka: <b>${data.openTickets}</b>  (${data.newTickets} baru)`);
  if (has('devices')) {
    const icon = data.devicesOffline > 0 ? '🔴' : '🟢';
    lines.push(`${icon} Perangkat offline: <b>${data.devicesOffline}</b> / ${data.devicesTotal}`);
  }
  if (has('compare') && data.compare) {
    lines.push('');
    lines.push(`📐 <b>vs periode lalu</b>`);
    lines.push(`   • Uang masuk: ${arrow(data.compare.income.pct)}  (dari ${fmtRp(data.compare.income.prev)})`);
    lines.push(`   • Pembayaran: ${arrow(data.compare.payments.pct)}`);
    lines.push(`   • Pelanggan baru: ${arrow(data.compare.newcust.pct)}`);
  }

  let text = lines.join('\n');
  // Guard limit Telegram (sisakan ruang untuk footer "..dipotong").
  if (text.length > TG_LIMIT) {
    text = text.slice(0, TG_LIMIT - 40).replace(/\n[^\n]*$/, '') + '\n…(dipotong, terlalu panjang)';
  }
  return text;
}

// Susun tombol inline (deep-link dashboard) bila app_base_url diisi & valid.
async function _buildButtons() {
  let base = '';
  try { base = (await getSetting('app_base_url', '')).trim(); } catch (_) {}
  if (!/^https?:\/\//i.test(base)) return null;
  base = base.replace(/\/+$/, '');
  return [[
    { text: '📊 Lihat Dashboard', url: base + '/dashboard' },
    { text: '⚠️ Penunggak', url: base + '/billing?status=overdue' },
  ]];
}

// Kirim dengan retry (3x, backoff 0/1.5/3 dtk).
async function _sendWithRetry(sendFn) {
  let last = { ok: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    try {
      last = await sendFn();
      if (last && last.ok) return last;
      // no_token / no_chat → tak ada gunanya retry.
      if (last && (last.reason === 'no_token' || last.reason === 'no_chat')) return last;
    } catch (e) {
      last = { ok: false, error: e.message };
    }
  }
  return last;
}

/**
 * generateAndSend({ chatId?, blocks?, template?, period?, frequency?, compare?,
 *                   showButton?, source?, runKey? }) → { ok, message, data, text, results }
 */
async function generateAndSend(opts = {}) {
  const Digest = require('./DailyDigestService');
  const Telegram = require('./TelegramService');

  let companyName = 'ISP';
  try { companyName = (await require('../utils/companyInfo').getCompanyName()) || 'ISP'; } catch (_) {}

  const blocks = Array.isArray(opts.blocks) && opts.blocks.length ? opts.blocks : DEFAULT_BLOCKS;
  const period = periodForFrequency(opts.frequency || 'daily', opts.period);
  const needExtras = blocks.some(b => EXTRA_BLOCKS.includes(b));
  const needCompare = !!opts.compare || blocks.includes('compare');

  const data = await Digest.buildDigestData(period, { withExtras: needExtras, withCompare: needCompare });
  const text = buildMessage(data, { blocks, template: opts.template, companyName });

  // Tujuan: opts.chatId → tgreport_chat_id → telegram_chat_id global.
  const cfgRow = await getSetting('tgreport_chat_id', '');
  const chatId = opts.chatId || cfgRow || '';

  // Tombol (opsional).
  let buttons = null;
  if (opts.showButton) { try { buttons = await _buildButtons(); } catch (_) {} }

  const sendFn = () => buttons
    ? Telegram.sendMessageWithButtons(text, chatId, buttons)
    : Telegram.sendMessageTo(text, chatId);

  const res = await _sendWithRetry(sendFn);
  const okCount = (res.results || []).filter(r => r.ok).length;
  const total   = (res.results || []).length;

  // Catat riwayat + dedup row (best-effort).
  await _writeLog({
    source: opts.source || 'manual',
    frequency: opts.frequency || null,
    period,
    runKey: opts.runKey || null,
    chatCount: total,
    okCount,
    charLen: text.length,
    ok: !!res.ok,
    summary: res.ok ? `Terkirim ${okCount}/${total} chat · ${text.length} char` : null,
    error: res.ok ? null : (res.reason || res.error || 'Gagal mengirim'),
  });

  if (!res.ok) {
    const reason = res.reason === 'no_token' ? 'Bot token belum diisi (atur di Telegram Center)'
                 : res.reason === 'no_chat' ? 'Tujuan chat belum diisi'
                 : (res.error || 'Gagal mengirim');
    // Notifikasi balik ke admin bila diaktifkan & bukan masalah token/chat.
    if (opts.notifyFail && res.reason !== 'no_token' && res.reason !== 'no_chat') {
      try {
        await Telegram.sendMessage(`🚨 <b>Telegram Report gagal</b>\nAlasan: ${esc(reason)}\nWaktu: ${moment().format('DD/MM HH:mm')}`);
      } catch (_) {}
    }
    return { ok: false, message: reason, data, text, results: res.results || [] };
  }
  return {
    ok: true,
    message: `Report terkirim ke ${okCount}/${total} chat`,
    data, text, results: res.results,
  };
}

/**
 * previewText({ blocks?, template?, period?, frequency?, compare? }) → { text, data, charLen, overLimit }
 */
async function previewText(opts = {}) {
  const Digest = require('./DailyDigestService');
  let companyName = 'ISP';
  try { companyName = (await require('../utils/companyInfo').getCompanyName()) || 'ISP'; } catch (_) {}

  const blocks = Array.isArray(opts.blocks) && opts.blocks.length ? opts.blocks : undefined;
  const period = periodForFrequency(opts.frequency || 'daily', opts.period);
  const effBlocks = blocks || DEFAULT_BLOCKS;
  const needExtras = effBlocks.some(b => EXTRA_BLOCKS.includes(b));
  const needCompare = !!opts.compare || effBlocks.includes('compare');

  const data = await Digest.buildDigestData(period, { withExtras: needExtras, withCompare: needCompare });
  const text = buildMessage(data, { blocks, template: opts.template, companyName });
  return { text, data, charLen: text.length, overLimit: text.length > TG_LIMIT };
}

// Tulis baris ReportLog (riwayat + dedup). Tidak melempar error ke pemanggil.
async function _writeLog(o) {
  try {
    const { ReportLog } = require('../models');
    if (!ReportLog) return;
    const status = o.ok ? (o.okCount >= o.chatCount && o.chatCount > 0 ? 'sent' : (o.okCount > 0 ? 'partial' : 'sent')) : 'failed';
    await ReportLog.create({
      source: o.source || 'manual',
      frequency: o.frequency || null,
      period: o.period || null,
      run_key: o.runKey || null,
      chat_count: o.chatCount || 0,
      ok_count: o.okCount || 0,
      char_len: o.charLen || 0,
      status,
      summary: o.summary || null,
      error_message: o.error || null,
    });
  } catch (e) {
    // Duplikasi run_key (UNIQUE) = sudah terkirim oleh proses lain → aman diabaikan.
    if (!/unique|duplicate/i.test(e.message || '')) {
      logger.warn('[TGReport] writeLog gagal: ' + (e.message || e));
    }
  }
}

// Cek apakah run_key sudah ada di ReportLog (dedup lintas proses).
async function _alreadyRan(runKey) {
  try {
    const { ReportLog } = require('../models');
    if (!ReportLog) return false;
    const row = await ReportLog.findOne({ where: { run_key: runKey } });
    return !!row;
  } catch (_) { return false; }
}

// ── Scheduler tick (dipanggil CronService tiap menit) ──────────────────
async function schedulerTick() {
  try {
    const cfg = await loadSettings();
    if (!cfg.enabled) return;

    const now = moment();
    if (now.hour() !== cfg.hour || now.minute() !== cfg.minute) return;
    if (cfg.frequency === 'weekly'  && now.day()  !== cfg.day_of_week)  return;
    if (cfg.frequency === 'monthly' && now.date() !== cfg.day_of_month) return;

    // run_key granular: freq:tanggal:jam — beda jam/hari/frekuensi = slot beda.
    const runKey = `${cfg.frequency}:${now.format('YYYY-MM-DD')}:${String(cfg.hour).padStart(2, '0')}`;

    // Dedup 1: app_settings (kompat lama). Dedup 2: ReportLog (lintas proses).
    const lastKey = await getSetting('tgreport_last_run_key', '');
    if (lastKey === runKey) return;
    if (await _alreadyRan(runKey)) { await setSetting('tgreport_last_run_key', runKey); return; }

    // Tandai SEBELUM kirim untuk cegah dobel bila kirim lambat & tick berikutnya masuk.
    await setSetting('tgreport_last_run_key', runKey);

    logger.info(`[TGReport] Scheduler trigger (${cfg.frequency} ${String(cfg.hour).padStart(2, '0')}:${String(cfg.minute).padStart(2, '0')})`);
    const result = await generateAndSend({
      blocks: cfg.blocks, template: cfg.template, chatId: cfg.chat_id,
      frequency: cfg.frequency, period: cfg.period || undefined,
      compare: cfg.compare, showButton: cfg.show_button, notifyFail: cfg.notify_fail,
      source: 'schedule', runKey,
    });
    await setSetting('tgreport_last_at', new Date().toISOString());
    await setSetting('tgreport_last_status', result.ok ? 'ok' : 'failed');
    await setSetting('tgreport_last_summary', result.message);
    logger.info('[TGReport] Scheduler done: ' + result.message);
  } catch (e) {
    logger.error('[TGReport] Scheduler error: ' + (e.message || e));
  }
}

// Ambil riwayat untuk UI (tab Riwayat).
async function getHistory(limit = 20) {
  try {
    const { ReportLog } = require('../models');
    if (!ReportLog) return [];
    const rows = await ReportLog.findAll({ order: [['created_at', 'DESC']], limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100) });
    return rows.map(r => ({
      id: r.id, source: r.source, frequency: r.frequency, period: r.period,
      chat_count: r.chat_count, ok_count: r.ok_count, char_len: r.char_len,
      status: r.status, summary: r.summary, error_message: r.error_message,
      created_at: r.created_at,
    }));
  } catch (_) { return []; }
}

module.exports = {
  BLOCKS, DEFAULT_BLOCKS, EXTRA_BLOCKS, TG_LIMIT,
  loadSettings, getSetting, setSetting,
  buildMessage, generateAndSend, previewText, schedulerTick, getHistory,
  periodForFrequency,
};
