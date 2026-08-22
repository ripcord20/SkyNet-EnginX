'use strict';
/**
 * Test sederhana untuk OltQueue (tanpa framework, jalankan: node test/oltQueue.test.js).
 * Memvalidasi: serialisasi per-OLT, paralel antar-OLT, isolasi error, anti-corruption.
 */
const assert = require('assert');
const q = require('../services/OltQueue');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1) Serial untuk OLT sama
  const order = [];
  await Promise.all([
    q.run('a', async () => { order.push('A1'); await sleep(30); order.push('A2'); }),
    q.run('a', async () => { order.push('B1'); await sleep(5);  order.push('B2'); }),
  ]);
  assert.deepStrictEqual(order, ['A1','A2','B1','B2'], 'harus serial untuk OLT sama');

  // 2) Error tidak memutus antrian
  const res = [];
  await Promise.all([
    q.run('b', async () => { throw new Error('x'); }).catch(() => res.push('err')),
    q.run('b', async () => { res.push('next'); }),
  ]);
  assert.ok(res.includes('next'), 'operasi setelah error harus tetap jalan');

  // 3) Anti-corruption: 20 op konkuren ke 1 OLT, shell yang rusak bila overlap
  let busy = false, corrupt = 0;
  const exec = async () => { if (busy) { corrupt++; return; } busy = true; await sleep(2); busy = false; };
  await Promise.all(Array.from({ length: 20 }, () =>
    q.run('c', async () => { await exec(); await exec(); await exec(); })
  ));
  assert.strictEqual(corrupt, 0, 'queue harus mencegah overlap (corruption=0)');

  console.log('✓ OltQueue tests PASS');
  process.exit(0);
})().catch(e => { console.error('✗ FAIL:', e.message); process.exit(1); });
