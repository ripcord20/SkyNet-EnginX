/**
 * MikrotikApiClient.js
 *
 * Binary API client untuk MikroTik RouterOS v6 dan v7 di port 8728 (plain) / 8729 (SSL).
 * Modul ini menyediakan:
 *   1. Class MikrotikApiClient — koneksi socket persistent + RouterOS binary protocol
 *      (encode length, sentence framing, login plain v7 + challenge-response MD5 v6)
 *   2. Method-method REST-style (get/post/put/patch/delete) yang menerjemahkan
 *      path REST ("/queue/simple", "/ppp/active/{id}/remove", dll) menjadi
 *      command API native ("/queue/simple/print", "/ppp/active/remove" dengan
 *      argumen =numbers=), agar drop-in compatible dengan MikrotikService.
 *   3. Helper getInterfaceStats() — pakai command monitor-traffic once
 *
 * Implementasi protokol diadaptasi dari MikroTikNativeAPI di IsolirService.js
 * yang sudah teruji untuk operasi firewall di production.
 */

"use strict";

const net    = require('net');
const tls    = require('tls');
const crypto = require('crypto');
const logger = require('../utils/logger');

// ════════════════════════════════════════════════════════════════
// Konstanta protokol
// ════════════════════════════════════════════════════════════════
const REPLY_TYPES = ['!done', '!re', '!trap', '!fatal', '!empty'];
const DEFAULT_CONNECT_TIMEOUT = 8000;
const DEFAULT_CMD_TIMEOUT     = 15000;

// ════════════════════════════════════════════════════════════════
// MikrotikApiClient
// ════════════════════════════════════════════════════════════════
class MikrotikApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port            — default 8728 plain / 8729 SSL
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {boolean} opts.useSSL         — default: port===8729 → true
   * @param {number} opts.timeout         — connect + per-command timeout (ms)
   * @param {'auto'|'v6'|'v7'} opts.forceVersion
   */
  constructor(opts = {}) {
    this.host         = opts.host;
    this.port         = parseInt(opts.port) || (opts.useSSL ? 8729 : 8728);
    this.username     = opts.username || 'admin';
    this.password     = opts.password || '';
    this.useSSL       = opts.useSSL != null ? !!opts.useSSL : (parseInt(this.port) === 8729);
    this.timeout      = opts.timeout || DEFAULT_CONNECT_TIMEOUT;
    this.forceVersion = opts.forceVersion || 'auto';

    this.sock              = null;
    this._buf              = Buffer.alloc(0);
    this._pending          = [];
    this.detectedVersion   = null;
    this._connectPromise   = null;  // single in-flight connect promise (anti-race)
    this._connected        = false;
    this._sendMutex        = Promise.resolve();  // serialize concurrent _send calls
  }

  // ── Konektivitas + login ────────────────────────────────────
  /**
   * Buat koneksi + login. Idempotent — kalau sudah connected, return langsung.
   * Pemakai harus pastikan close() dipanggil setelah selesai untuk free socket.
   */
  connect() {
    if (this._connected && this.sock && !this.sock.destroyed) return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve, reject) => {
      // Settle guard: pastikan resolve/reject hanya berlaku sekali.
      // Tanpa ini, error event yang fire SETELAH socket-level error (mis. TLS
      // handshake fail → multiple emit) bisa coba reject promise yang sudah settled.
      // Listener juga tetap aktif setelah settled — mereka bisa expose stray
      // rejection ke event loop yang lolos jadi unhandledRejection → uncaught.
      let settled = false;
      const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
      const safeReject  = (e) => { if (!settled) { settled = true; reject(e);  } };

      const onConnect = async () => {
        try {
          await this._login();
          this._connected = true;
          safeResolve(this);
        } catch (err) {
          try { this.sock?.destroy(); } catch (_) {}
          safeReject(err);
        }
      };

      const sockOpts = { host: this.host, port: this.port };
      if (this.useSSL) {
        // rejectUnauthorized:false karena RouterOS biasanya pakai self-signed cert.
        // minVersion: 'TLSv1' supaya kompatibel dengan RouterOS lama yang masih
        // negosiasi TLSv1.0/1.1 (RouterOS modern default TLSv1.2+).
        this.sock = tls.connect({
          ...sockOpts,
          rejectUnauthorized: false,
          minVersion: 'TLSv1',
        }, onConnect);
      } else {
        this.sock = net.createConnection(sockOpts, onConnect);
      }

      this.sock.setTimeout(this.timeout);
      // PENTING: socket-level error MUST destroy socket. Tanpa destroy, TLS
      // socket yang gagal handshake bisa terus emit event di event loop
      // berikutnya dan beberapa di antaranya tidak ke-handle → uncaughtException.
      this.sock.on('error', (err) => {
        try { this.sock?.destroy(); } catch (_) {}
        // Translate ke pesan yg actionable kalau bisa, lalu reject.
        this._onSocketError(err, safeReject);
      });
      this.sock.on('timeout', () => this._onSocketTimeout(safeReject));
      this.sock.on('data',    (d)   => this._onData(d));
      this.sock.on('close',   ()    => {
        this._connected = false;
        // Kalau close terjadi sebelum promise settled (handshake gagal tanpa
        // 'error' event yang sempat fire — jarang tapi mungkin), pastikan
        // promise reject supaya caller tidak menggantung.
        safeReject(new Error(`Koneksi ke ${this.host}:${this.port} ditutup sebelum login selesai`));
      });
    });

    // Clear in-flight promise setelah settle (sukses atau gagal) — supaya reconnect ke depan boleh.
    // .catch(() => {}) di sini WAJIB supaya kalau caller tidak chain .catch ke connect(),
    // promise reject tidak jadi unhandled rejection → uncaught exception.
    this._connectPromise.catch(() => {}).finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  _onSocketError(err, reject) {
    const msg = err.message || String(err);
    if (msg.includes('wrong version number') || msg.includes('EPROTO')) {
      return reject(new Error(
        `TLS handshake gagal di ${this.host}:${this.port}. ` +
        `SSL aktif tapi port mungkin plain. Coba matikan SSL atau pakai port 8729.`
      ));
    }
    if (msg.includes('handshake failure') || msg.includes('SSL') || err.code === 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE') {
      return reject(new Error(
        `TLS handshake gagal di ${this.host}:${this.port}: ${msg.split('\n')[0]}. ` +
        `Periksa apakah port menggunakan SSL (api-ssl: 8729) dan sertifikat router sah.`
      ));
    }
    if (msg.includes('ECONNREFUSED')) {
      return reject(new Error(
        `Koneksi ditolak ke ${this.host}:${this.port}. ` +
        `Pastikan service API aktif di MikroTik: /ip service enable api${this.useSSL ? '-ssl' : ''}`
      ));
    }
    if (msg.includes('ETIMEDOUT') || msg.includes('EHOSTUNREACH')) {
      return reject(new Error(`Router ${this.host}:${this.port} tidak terjangkau.`));
    }
    reject(err);
  }

  _onSocketTimeout(reject) {
    try { this.sock?.destroy(); } catch (_) {}
    reject(new Error(`Connection timeout (${this.timeout}ms)`));
  }

  async _login() {
    // v7: plain login → /login =name=... =password=...
    if (this.forceVersion === 'v7' || this.forceVersion === 'auto') {
      const res = await this._send(['/login', '=name=' + this.username, '=password=' + this.password]);
      const first = res[0];
      if (!first) throw new Error('No response from router');

      // Urutan cek penting:
      //   1) `first.ret` ada     → server kirim challenge (v6 post-handshake). Selesaikan dulu.
      //   2) !done / !empty       → v7 plain login success (tanpa challenge)
      //   3) !trap                → v6 legacy auth, fallback ke _loginV6Modern
      // Kalau cek (2) didahulukan, response v6 "!done dengan ret=challenge" akan
      // salah dianggap v7 success.
      if (first.ret) {
        await this._loginV6Challenge(first.ret);
        this.detectedVersion = 'v6';
        return;
      }

      // CATATAN: reply marker tersimpan di key '_replyType' (bukan 'type'),
      // karena 'type' bisa berupa attribute RouterOS sungguhan (mis. /interface
      // → type=ether/vlan/dst). Lihat _tryParse() utk rationale.
      if (first._replyType === '!done' || first._replyType === '!empty') {
        this.detectedVersion = 'v7';
        return;
      }

      // v6 (legacy mode): server kirim !trap → fallback ke flow modern
      if (first._replyType === '!trap') {
        if (this.forceVersion === 'v7') {
          throw new Error('Login v7 gagal: ' + (first.message || first.msg || 'wrong credentials'));
        }
        await this._loginV6Modern();
        this.detectedVersion = 'v6';
        return;
      }

      throw new Error('Login gagal: format response tidak dikenali');
    }

    // forceVersion === 'v6'
    await this._loginV6Modern();
    this.detectedVersion = 'v6';
  }

  async _loginV6Modern() {
    // v6 legacy flow: /login (tanpa argumen) → !done with ret=challenge
    const res = await this._send(['/login']);
    const first = res[0];
    if (!first || !first.ret) throw new Error('Login v6 gagal: tidak ada challenge dari router');
    await this._loginV6Challenge(first.ret);
  }

  async _loginV6Challenge(challengeHex) {
    // response = "00" + hex(MD5(\x00 + password + challenge_bytes))
    const challengeBytes = Buffer.from(challengeHex, 'hex');
    const md5 = crypto.createHash('md5');
    md5.update(Buffer.from([0]));
    md5.update(this.password, 'utf8');
    md5.update(challengeBytes);
    const responseHex = '00' + md5.digest('hex');
    const res = await this._send(['/login', '=name=' + this.username, '=response=' + responseHex]);
    const first = res[0];
    if (!first) throw new Error('Login v6 gagal: tidak ada response');
    if (first._replyType === '!trap') {
      throw new Error('Login v6 gagal: ' + (first.message || first.msg || 'wrong credentials'));
    }
  }

  // ── Encoder / decoder protokol RouterOS API ─────────────────
  _encodeLen(len) {
    if (len < 0x80)     return Buffer.from([len]);
    if (len < 0x4000)   return Buffer.from([((len >> 8) & 0x3F) | 0x80, len & 0xFF]);
    if (len < 0x200000) return Buffer.from([((len >> 16) & 0x1F) | 0xC0, (len >> 8) & 0xFF, len & 0xFF]);
    return Buffer.from([((len >> 24) & 0x0F) | 0xE0, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
  }

  _encodeWord(word) {
    const wb = Buffer.from(word, 'utf8');
    return Buffer.concat([this._encodeLen(wb.length), wb]);
  }

  _encodeSentence(words) {
    const parts = words.map(w => this._encodeWord(w));
    parts.push(Buffer.from([0]));  // sentence terminator
    return Buffer.concat(parts);
  }

  _send(words, cmdTimeout) {
    // Serialize semua _send call: socket binary protocol tidak menjamin reply order
    // ketika command di-interleave. Mutex memastikan command-N selesai (reply
    // !done/!trap/!fatal) sebelum command-(N+1) dikirim ke socket.
    const next = this._sendMutex.then(() => this._sendInternal(words, cmdTimeout));
    // Mutex tidak boleh reject — kalau command-N gagal, command-(N+1) tetap boleh jalan
    this._sendMutex = next.then(() => {}, () => {});
    return next;
  }

  _sendInternal(words, cmdTimeout) {
    return new Promise((resolve, reject) => {
      const tmo = cmdTimeout || DEFAULT_CMD_TIMEOUT;
      const timer = setTimeout(() => {
        // Hapus pending entry yang ini supaya tidak nyangkut
        const idx = this._pending.findIndex(p => p._timer === timer);
        if (idx >= 0) this._pending.splice(idx, 1);
        reject(new Error('Command timeout'));
      }, tmo);
      const entry = {
        _timer: timer,
        _acc: [],   // akumulator !re lintas chunk TCP (untuk command streaming spt ip-scan)
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject:  (e) => { clearTimeout(timer); reject(e); }
      };
      this._pending.push(entry);
      try {
        this.sock.write(this._encodeSentence(words));
      } catch (err) {
        const i = this._pending.indexOf(entry);
        if (i >= 0) this._pending.splice(i, 1);
        clearTimeout(timer);
        reject(err);
      }
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
    let pos = 0;
    const buf = this._buf;

    while (pos < buf.length) {
      if (buf.length - pos < 1) return false;
      const startPos = pos;
      const { len, skip } = this._decodeLen(buf, pos);
      pos += skip;
      if (len === 0) continue;
      if (pos + len > buf.length) return false;

      const word = buf.slice(pos, pos + len).toString('utf8');
      pos += len;

      if (!REPLY_TYPES.includes(word)) continue;

      // CATATAN BUG-FIX:
      // Reply marker disimpan di key '_replyType' (bukan 'type') supaya tidak bentrok
      // dengan attribute RouterOS sungguhan bernama 'type'.
      const sentence = { _replyType: word };

      let incomplete = false;
      while (pos < buf.length) {
        const { len: wlen, skip: wskip } = this._decodeLen(buf, pos);
        if (wlen === 0) { pos += wskip; break; }
        if (pos + wskip + wlen > buf.length) {
          // Atribut belum lengkap di buffer — rewind ke awal sentence ini,
          // tunggu chunk TCP berikutnya.
          pos = startPos;
          incomplete = true;
          break;
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
      if (incomplete) { this._buf = buf.slice(pos); return false; }

      // ── AKUMULASI per-request ──────────────────────────────────────
      // PENTING (fix ip-scan): command streaming spt /tool/ip-scan mengirim
      // banyak !re bertahap di beberapa chunk TCP, lalu baru !done di akhir.
      // Sebelumnya `sentences` lokal di-reset tiap _tryParse → !re yang datang
      // sebelum !done HILANG, sehingga hasil parsial & perlu klik berulang.
      // Sekarang setiap sentence ditumpuk di akumulator pending request,
      // dan baru di-resolve saat terminator (!done/!trap/!fatal/!empty) tiba.
      const cur = this._pending[0];
      if (cur) {
        if (!cur._acc) cur._acc = [];
        cur._acc.push(sentence);
      }

      // Konsumsi sentence ini dari buffer SEKARANG (jangan tunggu !done), supaya
      // saat chunk TCP berikutnya masuk, !re yang sudah diproses TIDAK diparse
      // ulang → mencegah duplikat. Untuk command streaming (ip-scan) ini krusial.
      this._buf = buf.slice(pos);

      if (word === '!done' || word === '!trap' || word === '!fatal' || word === '!empty') {
        const done = this._pending.shift();
        if (done) done.resolve(done._acc || [sentence]);
        return true;
      }
      // Lanjut parse sisa buffer (mungkin masih ada sentence lain di chunk yang sama).
      return true;
    }
    return false;
  }

  /**
   * Jalankan command. Throws kalau respons !trap atau !fatal.
   * Returns array dari !re sentences (data rows).
   */
  async run(words, cmdTimeout) {
    if (!this._connected) await this.connect();
    const res = await this._send(words, cmdTimeout);
    const trap = res.find(r => r._replyType === '!trap' || r._replyType === '!fatal');
    if (trap) throw new Error(trap.message || trap.msg || 'MikroTik API error');
    return res.filter(r => r._replyType === '!re');
  }

  close() {
    this._connected = false;
    try { this.sock?.destroy(); } catch (_) {}
    // Reject semua pending
    while (this._pending.length) {
      const p = this._pending.shift();
      try { p.reject(new Error('Connection closed')); } catch (_) {}
    }
  }

  // ════════════════════════════════════════════════════════════════
  // REST-style API — drop-in compatible dengan MikrotikService.request()
  // ════════════════════════════════════════════════════════════════
  /**
   * Translate REST-style call → command API native.
   *
   * Mapping yang di-handle:
   *   GET    /queue/simple                  → /queue/simple/print
   *   GET    /queue/simple?name=foo         → /queue/simple/print ?name=foo
   *   PUT    /queue/simple {...body}        → /queue/simple/add =key=value...
   *   PATCH  /queue/simple/{id} {...body}   → /queue/simple/set =.id={id} =key=value...
   *   DELETE /queue/simple/{id}             → /queue/simple/remove =.id={id}
   *   POST   /queue/simple/{id}/{verb} {b}  → /queue/simple/{verb} =.id={id} =key=value...
   *   POST   /queue/simple/{verb} {b}       → /queue/simple/{verb} =key=value...
   *   POST   /interface/monitor-traffic {b} → /interface/monitor-traffic =once= =interface=...
   *   POST   /tool/ping {b}                 → /tool/ping =address=ip =count=N ...
   *
   * Method ini mengembalikan plain object/array kompatibel dengan response REST
   * RouterOS v7 (key: kebab-case, value: string "true"/"false"/number-as-string),
   * supaya controller existing tidak perlu diubah.
   */
  async request(method, endpoint, body, opts) {
    if (!this._connected) await this.connect();
    const cmdTimeout = opts?.timeout || DEFAULT_CMD_TIMEOUT;

    method = (method || 'GET').toUpperCase();
    const { basePath, id, verb, queryArgs } = this._parsePath(endpoint);

    // Build command + argumen
    let command;
    const args = [];

    if (method === 'GET') {
      command = basePath + '/print';
      // Query string → ?key=value (RouterOS API query syntax)
      for (const [k, v] of Object.entries(queryArgs || {})) {
        args.push('?' + k + '=' + v);
      }
    }
    else if (method === 'PUT') {
      command = basePath + '/add';
      this._bodyToArgs(body, args);
    }
    else if (method === 'PATCH') {
      command = basePath + '/set';
      if (id) args.push('=.id=' + id);
      this._bodyToArgs(body, args);
    }
    else if (method === 'DELETE') {
      command = basePath + '/remove';
      if (id) args.push('=.id=' + id);
    }
    else if (method === 'POST') {
      // POST /path/{verb}     → verb sebagai sub-command
      // POST /path/{id}/{verb} → verb sebagai sub-command dengan =.id=
      command = basePath + (verb ? '/' + verb : '');
      if (id) args.push('=.id=' + id);
      this._bodyToArgs(body, args);
    }
    else {
      throw new Error(`Unsupported method: ${method}`);
    }

    const sentence = [command, ...args];
    // Untuk command lama (mis. /tool/ip-scan dengan duration besar), idle-timeout
    // socket bisa lebih pendek dari durasi command → koneksi keburu putus sebelum
    // !done. Naikkan sementara socket timeout selama command ini berjalan, lalu
    // kembalikan ke default setelah selesai.
    let _restoreSockTimeout = null;
    try {
      if (this.sock && cmdTimeout && cmdTimeout > this.timeout) {
        this.sock.setTimeout(cmdTimeout + 2000);
        _restoreSockTimeout = () => { try { this.sock.setTimeout(this.timeout); } catch (_) {} };
      }
    } catch (_) {}

    let rows;
    try {
      rows = await this.run(sentence, cmdTimeout);
    } finally {
      if (_restoreSockTimeout) _restoreSockTimeout();
    }

    // Format response menyerupai RouterOS REST v7:
    //   - GET list endpoint → array of objects
    //   - GET single object (mis. /system/identity, /system/resource) → object
    //   - POST/PUT/PATCH/DELETE → null kalau tidak ada data, object kalau ada
    if (method === 'GET') {
      // Single-object endpoints (return 1 row tanpa /print yang list-style)
      if (this._isSingletonEndpoint(basePath)) {
        return rows.length ? this._normalizeRow(rows[0]) : null;
      }
      return rows.map(r => this._normalizeRow(r));
    }
    // Mutasi: kalau ada response data (mis. add → return .id=*1), kembalikan
    if (rows.length === 1) return this._normalizeRow(rows[0]);
    if (rows.length > 1)   return rows.map(r => this._normalizeRow(r));
    return null;
  }

  /**
   * Parse path REST → { basePath, id, verb, queryArgs }
   *   /queue/simple                    → basePath='/queue/simple'
   *   /queue/simple/*1                 → basePath='/queue/simple', id='*1'
   *   /queue/simple/*1/remove          → basePath='/queue/simple', id='*1', verb='remove'
   *   /ppp/active/remove               → basePath='/ppp/active', verb='remove'
   *   /interface/monitor-traffic       → basePath='/interface', verb='monitor-traffic'
   *   /queue/simple?name=foo           → basePath='/queue/simple', queryArgs={name:'foo'}
   */
  _parsePath(endpoint) {
    if (!endpoint) return { basePath: '', id: null, verb: null, queryArgs: {} };

    // Pisahkan query string
    let qIdx = endpoint.indexOf('?');
    let pathPart = endpoint, queryPart = '';
    if (qIdx >= 0) {
      pathPart  = endpoint.slice(0, qIdx);
      queryPart = endpoint.slice(qIdx + 1);
    }
    const queryArgs = {};
    if (queryPart) {
      queryPart.split('&').forEach(pair => {
        if (!pair) return;
        const eq = pair.indexOf('=');
        const k = eq >= 0 ? decodeURIComponent(pair.slice(0, eq)) : decodeURIComponent(pair);
        const v = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : '';
        queryArgs[k] = v;
      });
    }

    // Decode URL-encoded path segments (controller existing pakai encodeURIComponent untuk .id)
    const segments = pathPart.split('/').filter(Boolean).map(s => decodeURIComponent(s));

    // Verb keywords yang dikenali sebagai sub-command (bukan id)
    const KNOWN_VERBS = new Set([
      'add','set','remove','print','enable','disable','move','reset-counters',
      'monitor','monitor-traffic','export','find','listen','getall',
      // ppp / interface specific
    ]);

    // Coba parse dari ujung: last segment = verb? prev = id?
    let id = null, verb = null;
    let baseEnd = segments.length;

    if (segments.length >= 2 && KNOWN_VERBS.has(segments[segments.length - 1])) {
      verb = segments[segments.length - 1];
      baseEnd = segments.length - 1;
      // Cek apakah segment sebelumnya adalah id (.id biasanya dimulai dengan *)
      if (baseEnd >= 1 && this._looksLikeId(segments[baseEnd - 1])) {
        id = segments[baseEnd - 1];
        baseEnd -= 1;
      }
    } else if (segments.length >= 1 && this._looksLikeId(segments[segments.length - 1])) {
      id = segments[segments.length - 1];
      baseEnd = segments.length - 1;
    }

    const basePath = '/' + segments.slice(0, baseEnd).join('/');
    return { basePath, id, verb, queryArgs };
  }

  _looksLikeId(s) {
    // RouterOS internal ID: "*1", "*A", "*1A2", dst. (asterisk + hex)
    return /^\*[0-9A-Fa-f]+$/.test(s);
  }

  _isSingletonEndpoint(basePath) {
    // Endpoint yang return 1 row (bukan list)
    return [
      '/system/identity',
      '/system/resource',
      '/system/clock',
      '/system/routerboard',
    ].includes(basePath);
  }

  _bodyToArgs(body, args) {
    if (!body || typeof body !== 'object') return;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      // RouterOS API: argumen value pakai prefix '=key=value'
      const val = (typeof v === 'boolean') ? (v ? 'true' : 'false') : String(v);
      args.push('=' + k + '=' + val);
    }
  }

  _normalizeRow(row) {
    // Buang field meta internal '_replyType' (reply marker !re yang kita simpan
    // saat parsing). JANGAN strip 'type' — itu attribute interface (ether, vlan,
    // bridge, pppoe-out, dst) yang penting untuk caller di MikrotikService.
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === '_replyType') continue; // marker !re/!done/!trap
      if (k === '_timer') continue;
      out[k] = v;
    }
    return out;
  }

  // Helpers REST-style — sama signature dengan MikrotikService
  get(ep, opts)         { return this.request('GET',    ep, undefined, opts); }
  post(ep, body, opts)  { return this.request('POST',   ep, body, opts); }
  put(ep, body, opts)   { return this.request('PUT',    ep, body, opts); }
  patch(ep, body, opts) { return this.request('PATCH',  ep, body, opts); }
  delete(ep, opts)      { return this.request('DELETE', ep, undefined, opts); }
}

module.exports = { MikrotikApiClient };
