'use strict';

/**
 * GponCliOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * Base service untuk OLT GPON "chipset-based" yang berbagi pola CLI mirip
 * (CDATA, HIOSO, ZIMMLINK, dan banyak OEM Cortina/Realtek lainnya).
 *
 * Pola CLI umum keluarga ini:
 *   - Masuk port PON : interface gpon 0/<port>   → prompt (config-if-gpon-0/N)#
 *   - Lihat ONU      : show onu_information / show online-onu
 *   - Redaman        : show onu optical-info <id> all   (Rx/Tx/OLT-Rx per ONU)
 *   - Authorize      : onu add <id> type <T> sn <SN>  (atau whitelist add)
 *   - Edit deskripsi : onu <id> description <desc>
 *   - Reboot         : onu reboot <id>
 *   - Hapus          : no onu <id>
 *
 * Index ONU di keluarga ini: <port>/<onu_id>  (mis. 1/5 = PON port 1, ONU 5).
 * Berbeda dengan ZTE yang pakai frame/slot/port:onu.
 *
 * Subclass (CDATA/HIOSO/ZIMMLINK) cukup override objek `cmd` (template
 * perintah) dan/atau parser bila format outputnya berbeda. Default di sini
 * mengikuti dokumentasi CDATA/Cortina yang paling umum.
 *
 * ⚠️ Perintah CLI bisa berbeda antar versi firmware. Selalu Test Koneksi
 *    dan uji 1 ONU sebelum dipakai produksi.
 * ─────────────────────────────────────────────────────────────────────
 */

const BaseCliOltService = require('./BaseCliOltService');
const logger = require('../utils/logger');

class GponCliOltService extends BaseCliOltService {
  constructor(config = {}) {
    super(config);
    this.brand = config.brand || 'gpon';

    // Template perintah — bisa di-override subclass.
    // {port} = nomor PON port, {id} = onu id, {sn} {type} {desc} {name}
    this.cmd = Object.assign({
      enter:        'configure terminal',
      exit:         'end',
      ifEnter:      'interface gpon 0/{port}',
      ifExit:       'exit',
      versionCheck: 'show system info',
      // Read
      onuList:      'show onu_information',          // semua ONU pada port aktif
      onuOptical:   'show onu optical-info {id} all',// redaman 1 ONU
      onuDetail:    'show onu detail-info {id}',     // detail 1 ONU
      uncfg:        'show onu auto-find',            // ONU belum terdaftar
      // System & ringkasan
      sysInfo:      'show system info',              // uptime/versi
      cpu:          'show cpu',                      // utilisasi CPU
      temperature:  'show temperature',             // suhu
      portState:    'show gpon onu state',           // ringkasan state port (chipset)
      // VLAN global
      vlanList:     'show vlan all',                 // daftar VLAN di OLT
      vlanCreate:   'vlan {vid}',                    // buat VLAN (di config mode)
      vlanDelete:   'no vlan {vid}',                 // hapus VLAN
      // VLAN per-ONU (service-port). Template umum chipset Cortina:
      onuVlanList:  'show onu service-port {id}',     // lihat service-port ONU
      onuVlanSet:   'onu {id} service-port {sp} gemport {gem} user-vlan {uvlan} vlan {vlan}',
      onuVlanDel:   'no onu {id} service-port {sp}',
      // Write
      authorize:    'onu add {id} type {type} sn {sn}',
      editName:     'onu {id} name {name}',
      editDesc:     'onu {id} description {desc}',
      reboot:       'onu reboot {id}',
      del:          'no onu {id}',
    }, config.cmd || {});

    // Ambang redaman (dBm) untuk klasifikasi kualitas Rx ONU.
    this.rxGood    = config.rxGood    ?? -25;
    this.rxWarning = config.rxWarning ?? -28;
  }

  // ── Helpers index ──────────────────────────────────────────────────
  // Normalisasi "0/1" / "1" / "gpon 0/1" → { port }
  _normPort(p) {
    const s = String(p || '').trim().replace(/^.*gpon\s*/i, '').replace(/^0\//, '');
    const m = s.match(/(\d+)/);
    return m ? parseInt(m[1]) : null;
  }
  _fmt(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  }

  // ── Test koneksi ───────────────────────────────────────────────────
  async testConnection() {
    try {
      await this.connect();
      const out = await this._safeExec(this.cmd.versionCheck)
              || await this._safeExec('show version')
              || await this._safeExec('show system');
      await this.disconnect();
      const firstLine = String(out).split('\n').map(s => s.trim()).filter(Boolean)[0] || 'OK';
      return { success: true, message: `Terhubung ke ${this.name} (${this.protocol.toUpperCase()})`, info: firstLine.slice(0, 160) };
    } catch (err) {
      await this.disconnect();
      return { success: false, error: err.message };
    }
  }

  // ── Daftar ONU pada PON port ───────────────────────────────────────
  async getOnuState(portRef, { withPower = false } = {}) {
    const port = this._normPort(portRef);
    if (port == null) throw new Error('PON port tidak valid: ' + portRef);

    await this._enterIf(port);
    const out = await this.exec(this.cmd.onuList);
    let list = this.parseOnuList(out, port);

    if (withPower) {
      for (const o of list) {
        try {
          const optOut = await this.exec(this._fmt(this.cmd.onuOptical, { id: o.onu_id }));
          const p = this.parseOptical(optOut, o.onu_id);
          o.onu_rx_dbm = p.onu_rx_dbm;
          o.quality    = p.quality;
        } catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
      }
    }
    await this._exitIf();
    return list;
  }

  // ── ONU belum terdaftar (auto-find) ────────────────────────────────
  async getUncfgOnu(portRef = null) {
    let out;
    if (portRef != null && this._normPort(portRef) != null) {
      const port = this._normPort(portRef);
      await this._enterIf(port);
      out = await this.exec(this.cmd.uncfg);
      await this._exitIf();
    } else {
      // Mode global (sebagian firmware mendukung tanpa masuk interface)
      await this._enterConfig();
      out = await this._safeExec(this.cmd.uncfg);
      await this._exitConfig();
    }
    return this.parseUncfg(out, this._normPort(portRef));
  }

  // ── Detail + redaman 1 ONU ─────────────────────────────────────────
  async getOnuDetail(portRef, onuId) {
    const port = this._normPort(portRef);
    await this._enterIf(port);
    const [detOut, optOut] = [
      await this._safeExec(this._fmt(this.cmd.onuDetail, { id: onuId })),
      await this._safeExec(this._fmt(this.cmd.onuOptical, { id: onuId })),
    ];
    await this._exitIf();
    const detail = this.parseOnuDetail(detOut, port, onuId);
    detail.power = this.parseOptical(optOut, onuId);
    return detail;
  }

  async getOnuPower(portRef, onuId) {
    const port = this._normPort(portRef);
    await this._enterIf(port);
    const out = await this.exec(this._fmt(this.cmd.onuOptical, { id: onuId }));
    await this._exitIf();
    return this.parseOptical(out, onuId);
  }

  // ── Info sistem OLT (uptime, versi, CPU, suhu) ─────────────────────
  async getSystemInfo() {
    const sys = await this._safeExec(this.cmd.sysInfo);
    const cpu = await this._safeExec(this.cmd.cpu);
    const temp = await this._safeExec(this.cmd.temperature);
    return this.parseSystemInfo(sys, cpu, temp);
  }

  // ── Ringkasan tiap PON port (jumlah ONU online/offline) ────────────
  // ports: array nomor port yang ingin diringkas (mis. [1,2,3,4]).
  async getPortSummary(ports = []) {
    const result = [];
    for (const p of ports) {
      try {
        await this._enterIf(p);
        const out = await this.exec(this.cmd.onuList);
        await this._exitIf();
        const list = this.parseOnuList(out, p);
        const online = list.filter(o => o.status === 'online').length;
        result.push({ port: p, total: list.length, online, offline: list.length - online });
      } catch (e) {
        result.push({ port: p, total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return result;
  }

  // ── Auto-discover PON port (chipset) ───────────────────────────────
  // Chipset GPON tidak selalu punya "show card". Strategi: probe port 1..N,
  // ambil port yang merespons onuList tanpa error. defaultPorts bisa
  // di-override subclass (mis. CDATA FD16xx = 16 port, HIOSO = 8, dst).
  async discoverPonPorts({ maxPorts = null } = {}) {
    const limit = maxPorts || this.defaultPonPorts || 8;
    const found = [];
    for (let p = 1; p <= limit; p++) {
      try {
        await this._enterIf(p);
        const out = await this.exec(this.cmd.onuList);
        await this._exitIf();
        // Port valid bila perintah tidak menolak interface-nya.
        if (!/invalid|does not exist|no such|incomplete|unknown command/i.test(String(out))) {
          found.push(String(p));
        }
      } catch (e) {
        try { await this._exitIf(); } catch (_) {}
        // Error masuk interface → kemungkinan port tidak ada; berhenti bila
        // sudah ketemu minimal 1 port (port di atasnya kemungkinan juga kosong).
        if (found.length) break;
      }
    }
    return found;
  }

  // ── Ambil SEMUA ONU lintas PON port dalam satu koneksi ─────────────
  async getAllOnus({ withPower = false, ports = null, maxPorts = 16 } = {}) {
    const ponPorts = (ports && ports.length) ? ports.map(p => this._normPort(p)).filter(p => p != null)
                                             : (await this.discoverPonPorts()).map(p => parseInt(p));
    const slice = ponPorts.slice(0, maxPorts);
    const allOnus = [];
    const portSummary = [];

    for (const port of slice) {
      try {
        await this._enterIf(port);
        const out = await this.exec(this.cmd.onuList);
        let list = this.parseOnuList(out, port);
        if (withPower) {
          for (const o of list) {
            try {
              const optOut = await this.exec(this._fmt(this.cmd.onuOptical, { id: o.onu_id }));
              const pw = this.parseOptical(optOut, o.onu_id);
              o.onu_rx_dbm = pw.onu_rx_dbm; o.quality = pw.quality;
            } catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
          }
        }
        await this._exitIf();
        list.forEach(o => { o.pon = String(port); });
        allOnus.push(...list);
        const online = list.filter(o => o.status === 'online').length;
        portSummary.push({ port: String(port), total: list.length, online, offline: list.length - online });
      } catch (e) {
        try { await this._exitIf(); } catch (_) {}
        portSummary.push({ port: String(port), total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return { onus: allOnus, ports: portSummary, scannedPorts: slice.map(String) };
  }

  // ── VLAN global ────────────────────────────────────────────────────
  async getVlans() {
    await this._enterConfig();
    const out = await this._safeExec(this.cmd.vlanList);
    await this._exitConfig();
    return this.parseVlanList(out);
  }

  async createVlan(vid, name) {
    vid = parseInt(vid);
    if (!vid || vid < 1 || vid > 4094) throw new Error('VLAN ID harus 1-4094');
    await this._enterConfig();
    let out = await this.exec(this._fmt(this.cmd.vlanCreate, { vid }));
    if (name && this.cmd.vlanName) out += '\n' + await this._safeExec(this._fmt(this.cmd.vlanName, { vid, name }));
    await this._exitConfig();
    if (/error|invalid|fail/i.test(out)) throw new Error('Buat VLAN gagal: ' + this._firstError(out));
    return { success: true, vid };
  }

  async deleteVlan(vid) {
    vid = parseInt(vid);
    await this._enterConfig();
    const out = await this.exec(this._fmt(this.cmd.vlanDelete, { vid }));
    await this._exitConfig();
    if (/error|invalid|fail/i.test(out)) throw new Error('Hapus VLAN gagal: ' + this._firstError(out));
    return { success: true };
  }

  // ── VLAN per-ONU (service-port) ────────────────────────────────────
  async getOnuVlans(portRef, onuId) {
    const port = this._normPort(portRef);
    await this._enterIf(port);
    const out = await this._safeExec(this._fmt(this.cmd.onuVlanList, { id: onuId }));
    await this._exitIf();
    return this.parseOnuVlans(out, onuId);
  }

  async setOnuVlan(portRef, onuId, { sp = 1, gem = 1, userVlan, vlan }) {
    const port = this._normPort(portRef);
    if (!vlan) throw new Error('vlan wajib diisi');
    await this._enterIf(port);
    const out = await this.exec(this._fmt(this.cmd.onuVlanSet, {
      id: onuId, sp, gem, uvlan: userVlan || vlan, vlan,
    }));
    await this._exitIf();
    if (/error|invalid|fail/i.test(out)) throw new Error('Set VLAN ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  async deleteOnuVlan(portRef, onuId, sp) {
    const port = this._normPort(portRef);
    await this._enterIf(port);
    const out = await this.exec(this._fmt(this.cmd.onuVlanDel, { id: onuId, sp }));
    await this._exitIf();
    if (/error|invalid|fail/i.test(out)) throw new Error('Hapus VLAN ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  // ════════════════════════════════════════════════════════════════════
  // ACTIONS (write)
  // ════════════════════════════════════════════════════════════════════
  async _enterConfig() {
    if (this.enablePassword) { await this._safeExec('enable'); await this._safeExec(this.enablePassword); }
    await this.exec(this.cmd.enter);
  }
  async _exitConfig() { await this._safeExec(this.cmd.exit); }

  async _enterIf(port) {
    await this._enterConfig();
    await this.exec(this._fmt(this.cmd.ifEnter, { port }));
  }
  async _exitIf() {
    await this._safeExec(this.cmd.ifExit);
    await this._exitConfig();
  }

  async authorizeOnu({ port, onuId, type, sn, name, description }) {
    const p = this._normPort(port);
    onuId = parseInt(onuId);
    if (p == null || !onuId || !type || !sn) throw new Error('port, onuId, type, dan sn wajib diisi');
    await this._enterIf(p);
    let out = await this.exec(this._fmt(this.cmd.authorize, { id: onuId, type, sn }));
    if (name)        out += '\n' + await this._safeExec(this._fmt(this.cmd.editName, { id: onuId, name }));
    if (description) out += '\n' + await this._safeExec(this._fmt(this.cmd.editDesc, { id: onuId, desc: description }));
    await this._exitIf();
    if (/error|invalid|fail|denied/i.test(out)) throw new Error('Authorize ditolak: ' + this._firstError(out));
    return { success: true, port: p, onuId };
  }

  async editOnu(portRef, onuId, { name, description } = {}) {
    const p = this._normPort(portRef);
    await this._enterIf(p);
    let out = '';
    if (name        !== undefined) out += '\n' + await this.exec(this._fmt(this.cmd.editName, { id: onuId, name }));
    if (description !== undefined) out += '\n' + await this.exec(this._fmt(this.cmd.editDesc, { id: onuId, desc: description }));
    await this._exitIf();
    if (/error|invalid|fail/i.test(out)) throw new Error('Edit ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  async rebootOnu(portRef, onuId) {
    const p = this._normPort(portRef);
    await this._enterIf(p);
    const out = await this.exec(this._fmt(this.cmd.reboot, { id: onuId }));
    await this._exitIf();
    if (/error|invalid|fail/i.test(out)) throw new Error('Reboot gagal: ' + this._firstError(out));
    return { success: true };
  }

  async deleteOnu(portRef, onuId) {
    const p = this._normPort(portRef);
    await this._enterIf(p);
    const out = await this.exec(this._fmt(this.cmd.del, { id: onuId }));
    await this._exitIf();
    if (/error|invalid|fail/i.test(out)) throw new Error('Hapus gagal: ' + this._firstError(out));
    return { success: true };
  }

  // ════════════════════════════════════════════════════════════════════
  // PARSERS (default Cortina/CDATA-style — override di subclass bila beda)
  // ════════════════════════════════════════════════════════════════════

  // Output umum:
  //   ONU-ID  SN              State    Description
  //   1       CDTAxxxxxxxx    online   Customer-A
  parseOnuList(out, port) {
    const list = [];
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      // baris data: diawali angka (onu id)
      const m = t.match(/^(\d+)\s+([0-9A-Za-z\-:]+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) return;
      if (/onu[\s_-]?id/i.test(t)) return; // header
      const onuId = parseInt(m[1]);
      const sn = m[2];
      const stateRaw = (m[3] || '').toLowerCase();
      let status = 'offline';
      if (/online|up|working|active|auth|normal/.test(stateRaw)) status = 'online';
      else if (/disable|deactiv/.test(stateRaw)) status = 'disabled';
      list.push({
        onu_id: onuId,
        port,
        onu_if: `${port}/${onuId}`,
        sn,
        type: null,
        name: m[4] ? m[4].trim() : null,
        admin_state: null,
        phase_state: m[3] || null,
        status,
      });
    });
    return list;
  }

  // show onu auto-find:
  //   PORT  SN              STATE
  //   1     CDTAxxxxxxxx    autofind
  parseUncfg(out, port) {
    const list = [];
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      const m = t.match(/(?:^|\s)(\d+)\s+([0-9A-Za-z]{8,})\s*(\S+)?/);
      if (!m) return;
      if (/sn|serial|state|port/i.test(t) && !/[0-9A-Fa-f]{8,}/.test(m[2])) return;
      list.push({
        port: port ?? parseInt(m[1]),
        sn: m[2],
        state: m[3] || 'autofind',
        next_onu_id: null,
      });
    });
    return list;
  }

  // show onu optical-info <id> all  (Cortina/CDATA-style):
  //   ONU-ID  Rx(dBm)  Tx(dBm)  OLT-Rx(dBm)  Temp  Volt  Current
  //   5       -22.30   2.10     -23.40       45    3.3   12
  parseOptical(out, onuId) {
    const s = String(out);
    const noSignal = /no\s*signal|los|n\/a/i.test(s) && !/-?\d+\.\d+/.test(s);
    // Cari baris yang memuat onuId lalu ambil angka desimal pertama (Rx) & kedua (Tx)
    let onu_rx = null, onu_tx = null, olt_rx = null;
    const lines = s.split('\n');
    for (const ln of lines) {
      const t = ln.trim();
      if (!/^\d+\s/.test(t)) continue;
      const nums = t.match(/-?\d+\.\d+/g);
      const idMatch = t.match(/^(\d+)/);
      if (nums && nums.length >= 2 && idMatch && parseInt(idMatch[1]) === parseInt(onuId)) {
        onu_rx = parseFloat(nums[0]);
        onu_tx = parseFloat(nums[1]);
        if (nums.length >= 3) olt_rx = parseFloat(nums[2]);
        break;
      }
    }
    // Fallback: label-based (Rx power: -22.3 dBm)
    if (onu_rx === null) {
      const rxm = s.match(/Rx[^\-\d]*(-?\d+\.\d+)/i);
      const txm = s.match(/Tx[^\-\d]*(-?\d+\.\d+)/i);
      if (rxm) onu_rx = parseFloat(rxm[1]);
      if (txm) onu_tx = parseFloat(txm[1]);
    }

    let quality = 'unknown';
    if (noSignal || onu_rx === null && /off|los/i.test(s)) quality = 'los';
    else if (onu_rx !== null) {
      if (onu_rx >= this.rxGood) quality = 'good';
      else if (onu_rx >= this.rxWarning) quality = 'warning';
      else quality = 'critical';
    }

    return {
      onu_if: `?/${onuId}`,
      onu_rx_dbm: onu_rx,
      onu_tx_dbm: onu_tx,
      olt_rx_dbm: olt_rx,
      olt_tx_dbm: null,
      no_signal: noSignal,
      quality,
      raw: s.trim().slice(0, 2000),
    };
  }

  parseOnuDetail(out, port, onuId) {
    const get = (label) => {
      const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\\s*(.+)', 'i');
      const m = String(out).match(re);
      return m ? m[1].trim() : null;
    };
    const distStr = get('Distance') || get('ONU Distance');
    return {
      onu_if:        `${port}/${onuId}`,
      name:          get('Name'),
      type:          get('Type') || get('Model'),
      state:         get('State') || get('Status'),
      admin_state:   get('Admin'),
      phase_state:   get('Phase'),
      auth_mode:     get('Auth') || get('Authentication'),
      serial_number: get('SN') || get('Serial') || get('Serial number'),
      description:   get('Description'),
      distance_m:    distStr ? (parseInt(String(distStr).replace(/[^\d]/g, '')) || null) : null,
      online_duration: get('Online') || get('Duration') || get('Uptime'),
      raw: String(out).trim().slice(0, 4000),
    };
  }

  // ── Parser system info ─────────────────────────────────────────────
  parseSystemInfo(sysOut, cpuOut, tempOut) {
    const all = String(sysOut);
    const grab = (re, src = all) => { const m = String(src).match(re); return m ? m[1].trim() : null; };
    const uptime  = grab(/up\s*time\s*[:=]?\s*(.+)/i) || grab(/uptime\s*[:=]?\s*(.+)/i);
    const version = grab(/(?:firmware|software|sw)\s*(?:ver(?:sion)?)?\s*[:=]\s*v?([\w.\-]+)/i)
                 || grab(/\bversion\s*[:=]\s*v?([\w.\-]+)/i);
    const hw      = grab(/hardware\s*(?:ver)?\s*[:=]?\s*(\S+)/i);
    const model   = grab(/(?:product|model|device)\s*(?:name)?\s*[:=]?\s*(.+)/i);
    // CPU: cari angka% pertama
    const cpuM = String(cpuOut).match(/(\d+(?:\.\d+)?)\s*%/);
    const cpu  = cpuM ? parseFloat(cpuM[1]) : null;
    // Suhu: cari angka diikuti C
    const tM = String(tempOut).match(/(-?\d+(?:\.\d+)?)\s*(?:°|deg)?\s*C/i);
    const temp = tM ? parseFloat(tM[1]) : null;
    return {
      model, version, hw_version: hw, uptime,
      cpu_percent: cpu, temperature_c: temp,
      raw: all.trim().slice(0, 2000),
    };
  }

  // ── Parser VLAN list ───────────────────────────────────────────────
  //   VLAN-ID  Name        Type      Ports
  //   100      INTERNET    static    ...
  parseVlanList(out) {
    const vlans = [];
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      const m = t.match(/^(\d{1,4})\s+(\S+)?(?:\s+(\S+))?(?:\s+(.*))?$/);
      if (!m) return;
      const vid = parseInt(m[1]);
      if (!vid || vid > 4094) return;
      if (/vlan[\s-]?id|^id\b/i.test(t)) return; // header
      vlans.push({
        vid,
        name: m[2] && !/^\d/.test(m[2]) ? m[2] : null,
        type: m[3] || null,
        ports: m[4] ? m[4].trim() : null,
      });
    });
    return vlans;
  }

  // ── Parser VLAN per-ONU (service-port) ─────────────────────────────
  parseOnuVlans(out, onuId) {
    const list = [];
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      // SP  GEM  USER-VLAN  VLAN
      const m = t.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (!m) return;
      list.push({
        service_port: parseInt(m[1]),
        gemport: parseInt(m[2]),
        user_vlan: parseInt(m[3]),
        vlan: parseInt(m[4]),
      });
    });
    // Fallback: cari pasangan "vlan N"
    if (!list.length) {
      const re = /vlan\s+(\d+)/gi; let mm;
      while ((mm = re.exec(String(out))) !== null) list.push({ service_port: list.length + 1, vlan: parseInt(mm[1]) });
    }
    return list;
  }
}

module.exports = GponCliOltService;
