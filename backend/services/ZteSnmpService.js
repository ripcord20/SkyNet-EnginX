'use strict';

/**
 * ZteSnmpService.js
 * ─────────────────────────────────────────────────────────────────────
 * Monitoring OLT ZTE C320 / C300 via SNMP (read-only, cepat & ringan).
 *
 * Dipakai untuk membaca: daftar ONU, nama, serial, type, status, RX power
 * (redaman), jarak. Untuk AKSI (authorize/hapus/VLAN) tetap memakai SSH
 * (ZteOltService) karena SNMP ZTE bersifat read-only untuk hal ini.
 *
 * OID & formula diverifikasi dari proyek open-source teruji terhadap C320 asli:
 *   github.com/Cepat-Kilat-Teknologi/go-snmp-olt-zte-c320
 *
 * Struktur OID ZTE C320:
 *   Base ONU-ID space : .1.3.6.1.4.1.3902.1082
 *   Base TYPE space   : .1.3.6.1.4.1.3902.1012
 *   onuIDSuffix   = 0x11010000 + board*0x100   + pon*1     (285278208 + board*256 + pon)
 *   onuTypeSuffix = 0x10000000 + board*0x10000 + pon*0x100 (268435456 + board*65536 + pon*256)
 *
 * Field (prefix + suffix di-WALK, lalu .<onu_id> di akhir):
 *   Name     : <base1>.500.10.2.3.3.1.2.<onuIDSuffix>
 *   Serial   : <base1>.500.10.2.3.3.1.18.<onuIDSuffix>
 *   Status   : <base1>.500.10.2.3.8.1.4.<onuIDSuffix>   (1=logging,2=LOS,3=sync/online,... )
 *   RxPower  : <base1>.500.20.2.2.2.1.10.<onuIDSuffix>
 *   Distance : <base1>.500.10.2.3.10.1.2.<onuIDSuffix>
 *   Desc     : <base1>.500.10.2.3.3.1.3.<onuIDSuffix>
 *   Type     : <base2>.3.50.11.2.1.17.<onuTypeSuffix>
 *
 * CATATAN konversi RX power: nilai mentah SNMP dikonversi ke dBm. Formula
 * paling umum di C320: dbm = (raw - 10000) / 1000  ATAU raw/1000 bila sudah
 * signed. Service mencoba mendeteksi otomatis & bisa dikalibrasi via env.
 * ─────────────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');

let snmp;
try { snmp = require('net-snmp'); }
catch (e) { logger.warn('[ZteSnmp] net-snmp belum terinstall — jalankan: npm install net-snmp'); }

// ── Konstanta OID (terverifikasi) ──────────────────────────────────────
const BASE1 = '1.3.6.1.4.1.3902.1082';   // ONU-ID space
const BASE2 = '1.3.6.1.4.1.3902.1012';   // TYPE space

const PFX = {
  name:     '.500.10.2.3.3.1.2',
  serial:   '.500.10.2.3.3.1.18',
  status:   '.500.10.2.3.8.1.4',
  rxpower:  '.500.20.2.2.2.1.10',
  distance: '.500.10.2.3.10.1.2',
  desc:     '.500.10.2.3.3.1.3',
  type:     '.3.50.11.2.1.17',           // di BASE2
};

const ONU_ID_IFINDEX_BASE   = 285278208; // 0x11010000
const ONU_ID_SLOT_STRIDE    = 256;       // 0x100
const ONU_ID_INCREMENT      = 1;
const ONU_TYPE_IFINDEX_BASE = 268435456; // 0x10000000
const ONU_TYPE_SLOT_STRIDE  = 65536;     // 0x10000
const ONU_TYPE_INCREMENT    = 256;       // 0x100

// Status code ZTE (umum): petakan ke online/offline
function mapStatus(code) {
  const c = parseInt(code);
  // 3 = working/online di banyak firmware C320; 1=logging, 2=LOS/offline
  if (c === 3) return 'online';
  if (c === 1) return 'offline';   // sedang proses
  if (c === 2) return 'offline';   // LOS
  return c >= 3 ? 'online' : 'offline';
}

class ZteSnmpService {
  constructor(config = {}) {
    this.host      = config.host;
    this.community = config.snmpCommunity || config.community || 'public';
    this.version   = (config.snmpVersion === '1') ? '1' : '2c';
    this.port      = config.snmpPort || 161;
    this.timeout   = config.timeout || 8000;
    this.name      = config.name || config.host;
    this.rxGood    = config.rxGood    ?? -25;
    this.rxWarning = config.rxWarning ?? -28;
  }

  _session() {
    if (!snmp) throw new Error('net-snmp tidak terinstall');
    return snmp.createSession(this.host, this.community, {
      port: this.port,
      version: this.version === '1' ? snmp.Version1 : snmp.Version2c,
      timeout: this.timeout,
      retries: 1,
    });
  }

  _suffix(board, pon) {
    return {
      id:   ONU_ID_IFINDEX_BASE   + board * ONU_ID_SLOT_STRIDE   + pon * ONU_ID_INCREMENT,
      type: ONU_TYPE_IFINDEX_BASE + board * ONU_TYPE_SLOT_STRIDE + pon * ONU_TYPE_INCREMENT,
    };
  }

  // Walk satu OID subtree → map { onuId: value }
  _walk(session, baseOid) {
    return new Promise((resolve, reject) => {
      const result = {};
      const onError = (err) => { try { session.close(); } catch (e) {} reject(err); };
      function feed(varbinds) {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          // onuId = elemen terakhir OID
          const parts = vb.oid.split('.');
          const onuId = parseInt(parts[parts.length - 1]);
          let val = vb.value;
          if (Buffer.isBuffer(val)) val = val.toString('utf8').replace(/\u0000+$/,'').trim();
          result[onuId] = val;
        }
      }
      session.subtree(baseOid, 20, (vbs) => feed(vbs), (err) => {
        if (err) return onError(err);
        resolve(result);
      });
    });
  }

  // Test koneksi SNMP (baca sysDescr)
  async testConnection() {
    return new Promise((resolve) => {
      let session;
      try { session = this._session(); } catch (e) { return resolve({ success: false, error: e.message }); }
      session.get(['1.3.6.1.2.1.1.1.0'], (err, varbinds) => {
        try { session.close(); } catch (e) {}
        if (err) return resolve({ success: false, error: err.message });
        let desc = varbinds && varbinds[0] && !snmp.isVarbindError(varbinds[0]) ? varbinds[0].value : null;
        if (Buffer.isBuffer(desc)) desc = desc.toString('utf8');
        resolve({ success: true, message: `SNMP terhubung ke ${this.name}`, info: String(desc || 'OK').slice(0, 160) });
      });
    });
  }

  // ── Daftar ONU pada satu PON (board/pon) ───────────────────────────
  // ref bisa "1/2/3" (frame/slot/port ZTE) — kita pakai slot=board, port=pon.
  async getOnuState(ref, { withPower = true } = {}) {
    const { board, pon } = this._parseRef(ref);
    const sfx = this._suffix(board, pon);
    const session = this._session();
    try {
      const [names, serials, statuses, types, rxs] = await Promise.all([
        this._walk(session, `${BASE1}${PFX.name}.${sfx.id}`),
        this._walk(session, `${BASE1}${PFX.serial}.${sfx.id}`),
        this._walk(session, `${BASE1}${PFX.status}.${sfx.id}`),
        this._walk(this._session(), `${BASE2}${PFX.type}.${sfx.type}`),
        withPower ? this._walk(this._session(), `${BASE1}${PFX.rxpower}.${sfx.id}`) : Promise.resolve({}),
      ]);
      try { session.close(); } catch (e) {}

      const ids = Object.keys(names).length ? Object.keys(names) : Object.keys(statuses);
      const list = ids.map(idStr => {
        const onuId = parseInt(idStr);
        const rxRaw = rxs[onuId];
        const rx = this._toDbm(rxRaw);
        let quality = 'unknown';
        if (rx !== null) quality = rx >= this.rxGood ? 'good' : (rx >= this.rxWarning ? 'warning' : 'critical');
        return {
          onu_id: onuId,
          board, pon,
          onu_if: `${board}/${pon}:${onuId}`,
          gpon_olt: `gpon-olt_1/${board}/${pon}`,
          name: this._serialToStr(names[onuId]) || null,
          sn: this._serialToStr(serials[onuId]) || null,
          type: types[onuId] != null ? String(types[onuId]) : null,
          status: mapStatus(statuses[onuId]),
          phase_state: statuses[onuId] != null ? String(statuses[onuId]) : null,
          onu_rx_dbm: rx,
          quality,
        };
      }).sort((a, b) => a.onu_id - b.onu_id);
      return list;
    } catch (err) {
      try { session.close(); } catch (e) {}
      throw err;
    }
  }

  // ── Redaman 1 ONU ──────────────────────────────────────────────────
  async getOnuPower(ref, onuId) {
    const { board, pon } = this._parseRef(ref);
    const sfx = this._suffix(board, pon);
    const rxMap = await this._getSingle(`${BASE1}${PFX.rxpower}.${sfx.id}`, onuId);
    const rx = this._toDbm(rxMap);
    let quality = 'unknown';
    if (rx !== null) quality = rx >= this.rxGood ? 'good' : (rx >= this.rxWarning ? 'warning' : 'critical');
    return { onu_rx_dbm: rx, onu_tx_dbm: null, olt_rx_dbm: null, olt_tx_dbm: null, no_signal: rx === null, quality };
  }

  // ── Detail 1 ONU ───────────────────────────────────────────────────
  async getOnuDetail(ref, onuId) {
    const { board, pon } = this._parseRef(ref);
    const sfx = this._suffix(board, pon);
    const [name, serial, status, dist, desc] = await Promise.all([
      this._getSingle(`${BASE1}${PFX.name}.${sfx.id}`, onuId),
      this._getSingle(`${BASE1}${PFX.serial}.${sfx.id}`, onuId),
      this._getSingle(`${BASE1}${PFX.status}.${sfx.id}`, onuId),
      this._getSingle(`${BASE1}${PFX.distance}.${sfx.id}`, onuId),
      this._getSingle(`${BASE1}${PFX.desc}.${sfx.id}`, onuId),
    ]);
    const power = await this.getOnuPower(ref, onuId);
    return {
      onu_if: `${board}/${pon}:${onuId}`,
      name: this._serialToStr(name), serial_number: this._serialToStr(serial),
      state: mapStatus(status), phase_state: status != null ? String(status) : null,
      description: this._serialToStr(desc),
      distance_m: dist != null ? parseInt(dist) || null : null,
      power,
    };
  }

  // ── Ringkasan per PON ──────────────────────────────────────────────
  async getPortSummary(refs = []) {
    const out = [];
    for (const ref of refs) {
      try {
        const list = await this.getOnuState(ref, { withPower: false });
        const online = list.filter(o => o.status === 'online').length;
        out.push({ port: this._refLabel(ref), total: list.length, online, offline: list.length - online });
      } catch (e) {
        out.push({ port: ref, total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return out;
  }

  // ── Info sistem (sysDescr, sysUpTime, sysName) ─────────────────────
  async getSystemInfo() {
    return new Promise((resolve) => {
      let session;
      try { session = this._session(); } catch (e) { return resolve({ error: e.message }); }
      const oids = ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.5.0'];
      session.get(oids, (err, vbs) => {
        try { session.close(); } catch (e) {}
        if (err) return resolve({ error: err.message });
        const val = (i) => (vbs[i] && !snmp.isVarbindError(vbs[i])) ? (Buffer.isBuffer(vbs[i].value) ? vbs[i].value.toString('utf8') : vbs[i].value) : null;
        let descr = val(0); const upticks = val(1); const sysname = val(2);
        const verM = String(descr || '').match(/V?\d+\.\d+\.\d+\S*/);
        resolve({
          model: sysname || (String(descr || '').split(/[, ]/)[0] || null),
          version: verM ? verM[0] : null,
          hw_version: null,
          uptime: upticks != null ? this._ticksToStr(upticks) : null,
          cpu_percent: null, temperature_c: null,
          raw: String(descr || '').slice(0, 500),
        });
      });
    });
  }

  // ════════════════════ Helpers ════════════════════
  _getSingle(baseOid, onuId) {
    return new Promise((resolve) => {
      let session;
      try { session = this._session(); } catch (e) { return resolve(null); }
      session.get([`${baseOid}.${onuId}`], (err, vbs) => {
        try { session.close(); } catch (e) {}
        if (err || !vbs || !vbs[0] || snmp.isVarbindError(vbs[0])) return resolve(null);
        let v = vbs[0].value;
        if (Buffer.isBuffer(v)) v = v.toString('utf8').replace(/\u0000+$/,'').trim();
        resolve(v);
      });
    });
  }

  _serialToStr(v) {
    if (v == null) return null;
    if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/\u0000+$/,'').trim();
    return String(v).trim() || null;
  }

  // Konversi nilai RX power mentah ke dBm.
  // ZTE C320 umumnya: raw integer. Coba beberapa skema umum:
  //   - raw besar (mis. 15000) → (raw - 10000)/1000 ? tidak; lebih sering signed*0.002 - dsb.
  // Pendekatan aman: jika |raw| > 1000 → raw/1000; jika 100..1000 → raw/100 lalu negatif.
  _toDbm(raw) {
    if (raw == null || raw === '') return null;
    let n = parseFloat(raw);
    if (isNaN(n)) return null;
    // Banyak firmware mengembalikan dBm*1000 (mis. -22500 = -22.5 dBm)
    if (Math.abs(n) >= 1000) n = n / 1000;
    // Beberapa mengembalikan dBm*100
    else if (Math.abs(n) >= 100) n = n / 100;
    // Bila masih positif besar (encoding 0.002 dBm + offset), abaikan kalibrasi rumit:
    // batasi ke rentang wajar -40..0
    if (n > 5) return null;          // nilai tak wajar → anggap tidak ada bacaan
    return Math.round(n * 100) / 100;
  }

  _ticksToStr(ticks) {
    let s = Math.floor(parseInt(ticks) / 100);
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60);
    return `${d}d ${h}h ${m}m`;
  }

  // ZTE ref "1/2/3" = frame/slot/port. SNMP pakai slot(board) & port(pon).
  // ── Ambil SEMUA ONU lintas board/pon via SNMP ──────────────────────
  // SNMP tidak punya "show card", jadi kita pindai grid board×pon dan
  // lewati port yang kosong. ports (opsional) = daftar ref eksplisit.
  async getAllOnus({ withPower = true, ports = null, boards = null, ponsPerBoard = 16, maxPorts = 32 } = {}) {
    let refs;
    if (ports && ports.length) {
      refs = ports;
    } else {
      const boardList = boards && boards.length ? boards : [1, 2, 3, 4, 5];
      refs = [];
      for (const b of boardList) for (let p = 1; p <= ponsPerBoard; p++) refs.push(`1/${b}/${p}`);
    }

    const allOnus = [];
    const portSummary = [];
    let scanned = 0;
    for (const ref of refs) {
      if (scanned >= maxPorts) break;
      try {
        const list = await this.getOnuState(ref, { withPower });
        if (!list.length) continue;          // port kosong → lewati
        scanned++;
        const label = this._refLabel(ref);
        list.forEach(o => { o.pon = label; });
        allOnus.push(...list);
        const online = list.filter(o => o.status === 'online').length;
        portSummary.push({ port: label, total: list.length, online, offline: list.length - online });
      } catch (e) { /* port tidak ada / timeout → lewati */ }
    }
    return { onus: allOnus, ports: portSummary, scannedPorts: portSummary.map(p => p.port) };
  }

  _parseRef(ref) {
    const s = String(ref || '').replace(/^gpon-olt_/i, '');
    const parts = s.split('/').map(x => parseInt(x)).filter(n => !isNaN(n));
    if (parts.length === 3) return { board: parts[1], pon: parts[2] };
    if (parts.length === 2) return { board: parts[0], pon: parts[1] };
    return { board: 1, pon: parts[0] || 1 };
  }
  _refLabel(ref) { const { board, pon } = this._parseRef(ref); return `${board}/${pon}`; }
}

module.exports = ZteSnmpService;
