'use strict';

/**
 * MonitorNotifier.js
 * ─────────────────────────────────────────────────────────────────────
 * Lapisan pengiriman notifikasi monitoring dengan 3 perlindungan:
 *
 *   1. RIWAYAT      — setiap notif dicatat ke notif_logs (tab Riwayat di UI).
 *   2. QUIET HOURS  — pada jam tenang (mis. 23:00–06:00), notif "recover"
 *      (non-kritis) DITAHAN; notif "down" tetap dikirim. Diatur via app_settings:
 *        telegram_quiet_enabled  0/1
 *        telegram_quiet_start    "23:00"
 *        telegram_quiet_end      "06:00"
 *   3. GROUPING     — dalam satu siklus runChecks, bila jumlah transisi melewati
 *      ambang (telegram_group_threshold, default 5), kirim SATU pesan ringkas
 *      ("12 perangkat down") alih-alih membanjiri chat. Di bawah ambang →
 *      kirim pesan individual seperti biasa.
 *
 * Cara pakai dalam satu siklus:
 *   const batch = createBatch(cfg);
 *   batch.add({ kind, event, refId, title, detail, text });   // antrikan
 *   await batch.flush();                                       // kirim semua
 */

const Telegram = require('./TelegramService');
const logger = require('../utils/logger');

// Resolusi tujuan chat per-jenis. Bila telegram_chat_<kind> diisi → pakai itu;
// kalau kosong → fallback ke telegram_chat_id global (perilaku lama).
function _chatForKind(cfg, kind) {
  const specific = (cfg['telegram_chat_' + kind] || '').trim();
  return specific || ''; // '' → sendMessage pakai chat global
}

function _hmToMin(hm, def) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return def;
  return (parseInt(m[1], 10) % 24) * 60 + (parseInt(m[2], 10) % 60);
}

// Apakah sekarang termasuk jam tenang? Mendukung rentang lintas-tengah-malam.
function inQuietHours(cfg, now = new Date()) {
  if (String(cfg.telegram_quiet_enabled) !== '1') return false;
  const start = _hmToMin(cfg.telegram_quiet_start, 23 * 60);
  const end   = _hmToMin(cfg.telegram_quiet_end, 6 * 60);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

async function _writeLog(o) {
  try {
    const { NotifLog } = require('../models');
    if (!NotifLog) return;
    await NotifLog.create({
      kind: o.kind, event: o.event, ref_id: o.refId != null ? String(o.refId) : null,
      title: o.title || null, detail: o.detail || null,
      chat_count: o.chatCount || 0, ok_count: o.okCount || 0,
      status: o.status || 'sent', error_message: o.error || null,
    });
  } catch (e) {
    logger.debug('[MonitorNotifier] writeLog gagal: ' + (e.message || e));
  }
}

// Kirim satu pesan + catat log. event 'down'|'recover'|'summary'.
async function _send(cfg, item) {
  // Quiet hours: tahan recover (non-kritis). Down & summary tetap kirim.
  if (item.event === 'recover' && inQuietHours(cfg)) {
    await _writeLog({ ...item, chatCount: 0, okCount: 0, status: 'held' });
    return { ok: true, held: true };
  }
  const res = await _routeSend(cfg, item);
  const okCount = (res.results || []).filter(r => r.ok).length;
  const total = (res.results || []).length;
  // Ambil alasan gagal yang berarti: reason → error top-level → error per-chat
  // pertama. Tanpa ini, kegagalan semua chat hanya tercatat "gagal" (kehilangan
  // pesan asli seperti "chat not found" / "bot was blocked").
  const firstChatErr = (res.results || []).find(r => r && r.ok === false && r.error);
  const failReason = res.reason || res.error || (firstChatErr && firstChatErr.error) || 'gagal';
  await _writeLog({
    ...item,
    chatCount: total, okCount,
    status: res.ok ? 'sent' : 'failed',
    error: res.ok ? null : failReason,
  });
  return { ok: !!res.ok, okCount, total };
}

// Kirim ke chat per-jenis bila dikonfigurasi, else chat global.
async function _routeSend(cfg, item) {
  const target = _chatForKind(cfg, item.kind);
  if (target) return Telegram.sendMessageTo(item.text, target, cfg);
  return Telegram.sendMessage(item.text, cfg);
}

function createBatch(cfg) {
  const items = [];
  const threshold = (() => {
    const n = parseInt(cfg.telegram_group_threshold, 10);
    return Number.isFinite(n) && n > 0 ? n : 5;
  })();

  return {
    add(item) { items.push(item); },
    size() { return items.length; },

    async flush() {
      if (!items.length) return { sent: 0, grouped: false };

      // Pisahkan per event untuk ringkasan grouping yang rapi.
      const downs = items.filter(i => i.event === 'down');
      const recovers = items.filter(i => i.event === 'recover');

      // Di bawah ambang → kirim individual (perilaku lama).
      if (items.length < threshold) {
        let sent = 0;
        for (const it of items) {
          const r = await _send(cfg, it);
          if (r.ok && !r.held) sent++;
        }
        return { sent, grouped: false };
      }

      // Di atas/sama ambang → ringkas jadi 1–2 pesan grup.
      const KIND_LABEL = { device: 'Perangkat', ont: 'ONT', ip: 'IP', pppoe: 'PPPoE' };
      const buildSummary = (list, head, emoji) => {
        const byKind = {};
        list.forEach(i => { byKind[i.kind] = (byKind[i.kind] || 0) + 1; });
        const parts = Object.entries(byKind)
          .map(([k, n]) => `${n} ${KIND_LABEL[k] || k}`).join(', ');
        const lines = [`${emoji} <b>${head}: ${list.length}</b>`, `<i>${parts}</i>`, ''];
        list.slice(0, 15).forEach(i => {
          lines.push(`• ${i.title || i.refId || '-'}${i.detail ? ` — ${i.detail}` : ''}`);
        });
        if (list.length > 15) lines.push(`… dan ${list.length - 15} lainnya`);
        return lines.join('\n');
      };

      let sent = 0;
      if (downs.length) {
        const text = buildSummary(downs, 'Gangguan terdeteksi', '🔴');
        const r = await _send(cfg, { kind: 'summary', event: 'summary', title: `${downs.length} down`, detail: null, text });
        if (r.ok && !r.held) sent++;
      }
      if (recovers.length) {
        const text = buildSummary(recovers, 'Pulih kembali', '🟢');
        const r = await _send(cfg, { kind: 'summary', event: 'recover', title: `${recovers.length} recover`, detail: null, text });
        if (r.ok && !r.held) sent++;
      }
      return { sent, grouped: true, downCount: downs.length, recoverCount: recovers.length };
    },
  };
}

// Kirim notif tunggal langsung (mis. test per-jenis) + log.
async function sendOne(cfg, item) {
  return _send(cfg, item);
}

module.exports = { createBatch, inQuietHours, sendOne };
