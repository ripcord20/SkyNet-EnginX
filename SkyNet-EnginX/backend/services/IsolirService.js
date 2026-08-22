/**
 * IsolirService.js
 * Isolir via MikroTik — mendukung 3 metode koneksi:
 *   1. REST API (RouterOS v7.1+, port 80/443)
 *   2. API Native v7 (port 8728/8729) — plain login
 *   3. API Native v6 (port 8728/8729) — challenge-response MD5
 * Mode 'auto' akan probe REST → Native v7 → Native v6 secara berurutan.
 */
const net      = require('net');
const tls      = require('tls');
const http     = require('http');
const https    = require('https');
const crypto   = require('crypto');
const { sequelize } = require('../models');
const { getCompanyName } = require('../utils/companyInfo');

const ADDRLIST    = 'FLAYNET-ISOLIR';
const COMMENT_SRC = 'FLAYNET-BLOCK-SRC';
const COMMENT_DST = 'FLAYNET-BLOCK-DST';

// Legacy comment patterns — supaya tetap kompatibel dengan rule lama yang dibuat
// versi sebelumnya (WAU). Setup firewall akan otomatis hapus rule legacy ini.
const LEGACY_ADDRLIST    = 'WAU-ISOLIR';
const LEGACY_COMMENT_SRC = 'WAU-BLOCK-SRC';
const LEGACY_COMMENT_DST = 'WAU-BLOCK-DST';

// ════════════════════════════════════════════════════════════════
// CLIENT 1: MikroTik Native API (port 8728 plain / 8729 SSL)
// ════════════════════════════════════════════════════════════════
// Mendukung baik RouterOS v6 (challenge-response MD5)
// maupun v7 (plain login). Pakai TCP socket native + binary protocol.
class MikroTikNativeAPI {
  constructor({ host, port, user, password, useSsl = false, timeout = 8000, forceVersion = 'auto' }) {
    this.host         = host;
    this.port         = port || (useSsl ? 8729 : 8728);
    this.user         = user;
    this.password     = password;
    this.useSsl       = !!useSsl;
    this.timeout      = timeout;
    this.forceVersion = forceVersion; // 'v6' | 'v7' | 'auto'
    this.sock         = null;
    this._buf         = Buffer.alloc(0);
    this._pending     = [];
    this.detectedVersion = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onConnect = async () => {
        try {
          await this._login();
          resolve(this);
        } catch(e) { reject(e); }
      };
      const opts = { host: this.host, port: this.port };
      if (this.useSsl) {
        // RouterOS pakai self-signed cert by default → tolerate
        this.sock = tls.connect({ ...opts, rejectUnauthorized: false }, onConnect);
      } else {
        this.sock = net.createConnection(opts, onConnect);
      }
      this.sock.setTimeout(this.timeout);
      this.sock.on('error', (err) => {
        // Berikan hint untuk error yang umum
        const msg = err.message || String(err);
        if (msg.includes('wrong version number') || msg.includes('EPROTO')) {
          return reject(new Error(
            'TLS handshake gagal (wrong version number). ' +
            'Penyebab: SSL/TLS aktif tapi port ' + this.port + ' adalah port plain (non-SSL). ' +
            'Solusi: matikan toggle SSL, ATAU ganti port ke 8729 (default API-SSL).'
          ));
        }
        if (msg.includes('ECONNREFUSED')) {
          return reject(new Error(
            `Koneksi ditolak ke ${this.host}:${this.port}. ` +
            `Pastikan service API aktif di MikroTik: /ip service enable api${this.useSsl ? '-ssl' : ''}`
          ));
        }
        if (msg.includes('ETIMEDOUT') || msg.includes('EHOSTUNREACH')) {
          return reject(new Error(`Router ${this.host} tidak terjangkau (timeout/unreachable). Cek IP & firewall.`));
        }
        reject(err);
      });
      this.sock.on('timeout', () => { try { this.sock.destroy(); } catch(_){}; reject(new Error('Connection timeout (' + this.timeout + 'ms)')); });
      this.sock.on('data', (data) => this._onData(data));
    });
  }

  async _login() {
    // Try plain login (v7 default): /login =name=... =password=...
    if (this.forceVersion === 'v7' || this.forceVersion === 'auto') {
      const res = await this._send(['/login', '=name=' + this.user, '=password=' + this.password]);
      const first = res[0];
      if (!first) throw new Error('No response from router');

      if (first.type === '!done' || first.type === '!empty') {
        // Plain login berhasil → ini RouterOS v7
        this.detectedVersion = 'v7';
        return;
      }

      if (first.type === '!trap') {
        const msg = first.message || first.msg || '';
        // Beberapa v7 dengan "user without password" return trap "invalid user name or password"
        if (this.forceVersion === 'v7') {
          throw new Error('Login v7 gagal: ' + msg);
        }
        // forceVersion === 'auto' → fallback ke v6 challenge-response
      }

      // v6: server kirim !done dengan ret=challenge_hex (post-handshake mode)
      if (first.ret) {
        await this._loginV6Challenge(first.ret);
        this.detectedVersion = 'v6';
        return;
      }

      // forceVersion === 'auto': server kirim !trap → coba v6 modern
      // (v6 mode: kirim /login kosong dulu, dapat challenge, lalu response)
      if (this.forceVersion === 'auto' && first.type === '!trap') {
        await this._loginV6Modern();
        this.detectedVersion = 'v6';
        return;
      }

      throw new Error('Login gagal: format response tidak dikenali');
    }

    // Force v6 challenge-response (legacy mode)
    if (this.forceVersion === 'v6') {
      await this._loginV6Modern();
      this.detectedVersion = 'v6';
      return;
    }
  }

  async _loginV6Modern() {
    // v6 flow: /login (no params) → !done with =ret=<hex challenge>
    const res = await this._send(['/login']);
    const first = res[0];
    if (!first || !first.ret) throw new Error('Login v6 gagal: tidak ada challenge');
    await this._loginV6Challenge(first.ret);
  }

  async _loginV6Challenge(challengeHex) {
    // response = MD5("\x00" + password + hex_to_bytes(challenge)) as hex
    const challengeBytes = Buffer.from(challengeHex, 'hex');
    const md5 = crypto.createHash('md5');
    md5.update(Buffer.from([0]));
    md5.update(this.password, 'utf8');
    md5.update(challengeBytes);
    const responseHex = '00' + md5.digest('hex');
    const res = await this._send(['/login', '=name=' + this.user, '=response=' + responseHex]);
    const first = res[0];
    if (!first) throw new Error('Login v6 gagal: tidak ada response');
    if (first.type === '!trap') {
      throw new Error('Login v6 gagal: ' + (first.message || first.msg || 'wrong credentials'));
    }
    // !done = success
  }

  _encodeLen(len) {
    if (len < 0x80)   return Buffer.from([len]);
    if (len < 0x4000) return Buffer.from([((len >> 8) & 0x3F) | 0x80, len & 0xFF]);
    if (len < 0x200000) return Buffer.from([((len >> 16) & 0x1F) | 0xC0, (len >> 8) & 0xFF, len & 0xFF]);
    return Buffer.from([((len >> 24) & 0x0F) | 0xE0, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
  }

  _encodeWord(word) {
    const wb = Buffer.from(word, 'utf8');
    return Buffer.concat([this._encodeLen(wb.length), wb]);
  }

  _encodeSentence(words) {
    const parts = words.map(w => this._encodeWord(w));
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
  }

  _send(words) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Command timeout')), this.timeout);
      this._pending.push({ resolve: (r) => { clearTimeout(timer); resolve(r); }, reject });
      this.sock.write(this._encodeSentence(words));
    });
  }

  _decodeLen(buf, pos) {
    const b = buf[pos];
    if ((b & 0xE0) === 0xE0) return { len: ((b & 0x0F) << 24) | (buf[pos+1] << 16) | (buf[pos+2] << 8) | buf[pos+3], skip: 4 };
    if ((b & 0xC0) === 0xC0) return { len: ((b & 0x1F) << 16) | (buf[pos+1] << 8) | buf[pos+2], skip: 3 };
    if ((b & 0x80) === 0x80) return { len: ((b & 0x3F) << 8) | buf[pos+1], skip: 2 };
    return { len: b, skip: 1 };
  }

  _onData(data) {
    this._buf = Buffer.concat([this._buf, data]);
    while (this._tryParse()) {}
  }

  _tryParse() {
    let pos  = 0;
    const buf = this._buf;
    const sentences = [];

    while (pos < buf.length) {
      if (buf.length - pos < 1) return false;
      const { len, skip } = this._decodeLen(buf, pos);
      pos += skip;

      if (len === 0) continue;
      if (pos + len > buf.length) return false;

      const word = buf.slice(pos, pos + len).toString('utf8');
      pos += len;

      const REPLY_TYPES = ['!done','!re','!trap','!fatal','!empty'];
      if (!REPLY_TYPES.includes(word)) continue;

      const sentence = { type: word };

      while (pos < buf.length) {
        const { len: wlen, skip: wskip } = this._decodeLen(buf, pos);
        if (wlen === 0) { pos += wskip; break; }
        if (pos + wskip + wlen > buf.length) {
          pos -= skip + len;
          return false;
        }
        pos += wskip;
        const attr = buf.slice(pos, pos + wlen).toString('utf8');
        pos += wlen;
        if (attr.startsWith('=')) {
          const eqIdx = attr.indexOf('=', 1);
          if (eqIdx > 0) sentence[attr.slice(1, eqIdx)] = attr.slice(eqIdx + 1);
          else sentence[attr.slice(1)] = '';
        } else if (attr.startsWith('.id=')) {
          sentence['.id'] = attr.slice(4);
        }
      }

      sentences.push(sentence);

      if (word === '!done' || word === '!trap' || word === '!fatal' || word === '!empty') {
        this._buf = buf.slice(pos);
        if (this._pending.length) this._pending.shift().resolve(sentences);
        return true;
      }
    }
    return false;
  }

  async run(words) {
    const res = await this._send(words);
    const trap = res.find(r => r.type === '!trap' || r.type === '!fatal');
    if (trap) throw new Error(trap.message || trap.msg || 'MikroTik error');
    return res.filter(r => r.type === '!re');
  }

  close() {
    try { this.sock?.destroy(); } catch(e) {}
  }
}

// ════════════════════════════════════════════════════════════════
// CLIENT 2: MikroTik REST API (RouterOS v7.1+, port 80/443)
// ════════════════════════════════════════════════════════════════
// Pakai endpoint /rest/* dengan HTTP Basic Auth.
// Lebih simple, tidak butuh socket persistent.
class MikroTikRestAPI {
  constructor({ host, port, user, password, useSsl = false, timeout = 8000 }) {
    this.host     = host;
    this.port     = port || (useSsl ? 443 : 80);
    this.user     = user;
    this.password = password;
    this.useSsl   = !!useSsl;
    this.timeout  = timeout;
    this.detectedVersion = 'v7-rest';
  }

  connect() {
    // REST stateless — verify dengan ping ke /rest/system/identity
    return this._request('GET', '/rest/system/identity').then(() => this);
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${this.user}:${this.password}`).toString('base64');

      // Pre-serialize body sebelum request supaya kita bisa set Content-Length
      // (MikroTik REST TIDAK support Transfer-Encoding: chunked yang akan
      // diaktifkan Node.js secara otomatis kalau Content-Length tidak di-set)
      let bodyBuf = null;
      if (body !== null && body !== undefined) {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        bodyBuf = Buffer.from(bodyStr, 'utf8');
      }

      const headers = {
        'Authorization': 'Basic ' + auth,
        'Accept':        'application/json',
      };
      if (bodyBuf) {
        headers['Content-Type']   = 'application/json';
        headers['Content-Length'] = bodyBuf.length;
      }

      const opts = {
        host:    this.host,
        port:    this.port,
        path,
        method,
        timeout: this.timeout,
        headers,
        rejectUnauthorized: false  // self-signed cert tolerated
      };

      const lib = this.useSsl ? https : http;
      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new Error('Login REST gagal: wrong credentials'));
          if (res.statusCode === 404) return reject(new Error('REST API tidak aktif (404). Aktifkan: /ip service enable www atau www-ssl'));
          if (res.statusCode >= 400) {
            // MikroTik REST error format: {"error":400,"message":"Bad Request","detail":"actual error"}
            let msg = data;
            try {
              const j = JSON.parse(data);
              const parts = [];
              if (j.message) parts.push(j.message);
              if (j.detail)  parts.push(j.detail);
              if (parts.length) msg = parts.join(' — ');
              else msg = data;
            } catch(_){}
            return reject(new Error(`REST ${res.statusCode} ${method} ${path}: ${msg}`));
          }
          try {
            const json = data ? JSON.parse(data) : null;
            resolve(json);
          } catch(e) { reject(new Error('Invalid JSON response: ' + e.message)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Connection timeout')); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  // Convert native API path/words → REST path + params
  // Native: ['/ip/firewall/filter/print', '?comment=FOO']
  //   → REST GET /rest/ip/firewall/filter?comment=FOO
  // Native: ['/ip/firewall/filter/add', '=chain=forward', '=action=drop']
  //   → REST PUT /rest/ip/firewall/filter  body={chain:'forward',action:'drop'}
  // Native: ['/ip/firewall/filter/remove', '=.id=*1A']
  //   → REST DELETE /rest/ip/firewall/filter/*1A
  async run(words) {
    if (!words || !words.length) throw new Error('Empty command');
    const cmd = words[0];                    // ex: /ip/firewall/filter/print
    const args = words.slice(1);

    // Parse command
    const parts = cmd.replace(/^\//, '').split('/');
    const verb  = parts[parts.length - 1];   // print | add | set | remove | enable | disable
    const path  = '/' + parts.slice(0, -1).join('/');

    // Parse args
    const params = {};   // dari ?key=val (filter saat print)
    const data   = {};   // dari =key=val (body untuk add/set)
    let id = null;
    for (const a of args) {
      if (a.startsWith('=.id=')) id = a.slice(5);
      else if (a.startsWith('=')) {
        const eq = a.indexOf('=', 1);
        if (eq > 0) {
          const k = a.slice(1, eq);
          const v = a.slice(eq + 1);
          if (k === '.id') id = v;
          else data[k] = v;
        }
      } else if (a.startsWith('?')) {
        const eq = a.indexOf('=', 1);
        if (eq > 0) params[a.slice(1, eq)] = a.slice(eq + 1);
      }
    }

    let url = '/rest' + path;
    let res;

    if (verb === 'print') {
      // GET dengan query string filter
      const qs = Object.keys(params).length
        ? '?' + Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        : '';
      res = await this._request('GET', url + qs);
      // REST return array of objects langsung
      if (Array.isArray(res)) {
        // Normalize: REST punya field ".id" sudah, jadi cocok.
        return res.map(r => ({ ...r }));
      }
      return [];
    }

    if (verb === 'add') {
      // REST: place-before dengan integer index TIDAK didukung. Yang didukung
      // adalah .id dari rule existing (untuk insert sebelum rule itu).
      // Karena kita biasanya ingin rule tetap di awal chain, strategi yang aman:
      //   1. Drop param place-before/place-after dari body (REST tolak integer)
      //   2. Setelah create, kalau perlu pindah, panggil 'move' dengan numbers=newId destination=0
      const wantPlaceBefore = data['place-before'];
      const wantPlaceAfter  = data['place-after'];
      delete data['place-before'];
      delete data['place-after'];

      // Normalisasi boolean yes/no → true/false untuk REST JSON.
      const BOOL_KEYS_ADD = ['disabled','bypassed','authorized'];
      for (const k of BOOL_KEYS_ADD) {
        if (data[k] === 'yes') data[k] = 'true';
        else if (data[k] === 'no') data[k] = 'false';
      }

      try {
        res = await this._request('PUT', url, data);
      } catch(e) {
        // Tampilkan body request supaya user bisa lihat field mana yang ditolak
        const dataPreview = JSON.stringify(data).slice(0, 200);
        throw new Error(e.message + ' [body: ' + dataPreview + ']');
      }
      const newId = (res && res['.id']) || (res && res.ret) || null;

      // Coba pindah ke posisi yang diminta (only kalau index numerik & rule ada)
      if (newId && (wantPlaceBefore != null || wantPlaceAfter != null)) {
        try {
          const dest = wantPlaceBefore != null ? wantPlaceBefore : wantPlaceAfter;
          // REST move endpoint: POST /rest/{path}/move {numbers: newId, destination: targetId}
          // Kalau destination integer 0/1 tidak diterima, fallback diam-diam.
          await this._request('POST', url + '/move',
            { numbers: newId, destination: String(dest) });
        } catch(_) { /* abaikan kalau gagal — rule tetap ada di akhir */ }
      }
      return [{ ret: newId, '.id': newId }];
    }

    if (verb === 'set') {
      if (!id) throw new Error('REST set butuh =.id=...');
      // RouterOS native pakai yes/no untuk boolean; REST JSON pakai true/false.
      // Normalisasi HANYA untuk field boolean yang dikenal supaya tidak salah
      // mengubah field teks yang kebetulan bernilai "yes"/"no".
      const BOOL_KEYS = ['disabled','bypassed','authorized'];
      for (const k of BOOL_KEYS) {
        if (data[k] === 'yes') data[k] = 'true';
        else if (data[k] === 'no') data[k] = 'false';
      }
      res = await this._request('PATCH', url + '/' + encodeURIComponent(id), data);
      return [];
    }

    if (verb === 'remove') {
      if (!id) throw new Error('REST remove butuh =.id=...');
      await this._request('DELETE', url + '/' + encodeURIComponent(id));
      return [];
    }

    if (verb === 'enable' || verb === 'disable') {
      if (!id) throw new Error('REST ' + verb + ' butuh =.id=...');
      await this._request('POST', url + '/' + verb,
        Object.assign({ numbers: id }, data));
      return [];
    }

    if (verb === 'move') {
      // Native: /ip/firewall/filter/move =numbers=*1A =destination=*2B
      // REST:   POST /rest/ip/firewall/filter/move {numbers, destination}
      // Args sudah ke-parse ke `data` (numbers, destination)
      await this._request('POST', url + '/move', data);
      return [];
    }

    // Generic POST untuk command lain (mis. /system/identity/print sudah di-handle di atas)
    res = await this._request('POST', url + '/' + verb, data);
    return Array.isArray(res) ? res : (res ? [res] : []);
  }

  close() {
    // stateless — no-op
  }
}

// ════════════════════════════════════════════════════════════════
// FACTORY: pilih API client berdasar device.api_mode
// ════════════════════════════════════════════════════════════════
//   api_mode: 'rest' | 'native_v7' | 'native_v6' | 'auto'
//   - 'auto'      : coba REST dulu (kalau use_ssl/use_rest), lalu Native v7, lalu v6
//   - 'rest'      : REST API saja
//   - 'native_v7' : Native API plain login (default)
//   - 'native_v6' : Native API challenge-response
async function createClient(device) {
  const mode = (device.api_mode || 'auto').toLowerCase();
  const useSsl  = !!device.use_ssl;
  const useRest = !!device.use_rest;

  const baseOpts = {
    host:     device.host,
    user:     device.username,
    password: device.password,
    useSsl,
    timeout:  parseInt(device.timeout) || 8000
  };

  // ── Mode: rest ──
  if (mode === 'rest') {
    const cli = new MikroTikRestAPI({ ...baseOpts, port: parseInt(device.rest_port) || (useSsl ? 443 : 80) });
    await cli.connect();
    return cli;
  }

  // ── Mode: native_v7 ──
  if (mode === 'native_v7') {
    const cli = new MikroTikNativeAPI({ ...baseOpts,
      port: parseInt(device.port) || (useSsl ? 8729 : 8728),
      forceVersion: 'v7'
    });
    await cli.connect();
    return cli;
  }

  // ── Mode: native_v6 ──
  if (mode === 'native_v6') {
    const cli = new MikroTikNativeAPI({ ...baseOpts,
      port: parseInt(device.port) || (useSsl ? 8729 : 8728),
      forceVersion: 'v6'
    });
    await cli.connect();
    return cli;
  }

  // ── Mode: auto (default) ──
  const errors = [];

  // 1. Coba REST kalau use_rest aktif (atau probe sekalian)
  if (useRest) {
    try {
      const cli = new MikroTikRestAPI({ ...baseOpts, port: parseInt(device.rest_port) || (useSsl ? 443 : 80) });
      await cli.connect();
      return cli;
    } catch(e) {
      errors.push('REST: ' + e.message);
      // Kalau TLS gagal di REST, coba sekali lagi tanpa SSL
      if (useSsl && /wrong version|EPROTO|SSL routines/i.test(e.message)) {
        try {
          const cli = new MikroTikRestAPI({ ...baseOpts, useSsl: false,
            port: parseInt(device.rest_port) || 80 });
          await cli.connect();
          return cli;
        } catch(e2) { errors.push('REST (no-SSL fallback): ' + e2.message); }
      }
    }
  }

  // 2. Coba Native dengan setting yang dikonfigurasi
  const nativePort = parseInt(device.port) || (useSsl ? 8729 : 8728);
  try {
    const cli = new MikroTikNativeAPI({ ...baseOpts, port: nativePort, forceVersion: 'auto' });
    await cli.connect();
    return cli;
  } catch(e) {
    errors.push('Native: ' + e.message);
    // Kalau TLS gagal, coba lagi tanpa SSL (kemungkinan port plain di-toggle SSL secara salah)
    if (useSsl && /wrong version|EPROTO|SSL routines/i.test(e.message)) {
      try {
        const cli = new MikroTikNativeAPI({ ...baseOpts, useSsl: false,
          port: parseInt(device.port) || 8728, forceVersion: 'auto' });
        await cli.connect();
        return cli;
      } catch(e2) { errors.push('Native (no-SSL fallback): ' + e2.message); }
    }
  }

  throw new Error('Semua metode koneksi gagal. ' + errors.join(' | '));
}

// ── Connect helper ─────────────────────────────────────────────
async function connectDevice(device) {
  return await createClient(device);
}

// ── Derive api_mode dari devices.api_protocol ──────────────────
// Berdasarkan keputusan design (Q2 opsi 2): mode 'auto' dihilangkan,
// koneksi mengikuti api_protocol di devices.
//   rest-http / rest-https → mode 'rest'
//   api-plain              → mode 'native_v7' (dengan auto-fallback ke v6 di createClient)
//   api-ssl                → mode 'native_v7' over SSL
//   null/unknown           → 'native_v7' sebagai default paling kompatibel
function deriveApiMode(apiProtocol) {
  if (apiProtocol === 'rest-http' || apiProtocol === 'rest-https') return 'rest';
  if (apiProtocol === 'api-plain' || apiProtocol === 'api-ssl')   return 'native_v7';
  return 'native_v7';
}

// ── Load device gabungan: mikrotik_devices (ext) + devices (master) ──
// Return: virtual device object yang dipakai createClient(),
// dengan field yang mirip skema lama supaya kode downstream minimal berubah.
//
// @param deviceId — mikrotik_devices.id (sama dengan customers.mikrotik_id)
// @param requireActive — kalau true, hanya return device aktif (is_active=1)
// @returns device object atau null kalau tidak ada
async function loadDeviceWithMaster(deviceId, requireActive = false) {
  const rows = await sequelize.query(
    `SELECT
        md.id           AS id,
        md.device_id    AS device_id,
        md.binary_port  AS binary_port,
        md.wan_interface,
        md.isolir_page_url,
        md.last_ping,
        md.status       AS ext_status,
        md.notes        AS ext_notes,
        d.id            AS master_id,
        d.name          AS name,
        d.ip_address    AS host,
        d.api_username  AS username,
        d.api_password  AS password,
        d.api_port      AS api_port,
        d.api_protocol  AS api_protocol,
        d.is_active     AS is_active,
        d.brand         AS brand,
        d.model         AS model,
        d.notes         AS notes
     FROM mikrotik_devices md
     INNER JOIN devices d ON d.id = md.device_id
     WHERE md.id = ? ${requireActive ? "AND d.is_active = 1" : ""}`,
    { replacements: [deviceId], type: sequelize.QueryTypes.SELECT }
  );
  const r = rows[0];
  if (!r) return null;

  // Build virtual device dengan field-naming yang dipakai createClient & downstream code
  const apiMode = deriveApiMode(r.api_protocol);
  const useSsl  = (r.api_protocol === 'rest-https' || r.api_protocol === 'api-ssl');

  // Port logic:
  //   - api_protocol = rest-http/rest-https  → port = devices.api_port (REST port)
  //   - api_protocol = api-plain/api-ssl     → port = devices.api_port (binary port custom)
  //   - binary_port di extension hanya jadi FALLBACK kalau api_port NULL
  //     (kasus jarang: device dengan api_port tidak di-set tapi pakai native binary)
  // Ini penting untuk handle custom port di /devices (mis. 235 untuk api-plain custom).
  const masterPort = r.api_port ? parseInt(r.api_port) : null;
  const binPortDefault = r.binary_port || (useSsl ? 8729 : 8728);
  const effectivePort = masterPort || binPortDefault;

  return {
    // Identity (untuk logging)
    id:           r.id,           // mikrotik_devices.id — dipakai customers.mikrotik_id, isolir_logs.device_id
    device_id:    r.device_id,    // devices.id — referensi master
    name:         r.name,
    host:         r.host,
    // Auth (dari devices/master)
    username:     r.username || 'admin',
    password:     r.password || '',
    // Port efektif untuk koneksi (rest atau native — sama-sama pakai devices.api_port)
    port:         effectivePort,
    rest_port:    (apiMode === 'rest') ? effectivePort : (r.api_port || (useSsl ? 443 : 80)),
    binary_port:  (apiMode === 'rest') ? binPortDefault : effectivePort,
    use_ssl:      useSsl ? 1 : 0,
    api_mode:     apiMode,
    use_rest:     (apiMode === 'rest') ? 1 : 0,
    api_protocol: r.api_protocol,
    is_active:    r.is_active,
    // Isolir-specific (dari mikrotik_devices/ext)
    wan_interface:   r.wan_interface || 'ether1',
    isolir_page_url: r.isolir_page_url,
    last_ping:       r.last_ping,
    status:          r.ext_status,
    notes:           r.ext_notes || r.notes
  };
}

// ── Test koneksi ───────────────────────────────────────────────
async function testConnection(deviceId) {
  const device = await loadDeviceWithMaster(deviceId, false);
  if (!device) throw new Error('Device tidak ditemukan');
  try {
    const api = await connectDevice(device);
    const identityRows = await api.run(['/system/identity/print']);
    let resourceRows = [];
    try { resourceRows = await api.run(['/system/resource/print']); } catch(_) {}
    api.close();

    const identity   = identityRows[0]?.name || 'MikroTik';
    const rosVersion = resourceRows[0]?.version || resourceRows[0]?.['version'] || null;
    const board      = resourceRows[0]?.['board-name'] || null;
    const apiMode    = api.detectedVersion || 'unknown';

    await sequelize.query("UPDATE mikrotik_devices SET status='online', last_ping=NOW() WHERE id=?",
      { replacements: [deviceId] });
    return {
      success:    true,
      identity,
      host:       device.host,
      ros_version: rosVersion,
      board,
      api_mode:   apiMode    // 'v7-rest' | 'v7' | 'v6'
    };
  } catch(e) {
    await sequelize.query("UPDATE mikrotik_devices SET status='offline', last_ping=NOW() WHERE id=?",
      { replacements: [deviceId] });
    throw e;
  }
}

// ── Setup firewall (sekali per device) ─────────────────────────
// V2: dengan DST-NAT redirect HTTP ke halaman isolir + bypass list.
// Logic dipindah ke IsolirFirewallV2.js untuk pemisahan tanggung jawab.
// File ini hanya menyediakan koneksi & migrasi address-list legacy.
async function setupFirewall(deviceId) {
  const device = await loadDeviceWithMaster(deviceId, true);
  if (!device) throw new Error('Device tidak ditemukan atau tidak aktif');

  const FirewallV2 = require('./IsolirFirewallV2');
  const api = await connectDevice(device);
  const results = [];
  try {
    // ── Migrasi address-list legacy WAU-ISOLIR → FLAYNET-ISOLIR ──
    // Tetap dipertahankan supaya upgrade dari versi lama tidak kehilangan
    // pelanggan yang sudah ter-isolir di address-list lama.
    let migrated = 0;
    try {
      const legacyEntries = await api.run(['/ip/firewall/address-list/print', '?list=' + LEGACY_ADDRLIST]);
      for (const e of legacyEntries) {
        if (!e.address) continue;
        const existsInNew = await api.run(['/ip/firewall/address-list/print',
          '?list=' + ADDRLIST, '?address=' + e.address]);
        if (existsInNew.length === 0) {
          await api.run(['/ip/firewall/address-list/add',
            '=list=' + ADDRLIST, '=address=' + e.address,
            '=comment=' + (e.comment || '').replace(/^WAU-/, 'FLAYNET-')]);
          migrated++;
        }
        if (e['.id']) await api.run(['/ip/firewall/address-list/remove', '=.id=' + e['.id']]);
      }
      if (migrated > 0) results.push(`✓ ${migrated} IP dimigrasi dari ${LEGACY_ADDRLIST} → ${ADDRLIST}`);
    } catch(e) { /* legacy list mungkin tidak ada — abaikan */ }

    // ── Delegate ke V2: DST-NAT + bypass + drop ──
    const v2Result = await FirewallV2.setupFirewallV2(api, device);
    results.push(...(v2Result.details || []));

    if (v2Result.errors && v2Result.errors.length) {
      // Sebagian gagal — return success=false agar user tahu
      api.close();
      return { success: false, message: v2Result.errors.join('; '), details: results };
    }

    await sequelize.query("UPDATE mikrotik_devices SET status='online', last_ping=NOW() WHERE id=?",
      { replacements: [deviceId] });
  } finally { try { api.close(); } catch(_){} }

  return { success: true, details: results };
}

// ── Isolir satu pelanggan ──────────────────────────────────────
async function isolirCustomer(customerId, triggerBy = 'admin', adminUserId = null) {
  // Step 1: ambil customer + extension ID
  const custRows = await sequelize.query(
    `SELECT c.* FROM customers c WHERE c.id=?`,
    { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
  );
  const cust = custRows[0];
  if (!cust)             throw new Error('Pelanggan tidak ditemukan');
  if (!cust.mikrotik_id) throw new Error('MikroTik device belum dipilih');

  // Step 2: load device gabungan (ext + master)
  const device = await loadDeviceWithMaster(cust.mikrotik_id, true);
  if (!device) throw new Error('Device MikroTik tidak ditemukan atau tidak aktif');

  // Gabung properties device ke cust supaya connectDevice(cust) tetap jalan
  // (createClient hanya butuh host/username/password/port/use_ssl/api_mode/use_rest/rest_port)
  Object.assign(cust, {
    host: device.host, username: device.username, password: device.password,
    port: device.port, use_ssl: device.use_ssl, api_mode: device.api_mode,
    use_rest: device.use_rest, rest_port: device.rest_port,
    device_name: device.name
  });

  // ── Auto-detect method: hotspot binding / static IP / PPPoE ──
  // Penentu utama: customers.connection_type (eksplisit, kalau diisi).
  //   'hotspot' → IP Binding disable/enable (butuh mac_address ATAU static_ip)
  //   'static'  → firewall address-list FLAYNET-ISOLIR
  //   'pppoe'   → switch profile + kick session
  // Fallback (data lama tanpa connection_type): prioritas static_ip → pppoe.
  const connType = (cust.connection_type || '').toLowerCase();
  const hasStatic   = !!cust.static_ip;
  const hasPPPoE    = !!cust.pppoe_username;
  const hasHotspot  = connType === 'hotspot' && (!!cust.mac_address || hasStatic);

  let method;
  if (hasHotspot)                          method = 'hotspot_binding';
  else if (connType === 'pppoe' && hasPPPoE) method = 'pppoe';
  else if (connType === 'static' && hasStatic) method = 'static';
  else if (hasStatic)                      method = 'static';   // fallback legacy
  else if (hasPPPoE)                        method = 'pppoe';    // fallback legacy
  else {
    throw new Error('Pelanggan belum punya MAC/Static IP (hotspot) maupun PPPoE Username');
  }

  if (cust.isolir_status === 'isolated') return { success: true, message: 'Sudah diisolir', skipped: true };

  const ip = cust.static_ip || null;
  const pppoeUser = cust.pppoe_username || null;
  let success = false, errorMsg = null, addrlistId = null, methodDetail = null;

  try {
    const api = await connectDevice(cust);
    try {
      if (method === 'hotspot_binding') {
        // ── Method hotspot: disable IP binding + kick session ──
        // FIX: pakai instance MikrotikService (jalur sama dgn UI) supaya set
        // disabled benar-benar tereksekusi & konsisten. Resolusi via devices.id
        // (device.device_id = master), bukan native client terpisah.
        const IsolirHotspotBinding = require('./IsolirHotspotBinding');
        const { getMikrotikInstanceByDevice } = require('./MikrotikService');
        const mt = await getMikrotikInstanceByDevice(device.device_id);
        const result = await IsolirHotspotBinding.isolirHotspotBinding(mt, {
          static_ip: ip, mac_address: cust.mac_address, customer_id: cust.customer_id,
        });
        addrlistId = result.bindingId;
        methodDetail = result.message;
      } else if (method === 'static') {
        // ── Method static: tambah IP ke address-list FLAYNET-ISOLIR ──
        const existing = await api.run(['/ip/firewall/address-list/print',
          '?list=' + ADDRLIST, '?address=' + ip]);
        if (existing.length > 0) {
          addrlistId = existing[0]['.id'];
          await api.run(['/ip/firewall/address-list/enable', '=.id=' + addrlistId]);
        } else {
          const res = await api.run(['/ip/firewall/address-list/add',
            '=list=' + ADDRLIST, '=address=' + ip, '=comment=FLAYNET-ISOLIR-' + customerId]);
          addrlistId = res[0]?.ret || null;
        }
        methodDetail = `IP ${ip} ditambahkan ke ${ADDRLIST}`;
      } else {
        // ── Method PPPoE: switch profile + kick session ──
        const IsolirPPPoE = require('./IsolirPPPoE');
        const result = await IsolirPPPoE.isolirPPPoEUser(api, pppoeUser, sequelize, customerId);
        methodDetail = result.message;
      }
      success = true;
    } finally {
      try { api.close(); } catch(_) {}
    }
  } catch(e) { errorMsg = e.message; }

  if (success) {
    await sequelize.query(
      "UPDATE customers SET isolir_status='isolated', isolir_at=NOW(), status='isolated' WHERE id=?",
      { replacements: [customerId] });
    // Notif panel
    try {
      const N = require('./NotificationService');
      const subjLabel = method === 'static'  ? `IP ${ip}`
                      : method === 'hotspot_binding' ? `Hotspot ${cust.mac_address || ip}`
                      : `PPPoE "${pppoeUser}"`;
      await N.pushAll({ type:'isolir', title:`Isolir: ${cust.name} (${cust.customer_id})`,
        message:`${subjLabel} diblokir karena tagihan overdue`, severity:'warning', action_url:'/isolir' });
    } catch(e) {}
    // Notif WA ke pelanggan
    await sendIsolirWA(cust, 'isolir');
    // Push notif ke pelanggan (browser/APK) — fire-and-forget
    try {
      await require('./PushService').sendIsolirNotif(customerId, cust.name, cust.customer_id);
    } catch (e) { console.warn('[Isolir] push isolir gagal: ' + e.message); }
  }
  await logIsolir({
    customer_id: customerId, device_id: cust.mikrotik_id,
    static_ip: ip, pppoe_username: pppoeUser, isolir_method: method,
    action: 'isolir', trigger_by: triggerBy, triggered_by_user: adminUserId,
    addrlist_id: addrlistId, success, error_msg: errorMsg
  });

  const subj = method === 'static'  ? `(${ip})`
             : method === 'hotspot_binding' ? `(Hotspot: ${cust.mac_address || ip})`
             : `(PPPoE: ${pppoeUser})`;
  return { success, message: success ? `${cust.name} ${subj} berhasil diisolir — ${methodDetail}` : errorMsg };
}

// ── Restore satu pelanggan ─────────────────────────────────────
async function restoreCustomer(customerId, triggerBy = 'admin', adminUserId = null) {
  const custRows = await sequelize.query(
    `SELECT c.* FROM customers c WHERE c.id=?`,
    { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
  );
  const cust = custRows[0];
  if (!cust)             throw new Error('Pelanggan tidak ditemukan');
  if (!cust.mikrotik_id) throw new Error('MikroTik device belum dipilih');

  const device = await loadDeviceWithMaster(cust.mikrotik_id, true);
  if (!device) throw new Error('Device MikroTik tidak ditemukan atau tidak aktif');

  Object.assign(cust, {
    host: device.host, username: device.username, password: device.password,
    port: device.port, use_ssl: device.use_ssl, api_mode: device.api_mode,
    use_rest: device.use_rest, rest_port: device.rest_port,
    device_name: device.name
  });

  // ── Auto-detect method (sama seperti isolir) ──
  const connType = (cust.connection_type || '').toLowerCase();
  const hasStatic   = !!cust.static_ip;
  const hasPPPoE    = !!cust.pppoe_username;
  const hasHotspot  = connType === 'hotspot' && (!!cust.mac_address || hasStatic);

  let method;
  if (hasHotspot)                          method = 'hotspot_binding';
  else if (connType === 'pppoe' && hasPPPoE) method = 'pppoe';
  else if (connType === 'static' && hasStatic) method = 'static';
  else if (hasStatic)                      method = 'static';   // fallback legacy
  else if (hasPPPoE)                        method = 'pppoe';    // fallback legacy
  else {
    throw new Error('Pelanggan belum punya MAC/Static IP (hotspot) maupun PPPoE Username');
  }

  if (cust.isolir_status === 'active') return { success: true, message: 'Sudah aktif', skipped: true };

  const ip = cust.static_ip || null;
  const pppoeUser = cust.pppoe_username || null;
  let success = false, errorMsg = null, methodDetail = null;

  try {
    const api = await connectDevice(cust);
    try {
      if (method === 'hotspot_binding') {
        // ── Method hotspot: enable kembali IP binding (jalur MikrotikService) ──
        const IsolirHotspotBinding = require('./IsolirHotspotBinding');
        const { getMikrotikInstanceByDevice } = require('./MikrotikService');
        const mt = await getMikrotikInstanceByDevice(device.device_id);
        const result = await IsolirHotspotBinding.restoreHotspotBinding(mt, {
          static_ip: ip, mac_address: cust.mac_address, customer_id: cust.customer_id,
        });
        methodDetail = result.message;
      } else if (method === 'static') {
        // ── Method static: hapus dari address-list ──
        for (const list of [ADDRLIST, LEGACY_ADDRLIST]) {
          const existing = await api.run(['/ip/firewall/address-list/print',
            '?list=' + list, '?address=' + ip]);
          for (const e of existing) {
            if (e['.id']) await api.run(['/ip/firewall/address-list/remove', '=.id=' + e['.id']]);
          }
        }
        methodDetail = `IP ${ip} dihapus dari ${ADDRLIST}`;
      } else {
        // ── Method PPPoE: restore profile asli + kick ──
        const IsolirPPPoE = require('./IsolirPPPoE');
        const result = await IsolirPPPoE.restorePPPoEUser(
          api, pppoeUser, cust.pppoe_profile_original
        );
        methodDetail = result.message;
      }
      success = true;
    } finally {
      try { api.close(); } catch(_) {}
    }
  } catch(e) { errorMsg = e.message; }

  if (success) {
    await sequelize.query(
      "UPDATE customers SET isolir_status='active', isolir_at=NULL, status='active' WHERE id=?",
      { replacements: [customerId] });
    // Notif panel
    try {
      const N = require('./NotificationService');
      const subjLabel = method === 'static'  ? `IP ${ip}`
                      : method === 'hotspot_binding' ? `Hotspot ${cust.mac_address || ip}`
                      : `PPPoE "${pppoeUser}"`;
      await N.pushAll({ type:'restore', title:`Restore: ${cust.name} (${cust.customer_id})`,
        message:`Akses ${subjLabel} dipulihkan`, severity:'info', action_url:'/isolir' });
    } catch(e) {}
    // Notif WA ke pelanggan
    await sendIsolirWA(cust, 'restore');
    // Push notif ke pelanggan (browser/APK) — fire-and-forget
    try {
      await require('./PushService').sendRestoreNotif(customerId, cust.name, cust.customer_id);
    } catch (e) { console.warn('[Restore] push restore gagal: ' + e.message); }
  }
  await logIsolir({
    customer_id: customerId, device_id: cust.mikrotik_id,
    static_ip: ip, pppoe_username: pppoeUser, isolir_method: method,
    action: 'restore', trigger_by: triggerBy, triggered_by_user: adminUserId,
    addrlist_id: null, success, error_msg: errorMsg
  });

  const subj = method === 'static'  ? `(${ip})`
             : method === 'hotspot_binding' ? `(Hotspot: ${cust.mac_address || ip})`
             : `(PPPoE: ${pppoeUser})`;
  return { success, message: success ? `${cust.name} ${subj} berhasil di-restore — ${methodDetail}` : errorMsg };
}

// ── Cek master switch auto-isolir ──────────────────────────────
// Mengembalikan true HANYA jika isolir_auto_enable = '1'.
// Dipakai untuk memblokir SEMUA jalur isolir OTOMATIS (batch cron,
// evaluasi event seperti payment-revert / invoice-delete) ketika admin
// menonaktifkan auto-isolir. Isolir MANUAL (tombol admin) tidak lewat sini.
async function isAutoIsolirEnabled() {
  const rows = await sequelize.query(
    "SELECT value FROM app_settings WHERE `key`='isolir_auto_enable'",
    { type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  return rows[0]?.value === '1';
}

// ── Auto isolir batch ──────────────────────────────────────────
// opts.force = true → jalankan meski master switch auto-isolir mati
// (dipakai tombol MANUAL "Jalankan Auto Isolir" di panel admin).
// Cron TIDAK pernah force, jadi tetap menghormati switch.
async function runAutoIsolir(opts = {}) {
  // Hormati master switch: kalau auto-isolir dimatikan, jangan isolir apa pun
  // (kecuali dipanggil manual dengan force=true).
  if (!opts.force && !(await isAutoIsolirEnabled())) {
    return { success: true, skipped: true, isolated: 0, reason: 'auto-isolir dinonaktifkan' };
  }
  const graceSetting = await sequelize.query(
    "SELECT value FROM app_settings WHERE `key`='isolir_grace_days'",
    { type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  const graceDays = parseInt(graceSetting[0]?.value || '0');

  // Cari pelanggan yang harus diisolir. Dua sumber "overdue":
  //   (A) punya invoice unpaid/overdue dgn due_date sudah lewat grace, ATAU
  //   (B) customers.due_date sendiri sudah lewat grace (fallback untuk kasus
  //       invoice belum ter-generate / due_date diset manual). Ini menyamakan
  //       perilaku dengan badge "Overdue" di halaman customer yang juga membaca
  //       customers.due_date langsung.
  const overdueCustomers = await sequelize.query(
    `SELECT c.id FROM customers c
      WHERE c.status='active' AND c.isolir_status='active'
        AND ( (c.static_ip IS NOT NULL AND c.static_ip!='')
           OR (c.pppoe_username IS NOT NULL AND c.pppoe_username!='')
           OR (c.connection_type='hotspot' AND c.mac_address IS NOT NULL AND c.mac_address!='') )
        AND c.mikrotik_id IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM invoices i
             WHERE i.customer_id = c.id
               AND i.status IN ('unpaid','overdue')
               AND DATE(i.due_date) <= DATE_SUB(CURDATE(), INTERVAL ${graceDays} DAY)
          )
          OR (
            c.due_date IS NOT NULL
            AND DATE(c.due_date) <= DATE_SUB(CURDATE(), INTERVAL ${graceDays} DAY)
            AND NOT EXISTS (
              SELECT 1 FROM invoices i2
               WHERE i2.customer_id = c.id
                 AND i2.status = 'paid'
                 AND DATE(i2.due_date) >= DATE(c.due_date)
            )
          )
        )`,
    { type: sequelize.QueryTypes.SELECT }
  );

  let isolated = 0, failed = 0;
  for (const row of overdueCustomers) {
    try {
      const r = await isolirCustomer(row.id, 'cron');
      if (r.success && !r.skipped) isolated++;
    } catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 500));
  }
  return { isolated, failed, total: overdueCustomers.length };
}

// ── Restore setelah bayar ──────────────────────────────────────
async function restoreAfterPayment(customerId) {
  const rows = await sequelize.query(
    'SELECT isolir_status FROM customers WHERE id=?',
    { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
  );
  if (rows[0]?.isolir_status === 'isolated') return restoreCustomer(customerId, 'payment');
  return { success: true, skipped: true };
}

// ── Re-evaluate satu customer: kalau memenuhi kriteria isolir, isolir-kan ──
// Dipanggil oleh PaymentController.destroy setelah payment dihapus.
// Idempotent: kalau customer sudah ter-isolir → skip diam-diam.
async function evaluateCustomer(customerId, triggerBy = 'payment_revert') {
  // Hormati master switch auto-isolir. Evaluasi ini dipicu oleh event
  // (payment-revert, invoice-delete, dsb) — semuanya termasuk isolir OTOMATIS,
  // jadi harus di-skip ketika admin menonaktifkan auto-isolir.
  if (!(await isAutoIsolirEnabled())) {
    return { success: true, skipped: true, reason: 'auto-isolir dinonaktifkan' };
  }
  // Ambil grace setting
  const graceSetting = await sequelize.query(
    "SELECT value FROM app_settings WHERE `key`='isolir_grace_days'",
    { type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  const graceDays = parseInt(graceSetting[0]?.value || '0');

  // Cek apakah customer ini memenuhi kriteria isolir:
  //   - status active + isolir_status active (belum ter-isolir)
  //   - punya static_ip ATAU pppoe_username + mikrotik_id
  //   - punya invoice unpaid/overdue dengan due_date sudah lewat grace days
  const rows = await sequelize.query(
    `SELECT c.id
       FROM customers c
      WHERE c.id = ?
        AND c.status = 'active'
        AND c.isolir_status = 'active'
        AND ( (c.static_ip IS NOT NULL AND c.static_ip != '')
           OR (c.pppoe_username IS NOT NULL AND c.pppoe_username != '')
           OR (c.connection_type='hotspot' AND c.mac_address IS NOT NULL AND c.mac_address != '') )
        AND c.mikrotik_id IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM invoices i
             WHERE i.customer_id = c.id
               AND i.status IN ('unpaid','overdue')
               AND DATE(i.due_date) <= DATE_SUB(CURDATE(), INTERVAL ${graceDays} DAY)
          )
          OR (
            c.due_date IS NOT NULL
            AND DATE(c.due_date) <= DATE_SUB(CURDATE(), INTERVAL ${graceDays} DAY)
            AND NOT EXISTS (
              SELECT 1 FROM invoices i2
               WHERE i2.customer_id = c.id
                 AND i2.status = 'paid'
                 AND DATE(i2.due_date) >= DATE(c.due_date)
            )
          )
        )
      LIMIT 1`,
    { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
  );

  if (rows.length === 0) {
    return { success: true, skipped: true, reason: 'tidak memenuhi kriteria isolir' };
  }

  return await isolirCustomer(customerId, triggerBy);
}

// ── Log ────────────────────────────────────────────────────────
async function logIsolir({ customer_id, device_id, static_ip, pppoe_username, isolir_method, action, trigger_by, triggered_by_user, addrlist_id, success, error_msg }) {
  // Coba INSERT dengan kolom baru. Kalau migration belum jalan (kolom belum ada),
  // fallback ke schema lama supaya tidak menggagalkan operasi isolir/restore.
  try {
    await sequelize.query(
      `INSERT INTO isolir_logs (customer_id,device_id,static_ip,pppoe_username,isolir_method,action,trigger_by,triggered_by_user,addrlist_id,success,error_msg)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      { replacements: [
        customer_id, device_id||null, static_ip||null, pppoe_username||null,
        isolir_method||'static', action, trigger_by, triggered_by_user||null,
        addrlist_id||null, success?1:0, error_msg||null
      ]}
    );
  } catch (e) {
    if (/Unknown column/i.test(e.message || '')) {
      // Fallback schema lama
      await sequelize.query(
        `INSERT INTO isolir_logs (customer_id,device_id,static_ip,action,trigger_by,triggered_by_user,addrlist_id,success,error_msg)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        { replacements: [customer_id, device_id||null, static_ip||pppoe_username||'-', action, trigger_by, triggered_by_user||null, addrlist_id||null, success?1:0, error_msg||null] }
      ).catch(err => console.error('[IsolirService] log fallback error:', err.message));
    } else {
      console.error('[IsolirService] log error:', e.message);
    }
  }
}

// ── Render template dengan placeholder (sinkron dengan WaFeaturesController) ──
function _renderTemplate(content, ctx) {
  if (!content) return '';
  let out = String(content);
  Object.keys(ctx || {}).forEach(k => {
    const val = ctx[k] == null ? '' : String(ctx[k]);
    out = out.split(`{${k}}`).join(val);
  });
  return out;
}

// ── Default template fallback (kalau DB tidak punya / belum di-seed) ──
const DEFAULT_TPL_ISOLIR = `*Pemberitahuan Isolir*

Yth. *{nama}*,

Layanan internet Anda dengan ID *{cid}* telah diisolir karena tagihan belum dibayar.

Silakan lakukan pembayaran untuk memulihkan layanan.

Terima kasih 🙏`;

const DEFAULT_TPL_RESTORE = `*Layanan Dipulihkan*

Yth. *{nama}*,

Layanan internet Anda dengan ID *{cid}* telah aktif kembali.

Terima kasih telah melakukan pembayaran 🙏`;

// ── Kirim notif WA ke pelanggan ───────────────────────────────
// Kirim notifikasi isolir/restore via email (paralel dengan WA).
// Best-effort: aktif hanya bila smtp_enabled='1', dan pelanggan punya email.
async function sendIsolirEmail(cust, action, ctx, plainMsg) {
  try {
    if (!cust || !cust.email) return;
    const en = await sequelize.query(
      "SELECT value FROM app_settings WHERE `key`='smtp_enabled'",
      { type: sequelize.QueryTypes.SELECT }
    );
    if (en[0]?.value !== '1') return;

    const EmailService = require('./EmailService');
    const company = (ctx && ctx.perusahaan) || 'Internet Service';
    const isIsolir = action === 'isolir';
    const accent = isIsolir ? '#dc2626' : '#16a34a';
    const title  = isIsolir ? 'Layanan Internet Dinonaktifkan' : 'Layanan Internet Diaktifkan Kembali';
    const lead   = isIsolir
      ? 'Layanan internet Anda untuk sementara kami nonaktifkan karena tagihan belum dibayar.'
      : 'Layanan internet Anda telah aktif kembali. Terima kasih atas pembayarannya.';
    const payBtn = (isIsolir && ctx && ctx.url && ctx.url !== '-')
      ? `<div style="text-align:center;margin:18px 0;"><a href="${ctx.url}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;font-size:14px;">Bayar Sekarang</a></div>`
      : '';
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;background:#f8faff;padding:24px;">
      <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e8eef7;">
        <div style="background:${accent};padding:20px 24px;">
          <div style="color:#fff;font-size:18px;font-weight:800;">${company}</div>
          <div style="color:rgba(255,255,255,.9);font-size:13px;margin-top:2px;">${title}</div>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 14px;color:#0f172a;font-size:14px;">Halo <b>${cust.name || 'Pelanggan'}</b>,</p>
          <p style="margin:0 0 16px;color:#475569;font-size:13.5px;line-height:1.6;">${lead}</p>
          <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
            <tr><td style="padding:8px 0;color:#64748b;">Customer ID</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;">${(ctx && ctx.cid) || cust.customer_id || '-'}</td></tr>
            ${isIsolir && ctx && ctx.tagihan ? `<tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Total Tagihan</td><td style="padding:8px 0;text-align:right;font-weight:700;color:${accent};border-top:1px solid #eef2f9;">${ctx.tagihan}</td></tr>` : ''}
          </table>
          ${payBtn}
          <p style="margin:18px 0 0;color:#94a3b8;font-size:11.5px;line-height:1.6;text-align:center;">Email otomatis dari sistem ${company}.</p>
        </div>
      </div>
    </div>`;
    await EmailService.send({
      to: cust.email,
      subject: `${title} — ${company}`,
      html,
      text: (plainMsg || lead).replace(/[*_~`]/g, ''),
      type: 'isolir'
    });
  } catch (e) {
    console.error('[IsolirService] sendIsolirEmail error:', e.message);
  }
}

async function sendIsolirWA(cust, action) {
  try {
    // Cek setting notif WA aktif
    const settings = await sequelize.query(
      "SELECT value FROM app_settings WHERE `key`='isolir_notify_wa'",
      { type: sequelize.QueryTypes.SELECT }
    );
    const waOn = settings[0]?.value === '1';

    // Bangun context minimal untuk email (kalau WA tidak jalan tapi email bisa).
    const buildCtxLite = async () => {
      let inv = null;
      try {
        const r = await sequelize.query(
          `SELECT i.invoice_number, i.amount FROM invoices i WHERE i.customer_id = ? ORDER BY i.due_date DESC LIMIT 1`,
          { replacements: [cust.id], type: sequelize.QueryTypes.SELECT }
        );
        inv = r[0] || null;
      } catch(_){}
      let url = '-';
      try {
        const u = await sequelize.query("SELECT value FROM app_settings WHERE `key`='isolir_page_url' LIMIT 1", { type: sequelize.QueryTypes.SELECT });
        url = (u[0]?.value || '').trim() || '-';
      } catch(_){}
      return {
        cid: cust.customer_id || '',
        tagihan: 'Rp ' + Number(inv?.amount || 0).toLocaleString('id-ID'),
        url,
        perusahaan: await getCompanyName()
      };
    };

    // Kalau WA nonaktif atau tidak ada nomor → coba email saja (kalau ada), lalu selesai.
    if (!waOn || !cust.phone) {
      if (cust.email) { try { await sendIsolirEmail(cust, action, await buildCtxLite(), null); } catch(_) {} }
      return;
    }

    const GatewayService = require('./GatewayService');
    const { WaSession } = require('../models');
    const session = await GatewayService.getDefaultSendingSession();
    if (!session) {
      if (cust.email) { try { await sendIsolirEmail(cust, action, await buildCtxLite(), null); } catch(_) {} }
      return;
    }

    // Build context placeholder
    let invoiceData = null;
    try {
      const inv = await sequelize.query(
        `SELECT i.invoice_number, i.amount, i.due_date, p.name AS package_name
           FROM invoices i
           LEFT JOIN customers c ON c.id = i.customer_id
           LEFT JOIN packages   p ON p.id = c.package_id
          WHERE i.customer_id = ?
          ORDER BY i.due_date DESC LIMIT 1`,
        { replacements: [cust.id], type: sequelize.QueryTypes.SELECT }
      );
      invoiceData = inv[0] || null;
    } catch(_) {}

    const fmtIDR  = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
    const fmtDate = d => {
      if (!d) return '-';
      try {
        const dt = new Date(d);
        const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
      } catch(_) { return String(d); }
    };

    const ctx = {
      nama:            cust.name || '',
      cid:             cust.customer_id || '',
      phone:           cust.phone || '',
      invoice:         invoiceData?.invoice_number || '-',
      jumlah:          fmtIDR(invoiceData?.amount),
      tgl_jatuh_tempo: fmtDate(invoiceData?.due_date),
      jatuh_tempo:     fmtDate(invoiceData?.due_date),
      tgl_bayar:       fmtDate(new Date()),
      paket:           invoiceData?.package_name || '-',
      perusahaan:      await getCompanyName(),
      // Alias placeholder yang dipakai di panel Settings (isolir_wa_message)
      tagihan:         fmtIDR(invoiceData?.amount),
      url:             await (async () => {
        try {
          const u = await sequelize.query(
            "SELECT value FROM app_settings WHERE `key`='isolir_page_url' LIMIT 1",
            { type: sequelize.QueryTypes.SELECT }
          );
          return (u[0]?.value || '').trim() || '-';
        } catch(_) { return '-'; }
      })(),
      // Backward compat
      customer_id:     cust.customer_id || '',
      static_ip:       cust.static_ip || '-'
    };

    // Prioritas template pesan isolir/restore:
    //   1. Setting app_settings 'isolir_wa_message' (khusus isolir, dari panel Settings)
    //   2. wa_templates kategori isolir/restore yang aktif
    //   3. hardcoded default
    const category = action === 'isolir' ? 'isolir' : 'restore';
    let template = null;
    if (action === 'isolir') {
      try {
        const sRows = await sequelize.query(
          "SELECT value FROM app_settings WHERE `key`='isolir_wa_message' LIMIT 1",
          { type: sequelize.QueryTypes.SELECT }
        );
        const v = sRows[0]?.value;
        if (v && String(v).trim()) template = v;
      } catch(_) {}
    }
    if (!template) {
      try {
        const rows = await sequelize.query(
          `SELECT content, message FROM wa_templates
            WHERE category = ? AND is_active = 1
            ORDER BY updated_at DESC LIMIT 1`,
          { replacements: [category], type: sequelize.QueryTypes.SELECT }
        );
        template = rows[0]?.content || rows[0]?.message || null;
      } catch(_) {}
    }

    // Fallback ke hardcoded default kalau template tidak ada di DB
    if (!template) {
      template = action === 'isolir' ? DEFAULT_TPL_ISOLIR : DEFAULT_TPL_RESTORE;
    }

    const msg = _renderTemplate(template, ctx);

    await GatewayService.sendMessage(session.session_id, cust.phone, msg, null);

    // Kirim juga via Email (best-effort, paralel) bila pelanggan punya email
    try { await sendIsolirEmail(cust, action, ctx, msg); } catch(_) {}

    // Update usage counter (best-effort)
    try {
      await sequelize.query(
        `UPDATE wa_templates SET usage_count = usage_count + 1
          WHERE category = ? AND is_active = 1
          ORDER BY updated_at DESC LIMIT 1`,
        { replacements: [category] }
      );
    } catch(_) {}
  } catch(e) {
    console.error('[IsolirService] sendIsolirWA error:', e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// AUTO-MIGRATION: Restruktur mikrotik_devices jadi extension table
// dari `devices`. devices = master (auth+host), mikrotik_devices = isolir-specific.
//
// Migration steps (idempotent — aman dipanggil berkali-kali):
//   1. Pastikan tabel mikrotik_devices ada (kalau fresh install)
//   2. Tambah kolom legacy yang mungkin belum ada (untuk DB lama yang belum
//      pernah melewati ensureSchema versi lama) — supaya step 4 bisa baca
//   3. Tambah kolom baru: device_id (FK→devices.id), binary_port
//   4. Migrate data: link tiap row ke devices.id (match by host=ip_address,
//      atau auto-insert ke devices kalau belum ada)
//   5. Kalau semua row sudah punya device_id, DROP kolom legacy
// ════════════════════════════════════════════════════════════════
async function ensureSchema() {
  try {
    // ── 1. Pastikan tabel mikrotik_devices ada (fresh install) ──
    // CATATAN: kolom legacy (host/port/dst.) dibuat dengan NULL-able supaya
    // migration step 4 tidak gagal saat insert "empty extension" untuk
    // fresh install. Setelah step 5 DROP, kolom-kolom ini hilang sama sekali.
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS mikrotik_devices (
        id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NULL,
        host VARCHAR(100) NULL,
        port SMALLINT UNSIGNED DEFAULT 8728,
        username VARCHAR(100) NULL,
        password VARCHAR(255) NULL,
        use_ssl TINYINT(1) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        wan_interface VARCHAR(50) DEFAULT 'ether1',
        notes TEXT NULL,
        status ENUM('online','offline','unknown') NOT NULL DEFAULT 'unknown',
        last_ping DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── 2. Cek kolom yang sudah ada (untuk handle skema legacy) ──
    let cols = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mikrotik_devices'`,
      { type: sequelize.QueryTypes.SELECT }
    );
    let have = new Set(cols.map(c => c.COLUMN_NAME));

    // Tambah kolom legacy yang mungkin belum ada (untuk DB lama) — supaya
    // step 4 bisa baca tanpa error. Kalau sudah ada, skip.
    const legacyAlters = [];
    if (!have.has('api_mode')) {
      legacyAlters.push("ADD COLUMN `api_mode` ENUM('auto','rest','native_v7','native_v6') NOT NULL DEFAULT 'auto'");
    }
    if (!have.has('use_rest')) {
      legacyAlters.push("ADD COLUMN `use_rest` TINYINT(1) NOT NULL DEFAULT 0");
    }
    if (!have.has('rest_port')) {
      legacyAlters.push("ADD COLUMN `rest_port` SMALLINT UNSIGNED DEFAULT NULL");
    }
    if (!have.has('isolir_page_url')) {
      legacyAlters.push("ADD COLUMN `isolir_page_url` VARCHAR(500) DEFAULT NULL");
    }
    if (legacyAlters.length) {
      try {
        await sequelize.query(`ALTER TABLE mikrotik_devices ${legacyAlters.join(', ')}`);
        console.log('[IsolirService] mikrotik_devices legacy columns added:', legacyAlters.length);
      } catch(e) {
        if (!/duplicate column|already exists/i.test(e.message || '')) {
          console.error('[IsolirService] add legacy columns error:', e.message);
        }
      }
      // Refresh cols list
      cols = await sequelize.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mikrotik_devices'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      have = new Set(cols.map(c => c.COLUMN_NAME));
    }

    // ── 3. Tambah kolom baru: device_id (FK→devices.id) dan binary_port ──
    const newAlters = [];
    if (!have.has('device_id')) {
      // device_id boleh NULL dulu — diisi di step 4. Setelah migrasi, kolom
      // ini akan jadi NOT NULL + UNIQUE (di step 5).
      // Tipe INT (signed) untuk match devices.id (Sequelize default).
      newAlters.push("ADD COLUMN `device_id` INT DEFAULT NULL");
    }
    if (!have.has('binary_port')) {
      newAlters.push("ADD COLUMN `binary_port` SMALLINT UNSIGNED DEFAULT 8728");
    }
    if (newAlters.length) {
      try {
        await sequelize.query(`ALTER TABLE mikrotik_devices ${newAlters.join(', ')}`);
        console.log('[IsolirService] mikrotik_devices ext columns added:', newAlters.length);
      } catch(e) {
        if (!/duplicate column|already exists/i.test(e.message || '')) {
          console.error('[IsolirService] add ext columns error:', e.message);
        }
      }
    }

    // ── 3b. Pastikan kolom legacy NULLABLE (idempotent, jalan tiap startup) ──
    // Skema lama membuat host/username/password/dst sebagai NOT NULL tanpa
    // default. Kalau step 5 (DROP) belum/tidak berhasil jalan, INSERT extension
    // baru akan gagal "Field 'host' doesn't have a default value". Dengan
    // membuat kolom-kolom ini NULLABLE di sini, INSERT skema baru selalu aman
    // meski kolom legacy masih ada. MODIFY ke NULL aman dijalankan berulang.
    const legacyNullable = [
      { col: 'name',     def: 'VARCHAR(100) NULL' },
      { col: 'host',     def: 'VARCHAR(100) NULL' },
      { col: 'port',     def: 'SMALLINT UNSIGNED NULL DEFAULT 8728' },
      { col: 'username', def: 'VARCHAR(100) NULL' },
      { col: 'password', def: 'VARCHAR(255) NULL' },
      { col: 'use_ssl',  def: 'TINYINT(1) NULL DEFAULT 0' },
      { col: 'is_active', def: 'TINYINT(1) NULL DEFAULT 1' },
      { col: 'api_mode', def: "ENUM('auto','rest','native_v7','native_v6') NULL DEFAULT 'auto'" },
      { col: 'use_rest', def: 'TINYINT(1) NULL DEFAULT 0' },
      { col: 'rest_port', def: 'SMALLINT UNSIGNED NULL DEFAULT NULL' },
    ];
    const nullableAlters = legacyNullable
      .filter(x => have.has(x.col))
      .map(x => `MODIFY COLUMN \`${x.col}\` ${x.def}`);
    if (nullableAlters.length) {
      try {
        await sequelize.query(`ALTER TABLE mikrotik_devices ${nullableAlters.join(', ')}`);
        console.log('[IsolirService] legacy columns set NULLABLE:', nullableAlters.length);
      } catch(e) {
        console.error('[IsolirService] set legacy nullable error:', e.message);
      }
    }

    // ── 4. Migrate data: link row mikrotik_devices ke devices ──
    //   a. Cari di devices: ip_address=host AND type='router'
    //   b. Kalau ketemu → UPDATE device_id, copy binary_port dari port lama
    //   c. Kalau tidak ketemu → INSERT ke devices, SET device_id ke ID baru
    //
    // Pengecualian: row yang host=NULL (mis. extension yang dibuat fresh
    // di skema baru via dropdown UI) di-skip.
    let migrated = 0, inserted = 0, skipped = 0;
    if (have.has('host')) {  // ada kolom legacy → kemungkinan ada data lama
      const orphans = await sequelize.query(
        `SELECT id, name, host, port, username, password, use_ssl, is_active,
                api_mode, use_rest, rest_port, notes
         FROM mikrotik_devices
         WHERE (device_id IS NULL OR device_id = 0)
           AND host IS NOT NULL AND host != ''`,
        { type: sequelize.QueryTypes.SELECT }
      );

      for (const row of orphans) {
        try {
          // a. Cari device yang match by IP & type
          const match = await sequelize.query(
            `SELECT id FROM devices WHERE ip_address = ? AND type = 'router' LIMIT 1`,
            { replacements: [row.host], type: sequelize.QueryTypes.SELECT }
          );

          let deviceId = match[0]?.id;

          // b. Kalau tidak match, insert ke devices
          if (!deviceId) {
            // Derive api_protocol dari kombinasi use_rest + use_ssl
            // (mapping balik dari skema lama → enum devices)
            let apiProtocol = 'rest-http';
            let apiPort = 80;
            const useRest = row.use_rest == 1 || row.api_mode === 'rest';
            const useSsl  = row.use_ssl == 1;

            if (useRest) {
              apiProtocol = useSsl ? 'rest-https' : 'rest-http';
              apiPort = row.rest_port || (useSsl ? 443 : 80);
            } else {
              // native API binary
              apiProtocol = useSsl ? 'api-ssl' : 'api-plain';
              apiPort = row.port || (useSsl ? 8729 : 8728);
            }

            const insertResult = await sequelize.query(
              `INSERT INTO devices
               (name, ip_address, type, brand, monitoring_type,
                api_username, api_password, api_port, api_protocol,
                is_active, notes, status, createdAt, updatedAt)
               VALUES (?, ?, 'router', 'MikroTik', 'api',
                       ?, ?, ?, ?, ?, ?, 'offline', NOW(), NOW())`,
              { replacements: [
                row.name || ('Router ' + row.host),
                row.host,
                row.username || 'admin',
                row.password || '',
                apiPort,
                apiProtocol,
                row.is_active == 1 ? 1 : 0,
                row.notes || null
              ]}
            );
            deviceId = insertResult[0];  // lastInsertId
            inserted++;
            console.log(`[IsolirService] migrated mikrotik_devices.id=${row.id} → NEW devices.id=${deviceId} (${row.host})`);
          } else {
            console.log(`[IsolirService] migrated mikrotik_devices.id=${row.id} → EXISTING devices.id=${deviceId} (${row.host})`);
          }

          // c. Update mikrotik_devices: set device_id + binary_port
          // binary_port = port lama kalau port itu binary (8728/8729),
          // selain itu default 8728.
          const binPort = (row.port == 8728 || row.port == 8729) ? row.port : 8728;
          await sequelize.query(
            `UPDATE mikrotik_devices SET device_id=?, binary_port=? WHERE id=?`,
            { replacements: [deviceId, binPort, row.id] }
          );
          migrated++;
        } catch(e) {
          skipped++;
          console.error(`[IsolirService] migrate row id=${row.id} failed:`, e.message);
        }
      }

      if (migrated > 0 || inserted > 0) {
        console.log(`[IsolirService] data migration: ${migrated} rows linked, ${inserted} new devices inserted, ${skipped} skipped`);
      }
    }

    // ── 5. Kalau semua row sudah punya device_id, drop kolom legacy ──
    // Cek ada-tidaknya row yang belum termigrasi (device_id IS NULL)
    const [[unmigrated]] = await sequelize.query(
      "SELECT COUNT(*) AS cnt FROM mikrotik_devices WHERE device_id IS NULL"
    );

    if (unmigrated && parseInt(unmigrated.cnt) === 0) {
      // Safe to drop legacy columns. Idempotent — pakai try/catch per-column.
      const legacyColsToDrop = [
        'name', 'host', 'port', 'username', 'password',
        'use_ssl', 'is_active', 'api_mode', 'use_rest', 'rest_port'
      ];
      const colsAfter = await sequelize.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mikrotik_devices'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      const haveAfter = new Set(colsAfter.map(c => c.COLUMN_NAME));

      const dropList = legacyColsToDrop.filter(c => haveAfter.has(c)).map(c => `DROP COLUMN \`${c}\``);
      if (dropList.length) {
        try {
          await sequelize.query(`ALTER TABLE mikrotik_devices ${dropList.join(', ')}`);
          console.log('[IsolirService] dropped legacy columns from mikrotik_devices:', dropList.length);
        } catch(e) {
          console.error('[IsolirService] drop legacy columns error:', e.message);
        }
      }

      // Make device_id NOT NULL + UNIQUE (kalau belum)
      try {
        await sequelize.query('ALTER TABLE mikrotik_devices MODIFY COLUMN `device_id` INT NOT NULL');
      } catch(_) {}

      // Cek apakah UNIQUE index sudah ada
      const idx = await sequelize.query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mikrotik_devices'
           AND COLUMN_NAME = 'device_id' AND NON_UNIQUE = 0`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (idx.length === 0) {
        try {
          await sequelize.query('ALTER TABLE mikrotik_devices ADD UNIQUE KEY uk_device_id (`device_id`)');
          console.log('[IsolirService] added UNIQUE constraint on mikrotik_devices.device_id');
        } catch(e) {
          // duplicate keys? log tapi jangan stop
          if (!/duplicate/i.test(e.message || '')) {
            console.error('[IsolirService] add UNIQUE on device_id error:', e.message);
          }
        }
      }
    } else if (unmigrated && parseInt(unmigrated.cnt) > 0) {
      console.warn(`[IsolirService] ⚠️ ${unmigrated.cnt} mikrotik_devices rows BELUM punya device_id — kolom legacy TIDAK di-drop (cek log error di atas)`);
    }

    // ── 1b. Kolom pppoe_profile_original di customers (untuk restore profile asli) ──
    try {
      const cCols = await sequelize.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      const cHave = new Set(cCols.map(c => c.COLUMN_NAME));
      if (cHave.has('pppoe_username') && !cHave.has('pppoe_profile_original')) {
        await sequelize.query(
          'ALTER TABLE customers ADD COLUMN `pppoe_profile_original` VARCHAR(100) DEFAULT NULL AFTER `pppoe_username`'
        );
        console.log('[IsolirService] customers.pppoe_profile_original added');
      }
      // Kolom untuk metode Hotspot IP Binding
      const custAlters = [];
      if (!cHave.has('connection_type')) {
        custAlters.push("ADD COLUMN `connection_type` ENUM('pppoe','static','hotspot') DEFAULT NULL AFTER `static_ip`");
      }
      if (!cHave.has('mac_address')) {
        custAlters.push("ADD COLUMN `mac_address` VARCHAR(20) DEFAULT NULL AFTER `static_ip`");
      }
      if (custAlters.length) {
        await sequelize.query(`ALTER TABLE customers ${custAlters.join(', ')}`);
        console.log('[IsolirService] customers hotspot columns added:', custAlters.length);
      }
    } catch(e) {
      if (!/duplicate column|already exists/i.test(e.message || '')) {
        console.error('[IsolirService] alter customers error:', e.message);
      }
    }

    // ── 1c. Kolom isolir_method di isolir_logs ──
    try {
      const lCols = await sequelize.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'isolir_logs'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (lCols.length > 0) {  // table exists
        const lHave = new Set(lCols.map(c => c.COLUMN_NAME));
        const lAlters = [];
        if (!lHave.has('isolir_method')) {
          lAlters.push("ADD COLUMN `isolir_method` ENUM('static','pppoe','hotspot_binding') DEFAULT 'static' AFTER `action`");
        }
        if (!lHave.has('pppoe_username')) {
          lAlters.push("ADD COLUMN `pppoe_username` VARCHAR(100) DEFAULT NULL AFTER `static_ip`");
        }
        if (lAlters.length) {
          await sequelize.query(`ALTER TABLE isolir_logs ${lAlters.join(', ')}`);
          console.log('[IsolirService] isolir_logs schema migrated:', lAlters.length, 'columns');
        }
        // Pastikan enum isolir_method sudah punya 'hotspot_binding' (tabel lama)
        if (lHave.has('isolir_method')) {
          try {
            await sequelize.query(
              "ALTER TABLE isolir_logs MODIFY COLUMN `isolir_method` ENUM('static','pppoe','hotspot_binding') DEFAULT 'static'"
            );
          } catch (_) {}
        }
        // static_ip NULL-able (kalau dulu NOT NULL)
        try {
          await sequelize.query('ALTER TABLE isolir_logs MODIFY COLUMN `static_ip` VARCHAR(50) NULL');
        } catch (_) {}
      }
    } catch(e) { /* abaikan */ }

    // ── 1d. Default settings PPPoE isolir (kalau belum ada) ──
    try {
      const defaults = [
        ['isolir_pppoe_profile_name', 'isolir-profile', 'string', 'Nama PPP profile untuk pelanggan diisolir'],
        ['isolir_pppoe_pool_name',    'isolir-pool',    'string', 'Nama IP pool untuk pelanggan PPPoE diisolir'],
        ['isolir_pppoe_pool_range',   '10.255.255.2-10.255.255.254', 'string', 'Range IP pool isolir'],
        ['isolir_pppoe_local_addr',   '10.255.255.1',   'string', 'Local-address PPP profile isolir (gateway)'],
        ['isolir_pppoe_rate_limit',   '128k/128k',      'string', 'Rate-limit PPP profile isolir (rx/tx)'],
      ];
      for (const [key, value, type, description] of defaults) {
        await sequelize.query(
          `INSERT IGNORE INTO app_settings (\`key\`, value, type, description) VALUES (?, ?, ?, ?)`,
          { replacements: [key, value, type, description] }
        );
      }
    } catch(e) { /* abaikan */ }


    // ── 2. Expand ENUM wa_templates.category — tambah 'isolir','restore' ──
    try {
      const [enumRow] = await sequelize.query(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wa_templates' AND COLUMN_NAME = 'category'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (enumRow && !String(enumRow.COLUMN_TYPE || '').includes("'isolir'")) {
        await sequelize.query(
          `ALTER TABLE wa_templates MODIFY COLUMN category
           ENUM('reminder_before','reminder_due','reminder_overdue',
                'broadcast','custom','payment_confirm','isolir','restore')
           NOT NULL DEFAULT 'custom'`
        );
        console.log('[IsolirService] wa_templates.category ENUM expanded with isolir & restore');
      }
    } catch(e) {
      console.error('[IsolirService] expand wa_templates ENUM error:', e.message);
    }

    // ── 3. Auto-seed default templates isolir & restore ──
    try {
      const existing = await sequelize.query(
        `SELECT id, name, category FROM wa_templates WHERE category IN ('isolir','restore')`,
        { type: sequelize.QueryTypes.SELECT }
      );
      const haveIsolir  = existing.some(t => t.category === 'isolir');
      const haveRestore = existing.some(t => t.category === 'restore');

      const defaultIsolir = `🔴 *Pemberitahuan Isolir*

Yth. *{nama}*,

Layanan internet Anda dengan ID *{cid}* telah diisolir karena tagihan belum dibayar.

📄 Invoice: {invoice}
💰 Jumlah: {jumlah}
📅 Jatuh tempo: {tgl_jatuh_tempo}

Silakan lakukan pembayaran untuk memulihkan layanan.

Terima kasih 🙏
_${`{perusahaan}`}_`;

      const defaultRestore = `*Layanan Dipulihkan*

Yth. *{nama}*,

Layanan internet Anda dengan ID *{cid}* telah aktif kembali.

Invoice: {invoice}
Dibayar: {jumlah}
Tanggal bayar: {tgl_bayar}

Terima kasih telah melakukan pembayaran 🙏
_${`{perusahaan}`}_`;

      const variables = ['nama','cid','invoice','jumlah','tgl_jatuh_tempo','tgl_bayar','perusahaan','paket','phone'];

      if (!haveIsolir) {
        await sequelize.query(
          `INSERT INTO wa_templates (name, category, content, message, variables, is_active, created_at, updated_at)
           VALUES (?, 'isolir', ?, ?, ?, 1, NOW(), NOW())`,
          { replacements: ['Notifikasi Isolir Pelanggan', defaultIsolir, defaultIsolir, JSON.stringify(variables)] }
        );
        console.log('[IsolirService] seeded default isolir template');
      }
      if (!haveRestore) {
        await sequelize.query(
          `INSERT INTO wa_templates (name, category, content, message, variables, is_active, created_at, updated_at)
           VALUES (?, 'restore', ?, ?, ?, 1, NOW(), NOW())`,
          { replacements: ['Notifikasi Restore Layanan', defaultRestore, defaultRestore, JSON.stringify(variables)] }
        );
        console.log('[IsolirService] seeded default restore template');
      }
    } catch(e) {
      console.error('[IsolirService] seed templates error:', e.message);
    }

    // ── Seed default setting auto-isolir (hanya kalau belum ada) ──────
    // isolir_auto_enable='1' → auto-isolir aktif; isolir_grace_days='0' → isolir
    // langsung saat invoice overdue (tanpa masa tenggang). Pakai INSERT IGNORE
    // pola: cek dulu, jangan overwrite kalau admin sudah mengubahnya.
    try {
      const defaults = [
        ['isolir_auto_enable', '1'],
        ['isolir_grace_days',  '0'],
        ['isolir_notify_wa',   '1'],
      ];
      for (const [k, v] of defaults) {
        const exist = await sequelize.query(
          'SELECT 1 FROM app_settings WHERE `key`=? LIMIT 1',
          { replacements: [k], type: sequelize.QueryTypes.SELECT }
        ).catch(() => []);
        if (!exist.length) {
          await sequelize.query(
            'INSERT INTO app_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value`=`value`',
            { replacements: [k, v] }
          ).catch(() => {});
          console.log(`[IsolirService] seeded ${k}=${v}`);
        }
      }
    } catch(e) {
      console.error('[IsolirService] seed isolir settings error:', e.message);
    }
  } catch(e) {
    console.error('[IsolirService] ensureSchema error:', e.message);
  }
}

// Jalankan migration di module load (tidak block, fire-and-forget)
ensureSchema();


module.exports = { connectDevice, setupFirewall, testConnection, isolirCustomer, restoreCustomer, runAutoIsolir, restoreAfterPayment, evaluateCustomer, ensureSchema, loadDeviceWithMaster, deriveApiMode };
