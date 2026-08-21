'use strict';
/**
 * Test sanitasi input CLI (anti command-injection) untuk ZteOltService.
 * Jalankan: node test/sanitize.test.js  (tidak butuh OLT asli).
 */
const assert = require('assert');

// Stub dependency jaringan agar service bisa di-load tanpa OLT.
const Module = require('module');
const stubs = {
  'telnet-client': { Telnet: class { on() {} async connect() {} async exec() { return ''; } async send() { return ''; } async end() {} } },
  'ssh2': { Client: class {} },
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (stubs[id]) return stubs[id];
  return origRequire.apply(this, arguments);
};

const Zte = require('../services/ZteOltService');
const s = new Zte({ host: 'x' });

// 1) Interface normalizer: input valid lolos
assert.strictEqual(s._normOltIf('1/2/1'), 'gpon-olt_1/2/1');
assert.strictEqual(s._normOnuIf('1/2/1:30'), 'gpon-onu_1/2/1:30');
assert.strictEqual(s._normOltIf(''), '');

// 2) Interface normalizer: injeksi dibersihkan / ditolak
assert.strictEqual(s._normOltIf('1/2/1\nreboot'), 'gpon-olt_1/2/1', 'newline harus dibuang');
assert.strictEqual(s._normOnuIf('1/2/1:30; no onu 5'), 'gpon-onu_1/2/1:30', 'metakarakter dibuang');
assert.throws(() => s._normOltIf('\n\nreboot all'), /tidak valid/, 'pure-injection ditolak');

// 3) SN/name/text: karakter kontrol & metakarakter dibuang
assert.strictEqual(s._sanSn('ZTEG\nreboot'), 'ZTEGreboot');
assert.ok(!/\n|;|\|/.test(s._sanName('Budi;reboot|x')));
assert.ok(!/\n/.test(s._sanText('A\nB')));

// 4) Int: rentang dipaksa, nilai liar ditolak
assert.strictEqual(s._sanInt('121', { min: 1, max: 4094, label: 'v' }), 121);
assert.throws(() => s._sanInt('99999', { min: 1, max: 4094, label: 'v' }), /1-4094/);
assert.throws(() => s._sanInt('abc', { min: 1, max: 10, label: 'v' }), /angka/);

console.log('✓ Sanitize (anti-injection) tests PASS');
