'use strict';

/**
 * WireGuardService.js — mengelola interface WireGuard di host tempat
 * aplikasi ini berjalan lewat CLI `wg` / `ip` (paket wireguard-tools & iproute2
 * di Linux). Tidak menyimpan state di file wg-quick — DB (WireguardServer /
 * WireguardPeer) adalah source of truth, di-push ke kernel via `wg syncconf`
 * (non-disruptive: peer lain yang sudah connect tidak ke-drop).
 *
 * Semua operasi live bersifat best-effort: kalau binary `wg` tidak ada atau
 * proses tidak punya privilese NET_ADMIN, CRUD di DB tetap jalan — caller
 * (controller) akan menerima {applied:false, error} dan menampilkannya
 * sebagai warning, bukan meng-gagalkan request.
 */

const { execFileSync } = require('child_process');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const logger = require('../utils/logger');
const ConfigCrypto = require('../utils/ConfigCrypto');

function encrypt(plaintext) { return ConfigCrypto._encryptString(String(plaintext || '')); }
function decrypt(value) {
  if (!value) return '';
  try { return ConfigCrypto._decryptString(value) || ''; }
  catch (e) { logger.error('[WireGuard] Gagal dekripsi: ' + e.message); return ''; }
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

// ── Binary / interface availability ───────────────────────────────────────
function binaryAvailable() {
  try { run('wg', ['--version']); return true; } catch (_) { return false; }
}

function interfaceExists(iface) {
  try { run('ip', ['link', 'show', iface]); return true; } catch (_) { return false; }
}

// ── Key generation (delegasi ke wireguard-tools — format Curve25519 base64
//    resmi, hindari reimplementasi crypto sendiri) ─────────────────────────
function generateKeypair() {
  const privateKey = run('wg', ['genkey']).trim();
  const publicKey  = run('wg', ['pubkey'], { input: privateKey + '\n' }).trim();
  return { privateKey, publicKey };
}
function generatePresharedKey() {
  return run('wg', ['genpsk']).trim();
}

// ── CIDR / IP math (IPv4 saja) ──────────────────────────────────────────────
function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function parseCidr(cidr) {
  const [ip, prefixStr] = String(cidr).split('/');
  const prefix = parseInt(prefixStr, 10);
  const ipInt  = ipToInt(ip);
  const mask   = prefix <= 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const network   = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { ip, ipInt, prefix, network, broadcast };
}

// Alamat network dari sebuah CIDR, mis. "10.66.66.100/26" -> "10.66.66.64/26".
// PENTING: jangan diganti dengan trik "nolkan oktet terakhir" — itu cuma
// benar untuk prefix /24, /16, /8. Subnet seperti /26 atau /27 butuh bitmask asli.
function networkCidr(cidr) {
  const { network, prefix } = parseCidr(cidr);
  return `${intToIp(network)}/${prefix}`;
}

// Cari IP host berikutnya yang belum dipakai peer lain di server yang sama.
async function allocateIp(server) {
  const { WireguardPeer } = require('../models');
  const { ipInt: serverIpInt, network, broadcast } = parseCidr(server.address_cidr);
  const existing = await WireguardPeer.findAll({ where: { server_id: server.id }, attributes: ['allocated_ip'] });
  const used = new Set(existing.map(p => ipToInt(String(p.allocated_ip).split('/')[0])));
  used.add(serverIpInt);
  for (let cur = network + 1; cur < broadcast; cur++) {
    const candidate = cur >>> 0;
    if (!used.has(candidate)) return intToIp(candidate) + '/32';
  }
  throw new Error(`Tidak ada IP tersisa di subnet ${server.address_cidr}`);
}

// ── Config text builders ────────────────────────────────────────────────
// Format wg-quick lengkap — untuk DIUNDUH client (butuh private key peer,
// jadi hanya tersedia untuk peer yang key-nya di-generate oleh kita).
function buildClientConfig(server, peer) {
  const privateKey = decrypt(peer.private_key);
  if (!privateKey) throw new Error('Private key peer ini tidak tersimpan (dibuat manual dari public key sendiri) — tidak bisa menerbitkan file konfigurasi lengkap.');
  const lines = ['[Interface]'];
  lines.push(`PrivateKey = ${privateKey}`);
  lines.push(`Address = ${peer.allocated_ip}`);
  if (server.dns) lines.push(`DNS = ${server.dns}`);
  if (server.mtu) lines.push(`MTU = ${server.mtu}`);
  lines.push('');
  lines.push('[Peer]');
  lines.push(`PublicKey = ${server.public_key}`);
  const psk = decrypt(peer.preshared_key);
  if (psk) lines.push(`PresharedKey = ${psk}`);
  lines.push(`AllowedIPs = ${peer.client_allowed_ips}`);
  lines.push(`Endpoint = ${server.endpoint_host || '<ISI-ENDPOINT-HOST>'}:${server.listen_port}`);
  if (peer.persistent_keepalive) lines.push(`PersistentKeepalive = ${peer.persistent_keepalive}`);
  return lines.join('\n') + '\n';
}

// Format polos (setconf-compatible, TANPA Address/DNS/MTU) — dipakai internal
// untuk `wg syncconf`, bukan untuk dibagikan ke client.
function buildSyncConfText(server, peers, decryptedServerPrivateKey) {
  const lines = ['[Interface]'];
  lines.push(`PrivateKey = ${decryptedServerPrivateKey}`);
  lines.push(`ListenPort = ${server.listen_port}`);
  for (const p of peers) {
    if (!p.is_enabled) continue;
    lines.push('');
    lines.push('[Peer]');
    lines.push(`PublicKey = ${p.public_key}`);
    const psk = decrypt(p.preshared_key);
    if (psk) lines.push(`PresharedKey = ${psk}`);
    lines.push(`AllowedIPs = ${p.allocated_ip}`);
    if (p.endpoint) lines.push(`Endpoint = ${p.endpoint}`);
    if (p.persistent_keepalive) lines.push(`PersistentKeepalive = ${p.persistent_keepalive}`);
  }
  return lines.join('\n') + '\n';
}

// ── Live interface control ──────────────────────────────────────────────
function ensureInterfaceUp(server) {
  if (!interfaceExists(server.interface_name)) {
    run('ip', ['link', 'add', 'dev', server.interface_name, 'type', 'wireguard']);
  }
  // Idempotent — kalau address sudah ter-assign, 'ip address add' akan error
  // "File exists"; itu diabaikan dengan sengaja.
  try { run('ip', ['address', 'add', server.address_cidr, 'dev', server.interface_name]); } catch (_) {}
  if (server.mtu) {
    try { run('ip', ['link', 'set', 'mtu', String(server.mtu), 'dev', server.interface_name]); } catch (_) {}
  }
  run('ip', ['link', 'set', server.interface_name, 'up']);
}

function syncConf(server, peers, decryptedPrivateKey) {
  const text = buildSyncConfText(server, peers, decryptedPrivateKey);
  const tmpFile = path.join(os.tmpdir(), `wgsync-${server.interface_name}-${Date.now()}.conf`);
  fs.writeFileSync(tmpFile, text, { mode: 0o600 });
  try {
    run('wg', ['syncconf', server.interface_name, tmpFile]);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function interfaceDown(server) {
  try { run('ip', ['link', 'delete', 'dev', server.interface_name]); } catch (e) {
    logger.warn('[WireGuard] Gagal delete interface ' + server.interface_name + ': ' + e.message);
  }
}

// Orkestrasi best-effort: dipanggil controller setiap kali server/peer berubah.
async function applyLive(server) {
  try {
    if (!server.is_active) { interfaceDown(server); return { applied: true, note: 'interface dimatikan' }; }
    if (!binaryAvailable()) throw new Error('Perintah "wg" tidak ditemukan di server ini — install paket wireguard-tools.');
    const { WireguardPeer } = require('../models');
    const peers = await WireguardPeer.findAll({ where: { server_id: server.id } });
    const privKey = decrypt(server.private_key);
    ensureInterfaceUp(server);
    syncConf(server, peers, privKey);
    return { applied: true };
  } catch (e) {
    logger.warn('[WireGuard] Gagal apply live config utk ' + server.interface_name + ': ' + e.message);
    return { applied: false, error: e.message };
  }
}

// `wg show <iface> dump` → statistik live per-peer (handshake terakhir, byte counter).
function getRuntimeStats(iface) {
  const map = new Map();
  try {
    const out = run('wg', ['show', iface, 'dump']);
    const lines = out.trim().split('\n');
    for (let i = 1; i < lines.length; i++) { // baris 0 = interface sendiri
      const cols = lines[i].split('\t');
      const [publicKey, , endpoint, , latestHandshake, rx, tx] = cols;
      if (!publicKey) continue;
      map.set(publicKey, {
        endpoint: (endpoint && endpoint !== '(none)') ? endpoint : null,
        latestHandshake: parseInt(latestHandshake, 10) || 0,
        rx: parseInt(rx, 10) || 0,
        tx: parseInt(tx, 10) || 0,
      });
    }
  } catch (_) { /* interface belum up / wg tidak ada — kembalikan map kosong */ }
  return map;
}

// ── Port forwarding (DNAT) — meneruskan port di interface publik host ke
// IP tunnel salah satu WireGuard peer. Dipakai NAS module supaya admin bisa
// buka Winbox/SSH ke router yang tidak punya IP publik (di belakang CGNAT).
// Butuh privilese root/NET_ADMIN — sama seperti operasi `wg`/`ip` lainnya.

// Deteksi interface default (yang punya rute ke internet) — dipakai sebagai
// interface publik default kalau admin tidak menentukan sendiri.
function detectPublicInterface() {
  try {
    const out = run('ip', ['route', 'show', 'default']);
    const m = out.match(/dev\s+(\S+)/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

function portForwardArgs(rule, publicIface) {
  const proto = rule.protocol === 'udp' ? 'udp' : 'tcp';
  return {
    dnat: ['-t', 'nat', '-A', 'PREROUTING', '-i', publicIface, '-p', proto,
           '--dport', String(rule.public_port), '-j', 'DNAT',
           '--to-destination', `${rule.target_ip}:${rule.target_port}`],
    dnatDel: ['-t', 'nat', '-D', 'PREROUTING', '-i', publicIface, '-p', proto,
           '--dport', String(rule.public_port), '-j', 'DNAT',
           '--to-destination', `${rule.target_ip}:${rule.target_port}`],
    fwd: ['-A', 'FORWARD', '-p', proto, '-d', rule.target_ip,
           '--dport', String(rule.target_port), '-j', 'ACCEPT'],
    fwdDel: ['-D', 'FORWARD', '-p', proto, '-d', rule.target_ip,
           '--dport', String(rule.target_port), '-j', 'ACCEPT'],
  };
}

// rule: { public_port, target_ip, target_port, protocol }
function addPortForward(rule, publicIface) {
  const iface = publicIface || detectPublicInterface();
  if (!iface) throw new Error('Tidak bisa deteksi interface publik — tentukan manual.');
  const args = portForwardArgs(rule, iface);
  run('iptables', args.dnat);
  run('iptables', args.fwd);
  return { iface };
}

function removePortForward(rule, publicIface) {
  const iface = publicIface || detectPublicInterface();
  if (!iface) return;
  const args = portForwardArgs(rule, iface);
  // Best-effort — kalau rule sudah tidak ada (mis. host di-restart & rule hilang), abaikan.
  try { run('iptables', args.dnatDel); } catch (_) {}
  try { run('iptables', args.fwdDel); } catch (_) {}
}

module.exports = {
  encrypt, decrypt,
  binaryAvailable, interfaceExists,
  generateKeypair, generatePresharedKey,
  allocateIp, networkCidr,
  buildClientConfig,
  applyLive, interfaceDown,
  getRuntimeStats,
  detectPublicInterface, addPortForward, removePortForward,
};
