#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════
 * IMPORT DATA WILAYAH INDONESIA → database sendiri (jalankan SEKALI).
 *
 * Membaca file CSV BAWAAN di folder seeds/wilayah_data/ (provinsi, kab/kota,
 * kecamatan, desa) lalu menyimpannya ke tabel regions_* di database Anda.
 * Data sudah disertakan — TIDAK perlu internet, TIDAK bergantung emsifa.
 *
 * Sumber data: github.com/emsifa/api-wilayah-indonesia (folder data, CSV).
 *
 * Jalankan dari root project:
 *     node backend/seeds/import_regions.js
 *
 * Aman diulang (idempotent): pakai upsert, data lama ditimpa.
 * ════════════════════════════════════════════════════════════════════
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { sequelize, Province, Regency, District, Village } = require('../models');

const DATA_DIR = path.join(__dirname, 'wilayah_data');

// Parser 1 baris CSV sederhana yang BENAR menangani field berkutip
// (mis. nama desa: "LAMBANG SARI I, II, III" yang mengandung koma).
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function importCsv(file, Model, mapCols) {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) throw new Error(`File tidak ditemukan: ${full}`);

  // Baca seluruh file lalu split per baris. Ini menghindari bug Node v24 pada
  // `for await` di atas readline (ERR_USE_AFTER_CLOSE: readline was closed) yang
  // muncul ketika loop di-pause oleh await yang lama (mis. bulkCreate ke DB).
  // File terbesar (villages.csv) hanya ~2.3 MB, aman dimuat ke memori.
  const content = fs.readFileSync(full, 'utf8');
  const lines = content.split(/\r?\n/);

  let batch = [], total = 0, lineNo = 0;
  const CHUNK = 500; // aman dari max_allowed_packet
  const flush = async () => {
    if (!batch.length) return;
    try {
      await Model.bulkCreate(batch, { updateOnDuplicate: Object.keys(batch[0]) });
    } catch (dbErr) {
      const orig = dbErr.original || dbErr.parent || dbErr;
      throw new Error(
        `bulkCreate ${file} gagal di sekitar baris ${lineNo}: ` +
        `${orig.code || ''} ${orig.sqlMessage || dbErr.message}` +
        (batch[0] ? ` | contoh row: ${JSON.stringify(batch[0])}` : '')
      );
    }
    total += batch.length; batch = [];
  };

  for (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const row = mapCols(cols);
    if (row) batch.push(row);
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return total;
}

(async () => {
  console.log('→ Memastikan tabel regions_* ada…');
  await Province.sync(); await Regency.sync(); await District.sync(); await Village.sync();

  console.log('→ Impor provinsi…');
  const nP = await importCsv('provinces.csv', Province,
    (c) => c[0] ? ({ id: c[0], name: c[1] }) : null);
  console.log(`  ✓ ${nP} provinsi`);

  console.log('→ Impor kabupaten/kota…');
  const nR = await importCsv('regencies.csv', Regency,
    (c) => c[0] ? ({ id: c[0], province_id: c[1], name: c[2] }) : null);
  console.log(`  ✓ ${nR} kabupaten/kota`);

  console.log('→ Impor kecamatan…');
  const nD = await importCsv('districts.csv', District,
    (c) => c[0] ? ({ id: c[0], regency_id: c[1], name: c[2] }) : null);
  console.log(`  ✓ ${nD} kecamatan`);

  console.log('→ Impor desa/kelurahan (besar, mohon tunggu)…');
  const nV = await importCsv('villages.csv', Village,
    (c) => c[0] ? ({ id: c[0], district_id: c[1], name: c[2] }) : null);
  console.log(`  ✓ ${nV} desa/kelurahan`);

  console.log(`\n✅ SELESAI. Total: ${nP} prov · ${nR} kab · ${nD} kec · ${nV} desa.`);
  console.log('   Aplikasi kini memakai data wilayah sendiri (tidak bergantung emsifa).');
  await sequelize.close();
  process.exit(0);
})().catch(err => {
  console.error('\n❌ GAGAL:', err.message);
  if (err.original || err.parent) {
    const o = err.original || err.parent;
    console.error('   DB error:', o.code || '', o.sqlMessage || o.message || '');
  }
  console.error('   Detail:', err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : '(no stack)');
  console.error('   Aman diulang dari awal (idempotent upsert).');
  process.exit(1);
});
