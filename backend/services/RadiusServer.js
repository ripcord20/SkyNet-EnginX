'use strict';

/**
 * RadiusServer.js — Embedded RADIUS AAA server (RFC 2865 authentication +
 * RFC 2866 accounting), dipakai supaya router (MikroTik dkk, dikonfigurasi
 * sebagai RADIUS client via `/radius add service=ppp,hotspot address=<host>
 * secret=...`) bisa autentikasi PPPoE/Hotspot secara terpusat lewat modul
 * RADIUS aplikasi ini, alih-alih PPP secret lokal per-router.
 *
 * Bukan proxy ke FreeRADIUS — ini implementasi server RADIUS sendiri di atas
 * UDP (dgram), pakai paket npm `radius` untuk encode/decode paket.
 */

const dgram  = require('dgram');
const crypto = require('crypto');
const logger = require('../utils/logger');
const ConfigCrypto = require('../utils/ConfigCrypto');

let radius = null;
let radiusReady = false;
try {
  radius = require('radius');
  radiusReady = true;
} catch (e) {
  logger.warn('[RadiusServer] Paket "radius" tidak tersedia: ' + e.message);
}

let authSocket = null;
let acctSocket = null;
let running = false;
let startedAt = null;
let ports = { authPort: null, acctPort: null };
const stats = { accessAccept: 0, accessReject: 0, acctStart: 0, acctStop: 0, acctUpdate: 0, errors: 0 };

// ── Cache NAS clients (source IP -> {id,name,secret}) ────────────────────
// Dipakai untuk mencocokkan shared secret berdasarkan IP pengirim paket UDP,
// direfresh berkala supaya tiap paket tidak selalu round-trip ke DB.
let nasCache = new Map();
let nasCacheAt = 0;
const NAS_CACHE_TTL = 30 * 1000;

function decryptOrEmpty(value) {
  try { return ConfigCrypto._decryptString(value) || ''; }
  catch (e) { logger.error('[RadiusServer] Gagal dekripsi: ' + e.message); return ''; }
}

async function loadNasClients() {
  const { RadiusNasClient } = require('../models');
  const rows = await RadiusNasClient.findAll({ where: { is_active: true } });
  const map = new Map();
  for (const r of rows) {
    map.set(r.nas_ip_address, { id: r.id, name: r.name, secret: decryptOrEmpty(r.secret) });
  }
  nasCache = map;
  nasCacheAt = Date.now();
  return map;
}

async function getNasBySourceIp(ip) {
  if (!nasCache.size || (Date.now() - nasCacheAt) > NAS_CACHE_TTL) {
    await loadNasClients();
  }
  return nasCache.get(ip) || null;
}

function invalidateNasCache() { nasCache = new Map(); nasCacheAt = 0; }

// Throttle last_seen_at (satu NAS max 1x / 30 detik) supaya paket RADIUS
// beruntun tidak menuliskan DB terus-menerus.
const lastSeenThrottle = new Map();
function touchLastSeen(nas) {
  if (!nas?.id) return;
  const now = Date.now();
  if ((lastSeenThrottle.get(nas.id) || 0) + 30000 > now) return;
  lastSeenThrottle.set(nas.id, now);
  const { RadiusNasClient } = require('../models');
  RadiusNasClient.update({ last_seen_at: new Date() }, { where: { id: nas.id } }).catch(() => {});
}

// ── Gigawords helper (RFC 2869: Acct-Input/Output-Octets overflow ke
//    -Gigawords tiap 2^32 byte) → gabung jadi satu angka byte total ──
function octetsFromAttrs(low, giga) {
  const l = parseInt(low, 10) || 0;
  const g = parseInt(giga, 10) || 0;
  return g * 4294967296 + l;
}

// ── Verifikasi CHAP-Password (RFC 2865 §5.3) ──────────────────────────────
// node-radius otomatis mendekripsi User-Password (PAP) saat decode(), tapi
// CHAP tidak "terenkripsi" dengan cara yang sama — responnya harus dihitung
// ulang di sisi server dari plaintext password lalu dibandingkan.
function verifyChap(packet, plaintextPassword) {
  const chapPassword = packet.attributes['CHAP-Password'];
  if (!Buffer.isBuffer(chapPassword) || chapPassword.length < 17) return false;
  const chapId   = chapPassword[0];
  const response = chapPassword.subarray(1);
  const challenge = packet.attributes['CHAP-Challenge'] || packet.authenticator;
  if (!challenge) return false;
  const expected = crypto.createHash('md5')
    .update(Buffer.from([chapId]))
    .update(Buffer.from(String(plaintextPassword), 'utf8'))
    .update(challenge)
    .digest();
  return expected.equals(response);
}

// ── Access-Request handler ────────────────────────────────────────────────
async function handleAuthPacket(msg, rinfo) {
  const nas = await getNasBySourceIp(rinfo.address);
  if (!nas) {
    logger.warn('[RADIUS] Access-Request ditolak — NAS tidak dikenal: ' + rinfo.address);
    return;
  }

  let packet;
  try {
    packet = radius.decode({ packet: msg, secret: nas.secret });
  } catch (e) {
    stats.errors++;
    logger.warn('[RADIUS] Gagal decode paket dari ' + rinfo.address + ' (secret salah?): ' + e.message);
    return;
  }
  if (packet.code !== 'Access-Request') return;
  touchLastSeen(nas);

  const username = packet.attributes['User-Name'];
  const { RadiusUser } = require('../models');
  const user = username ? await RadiusUser.findOne({ where: { username } }) : null;

  let accept = false;
  let denyReason = '';

  if (!user) {
    denyReason = 'user tidak ditemukan';
  } else if (!user.is_active) {
    denyReason = 'user nonaktif';
  } else if (user.expires_at && new Date(user.expires_at) < new Date()) {
    denyReason = 'akun kadaluarsa';
  } else {
    const storedPassword = decryptOrEmpty(user.password);
    if (packet.attributes['User-Password'] != null) {
      accept = String(packet.attributes['User-Password']) === storedPassword;
      denyReason = accept ? '' : 'password PAP salah';
    } else if (packet.attributes['CHAP-Password']) {
      accept = verifyChap(packet, storedPassword);
      denyReason = accept ? '' : 'password CHAP salah';
    } else {
      denyReason = 'tidak ada atribut auth yang didukung (PAP/CHAP)';
    }
  }

  const replyAttributes = [];
  if (accept) {
    stats.accessAccept++;
    if (user.reply_framed_ip) replyAttributes.push(['Framed-IP-Address', user.reply_framed_ip]);
    if (user.reply_rate_limit) {
      // MikroTik vendor id 14988 — VSA umum untuk limit bandwidth PPP/Hotspot via RADIUS.
      replyAttributes.push(['Vendor-Specific', 14988, [['Mikrotik-Rate-Limit', user.reply_rate_limit]]]);
    }
    try { await user.update({ last_auth_at: new Date(), last_auth_nas: rinfo.address }); } catch (_) {}
  } else {
    stats.accessReject++;
    logger.info(`[RADIUS] Access-Reject "${username}" dari ${rinfo.address}${denyReason ? ' — ' + denyReason : ''}`);
  }

  const response = radius.encode_response({
    packet,
    code: accept ? 'Access-Accept' : 'Access-Reject',
    secret: nas.secret,
    attributes: replyAttributes,
  });
  authSocket.send(response, 0, response.length, rinfo.port, rinfo.address);
}

// ── Accounting-Request handler ────────────────────────────────────────────
async function upsertAccounting(sessionId, nasIp, defaults, patch) {
  const { RadiusAccounting } = require('../models');
  const [row] = await RadiusAccounting.findOrCreate({
    where: { acct_session_id: sessionId, nas_ip_address: nasIp },
    defaults: { acct_session_id: sessionId, nas_ip_address: nasIp, ...defaults },
  });
  await row.update(patch);
  return row;
}

async function handleAcctPacket(msg, rinfo) {
  const nas = await getNasBySourceIp(rinfo.address);
  if (!nas) {
    logger.warn('[RADIUS] Accounting-Request ditolak — NAS tidak dikenal: ' + rinfo.address);
    return;
  }

  let packet;
  try {
    packet = radius.decode({ packet: msg, secret: nas.secret });
  } catch (e) {
    stats.errors++;
    logger.warn('[RADIUS] Gagal decode paket accounting dari ' + rinfo.address + ': ' + e.message);
    return;
  }
  if (packet.code !== 'Accounting-Request') return;
  touchLastSeen(nas);

  const a = packet.attributes;
  const sessionId  = a['Acct-Session-Id'] || '';
  const username   = a['User-Name'] || '';
  const statusType = a['Acct-Status-Type'];

  if (sessionId) {
    try {
      if (statusType === 'Start') {
        stats.acctStart++;
        await upsertAccounting(sessionId, rinfo.address, {
          username, started_at: new Date(),
        }, {
          username,
          framed_ip_address: a['Framed-IP-Address'] || null,
          calling_station_id: a['Calling-Station-Id'] || null,
          started_at: new Date(),
          stopped_at: null,
          last_update_at: new Date(),
        });
      } else if (statusType === 'Interim-Update') {
        stats.acctUpdate++;
        await upsertAccounting(sessionId, rinfo.address, {
          username, started_at: new Date(),
        }, {
          framed_ip_address: a['Framed-IP-Address'] || null,
          input_octets:  octetsFromAttrs(a['Acct-Input-Octets'],  a['Acct-Input-Gigawords']),
          output_octets: octetsFromAttrs(a['Acct-Output-Octets'], a['Acct-Output-Gigawords']),
          session_time: parseInt(a['Acct-Session-Time'], 10) || 0,
          last_update_at: new Date(),
        });
      } else if (statusType === 'Stop') {
        stats.acctStop++;
        await upsertAccounting(sessionId, rinfo.address, {
          username, started_at: new Date(),
        }, {
          input_octets:  octetsFromAttrs(a['Acct-Input-Octets'],  a['Acct-Input-Gigawords']),
          output_octets: octetsFromAttrs(a['Acct-Output-Octets'], a['Acct-Output-Gigawords']),
          session_time: parseInt(a['Acct-Session-Time'], 10) || 0,
          terminate_cause: a['Acct-Terminate-Cause'] || null,
          stopped_at: new Date(),
          last_update_at: new Date(),
        });
      }
      // Accounting-On/Off (restart NAS) — tidak per-sesi, cukup dicatat di log.
    } catch (e) {
      stats.errors++;
      logger.error('[RADIUS] Gagal simpan accounting: ' + e.message);
    }
  }

  // Selalu balas Accounting-Response supaya NAS tidak retry terus-menerus.
  const response = radius.encode_response({ packet, code: 'Accounting-Response', secret: nas.secret });
  acctSocket.send(response, 0, response.length, rinfo.port, rinfo.address);
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
function start(opts = {}) {
  if (running) return Promise.resolve({ alreadyRunning: true, ...ports });
  if (!radiusReady) return Promise.reject(new Error('Paket "radius" belum terpasang. Jalankan: npm install'));

  const authPort = parseInt(opts.authPort || process.env.RADIUS_AUTH_PORT || '1812', 10);
  const acctPort = parseInt(opts.acctPort || process.env.RADIUS_ACCT_PORT || '1813', 10);

  return new Promise((resolve, reject) => {
    invalidateNasCache();
    authSocket = dgram.createSocket('udp4');
    acctSocket = dgram.createSocket('udp4');

    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { authSocket && authSocket.close(); } catch (_) {}
      try { acctSocket && acctSocket.close(); } catch (_) {}
      authSocket = null; acctSocket = null;
      reject(e);
    };

    authSocket.on('message', (msg, rinfo) => {
      handleAuthPacket(msg, rinfo).catch(e => { stats.errors++; logger.error('[RADIUS] auth handler error: ' + e.message); });
    });
    acctSocket.on('message', (msg, rinfo) => {
      handleAcctPacket(msg, rinfo).catch(e => { stats.errors++; logger.error('[RADIUS] acct handler error: ' + e.message); });
    });
    authSocket.once('error', fail);
    acctSocket.once('error', fail);

    let pending = 2;
    const done = () => {
      if (settled) return;
      if (--pending === 0) {
        settled = true;
        running = true;
        startedAt = new Date();
        ports = { authPort, acctPort };
        logger.info(`[RADIUS] Server listening — auth:${authPort} acct:${acctPort}`);
        resolve({ authPort, acctPort });
      }
    };
    authSocket.bind(authPort, done);
    acctSocket.bind(acctPort, done);
  });
}

function stop() {
  running = false;
  startedAt = null;
  try { authSocket && authSocket.close(); } catch (_) {}
  try { acctSocket && acctSocket.close(); } catch (_) {}
  authSocket = null;
  acctSocket = null;
  logger.info('[RADIUS] Server stopped');
}

function status() {
  return {
    running,
    ready: radiusReady,
    startedAt,
    ports: running ? ports : null,
    stats: { ...stats },
    nasCached: nasCache.size,
  };
}

module.exports = { start, stop, status, invalidateNasCache };
