'use strict';
/**
 * Test modul NAS VPN (L2TP/PPTP) — alokasi IP, script MikroTik,
 * penyembunyian script saat NAS sudah terhubung.
 * Jalankan: node test/vpnNas.test.js
 */
const assert = require('assert');
const Vpn = require('../services/VpnNasService');

// ── Username / password ──────────────────────────────────────────
const user = Vpn.generateUsername();
assert.ok(/^billingradius_[0-9a-f]{13}$/.test(user), 'username mengikuti pola billingradius_<13 hex>: ' + user);
const pass = Vpn.generatePassword();
assert.strictEqual(pass.length, 20, 'password hex 10 byte');
assert.ok(/^[0-9a-f]+$/.test(pass), 'password hanya hex (aman di RouterOS)');

const secret = Vpn.generateRadiusSecret();
assert.ok(secret.length >= 16, 'radius secret cukup panjang');

// ── CIDR / IP allocation ─────────────────────────────────────────
const cidr = Vpn.parseCidr('10.200.0.0/24');
assert.strictEqual(Vpn.intToIp(cidr.network), '10.200.0.0');
assert.strictEqual(Vpn.intToIp(cidr.broadcast), '10.200.0.255');

assert.strictEqual(
  Vpn.allocateNextIp([], '10.200.0.0/24', '10.200.0.1'),
  '10.200.0.2',
  'skip network + local-address'
);
assert.strictEqual(
  Vpn.allocateNextIp(['10.200.0.2', '10.200.0.3'], '10.200.0.0/24', '10.200.0.1'),
  '10.200.0.4'
);

assert.throws(() => Vpn.parseCidr('10.200.0.0/33'), /tidak valid/);
assert.throws(() => Vpn.parseCidr('not-an-ip'), /tidak valid/);

const almostFull = [];
for (let i = 2; i <= 254; i++) almostFull.push('10.200.0.' + i);
assert.throws(
  () => Vpn.allocateNextIp(almostFull, '10.200.0.0/24', '10.200.0.1'),
  /Tidak ada IP tersisa/
);

// ── Protocols ────────────────────────────────────────────────────
assert.deepStrictEqual(Vpn.protocolList('l2tp,pptp'), ['l2tp', 'pptp']);
assert.deepStrictEqual(Vpn.protocolList('PPTP, L2TP, bogus'), ['pptp', 'l2tp']);
assert.strictEqual(Vpn.protocolLabel('l2tp,pptp'), 'L2TP, PPTP');
assert.deepStrictEqual(Vpn.protocolList(''), ['l2tp', 'pptp'], 'default L2TP+PPTP');

// ── RouterOS quoting ─────────────────────────────────────────────
assert.strictEqual(Vpn.rosQuote('abc'), '"abc"');
assert.strictEqual(Vpn.rosQuote('a"b'), '"a\\"b"');

// ── MikroTik script ──────────────────────────────────────────────
const script = Vpn.buildMikrotikScript({
  name: 'Kampung Mandar',
  serverIp: '217.216.34.97',
  username: 'billingradius_6a630e09cabb3',
  password: 's3cretpass',
  radiusSecret: 'radsecret',
  localIp: '10.200.0.1',
  remoteIp: '10.200.0.5',
  profileName: 'skynet-nas',
  dns: '8.8.8.8,1.1.1.1',
  protocols: 'l2tp,pptp',
  mtu: 1400,
});
assert.ok(script.includes('/interface l2tp-client'), 'script berisi L2TP client');
assert.ok(script.includes('/interface pptp-client'), 'script berisi PPTP client');
assert.ok(script.includes('connect-to=217.216.34.97'), 'connect-to IP server VPN');
assert.ok(script.includes('user="billingradius_6a630e09cabb3"'), 'username PPP');
assert.ok(script.includes('password="s3cretpass"'), 'password PPP');
assert.ok(script.includes('/radius'), 'script set RADIUS');
assert.ok(script.includes('address=10.200.0.1'), 'RADIUS address = local tunnel IP');
assert.ok(script.includes('src-address=10.200.0.5'), 'src-address = remote NAS IP');
assert.ok(script.includes('secret="radsecret"'), 'RADIUS secret');
assert.ok(script.includes('/ppp aaa'), 'PPP AAA via RADIUS');
assert.ok(script.includes('HANYA untuk SATU perangkat MikroTik'), 'peringatan copy-paste');

const l2tpOnly = Vpn.buildMikrotikScript({
  name: 'X', serverIp: '1.2.3.4', username: 'u', password: 'p',
  radiusSecret: 's', localIp: '10.200.0.1', remoteIp: '10.200.0.2',
  protocols: 'l2tp',
});
assert.ok(l2tpOnly.includes('l2tp-client'));
assert.ok(!l2tpOnly.includes('pptp-client'), 'PPTP di-omit kalau protokol l2tp saja');

// ── chap-secrets ─────────────────────────────────────────────────
const chap = Vpn.chapSecretsBody([
  { username: 'billingradius_abc', password: 'pw', remoteIp: '10.200.0.5' },
]);
assert.ok(chap.includes('billingradius_abc  *  pw  10.200.0.5'));

const accel = Vpn.accelPppSecretsBody([
  { username: 'u1', password: 'p1', remoteIp: '10.200.0.5' },
]);
assert.strictEqual(accel.trim(), 'u1  p1  10.200.0.5');

// ── Connected → script hidden ────────────────────────────────────
const now = Date.now();
const online = Vpn.isConnected(
  { vpn_username: 'u', last_seen_at: new Date(now - 30 * 1000), nas_ip_address: '10.200.0.5' },
  { now, allowPing: false, accelSessions: '' }
);
assert.strictEqual(online.connected, true, 'last_seen dalam 3 menit = terhubung');
assert.strictEqual(online.reason, 'radius');

const stale = Vpn.isConnected(
  { vpn_username: 'u', last_seen_at: new Date(now - 10 * 60 * 1000), nas_ip_address: '10.200.0.5' },
  { now, allowPing: false, accelSessions: '' }
);
assert.strictEqual(stale.connected, false, 'last_seen kadaluarsa = offline (script boleh ditampilkan)');

const viaPpp = Vpn.isConnected(
  { vpn_username: 'billingradius_aaa', last_seen_at: null, nas_ip_address: '10.200.0.9' },
  { now, allowPing: false, accelSessions: 'ifname user calling-sid\nppp0 billingradius_aaa 1.2.3.4' }
);
assert.strictEqual(viaPpp.connected, true, 'sesi accel-ppp aktif = terhubung');
assert.strictEqual(viaPpp.reason, 'ppp');

const missing = Vpn.isConnected(null);
assert.strictEqual(missing.connected, false);

console.log('vpnNas.test.js: semua assertion lulus.');
