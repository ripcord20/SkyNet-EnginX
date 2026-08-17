'use strict';

/**
 * HiosoOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * OLT HIOSO (GPON, chipset-based). CLI sekeluarga dengan CDATA namun
 * sebagian perintah memakai gaya "show ont" dan masuk port via
 * "interface gpon 1/<port>".
 *
 * Perintah utama (verifikasi sesuai firmware Anda):
 *   interface gpon 1/<port>
 *   show ont info / show online-onu
 *   show ont optical-info <id>
 *   ont confirm <id> sn-auth <sn> type <type>   (gaya auth HIOSO)
 *   ont reboot <id> ; no ont <id>
 * ─────────────────────────────────────────────────────────────────────
 */

const GponCliOltService = require('./GponCliOltService');

class HiosoOltService extends GponCliOltService {
  constructor(config = {}) {
    super(Object.assign({}, config, {
      brand: 'hioso',
      cmd: Object.assign({
        versionCheck: 'show system',
        ifEnter:      'interface gpon 1/{port}',
        onuList:      'show ont info',
        onuOptical:   'show ont optical-info {id}',
        onuDetail:    'show ont info {id}',
        uncfg:        'show ont auto-find',
        authorize:    'ont confirm {id} sn-auth {sn} type {type}',
        editName:     'ont {id} name {name}',
        editDesc:     'ont {id} description {desc}',
        reboot:       'ont reboot {id}',
        del:          'no ont {id}',
      }, config.cmd || {}),
    }));
    // HIOSO EPON/GPON umumnya 8 PON port.
    this.defaultPonPorts = config.defaultPonPorts || 8;
  }

  // HIOSO kadang memakai header "ONT ID" dan kolom berbeda; parser default
  // GponCliOltService sudah cukup toleran, tapi kita longgarkan deteksi state.
  parseOnuList(out, port) {
    const list = super.parseOnuList(out, port);
    return list;
  }
}

module.exports = HiosoOltService;
