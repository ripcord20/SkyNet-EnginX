/**
 * PppoeBulkProvisionService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker untuk pembuatan user PPPoE secara massal ke MikroTik.
 *
 * PRINSIP DESAIN:
 *
 * 1. THROTTLE, bukan blast.
 *    RouterOS REST API single-threaded untuk operasi tulis. Mengirim 1000 POST
 *    beruntun tanpa jeda akan bikin CPU router spike dan memutus koneksi
 *    (ECONNRESET). Worker ini memproses N item paralel lalu jeda sebentar.
 *
 * 2. SNAPSHOT SEKALI, bukan query per-user.
 *    getPPPoESecrets() dipanggil SATU KALI di awal job untuk membangun Set
 *    username yang sudah ada. Kalau dipanggil per-user (1000x), router mati
 *    duluan sebelum item ke-100. Set di-update in-memory setiap create sukses.
 *
 * 3. CHECKPOINT DI DATABASE.
 *    Worker selalu SELECT item status='pending'. Kalau proses mati di tengah,
 *    item yang sudah 'ok' tidak diproses ulang → tidak ada duplikat saat resume.
 *
 * 4. RETRY HANYA UNTUK ERROR TRANSIENT.
 *    ECONNRESET/timeout = masalah jaringan → layak diulang dengan backoff.
 *    "profile not found" / "already have such name" = masalah data → percuma
 *    diulang, langsung tandai failed supaya tidak membuang waktu.
 *
 * 5. JOB JALAN DI BACKGROUND.
 *    Controller memanggil runJob() TANPA await, lalu balas 202 Accepted.
 *    HTTP request tidak boleh menunggu 1000 user selesai — pasti timeout.
 */

const { getMikrotikInstanceByDevice } = require('./MikrotikService');
const logger = require('../utils/logger');

// ── Default tuning ───────────────────────────────────────────────────────────
// CONCURRENCY 3 aman untuk RB450G / hEX / RB1100 ke atas.
// Untuk RouterBoard kelas bawah (RB750, hAP lite), pakai 1 dan delayMs 250.
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_DELAY_MS    = 120;
const MAX_ATTEMPTS        = 3;

// ── Adaptive throttle ────────────────────────────────────────────────────────
// Batas bawah/atas penyesuaian otomatis. Concurrency tidak pernah turun di
// bawah 1 (job harus tetap jalan) dan tidak pernah naik melewati setelan awal
// operator — kalau operator memilih 3 untuk RB750, worker tidak boleh
// "memutuskan sendiri" bahwa 5 aman.
const THROTTLE_MIN_CONCURRENCY = 1;
const THROTTLE_MAX_DELAY_MS    = 1500;
const THROTTLE_TRIP_ERRORS     = 3;   // error transient beruntun sebelum melambat
const THROTTLE_RECOVER_BATCHES = 8;   // batch bersih sebelum mencoba cepat lagi

/**
 * Pengatur laju yang menyesuaikan diri dengan kondisi router.
 *
 * MASALAH YANG DISELESAIKAN: concurrency dipilih sekali di awal oleh operator.
 * Kalau ternyata terlalu tinggi untuk router tersebut, operator baru sadar
 * setelah puluhan ECONNRESET — dan saat itu sebagian job sudah gagal.
 *
 * CARA KERJA:
 *   - Setiap error transient beruntun dihitung. Setelah 3 kali, concurrency
 *     dibagi dua dan jeda digandakan (backoff multiplikatif — turun cepat,
 *     karena router yang kewalahan perlu kelegaan segera).
 *   - Setiap batch tanpa error menaikkan skor pemulihan. Setelah 8 batch
 *     bersih, concurrency naik satu tingkat (additive increase — naik pelan,
 *     supaya tidak langsung membanjiri router lagi).
 *
 * Pola AIMD ini sama dengan yang dipakai kontrol kongesti TCP, dan cocok
 * di sini karena gejalanya identik: kita tidak tahu kapasitas lawan bicara,
 * hanya tahu kapan mulai gagal.
 */
class AdaptiveThrottle {
  constructor(concurrency, delayMs, enabled) {
    this.enabled     = enabled !== false;
    this.baseConc    = concurrency;   // plafon — setelan operator
    this.baseDelay   = delayMs;
    this.concurrency = concurrency;
    this.delayMs     = delayMs;

    this.consecutiveErrors = 0;
    this.cleanBatches      = 0;
    this.adjustments       = [];      // riwayat untuk laporan
  }

  /** Dipanggil saat satu item kena error transient. */
  recordError() {
    if (!this.enabled) return;
    this.consecutiveErrors++;
    this.cleanBatches = 0;

    if (this.consecutiveErrors >= THROTTLE_TRIP_ERRORS) {
      this.consecutiveErrors = 0;
      this._slowDown();
    }
  }

  /** Dipanggil saat satu item berhasil. */
  recordSuccess() {
    this.consecutiveErrors = 0;
  }

  /** Dipanggil di akhir setiap batch. */
  endBatch(hadError) {
    if (!this.enabled) return;
    if (hadError) { this.cleanBatches = 0; return; }

    this.cleanBatches++;
    if (this.cleanBatches >= THROTTLE_RECOVER_BATCHES) {
      this.cleanBatches = 0;
      this._speedUp();
    }
  }

  _slowDown() {
    const prevC = this.concurrency, prevD = this.delayMs;
    this.concurrency = Math.max(THROTTLE_MIN_CONCURRENCY, Math.floor(this.concurrency / 2));
    this.delayMs     = Math.min(THROTTLE_MAX_DELAY_MS, Math.max(50, this.delayMs * 2));

    if (this.concurrency !== prevC || this.delayMs !== prevD) {
      const note = `Router kewalahan — melambat ke concurrency ${this.concurrency}, jeda ${this.delayMs}ms`;
      this.adjustments.push({ at: new Date().toISOString(), type: 'slow', note });
      logger.warn(`[PppoeBulk] ${note}`);
    }
  }

  _speedUp() {
    // Tidak pernah melewati setelan awal operator.
    if (this.concurrency >= this.baseConc && this.delayMs <= this.baseDelay) return;

    const prevC = this.concurrency, prevD = this.delayMs;
    this.concurrency = Math.min(this.baseConc, this.concurrency + 1);
    this.delayMs     = Math.max(this.baseDelay, Math.round(this.delayMs / 1.5));

    if (this.concurrency !== prevC || this.delayMs !== prevD) {
      const note = `Router stabil — mempercepat ke concurrency ${this.concurrency}, jeda ${this.delayMs}ms`;
      this.adjustments.push({ at: new Date().toISOString(), type: 'fast', note });
      logger.info(`[PppoeBulk] ${note}`);
    }
  }

  /** Ringkasan untuk disimpan di job.options dan ditampilkan di UI. */
  summary() {
    return {
      current:     { concurrency: this.concurrency, delayMs: this.delayMs },
      base:        { concurrency: this.baseConc,    delayMs: this.baseDelay },
      adjustments: this.adjustments.slice(-10),
      throttled:   this.concurrency < this.baseConc || this.delayMs > this.baseDelay,
    };
  }
}

// Registry job yang sedang berjalan di proses ini — mencegah satu job
// dijalankan dua worker sekaligus kalau user klik "Start" dua kali.
const runningJobs = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Deteksi error yang layak di-retry. Hanya masalah transport/jaringan.
 */
function isTransientError(msg) {
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|timeout/i.test(String(msg || ''));
}

/**
 * Generate password acak yang mudah dibaca teknisi di lapangan.
 * Tanpa karakter ambigu (0/O, 1/l/I) supaya tidak salah ketik saat setup ONT.
 */
function generatePassword(len = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/**
 * Cari .id secret berdasarkan username.
 *
 * Dibutuhkan karena createPPPoESecret() tidak selalu mengembalikan .id:
 * pada binary API, MikroTik kerap menutup koneksi setelah write sukses dan
 * MikrotikService mengembalikan null. Tanpa .id, rollback tidak punya
 * pegangan untuk menghapus secret.
 *
 * CATATAN: getPPPoESecrets() memetakan `.id` RouterOS menjadi properti `id`,
 * jadi yang dibaca di sini adalah `s.id` — nilainya tetap format RouterOS
 * (mis. "*1A") yang bisa langsung dipakai deletePPPoESecret().
 */
async function lookupSecretId(mt, username) {
  try {
    const all = await mt.getPPPoESecrets();
    const target = String(username).toLowerCase();
    const found = (all || []).find(s => String(s.name || '').toLowerCase() === target);
    return found ? (found.id || null) : null;
  } catch (e) {
    logger.warn(`[PppoeBulk] lookupSecretId(${username}) gagal: ${e.message}`);
    return null;
  }
}

/**
 * Ekstrak .id dari berbagai bentuk response RouterOS.
 * REST API v7 balikin { ret: "*1A" } untuk /add, tapi beberapa build
 * balikin object secret lengkap dengan field ".id".
 */
function extractMikrotikId(res) {
  if (!res) return null;
  if (typeof res === 'string') return res;
  return res.ret || res['.id'] || res.id || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROSES SATU ITEM
// ─────────────────────────────────────────────────────────────────────────────
async function processItem(item, ctx) {
  const { mt, existingSet, existingIdMap, profileSet, opts, counters } = ctx;

  const uname = String(item.username || '').trim();
  const unameLower = uname.toLowerCase();

  try {
    // ── Guard 1: username sudah ada di router ──────────────────
    if (existingSet.has(unameLower)) {
      if (opts.onDuplicate === 'overwrite') {
        let existingId = existingIdMap.get(unameLower);
        // Snapshot awal bisa saja tidak memuat .id (mis. router baru merespons
        // sebagian). Cari ulang sebelum menyerah.
        if (!existingId && !opts.dryRun) {
          existingId = await lookupSecretId(mt, uname);
          if (existingId) existingIdMap.set(unameLower, existingId);
        }
        if (existingId && !opts.dryRun) {
          // Kirim juga IP statis kalau item punya — tanpa ini, overwrite
          // hanya memperbarui password/profile/comment dan diam-diam
          // mengabaikan remote/local address, sehingga user tetap memakai
          // IP lama atau pool meski file menentukan IP statis baru.
          const patch = {
            password: item.password,
            profile:  item.profile || 'default',
            service:  item.service || 'pppoe',
            comment:  item.comment || undefined,
          };
          if (item.remote_address) patch.remoteAddress = item.remote_address;
          if (item.local_address)  patch.localAddress  = item.local_address;
          await mt.updatePPPoESecret(existingId, patch);
        } else if (!existingId && !opts.dryRun) {
          // Overwrite diminta tapi .id secret tidak bisa diresolusi — update
          // TIDAK terkirim. Jangan tandai 'ok' (itu bohong: router tak berubah,
          // dan verifikasi tak menangkapnya karena username memang sudah ada).
          // Tandai gagal supaya masuk antrian retry dan terlihat operator.
          await item.update({
            status: 'failed',
            error: 'Overwrite gagal: .id secret tidak ditemukan di router — coba lagi atau periksa manual',
            attempts: item.attempts + 1,
            processed_at: new Date(),
          });
          counters.failed++;
          return;
        }
        await item.update({
          status: 'ok',
          mikrotik_id: existingId || null,
          error: opts.dryRun ? '[dry-run] akan di-overwrite' : 'Di-overwrite (sudah ada sebelumnya)',
          attempts: item.attempts + 1,
          processed_at: new Date(),
        });
        counters.succeeded++;
        return;
      }

      // Mode skip (default)
      await item.update({
        status: 'skipped',
        error: 'Username sudah ada di router',
        attempts: item.attempts + 1,
        processed_at: new Date(),
      });
      counters.skipped++;
      return;
    }

    // ── Guard 2: profile harus ada di router ───────────────────
    // Ini penyebab kegagalan massal paling umum. Router menolak create
    // kalau profile tidak dikenal, dan errornya tidak selalu jelas.
    const wantProfile = item.profile || 'default';
    if (profileSet.size > 0 && !profileSet.has(wantProfile)) {
      await item.update({
        status: 'failed',
        error: `Profile "${wantProfile}" tidak ada di router. Buat profile-nya dulu.`,
        attempts: item.attempts + 1,
        processed_at: new Date(),
      });
      counters.failed++;
      return;
    }

    // ── Dry run: simulasi tanpa menulis ke router ──────────────
    if (opts.dryRun) {
      existingSet.add(unameLower); // supaya duplikat dalam file ikut ke-detect
      await item.update({
        status: 'ok',
        error: '[dry-run] tidak ditulis ke router',
        attempts: item.attempts + 1,
        processed_at: new Date(),
      });
      counters.succeeded++;
      return;
    }

    // ── Eksekusi create ────────────────────────────────────────
    // PENTING: createPPPoESecret() di MikrotikService membaca field dalam
    // camelCase (remoteAddress / localAddress / callerId), BUKAN kebab-case.
    // Mengirim 'remote-address' membuat field diabaikan diam-diam.
    const payload = {
      name:     uname,
      password: item.password || generatePassword(),
      profile:  wantProfile,
      service:  item.service || 'pppoe',
    };
    if (item.comment)        payload.comment       = item.comment;
    if (item.remote_address) payload.remoteAddress = item.remote_address;
    if (item.local_address)  payload.localAddress  = item.local_address;

    const res = await mt.createPPPoESecret(payload);
    let mtId = extractMikrotikId(res);

    // MikroTik sering menutup koneksi setelah write sukses; MikrotikService
    // menanganinya dengan `return null`. Akibatnya .id tidak ikut terbawa,
    // dan tanpa .id fitur rollback tidak bisa menghapus secret ini.
    // Solusi: lookup .id berdasarkan username langsung setelah create.
    if (!mtId) {
      mtId = await lookupSecretId(mt, uname);
    }

    // Update snapshot in-memory supaya duplikat dalam batch yang sama ke-detect
    existingSet.add(unameLower);
    if (mtId) existingIdMap.set(unameLower, mtId);

    await item.update({
      status: 'ok',
      mikrotik_id: mtId,
      error: mtId ? null : 'Dibuat, tapi .id tidak terbaca — rollback akan mencari by-username',
      attempts: item.attempts + 1,
      processed_at: new Date(),
    });
    counters.succeeded++;
    if (ctx.throttle) ctx.throttle.recordSuccess();

  } catch (e) {
    const attempts = item.attempts + 1;
    const msg = e.message || String(e);

    // Retry hanya untuk error jaringan, dengan backoff bertingkat
    if (attempts < MAX_ATTEMPTS && isTransientError(msg)) {
      // Beri tahu throttle: error transient berarti router mungkin kewalahan.
      if (ctx.throttle) ctx.throttle.recordError();
      if (ctx.batchState) ctx.batchState.hadError = true;
      await item.update({ attempts, error: `Retry ${attempts}/${MAX_ATTEMPTS}: ${msg}` });
      await sleep(500 * attempts);
      return; // tetap 'pending' → diambil lagi di batch berikutnya
    }

    await item.update({
      status: 'failed',
      error: msg,
      attempts,
      processed_at: new Date(),
    });
    counters.failed++;
    if (isTransientError(msg) && ctx.batchState) ctx.batchState.hadError = true;
    logger.warn(`[PppoeBulk] item#${item.id} (${uname}) gagal: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER UTAMA
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Jalankan job. Dipanggil TANPA await dari controller (fire-and-forget).
 * Semua progress dicatat ke DB, jadi frontend cukup polling endpoint /status.
 */
async function runJob(jobId) {
  if (runningJobs.has(jobId)) {
    logger.info(`[PppoeBulk] job#${jobId} sudah berjalan, abaikan start duplikat`);
    return;
  }
  runningJobs.add(jobId);

  const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');

  let job;
  try {
    job = await PppoeProvisionJob.findByPk(jobId);
    if (!job) throw new Error('Job tidak ditemukan');

    const opts = Object.assign({
      dryRun:      false,
      onDuplicate: 'skip',
      concurrency: DEFAULT_CONCURRENCY,
      delayMs:     DEFAULT_DELAY_MS,
      syncToCrm:   true,
    }, job.options || {});

    const concurrency = Math.max(1, Math.min(10, parseInt(opts.concurrency) || DEFAULT_CONCURRENCY));
    const delayMs     = Math.max(0, parseInt(opts.delayMs) || DEFAULT_DELAY_MS);

    await job.update({
      status: 'running',
      started_at: job.started_at || new Date(),
      error_message: null,
    });

    // ── Koneksi router ────────────────────────────────────────
    const mt = await getMikrotikInstanceByDevice(job.device_id);
    if (!mt) throw new Error(`Router (device_id=${job.device_id}) tidak bisa dihubungi`);

    // ── SNAPSHOT SEKALI ───────────────────────────────────────
    // Ini kunci performa. Jangan pindahkan ke dalam loop.
    logger.info(`[PppoeBulk] job#${jobId} mengambil snapshot secret & profile...`);
    const existingSecrets = await mt.getPPPoESecrets().catch(() => []);
    const existingSet   = new Set();
    const existingIdMap = new Map();
    (existingSecrets || []).forEach(s => {
      const n = String(s.name || '').toLowerCase();
      if (!n) return;
      existingSet.add(n);
      if (s.id) existingIdMap.set(n, s.id);
    });

    const profiles = await mt.getPPPoEProfiles().catch(() => []);
    const profileSet = new Set((profiles || []).map(p => p.name).filter(Boolean));

    logger.info(`[PppoeBulk] job#${jobId} start — ${existingSet.size} secret existing, ${profileSet.size} profile, concurrency=${concurrency}`);

    const counters = { succeeded: 0, failed: 0, skipped: 0 };

    // Throttle adaptif — menyesuaikan concurrency & jeda dengan kondisi router.
    // Bisa dimatikan lewat opts.adaptiveThrottle = false kalau operator ingin
    // laju tetap persis seperti yang dia pilih.
    const throttle = new AdaptiveThrottle(concurrency, delayMs, opts.adaptiveThrottle !== false);
    const batchState = { hadError: false };
    const ctx = { mt, existingSet, existingIdMap, profileSet, opts, counters, throttle, batchState };

    // ── Loop batch ────────────────────────────────────────────
    let guard = 0;
    const maxLoops = 100000; // safety net terhadap infinite loop
    let lastReportedConc = throttle.concurrency;

    while (guard++ < maxLoops) {
      // Cek sinyal pause/cancel dari user setiap batch
      await job.reload();
      if (job.status === 'paused') {
        logger.info(`[PppoeBulk] job#${jobId} di-pause user`);
        await flushCounters(job, counters);
        await persistThrottle(job, throttle);
        return;
      }

      batchState.hadError = false;

      const batch = await PppoeProvisionItem.findAll({
        where: { job_id: jobId, status: 'pending' },
        order: [['id', 'ASC']],
        // Ambil sebanyak concurrency SAAT INI — nilainya bisa berubah
        // di tengah job kalau throttle menyesuaikan diri.
        limit: throttle.concurrency,
      });

      if (!batch.length) break;

      await Promise.all(batch.map(it => processItem(it, ctx)));
      throttle.endBatch(batchState.hadError);
      await flushCounters(job, counters);

      // Simpan status throttle ke DB hanya saat berubah, supaya UI bisa
      // menampilkannya tanpa membanjiri database dengan UPDATE tiap batch.
      if (throttle.concurrency !== lastReportedConc) {
        lastReportedConc = throttle.concurrency;
        await persistThrottle(job, throttle);
      }

      if (throttle.delayMs) await sleep(throttle.delayMs);
    }

    // ── Sinkronisasi balik ke CRM ─────────────────────────────
    if (opts.syncToCrm && !opts.dryRun) {
      await syncBackToCrm(jobId, job.device_id).catch(e =>
        logger.warn(`[PppoeBulk] sync ke CRM gagal: ${e.message}`)
      );
    }

    // ── Verifikasi akhir ──────────────────────────────────────
    // Jangan percaya begitu saja pada respons create: MikroTik bisa membalas
    // sukses padahal record tidak tertulis, dan sebaliknya bisa memutus
    // koneksi setelah write berhasil. Bandingkan hasil dengan kondisi
    // router yang sebenarnya.
    let verification = null;
    if (!opts.dryRun && opts.verifyAfter !== false) {
      verification = await verifyJob(jobId, mt).catch(e => {
        logger.warn(`[PppoeBulk] verifikasi job#${jobId} gagal: ${e.message}`);
        return { error: e.message };
      });
    }

    await persistThrottle(job, throttle);
    await job.reload();
    await job.update({
      status: 'done',
      finished_at: new Date(),
      verification,
    });
    logger.info(
      `[PppoeBulk] job#${jobId} selesai — ok:${job.succeeded} skip:${job.skipped} fail:${job.failed}` +
      (verification && verification.missing ? ` | verifikasi: ${verification.missing} tidak ditemukan di router` : '')
    );

  } catch (e) {
    logger.error(`[PppoeBulk] job#${jobId} gagal total: ${e.message}`);
    if (job) {
      await job.update({
        status: 'failed',
        error_message: e.message,
        finished_at: new Date(),
      }).catch(() => {});
    }
  } finally {
    runningJobs.delete(jobId);
  }
}

/**
 * Tulis counter agregat ke tabel job. Dipanggil per batch (bukan per item)
 * supaya tidak membanjiri DB dengan UPDATE.
 */
async function flushCounters(job, counters) {
  const { PppoeProvisionItem } = require('../models');
  const { sequelize } = require('../models');
  try {
    const rows = await sequelize.query(
      `SELECT status, COUNT(*) AS c FROM pppoe_provision_items WHERE job_id = ? GROUP BY status`,
      { replacements: [job.id], type: sequelize.QueryTypes.SELECT }
    );
    const m = {};
    rows.forEach(r => { m[r.status] = parseInt(r.c, 10); });
    await job.update({
      succeeded: m.ok      || 0,
      failed:    m.failed  || 0,
      skipped:   m.skipped || 0,
    });
  } catch (e) {
    // Non-fatal: counter hanya untuk display
    logger.warn(`[PppoeBulk] flushCounters job#${job.id}: ${e.message}`);
  }
}

/**
 * Setelah secret berhasil dibuat di router, update tabel customers supaya
 * pppoe_username & mikrotik_id-nya konsisten dengan kondisi di router.
 *
 * CATATAN PENTING: customers.mikrotik_id harus berisi mikrotik_devices.id,
 * BUKAN devices.id. Ini konsisten dengan resolveMikrotikDeviceId() di
 * CustomerImportController — kalau salah, fitur isolir tidak bisa resolve router.
 */
async function syncBackToCrm(jobId, deviceId) {
  const { PppoeProvisionItem, Customer, sequelize } = require('../models');

  const okItems = await PppoeProvisionItem.findAll({
    where: { job_id: jobId, status: 'ok' },
    attributes: ['customer_id', 'username'],
    raw: true,
  });
  const withCid = okItems.filter(i => i.customer_id);
  if (!withCid.length) return;

  // Resolve devices.id → mikrotik_devices.id (auto-create kalau belum ada)
  let mdId = null;
  const found = await sequelize.query(
    'SELECT id FROM mikrotik_devices WHERE device_id=? LIMIT 1',
    { replacements: [deviceId], type: sequelize.QueryTypes.SELECT }
  );
  if (found && found.length) {
    mdId = found[0].id;
  } else {
    await sequelize.query(
      `INSERT INTO mikrotik_devices (device_id, binary_port, wan_interface, status)
       VALUES (?, 8728, 'ether1', 'unknown')`,
      { replacements: [deviceId] }
    );
    const again = await sequelize.query(
      'SELECT id FROM mikrotik_devices WHERE device_id=? LIMIT 1',
      { replacements: [deviceId], type: sequelize.QueryTypes.SELECT }
    );
    if (again && again.length) mdId = again[0].id;
  }

  for (const it of withCid) {
    try {
      const patch = { pppoe_username: it.username };
      if (mdId) patch.mikrotik_id = mdId;
      await Customer.update(patch, { where: { customer_id: it.customer_id } });
    } catch (e) {
      logger.warn(`[PppoeBulk] sync CRM cust ${it.customer_id}: ${e.message}`);
    }
  }
  logger.info(`[PppoeBulk] job#${jobId} sync ${withCid.length} customer ke CRM`);
}

/**
 * Simpan status throttle ke job.options supaya bisa ditampilkan di UI.
 * Non-fatal — kegagalan di sini tidak boleh menghentikan job.
 */
async function persistThrottle(job, throttle) {
  try {
    await job.update({
      options: Object.assign({}, job.options || {}, { throttleState: throttle.summary() })
    });
  } catch (e) {
    logger.warn(`[PppoeBulk] persistThrottle job#${job.id}: ${e.message}`);
  }
}

/**
 * VERIFIKASI PASCA-JOB
 * ─────────────────────────────────────────────────────────────────────────────
 * Bandingkan item berstatus 'ok' dengan daftar secret yang benar-benar ada
 * di router.
 *
 * KENAPA PERLU: respons MikroTik tidak selalu mencerminkan kenyataan.
 * Koneksi bisa putus setelah write sukses (dilaporkan gagal padahal berhasil),
 * atau router menerima perintah tapi menolaknya secara internal (dilaporkan
 * berhasil padahal tidak ada). Satu panggilan getPPPoESecrets() di akhir job
 * menangkap kedua kasus itu — murah untuk batch ribuan.
 *
 * Item 'ok' yang ternyata tidak ada di router dikembalikan ke 'pending'
 * supaya bisa langsung diulang lewat tombol Retry.
 */
async function verifyJob(jobId, mt) {
  const { PppoeProvisionItem } = require('../models');

  const secrets = await mt.getPPPoESecrets();
  const onRouter = new Map();
  (secrets || []).forEach(sec => {
    const n = String(sec.name || '').toLowerCase();
    if (n) onRouter.set(n, sec.id || null);
  });

  const okItems = await PppoeProvisionItem.findAll({
    where: { job_id: jobId, status: 'ok' },
  });

  const result = {
    checked: okItems.length,
    confirmed: 0,
    missing: 0,
    idRecovered: 0,
    missingUsernames: [],
    at: new Date().toISOString(),
  };

  for (const it of okItems) {
    const uname = String(it.username || '').toLowerCase();

    if (!onRouter.has(uname)) {
      // Dilaporkan berhasil, tapi tidak ada di router.
      result.missing++;
      if (result.missingUsernames.length < 50) result.missingUsernames.push(it.username);
      await it.update({
        status: 'pending',
        mikrotik_id: null,
        attempts: 0,
        error: 'Verifikasi: tidak ditemukan di router meski create dilaporkan sukses — siap diulang',
      });
      continue;
    }

    result.confirmed++;

    // Sekalian isi .id yang sebelumnya kosong, supaya rollback punya pegangan.
    const routerId = onRouter.get(uname);
    if (!it.mikrotik_id && routerId) {
      await it.update({ mikrotik_id: routerId, error: null });
      result.idRecovered++;
    }
  }

  logger.info(
    `[PppoeBulk] verifikasi job#${jobId} — ${result.confirmed}/${result.checked} terkonfirmasi` +
    (result.missing ? `, ${result.missing} hilang` : '') +
    (result.idRecovered ? `, ${result.idRecovered} .id dipulihkan` : '')
  );

  return result;
}

/**
 * RECOVERY SAAT STARTUP
 * ─────────────────────────────────────────────────────────────────────────────
 * Dipanggil sekali dari server.js setelah database siap.
 *
 * MASALAH: worker hidup di memori proses. Kalau PM2 restart di tengah batch
 * 1000 user, job tertinggal di status 'running' selamanya — tidak ada yang
 * melanjutkan, dan tidak ada indikasi apa pun sampai ada orang membuka
 * halaman dan menekan Lanjutkan.
 *
 * Karena checkpoint sudah ada di tabel item (hanya status='pending' yang
 * diproses), melanjutkan job cukup aman: item yang sudah 'ok' tidak akan
 * dibuat ulang.
 *
 * @param {object} opt
 *   autoResume  - true: langsung jalankan lagi; false: hanya tandai 'paused'
 *   maxJobs     - batas job yang di-resume sekaligus (hindari badai request
 *                 ke banyak router saat boot)
 */
async function recoverStaleJobs(opt = {}) {
  const autoResume = opt.autoResume !== false;
  const maxJobs    = opt.maxJobs || 3;

  const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');

  let stale;
  try {
    stale = await PppoeProvisionJob.findAll({
      where: { status: 'running' },
      order: [['id', 'ASC']],
    });
  } catch (e) {
    // Tabel belum ada (migrasi belum dijalankan) — bukan kondisi fatal.
    logger.warn(`[PppoeBulk] recovery dilewati: ${e.message}`);
    return { found: 0, resumed: 0, closed: 0 };
  }

  if (!stale.length) return { found: 0, resumed: 0, closed: 0 };

  const stats = { found: stale.length, resumed: 0, closed: 0 };
  logger.info(`[PppoeBulk] recovery: ${stale.length} job tertinggal di status 'running'`);

  for (const job of stale) {
    // Job yang sedang berjalan di proses ini (mustahil saat boot, tapi aman)
    if (runningJobs.has(job.id)) continue;

    const pending = await PppoeProvisionItem.count({
      where: { job_id: job.id, status: 'pending' },
    }).catch(() => 0);

    // Tidak ada sisa kerja → job sebenarnya sudah selesai, hanya statusnya
    // tidak sempat diperbarui sebelum proses mati.
    if (!pending) {
      await job.update({
        status: 'done',
        finished_at: job.finished_at || new Date(),
        error_message: 'Ditutup otomatis saat startup — semua item sudah diproses',
      });
      stats.closed++;
      logger.info(`[PppoeBulk] job#${job.id} ditutup (tidak ada item pending)`);
      continue;
    }

    if (!autoResume || stats.resumed >= maxJobs) {
      // Tandai paused supaya terlihat di UI dan bisa dilanjutkan manual.
      await job.update({
        status: 'paused',
        error_message: `Terputus saat restart server — ${pending} item belum diproses. Klik Lanjutkan.`,
      });
      logger.info(`[PppoeBulk] job#${job.id} ditandai paused (${pending} item tersisa)`);
      continue;
    }

    await job.update({
      status: 'pending',
      error_message: `Dilanjutkan otomatis setelah restart — ${pending} item tersisa`,
    });
    stats.resumed++;
    logger.info(`[PppoeBulk] job#${job.id} dilanjutkan otomatis (${pending} item tersisa)`);

    // Fire-and-forget, dengan jeda bertingkat supaya beberapa job tidak
    // menghantam router bersamaan tepat saat server baru naik.
    const delay = stats.resumed * 3000;
    setTimeout(() => {
      runJob(job.id).catch(e =>
        logger.error(`[PppoeBulk] resume job#${job.id} gagal: ${e.message}`)
      );
    }, delay);
  }

  return stats;
}

/**
 * SCHEDULER JOB TERJADWAL
 * ─────────────────────────────────────────────────────────────────────────────
 * Dipanggil berkala oleh cron (lihat CronService). Mencari job berstatus
 * 'scheduled' yang scheduled_at-nya sudah lewat, lalu menjalankannya.
 *
 * KENAPA PERLU: controller start() bisa menaruh job di status 'scheduled'
 * (mis. migrasi ribuan user dijadwalkan ke luar jam sibuk), tapi tanpa
 * fungsi ini tidak ada yang pernah menjalankannya — job menggantung selamanya.
 *
 * ANTI DOUBLE-RUN: klaim job dengan UPDATE bersyarat
 * (WHERE status='scheduled') sebelum runJob. Kalau dua tick cron beririsan
 * (atau dua instance PM2), hanya satu yang berhasil mengubah statusnya;
 * yang lain mendapat affected=0 dan melewatinya. runJob sendiri juga punya
 * guard runningJobs, jadi ini lapis pertahanan kedua.
 *
 * @param {object} opt
 *   maxJobs - batas job yang dijalankan per tick (hindari badai request ke
 *             banyak router sekaligus saat banyak jadwal jatuh tempo bersamaan)
 */
async function runDueScheduledJobs(opt = {}) {
  const maxJobs = opt.maxJobs || 3;
  const { PppoeProvisionJob, sequelize } = require('../models');
  const { Op } = require('sequelize');

  let due;
  try {
    due = await PppoeProvisionJob.findAll({
      where: {
        status: 'scheduled',
        scheduled_at: { [Op.ne]: null, [Op.lte]: new Date() },
      },
      order: [['scheduled_at', 'ASC']],
      limit: maxJobs,
    });
  } catch (e) {
    // Tabel/kolom belum ada (migrasi schedule belum dijalankan) — bukan fatal.
    logger.warn(`[PppoeBulk] scheduler dilewati: ${e.message}`);
    return { found: 0, started: 0 };
  }

  if (!due.length) return { found: 0, started: 0 };

  const stats = { found: due.length, started: 0 };

  for (let i = 0; i < due.length; i++) {
    const job = due[i];

    // Sudah berjalan di proses ini — jangan sentuh.
    if (runningJobs.has(job.id)) continue;

    // Klaim atomik: hanya berhasil kalau statusnya MASIH 'scheduled'.
    // Ini yang mencegah dua tick/instance menjalankan job yang sama.
    const [affected] = await PppoeProvisionJob.update(
      { status: 'pending', scheduled_at: null, error_message: null },
      { where: { id: job.id, status: 'scheduled' } }
    );
    if (!affected) continue; // sudah diklaim pihak lain

    stats.started++;
    logger.info(`[PppoeBulk] scheduler menjalankan job#${job.id} (jadwal ${job.scheduled_at})`);

    // Jeda bertingkat supaya beberapa job tidak menghantam router bersamaan.
    const delay = i * 2000;
    setTimeout(() => {
      runJob(job.id).catch(e =>
        logger.error(`[PppoeBulk] scheduled runJob#${job.id} gagal: ${e.message}`)
      );
    }, delay);
  }

  return stats;
}

/**
 * PEMBERSIHAN PASSWORD
 * ─────────────────────────────────────────────────────────────────────────────
 * Kosongkan kolom password pada job yang sudah selesai lebih dari N hari.
 *
 * KENAPA: password PPPoE harus disimpan plaintext saat provisioning karena
 * router membutuhkan nilai aslinya. Tapi setelah job selesai dan laporan
 * diunduh, CRM tidak lagi memerlukannya — yang tersisa hanya risiko kalau
 * database bocor.
 *
 * Laporan .xlsx tetap bisa diunduh setelah ini, hanya kolom passwordnya
 * kosong. Operator yang butuh password harus mengunduh laporan sebelum
 * masa retensi habis.
 */
async function purgeOldPasswords(retentionDays = 7) {
  const { PppoeProvisionJob, PppoeProvisionItem, sequelize } = require('../models');
  const { Op } = require('sequelize');

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  try {
    const jobs = await PppoeProvisionJob.findAll({
      where: {
        status: { [Op.in]: ['done', 'failed'] },
        finished_at: { [Op.lt]: cutoff },
      },
      attributes: ['id'],
      raw: true,
    });

    if (!jobs.length) return { jobs: 0, items: 0 };

    const ids = jobs.map(j => j.id);
    const [affected] = await PppoeProvisionItem.update(
      { password: null },
      { where: { job_id: { [Op.in]: ids }, password: { [Op.ne]: null } } }
    );

    if (affected) {
      logger.info(`[PppoeBulk] purge password — ${affected} item dari ${ids.length} job (>${retentionDays} hari)`);
    }
    return { jobs: ids.length, items: affected };
  } catch (e) {
    logger.warn(`[PppoeBulk] purgeOldPasswords: ${e.message}`);
    return { jobs: 0, items: 0, error: e.message };
  }
}

/**
 * Hapus kembali semua secret yang dibuat job ini.
 * Hanya menyentuh item status='ok' yang punya mikrotik_id, jadi secret lain
 * di router tidak terganggu.
 */
async function rollbackJob(jobId) {
  const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');

  const job = await PppoeProvisionJob.findByPk(jobId);
  if (!job) throw new Error('Job tidak ditemukan');

  const mt = await getMikrotikInstanceByDevice(job.device_id);
  if (!mt) throw new Error(`Router (device_id=${job.device_id}) tidak bisa dihubungi`);

  const items = await PppoeProvisionItem.findAll({
    where: { job_id: jobId, status: 'ok' },
  });

  if (!items.length) {
    return { deleted: 0, failed: 0, skipped: 0, notFound: 0,
             message: 'Tidak ada item berhasil yang bisa di-rollback' };
  }

  // Ambil snapshot secret router SEKALI untuk resolusi .id.
  // Item yang mikrotik_id-nya null (karena koneksi ke-reset saat create)
  // dicocokkan by-username ke snapshot ini.
  let byName = new Map();
  try {
    const all = await mt.getPPPoESecrets();
    (all || []).forEach(sec => {
      const n = String(sec.name || '').toLowerCase();
      if (n && sec.id) byName.set(n, sec.id);
    });
  } catch (e) {
    logger.warn(`[PppoeBulk] rollback: gagal ambil snapshot secret: ${e.message}`);
  }

  const stats = { deleted: 0, failed: 0, skipped: 0, notFound: 0 };

  for (const it of items) {
    const uname = String(it.username || '').toLowerCase();

    // Resolusi .id berlapis:
    //   1. mikrotik_id yang tersimpan saat create
    //   2. cocokkan username ke snapshot router
    // Lapis kedua penting karena create tidak selalu mengembalikan .id.
    let id = it.mikrotik_id || byName.get(uname) || null;

    if (!id) {
      // Username tidak ada di router — kemungkinan sudah dihapus manual.
      // Tandai sebagai selesai supaya job tidak menggantung di status 'ok'.
      stats.notFound++;
      await it.update({
        status: 'pending', mikrotik_id: null, attempts: 0,
        error: 'Tidak ditemukan di router saat rollback (mungkin sudah dihapus manual)',
      });
      continue;
    }

    try {
      await mt.deletePPPoESecret(id);
      await it.update({ status: 'pending', mikrotik_id: null, error: 'Di-rollback', attempts: 0 });
      stats.deleted++;
      await sleep(80);
    } catch (e) {
      // deletePPPoESecret sudah memverifikasi penghapusan secara internal,
      // jadi kalau sampai melempar error, record memang masih ada.
      stats.failed++;
      await it.update({ error: 'Rollback gagal: ' + e.message });
      logger.warn(`[PppoeBulk] rollback ${it.username} (id=${id}): ${e.message}`);
    }
  }

  // Hitung ulang succeeded dari kondisi item yang sebenarnya,
  // jangan asal set 0 — item yang gagal dihapus masih berstatus 'ok'.
  const stillOk = await PppoeProvisionItem.count({ where: { job_id: jobId, status: 'ok' } })
    .catch(() => 0);

  await job.update({
    status: stillOk > 0 ? 'done' : 'pending',
    succeeded: stillOk,
    finished_at: stillOk > 0 ? job.finished_at : null,
    error_message: `Rollback: ${stats.deleted} dihapus, ${stats.failed} gagal, ${stats.notFound} tidak ditemukan`,
  });

  logger.info(`[PppoeBulk] rollback job#${jobId} — ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  runJob,
  rollbackJob,
  verifyJob,
  recoverStaleJobs,
  runDueScheduledJobs,
  purgeOldPasswords,
  generatePassword,
  isTransientError,
  AdaptiveThrottle,
  DEFAULT_CONCURRENCY,
  DEFAULT_DELAY_MS,
};
