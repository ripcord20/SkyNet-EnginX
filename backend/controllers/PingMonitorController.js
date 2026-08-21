/**
 * PingMonitorController.js
 *
 * Logic improvements:
 * - Per-IP STATE MACHINE: unknown → up/down dengan konfirmasi
 * - DOWN dikonfirmasi setelah CONFIRM_DOWN scan berturut gagal (anti false-positive)
 * - UP langsung saat 1 packet reply (recovery cepat)
 * - Riwayat RTT 10 hasil → avg latency lebih stabil
 * - Satu axios ping-client per-module, bukan per-call
 * - Semaphore concurrency bukan chunk (lebih efisien)
 * - Sync pakai bulk query + in-memory index, bukan N×DB queries
 */

"use strict";

const { getMikrotikInstance, getMikrotikInstanceByDevice } = require("../services/MikrotikService");
const { Customer, Package }   = require("../models");
const { Op }                  = require("sequelize");
const logger                  = require("../utils/logger");
const axios                   = require("axios");
const https                   = require("https");

// ── Helper: resolve device_id dari query/header ──────────────
// Pattern sama dengan PPPoEController — frontend kirim ?device_id=N atau
// header X-Device-Id. Kalau tidak ada → null (fallback ke primary device).
function resolveDeviceId(req) {
  const q = req?.query?.device_id;
  const h = req?.headers?.['x-device-id'];
  const v = q || h;
  return v ? parseInt(v) : null;
}
// getMt SELALU async — getMikrotikInstanceByDevice() return Promise, sedangkan
// getMikrotikInstance() return langsung. Kita normalisasi jadi semuanya
// awaitable supaya caller tidak salah pakai (Promise.get != function).
async function getMt(req) {
  const id = resolveDeviceId(req);
  return id ? await getMikrotikInstanceByDevice(id) : getMikrotikInstance();
}

// ── Konstanta ─────────────────────────────────────────────────
const PING_COUNT     = 4;     // packet per probe
const PING_INTERVAL  = "0.2"; // detik antar packet
const PING_TIMEOUT   = 15000; // ms timeout HTTP ke MikroTik
const CONFIRM_DOWN   = 2;     // butuh N scan gagal berturut untuk DOWN
const RTT_HISTORY    = 10;    // simpan N hasil RTT terakhir
const CONCURRENCY    = 4;     // max parallel probe ke MikroTik

// ── State store per-IP ────────────────────────────────────────
// ip → { status, consecutiveFail, consecutiveOk, rttHistory,
//         loss, sent, received, lastCheck, downSince, upSince }
const ipState = new Map();

function getIpState(ip) {
  if (!ipState.has(ip)) {
    ipState.set(ip, {
      status:          "unknown",
      consecutiveFail: 0,
      consecutiveOk:   0,
      rttHistory:      [],
      loss:            0,
      sent:            0,
      received:        0,
      lastCheck:       null,
      downSince:       null,
      upSince:         null,
    });
  }
  return ipState.get(ip);
}

// ── Satu ping-client per module ───────────────────────────────
// ── Ping client cache per device ──────────────────────────────
// Axios instance untuk hit /tool/ping di MikroTik. Cache per-device supaya
// user bisa switch antar router tanpa hot-reload backend. Kalau MikroTik
// instance hilang dari pool (mis. config update), client juga di-reset.
const _pingClients = new Map(); // key = deviceId|'_primary'

async function getPingClient(req) {
  // Kembalikan instance MikrotikService (punya .ping() yang transport-aware).
  // Tidak lagi pakai axios REST — supaya router API-PLAIN (native) bekerja benar.
  const mt = await getMt(req);
  if (!mt) throw new Error('MikroTik instance not available for device');
  return mt;
}

function resetPingClient(deviceId) {
  if (deviceId === undefined || deviceId === null) {
    _pingClients.clear();
  } else {
    _pingClients.delete(deviceId || '_primary');
  }
}

// ── Parse response RouterOS /tool/ping ────────────────────────
// Format A: aggregate  { sent, received, avg-rtt, ... }
// Format B: array [ per-packet ..., summary ]
// Format C: array per-packet saja (tanpa summary)
function parseResponse(raw) {
  if (!raw) return null;
  const entries = Array.isArray(raw) ? raw : [raw];

  // Cari summary (entry dengan field "sent" bernilai angka)
  let summary = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && typeof e === "object" && +e.sent > 0) { summary = e; break; }
  }

  if (summary) {
    return {
      sent:     +summary.sent     || PING_COUNT,
      received: +summary.received || 0,
      rtt:      parseRtt(summary["avg-rtt"] || summary["avg-rtt-ms"] || "0"),
    };
  }

  // Fallback: hitung dari per-packet (REST: response-time / native: time)
  let received = 0, rttSum = 0, rttN = 0;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const st = (e.status || "").toLowerCase();
    const rttRaw = e["response-time"] != null ? e["response-time"]
                 : (e.time != null ? e.time : null);
    // Paket sukses: ada status "reply" / ada response-time / ada time tanpa status error
    const isReply = st.includes("reply")
                 || (rttRaw != null && !st.includes("timeout") && !st.includes("unreachable") && !st.includes("no route"));
    if (isReply && rttRaw != null) {
      received++;
      const rt = parseRtt(rttRaw);
      if (rt > 0) { rttSum += rt; rttN++; }
    }
  }
  return {
    sent:     Math.max(entries.filter(e => e && typeof e === "object").length, received, PING_COUNT),
    received,
    rtt:      rttN > 0 ? rttSum / rttN : 0,
  };
}

// Normalisasi RTT ke ms: "1.5ms" → 1.5 | "1500us" → 1.5 | "1.5" → 1.5
function parseRtt(raw) {
  const s = String(raw || "0");
  const n = parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
  return s.includes("us") ? n / 1000 : n;
}

// ── Probe satu IP + update state machine ─────────────────────
// pingClient di-pass dari caller supaya bisa pakai client yang sesuai
// dengan device yang dipilih user.
async function probeIP(ip, pingClient) {
  const s   = getIpState(ip);
  const now = new Date().toISOString();

  let probe;
  try {
    // pingClient di sini adalah instance MikrotikService (mt), bukan axios.
    // mt.ping() memakai transport yang benar (native API-PLAIN / REST otomatis),
    // sehingga router yang pakai API-PLAIN tidak lagi salah dibaca DOWN.
    const resp = await pingClient.ping(ip, { count: PING_COUNT, interval: PING_INTERVAL });
    probe = parseResponse(resp);
  } catch (err) {
    logger.debug(`PingMonitor probe ${ip}: ${err.message}`);
    probe = { sent: PING_COUNT, received: 0, rtt: 0 };
  }

  if (!probe) probe = { sent: PING_COUNT, received: 0, rtt: 0 };

  const reachable = probe.received > 0;

  // Update RTT history
  if (reachable && probe.rtt > 0) {
    s.rttHistory.push(probe.rtt);
    if (s.rttHistory.length > RTT_HISTORY) s.rttHistory.shift();
  }

  // State transitions
  if (reachable) {
    s.consecutiveFail = 0;
    s.consecutiveOk++;
    if (s.status !== "up") {
      logger.info(`PingMonitor: ${ip} UP (was ${s.status})`);
      s.status    = "up";
      s.upSince   = now;
      s.downSince = null;
    }
  } else {
    s.consecutiveOk   = 0;
    s.consecutiveFail++;
    // DOWN hanya dikonfirmasi setelah CONFIRM_DOWN kali berturut
    if (s.consecutiveFail >= CONFIRM_DOWN && s.status !== "down") {
      logger.info(`PingMonitor: ${ip} DOWN (${s.consecutiveFail}x fail)`);
      s.status    = "down";
      s.downSince = now;
      s.upSince   = null;
    }
  }

  s.sent      = probe.sent;
  s.received  = probe.received;
  s.loss      = probe.sent > 0 ? Math.round((1 - probe.received / probe.sent) * 100) : 100;
  s.lastCheck = now;

  return toResult(ip, s);
}

// Bangun objek result dari state
function toResult(ip, s) {
  const avgRtt = s.rttHistory.length > 0
    ? s.rttHistory.reduce((a, b) => a + b, 0) / s.rttHistory.length
    : 0;

  // Saat masih "unknown" tapi sudah pernah di-probe, tentukan dari fail/ok
  const displayStatus = s.status === "unknown" && s.lastCheck
    ? (s.consecutiveFail > 0 ? "down" : "up")
    : s.status;

  return {
    status:          displayStatus,
    latency:         +avgRtt.toFixed(1),
    latencyLast:     s.rttHistory.length ? +s.rttHistory[s.rttHistory.length - 1].toFixed(1) : 0,
    loss:            s.loss,
    sent:            s.sent,
    received:        s.received,
    consecutiveFail: s.consecutiveFail,
    downSince:       s.downSince,
    upSince:         s.upSince,
    lastCheck:       s.lastCheck,
  };
}

// ── Probe batch dengan semaphore (bukan chunking) ─────────────
// Semaphore lebih efisien: slot langsung diisi setelah selesai,
// tidak menunggu seluruh chunk selesai sebelum lanjut.
function probeBatch(ips, pingClient) {
  return new Promise((resolve) => {
    const results = {};
    let idx = 0, active = 0;

    function next() {
      if (idx >= ips.length && active === 0) { resolve(results); return; }
      while (active < CONCURRENCY && idx < ips.length) {
        const ip = ips[idx++];
        active++;
        probeIP(ip, pingClient)
          .then(r  => { results[ip] = r; })
          .catch(() => { results[ip] = toResult(ip, getIpState(ip)); })
          .finally(() => { active--; next(); });
      }
    }
    next();
  });
}

// ════════════════════════════════════════════════════════════════
// Endpoints
// ════════════════════════════════════════════════════════════════

// GET /api/ping-monitor/customers
// ── Auto-sync throttle ────────────────────────────────────────
// Auto-sync triggered oleh frontend (GET /customers?autoSync=1) tidak boleh
// jalan setiap reload. 60 detik window cukup untuk capture PPPoE/queue change
// tanpa hammering MikroTik.
let _lastAutoSyncAt = 0;
const AUTO_SYNC_THROTTLE_MS = 60 * 1000;

// In-memory cache untuk PPPoE active sessions — diisi oleh syncFromMikrotik
// dan dipakai getCustomers untuk enrich IP customer yang PPPoE-only.
// PER-DEVICE: cache di-key by deviceId supaya tidak salah enrich ketika
// user switch ke device lain (PPPoE sessions di Mikrotik A beda dengan B).
// { deviceId → { cache: Map<username,ip>, at: timestamp } } | '_primary' untuk default
const _pppoeActiveByDevice = new Map();
function _getPppoeCache(req) {
  const key = resolveDeviceId(req) || '_primary';
  if (!_pppoeActiveByDevice.has(key)) {
    _pppoeActiveByDevice.set(key, { cache: null, at: 0 });
  }
  return _pppoeActiveByDevice.get(key);
}

// ARP cache per device — untuk verify static IP customer benar2 berada di
// router terpilih (bukan router lain). Routerboard yg tidak punya route ke
// subnet customer = ARP empty untuk IP itu = customer bukan punya router ini.
const _arpByDevice = new Map();
function _getArpCache(req) {
  const key = resolveDeviceId(req) || '_primary';
  if (!_arpByDevice.has(key)) {
    _arpByDevice.set(key, { cache: null, at: 0 });
  }
  return _arpByDevice.get(key);
}

exports.getCustomers = async (req, res) => {
  try {
    // 1) Auto-sync (opsional, lewat ?autoSync=1) — silently best-effort
    //    Tidak blok response kalau MikroTik error.
    if (req.query.autoSync === "1") {
      const now = Date.now();
      if (now - _lastAutoSyncAt >= AUTO_SYNC_THROTTLE_MS) {
        _lastAutoSyncAt = now;
        try { await _runSync(req); }
        catch (e) { logger.warn("PingMonitor auto-sync gagal: " + e.message); }
      }
    }

    // 2) Refresh PPPoE active + ARP cache (untuk enrich IP & validasi router).
    //    Stale lebih dari 60 dtk → refresh; gagal → biarkan cache lama / null.
    //    Per-device cache: tidak mencampur antar router.
    const pppoeState = _getPppoeCache(req);
    const arpState   = _getArpCache(req);
    if (Date.now() - pppoeState.at > 60 * 1000) {
      try {
        const mt = await getMt(req);
        // Parallel fetch — PPPoE active + ARP table dari router yg sama
        const [pppoeList, arpList] = await Promise.allSettled([
          mt.get("/ppp/active"),
          mt.get("/ip/arp"),
        ]);

        // PPPoE cache
        const pCache = new Map();
        if (pppoeList.status === "fulfilled" && Array.isArray(pppoeList.value)) {
          pppoeList.value.forEach(s => {
            const u = (s.name || "").toLowerCase();
            if (u && s.address) pCache.set(u, s.address);
          });
        }
        pppoeState.cache = pCache;
        pppoeState.at    = Date.now();

        // ARP cache — set of IP yg ada di tabel ARP (artinya ada di L2 router ini)
        const aCache = new Set();
        if (arpList.status === "fulfilled" && Array.isArray(arpList.value)) {
          arpList.value.forEach(a => {
            if (a.address && /^\d+\.\d+\.\d+\.\d+$/.test(a.address)) {
              aCache.add(a.address);
            }
          });
        }
        arpState.cache = aCache;
        arpState.at    = Date.now();
      } catch (_) {
        // MikroTik tak terjangkau; biarkan cache lama dipakai (atau null).
      }
    }

    // 3) Query customer: filter PER-DEVICE.
    //    Logic:
    //      - Kalau user pilih device tertentu (deviceId != null) → hanya
    //        ambil customer dengan mikrotik_id = deviceId.
    //      - Tetap include customer yang mikrotik_id-nya NULL TAPI username
    //        PPPoE-nya muncul di sesi aktif device terpilih (self-healing:
    //        data lama yang belum di-tag akan auto-di-tag di akhir).
    //      - Kalau deviceId null (mode primary/legacy) → tampilkan semua
    //        seperti perilaku lama (backward compatible).
    const deviceId = resolveDeviceId(req);

    // Build WHERE clause
    const baseWhere = {
      status: { [Op.in]: ["active", "isolated"] },
      [Op.or]: [
        { static_ip:      { [Op.and]: [{ [Op.not]: null }, { [Op.ne]: "" }] } },
        { pppoe_username: { [Op.and]: [{ [Op.not]: null }, { [Op.ne]: "" }] } },
      ],
    };

    if (deviceId) {
      // Customer yang sudah di-tag ke device ini ATAU belum punya tag
      // (mikrotik_id NULL) — yang NULL akan kita filter lagi pakai PPPoE/ARP
      // di tahap selanjutnya supaya tidak salah tampil di router lain.
      baseWhere[Op.and] = [{
        [Op.or]: [
          { mikrotik_id: deviceId },
          { mikrotik_id: null },
        ],
      }];
    }

    const rows = await Customer.findAll({
      where: baseWhere,
      include: [{
        model:      Package,
        as:         "package",
        attributes: ["name", "speed_down", "speed_up"],
        required:   false,
      }],
      attributes: ["id","customer_id","name","static_ip","status",
                   "pppoe_username","address","package_id","mikrotik_id"],
      order: [["name", "ASC"]],
    });

    // 3.5) Filter pelanggan dengan mikrotik_id NULL: hanya masukkan kalau
    //      PPPoE username-nya benar2 ada di sesi aktif device terpilih,
    //      ATAU static_ip-nya muncul di ARP table device terpilih.
    //      Sekaligus self-healing: auto-update mikrotik_id customer tsb
    //      supaya request berikutnya lebih cepat (tidak perlu match lagi).
    const filtered = [];
    const healingUpdates = []; // { id, deviceId } untuk batch update di belakang

    for (const c of rows) {
      // Customer sudah di-tag device ini → langsung masuk
      if (c.mikrotik_id === deviceId) {
        filtered.push(c);
        continue;
      }
      // Kalau deviceId null (mode legacy) → semua masuk
      if (!deviceId) {
        filtered.push(c);
        continue;
      }
      // Customer NULL tag → cek 2 sumber:
      //   (a) PPPoE active match → user PPPoE customer ini
      //   (b) Static IP muncul di ARP table → router ini punya L2 reach ke IP itu
      // Tanpa cache (router unreachable) → SKIP supaya tidak muncul di router salah.
      if (c.mikrotik_id == null) {
        let belongsHere = false;

        // (a) Cek PPPoE active
        if (c.pppoe_username && pppoeState.cache) {
          const uname = c.pppoe_username.toLowerCase();
          if (pppoeState.cache.has(uname)) belongsHere = true;
        }

        // (b) Cek ARP table untuk static IP
        if (!belongsHere && c.static_ip && arpState.cache) {
          if (arpState.cache.has(c.static_ip)) belongsHere = true;
        }

        if (belongsHere) {
          filtered.push(c);
          healingUpdates.push(c.id);  // tag ke device ini
        }
      }
      // Selain itu → skip (customer milik router lain)
    }

    // Self-healing: tag mikrotik_id untuk customer yang berhasil match via PPPoE.
    // Best-effort (non-blocking), tidak mengganggu response.
    if (healingUpdates.length > 0) {
      Customer.update(
        { mikrotik_id: deviceId },
        { where: { id: { [Op.in]: healingUpdates } } }
      ).then(() => {
        logger.info(`PingMonitor: ${healingUpdates.length} customer auto-tagged ke device ${deviceId}`);
      }).catch(e => logger.warn("PingMonitor self-heal gagal: " + e.message));
    }

    // 4) Build response: untuk customer tanpa static_ip, lookup IP dari
    //    PPPoE active cache. Kalau tetap tak ditemukan → ip kosong & status "no_ip".
    const data = filtered.map(c => {
      let ip = c.static_ip || "";
      let ipSource = ip ? "static" : "";

      // PPPoE-only: cari IP dari active session
      if (!ip && c.pppoe_username && pppoeState.cache) {
        const found = pppoeState.cache.get(c.pppoe_username.toLowerCase());
        if (found) { ip = found; ipSource = "pppoe"; }
      }

      const s = ip ? ipState.get(ip) : null;
      return {
        id:          c.id,
        customer_id: c.customer_id,
        name:        c.name,
        ip,
        ip_source:   ipSource,                   // "static" | "pppoe" | ""
        has_ip:      !!ip,
        status:      c.status,
        pppoe:       c.pppoe_username || "-",
        address:     c.address        || "-",
        package:     c.package?.name  || "-",
        speed:       c.package
                       ? `${c.package.speed_down}/${c.package.speed_up} Mbps`
                       : "-",
        ping: ip
          ? (s ? toResult(ip, s) : { status: "unknown", latency: 0, loss: 0, lastCheck: null })
          : { status: "no_ip",   latency: 0, loss: 0, lastCheck: null },
      };
    });

    res.json({
      success:    true,
      data,
      total:      data.length,
      with_ip:    data.filter(x => x.has_ip).length,
      without_ip: data.filter(x => !x.has_ip).length,
      device_id:  deviceId,                       // info: device yg sedang difilter
    });
  } catch (e) {
    logger.error("PingMonitor getCustomers:", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// GET /api/ping-monitor/all-customers
exports.getAllCustomers = async (req, res) => {
  try {
    const rows = await Customer.findAll({
      where:      { status: { [Op.in]: ["active", "isolated"] } },
      attributes: ["id","customer_id","name","static_ip","status","pppoe_username"],
      order:      [["name", "ASC"]],
    });
    const data = rows.map(c => ({
      id:          c.id,
      customer_id: c.customer_id,
      name:        c.name,
      ip:          c.static_ip    || "",
      pppoe:       c.pppoe_username || "",
      status:      c.status,
      hasIP:       !!(c.static_ip?.trim()),
    }));
    res.json({
      success:   true,
      data,
      total:     data.length,
      withIP:    data.filter(c => c.hasIP).length,
      withoutIP: data.filter(c => !c.hasIP).length,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/ping-monitor/ping-batch  { ips: [...] }
exports.pingBatch = async (req, res) => {
  const { ips } = req.body || {};
  if (!Array.isArray(ips) || ips.length === 0)
    return res.status(400).json({ success: false, message: "ips[] wajib diisi" });

  let pingClient;
  try {
    if (!(await getMt(req))) throw new Error('Device tidak ditemukan');
    pingClient = await getPingClient(req);
  } catch (e) {
    return res.status(503).json({ success: false, message: "MikroTik tidak terhubung: " + e.message });
  }

  const results = await probeBatch(ips.slice(0, 50), pingClient);
  res.json({ success: true, results, checkedAt: new Date().toISOString() });
};

// POST /api/ping-monitor/ping-single  { ip }
exports.pingSingle = async (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ success: false, message: "ip wajib diisi" });

  let pingClient;
  try {
    if (!(await getMt(req))) throw new Error('Device tidak ditemukan');
    pingClient = await getPingClient(req);
  } catch (e) { return res.status(503).json({ success: false, message: "MikroTik tidak terhubung" }); }

  // Reset counter agar single-ping langsung reflektif
  const s = getIpState(ip);
  s.consecutiveFail = 0;
  s.consecutiveOk   = 0;

  const result = await probeIP(ip, pingClient);
  res.json({ success: true, ip, ...result });
};

// GET /api/ping-monitor/summary
exports.summary = async (req, res) => {
  try {
    const deviceId = resolveDeviceId(req);
    const where = {
      status:    { [Op.in]: ["active","isolated"] },
      static_ip: { [Op.not]: null, [Op.ne]: "" },
    };
    if (deviceId) where.mikrotik_id = deviceId;

    const rows = await Customer.findAll({
      where,
      attributes: ["static_ip"],
    });
    let up = 0, down = 0, unknown = 0;
    rows.forEach(c => {
      const s = ipState.get(c.static_ip);
      if (!s || s.status === "unknown") unknown++;
      else if (s.status === "up")        up++;
      else                               down++;
    });
    res.json({ success: true, total: rows.length, up, down, unknown, device_id: deviceId, lastUpdate: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/ping-monitor/set-ip  { customerId, ip }
exports.setCustomerIP = async (req, res) => {
  const { customerId, ip } = req.body || {};
  if (!customerId || !ip)
    return res.status(400).json({ success: false, message: "customerId dan ip wajib" });
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
    return res.status(400).json({ success: false, message: "Format IP tidak valid" });
  try {
    const c = await Customer.findByPk(customerId);
    if (!c) return res.status(404).json({ success: false, message: "Customer tidak ditemukan" });
    await c.update({ static_ip: ip });
    res.json({ success: true, message: `IP ${ip} disimpan untuk ${c.name}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ════════════════════════════════════════════════════════════════
// GET /api/ping-monitor/search-customers?q=...
// Type-ahead untuk modal "Tambah Manual" — return pelanggan match by
// name / customer_id / pppoe_username. Limit 20 untuk responsiveness.
// ════════════════════════════════════════════════════════════════
exports.searchCustomers = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, data: [] });

    const rows = await Customer.findAll({
      where: {
        status: { [Op.in]: ["active", "isolated"] },
        [Op.or]: [
          { name:           { [Op.like]: `%${q}%` } },
          { customer_id:    { [Op.like]: `%${q}%` } },
          { pppoe_username: { [Op.like]: `%${q}%` } },
        ],
      },
      attributes: ["id","customer_id","name","static_ip","pppoe_username","status","mikrotik_id"],
      limit: 20,
      order: [["name","ASC"]],
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ════════════════════════════════════════════════════════════════
// GET /api/ping-monitor/router-sources?device_id=N
// Autodetect IP/PPPoE pada router terpilih. Return:
//   - pppoeActive: [{ username, ip, uptime, ... }]  → dari /ppp/active
//   - pppoeSecrets: [{ username, profile, ... }]    → dari /ppp/secret (semua, termasuk offline)
//   - simpleQueues: [{ name, target }]              → dari /queue/simple
// Frontend pakai untuk dropdown "Pilih IP / PPPoE" — user bisa pilih
// PPPoE username (akan resolve ke IP saat session aktif) atau IP langsung.
// ════════════════════════════════════════════════════════════════
exports.getRouterSources = async (req, res) => {
  try {
    const mt = await getMt(req);
    if (!mt) {
      return res.status(503).json({ success: false, message: "Device tidak ditemukan / belum dikonfigurasi" });
    }

    const [activeRaw, secretsRaw, queuesRaw] = await Promise.allSettled([
      mt.get("/ppp/active"),
      mt.get("/ppp/secret"),
      mt.get("/queue/simple"),
    ]);

    // Parse PPPoE active sessions
    const pppoeActive = [];
    if (activeRaw.status === "fulfilled" && Array.isArray(activeRaw.value)) {
      activeRaw.value.forEach(s => {
        if (s.name && s.address) {
          pppoeActive.push({
            username: s.name,
            ip:       s.address,
            uptime:   s.uptime || "",
            service:  s.service || "pppoe",
          });
        }
      });
    }

    // Parse PPPoE secrets (semua user, termasuk offline)
    // Build set username yang aktif supaya bisa di-mark "online/offline"
    const activeSet = new Set(pppoeActive.map(p => p.username.toLowerCase()));
    const pppoeSecrets = [];
    if (secretsRaw.status === "fulfilled" && Array.isArray(secretsRaw.value)) {
      secretsRaw.value.forEach(s => {
        if (s.name) {
          pppoeSecrets.push({
            username: s.name,
            profile:  s.profile || "",
            comment:  s.comment || "",
            disabled: s.disabled === "true" || s.disabled === true,
            online:   activeSet.has(s.name.toLowerCase()),
          });
        }
      });
    }

    // Parse Simple Queue (sumber IP statis selain PPPoE)
    const simpleQueues = [];
    if (queuesRaw.status === "fulfilled" && Array.isArray(queuesRaw.value)) {
      queuesRaw.value.forEach(q => {
        const target = (q.target || "").replace("/32","").trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
          simpleQueues.push({
            name:    q.name || "",
            ip:      target,
            comment: q.comment || "",
          });
        }
      });
    }

    res.json({
      success: true,
      device_id: resolveDeviceId(req),
      pppoeActive,
      pppoeSecrets,
      simpleQueues,
      counts: {
        pppoeActive:  pppoeActive.length,
        pppoeSecrets: pppoeSecrets.length,
        simpleQueues: simpleQueues.length,
      },
    });
  } catch (e) {
    logger.error("PingMonitor getRouterSources:", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ════════════════════════════════════════════════════════════════
// POST /api/ping-monitor/assign
// Versi enhanced dari set-ip: terima sekaligus deviceId + customerId +
// (ip|pppoe). Backend resolve PPPoE → IP via /ppp/active kalau perlu.
// Body: { customerId, deviceId, type: 'ip'|'pppoe', value }
//   - type='ip'    → value adalah IP (4 octet)
//   - type='pppoe' → value adalah username, backend set pppoe_username +
//                    cari IP aktif (kalau ada) → set static_ip juga
// ════════════════════════════════════════════════════════════════
exports.assignManual = async (req, res) => {
  const { customerId, deviceId, type, value } = req.body || {};
  if (!customerId || !deviceId || !type || !value) {
    return res.status(400).json({ success: false, message: "customerId, deviceId, type, value wajib" });
  }
  if (!["ip","pppoe"].includes(type)) {
    return res.status(400).json({ success: false, message: "type harus 'ip' atau 'pppoe'" });
  }

  try {
    const c = await Customer.findByPk(customerId);
    if (!c) return res.status(404).json({ success: false, message: "Customer tidak ditemukan" });

    const updates = { mikrotik_id: parseInt(deviceId) };
    let resolvedIp = null;

    if (type === "ip") {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))
        return res.status(400).json({ success: false, message: "Format IP tidak valid" });
      updates.static_ip = value;
      resolvedIp = value;
    } else {
      // type=pppoe: set username + coba resolve IP dari active session
      updates.pppoe_username = value;
      try {
        const mt = await getMikrotikInstanceByDevice(parseInt(deviceId));
        if (mt) {
          const list = await mt.get("/ppp/active");
          const found = (Array.isArray(list) ? list : [])
            .find(s => (s.name || "").toLowerCase() === value.toLowerCase());
          if (found && found.address) {
            updates.static_ip = found.address;
            resolvedIp = found.address;
          }
        }
      } catch (e) {
        logger.warn(`PingMonitor assignManual: gagal resolve IP PPPoE ${value}: ${e.message}`);
        // Tetap simpan pppoe_username, IP nanti di-fill saat sync berikutnya
      }
    }

    await c.update(updates);
    res.json({
      success: true,
      message: resolvedIp
        ? `${c.name} → IP ${resolvedIp} (router ${deviceId})`
        : `${c.name} → PPPoE ${value} (belum online, IP akan auto-fill saat session aktif)`,
      customer: { id: c.id, name: c.name, static_ip: resolvedIp, pppoe_username: c.pppoe_username, mikrotik_id: c.mikrotik_id },
    });
  } catch (e) {
    logger.error("PingMonitor assignManual:", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ════════════════════════════════════════════════════════════════
// POST /api/ping-monitor/delete-ping  { customerId }
// Hapus data ping pelanggan: set static_ip=NULL, pppoe_username tetap
// (supaya identitas customer tidak hilang), clear ipState in-memory.
// Customer tidak akan muncul lagi di Ping Monitor sampai di-assign ulang.
// CATATAN: tidak menghapus record customer — hanya unassign data ping.
// ════════════════════════════════════════════════════════════════
exports.deletePing = async (req, res) => {
  const { customerId, clearPppoe = false } = req.body || {};
  if (!customerId)
    return res.status(400).json({ success: false, message: "customerId wajib" });

  try {
    const c = await Customer.findByPk(customerId);
    if (!c) return res.status(404).json({ success: false, message: "Customer tidak ditemukan" });

    const oldIp = c.static_ip;
    const updates = { static_ip: null, mikrotik_id: null };
    if (clearPppoe) updates.pppoe_username = null;

    await c.update(updates);

    // Clear in-memory state untuk IP tsb supaya tidak ada residu
    if (oldIp) ipState.delete(oldIp);

    res.json({
      success: true,
      message: `Data ping ${c.name} dihapus${oldIp ? ` (IP ${oldIp} di-release)` : ""}`,
    });
  } catch (e) {
    logger.error("PingMonitor deletePing:", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/ping-monitor/sync-from-mikrotik
exports.syncFromMikrotik = async (req, res) => {
  try {
    const result = await _runSync(req);
    res.json({
      success: true,
      message: `Sync selesai: ${result.updated} diupdate, ${result.skipped} skip, ${result.notFound} tidak cocok`,
      ...result,
    });
  } catch (e) {
    res.status(503).json({ success: false, message: "MikroTik tidak terhubung: " + e.message });
  }
};

// Internal: shared sync logic. Throws kalau MikroTik error.
// Dipanggil oleh syncFromMikrotik (manual) dan getCustomers (auto, throttled).
// req di-pass supaya tahu device mana yang dipilih user.
async function _runSync(req) {
  const mt = await getMt(req);
  if (!mt) throw new Error('MikroTik instance not available');
  // Reset ping client untuk device yang sedang di-sync — supaya baseURL fresh
  resetPingClient(resolveDeviceId(req));

  const deviceId = resolveDeviceId(req);
  const result = { updated: 0, skipped: 0, notFound: 0, errors: [], sources: [] };

  // Bulk load customer SCOPED ke device terpilih + customer tanpa tag (mikrotik_id NULL).
  // Customer milik router lain TIDAK boleh ikut di-sync di sini karena PPPoE/queue
  // yang kita baca cuma dari satu router. Kalau ikut di-update bisa overwrite IP
  // customer router lain.
  const custWhere = { status: { [Op.in]: ["active", "isolated"] } };
  if (deviceId) {
    custWhere[Op.or] = [
      { mikrotik_id: deviceId },
      { mikrotik_id: null },  // belum di-tag → kandidat self-healing
    ];
  }
  const allCust = await Customer.findAll({
    where:      custWhere,
    attributes: ["id","name","pppoe_username","static_ip","mikrotik_id"],
  });

  // Index by pppoe_username (lowercase) dan by IP
  const byPPPoE = new Map();  // "username" → Customer
  const byIP    = new Map();  // "10.x.x.x" → Customer
  allCust.forEach(c => {
    if (c.pppoe_username) byPPPoE.set(c.pppoe_username.toLowerCase(), c);
    if (c.static_ip)      byIP.set(c.static_ip, c);
  });

  const applyIP = async (cust, newIP) => {
    if (!cust || !newIP) return "notFound";

    // Build update payload. IP di-set kalau berbeda; mikrotik_id di-set kalau
    // belum di-tag (self-healing) atau memang sudah tag ke device ini.
    const updates = {};
    if (cust.static_ip !== newIP) updates.static_ip = newIP;
    if (deviceId && cust.mikrotik_id == null) updates.mikrotik_id = deviceId;

    if (Object.keys(updates).length === 0) return "skipped";

    try {
      await cust.update(updates);
      byIP.set(newIP, cust);  // update index
      return "updated";
    } catch (e) {
      result.errors.push(`${cust.name}: ${e.message}`);
      return "notFound";
    }
  };

  // 1. PPPoE active sessions
  try {
    const list = await mt.get("/ppp/active");
    const sessions = Array.isArray(list) ? list : [];
    result.sources.push(`PPPoE: ${sessions.length} sesi aktif`);
    // Update PPPoE active cache sekalian — supaya getCustomers berikutnya
    // bisa langsung enrich tanpa hit MikroTik lagi
    const cache = new Map();
    for (const s of sessions) {
      const uname = (s.name    || "").toLowerCase();
      const ip    =  s.address || "";
      if (!uname || !ip) continue;
      cache.set(uname, ip);
      const out = await applyIP(byPPPoE.get(uname), ip);
      result[out]++;
    }
    // Update PPPoE active cache per device — supaya getCustomers berikutnya
    // bisa langsung enrich tanpa hit MikroTik lagi
    const pppoeState = _getPppoeCache(req);
    pppoeState.cache = cache;
    pppoeState.at    = Date.now();
  } catch (e) { result.errors.push("PPPoE: " + e.message); }

  // 2. Simple Queue targets
  try {
    const list = await mt.get("/queue/simple");
    const queues = Array.isArray(list) ? list : [];
    result.sources.push(`Queue: ${queues.length} antrian`);
    for (const q of queues) {
      const target = (q.target || "").replace("/32","").trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(target)) continue;
      if (byIP.has(target)) { result.skipped++; continue; }
      const qname = (q.name || "").toLowerCase().trim();
      // Exact match dulu, lalu partial
      const cust = byPPPoE.get(qname)
               || [...byPPPoE.entries()].find(([k]) => k.includes(qname) || qname.includes(k))?.[1];
      if (cust && !cust.static_ip) {
        const out = await applyIP(cust, target);
        result[out]++;
      } else {
        result.notFound++;
      }
    }
  } catch (e) { result.errors.push("Queue: " + e.message); }

  // 3. DHCP leases
  try {
    const list = await mt.get("/ip/dhcp-server/lease");
    if (Array.isArray(list)) {
      result.sources.push(`DHCP: ${list.length} lease`);
      for (const l of list) {
        const ip   = l.address || l["active-address"] || "";
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
        if (byIP.has(ip)) continue;
        const term = (l.hostname || l["host-name"] || l.comment || "").toLowerCase();
        if (!term) continue;
        const cust = byPPPoE.get(term)
                  || [...byPPPoE.entries()].find(([k]) => k.includes(term) || term.includes(k))?.[1];
        if (cust && !cust.static_ip) {
          const out = await applyIP(cust, ip);
          result[out]++;
        }
      }
    }
  } catch (_) {}

  return result;
}
