'use strict';

/**
 * HsgqEponOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * OLT EPON HSGQ-E04I / E08 (firmware NEUTRAL "epon_firmware_I_V2.2.0_Rel").
 *
 * Berbeda dari OLT GPON (ZTE/CDATA/HIOSO/ZIMMLINK):
 *   - Ini EPON, ONU diidentifikasi via MAC ADDRESS (bukan serial number GPON).
 *   - Index PON: epon <port>  (E04I punya 4 PON), prompt (config-epon-N)#.
 *   - Index ONU global: <pon>/<onu_id>  (mis. 1/1 = PON1 ONU1).
 *   - Authorize = bind-onu mac <mac> lalu onu confirm onu-id <id>.
 *   - VLAN dibuat di switch side: vlan standard <vid> + port epon/ge tagged.
 *
 * Sumber perintah: NEUTRAL OLT User Manual V2.2.0 (yang diberikan user).
 *
 * Login default pabrik: root / admin. Untuk masuk privileged:
 *   enable → configure
 *
 * ⚠️ Beberapa perintah bergantung versi firmware. Selalu Test Koneksi &
 *    uji 1 ONU sebelum dipakai produksi.
 * ─────────────────────────────────────────────────────────────────────
 */

const BaseCliOltService = require('./BaseCliOltService');
const logger = require('../utils/logger');

class HsgqEponOltService extends BaseCliOltService {
  constructor(config = {}) {
    super(config);
    this.brand = 'hsgq';
    this.rxGood    = config.rxGood    ?? -25;
    this.rxWarning = config.rxWarning ?? -28;
    // E04I = 4 PON, E08 = 8 PON. Dipakai auto-discover.
    this.defaultPonPorts = config.defaultPonPorts || 4;
  }

  // ── Helpers ────────────────────────────────────────────────────────
  _normPort(p) {
    const s = String(p || '').trim().replace(/^.*epon[\s_-]?/i, '');
    const m = s.match(/(\d+)/);
    return m ? parseInt(m[1]) : null;
  }
  // ONU ref "1/3" → {pon:1, id:3}
  _splitRef(ref) {
    const m = String(ref || '').match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return { pon: parseInt(m[1]), id: parseInt(m[2]) };
    return {};
  }

  // ── Privileged & config mode (root/admin → enable → configure) ─────
  async _enterPriv() {
    // Sebagian unit langsung di prompt '#', enable tetap aman dipanggil
    await this._safeExec('enable');
    if (this.enablePassword) await this._safeExec(this.enablePassword);
  }
  async _enterConfig() {
    await this._enterPriv();
    await this.exec('configure');
  }
  async _exitConfig() { await this._safeExec('exit'); }

  async _enterEpon(pon) {
    await this._enterConfig();
    await this.exec(`interface epon ${pon}`);
  }
  async _exitEpon() {
    await this._safeExec('exit');   // keluar dari epon node
    await this._exitConfig();       // keluar dari config
  }

  // ── Test koneksi ───────────────────────────────────────────────────
  async testConnection() {
    try {
      await this.connect();
      await this._enterConfig();
      await this._safeExec('interface manage');
      const out = await this._safeExec('board');
      await this._safeExec('exit');
      await this._exitConfig();
      await this.disconnect();
      const line = String(out).split('\n').map(s => s.trim()).find(l => /version|neutral|hsgq/i.test(l)) || 'OK';
      return { success: true, message: `Terhubung ke ${this.name} (${this.protocol.toUpperCase()})`, info: line.slice(0, 160) };
    } catch (err) {
      await this.disconnect();
      return { success: false, error: err.message };
    }
  }

  // ── Daftar ONU pada satu PON ───────────────────────────────────────
  async getOnuState(portRef, { withPower = false } = {}) {
    const pon = this._normPort(portRef);
    if (pon == null) throw new Error('PON port tidak valid: ' + portRef);
    await this._enterEpon(pon);
    const out = await this.exec('show onu-info all');
    let list = this._parseOnuInfoAll(out, pon);

    if (withPower) {
      for (const o of list) {
        try {
          const d = await this.exec(`show onu-info onu-id ${o.onu_id}`);
          const p = this._parseOptical(d);
          o.onu_rx_dbm = p.onu_rx_dbm;
          o.quality    = p.quality;
        } catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
      }
    }
    await this._exitEpon();
    return list;
  }

  // ── ONU belum terdaftar (Initial / auth pending) ───────────────────
  // Pada HSGQ, ONU yang belum di-confirm muncul di show onu-info all dengan
  // Config-State FALSE / Status Initial. Kita filter dari situ.
  async getUncfgOnu(portRef = null) {
    const pons = portRef != null ? [this._normPort(portRef)] : [1, 2, 3, 4];
    const list = [];
    for (const pon of pons) {
      if (pon == null) continue;
      try {
        await this._enterEpon(pon);
        const out = await this.exec('show onu-info all');
        await this._exitEpon();
        this._parseOnuInfoAll(out, pon).forEach(o => {
          if (o.config_state === false || /initial|auth-?fail|unauth/i.test(o.phase_state || '')) {
            list.push({ port: pon, onu_id: o.onu_id, mac: o.mac, sn: o.mac, state: o.phase_state || 'initial' });
          }
        });
      } catch (e) { /* skip pon */ }
    }
    return list;
  }

  // ── Detail + redaman 1 ONU ─────────────────────────────────────────
  async getOnuDetail(portRef, onuId) {
    const pon = this._normPort(portRef);
    await this._enterEpon(pon);
    const out = await this.exec(`show onu-info onu-id ${onuId}`);
    await this._exitEpon();
    const detail = this._parseOnuDetail(out, pon, onuId);
    detail.power = this._parseOptical(out);
    return detail;
  }

  async getOnuPower(portRef, onuId) {
    const pon = this._normPort(portRef);
    await this._enterEpon(pon);
    const out = await this.exec(`show onu-info onu-id ${onuId}`);
    await this._exitEpon();
    return this._parseOptical(out);
  }

  // ── Info sistem (interface manage → board) ─────────────────────────
  async getSystemInfo() {
    await this._enterConfig();
    await this._safeExec('interface manage');
    const board = await this._safeExec('board');
    await this._safeExec('exit');
    const tz = await this._safeExec('show timezone');
    const tm = await this._safeExec('time');
    await this._exitConfig();
    const grab = (re, src = board) => { const m = String(src).match(re); return m ? m[1].trim() : null; };
    // Uptime dari "time": System running time : 0 day 0 hour 13 minute 28 second
    const up = String(tm).match(/running time\s*[:=]\s*(.+)/i);
    return {
      model:        grab(/(?:Neutral|HSGQ)[\w.\-]*/i, board) ? (String(board).match(/(?:Neutral|HSGQ)[\w.\-]*/i) || [])[0] : grab(/hostname\s*[:=]\s*(\S+)/i),
      version:      grab(/Software Version\s*[:=]\s*(\S+)/i),
      hw_version:   grab(/Hardware Version\s*[:=]\s*(\S+)/i),
      uptime:       up ? up[1].trim() : null,
      cpu_percent:  null,   // firmware ini tidak expose CPU via CLI standar
      temperature_c: null,  // idem suhu
      mac:          grab(/Base Mac Address\s*[:=]\s*([0-9a-f:]+)/i),
      raw: String(board).trim().slice(0, 2000),
    };
  }

  // ── Ringkasan per PON ──────────────────────────────────────────────
  async getPortSummary(ports = []) {
    const result = [];
    for (const pr of ports) {
      const pon = this._normPort(pr);
      if (pon == null) { result.push({ port: pr, total: 0, online: 0, offline: 0, error: 'port invalid' }); continue; }
      try {
        await this._enterEpon(pon);
        const out = await this.exec('show onu-info all');
        await this._exitEpon();
        const list = this._parseOnuInfoAll(out, pon);
        const online = list.filter(o => o.status === 'online').length;
        result.push({ port: pon, total: list.length, online, offline: list.length - online });
      } catch (e) {
        result.push({ port: pon, total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return result;
  }

  // ── Auto-discover PON port (EPON HSGQ) ─────────────────────────────
  // E04I = 4 PON, E08 = 8 PON. Default 4; bisa di-override via config.
  async discoverPonPorts() {
    const max = this.defaultPonPorts || 4;
    return Array.from({ length: max }, (_, i) => String(i + 1));
  }

  // ── Ambil SEMUA ONU lintas PON dalam satu koneksi ──────────────────
  async getAllOnus({ withPower = false, ports = null, maxPorts = 8 } = {}) {
    const list = (ports && ports.length) ? ports.map(p => this._normPort(p)).filter(p => p != null)
                                         : (await this.discoverPonPorts()).map(p => parseInt(p));
    const slice = list.slice(0, maxPorts);
    const allOnus = [];
    const portSummary = [];

    for (const pon of slice) {
      try {
        await this._enterEpon(pon);
        const out = await this.exec('show onu-info all');
        let onus = this._parseOnuInfoAll(out, pon);
        if (withPower) {
          for (const o of onus) {
            try {
              const d = await this.exec(`show onu-info onu-id ${o.onu_id}`);
              const p = this._parseOptical(d);
              o.onu_rx_dbm = p.onu_rx_dbm; o.quality = p.quality;
            } catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
          }
        }
        await this._exitEpon();
        onus.forEach(o => { o.pon = String(pon); });
        allOnus.push(...onus);
        const online = onus.filter(o => o.status === 'online').length;
        portSummary.push({ port: String(pon), total: onus.length, online, offline: onus.length - online });
      } catch (e) {
        try { await this._exitEpon(); } catch (_) {}
        portSummary.push({ port: String(pon), total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return { onus: allOnus, ports: portSummary, scannedPorts: slice.map(String) };
  }

  // ════════════════════════════════════════════════════════════════════
  // ACTIONS — ONU
  // ════════════════════════════════════════════════════════════════════

  /**
   * Authorize ONU EPON: bind MAC ke onu-id lalu confirm.
   * p: { port, onuId, mac, sn(=mac alias), name?, description? }
   * Catatan: EPON pakai MAC. Field "sn" dari UI dipetakan ke mac.
   */
  async authorizeOnu({ port, onuId, mac, sn, name, description }) {
    const pon = this._normPort(port);
    const macAddr = (mac || sn || '').trim();
    if (pon == null || !macAddr) throw new Error('port dan MAC address wajib diisi');
    await this._enterEpon(pon);
    let out = '';
    if (onuId) {
      // Bind eksplisit ke onu-id tertentu
      out += await this.exec(`bind-onu mac ${macAddr}`);
      out += '\n' + await this.exec(`onu confirm onu-id ${parseInt(onuId)}`);
    } else {
      // Biarkan sistem assign onu-id
      out += await this.exec(`bind-onu mac ${macAddr}`);
    }
    if (description && onuId) out += '\n' + await this._safeExec(`onu-description onu-id ${parseInt(onuId)} ${description}`);
    await this._exitEpon();
    if (/error|invalid|fail|denied/i.test(out)) throw new Error('Authorize ditolak: ' + this._firstError(out));
    return { success: true, port: pon, onuId: onuId ? parseInt(onuId) : null, mac: macAddr };
  }

  async editOnu(portRef, onuId, { name, description } = {}) {
    const pon = this._normPort(portRef);
    await this._enterEpon(pon);
    let out = '';
    // Firmware ini umumnya hanya mendukung deskripsi ONU
    if (description !== undefined) out += await this._safeExec(`onu-description onu-id ${onuId} ${description}`);
    if (name !== undefined)        out += '\n' + await this._safeExec(`onu-description onu-id ${onuId} ${name}`);
    await this._exitEpon();
    if (/error|invalid|fail/i.test(out)) throw new Error('Edit ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  async rebootOnu(portRef, onuId) {
    const pon = this._normPort(portRef);
    await this._enterEpon(pon);
    const out = await this.exec(`onu reboot onu-id ${onuId}`);
    await this._exitEpon();
    if (/error|invalid|fail/i.test(out)) throw new Error('Reboot gagal: ' + this._firstError(out));
    return { success: true };
  }

  async deleteOnu(portRef, onuId) {
    const pon = this._normPort(portRef);
    await this._enterEpon(pon);
    // Hapus / unbind ONU
    const out = await this.exec(`no onu onu-id ${onuId}`);
    await this._exitEpon();
    if (/error|invalid|fail/i.test(out)) throw new Error('Hapus gagal: ' + this._firstError(out));
    return { success: true };
  }

  // ════════════════════════════════════════════════════════════════════
  // ACTIONS — VLAN (switch side)
  // ════════════════════════════════════════════════════════════════════
  async getVlans() {
    await this._enterConfig();
    // HSGQ: "show vlan" sendiri hanya menampilkan submenu (all/protocol/qinq/
    // translation). Data VLAN sebenarnya dari "show vlan all".
    const out = await this._safeExec('show vlan all');
    await this._exitConfig();
    return this._parseVlanList(out);
  }

  async createVlan(vid, name, { tagPorts } = {}) {
    vid = parseInt(vid);
    if (!vid || vid < 1 || vid > 4094) throw new Error('VLAN ID harus 1-4094');
    await this._enterConfig();
    let out = await this.exec(`vlan standard ${vid}`);
    // Default: tag-kan PON1 & GE1 agar VLAN langsung dapat dipakai uplink + pon
    const ports = tagPorts || ['epon 1', 'ge 1'];
    for (const p of ports) out += '\n' + await this._safeExec(`port ${p} tagged`);
    out += '\n' + await this._safeExec('exit');
    await this._exitConfig();
    if (/error|invalid|fail/i.test(out)) throw new Error('Buat VLAN gagal: ' + this._firstError(out));
    return { success: true, vid };
  }

  async deleteVlan(vid) {
    vid = parseInt(vid);
    await this._enterConfig();
    // Masuk ke node vlan lalu hapus (sesuai manual: no vlan <vid> di dalam vlan node)
    let out = await this._safeExec(`vlan standard ${vid}`);
    out += '\n' + await this.exec(`no vlan ${vid}`);
    await this._exitConfig();
    if (/error|invalid|fail/i.test(out)) throw new Error('Hapus VLAN gagal: ' + this._firstError(out));
    return { success: true };
  }

  // VLAN per-ONU UNI (port-vlan mode tag) — EPON style
  async getOnuVlans(portRef, onuId) {
    const pon = this._normPort(portRef);
    await this._safeExec(''); // noop
    await this._enterConfig();
    await this._safeExec(`interface onu ${pon}/${onuId}`);
    const out = await this._safeExec('show onu-link-staus') || await this._safeExec('show port-vlan');
    await this._safeExec('exit');
    await this._exitConfig();
    return this._parseOnuVlans(out);
  }

  // Set UNI VLAN tag: onu UNI port {uni} mode tag {vlan}
  async setOnuVlan(portRef, onuId, { sp = 1, vlan, userVlan, gem } = {}) {
    const pon = this._normPort(portRef);
    const uni = parseInt(sp) || 1;        // pakai SP sebagai nomor UNI port
    const v = parseInt(vlan || userVlan);
    if (!v) throw new Error('vlan wajib diisi');
    await this._enterConfig();
    await this.exec(`interface onu ${pon}/${onuId}`);
    const out = await this.exec(`port-vlan ${uni} mode tag ${v} pri 0`);
    await this._safeExec('exit');
    await this._exitConfig();
    if (/error|invalid|fail/i.test(out)) throw new Error('Set VLAN ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  async deleteOnuVlan(portRef, onuId, sp) {
    const pon = this._normPort(portRef);
    const uni = parseInt(sp) || 1;
    await this._enterConfig();
    await this.exec(`interface onu ${pon}/${onuId}`);
    // Kembalikan ke transparent (hapus tag)
    const out = await this.exec(`port-vlan ${uni} mode transparent`);
    await this._safeExec('exit');
    await this._exitConfig();
    if (/error|invalid|fail/i.test(out)) throw new Error('Hapus VLAN ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  // ════════════════════════════════════════════════════════════════════
  // PARSERS
  // ════════════════════════════════════════════════════════════════════

  // show onu-info all:
  // PON/ONU  Mac-Address        Status   Auth-State  Config-State  Reg-time  ONU-TYPE
  // 1/1      00:12:34:45:56:05  Online   TRUE        TRUE          2019/...  1ge
  _parseOnuInfoAll(out, pon) {
    const list = [];
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      const m = t.match(/^(\d+)\/(\d+)\s+([0-9a-fA-F:]{17})\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (!m) return;
      const onuId = parseInt(m[2]);
      const statusRaw = (m[4] || '').toLowerCase();
      let status = 'offline';
      if (/online|up|working|normal/.test(statusRaw)) status = 'online';
      else if (/initial|offline|down/.test(statusRaw)) status = 'offline';
      const configState = /true/i.test(m[6]);
      list.push({
        onu_id:  onuId,
        port:    pon,
        onu_if:  `${pon}/${onuId}`,
        mac:     m[3],
        sn:      m[3],                 // alias agar UI yang pakai "sn" tetap jalan
        type:    null,
        name:    null,
        phase_state: m[4],
        auth_state:  /true/i.test(m[5]),
        config_state: configState,
        status,
      });
    });
    return list;
  }

  // show onu-info onu-id N (detail vertikal "Key : Value")
  _parseOnuDetail(out, pon, onuId) {
    const get = (label) => {
      const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\\s*(.+)', 'i');
      const m = String(out).match(re);
      return m ? m[1].trim() : null;
    };
    return {
      onu_if:        `${pon}/${onuId}`,
      name:          get('ONU Name') || get('ONU description'),
      type:          get('ONU type') || get('ONU model'),
      state:         get('Status'),
      admin_state:   get('Authrize mode') || get('Authorize mode'),
      phase_state:   get('Status'),
      auth_mode:     get('Authrize mode') || get('Authorize mode'),
      serial_number: get('Mac address') || get('LOID'),
      mac:           get('Mac address'),
      loid:          get('LOID'),
      description:   get('ONU description'),
      distance_m:    (() => { const d = get('ONU RTT'); return d ? (parseInt(d) || null) : null; })(),
      online_duration: get('Online Duration'),
      vendor:        get('ONU vendor'),
      sw_version:    get('ONU sw(hw) version'),
      raw: String(out).trim().slice(0, 4000),
    };
  }

  // Redaman EPON: cari nilai Rx/Tx power (dBm) pada output detail
  _parseOptical(out) {
    const s = String(out);
    const num = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : null; };
    const onu_rx = num(/(?:ONU\s*)?Rx\s*power[^\-\d]*(-?\d+(?:\.\d+)?)/i)
               ?? num(/Receive\s*power[^\-\d]*(-?\d+(?:\.\d+)?)/i);
    const onu_tx = num(/(?:ONU\s*)?Tx\s*power[^\-\d]*(-?\d+(?:\.\d+)?)/i)
               ?? num(/Transmit\s*power[^\-\d]*(-?\d+(?:\.\d+)?)/i);
    const olt_rx = num(/OLT\s*Rx[^\-\d]*(-?\d+(?:\.\d+)?)/i);
    const noSignal = /no\s*signal|los\b/i.test(s) && onu_rx === null;

    let quality = 'unknown';
    if (noSignal) quality = 'los';
    else if (onu_rx !== null) {
      if (onu_rx >= this.rxGood) quality = 'good';
      else if (onu_rx >= this.rxWarning) quality = 'warning';
      else quality = 'critical';
    }
    return {
      onu_rx_dbm: onu_rx, onu_tx_dbm: onu_tx, olt_rx_dbm: olt_rx, olt_tx_dbm: null,
      no_signal: noSignal, quality, raw: s.trim().slice(0, 1500),
    };
  }

  // show vlan all (HSGQ EPON) — blok per-VLAN bergaya vertikal:
  //   VLAN ID            : 26
  //   Name               : VLAN26
  //   Description        : VLAN26
  //   Tagged Ports       : PON01-PON04,GE01-GE08
  //   Untagged Ports     :
  //   Default Vlan Ports :
  // Blok dipisah garis "----". Parse per-baris agar field kosong tidak
  // membuat parser "meloncat" ke baris berikutnya (bug regex greedy lama).
  _parseVlanList(out) {
    const vlans = [];
    const s = String(out);

    // Pecah jadi blok berdasarkan baris pemisah "----" ATAU awal "VLAN ID".
    // Gunakan pendekatan akumulasi baris: tiap kali ketemu "VLAN ID", mulai blok baru.
    let cur = null;
    const pushCur = () => { if (cur && cur.vid != null) vlans.push(cur); cur = null; };

    const field = (line, label) => {
      const re = new RegExp('^\\s*' + label + '\\s*[:=]\\s*(.*)$', 'i');
      const m = line.match(re);
      return m ? m[1].trim() : null;
    };

    s.split('\n').forEach(line => {
      const vidStr = field(line, 'VLAN ID');
      if (vidStr !== null) {
        // Awal blok VLAN baru.
        pushCur();
        const vid = parseInt(vidStr);
        cur = { vid: isNaN(vid) ? null : vid, name: null, description: null,
                type: 'standard', ports: null, untagged_ports: null, default_ports: null };
        return;
      }
      if (!cur) return;
      let v;
      if ((v = field(line, 'Name')) !== null) cur.name = v || null;
      else if ((v = field(line, 'Description')) !== null) cur.description = v || null;
      else if ((v = field(line, 'Tagged Ports')) !== null) cur.ports = v || null;
      else if ((v = field(line, 'Untagged Ports')) !== null) cur.untagged_ports = v || null;
      else if ((v = field(line, 'Default Vlan Ports')) !== null) cur.default_ports = v || null;
    });
    pushCur();

    // Fallback: bila format tak dikenali, coba tabel "vid name ..."
    if (!vlans.length) {
      s.split('\n').forEach(line => {
        const mm = line.trim().match(/^(\d{1,4})\b(?:\s+(\S+))?/);
        if (mm && parseInt(mm[1]) <= 4094 && !/vlan/i.test(line)) {
          vlans.push({ vid: parseInt(mm[1]), name: mm[2] || null, type: null, ports: null });
        }
      });
    }
    return vlans;
  }

  _parseOnuVlans(out) {
    const list = [];
    String(out).split('\n').forEach(line => {
      const m = line.trim().match(/port[- ]?vlan\s+(\d+).*?(?:tag|vlan)\s+(\d+)/i)
            || line.trim().match(/(\d+)\s+(?:tag|access)\s+(\d+)/i);
      if (m) list.push({ service_port: parseInt(m[1]), vlan: parseInt(m[2]) });
    });
    return list;
  }
}

module.exports = HsgqEponOltService;
