'use strict';
/**
 * Test jalur pengambilan data ONU (parser state + getAllOnus).
 * Jalankan: node test/onuFetch.test.js  (tidak butuh OLT asli).
 * Memvalidasi: parser 2-format, dedup, omcc, 1x full-config fetch, retry.
 */
const assert = require('assert');
const Module = require('module');
const stubs = {
  'telnet-client': { Telnet: class { on() {} async connect() {} async exec() { return ''; } async send() { return ''; } async end() {} } },
  'ssh2': { Client: class {} },
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) { return stubs[id] || origRequire.apply(this, arguments); };

const Zte = require('../services/ZteOltService');

(async () => {
  const s = new Zte({ host: 'x' });

  // Parser: 2 format, header di-skip, dedup, omcc benar
  const parsed = s._parseOnuState(
    'OnuIndex Admin OMCC Phase Channel\n' +
    'gpon-onu_1/2/1:1 enable enable working 1\n' +
    '1/2/1:2 enable disable LOS 1(GPON)\n' +
    'gpon-onu_1/2/1:1 enable enable working 1', 'gpon-olt_1/2/1');
  assert.strictEqual(parsed.length, 2, 'dedup baris dobel');
  assert.strictEqual(parsed[0].status, 'online');
  assert.strictEqual(parsed[0].omcc_state, 'enable', 'omcc kolom benar');
  assert.strictEqual(parsed[1].status, 'offline');
  assert.strictEqual(parsed[1].phase_state, 'los');

  // getAllOnus: 1x full-config, dedup PON, meta lengkap
  let cfgN = 0;
  const cfg = 'interface gpon-olt_1/2/1\n onu 1 type F663NV3a sn AAA\n!\ninterface gpon-onu_1/2/1:1\n name BUDI\n!';
  s.discoverPonPorts = async () => ['1/2/1', '1/2/1'];
  s.exec = async (c) => /state/.test(c) ? 'gpon-onu_1/2/1:1 enable enable working 1' : '';
  s._safeExec = async (c) => { if (/^show running-config$/.test(c.trim())) { cfgN++; return cfg; } return ''; };
  const res = await s.getAllOnus({});
  assert.strictEqual(cfgN, 1, 'full-config hanya 1x (bukan N+1)');
  assert.strictEqual(res.onus.length, 1, 'dedup PON');
  assert.strictEqual(res.onus[0].name, 'BUDI');
  assert.strictEqual(res.onus[0].sn, 'AAA');
  assert.strictEqual(res.onus[0].type, 'F663NV3a');

  // Retry pada kegagalan transien
  let att = 0;
  const s2 = new Zte({ host: 'x' });
  s2.discoverPonPorts = async () => ['1/2/1'];
  s2._safeExec = async () => '';
  s2.exec = async (c) => { if (/state/.test(c)) { att++; if (att === 1) throw new Error('timeout'); return 'gpon-onu_1/2/1:1 enable enable working 1'; } return ''; };
  const res2 = await s2.getAllOnus({});
  assert.strictEqual(res2.onus.length, 1, 'recover setelah retry');

  console.log('✓ ONU fetch tests PASS');
})().catch(e => { console.error('✗ FAIL:', e.message); process.exit(1); });
