#!/usr/bin/env node
/**
 * diagnose-waha-webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Memeriksa seluruh rantai webhook WAHA untuk menemukan di titik mana pesan
 * masuk terputus.
 *
 * Jalankan dari root project:
 *   node backend/scripts/diagnose-waha-webhook.js
 *
 * Skrip ini hanya MEMBACA — tidak mengubah apa pun kecuali Anda menambahkan
 * flag --fix, yang akan mendaftarkan ulang webhook ke WAHA.
 */

'use strict';

// Muat .env dari root project. Dibungkus try supaya skrip tetap jalan
// walau dotenv tidak terpasang — variabel bisa saja sudah diekspor lewat
// PM2 ecosystem atau shell.
try {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
} catch (e) {
  console.log('\x1b[33m!\x1b[0m dotenv tidak tersedia — memakai variabel lingkungan yang sudah ada');
}

const axios = require('axios');
const FIX = process.argv.includes('--fix');

const EVENTS_WAJIB = ['message', 'message.any', 'message.ack', 'message.revoked', 'session.status'];

// Pewarnaan output supaya mudah dibaca di terminal
const c = {
  ok:   (t) => '\x1b[32m✓\x1b[0m ' + t,
  bad:  (t) => '\x1b[31m✗\x1b[0m ' + t,
  warn: (t) => '\x1b[33m!\x1b[0m ' + t,
  dim:  (t) => '\x1b[90m' + t + '\x1b[0m',
  head: (t) => '\n\x1b[1m' + t + '\x1b[0m',
};

const masalah = [];
function lapor(pesan, solusi) {
  masalah.push({ pesan, solusi });
}

(async () => {
  console.log('\x1b[1m═══ Diagnosa Webhook WAHA ═══\x1b[0m');

  // ── 1. APP_URL ────────────────────────────────────────────────
  console.log(c.head('1. Variabel lingkungan'));

  const appUrl = String(process.env.APP_URL || process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (!appUrl) {
    console.log(c.bad('APP_URL / BASE_URL: KOSONG'));
    lapor(
      'APP_URL tidak diset di .env',
      'Tambahkan ke .env:\n     APP_URL=https://dgs.digs.co.id\n   Lalu: pm2 restart flaynet-crm'
    );
  } else {
    console.log(c.ok('APP_URL = ' + appUrl));
    if (/localhost|127\.0\.0\.1/.test(appUrl)) {
      console.log(c.warn('APP_URL menunjuk ke localhost'));
      lapor(
        'APP_URL memakai localhost',
        'Kalau WAHA jalan di container/host berbeda, dia tidak bisa menjangkau\n' +
        '   localhost aplikasi. Pakai URL publik atau IP yang bisa dijangkau WAHA.'
      );
    }
  }

  const webhookUrl = appUrl ? appUrl + '/portal/webhook/waha' : '(tidak bisa dihitung)';
  console.log(c.dim('   URL webhook yang seharusnya: ' + webhookUrl));

  // ── 2. Session di database ────────────────────────────────────
  console.log(c.head('2. Session WAHA di database'));

  let sessions = [];
  try {
    const db = require('../models');
    sessions = await db.WaSession.findAll({ where: { provider: 'waha' }, raw: true });
  } catch (e) {
    console.log(c.bad('Gagal baca database: ' + e.message));
    process.exit(1);
  }

  if (!sessions.length) {
    console.log(c.bad('Tidak ada session dengan provider=waha'));
    lapor('Belum ada session WAHA terdaftar', 'Buat session dulu lewat halaman WhatsApp Gateway.');
    ringkas();
    process.exit(0);
  }

  sessions.forEach(s => {
    console.log(c.ok(`session_id=${s.session_id} nama="${s.name}" waha_session="${s.waha_session || 'default'}" status=${s.status}`));
    console.log(c.dim(`   base_url=${s.waha_url || '(kosong)'}  phone=${s.phone_number || '(belum)'}`));
  });

  // ── 3. Konfigurasi webhook di WAHA ────────────────────────────
  console.log(c.head('3. Konfigurasi webhook di instance WAHA'));

  for (const s of sessions) {
    const base = String(s.waha_url || '').replace(/\/+$/, '');
    const name = s.waha_session || 'default';
    // Sama persis dengan getConfig() di WahaService: API key dibaca HANYA
    // dari kolom DB, tanpa fallback ke env. Kalau skrip ini pakai fallback
    // sementara aplikasi tidak, diagnosa bisa tampak sehat padahal aplikasi
    // sebenarnya gagal autentikasi.
    const key  = String(s.waha_api_key || '').trim();

    if (!base) {
      console.log(c.bad(`[${name}] waha_url kosong`));
      lapor(`Session "${name}" tidak punya URL WAHA`, 'Isi URL WAHA di form edit session.');
      continue;
    }
    if (!/^https?:\/\//i.test(base)) {
      console.log(c.bad(`[${name}] waha_url tidak diawali http:// atau https:// — "${base}"`));
      lapor(
        `URL WAHA session "${name}" formatnya salah`,
        'Aplikasi menolak URL tanpa skema. Perbaiki jadi mis. http://127.0.0.1:3001'
      );
      continue;
    }
    if (!key) {
      console.log(c.warn(`[${name}] API key kosong — kalau container WAHA memakai WHATSAPP_API_KEY, request akan ditolak 401`));
    }

    const http = axios.create({
      baseURL: base,
      timeout: 15000,
      headers: key ? { 'X-Api-Key': key } : {},
    });

    let info;
    try {
      const r = await http.get('/api/sessions/' + encodeURIComponent(name));
      info = r.data;
      console.log(c.ok(`[${name}] terhubung ke WAHA — status: ${info.status}`));
    } catch (e) {
      const detail = e.response ? `HTTP ${e.response.status}` : e.message;
      console.log(c.bad(`[${name}] tidak bisa menghubungi WAHA di ${base}: ${detail}`));
      lapor(
        `Aplikasi tidak bisa menghubungi WAHA (${base})`,
        'Cek: apakah container WAHA jalan? Apakah URL & API key benar?\n' +
        '   Uji manual: curl -H "X-Api-Key: KEY" ' + base + '/api/sessions'
      );
      continue;
    }

    const hooks = (info && info.config && info.config.webhooks) || [];

    if (!hooks.length) {
      console.log(c.bad(`[${name}] TIDAK ADA webhook terdaftar di WAHA`));
      lapor(
        `Session "${name}" tidak punya webhook di WAHA`,
        'Ini penyebab pesan masuk tidak sampai.\n' +
        '   Perbaiki: jalankan ulang skrip ini dengan --fix\n' +
        '   Atau isi manual di dashboard WAHA → session → webhooks:\n' +
        '     URL    : ' + webhookUrl + '\n' +
        '     Events : ' + EVENTS_WAJIB.join(', ')
      );
    } else {
      hooks.forEach(h => {
        const ev = Array.isArray(h.events) ? h.events : [];
        const cocok = String(h.url || '') === webhookUrl;

        console.log((cocok ? c.ok : c.warn)(`[${name}] webhook: ${h.url}`));
        console.log(c.dim('   events: ' + (ev.join(', ') || '(kosong)')));

        if (!cocok && appUrl) {
          console.log(c.bad('   URL TIDAK COCOK dengan APP_URL aplikasi'));
          lapor(
            `URL webhook di WAHA (${h.url}) beda dengan yang diharapkan aplikasi`,
            'Aplikasi menunggu di: ' + webhookUrl + '\n' +
            '   Samakan salah satunya — ubah APP_URL di .env, atau ubah webhook di WAHA.'
          );
        }

        const kurang = EVENTS_WAJIB.filter(e => !ev.includes(e));
        if (kurang.length) {
          console.log(c.bad('   Event kurang: ' + kurang.join(', ')));
          lapor(
            `Session "${name}" tidak berlangganan event: ${kurang.join(', ')}`,
            kurang.includes('message')
              ? 'Tanpa event "message", pesan masuk TIDAK AKAN pernah dikirim ke aplikasi.\n' +
                '   Perbaiki dengan --fix atau tambahkan manual di dashboard WAHA.'
              : 'Jalankan skrip ini dengan --fix untuk melengkapi.'
          );
        }
      });
    }

    // ── 4. Uji jangkauan balik: bisakah WAHA menghubungi aplikasi? ──
    if (appUrl && !FIX) {
      console.log(c.head('4. Uji jangkauan aplikasi dari luar'));
      try {
        const r = await axios.post(webhookUrl, { event: 'ping.diagnostic' }, {
          timeout: 10000,
          validateStatus: () => true,
        });
        if (r.status === 200) {
          console.log(c.ok('Endpoint webhook merespons 200 — aplikasi bisa dijangkau'));
        } else if (r.status === 404) {
          console.log(c.bad('Endpoint webhook 404 — route tidak terdaftar'));
          lapor(
            'POST ' + webhookUrl + ' mengembalikan 404',
            'Route /portal/webhook/waha tidak aktif. Cek apakah portal.js ter-mount\n' +
            '   di server.js: app.use(\'/portal\', portalRoutes)'
          );
        } else {
          console.log(c.warn('Endpoint webhook merespons HTTP ' + r.status));
          lapor(
            'Webhook merespons ' + r.status + ' (bukan 200)',
            r.status === 401 || r.status === 403
              ? 'Ada middleware auth yang memblokir. Endpoint webhook harus publik.'
              : 'Cek log aplikasi: pm2 logs flaynet-crm'
          );
        }
      } catch (e) {
        console.log(c.bad('Tidak bisa menghubungi ' + webhookUrl + ': ' + e.message));
        lapor(
          'Endpoint webhook tidak bisa dijangkau dari luar',
          'Kalau ini gagal dari server sendiri, WAHA juga tidak akan bisa.\n' +
          '   Cek: firewall, reverse proxy (nginx), atau APP_URL salah.'
        );
      }
    }

    // ── 5. Perbaikan otomatis ─────────────────────────────────────
    if (FIX && appUrl) {
      console.log(c.head('5. Mendaftarkan ulang webhook'));
      try {
        await http.put('/api/sessions/' + encodeURIComponent(name), {
          config: { webhooks: [{ url: webhookUrl, events: EVENTS_WAJIB.slice() }] },
        });
        console.log(c.ok(`[${name}] webhook didaftarkan ulang ke ${webhookUrl}`));
        console.log(c.dim('   events: ' + EVENTS_WAJIB.join(', ')));
        console.log(c.warn('Restart session di WAHA agar config baru berlaku:'));
        console.log(c.dim(`   curl -X POST -H "X-Api-Key: KEY" ${base}/api/sessions/${name}/restart`));
      } catch (e) {
        const detail = e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data || {}).slice(0, 200)}` : e.message;
        console.log(c.bad(`[${name}] gagal update: ${detail}`));
        console.log(c.dim('   Sebagian versi WAHA tidak mendukung PUT. Isi manual di dashboard.'));
      }
    }
  }

  // ── 6. Riwayat pesan masuk ────────────────────────────────────
  console.log(c.head('6. Riwayat pesan di database'));
  try {
    const db = require('../models');
    const masuk = await db.WaMessage.count({ where: { direction: 'inbound' } });
    const keluar = await db.WaMessage.count({ where: { direction: 'outbound' } });
    console.log(`   inbound : ${masuk}`);
    console.log(`   outbound: ${keluar}`);

    if (masuk === 0 && keluar > 0) {
      console.log(c.bad('Ada pesan keluar tapi NOL pesan masuk'));
      lapor(
        'Belum pernah ada pesan masuk tersimpan',
        'Konsisten dengan gejala: webhook tidak pernah sampai ke aplikasi.'
      );
    } else if (masuk > 0) {
      const terakhir = await db.WaMessage.findOne({
        where: { direction: 'inbound' },
        order: [['created_at', 'DESC']],
        raw: true,
      });
      console.log(c.ok('Pesan masuk terakhir: ' + new Date(terakhir.created_at).toLocaleString('id-ID')));
    }
  } catch (e) {
    console.log(c.warn('Gagal baca riwayat: ' + e.message));
  }

  ringkas();
  process.exit(0);
})().catch(e => {
  console.error('\n\x1b[31mSkrip gagal:\x1b[0m', e.message);
  process.exit(1);
});

function ringkas() {
  console.log(c.head('═══ RINGKASAN ═══'));
  if (!masalah.length) {
    console.log(c.ok('Tidak ditemukan masalah konfigurasi.'));
    console.log(c.dim('\nKalau pesan masuk masih tidak muncul, pantau log saat mengirim WA:'));
    console.log(c.dim('  pm2 logs flaynet-crm --lines 0 | grep WAHA'));
    console.log(c.dim('\nKalau tidak ada baris "[WAHA] Webhook message" muncul, berarti WAHA'));
    console.log(c.dim('memang tidak mengirim — periksa log container WAHA sendiri.'));
    return;
  }
  console.log(`Ditemukan ${masalah.length} masalah:\n`);
  masalah.forEach((m, i) => {
    console.log(`\x1b[31m${i + 1}. ${m.pesan}\x1b[0m`);
    console.log('   ' + m.solusi.replace(/\n/g, '\n   '));
    console.log('');
  });
  if (!FIX) {
    console.log(c.dim('Sebagian masalah bisa diperbaiki otomatis:'));
    console.log(c.dim('  node backend/scripts/diagnose-waha-webhook.js --fix'));
  }
}
