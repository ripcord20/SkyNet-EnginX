'use strict';

/**
 * VpnNasService — VPN concentrator L2TP/PPTP untuk koneksi NAS (MikroTik)
 * ke server billing, pola yang sama dengan modul NAS INETmedia:
 *
 *   1. Setiap NAS mendapat akun PPP unik (username billingradius_<hex>,
 *      password, IP tunnel remote).
 *   2. MikroTik di-site menghubungkan diri sebagai L2TP/PPTP client.
 *   3. Paket RADIUS dari router datang lewat IP tunnel (tidak butuh IP publik).
 *   4. Script RouterOS hanya ditampilkan selama NAS belum online — setelah
 *      terhubung, script disembunyikan supaya tidak ter-copy ke MikroTik lain
 *      (satu NAS = satu perangkat).
 *
 * Apply live ke accel-ppp / xl2tpd / pptpd bersifat best-effort: CRUD di DB
 * tetap jalan kalau binary/privilese tidak ada.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../utils/logger');
const ConfigCrypto = require('../utils/ConfigCrypto');

const SETTING_KEYS = {
  serverIp: 'nas_vpn_server_ip',
  localIp: 'nas_vpn_local_ip',
  poolCidr: 'nas_vpn_pool_cidr',
  profileName: 'nas_vpn_profile_name',
  dns: 'nas_vpn_dns',
  protocols: 'nas_vpn_protocols',
  mtu: 'nas_vpn_mtu',
};

const DEFAULTS = {
  localIp: '10.200.0.1',
  poolCidr: '10.200.0.0/24',
  profileName: 'skynet-nas',
  dns: '8.8.8.8,1.1.1.1',
  protocols: 'l2tp,pptp',
  mtu: '1400',
};

const CONNECTED_WINDOW_MS = 3 * 60 * 1000;
const CHAP_DIR = path.join(process.cwd(), 'uploads', 'nas-vpn');

function encrypt(plaintext) { return ConfigCrypto._encryptString(String(plaintext || '')); }
function decrypt(value) {
  if (!value) return '';
  try { return ConfigCrypto._decryptString(value) || ''; }
  catch (e) { return ''; }
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 4000, ...opts });
}

function generateUsername() {
  return 'billingradius_' + crypto.randomBytes(7).toString('hex').slice(0, 13);
}

function generatePassword() {
  return crypto.randomBytes(10).toString('hex');
}

function generateRadiusSecret() {
  return crypto.randomBytes(18).toString('base64url');
}

function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error('IP tidak valid: ' + ip);
  }
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function parseCidr(cidr) {
  const [ip, prefixStr] = String(cidr || '').split('/');
  const prefix = parseInt(prefixStr, 10);
  if (!ip || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new Error('Pool CIDR tidak valid (pakai IPv4 /8–/30), contoh 10.200.0.0/24');
  }
  const ipInt = ipToInt(ip);
  const mask = prefix <= 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { ip, prefix, network, broadcast };
}

function protocolList(raw) {
  const allowed = new Set(['l2tp', 'pptp']);
  const list = String(raw || DEFAULTS.protocols)
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => allowed.has(s));
  return list.length ? [...new Set(list)] : ['l2tp', 'pptp'];
}

function protocolLabel(raw) {
  return protocolList(raw).map(p => p.toUpperCase()).join(', ');
}

/**
 * Alokasikan IP remote berikutnya di pool, melewati network, broadcast, dan
 * alamat lokal server (PPP local-address).
 */
function allocateNextIp(usedIps, poolCidr, localIp) {
  const { network, broadcast } = parseCidr(poolCidr);
  const used = new Set((usedIps || []).map(ip => ipToInt(String(ip).split('/')[0])));
  if (localIp) used.add(ipToInt(localIp));
  used.add(network);
  used.add(broadcast);
  for (let cur = network + 1; cur < broadcast; cur++) {
    const candidate = cur >>> 0;
    if (!used.has(candidate)) return intToIp(candidate);
  }
  throw new Error(`Tidak ada IP tersisa di pool ${poolCidr}`);
}

function detectPublicIp() {
  try {
    const out = run('ip', ['-4', 'route', 'get', '1.1.1.1']);
    const m = out.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/);
    if (m) return m[1];
  } catch (_) { /* ignore */ }
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '';
}

function rosQuote(value) {
  return '"' + String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Script RouterOS yang di-paste ke terminal MikroTik. Satu NAS = satu device.
 */
function buildMikrotikScript(opts) {
  const name = opts.name || 'NAS';
  const serverIp = opts.serverIp || '';
  const username = opts.username || '';
  const password = opts.password || '';
  const radiusSecret = opts.radiusSecret || '';
  const localIp = opts.localIp || DEFAULTS.localIp;
  const remoteIp = opts.remoteIp || '';
  const profile = opts.profileName || DEFAULTS.profileName;
  const dns = String(opts.dns || DEFAULTS.dns).split(/[,\s]+/).filter(Boolean);
  const mtu = parseInt(opts.mtu, 10) || 1400;
  const protocols = protocolList(opts.protocols);
  const ifaceL2tp = 'skynet-l2tp';
  const ifacePptp = 'skynet-pptp';

  const lines = [
    '# ============================================================',
    '# SkyNet-EnginX — Script Konfigurasi NAS',
    `# NAS            : ${name}`,
    `# VPN Server     : ${serverIp}`,
    `# Username       : ${username}`,
    `# IP Tunnel NAS  : ${remoteIp}`,
    '# HANYA untuk SATU perangkat MikroTik. Jangan di-paste ke router lain.',
    '# ============================================================',
    '',
    `/ppp profile`,
    `add name=${rosQuote(profile)} local-address=${localIp} remote-address=${remoteIp} change-tcp-mss=yes only-one=yes use-encryption=yes${dns[0] ? ` dns-server=${dns[0]}${dns[1] ? ',' + dns[1] : ''}` : ''} comment="SkyNet NAS VPN"`,
    '',
  ];

  if (protocols.includes('l2tp')) {
    lines.push(
      `/interface l2tp-client`,
      `add name=${rosQuote(ifaceL2tp)} connect-to=${serverIp} user=${rosQuote(username)} password=${rosQuote(password)} profile=${rosQuote(profile)} disabled=no add-default-route=no use-ipsec=no keepalive-timeout=30 mtu=${mtu} comment="SkyNet NAS VPN L2TP"`,
      '',
    );
  }
  if (protocols.includes('pptp')) {
    lines.push(
      `/interface pptp-client`,
      `add name=${rosQuote(ifacePptp)} connect-to=${serverIp} user=${rosQuote(username)} password=${rosQuote(password)} profile=${rosQuote(profile)} disabled=no add-default-route=no keepalive-timeout=30 mtu=${mtu} comment="SkyNet NAS VPN PPTP"`,
      '',
    );
  }

  lines.push(
    `/radius`,
    `add address=${localIp} secret=${rosQuote(radiusSecret)} service=ppp,hotspot timeout=3s src-address=${remoteIp} comment="SkyNet RADIUS via VPN"`,
    '',
    `/radius incoming`,
    `set accept=yes`,
    '',
    `/ppp aaa`,
    `set use-radius=yes accounting=yes interim-update=5m`,
    '',
    '# Selesai. Pastikan VPN client statusnya "connected", lalu RADIUS akan',
    '# memakai IP tunnel sebagai sumber paket (tidak butuh IP publik).',
    '',
  );
  return lines.join('\n');
}

function chapSecretsBody(accounts) {
  const header = [
    '# Generated by SkyNet-EnginX NAS VPN module. Do not edit by hand.',
    '# username  server  password  ip',
  ];
  const rows = (accounts || []).map(a =>
    `${a.username}  *  ${a.password}  ${a.remoteIp}`
  );
  return header.concat(rows).join('\n') + '\n';
}

function accelPppSecretsBody(accounts) {
  return (accounts || []).map(a =>
    `${a.username}  ${a.password}  ${a.remoteIp}`
  ).join('\n') + (accounts && accounts.length ? '\n' : '');
}

async function getSettingMap() {
  const { AppSetting } = require('../models');
  const keys = Object.values(SETTING_KEYS);
  const rows = await AppSetting.findAll({ where: { key: keys } });
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

async function getSettings() {
  const map = await getSettingMap();
  const detected = detectPublicIp();
  return {
    serverIp: map[SETTING_KEYS.serverIp] || detected || '',
    localIp: map[SETTING_KEYS.localIp] || DEFAULTS.localIp,
    poolCidr: map[SETTING_KEYS.poolCidr] || DEFAULTS.poolCidr,
    profileName: map[SETTING_KEYS.profileName] || DEFAULTS.profileName,
    dns: map[SETTING_KEYS.dns] || DEFAULTS.dns,
    protocols: map[SETTING_KEYS.protocols] || DEFAULTS.protocols,
    mtu: map[SETTING_KEYS.mtu] || DEFAULTS.mtu,
    detectedServerIp: detected,
  };
}

async function saveSettings(patch) {
  const { AppSetting } = require('../models');
  const allowed = {
    serverIp: SETTING_KEYS.serverIp,
    localIp: SETTING_KEYS.localIp,
    poolCidr: SETTING_KEYS.poolCidr,
    profileName: SETTING_KEYS.profileName,
    dns: SETTING_KEYS.dns,
    protocols: SETTING_KEYS.protocols,
    mtu: SETTING_KEYS.mtu,
  };
  if (patch.poolCidr) parseCidr(patch.poolCidr);
  if (patch.localIp) ipToInt(patch.localIp);
  if (patch.serverIp && patch.serverIp !== '') ipToInt(patch.serverIp);
  if (patch.protocols) patch.protocols = protocolList(patch.protocols).join(',');
  if (patch.mtu) {
    const m = parseInt(patch.mtu, 10);
    if (!Number.isInteger(m) || m < 576 || m > 1500) throw new Error('MTU harus 576–1500');
    patch.mtu = String(m);
  }
  for (const [field, key] of Object.entries(allowed)) {
    if (patch[field] === undefined) continue;
    await AppSetting.upsert({
      key,
      value: String(patch[field] == null ? '' : patch[field]),
      type: 'string',
      description: 'NAS VPN ' + field,
    });
  }
  return getSettings();
}

function pingHost(ip) {
  if (!ip) return false;
  try {
    run('ping', ['-c', '1', '-W', '1', ip], { stdio: 'ignore', timeout: 2500 });
    return true;
  } catch (_) {
    return false;
  }
}

function accelSessions() {
  try {
    const out = run('accel-cmd', ['show', 'sessions']);
    return String(out || '');
  } catch (_) {
    return '';
  }
}

function isConnected(nas, opts = {}) {
  if (!nas) return { connected: false, reason: 'missing' };
  const now = opts.now || Date.now();
  if (nas.last_seen_at) {
    const ts = new Date(nas.last_seen_at).getTime();
    if (Number.isFinite(ts) && (now - ts) < CONNECTED_WINDOW_MS) {
      return { connected: true, reason: 'radius', lastSeenAt: nas.last_seen_at };
    }
  }
  const sessions = opts.accelSessions != null ? opts.accelSessions : accelSessions();
  if (nas.vpn_username && sessions && sessions.includes(nas.vpn_username)) {
    return { connected: true, reason: 'ppp', lastSeenAt: nas.last_seen_at || null };
  }
  const ip = nas.vpn_remote_ip || nas.nas_ip_address;
  if (opts.allowPing !== false && pingHost(ip)) {
    return { connected: true, reason: 'ping', lastSeenAt: nas.last_seen_at || null };
  }
  return { connected: false, reason: 'offline', lastSeenAt: nas.last_seen_at || null };
}

async function loadVpnAccounts() {
  const { RadiusNasClient } = require('../models');
  const rows = await RadiusNasClient.findAll({ where: { connection_mode: 'vpn', is_active: true } });
  return rows.map(r => ({
    username: r.vpn_username,
    password: decrypt(r.vpn_password),
    remoteIp: r.vpn_remote_ip || r.nas_ip_address,
  })).filter(a => a.username && a.password && a.remoteIp);
}

function writeFileBestEffort(filePath, body) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, { mode: 0o600 });
    return { written: true, path: filePath };
  } catch (e) {
    return { written: false, path: filePath, error: e.message };
  }
}

async function syncChapSecrets() {
  const accounts = await loadVpnAccounts();
  const chap = chapSecretsBody(accounts);
  const accel = accelPppSecretsBody(accounts);
  const results = [];
  results.push(writeFileBestEffort(path.join(CHAP_DIR, 'chap-secrets'), chap));
  results.push(writeFileBestEffort(path.join(CHAP_DIR, 'accel-ppp.secrets'), accel));
  // Paths produksi umum — hanya ditulis kalau writable (root).
  results.push(writeFileBestEffort('/etc/ppp/chap-secrets.skynet-nas', chap));
  try {
    run('accel-cmd', ['reload']);
    results.push({ reloaded: 'accel-ppp' });
  } catch (_) { /* accel-ppp tidak terpasang */ }
  return { accounts: accounts.length, results };
}

async function allocateRemoteIp(settings) {
  const { RadiusNasClient } = require('../models');
  const rows = await RadiusNasClient.findAll({
    where: { connection_mode: 'vpn' },
    attributes: ['vpn_remote_ip', 'nas_ip_address'],
  });
  const used = rows.map(r => r.vpn_remote_ip || r.nas_ip_address).filter(Boolean);
  return allocateNextIp(used, settings.poolCidr, settings.localIp);
}

async function provisionVpnNas({ name, site_name, device_id, description, created_by }) {
  if (!name) throw new Error('Nama NAS wajib diisi');
  const settings = await getSettings();
  if (!settings.serverIp) {
    throw new Error('IP Server VPN belum diisi. Buka Pengaturan NAS VPN dan isi IP publik server ini.');
  }

  const { RadiusNasClient, Device } = require('../models');
  let siteNameFinal = site_name || null;
  if (!siteNameFinal && device_id) {
    const dev = await Device.findByPk(device_id);
    if (dev?.location) siteNameFinal = dev.location;
  }

  const username = generateUsername();
  const password = generatePassword();
  const radiusSecret = generateRadiusSecret();
  const remoteIp = await allocateRemoteIp(settings);

  const nas = await RadiusNasClient.create({
    name,
    nas_ip_address: remoteIp,
    secret: encrypt(radiusSecret),
    nas_type: 'mikrotik',
    description: description || null,
    site_name: siteNameFinal,
    device_id: device_id || null,
    connection_mode: 'vpn',
    vpn_username: username,
    vpn_password: encrypt(password),
    vpn_local_ip: settings.localIp,
    vpn_remote_ip: remoteIp,
    vpn_protocols: protocolList(settings.protocols).join(','),
    created_by: created_by || null,
  });

  let apply = { applied: false };
  try {
    apply = { applied: true, ...(await syncChapSecrets()) };
  } catch (e) {
    apply = { applied: false, error: e.message };
  }

  const script = buildMikrotikScript({
    name,
    serverIp: settings.serverIp,
    username,
    password,
    radiusSecret,
    localIp: settings.localIp,
    remoteIp,
    profileName: settings.profileName,
    dns: settings.dns,
    protocols: settings.protocols,
    mtu: settings.mtu,
  });

  return {
    nas,
    radiusSecret,
    vpnPassword: password,
    script,
    settings,
    apply,
  };
}

function publicProfile(nas, settings) {
  const protocols = nas.vpn_protocols || settings.protocols;
  return {
    name: settings.profileName,
    localAddress: nas.vpn_local_ip || settings.localIp,
    remoteAddress: nas.vpn_remote_ip || nas.nas_ip_address,
    dns: settings.dns,
    mtu: settings.mtu,
    onlyOne: true,
    useEncryption: true,
    changeTcpMss: true,
    protocols: protocolList(protocols),
    protocolLabel: protocolLabel(protocols),
  };
}

module.exports = {
  SETTING_KEYS,
  DEFAULTS,
  CONNECTED_WINDOW_MS,
  encrypt,
  decrypt,
  generateUsername,
  generatePassword,
  generateRadiusSecret,
  ipToInt,
  intToIp,
  parseCidr,
  protocolList,
  protocolLabel,
  allocateNextIp,
  detectPublicIp,
  rosQuote,
  buildMikrotikScript,
  chapSecretsBody,
  accelPppSecretsBody,
  getSettings,
  saveSettings,
  pingHost,
  isConnected,
  syncChapSecrets,
  allocateRemoteIp,
  provisionVpnNas,
  publicProfile,
};
