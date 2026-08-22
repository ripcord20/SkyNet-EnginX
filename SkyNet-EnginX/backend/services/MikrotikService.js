/**
 * MikroTik REST API Service (RouterOS v7+)
 * monitor-traffic: POST with body { interface, once: true }
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { MikrotikApiClient } = require('./MikrotikApiClient');

/**
 * Port → protokol detection (FALLBACK MODE — dipakai kalau caller tidak
 * memberikan `api_protocol` eksplisit). Penjelasan:
 *   8728 → API binary (plain)
 *   8729 → API binary (SSL)
 *   443  → REST (SSL) — RouterOS v7.1+
 *   else → REST (plain) — RouterOS v7.1+
 *
 * Pakai opsi `api_protocol` eksplisit kalau memungkinkan, karena port
 * custom (mis. admin remap api port=8730 untuk security) akan salah
 * di-deteksi jadi REST oleh logika ini.
 */
function detectProtocol(port) {
  const p = parseInt(port);
  if (p === 8728) return { protocol: 'api',     useSSL: false };
  if (p === 8729) return { protocol: 'api-ssl', useSSL: true  };
  if (p === 443)  return { protocol: 'rest',    useSSL: true  };
  return { protocol: 'rest', useSSL: false };
}

/**
 * Map flag eksplisit `api_protocol` (dari Device.api_protocol) ke
 * (protocol, useSSL) yang dipakai constructor. Single source of truth.
 *
 * Mendukung 6 nilai input:
 *   - 4 nilai granular (DB ENUM): rest-http, rest-https, api-plain, api-ssl
 *   - 2 nilai high-level (alias):  rest, api-binary
 *     → useSSL ditentukan oleh port (443/8729 = SSL, lainnya = plain)
 *
 * `port` opsional, hanya dipakai untuk alias 'rest' / 'api-binary' untuk
 * memutuskan plain vs SSL.
 */
function resolveProtocol(apiProtocol, port = null) {
  switch (apiProtocol) {
    // ── Nilai granular (DB ENUM) ────────────────────────────────────
    case 'rest-http':  return { protocol: 'rest',    useSSL: false };
    case 'rest-https': return { protocol: 'rest',    useSSL: true  };
    case 'api-plain':  return { protocol: 'api',     useSSL: false };
    case 'api-ssl':    return { protocol: 'api-ssl', useSSL: true  };

    // ── Alias high-level (dari UI yg simpel) ────────────────────────
    // useSSL diturunkan dari port: 443 = HTTPS, 8729 = Binary SSL, lainnya = plain.
    case 'rest': {
      const p = parseInt(port);
      return { protocol: 'rest', useSSL: p === 443 };
    }
    case 'api-binary': {
      const p = parseInt(port);
      const isSSL = p === 8729;
      return { protocol: isSSL ? 'api-ssl' : 'api', useSSL: isSSL };
    }

    default: return null; // unknown → caller jatuh ke detectProtocol
  }
}

/**
 * Port default untuk protocol tertentu. Dipakai kalau user tidak isi port
 * tapi sudah pilih protocol.
 */
function defaultPortForProtocol(apiProtocol) {
  switch (apiProtocol) {
    case 'rest-http':  return 80;
    case 'rest-https': return 443;
    case 'api-plain':  return 8728;
    case 'api-ssl':    return 8729;
    case 'rest':       return 80;     // alias → default plain
    case 'api-binary': return 8728;   // alias → default plain
    default:           return null;
  }
}

/**
 * Mask sensitive fields (password, secret, token, key) before they reach the logger.
 * Accepts an object or a string; returns a safe-to-log string.
 */
const SENSITIVE_KEYS = /"(password|pass|secret|token|api[-_]?key|authorization)"\s*:\s*"[^"]*"/gi;
function redactSecrets(payload) {
  if (payload == null) return '{}';
  let str;
  try {
    str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch (_) {
    return '[unserializable]';
  }
  return str.replace(SENSITIVE_KEYS, (_, key) => `"${key}":"***"`);
}

class MikrotikService {
  constructor(config = {}) {
    this.host     = config.host     || process.env.MT_HOST || '192.168.1.1';
    this.port     = config.port     || process.env.MT_PORT || 80;
    this.username = config.username || process.env.MT_USER || 'admin';
    this.password = config.password || process.env.MT_PASS || '';
    this.timeout  = config.timeout  || 15000;

    // Tentukan protokol — prioritas:
    //   1. `config.api_protocol` eksplisit (dari Device.api_protocol di DB)
    //   2. Deteksi berdasarkan port (backward-compat utk caller lama yg cuma kirim port)
    //
    // Catatan: kalau api_protocol diset tapi port tidak diisi, isi port dengan
    // default-nya (8728/8729/80/443) supaya tidak fallback ke env MT_PORT.
    let resolved = null;
    if (config.api_protocol) {
      // Pass port — resolveProtocol pakai port utk deteksi SSL pada alias
      // 'rest'/'api-binary' (port 443 / 8729 = SSL).
      resolved = resolveProtocol(config.api_protocol, this.port);
      if (resolved && !config.port) {
        this.port = defaultPortForProtocol(config.api_protocol) || this.port;
      }
    }
    if (!resolved) {
      resolved = detectProtocol(this.port);
    }
    this.protocol = resolved.protocol;
    // useSSL dari config explicit > resolved
    this.useSSL   = (config.useSSL != null) ? !!config.useSSL : resolved.useSSL;

    // Init transport sesuai protokol
    if (this.protocol === 'api' || this.protocol === 'api-ssl') {
      // Binary API — koneksi persistent socket
      this.baseURL = `mikrotik-api${this.useSSL ? '-ssl' : ''}://${this.host}:${this.port}`;
      this._apiClient = new MikrotikApiClient({
        host:     this.host,
        port:     this.port,
        username: this.username,
        password: this.password,
        useSSL:   this.useSSL,
        timeout:  this.timeout,
      });
      this.client = null;  // tidak pakai axios
    } else {
      // REST — pakai axios seperti sebelumnya
      this.baseURL = `${this.useSSL ? 'https' : 'http'}://${this.host}:${this.port}/rest`;
      const agentOptions = this.useSSL
        ? { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) }
        : {};
      this.client = axios.create({
        baseURL: this.baseURL,
        auth: { username: this.username, password: this.password },
        timeout: this.timeout,
        ...agentOptions
      });
      this._apiClient = null;
    }
  }

  async request(method, endpoint, data, opts = {}) {
    // opts: { retries=1, timeout, debugTag }
    const retries = (opts.retries != null) ? opts.retries : 1;
    const isWrite = ['PUT','POST','PATCH','DELETE'].includes(method);
    const debug = process.env.MT_DEBUG !== 'false'; // default ON; set MT_DEBUG=false to silence
    // Timeout default: 8s GET, 15s WRITE. Bisa di-override via opts.timeout (mis. polling pakai 5s).
    const timeoutMs = opts.timeout != null ? opts.timeout : (isWrite ? 15000 : 8000);

    // ── Binary API path ─────────────────────────────────────
    if (this._apiClient) {
      if (debug && isWrite) {
        logger.info(`[MT] → ${method} api://${this.host}:${this.port}${endpoint} body=${redactSecrets(data)}`);
      }
      try {
        const res = await this._apiClient.request(method, endpoint, data, { timeout: timeoutMs });
        if (debug && isWrite) {
          logger.info(`[MT] ← ${method} ${endpoint} data=${redactSecrets(res)}`);
        }
        return res;
      } catch (err) {
        // Reconnect & retry sekali kalau koneksi drop
        const msg = err.message || String(err);
        const isConnReset = /Connection closed|ECONNRESET|EPIPE|socket hang up/i.test(msg);
        if (isConnReset && retries > 0) {
          // Buang client lama, biar connect() berikutnya bangun socket baru
          try { this._apiClient.close(); } catch (_) {}
          this._apiClient = new MikrotikApiClient({
            host: this.host, port: this.port, username: this.username,
            password: this.password, useSSL: this.useSSL, timeout: this.timeout,
          });
          await new Promise(r => setTimeout(r, 500));
          return this.request(method, endpoint, data, { ...opts, retries: retries - 1 });
        }
        // Untuk write, MikroTik kadang drop koneksi setelah eksekusi sukses.
        // Treat sebagai sukses dengan response null (sama seperti behavior REST).
        if (isConnReset && isWrite) {
          if (debug) logger.info(`[MT] ← ${method} ${endpoint} conn-reset (treated as success)`);
          return null;
        }
        if (debug) logger.error(`[MT] ← ${method} ${endpoint} error: ${msg}`);
        throw err;
      }
    }

    // ── REST path (default, RouterOS v7.1+) ─────────────────
    if (debug && isWrite) {
      logger.info(`[MT] → ${method} ${this.baseURL}${endpoint} body=${redactSecrets(data)}`);
    }
    try {
      const res = await this.client.request({
        method, url: endpoint, data,
        timeout: timeoutMs
      });
      if (debug && isWrite) {
        logger.info(`[MT] ← ${method} ${endpoint} status=${res.status} data=${redactSecrets(res.data)}`);
      }
      return res.data;
    } catch (err) {
      // RouterOS v7 sering drop koneksi SETELAH operasi write berhasil
      // ECONNRESET pada write = operasi sudah dieksekusi, anggap sukses
      if (err.code === 'ECONNRESET' && isWrite) {
        if (debug) logger.info(`[MT] ← ${method} ${endpoint} ECONNRESET (treated as success)`);
        return null;
      }
      // Retry sekali untuk GET yang kena reset
      if (err.code === 'ECONNRESET' && !isWrite && retries > 0) {
        await new Promise(r => setTimeout(r, 500));
        return this.request(method, endpoint, data, { ...opts, retries: retries - 1 });
      }
      if (err.code === 'ECONNREFUSED') throw new Error(`Cannot connect to MikroTik at ${this.host}:${this.port}`);
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') throw new Error('Connection timeout');
      if (err.code === 'ECONNRESET') throw new Error('Koneksi ke MikroTik terputus');
      // SSL/TLS handshake gagal: ini umum kalau user pilih port 443 + SSL tapi MikroTik
      // tidak run www-ssl di port itu (atau port-nya plain HTTP). Pesan native dari OpenSSL
      // (`EPROTO ... ssl3_read_bytes:sslv3 alert handshake failure`) tidak actionable.
      // Translate ke pesan yg menjelaskan opsi: matikan SSL, ganti port plain, atau aktifkan
      // www-ssl di MikroTik.
      const msg = err.message || String(err);
      if (err.code === 'EPROTO'
          || err.code === 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'
          || err.code === 'ERR_SSL_WRONG_VERSION_NUMBER'
          || /handshake failure|wrong version number|sslv3 alert|SSL routines/i.test(msg)) {
        throw new Error(
          `TLS handshake gagal di ${this.host}:${this.port}. ` +
          `Port ini sepertinya tidak mendukung SSL/HTTPS. ` +
          `Matikan opsi SSL, ganti ke port plain (mis. 80 / 8728), atau aktifkan www-ssl di MikroTik.`
        );
      }
      if (err.response) {
        const body = err.response.data;
        const detail = (body && body.detail) ? body.detail
                     : (body && body.message) ? body.message
                     : redactSecrets(body);
        if (debug) {
          logger.error(`[MT] ← ${method} ${endpoint} status=${err.response.status} body=${redactSecrets(body)}`);
        }
        throw new Error(`MikroTik: ${detail}`);
      }
      throw err;
    }
  }

  // Helpers — terima opts (mis. timeout) yang dilewatkan ke request()
  get(ep, opts)         { return this.request('GET',    ep, undefined, opts); }
  post(ep, body, opts)  { return this.request('POST',   ep, body, opts); }
  put(ep, body, opts)   { return this.request('PUT',    ep, body, opts); }
  patch(ep, body, opts) { return this.request('PATCH',  ep, body, opts); }
  delete(ep, opts)      { return this.request('DELETE', ep, undefined, opts); }

  // ── QUEUE ──────────────────────────────────────────────────
  async getQueues() {
    // List bisa banyak (ratusan queue). Beri timeout lebih lega (12s).
    const t0 = Date.now();
    const q = await this.get('/queue/simple', { timeout: 12000 });
    const elapsed = Date.now() - t0;
    if (elapsed > 5000) {
      logger.warn(`[MT] getQueues lambat: ${elapsed}ms — host=${this.host} count=${Array.isArray(q) ? q.length : 0}`);
    }
    return (Array.isArray(q) ? q : []).map(r => ({
      id: r['.id'], name: r.name || '', target: r.target || '',
      maxLimit: r['max-limit'] || '0/0', priority: r.priority || '8',
      disabled: r.disabled === 'true',
      // Dynamic queue (auto-generated dari PPPoE rate-limit / hotspot user-profile).
      // Untuk PPPoE, MikroTik bikin queue dgn nama "<pppoe-USERNAME>" saat sesi up.
      dynamic:  r.dynamic  === 'true',
      comment: r.comment || '', parent: r.parent || 'none',
      // MikroTik rate/bytes format: upload/download — swap agar rateIn=download, rateOut=upload
      rateIn:  (r.rate  || '0/0').split('/')[1],  // download pelanggan
      rateOut: (r.rate  || '0/0').split('/')[0],  // upload pelanggan
      bytesIn: (r.bytes || '0/0').split('/')[1],  // total download
      bytesOut:(r.bytes || '0/0').split('/')[0],  // total upload
      queued: r.queued || '0/0'
    }));
  }

  async getQueueStats() {
    // Polling endpoint — pakai timeout lebih pendek (5s) supaya kalau MikroTik
    // melambat, polling tidak antri lama. Drop saja, polling berikutnya akan retry.
    const q = await this.get('/queue/simple', { timeout: 5000, retries: 0 });
    return (Array.isArray(q) ? q : []).map(r => ({
      id: r['.id'], name: r.name,
      target: r.target || '',                      // IP/subnet target (utk match static)
      rateIn:  (r.rate  || '0/0').split('/')[1],  // download pelanggan
      rateOut: (r.rate  || '0/0').split('/')[0],  // upload pelanggan
      bytesIn: (r.bytes || '0/0').split('/')[1],  // total download
      bytesOut:(r.bytes || '0/0').split('/')[0],
    }));
  }

  async createQueue(data) {
    const body = {
      name: data.name, target: data.target,
      'max-limit': data.maxLimit || '10M/10M',
      comment: data.comment || '',
      disabled: data.disabled ? 'true' : 'false',
      priority: String(data.priority || '8')
    };
    // Parent queue (opsional). 'none' / kosong = queue top-level.
    if (data.parent && data.parent !== 'none') body.parent = data.parent;
    return this.put('/queue/simple', body);
  }

  async updateQueue(id, data) {
    const body = {
      name: data.name, target: data.target,
      'max-limit': data.maxLimit, comment: data.comment || '',
      disabled: data.disabled ? 'true' : 'false',
      priority: String(data.priority || '8')
    };
    // Set parent bila dipilih; kirim 'none' untuk melepas parent.
    if (data.parent !== undefined) body.parent = (data.parent && data.parent !== 'none') ? data.parent : 'none';
    return this.patch(`/queue/simple/${encodeURIComponent(id)}`, body);
  }

  async deleteQueue(id)  { return this.delete(`/queue/simple/${encodeURIComponent(id)}`); }
  async enableQueue(id)  { return this.patch(`/queue/simple/${encodeURIComponent(id)}`, { disabled: 'false' }); }
  async disableQueue(id) { return this.patch(`/queue/simple/${encodeURIComponent(id)}`, { disabled: 'true'  }); }

  // ── PPPOE ──────────────────────────────────────────────────
  async getPPPoESessions() {
    const s = await this.get('/ppp/active');
    return (Array.isArray(s) ? s : []).map(r => ({
      id: r['.id'], name: r.name || '', service: r.service || 'pppoe',
      address: r.address || '', uptime: r.uptime || '0s',
      callerID: r['caller-id'] || '', radius: r.radius === 'true',
      // Virtual interface name dari sesi PPPoE aktif (mis. "<pppoe-room-pppoe>"
      // atau "pppoe-room-pppoe" tergantung versi RouterOS / format response).
      // Dipakai untuk korelasi dengan dynamic simple queue yang target/name-nya
      // mengacu ke interface ini.
      interface: r.interface || ''
    }));
  }

  async getPPPoESecrets() {
    const s = await this.get('/ppp/secret');
    return (Array.isArray(s) ? s : []).map(r => ({
      id:            r['.id'],
      name:          r.name          || '',
      hasPassword:   !!r.password,        // flag saja — password tidak di-expose ke frontend
      service:       r.service       || 'pppoe',
      profile:       r.profile       || 'default',
      localAddress:  r['local-address']  || '',
      remoteAddress: r['remote-address'] || '',
      callerId:      r['caller-id']      || '',
      disabled:      r.disabled === 'true',
      comment:       r.comment || '',
      lastLoggedOut: r['last-logged-out'] || '',
      lastCaller:    r['last-caller-id']  || ''
    }));
  }

  // Disconnect (kick) sesi PPP aktif berdasarkan internal ID (mis. "*80000002").
  //
  // RouterOS v7 REST API tidak konsisten antar-build untuk perintah `remove`
  // pada `/ppp/active`. Kita ikuti pola yang sudah teruji pada deletePPPoESecret:
  // coba beberapa bentuk RPC + DELETE, lalu verifikasi via list-scan.
  //
  // Catatan: ID seperti "*80000002" boleh berisi karakter `*`. encodeURIComponent
  // mengubahnya jadi "%2A", dan beberapa build merespons dengan
  // "no such command prefix". Strategi 2 (numbers=<id raw>) terbukti paling
  // kompatibel karena mirror perintah CLI `/ppp/active remove numbers=<id>`.
  async disconnectPPPoE(id) {
    const encId = encodeURIComponent(id);

    const verifyGone = async () => {
      try {
        const all = await this.get('/ppp/active');
        if (!Array.isArray(all)) return true;
        return !all.some(r => r['.id'] === id);
      } catch (e) {
        return false;
      }
    };

    const attempts = [
      // Strategy 1: CLI-style remove via collection endpoint, raw id di body.
      //   Mirror: `/ppp/active remove numbers=*XXX`. Paling kompatibel.
      { label: 'POST /remove numbers',
        run: () => this.request('POST', `/ppp/active/remove`, { numbers: id }) },

      // Strategy 2: RPC-style POST /<path>/<id>/remove (id encoded).
      { label: 'POST .id/remove',
        run: () => this.request('POST', `/ppp/active/${encId}/remove`, null) },

      // Strategy 3: HTTP DELETE /<path>/<id>.
      { label: 'HTTP DELETE',
        run: () => this.request('DELETE', `/ppp/active/${encId}`) },
    ];

    let lastErr = null;
    for (const a of attempts) {
      try {
        await a.run();
      } catch (e) {
        lastErr = e;
        // Lanjut verifikasi — error transient (ECONNRESET) bisa terjadi
        // padahal session sudah ter-disconnect.
      }
      if (await verifyGone()) {
        logger.info(`[MT] disconnectPPPoE id=${id} succeeded via: ${a.label}`);
        return { success: true };
      }
      logger.warn(`[MT] disconnectPPPoE id=${id} attempt "${a.label}" did not remove session; trying next`);
    }

    throw new Error(
      lastErr
        ? `MikroTik: disconnect accepted but session still active (${lastErr.message})`
        : 'MikroTik: disconnect accepted but session still active'
    );
  }

  // ── PPPoE Secrets CRUD ─────────────────────────────────────
  async createPPPoESecret(data) {
    const body = {
      name:     data.name,
      password: data.password || '',
      service:  data.service  || 'pppoe',
      profile:  data.profile  || 'default',
      disabled: data.disabled ? 'true' : 'false'
    };
    if(data.localAddress  && data.localAddress.trim())  body['local-address']  = data.localAddress.trim();
    if(data.remoteAddress && data.remoteAddress.trim()) body['remote-address'] = data.remoteAddress.trim();
    if(data.callerId      && data.callerId.trim())      body['caller-id']      = data.callerId.trim();
    if(data.comment       && data.comment.trim())       body.comment           = data.comment.trim();

    // RouterOS REST API: POST /ppp/secret/add (lebih kompatibel lintas versi)
    try {
      return await this.post('/ppp/secret/add', body);
    } catch(e) {
      // Fallback: PUT /ppp/secret (RouterOS v7 standard)
      try { return await this.put('/ppp/secret', body); }
      catch(e2) { throw new Error(e.message || e2.message); }
    }
  }
  async updatePPPoESecret(id, data) {
    const encId = encodeURIComponent(id);
    const body = {};
    if(data.name     !== undefined && data.name !== '') body.name     = data.name;
    if(data.password !== undefined && data.password)    body.password = data.password;
    if(data.service  !== undefined && data.service)     body.service  = data.service;
    if(data.profile  !== undefined && data.profile)     body.profile  = data.profile;
    if(data.disabled !== undefined) body.disabled = data.disabled ? 'true' : 'false';
    // For address/caller-id/comment: only include if non-empty — sending "" can trigger
    // "no such command prefix" style errors on some RouterOS builds. To CLEAR a field,
    // MikroTik REST expects the key omitted or explicit unset command, not empty string.
    const la = (data.localAddress  || '').trim();
    const ra = (data.remoteAddress || '').trim();
    const ci = (data.callerId      || '').trim();
    const cm = (data.comment       || '').trim();
    if (la) body['local-address']  = la;
    if (ra) body['remote-address'] = ra;
    if (ci) body['caller-id']      = ci;
    if (cm !== undefined) body.comment = cm; // comment '' is allowed (clear comment)
    // RouterOS v7 REST standard: PATCH /ppp/secret/<id> to update a record.
    // Fallback: POST /ppp/secret/<id>/set (RouterOS RPC-style) for older/variant builds.
    try {
      return await this.patch(`/ppp/secret/${encId}`, body);
    } catch(e) {
      try { return await this.post(`/ppp/secret/${encId}/set`, body); }
      catch(e2) { throw new Error(e.message || e2.message); }
    }
  }
  async deletePPPoESecret(id)  {
    const encId = encodeURIComponent(id);

    // Verify the record is actually gone by re-fetching the collection.
    // We intentionally DON'T use GET /ppp/secret/<id> because some RouterOS builds
    // answer 200 with an empty object for unknown ids, which would produce a false
    // "gone" positive. Scanning the list is authoritative.
    const verifyGone = async () => {
      try {
        const all = await this.get('/ppp/secret');
        if (!Array.isArray(all)) return true; // no list → assume gone
        return !all.some(r => r['.id'] === id);
      } catch (e) {
        return false; // if we cannot verify, assume NOT gone (safer)
      }
    };

    const attempts = [
      // Strategy 1: RPC-style POST /<path>/<id>/remove with no body.
      //   This is the most common form in RouterOS v7 REST docs.
      { label: 'POST .id/remove',
        run: () => this.request('POST', `/ppp/secret/${encId}/remove`, null) },

      // Strategy 2: RPC-style POST /<path>/remove with {numbers: [id]} body.
      //   This mirrors CLI: `/ppp/secret remove numbers=<id>`. Some builds only
      //   accept this form.
      { label: 'POST /remove numbers',
        run: () => this.request('POST', `/ppp/secret/remove`, { numbers: id }) },

      // Strategy 3: HTTP DELETE /<path>/<id>. Works on newer RouterOS 7.x but is
      //   known to silently no-op on some builds — hence we verify afterwards.
      { label: 'HTTP DELETE',
        run: () => this.request('DELETE', `/ppp/secret/${encId}`) },
    ];

    let lastErr = null;
    for (const a of attempts) {
      try {
        await a.run();
      } catch (e) {
        lastErr = e;
        // Even if the HTTP call errored, verify — some errors are transient
        // (ECONNRESET post-write) and the op may have succeeded anyway.
      }
      if (await verifyGone()) {
        logger.info(`[MT] deletePPPoESecret id=${id} succeeded via: ${a.label}`);
        return { success: true };
      }
      logger.warn(`[MT] deletePPPoESecret id=${id} attempt "${a.label}" did not remove record; trying next`);
    }

    throw new Error(
      lastErr
        ? `MikroTik: delete accepted but record still exists (${lastErr.message})`
        : 'MikroTik: delete accepted but record still exists'
    );
  }
  async enablePPPoESecret(id)  {
    const encId = encodeURIComponent(id);
    try { return await this.patch(`/ppp/secret/${encId}`, { disabled:'false' }); }
    catch(e) {
      try { return await this.post(`/ppp/secret/${encId}/set`, { disabled:'false' }); }
      catch(e2) { throw new Error(e.message || e2.message); }
    }
  }
  async disablePPPoESecret(id) {
    const encId = encodeURIComponent(id);
    try { return await this.patch(`/ppp/secret/${encId}`, { disabled:'true' }); }
    catch(e) {
      try { return await this.post(`/ppp/secret/${encId}/set`, { disabled:'true' }); }
      catch(e2) { throw new Error(e.message || e2.message); }
    }
  }

  // ── PPPoE Profiles ─────────────────────────────────────────
  async getPPPoEProfiles() {
    const p = await this.get('/ppp/profile');
    return Array.isArray(p) ? p.map(r=>({
      id: r['.id'], name: r.name,
      localAddress:  r['local-address']  || '',
      remoteAddress: r['remote-address'] || '',
      rateLimit:     r['rate-limit']     || '',
      sessionTimeout:r['session-timeout']|| '',
      comment:       r.comment || ''
    })) : [];
  }

  // ── IP POOL ────────────────────────────────────────────────
  async getIPPools() {
    const p = await this.get('/ip/pool');
    return (Array.isArray(p) ? p : []).map(r => ({
      id: r['.id'], name: r.name, ranges: r.ranges || '',
      nextPool: r['next-pool'] || 'none', comment: r.comment || ''
    }));
  }

  async getIPPoolUsed() {
    const u = await this.get('/ip/pool/used');
    return (Array.isArray(u) ? u : []).map(r => ({
      id: r['.id'], pool: r.pool || '', address: r.address || '',
      owner: r.owner || '', info: r.info || ''
    }));
  }

  async createIPPool(data) {
    const body = { name: data.name, ranges: data.ranges };
    if (data.nextPool && data.nextPool !== 'none') body['next-pool'] = data.nextPool;
    if (data.comment) body.comment = data.comment;
    return this.put('/ip/pool', body);
  }

  async deleteIPPool(id) { return this.delete(`/ip/pool/${id}`); }

  // ── IP ADDRESSES (alamat terpasang di interface) ────────────
  async getIPAddresses() {
    const a = await this.get('/ip/address');
    return (Array.isArray(a) ? a : []).map(r => ({
      id: r['.id'], address: r.address || '', network: r.network || '',
      interface: r.interface || '', disabled: r.disabled === 'true',
      dynamic: r.dynamic === 'true', comment: r.comment || ''
    }));
  }

  async addIPAddress(data) {
    const body = { address: data.address, interface: data.interface };
    if (data.network) body.network = data.network;
    if (data.comment) body.comment = data.comment;
    if (data.disabled !== undefined) body.disabled = data.disabled ? 'true' : 'false';
    return this.put('/ip/address', body);
  }

  async updateIPAddress(id, data) {
    const body = {};
    if (data.address   !== undefined) body.address   = data.address;
    if (data.interface !== undefined) body.interface = data.interface;
    if (data.network   !== undefined) body.network   = data.network;
    if (data.comment   !== undefined) body.comment   = data.comment;
    if (data.disabled  !== undefined) body.disabled  = data.disabled ? 'true' : 'false';
    return this.patch(`/ip/address/${id}`, body);
  }

  async deleteIPAddress(id) { return this.delete(`/ip/address/${id}`); }
  async toggleIPAddress(id, disabled) { return this.patch(`/ip/address/${id}`, { disabled: disabled ? 'true' : 'false' }); }

  /**
   * Saran range pool berdasarkan IP yang terpasang di sebuah interface.
   * Contoh: interface punya 10.5.50.1/24 → saran range 10.5.50.2-10.5.50.254
   * (host pertama setelah gateway s/d host terakhir sebelum broadcast).
   *
   * @param {string} ifaceName nama interface
   * @returns {{ found:boolean, address?:string, cidr?:number, gateway?:string,
   *             suggestedRange?:string, network?:string }}
   */
  async suggestPoolRange(ifaceName) {
    const addrs = await this.getIPAddresses();
    const match = addrs.find(a => a.interface === ifaceName && a.address && !a.disabled);
    if (!match) return { found: false };

    const [ip, cidrStr] = match.address.split('/');
    const cidr = parseInt(cidrStr) || 24;
    const ipInt = ipToIntLocal(ip);
    const mask = cidr === 0 ? 0 : (0xFFFFFFFF << (32 - cidr)) >>> 0;
    const networkInt   = (ipInt & mask) >>> 0;
    const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0;

    // host pertama = network+1 (biasanya gateway), pool mulai dari network+2
    const firstHost = networkInt + 1;
    const startInt  = networkInt + 2;          // skip gateway
    const endInt    = broadcastInt - 1;        // skip broadcast

    // Kalau subnet terlalu kecil (/31, /32), tidak ada range usable
    if (cidr >= 31 || endInt < startInt) {
      return { found: true, address: match.address, cidr, gateway: ip,
               network: intToIpLocal(networkInt), suggestedRange: '' };
    }
    return {
      found: true,
      address: match.address,
      cidr,
      gateway: intToIpLocal(firstHost),
      network: intToIpLocal(networkInt),
      suggestedRange: `${intToIpLocal(startInt)}-${intToIpLocal(endInt)}`,
    };
  }

  // ── FIREWALL ───────────────────────────────────────────────
  async getFirewallFilter() {
    const r = await this.get('/ip/firewall/filter');
    return (Array.isArray(r) ? r : []).map((rule, idx) => ({
      id: rule['.id'], chain: rule.chain || '', action: rule.action || '',
      protocol: rule.protocol || 'any',
      srcAddress: rule['src-address'] || '', dstAddress: rule['dst-address'] || '',
      srcPort: rule['src-port'] || '', dstPort: rule['dst-port'] || '',
      inInterface: rule['in-interface'] || '', outInterface: rule['out-interface'] || '',
      comment: rule.comment || '', disabled: rule.disabled === 'true',
      bytes: parseInt(rule.bytes) || 0, packets: parseInt(rule.packets) || 0, order: idx + 1
    }));
  }

  async getFirewallNAT() {
    const r = await this.get('/ip/firewall/nat');
    return (Array.isArray(r) ? r : []).map((rule, idx) => ({
      id: rule['.id'], chain: rule.chain || '', action: rule.action || '',
      protocol: rule.protocol || 'any',
      srcAddress: rule['src-address'] || '', dstAddress: rule['dst-address'] || '',
      toAddresses: rule['to-addresses'] || '', toPorts: rule['to-ports'] || '',
      comment: rule.comment || '', disabled: rule.disabled === 'true',
      bytes: parseInt(rule.bytes) || 0, packets: parseInt(rule.packets) || 0, order: idx + 1
    }));
  }

  async toggleFirewallRule(chain, id, disable) {
    const base = chain === 'nat' ? '/ip/firewall/nat' : '/ip/firewall/filter';
    // RouterOS REST API: PATCH /{id} dengan property disabled
    return this.patch(`${base}/${encodeURIComponent(id)}`, { disabled: disable ? 'true' : 'false' });
  }

  // ── INTERFACES ─────────────────────────────────────────────
  async getInterfaces() {
    const ifaces = await this.get('/interface');
    return (Array.isArray(ifaces) ? ifaces : []).map(i => ({
      id: i['.id'], name: i.name, type: i.type || 'ether',
      mtu: i.mtu || 1500, running: i.running === 'true',
      disabled: i.disabled === 'true', comment: i.comment || '',
      macAddress: i['mac-address'] || '',
      txByte: parseInt(i['tx-byte']) || 0, rxByte: parseInt(i['rx-byte']) || 0,
      txPacket: parseInt(i['tx-packet']) || 0, rxPacket: parseInt(i['rx-packet']) || 0
    }));
  }

  // ── IP SCAN (Tools > IP Scan) ──────────────────────────────
  /**
   * Jalankan /tool/ip-scan di RouterOS.
   * RouterOS REST v7 : POST /tool/ip-scan { interface, address-range, duration }
   * RouterOS binary  : /tool/ip-scan =interface= =address-range= =duration=
   * `duration` (detik) WAJIB supaya command berhenti & response balik —
   * tanpa duration, ip-scan jalan terus (streaming) dan request hang.
   *
   * @param {object} opts
   *   - interface    : nama interface (wajib)
   *   - addressRange : CIDR/range (opsional; kalau kosong scan subnet interface)
   *   - duration     : detik (default 5)
   * @returns array of { address, macAddress, time, dns, snmp, netbios }
   */
  async runIpScan({ interface: iface, addressRange = '', duration = 5 } = {}) {
    if (!iface) throw new Error('Interface wajib dipilih');
    const dur = Math.min(Math.max(parseInt(duration) || 5, 1), 30);

    // PENTING: RouterOS /tool/ip-scan butuh duration dalam FORMAT WAKTU ROS
    // (mis. "5s"). Kalau dikirim angka polos "5", sebagian build menafsirkannya
    // berbeda / langsung selesai (return instan dengan hasil parsial) — itulah
    // kenapa sebelumnya perlu klik Start berkali-kali baru hasil lengkap.
    // Dengan "Ns" command BLOCK penuh selama N detik lalu balas semua !re.
    const body = { interface: iface, duration: `${dur}s` };
    if (addressRange && addressRange.trim()) body['address-range'] = addressRange.trim();

    // Command-level timeout HARUS lebih besar dari durasi scan + overhead jaringan.
    // Beri buffer 12 detik supaya native API tidak memotong sebelum !done.
    const res = await this.request('POST', '/tool/ip-scan', body, {
      timeout: dur * 1000 + 12000,
      retries: 0,
    });

    const rows = Array.isArray(res) ? res : (res ? [res] : []);
    const mapped = rows.map(r => ({
      address:    r.address    || r['address'] || '',
      macAddress: r['mac-address'] || r.mac || '',
      time:       r.time       || r['time'] || '',
      dns:        r['dns']     || r.dns  || '',
      snmp:       r['snmp']    || r.snmp || '',
      netbios:    r['netbios'] || r.netbios || '',
    })).filter(r => r.address);

    // RouterOS ip-scan kerap mengirim host yang sama berkali-kali (per-probe).
    // Dedup di sini: kunci = MAC (kalau ada) atau address. Ambil entri terlengkap.
    const seen = new Map();
    for (const r of mapped) {
      const key = r.macAddress ? 'M:' + r.macAddress.toUpperCase() : 'A:' + r.address;
      const ex = seen.get(key);
      if (!ex || (!ex.macAddress && r.macAddress) || (!ex.dns && r.dns)) {
        seen.set(key, { ...ex, ...r });
      }
    }
    // Urutkan by IP supaya tampilan rapi (numerik per oktet).
    return [...seen.values()].sort((a, b) => {
      const ai = (a.address || '').split('.').map(Number);
      const bi = (b.address || '').split('.').map(Number);
      for (let i = 0; i < 4; i++) { if ((ai[i]||0) !== (bi[i]||0)) return (ai[i]||0) - (bi[i]||0); }
      return 0;
    });
  }


  async getInterfaceStats(name) {
    try {
      const res = await this.request('POST', '/interface/monitor-traffic', {
        interface: name,
        once: true
      }, { timeout: 8000, retries: 0 });
      const s = Array.isArray(res) ? res[0] : res;
      if (s && typeof s === 'object') {
        return {
          name,
          rxBitsPerSecond:    parseInt(s['rx-bits-per-second'])    || 0,
          txBitsPerSecond:    parseInt(s['tx-bits-per-second'])    || 0,
          rxPacketsPerSecond: parseInt(s['rx-packets-per-second']) || 0,
          txPacketsPerSecond: parseInt(s['tx-packets-per-second']) || 0,
          fpRxBitsPerSecond:  parseInt(s['fp-rx-bits-per-second']) || 0,
          fpTxBitsPerSecond:  parseInt(s['fp-tx-bits-per-second']) || 0,
        };
      }
    } catch (e) { /* silent */ }
    return { name, rxBitsPerSecond: 0, txBitsPerSecond: 0, rxPacketsPerSecond: 0, txPacketsPerSecond: 0 };
  }

  /**
   * Monitor traffic banyak interface — parallel POST requests
   * (bulk comma-separated tidak support di RouterOS ini → parallel individual)
   */
  async getInterfacesBulkStats(names) {
    if (!names || !names.length) return [];
    // Parallel requests, max 8 sekaligus
    const chunks = [];
    for (let i = 0; i < names.length; i += 8) {
      chunks.push(names.slice(i, i + 8));
    }
    const results = [];
    for (const chunk of chunks) {
      const stats = await Promise.all(
        chunk.map(name => this.getInterfaceStats(name))
      );
      results.push(...stats);
    }
    return results;
  }

  // ── SYSTEM ─────────────────────────────────────────────────
  async getSystemResource() {
    const r = await this.get('/system/resource');
    return {
      uptime: r.uptime || '0s', version: r.version || '',
      boardName: r['board-name'] || '', platform: r.platform || '',
      cpuLoad: parseInt(r['cpu-load']) || 0,
      freeMemory: parseInt(r['free-memory']) || 0,
      totalMemory: parseInt(r['total-memory']) || 0
    };
  }

  async getSystemIdentity() { return this.get('/system/identity'); }

  /**
   * Ambil top destination dari /ip/firewall/connection (connection tracking).
   *
   * MikroTik tidak menyimpan histori NetFlow yg bisa di-query, tapi connection
   * tracking memberi snapshot SEMUA koneksi aktif saat ini beserta bytes-nya.
   * Kita agregasi per destination IP, jumlahkan total bytes (orig + repl),
   * lalu return top-N berdasarkan bytes terbanyak.
   *
   * CATATAN:
   *   - Ini snapshot real-time, bukan histori. Bytes adalah akumulasi sejak
   *     koneksi itu dibuka (bukan rate). Koneksi yg sudah closed tidak muncul.
   *   - Connection tracking harus enabled di router (default ON). Kalau OFF,
   *     list kosong.
   *   - Field bytes: RouterOS v7 pakai 'orig-bytes'/'repl-bytes', v6 kadang
   *     'orig-bytes' saja. Kita handle keduanya.
   *
   * @param {object} opts { limit=15, minBytes=0, excludeLocal=true }
   * @returns {Promise<Array<{dst, bytes, origBytes, replBytes, connections, protocols}>>}
   */
  async getTopConnections(opts = {}) {
    const limit        = opts.limit        != null ? opts.limit        : 15;
    const minBytes     = opts.minBytes     != null ? opts.minBytes     : 0;
    const excludeLocal = opts.excludeLocal !== false; // default true

    let conns = [];
    try {
      conns = await this.get('/ip/firewall/connection', { timeout: 12000, retries: 0 });
    } catch (e) {
      // Connection tracking mungkin disabled atau endpoint tidak ada
      return { available: false, reason: e.message, data: [] };
    }
    if (!Array.isArray(conns)) return { available: false, reason: 'format tidak dikenal', data: [] };

    // Helper: ambil IP dari "IP:PORT" → "IP"
    const ipOnly = (addr) => {
      if (!addr) return '';
      const s = String(addr);
      // IPv6 punya banyak ':' — skip (jarang dipakai untuk top-talker view)
      if ((s.match(/:/g) || []).length > 1) return s;
      return s.split(':')[0];
    };

    // Helper: cek apakah IP private/lokal (RFC1918 + CGNAT + loopback)
    const isLocal = (ip) => {
      if (!ip) return true;
      if (/^10\./.test(ip)) return true;
      if (/^192\.168\./.test(ip)) return true;
      if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
      if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(ip)) return true; // CGNAT 100.64/10
      if (/^127\./.test(ip)) return true;
      if (/^169\.254\./.test(ip)) return true;
      if (/^(224|239)\./.test(ip)) return true; // multicast
      return false;
    };

    // Agregasi per destination IP
    const agg = {}; // dstIp → { bytes, origBytes, replBytes, connections, protocols:Set }
    for (const c of conns) {
      const dstIp = ipOnly(c['dst-address']);
      if (!dstIp) continue;
      if (excludeLocal && isLocal(dstIp)) continue;

      const orig = parseInt(c['orig-bytes']) || 0;
      const repl = parseInt(c['repl-bytes']) || 0;
      const total = orig + repl;
      const proto = (c.protocol || '').toLowerCase();

      if (!agg[dstIp]) {
        agg[dstIp] = { dst: dstIp, bytes: 0, origBytes: 0, replBytes: 0, connections: 0, protocols: new Set() };
      }
      agg[dstIp].bytes      += total;
      agg[dstIp].origBytes  += orig;
      agg[dstIp].replBytes  += repl;
      agg[dstIp].connections += 1;
      if (proto) agg[dstIp].protocols.add(proto);
    }

    // Semua agregat (sebelum slice) — dipakai untuk summary per-provider.
    const allAgg = Object.values(agg).map(a => ({
      dst:         a.dst,
      bytes:       a.bytes,
      connections: a.connections,
    }));

    // Sort by bytes desc, ambil top-N, filter minBytes
    const arr = Object.values(agg)
      .filter(a => a.bytes >= minBytes)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, limit)
      .map(a => ({
        dst:         a.dst,
        bytes:       a.bytes,
        origBytes:   a.origBytes,
        replBytes:   a.replBytes,
        connections: a.connections,
        protocols:   Array.from(a.protocols),
      }));

    return { available: true, totalConnections: conns.length, data: arr, allAgg };
  }


  /**
   * Ambil DNS cache router (/ip/dns/cache).
   *
   * Berisi pemetaan nama domain → IP yang sudah di-resolve & di-cache router.
   * Hanya terisi jika router menjadi DNS resolver untuk klien
   * (allow-remote-requests=yes). Dipakai untuk memetakan IP destinasi koneksi
   * kembali ke nama domain di "Web" tab NOC dashboard.
   *
   * @returns {Promise<Array<{name, address, type, ttl}>>}
   */
  async getDnsCache() {
    let rows = [];
    try {
      rows = await this.get('/ip/dns/cache', { timeout: 10000, retries: 0 });
    } catch (e) {
      return [];
    }
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(r => r && r.name && (r.data || r.address))
      .map(r => ({
        name:    r.name,
        // RouterOS pakai 'data' utk isi record; sebagian versi 'address'
        address: r.data || r.address || '',
        type:    r.type || 'A',
        ttl:     r.ttl || '',
      }));
  }


  /**
   * Ping satu IP via MikroTik /tool/ping.
   * Dual-protocol: di REST → POST /tool/ping { address, count, interval }
   * di Binary    → /tool/ping =address=ip =count=N =interval=0.2
   *
   * Returns raw response (array of per-packet results atau summary object).
   * Caller bertanggung jawab parse.
   *
   * @param {string} ip
   * @param {object} opts { count=4, interval='0.2', timeout=15000 }
   */
  async ping(ip, opts = {}) {
    const count    = opts.count    != null ? opts.count    : 4;
    const interval = opts.interval != null ? opts.interval : '0.2';
    const timeout  = opts.timeout  != null ? opts.timeout  : 15000;
    return this.request('POST', '/tool/ping', {
      address:  ip,
      count:    String(count),
      interval: String(interval),
    }, { timeout, retries: 0 });
  }

  async testConnection() {
    try {
      const identity = await this.getSystemIdentity();
      return { success: true, identity: identity.name || 'MikroTik' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// ─── INSTANCE CACHE ──────────────────────────────────────────
// Default instance (dari .env / mikrotik_config.json) + per-device cache.
let _instance = null;
const _deviceInstances = new Map(); // key: deviceId (number) → MikrotikService

/**
 * Ambil instance default (dari env / config global). Kalau diberi config object,
 * return instance baru (tidak di-cache).
 */
function getMikrotikInstance(config = null) {
  if (config) return new MikrotikService(config);
  if (!_instance) _instance = new MikrotikService();
  return _instance;
}

/**
 * Replace default instance. Dipanggil setelah saveConfig agar perubahan
 * langsung berlaku tanpa restart.
 */
function setMikrotikInstance(config) {
  _instance = new MikrotikService(config);
  return _instance;
}

/**
 * Reset semua cache. Dipakai saat config global berubah atau device dihapus.
 * Kalau instance pakai binary API, socket-nya ditutup agar tidak leak file descriptor.
 */
function resetInstance(deviceId = null) {
  const closeIfBinary = (inst) => {
    if (inst && inst._apiClient) {
      try { inst._apiClient.close(); } catch (_) {}
    }
  };
  if (deviceId == null) {
    closeIfBinary(_instance);
    for (const inst of _deviceInstances.values()) closeIfBinary(inst);
    _instance = null;
    _deviceInstances.clear();
  } else {
    const key = Number(deviceId);
    closeIfBinary(_deviceInstances.get(key));
    _deviceInstances.delete(key);
  }
}

/**
 * Dapatkan instance MikrotikService yang sudah di-bind ke device dari tabel `devices`.
 * Resolve order: explicit deviceId → device dengan is_primary=true → device router pertama
 *                → fallback ke instance default (.env).
 *
 * @param {number|null} deviceId - PK dari tabel devices. Boleh null untuk auto-pick.
 * @returns {Promise<MikrotikService>}
 */
async function getMikrotikInstanceByDevice(deviceId = null) {
  // Lazy-require agar tidak circular saat module-init
  const { Device } = require('../models');
  const logger = require('../utils/logger');

  let device = null;

  if (deviceId) {
    // Cache hit? Tapi tetap fetch device dari DB untuk validasi config tidak berubah.
    device = await Device.findByPk(deviceId);
    if (device) {
      const cached = _deviceInstances.get(Number(deviceId));
      // Pakai cache hanya kalau host/port/credential/protokol masih sama dengan DB.
      // api_protocol ikut dicek karena perubahan protocol harus rebuild instance
      // (binary ↔ REST = transport berbeda).
      if (cached &&
          cached.host === device.ip_address &&
          String(cached.port) === String(device.api_port || 80) &&
          cached.username === (device.api_username || 'admin') &&
          cached._apiProtocol === (device.api_protocol || null)) {
        logger.debug(`[MT] cache hit device_id=${deviceId} host=${device.ip_address}`);
        return cached;
      }
      // Cache stale → invalidate (& close binary socket kalau ada)
      if (cached) {
        if (cached._apiClient) { try { cached._apiClient.close(); } catch (_) {} }
        _deviceInstances.delete(Number(deviceId));
      }
    }
  }

  if (!device) {
    // Auto-pick: prioritas is_primary=true, lalu router pertama yang aktif.
    // Kalau kolom is_primary tidak ada (skema lama), fallback aman.
    try {
      device = await Device.findOne({
        where: { is_primary: true, type: 'router', is_active: true }
      });
    } catch (_) { /* kolom tidak ada → skip */ }

    if (!device) {
      device = await Device.findOne({
        where: { type: 'router', is_active: true },
        order: [['id', 'ASC']]
      });
    }
  }

  if (!device || !device.ip_address) {
    // Tidak ada device terdaftar — pakai instance default (.env)
    logger.warn('[MT] no device found, fallback to default instance');
    return getMikrotikInstance();
  }

  // Build config. Prioritas:
  //   1. api_protocol eksplisit di device → menentukan binary vs REST
  //   2. Fallback ke deteksi dari port (utk device lama yg belum di-migrate)
  const cfg = {
    host:         device.ip_address,
    port:         device.api_port || 80,
    username:     device.api_username || 'admin',
    password:     device.api_password || '',
    api_protocol: device.api_protocol || null,
  };

  logger.info(`[MT] new instance device_id=${device.id} name="${device.name}" host=${cfg.host}:${cfg.port} protocol=${cfg.api_protocol || 'auto'}`);
  const inst = new MikrotikService(cfg);
  // Tag biar cache invalidation bisa cek perubahan api_protocol
  inst._apiProtocol = device.api_protocol || null;
  _deviceInstances.set(Number(device.id), inst);
  return inst;
}

// ── Helper IP <-> int (untuk suggestPoolRange) ───────────────
function ipToIntLocal(ip) {
  const p = String(ip).split('.');
  return (((parseInt(p[0]) || 0) << 24) + ((parseInt(p[1]) || 0) << 16) +
          ((parseInt(p[2]) || 0) << 8) + (parseInt(p[3]) || 0)) >>> 0;
}
function intToIpLocal(int) {
  return [(int >>> 24) & 0xFF, (int >>> 16) & 0xFF, (int >>> 8) & 0xFF, int & 0xFF].join('.');
}

module.exports = {
  MikrotikService,
  getMikrotikInstance,
  setMikrotikInstance,
  resetInstance,
  getMikrotikInstanceByDevice
};