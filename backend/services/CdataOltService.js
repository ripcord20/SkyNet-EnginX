'use strict';

/**
 * CdataOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * OLT CDATA (FD16xx / FD12xx series, chipset Cortina). CLI mengikuti pola
 * keluarga GPON chipset-based.
 *
 * Default account pabrik (sebagian unit): admin / Xpon@Olt9417#
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

class CdataOltService extends GponCliOltService {
  constructor(config = {}) {
    super(Object.assign({}, config, {
      brand: 'cdata',
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
    // CDATA FD16xx umumnya 8/16 PON port. Dipakai auto-discover.
    this.defaultPonPorts = config.defaultPonPorts || 16;
  }
}

module.exports = CdataOltService;
