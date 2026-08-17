'use strict';

/**
 * ZimmlinkOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * OLT ZIMMLINK (GPON, chipset-based — umumnya kompatibel pola CDATA/Cortina).
 * CLI mengikuti keluarga GPON chipset-based; default mengikuti gaya CDATA.
 *
 * Perintah utama (verifikasi sesuai firmware Anda):
 *   interface gpon 0/<port>
 *   show onu_information
 *   show onu optical-info <id> all
 *   onu add <id> type <type> sn <sn>
 *   onu reboot <id> ; no onu <id>
 * ─────────────────────────────────────────────────────────────────────
 */

const GponCliOltService = require('./GponCliOltService');

class ZimmlinkOltService extends GponCliOltService {
  constructor(config = {}) {
    super(Object.assign({}, config, {
      brand: 'zimmlink',
      cmd: Object.assign({
        versionCheck: 'show system_info',
        onuList:      'show onu_information',
        onuOptical:   'show onu optical-info {id} all',
        onuDetail:    'show onu_information {id}',
        uncfg:        'show onu auto-find',
        authorize:    'onu add {id} type {type} sn {sn}',
        editName:     'onu {id} name {name}',
        editDesc:     'onu {id} description {desc}',
        reboot:       'onu reboot {id}',
        del:          'no onu {id}',
      }, config.cmd || {}),
    }));
    // ZIMMLINK GPON umumnya 8 PON port.
    this.defaultPonPorts = config.defaultPonPorts || 8;
  }
}

module.exports = ZimmlinkOltService;
