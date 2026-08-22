'use strict';

/**
 * HsgqOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * Service SNMP untuk OLT HSGQ E04I
 * Vendor Enterprise OID: 1.3.6.1.4.1.50224
 *
 * OID verified via snmpwalk langsung ke device 10.2.2.250
 *
 * Struktur tabel ONU (1.3.6.1.4.1.50224.3.3.2.1):
 *   Kolom 2  = Nama/deskripsi ONU (nama pelanggan)
 *   Kolom 3  = Status registrasi (selalu 1, BUKAN online/offline)
 *   Kolom 4  = IP Address ONU
 *   Kolom 7  = MAC Address (6 byte)
 *   Kolom 12 = Hardware version (V3.1, V2.0)
 *   Kolom 14 = Firmware version (V1.0.0P1T6)
 *   Kolom 15 = RX Power (uint8: >=128 → (val-256)/10 dBm, <128 → -(val/10) dBm)
 *   Kolom 16 = ONU Sequence Index (STATUS SEBENARNYA):
 *              0     = OFFLINE
 *              65535 = REMOVED/ERROR (offline)
 *              1-127 = ONLINE (urutan slot aktif di PON)
 *   Kolom 25 = Chipset vendor (ZTE, MTK, ZICG)
 *
 * Format index: 4-byte [1][0][PON][ONU]
 *   16777473 = PON1/ONU1, 16778261 = PON4/ONU21
 * ─────────────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');

let snmp;
try {
  snmp = require('net-snmp');
} catch (e) {
  logger.warn('[HsgqOlt] net-snmp tidak terinstall — jalankan: npm install net-snmp');
}

const OID = {
  SYS_DESCR:    '1.3.6.1.2.1.1.1.0',
  SYS_NAME:     '1.3.6.1.2.1.1.5.0',
  ONU_NAME:     '1.3.6.1.4.1.50224.3.3.2.1.2',   // nama pelanggan
  ONU_IP:       '1.3.6.1.4.1.50224.3.3.2.1.4',   // IP address
  ONU_MAC:      '1.3.6.1.4.1.50224.3.3.2.1.7',   // MAC (6 byte)
  ONU_HW_VER:   '1.3.6.1.4.1.50224.3.3.2.1.12',  // HW version
  ONU_FW_VER:   '1.3.6.1.4.1.50224.3.3.2.1.14',  // FW version
  ONU_RX_POWER: '1.3.6.1.4.1.50224.3.3.2.1.15',  // RX Power (uint8)
  ONU_SEQ:      '1.3.6.1.4.1.50224.3.3.2.1.16',  // Sequence → 0/65535=offline
};

class HsgqOltService {
  constructor(config = {}) {
    this.host      = config.host;
    this.community = config.community || 'public';
    this.port      = config.port      || 161;
    this.timeout   = config.timeout   || 10000;
    this.name      = config.name      || config.host;
    this._session  = null;
  }

  _getSession() {
    if (this._session) return this._session;
    if (!snmp) throw new Error('net-snmp tidak terinstall');
    this._session = snmp.createSession(this.host, this.community, {
      port: this.port, timeout: this.timeout, retries: 2, version: snmp.Version2c,
    });
    this._session.on('error', () => { this._session = null; });
    return this._session;
  }

  closeSession() {
    if (this._session) { try { this._session.close(); } catch(e) {} this._session = null; }
  }

  _get(oids) {
    return new Promise((resolve, reject) => {
      this._getSession().get(oids, (err, vbs) => err ? reject(err) : resolve(vbs));
    });
  }

  _walk(oid) {
    return new Promise((resolve, reject) => {
      const results = [];
      this._getSession().subtree(oid, 20, (varbinds) => {
        for (const v of varbinds) {
          if (!snmp.isVarbindError(v)) results.push({ oid: v.oid, value: v.value });
        }
      }, (err) => err ? reject(err) : resolve(results));
    });
  }

  _decodeIndex(idx) {
    const i = parseInt(idx);
    return { pon: (i >> 8) & 0xFF, onu: i & 0xFF };
  }

  _extractIndex(fullOid, baseOid) {
    return fullOid.replace(baseOid + '.', '');
  }

  _parseName(raw) {
    if (!raw) return null;
    return Buffer.isBuffer(raw)
      ? raw.toString('utf8').trim().replace(/\x00/g, '') || null
      : String(raw).trim() || null;
  }

  _parseMac(raw) {
    if (!raw || !Buffer.isBuffer(raw) || raw.length !== 6) return null;
    return [...raw].map(b => b.toString(16).padStart(2,'0')).join(':').toUpperCase();
  }

  _parseIp(raw) {
    const s = String(raw || '').trim();
    return (s && s !== '0.0.0.0') ? s : null;
  }

  _parseVersion(raw) {
    if (!raw) return null;
    return Buffer.isBuffer(raw)
      ? raw.toString('ascii').trim().replace(/\x00/g,'') || null
      : String(raw).trim() || null;
  }

  _parseRxPower(raw) {
    if (raw === null || raw === undefined) return null;
    // uint8: >=128 → (val-256)/10 dBm  |  <128 → -(val/10) dBm
    // val=0 → no signal (offline)
    const val = Buffer.isBuffer(raw) ? raw.readUInt8(0) : parseInt(raw);
    if (isNaN(val) || val === 0) return null;
    const dbm = val >= 128 ? (val - 256) / 10 : -(val / 10);
    return parseFloat(dbm.toFixed(1));
  }

  // Col 16: 0=offline, 65535=removed/error, 1-127=online
  _parseStatus(seqRaw, rxPower) {
    const seq = parseInt(seqRaw);
    if (isNaN(seq) || seq === 0 || seq === 65535) return 'offline';
    // Online tapi sinyal lemah → warning
    if (rxPower !== null && rxPower < -27) return 'warning';
    return 'online';
  }

  async getAllONTs() {
    if (!snmp) throw new Error('net-snmp tidak terinstall. Jalankan: npm install net-snmp');
    logger.info(`[HsgqOlt:${this.name}] Fetching ONTs via SNMP...`);

    const fields = [
      { key: 'name',     oid: OID.ONU_NAME     },
      { key: 'ip',       oid: OID.ONU_IP       },
      { key: 'mac',      oid: OID.ONU_MAC      },
      { key: 'hw_ver',   oid: OID.ONU_HW_VER   },
      { key: 'fw_ver',   oid: OID.ONU_FW_VER   },
      { key: 'rx_power', oid: OID.ONU_RX_POWER },
      { key: 'seq',      oid: OID.ONU_SEQ      },
    ];

    const walkResults = await Promise.allSettled(
      fields.map(f => this._walk(f.oid).then(rows => ({ key: f.key, oid: f.oid, rows })))
    );

    const onuMap = new Map();
    for (const result of walkResults) {
      if (result.status !== 'fulfilled') continue;
      const { key, oid, rows } = result.value;
      for (const row of rows) {
        const idx = this._extractIndex(row.oid, oid);
        if (!onuMap.has(idx)) onuMap.set(idx, { _index: idx });
        onuMap.get(idx)[key] = row.value;
      }
    }

    logger.info(`[HsgqOlt:${this.name}] ${onuMap.size} ONU entries found`);
    return this._normalizeONTs(onuMap);
  }

  _normalizeONTs(onuMap) {
    const results = [];
    for (const [idx, raw] of onuMap) {
      const { pon, onu } = this._decodeIndex(idx);
      const name    = this._parseName(raw.name);
      const mac     = this._parseMac(raw.mac);
      const rxPower = this._parseRxPower(raw.rx_power);
      const ip      = this._parseIp(raw.ip);
      const hwVer   = this._parseVersion(raw.hw_ver);
      const fwVer   = this._parseVersion(raw.fw_ver);
      const status  = this._parseStatus(raw.seq, rxPower);
      const serial  = mac
        ? `HSGQ${mac.replace(/:/g,'')}`
        : `HSGQ-P${pon}O${String(onu).padStart(3,'0')}`;

      results.push({
        serial_number:   serial,
        olt_index:       idx,
        pon_port:        pon,
        onu_id:          onu,
        manufacturer:    'HSGQ',
        model:           name || `ONU-P${pon}/${onu}`,
        firmware:        fwVer || hwVer || null,
        description:     name || null,
        ip_address:      ip,
        mac_address:     mac,
        status,
        signal_strength: rxPower,
        uptime:          null,
        tr069_params: {
          rx_power:    rxPower,
          tx_power:    null,
          olt_rx_power:null,
          hw_version:  hwVer,
          fw_version:  fwVer,
        },
        source:      'snmp_hsgq',
        last_inform: new Date(),
        last_synced: new Date(),
      });
    }

    const online  = results.filter(r => r.status === 'online').length;
    const offline = results.filter(r => r.status === 'offline').length;
    const warning = results.filter(r => r.status === 'warning').length;
    logger.info(`[HsgqOlt:${this.name}] ${results.length} total | ${online} online | ${offline} offline | ${warning} warning`);
    return results;
  }

  async testConnection() {
    if (!snmp) return { success: false, error: 'net-snmp tidak terinstall' };
    try {
      const vbs  = await this._get([OID.SYS_DESCR, OID.SYS_NAME]);
      const desc = Buffer.isBuffer(vbs[0]?.value) ? vbs[0].value.toString('ascii') : String(vbs[0]?.value || '');
      const name = Buffer.isBuffer(vbs[1]?.value) ? vbs[1].value.toString('ascii') : String(vbs[1]?.value || '');
      this.closeSession();
      return { success: true, sysDescr: desc.trim(), sysName: name.trim(), message: `Terhubung ke: ${name.trim()} — ${desc.trim()}` };
    } catch (err) {
      this.closeSession();
      return { success: false, error: err.message };
    }
  }
}

module.exports = HsgqOltService;