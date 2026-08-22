/**
 * MonitoringService.js — Deteksi gangguan & kirim notifikasi Telegram.
 * -------------------------------------------------------------------
 * Dijalankan berkala oleh cron. Memeriksa 3 kondisi:
 *   1. Perangkat (router/olt/switch) DOWN          → telegram_notif_device
 *   2. ONT pelanggan DISCONNECT (offline)          → telegram_notif_ont
 *   3. IP pelanggan tidak reachable / timeout      → telegram_notif_ip
 *
 * ANTI-SPAM: notifikasi hanya dikirim saat TRANSISI status
 * (online→down dan down→online/recovery), bukan tiap polling. State
 * transisi kini DIPERSIST ke DB (MonitorStateStore → tabel monitor_states),
 * sehingga survive restart: device yang down saat restart tetap memicu notif.
 * Dilengkapi flapping-guard (status harus stabil N detik), grouping (banyak
 * transisi → 1 pesan ringkas), quiet-hours (tahan recover di jam tenang), dan
 * riwayat (tabel notif_logs) — semua via MonitorNotifier.
 */

const logger = require('../utils/logger');
const Telegram = require('./TelegramService');
const Store = require('./MonitorStateStore');
const Notifier = require('./MonitorNotifier');
const { exec } = require('child_process');

// ── ICMP ping langsung dari server (independen dari SNMP) ───────────
// Dipakai agar deteksi device down/up real-time saat polling Telegram,
// tidak menunggu SNMPService meng-update kolom devices.status.
// Linux: `ping -c <count> -W <timeout> <ip>`. Return true kalau reachable.
function _icmpPing(ip, { count = 2, timeoutSec = 2 } = {}) {
  return new Promise((resolve) => {
    if (!ip) return resolve(false);
    // Validasi sederhana supaya aman dari injection (IPv4/host alfanumerik).
    if (!/^[a-zA-Z0-9_.:-]+$/.test(ip)) return resolve(false);
    const cmd = `ping -c ${count} -W ${timeoutSec} ${ip}`;
    exec(cmd, { timeout: (count * timeoutSec + 3) * 1000 }, (err, stdout) => {
      if (err) return resolve(false); // exit code != 0 → tidak ada balasan
      // Pastikan benar-benar ada paket diterima (hindari false positive)
      resolve(/(\d+) received|(\d+) packets received/.test(stdout) &&
              !/ 0 received|, 0 packets received/.test(stdout));
    });
  });
}

// State transisi sekarang dikelola MonitorStateStore (persisted ke DB).
// _baseline menandai apakah kind sudah pernah dipoll dalam proses ini; saat
// state sudah ada di DB, evaluate() tidak akan menganggapnya baseline.
let _baseline = { device: false, ont: false, ip: false, pppoe: false };

// Flapping guard (detik) per jenis — dibaca dari cfg saat runChecks.
function _flapGuard(cfg) {
  const n = parseInt(cfg && cfg.telegram_flap_guard, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Batch notifier aktif untuk siklus berjalan (di-set di runChecks).
let _batch = null;

function _fmtTime() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });
}

// Cek transisi 1 entitas via store (persisted + flapping guard).
// Return 'down' | 'recover' | null (tak berubah).
function _transition(kind, id, isDown, isBaseline, cfg) {
  return Store.evaluate(kind, id, isDown, {
    isBaseline,
    flapGuardSec: _flapGuard(cfg),
  });
}

// ── Template pesan (bisa dikustom via Settings → Telegram) ──────────
// Placeholder per jenis di-replace saat kirim. Default = format bawaan.
const TPL_DEFAULTS = {
  device_down:    '<b>PERANGKAT DOWN</b>\n\n<b>{nama}</b>\nTipe: {tipe}\nIP: <code>{ip}</code>\n{waktu}',
  device_recover: '<b>Perangkat kembali ONLINE</b>\n\n<b>{nama}</b> ({ip})\n{waktu}',
  ont_down:       '<b>ONT PELANGGAN DISCONNECT</b>\n\n<b>{nama}</b>{cid}\n{waktu}',
  ont_recover:    '<b>ONT kembali ONLINE</b>\n\n<b>{nama}</b>{cid}\n{waktu}',
  ip_down:        '<b>IP PELANGGAN TIMEOUT</b>\n\n<b>{nama}</b> ({cid})\nIP: <code>{ip}</code> tidak merespons\n{waktu}',
  ip_recover:     '<b>IP pelanggan kembali reachable</b>\n\n<b>{nama}</b> ({cid}) — <code>{ip}</code>\n{waktu}',
  pppoe_down:     '<b>PPPoE PELANGGAN DISCONNECT</b>\n\n<b>{nama}</b> ({cid})\nUser: <code>{user}</code>\n{waktu}',
  pppoe_recover:  '<b>PPPoE pelanggan kembali ONLINE</b>\n\n<b>{nama}</b> ({cid})\nUser: <code>{user}</code> — <code>{ip}</code>\n{waktu}',
};

// Render template: ambil dari cfg[telegram_tpl_<key>] kalau ada, else default.
// vars di-escape HTML supaya aman. Placeholder {x} yang tak dikenal dibiarkan.
function _renderTpl(cfg, key, vars) {
  let tpl = (cfg['telegram_tpl_' + key] || '').trim() || TPL_DEFAULTS[key] || '';
  return tpl.replace(/\{(\w+)\}/g, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return _esc(vars[name]);
    return m;
  });
}

// ── 1. Perangkat down ────────────────────────────────────────
// Ping LANGSUNG tiap device (ICMP dari server), bukan baca kolom
// devices.status — supaya deteksi real-time & tidak tergantung SNMP.
async function _checkDevices(cfg) {
  if (String(cfg.telegram_notif_device) !== '1') return;
  const { Device } = require('../models');
  const devices = await Device.findAll({
    where: { is_active: true },
    attributes: ['id', 'name', 'type', 'ip_address'],
  });
  const isBaseline = !_baseline.device;

  // Ping paralel per-chunk supaya tidak menahan event loop terlalu lama
  const chunkSize = 12;
  for (let i = 0; i < devices.length; i += chunkSize) {
    const chunk = devices.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async (d) => {
      if (!d.ip_address) return; // tanpa IP tak bisa diping → lewati
      const reachable = await _icmpPing(d.ip_address, { count: 2, timeoutSec: 2 });
      const tr = _transition('device', d.id, !reachable, isBaseline, cfg);
      if (tr === 'down') {
        _batch.add({
          kind: 'device', event: 'down', refId: d.id,
          title: d.name || ('Device #' + d.id),
          detail: (d.ip_address || '-'),
          text: _renderTpl(cfg, 'device_down', {
            nama: d.name || ('Device #' + d.id),
            tipe: (d.type || '-').toUpperCase(),
            ip: d.ip_address || '-',
            waktu: _fmtTime(),
          }),
        });
      } else if (tr === 'recover') {
        _batch.add({
          kind: 'device', event: 'recover', refId: d.id,
          title: d.name || ('Device #' + d.id),
          detail: (d.ip_address || '-'),
          text: _renderTpl(cfg, 'device_recover', {
            nama: d.name || ('Device #' + d.id),
            tipe: (d.type || '-').toUpperCase(),
            ip: d.ip_address || '-',
            waktu: _fmtTime(),
          }),
        });
      }
    }));
  }
  _baseline.device = true;
}

// ── 2. ONT pelanggan disconnect ──────────────────────────────
async function _checkOnts(cfg) {
  if (String(cfg.telegram_notif_ont) !== '1') return;
  const { OntDevice, Customer } = require('../models');
  const onts = await OntDevice.findAll({
    attributes: ['id', 'serial_number', 'model', 'status'],
    include: [{ model: Customer, as: 'customer', attributes: ['name', 'customer_id'], required: false }],
  });
  const isBaseline = !_baseline.ont;
  for (const o of onts) {
    // Hanya proses ONT yang statusnya pasti (online/offline). Status null/
    // unknown (belum pernah di-poll) dilewati supaya tidak memicu transisi palsu.
    if (o.status !== 'online' && o.status !== 'offline') continue;
    const isDown = o.status === 'offline';
    const tr = _transition('ont', o.id, isDown, isBaseline, cfg);
    const who = o.customer?.name || o.model || o.serial_number || ('ONT #' + o.id);
    const cidRaw = o.customer?.customer_id || '';
    const cidParen = cidRaw ? ' (' + cidRaw + ')' : '';
    if (tr === 'down') {
      _batch.add({
        kind: 'ont', event: 'down', refId: o.id,
        title: who, detail: cidRaw || (o.serial_number || ''),
        text: _renderTpl(cfg, 'ont_down', {
          nama: who, cid: cidParen, cid_raw: cidRaw,
          sn: o.serial_number || '-', waktu: _fmtTime(),
        }),
      });
    } else if (tr === 'recover') {
      _batch.add({
        kind: 'ont', event: 'recover', refId: o.id,
        title: who, detail: cidRaw || (o.serial_number || ''),
        text: _renderTpl(cfg, 'ont_recover', {
          nama: who, cid: cidParen, cid_raw: cidRaw,
          sn: o.serial_number || '-', waktu: _fmtTime(),
        }),
      });
    }
  }
  _baseline.ont = true;
}

// ── 3. IP pelanggan tidak reachable / timeout ────────────────
// Selaras dengan halaman Ping Monitor: ping dari sisi MikroTik (router),
// bukan dari server. Lebih akurat karena router adalah gateway pelanggan.
// Pelanggan dikelompokkan per router (mikrotik_id), ping via instance
// masing-masing; fallback ke instance default kalau mikrotik_id null.
async function _checkCustomerIps(cfg) {
  if (String(cfg.telegram_notif_ip) !== '1') return;
  const { Customer } = require('../models');
  const { Op } = require('sequelize');
  const { getMikrotikInstance, getMikrotikInstanceByDevice } = require('./MikrotikService');

  // Pelanggan aktif yang punya static_ip (sumber sama dengan Ping Monitor).
  // Pelanggan yang sedang diisolir DIKECUALIKAN — koneksinya sengaja diputus,
  // jadi unreachable-nya wajar dan tidak boleh memicu notif down palsu.
  const customers = await Customer.findAll({
    where: {
      status: 'active',
      isolir_status: 'active',
      static_ip: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
    },
    attributes: ['id', 'customer_id', 'name', 'static_ip', 'mikrotik_id'],
    limit: 500,
  });
  const isBaseline = !_baseline.ip;

  // Kelompokkan per router supaya 1 instance dipakai untuk banyak IP
  const byRouter = new Map(); // deviceId (atau 'default') → [customers]
  for (const c of customers) {
    const key = c.mikrotik_id != null ? c.mikrotik_id : 'default';
    if (!byRouter.has(key)) byRouter.set(key, []);
    byRouter.get(key).push(c);
  }

  for (const [routerKey, custList] of byRouter) {
    let mt = null;
    try {
      mt = routerKey === 'default'
        ? getMikrotikInstance()
        : await getMikrotikInstanceByDevice(routerKey);
    } catch (e) {
      // Router tak terjangkau → jangan ubah state (hindari false alarm)
      logger.warn(`[Monitoring:IP] Router ${routerKey} tak terjangkau, skip ${custList.length} IP: ${e.message}`);
      continue;
    }
    if (!mt) {
      logger.warn(`[Monitoring:IP] Instance MikroTik null utk router ${routerKey}, skip ${custList.length} IP`);
      continue;
    }

    // Ping per IP via router (chunk supaya tidak membanjiri 1 router sekaligus)
    const chunkSize = 8;
    for (let i = 0; i < custList.length; i += chunkSize) {
      const chunk = custList.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (c) => {
        let reachable = false;
        try {
          const resp = await mt.ping(c.static_ip, { count: 4, interval: '0.2' });
          reachable = _pingReachable(resp);
        } catch (e) {
          reachable = false;
          logger.debug(`[Monitoring:IP] ping ${c.static_ip} error: ${e.message}`);
        }

        const tr = _transition('ip', c.id, !reachable, isBaseline, cfg);
        if (tr) logger.info(`[Monitoring:IP] ${c.name} (${c.static_ip}) → ${tr}`);
        if (tr === 'down') {
          _batch.add({
            kind: 'ip', event: 'down', refId: c.id,
            title: c.name || ('Customer #' + c.id), detail: c.static_ip,
            text: _renderTpl(cfg, 'ip_down', {
              nama: c.name || ('Customer #' + c.id),
              cid: c.customer_id || '', ip: c.static_ip, waktu: _fmtTime(),
            }),
          });
        } else if (tr === 'recover') {
          _batch.add({
            kind: 'ip', event: 'recover', refId: c.id,
            title: c.name || ('Customer #' + c.id), detail: c.static_ip,
            text: _renderTpl(cfg, 'ip_recover', {
              nama: c.name || ('Customer #' + c.id),
              cid: c.customer_id || '', ip: c.static_ip, waktu: _fmtTime(),
            }),
          });
        }
      }));
    }
  }
  _baseline.ip = true;
}

// ── 4. PPPoE pelanggan disconnect ────────────────────────────
// Deteksi pelanggan PPPoE yang sesi-nya tidak aktif di MikroTik.
// Efisien: ambil /ppp/active SEKALI per router, bandingkan username.
// Pelanggan dikelompokkan per router (mikrotik_id); fallback ke default.
async function _checkPppoe(cfg) {
  if (String(cfg.telegram_notif_pppoe) !== '1') return;
  const { Customer } = require('../models');
  const { Op } = require('sequelize');
  const { getMikrotikInstance, getMikrotikInstanceByDevice } = require('./MikrotikService');

  // Pelanggan yang dipantau: punya pppoe_username (itu sendiri sudah menandakan
  // user PPPoE), aktif, dan TIDAK sedang diisolir. Sengaja TIDAK memfilter
  // connection_type karena field itu sering null/tidak terisi konsisten —
  // patokan utama adalah adanya username PPPoE.
  const customers = await Customer.findAll({
    where: {
      status: 'active',
      isolir_status: 'active',
      pppoe_username: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
    },
    attributes: ['id', 'customer_id', 'name', 'pppoe_username', 'mikrotik_id'],
    limit: 2000,
  });
  if (!customers.length) {
    logger.info('[Monitoring:PPPoE] Tidak ada pelanggan dengan pppoe_username aktif — skip');
    _baseline.pppoe = true;
    return;
  }
  const isBaseline = !_baseline.pppoe;

  // Kelompokkan per router
  const byRouter = new Map();
  for (const c of customers) {
    const key = c.mikrotik_id != null ? c.mikrotik_id : 'default';
    if (!byRouter.has(key)) byRouter.set(key, []);
    byRouter.get(key).push(c);
  }

  for (const [routerKey, custList] of byRouter) {
    let mt = null;
    try {
      mt = routerKey === 'default'
        ? getMikrotikInstance()
        : await getMikrotikInstanceByDevice(routerKey);
    } catch (e) {
      logger.warn(`[Monitoring:PPPoE] Router ${routerKey} tak terjangkau, skip ${custList.length} user: ${e.message}`);
      continue;
    }
    if (!mt) {
      logger.warn(`[Monitoring:PPPoE] Instance MikroTik null utk router ${routerKey}, skip ${custList.length} user`);
      continue;
    }

    // Ambil sesi PPPoE aktif SEKALI; kalau gagal, jangan ubah state (anti false alarm)
    let sessions = [];
    try {
      sessions = await mt.getPPPoESessions();
    } catch (e) {
      logger.warn(`[Monitoring:PPPoE] Gagal ambil /ppp/active router ${routerKey}: ${e.message}`);
      continue;
    }
    // Map username (lowercase) → address, untuk lookup cepat
    const online = new Map();
    for (const s of sessions) {
      if (s && s.name) online.set(String(s.name).trim().toLowerCase(), s.address || '');
    }
    logger.info(`[Monitoring:PPPoE] Router ${routerKey}: ${custList.length} pelanggan dipantau, ${online.size} sesi aktif di /ppp/active`);

    for (const c of custList) {
      const uname = String(c.pppoe_username).trim().toLowerCase();
      const isOnline = online.has(uname);
      const tr = _transition('pppoe', c.id, !isOnline, isBaseline, cfg);
      if (tr) logger.info(`[Monitoring:PPPoE] ${c.name} (${c.pppoe_username}) → ${tr}`);
      const cidRaw = c.customer_id || '';
      if (tr === 'down') {
        _batch.add({
          kind: 'pppoe', event: 'down', refId: c.id,
          title: c.name || ('Customer #' + c.id), detail: c.pppoe_username,
          text: _renderTpl(cfg, 'pppoe_down', {
            nama: c.name || ('Customer #' + c.id),
            cid: cidRaw, user: c.pppoe_username, ip: '-', waktu: _fmtTime(),
          }),
        });
      } else if (tr === 'recover') {
        _batch.add({
          kind: 'pppoe', event: 'recover', refId: c.id,
          title: c.name || ('Customer #' + c.id), detail: c.pppoe_username,
          text: _renderTpl(cfg, 'pppoe_recover', {
            nama: c.name || ('Customer #' + c.id),
            cid: cidRaw, user: c.pppoe_username,
            ip: online.get(uname) || '-', waktu: _fmtTime(),
          }),
        });
      }
    }
  }
  _baseline.pppoe = true;
}


// Menangani 3 format: (A) summary {sent,received}, (B) array per-paket +
// summary, (C) array per-paket saja. Cek status paket supaya entry "timeout"
// / "unreachable" tidak salah dihitung sebagai balasan.
function _pingReachable(raw) {
  if (!raw) return false;
  const entries = Array.isArray(raw) ? raw : [raw];

  // 1) Cari summary: entry dengan field "sent" > 0 → pakai "received"-nya
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && typeof e === 'object' && +e.sent > 0) {
      return (+e.received || 0) > 0;
    }
  }

  // 2) Fallback per-paket: hitung paket yang benar-benar reply
  let received = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const st = (e.status || '').toLowerCase();
    const rttRaw = e['response-time'] != null ? e['response-time']
                 : (e.time != null ? e.time : null);
    const isReply = st.includes('reply')
                 || (rttRaw != null && !st.includes('timeout')
                     && !st.includes('unreachable') && !st.includes('no route'));
    if (isReply && rttRaw != null) received++;
  }
  return received > 0;
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// Entry point cron — jalankan semua cek (kalau Telegram aktif).
// Lock anti-overlap: kalau satu siklus belum selesai saat cron berikutnya
// tiba (mis. banyak IP/PPPoE & interval pendek), run baru di-skip supaya
// dua run tidak mengakses _state bersamaan (race → notif dobel/hilang).
let _running = false;
async function runChecks() {
  if (_running) {
    logger.warn('[Monitoring] runChecks sebelumnya belum selesai — skip siklus ini');
    return;
  }
  _running = true;
  try {
    const cfg = await Telegram._getConfig();
    if (!Telegram.isEnabled(cfg)) {
      logger.info('[Monitoring] runChecks skip — Telegram belum aktif/terkonfigurasi');
      return;
    }
    logger.info('[Monitoring] runChecks mulai (device=' + cfg.telegram_notif_device +
      ' ont=' + cfg.telegram_notif_ont + ' ip=' + cfg.telegram_notif_ip +
      ' pppoe=' + cfg.telegram_notif_pppoe + ')');

    // Pastikan state persisted sudah dimuat (cold start tanpa server.js hook).
    if (!Store.isLoaded()) { try { await Store.load(); } catch (_) {} }

    // Batch notifier untuk siklus ini → mendukung grouping & quiet-hours.
    _batch = Notifier.createBatch(cfg);

    // Tiap cek diisolasi: kalau satu gagal (mis. error query), yang lain
    // tetap jalan supaya satu masalah tidak memblok notifikasi lainnya.
    const steps = [
      ['device', _checkDevices], ['ont', _checkOnts],
      ['ip', _checkCustomerIps], ['pppoe', _checkPppoe],
    ];
    for (const [label, fn] of steps) {
      try {
        await fn(cfg);
      } catch (e) {
        logger.error(`[Monitoring] _check${label} error: ` + (e.stack || e.message));
      }
    }

    // ── Network Health (router unreachable / CPU-RAM / interface down) ──
    // Reuse _batch yang sama → ikut grouping & quiet-hours satu siklus.
    try {
      await require('./NetworkHealthService').runChecks(cfg, _batch);
    } catch (e) {
      logger.error('[Monitoring] NetworkHealth error: ' + (e.stack || e.message));
    }

    // Kirim semua notifikasi terkumpul (individual atau grup ringkas).
    try {
      const out = await _batch.flush();
      if (out && out.sent) logger.info('[Monitoring] notif terkirim: ' + JSON.stringify(out));
    } catch (e) {
      logger.error('[Monitoring] flush notif error: ' + (e.message || e));
    } finally {
      _batch = null;
    }

    // ── Feed PPPoE CONNECT/DISCONNECT (kartu real-time) ────────────────
    // Independen dari _batch: kirim kartu sendiri. Dijalankan terakhir agar
    // tidak menahan notifikasi gangguan di atas.
    try {
      await require('./PppoeFeedService').runFeed(cfg);
    } catch (e) {
      logger.error('[Monitoring] PppoeFeed error: ' + (e.message || e));
    }

    // ── Alert ambang agregat (offline massal) ──────────────────────────
    try {
      await require('./ThresholdAlertService').runChecks(cfg);
    } catch (e) {
      logger.error('[Monitoring] ThresholdAlert error: ' + (e.message || e));
    }

    logger.info('[Monitoring] runChecks selesai');
  } catch (e) {
    logger.error('[Monitoring] runChecks error: ' + (e.stack || e.message));
  } finally {
    _running = false;
  }
}

// Trigger manual (dipanggil dari endpoint debug). RESET baseline supaya
// siklus ini benar-benar mengevaluasi transisi (bukan dianggap baseline),
// dan kembalikan ringkasan diagnostik tanpa mengandalkan log saja.
async function runChecksManual() {
  const cfg = await Telegram._getConfig();
  const enabled = Telegram.isEnabled(cfg);
  if (!enabled) {
    return { ok: false, enabled: false, message: 'Telegram belum aktif (cek token, chat_id, dan toggle aktif).' };
  }
  // Paksa evaluasi transisi pada run manual ini (state tetap dari DB).
  _baseline = { device: false, ont: false, ip: false, pppoe: false };
  Store.resetBaseline();
  try { require('./NetworkHealthService').resetBaseline(); } catch (_) {}
  const before = _running;
  if (before) return { ok: false, message: 'Pengecekan sedang berjalan, coba lagi sebentar.' };
  await runChecks();
  return {
    ok: true, enabled: true,
    message: 'runChecks dijalankan. Cek Telegram & log server untuk hasilnya.',
    toggles: {
      device: cfg.telegram_notif_device === '1',
      ont: cfg.telegram_notif_ont === '1',
      ip: cfg.telegram_notif_ip === '1',
      pppoe: cfg.telegram_notif_pppoe === '1',
    },
  };
}

// Muat state persisted saat startup (dipanggil server.js setelah model sync).
async function init() {
  try { await Store.load(); } catch (e) { logger.warn('[Monitoring] init/load gagal: ' + (e.message || e)); }
}

// Riwayat notifikasi untuk UI (tab Riwayat di /telegram).
async function getHistory(limit = 20) {
  try {
    const { NotifLog } = require('../models');
    if (!NotifLog) return [];
    const rows = await NotifLog.findAll({
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100),
    });
    return rows.map(r => ({
      id: r.id, kind: r.kind, event: r.event, ref_id: r.ref_id,
      title: r.title, detail: r.detail,
      chat_count: r.chat_count, ok_count: r.ok_count,
      status: r.status, error_message: r.error_message, created_at: r.created_at,
    }));
  } catch (_) { return []; }
}

// Kirim notifikasi CONTOH untuk satu jenis (tombol "Tes" per kartu di UI).
// kind: 'device'|'ont'|'ip'|'pppoe'. Memakai template tersimpan + data dummy.
async function sendTestNotif(kind) {
  const cfg = await Telegram._getConfig();
  if (!Telegram.isEnabled(cfg)) {
    return { ok: false, message: 'Telegram belum aktif (cek token, chat_id, dan toggle aktif).' };
  }
  const sample = {
    device: { key: 'device_down', vars: { nama: 'OLT-CORE-01', tipe: 'OLT', ip: '10.10.0.1', waktu: _fmtTime() }, title: 'OLT-CORE-01', detail: '10.10.0.1' },
    ont:    { key: 'ont_down',    vars: { nama: 'Budi Santoso', cid: ' (CUST-00123)', cid_raw: 'CUST-00123', sn: 'HWTC1234ABCD', waktu: _fmtTime() }, title: 'Budi Santoso', detail: 'CUST-00123' },
    ip:     { key: 'ip_down',     vars: { nama: 'Siti Aminah', cid: 'CUST-00456', ip: '192.168.10.20', waktu: _fmtTime() }, title: 'Siti Aminah', detail: '192.168.10.20' },
    pppoe:  { key: 'pppoe_down',  vars: { nama: 'Andi Wijaya', cid: 'CUST-00789', user: 'andi.w', ip: '-', waktu: _fmtTime() }, title: 'Andi Wijaya', detail: 'andi.w' },
  }[kind];
  if (!sample) return { ok: false, message: 'Jenis notifikasi tidak dikenal: ' + kind };

  const text = '🧪 <i>[CONTOH]</i> ' + _renderTpl(cfg, sample.key, sample.vars);
  const res = await Notifier.sendOne(cfg, {
    kind: 'test', event: 'down', refId: null, title: sample.title, detail: sample.detail, text,
  });
  return {
    ok: !!res.ok,
    message: res.ok ? `Contoh notifikasi ${kind} terkirim (${res.okCount}/${res.total} chat)` : 'Gagal mengirim contoh — cek konfigurasi.',
  };
}

module.exports = { runChecks, runChecksManual, init, getHistory, sendTestNotif, TPL_DEFAULTS };
