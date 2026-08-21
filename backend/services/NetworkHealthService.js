'use strict';

/**
 * NetworkHealthService.js — Monitoring kesehatan INFRASTRUKTUR INTI ke Telegram.
 * ─────────────────────────────────────────────────────────────────────────────
 * Melengkapi blind-spot MonitoringService (yang fokus ke pelanggan: ONT/IP/PPPoE).
 * Tiga cek baru, semuanya transition-based (anti-spam) lewat MonitorStateStore +
 * MonitorNotifier — jadi otomatis dapat flapping-guard, grouping, quiet-hours,
 * riwayat (notif_logs), dan per-jenis chat routing seperti monitoring lama.
 *
 *   1. ROUTER UNREACHABLE / API GAGAL  → telegram_notif_router
 *      Router (devices.type='router', is_active) di-ping ICMP dari server +
 *      cek apakah API MikroTik bisa diakses. Ini event PALING KRITIS: kalau
 *      router gateway tumbang, semua pelanggan di bawahnya ikut down. Sebelumnya
 *      monitoring hanya `continue` diam-diam saat router tak terjangkau.
 *
 *   2. BEBAN ROUTER (CPU / RAM) TINGGI → telegram_notif_resource
 *      Ambil /system/resource tiap router (REUSE getSystemResource()). Alert saat
 *      CPU ≥ ambang (telegram_cpu_threshold, default 90%) atau RAM terpakai ≥
 *      ambang (telegram_mem_threshold, default 90%). Transisi naik→turun memicu
 *      "pulih". Hysteresis: dianggap pulih saat turun ≥10% di bawah ambang biar
 *      tidak kedip di sekitar nilai ambang.
 *
 *   3. INTERFACE / UPLINK DOWN         → telegram_notif_iface
 *      Cek per-interface (running=false padahal enabled) untuk interface yang
 *      DIPANTAU. Berguna saat uplink/trunk putus tapi router masih hidup —
 *      tidak terdeteksi oleh ping device. Default hanya pantau interface yang
 *      comment-nya mengandung kata kunci (telegram_iface_keywords, default
 *      "uplink,trunk,backhaul,wan") supaya tidak banjir oleh ratusan pppoe-*.
 *      Bila telegram_iface_all=1, semua ether/sfp/vlan fisik dipantau.
 *
 * Toggle & ambang disimpan di app_settings (di-load via TelegramService._getConfig
 * yang mengambil semua key `telegram_%`). Template pesan bisa dikustom dengan
 * key telegram_tpl_<event> (lihat TPL_DEFAULTS); kalau kosong pakai default.
 *
 * Dipanggil dari MonitoringService.runChecks() dengan meneruskan `cfg` dan
 * `batch` (Notifier) yang sama, agar semua transisi dalam satu siklus ikut
 * grouping & quiet-hours bersama monitoring pelanggan.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');
const Store = require('./MonitorStateStore');
const { exec } = require('child_process');

// Penanda baseline per-kind (per proses). Saat true, transisi pertama tidak
// memicu notif — selaras dengan _baseline di MonitoringService.
let _baseline = { router: false, resource: false, iface: false };

function resetBaseline() { _baseline = { router: false, resource: false, iface: false }; }

const _esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function _fmtTime() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });
}

function _flapGuard(cfg) {
  const n = parseInt(cfg && cfg.telegram_flap_guard, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function _transition(kind, id, isDown, isBaseline, cfg) {
  return Store.evaluate(kind, id, isDown, { isBaseline, flapGuardSec: _flapGuard(cfg) });
}

// ── Template default (bisa dikustom via telegram_tpl_<key>) ────────────────
const TPL_DEFAULTS = {
  router_down:      '<b>ROUTER TIDAK TERJANGKAU</b>\n\n<b>{nama}</b>\nIP: <code>{ip}</code>\nMasalah: {alasan}\nPelanggan di bawah router ini kemungkinan ikut terganggu.\n{waktu}',
  router_recover:   '<b>Router kembali ONLINE</b>\n\n<b>{nama}</b> ({ip})\n{waktu}',
  resource_down:    '<b>BEBAN ROUTER TINGGI</b>\n\n<b>{nama}</b> ({ip})\nCPU: <b>{cpu}%</b> · RAM: <b>{mem}%</b>\nPemicu: {pemicu}\n{waktu}',
  resource_recover: '<b>Beban router kembali normal</b>\n\n<b>{nama}</b>\nCPU: {cpu}% · RAM: {mem}%\n{waktu}',
  iface_down:       '<b>INTERFACE DOWN</b>\n\nRouter: <b>{router}</b>\nInterface: <code>{iface}</code>{komentar}\n{waktu}',
  iface_recover:    '<b>Interface kembali UP</b>\n\nRouter: <b>{router}</b>\nInterface: <code>{iface}</code>\n{waktu}',
};

function _renderTpl(cfg, key, vars) {
  let tpl = (cfg['telegram_tpl_' + key] || '').trim() || TPL_DEFAULTS[key] || '';
  return tpl.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? _esc(vars[name]) : m);
}

// ── ICMP ping dari server (sama gaya dengan MonitoringService) ─────────────
function _icmpPing(ip, { count = 2, timeoutSec = 2 } = {}) {
  return new Promise((resolve) => {
    if (!ip || !/^[a-zA-Z0-9_.:-]+$/.test(ip)) return resolve(false);
    exec(`ping -c ${count} -W ${timeoutSec} ${ip}`, { timeout: (count * timeoutSec + 3) * 1000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/(\d+) received|(\d+) packets received/.test(stdout) &&
              !/ 0 received|, 0 packets received/.test(stdout));
    });
  });
}

// Ambil daftar router aktif dari tabel devices.
async function _activeRouters() {
  const { Device } = require('../models');
  return Device.findAll({
    where: { type: 'router', is_active: true },
    attributes: ['id', 'name', 'ip_address'],
    order: [['id', 'ASC']],
  });
}

// ── 1. Router unreachable / API gagal ──────────────────────────────────────
async function _checkRouters(cfg, batch) {
  if (String(cfg.telegram_notif_router) !== '1') return;
  const { getMikrotikInstanceByDevice } = require('./MikrotikService');
  const routers = await _activeRouters();
  const isBaseline = !_baseline.router;

  for (const d of routers) {
    if (!d.ip_address) continue;

    // Down bila: ICMP gagal ATAU API tidak bisa diakses (getSystemResource gagal).
    let reachable = await _icmpPing(d.ip_address, { count: 2, timeoutSec: 2 });
    let reason = 'ICMP tidak merespons';
    if (reachable) {
      // Ping OK → pastikan API juga hidup (deteksi router "setengah mati":
      // OS hidup tapi service API mati / kredensial salah).
      try {
        const mt = await getMikrotikInstanceByDevice(d.id);
        await mt.getSystemResource();
        reason = '';
      } catch (e) {
        reachable = false;
        reason = 'API MikroTik gagal diakses';
      }
    }

    const tr = _transition('router', d.id, !reachable, isBaseline, cfg);
    if (tr === 'down') {
      batch.add({
        kind: 'router', event: 'down', refId: d.id,
        title: d.name || ('Router #' + d.id), detail: d.ip_address,
        text: _renderTpl(cfg, 'router_down', {
          nama: d.name || ('Router #' + d.id), ip: d.ip_address,
          alasan: reason || 'tidak terjangkau', waktu: _fmtTime(),
        }),
      });
    } else if (tr === 'recover') {
      batch.add({
        kind: 'router', event: 'recover', refId: d.id,
        title: d.name || ('Router #' + d.id), detail: d.ip_address,
        text: _renderTpl(cfg, 'router_recover', {
          nama: d.name || ('Router #' + d.id), ip: d.ip_address, waktu: _fmtTime(),
        }),
      });
    }
  }
  _baseline.router = true;
}

// ── 2. Beban router (CPU/RAM) tinggi ───────────────────────────────────────
async function _checkResources(cfg, batch) {
  if (String(cfg.telegram_notif_resource) !== '1') return;
  const { getMikrotikInstanceByDevice } = require('./MikrotikService');

  const cpuTh = (() => { const n = parseInt(cfg.telegram_cpu_threshold, 10); return Number.isFinite(n) && n > 0 && n <= 100 ? n : 90; })();
  const memTh = (() => { const n = parseInt(cfg.telegram_mem_threshold, 10); return Number.isFinite(n) && n > 0 && n <= 100 ? n : 90; })();
  // Hysteresis: dianggap pulih saat turun ke (ambang - margin) supaya tidak kedip.
  const margin = 10;

  const routers = await _activeRouters();
  const isBaseline = !_baseline.resource;

  for (const d of routers) {
    let r = null;
    try {
      const mt = await getMikrotikInstanceByDevice(d.id);
      r = await mt.getSystemResource();
    } catch (e) {
      // Router tak terjangkau → jangan ubah state resource (sudah ditangani _checkRouters)
      continue;
    }
    if (!r) continue;

    const cpu = Math.round(r.cpuLoad || 0);
    const total = r.totalMemory || 0;
    const free = r.freeMemory || 0;
    const memPct = total > 0 ? Math.round(((total - free) / total) * 100) : 0;

    // Status "down" (= beban tinggi) bila salah satu lampaui ambang.
    // Untuk recover, pakai ambang - margin (hysteresis) → cek manual lewat
    // pending state di store kurang pas, jadi kita tentukan isHigh di sini.
    const isHigh = (cpu >= cpuTh) || (memPct >= memTh);
    const isNormal = (cpu <= cpuTh - margin) && (memPct <= memTh - margin);

    // Hanya evaluasi transisi saat kondisi jelas (high atau normal). Zona abu-abu
    // (antara ambang-margin dan ambang) → biarkan state apa adanya (tidak evaluasi)
    // supaya hysteresis bekerja.
    let isDown;
    if (isHigh) isDown = true;
    else if (isNormal) isDown = false;
    else continue; // zona abu-abu, skip evaluasi

    const triggers = [];
    if (cpu >= cpuTh) triggers.push(`CPU ${cpu}% ≥ ${cpuTh}%`);
    if (memPct >= memTh) triggers.push(`RAM ${memPct}% ≥ ${memTh}%`);

    const tr = _transition('resource', d.id, isDown, isBaseline, cfg);
    if (tr === 'down') {
      batch.add({
        kind: 'resource', event: 'down', refId: d.id,
        title: d.name || ('Router #' + d.id), detail: `CPU ${cpu}% RAM ${memPct}%`,
        text: _renderTpl(cfg, 'resource_down', {
          nama: d.name || ('Router #' + d.id), ip: d.ip_address || '-',
          cpu, mem: memPct, pemicu: triggers.join(' · ') || 'beban tinggi', waktu: _fmtTime(),
        }),
      });
    } else if (tr === 'recover') {
      batch.add({
        kind: 'resource', event: 'recover', refId: d.id,
        title: d.name || ('Router #' + d.id), detail: `CPU ${cpu}% RAM ${memPct}%`,
        text: _renderTpl(cfg, 'resource_recover', {
          nama: d.name || ('Router #' + d.id), ip: d.ip_address || '-',
          cpu, mem: memPct, waktu: _fmtTime(),
        }),
      });
    }
  }
  _baseline.resource = true;
}

// ── 3. Interface / uplink down ─────────────────────────────────────────────
function _ifaceKeywords(cfg) {
  const raw = (cfg.telegram_iface_keywords || 'uplink,trunk,backhaul,wan').trim();
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Apakah interface ini termasuk yang dipantau?
function _ifaceMonitored(cfg, iface, keywords) {
  if (iface.disabled) return false;                 // interface sengaja dimatikan → abaikan
  const name = (iface.name || '').toLowerCase();
  const comment = (iface.comment || '').toLowerCase();
  // Jangan pantau virtual PPPoE/queue/dll yang muncul-hilang per sesi pelanggan.
  if (/^(<pppoe|pppoe-|<l2tp|l2tp-|<pptp|pptp-|<ovpn|ovpn-|<sstp|sstp-)/.test(name)) return false;

  if (String(cfg.telegram_iface_all) === '1') {
    // Mode "semua": batasi ke interface fisik/logis stabil.
    return /^(ether|sfp|combo|vlan|bridge|bonding|wlan)/.test(iface.type || '') ||
           /^(ether|sfp|combo|vlan|bridge|bonding|wlan)/.test(name);
  }
  // Mode default: hanya yang nama/komentarnya cocok kata kunci.
  return keywords.some(k => name.includes(k) || comment.includes(k));
}

async function _checkInterfaces(cfg, batch) {
  if (String(cfg.telegram_notif_iface) !== '1') return;
  const { getMikrotikInstanceByDevice } = require('./MikrotikService');
  const keywords = _ifaceKeywords(cfg);
  const routers = await _activeRouters();
  const isBaseline = !_baseline.iface;

  for (const d of routers) {
    let ifaces = [];
    try {
      const mt = await getMikrotikInstanceByDevice(d.id);
      ifaces = await mt.getInterfaces();
    } catch (e) {
      continue; // router tak terjangkau → skip (ditangani _checkRouters)
    }

    for (const iface of (ifaces || [])) {
      if (!_ifaceMonitored(cfg, iface, keywords)) continue;
      // refId unik per (router, interface). running=false → down.
      const refId = `${d.id}:${iface.name}`;
      const isDown = iface.running === false;
      const tr = _transition('iface', refId, isDown, isBaseline, cfg);
      const komentar = iface.comment ? ` (${iface.comment})` : '';
      if (tr === 'down') {
        batch.add({
          kind: 'iface', event: 'down', refId,
          title: `${d.name} · ${iface.name}`, detail: iface.comment || iface.name,
          text: _renderTpl(cfg, 'iface_down', {
            router: d.name || ('Router #' + d.id), iface: iface.name,
            komentar, waktu: _fmtTime(),
          }),
        });
      } else if (tr === 'recover') {
        batch.add({
          kind: 'iface', event: 'recover', refId,
          title: `${d.name} · ${iface.name}`, detail: iface.comment || iface.name,
          text: _renderTpl(cfg, 'iface_recover', {
            router: d.name || ('Router #' + d.id), iface: iface.name, waktu: _fmtTime(),
          }),
        });
      }
    }
  }
  _baseline.iface = true;
}

/**
 * runChecks(cfg, batch) — dipanggil dari MonitoringService dalam siklus yang sama.
 * Tiap cek diisolasi: error di satu cek tidak memblok yang lain.
 */
async function runChecks(cfg, batch) {
  const steps = [
    ['Router', _checkRouters],
    ['Resource', _checkResources],
    ['Interface', _checkInterfaces],
  ];
  for (const [label, fn] of steps) {
    try {
      await fn(cfg, batch);
    } catch (e) {
      logger.error(`[NetHealth] _check${label} error: ` + (e.stack || e.message));
    }
  }
}

// Kirim contoh notifikasi (tombol "Tes" per kartu di UI). kind: router|resource|iface
async function sendTestNotif(kind) {
  const Telegram = require('./TelegramService');
  const Notifier = require('./MonitorNotifier');
  const cfg = await Telegram._getConfig();
  if (!Telegram.isEnabled(cfg)) {
    return { ok: false, message: 'Telegram belum aktif (cek token, chat_id, dan toggle aktif).' };
  }
  const sample = {
    router:   { key: 'router_down',   vars: { nama: 'RB-CORE-01', ip: '10.0.0.1', alasan: 'ICMP tidak merespons', waktu: _fmtTime() }, title: 'RB-CORE-01', detail: '10.0.0.1' },
    resource: { key: 'resource_down', vars: { nama: 'RB-CORE-01', ip: '10.0.0.1', cpu: 96, mem: 88, pemicu: 'CPU 96% ≥ 90%', waktu: _fmtTime() }, title: 'RB-CORE-01', detail: 'CPU 96%' },
    iface:    { key: 'iface_down',    vars: { router: 'RB-CORE-01', iface: 'sfp-sfpplus1', komentar: ' (Uplink Upstream)', waktu: _fmtTime() }, title: 'RB-CORE-01 · sfp-sfpplus1', detail: 'Uplink Upstream' },
  }[kind];
  if (!sample) return { ok: false, message: 'Jenis notifikasi tidak dikenal: ' + kind };

  const text = '<i>[CONTOH]</i> ' + _renderTpl(cfg, sample.key, sample.vars);
  const res = await Notifier.sendOne(cfg, {
    kind, event: 'down', refId: null, title: sample.title, detail: sample.detail, text,
  });
  return {
    ok: !!res.ok,
    message: res.ok ? `Contoh notifikasi ${kind} terkirim (${res.okCount}/${res.total} chat)` : 'Gagal mengirim contoh — cek konfigurasi.',
  };
}

module.exports = { runChecks, resetBaseline, sendTestNotif, TPL_DEFAULTS };
