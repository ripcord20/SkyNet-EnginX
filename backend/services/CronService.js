'use strict';

/**
 * CronService.js
 * ─────────────────────────────────────────────────────────────────────
 * Semua cron job aplikasi dalam satu service.
 *
 * Job yang berjalan:
 *  - Overdue invoice         → setiap hari jam 01:00
 *  - Auto isolir             → setiap jam
 *  - DB Cleanup MASTER       → setiap hari jam 03:00 (semua high-volume table)
 *  - DB Backup AUTO          → konfigurasi via Settings → Database Management
 *  - Queue traffic history   → setiap 1 menit
 *  - Device traffic poll     → setiap 1 menit (MikroTik API)
 *  - GenieACS ONT poll       → setiap 5 menit (jika GenieACS aktif)
 *  - OLT SNMP poll           → setiap 5 menit (jika OLT dikonfigurasi)
 *  - Cleanup signal history  → setiap hari jam 03:30
 *  - WA Reminder             → setiap 1 menit (cek jadwal)
 *  - WA Report               → setiap 1 menit (cek jadwal)
 *  - Broadcast Scheduler     → setiap 1 menit
 *  - Daily Alerts            → setiap hari jam 07:00
 * ─────────────────────────────────────────────────────────────────────
 */

const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const moment = require('moment');
const DemoResetService = require('../utils/DemoResetService');
const DemoController = require('../controllers/DemoController');

// ── Timezone helper (tanpa dependency moment-timezone) ──────────────────
// Cron jalan pakai waktu server (bisa UTC di VPS). Untuk reminder, jam &
// tanggal harus dihitung di timezone aplikasi (default Asia/Jakarta) supaya
// "08:00" yang diset admin benar-benar jam 08:00 WIB, bukan waktu server.
const APP_TZ = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Jakarta';

// Ambil komponen waktu sekarang di timezone tertentu via Intl (built-in).
// Return { hhmm: 'HH:mm', date: 'YYYY-MM-DD' }.
function nowInTz(tz) {
  try {
    const d = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const hh = parts.hour === '24' ? '00' : parts.hour; // beberapa env pakai 24
    return {
      hhmm: `${hh}:${parts.minute}`,
      date: `${parts.year}-${parts.month}-${parts.day}`
    };
  } catch (_) {
    // Fallback: waktu server
    return { hhmm: moment().format('HH:mm'), date: moment().format('YYYY-MM-DD') };
  }
}

// Tanggal (YYYY-MM-DD) relatif terhadap "hari ini di tz", digeser N hari.
function dateInTzOffset(tz, offsetDays) {
  const base = nowInTz(tz).date; // YYYY-MM-DD di tz
  // Pakai moment untuk aritmatika tanggal murni (date-only, aman dari DST).
  return moment(base, 'YYYY-MM-DD').add(offsetDays, 'days').format('YYYY-MM-DD');
}
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const ConfigCrypto = require('../utils/ConfigCrypto');
const { getCompanyName } = require('../utils/companyInfo');

// Models yang dibutuhkan
const { QueueHistory, Invoice, Customer, TrafficData, DeviceLog } = require('../models');

// Path config OLT
const OLT_CONFIG_PATH = path.join(__dirname, '../../uploads/olt_config.json');

class CronService {
  constructor() {
    this.jobs    = [];
    this.io      = null;

    // Jobs yang berjalan di constructor (bukan di start())
    cron.schedule('0 7 * * *', () => this._runDailyAlerts());
    cron.schedule('0 * * * *', () => this._runAutoIsolir());

    // Sampler traffic interface hotspot — tiap 5 menit, untuk riwayat kapasitas.
    try {
      const TrafficHistory = require('./TrafficHistoryService');
      cron.schedule('*/5 * * * *', () => TrafficHistory.sample().catch(() => {}));
      cron.schedule('30 3 * * *', () => TrafficHistory.prune(30).catch(() => {})); // retensi 30 hari
      setTimeout(() => TrafficHistory.sample().catch(() => {}), 8000);             // sampel awal
    } catch (e) { console.error('[Cron] traffic sampler:', e.message); }

    // Pengeluaran berulang — cek tiap hari jam 02:00; entri dibuat saat
    // tanggal hari ini mencapai day_of_month tiap template (idempotent).
    try {
      const RecurringExpense = require('./RecurringExpenseService');
      cron.schedule('0 2 * * *', () => RecurringExpense.generate().catch(() => {}));
      setTimeout(() => RecurringExpense.generate().catch(() => {}), 12000);        // cek awal saat start
    } catch (e) { console.error('[Cron] recurring expense:', e.message); }

    // Bersihkan password provisioning PPPoE yang sudah tidak dibutuhkan.
    // Password disimpan plaintext karena router memerlukan nilai aslinya
    // saat provisioning, tapi setelah job selesai dan laporan diunduh,
    // menyimpannya hanya menambah risiko kalau database bocor.
    // Retensi 7 hari — cukup untuk mengunduh laporan .xlsx.
    try {
      const PppoeBulk = require('./PppoeBulkProvisionService');
      const RETENSI_HARI = 7;
      cron.schedule('30 3 * * *', () => PppoeBulk.purgeOldPasswords(RETENSI_HARI).catch(() => {}));
      setTimeout(() => PppoeBulk.purgeOldPasswords(RETENSI_HARI).catch(() => {}), 20000);
    } catch (e) { console.error('[Cron] purge password pppoe:', e.message); }

    // Scheduler bulk PPPoE — jalankan job yang dijadwalkan (status 'scheduled')
    // begitu waktunya tiba. Tanpa ini, job yang dijadwalkan lewat opsi
    // "jalankan nanti" tidak pernah dieksekusi dan menggantung selamanya.
    // Cek tiap menit + sekali ~25 detik setelah start (menangkap jadwal yang
    // sudah lewat selagi server mati). Fungsi punya klaim atomik sendiri,
    // jadi aman meski tick beririsan.
    try {
      const PppoeBulk = require('./PppoeBulkProvisionService');
      cron.schedule('* * * * *', () =>
        PppoeBulk.runDueScheduledJobs({ maxJobs: 3 })
          .then(r => { if (r.started) console.log(`[Cron] Bulk PPPoE: ${r.started} job terjadwal dijalankan`); })
          .catch(() => {})
      );
      setTimeout(() => PppoeBulk.runDueScheduledJobs({ maxJobs: 3 }).catch(() => {}), 25000);
    } catch (e) { console.error('[Cron] scheduler pppoe bulk:', e.message); }

    // Pemasukan otomatis — jaring pengaman: backfill payment yang (karena
    // jalur lama/edge case) belum tercatat di Keuangan. Pembayaran normal
    // sudah disinkron real-time saat dibuat, jadi cron ini hanya menambal
    // sisa. Idempotent (ref PAY-{id}). Jalan tiap 10 menit + sekali saat start.
    try {
      cron.schedule('*/10 * * * *', () => this._backfillKeuanganIncome().catch(() => {}));
      setTimeout(() => this._backfillKeuanganIncome().catch(() => {}), 15000);
    } catch (e) { console.error('[Cron] keuangan income backfill:', e.message); }

    // Auto-verifikasi sesi Fonnte — provider Fonnte adalah layanan cloud;
    // device-nya hidup di server Fonnte, bukan di sini. Saat FLAYNET restart,
    // status di DB bisa jadi 'disconnected' meski device Fonnte sebenarnya aktif.
    // Job ini mengecek ulang status ke API Fonnte secara berkala + sekali saat
    // start, lalu update DB & broadcast ke UI — jadi tak perlu klik "Verifikasi
    // Status" manual. Tiap 3 menit + sekali ~10 detik setelah start.
    try {
      cron.schedule('*/3 * * * *', () => this._autoVerifyFonnte().catch(() => {}));
      setTimeout(() => this._autoVerifyFonnte().catch(() => {}), 10000);
    } catch (e) { console.error('[Cron] fonnte auto-verify:', e.message); }

    // Auto-reconnect WAHA — WAHA berjalan sebagai layanan terpisah (Docker).
    // Session bisa jadi STOPPED/FAILED setelah restart container WAHA, blip
    // jaringan, atau WhatsApp memutus. Tanpa ini, admin harus start manual.
    // Job ini mengecek tiap session provider=waha berkala; kalau putus & punya
    // auth tersimpan (pernah connected/ada phone_number), otomatis di-start
    // ulang. Session yang butuh scan QR TIDAK dipaksa (di luar kendali). Tiap
    // 2 menit + sekali ~14 detik setelah start.
    try {
      cron.schedule('*/2 * * * *', () => this._autoReconnectWaha().catch(() => {}));
      cron.schedule('*/2 * * * *', () => this._reconcilePendingWa().catch(() => {}));
      setTimeout(() => this._autoReconnectWaha().catch(() => {}), 14000);
    } catch (e) { console.error('[Cron] waha auto-reconnect:', e.message); }

    // Field Collection — generate task penagihan dari invoice belum lunas.
    // Berjalan tiap hari jam 06:00 (idempotent: invoice yg sudah punya task
    // aktif dilewati). Admin tetap bisa generate manual dari /collect.
    try {
      const CollectionService = require('./CollectionService');
      cron.schedule('0 6 * * *', () => {
        CollectionService.generateTasks({})
          .then(r => console.log(`[Cron] Collection tasks: +${r.created} (skip ${r.skipped})`))
          .catch(e => console.error('[Cron] collection generate:', e.message));
      });
    } catch (e) { console.error('[Cron] collection task:', e.message); }

    // Laporan Keuangan via Email — tick tiap jam (menit ke-5), cek apakah
    // saatnya kirim sesuai jadwal (harian/mingguan/bulanan + jam yg disetel).
    try {
      cron.schedule('5 * * * *', () => {
        this._runFinanceReportSchedule()
          .catch(e => console.error('[Cron] finance report:', e.message));
      });
    } catch (e) { console.error('[Cron] finance report schedule:', e.message); }

    // Email Digest Harian — tick tiap jam (menit ke-8), cek apakah saatnya
    // kirim "pulse harian" operasional ke admin (idempotent per hari).
    try {
      cron.schedule('8 * * * *', () => {
        this._runDailyDigestSchedule()
          .catch(e => console.error('[Cron] daily digest:', e.message));
      });
    } catch (e) { console.error('[Cron] daily digest schedule:', e.message); }

    // Retry email gagal — tiap 3 menit proses antrian email berstatus
    // 'retrying' yang sudah jatuh tempo (backoff 2m/10m/30m, maks 3x).
    try {
      cron.schedule('*/3 * * * *', () => {
        const EmailService = require('./EmailService');
        EmailService.processRetryQueue()
          .then(r => { if (r.processed) console.log(`[Cron] Email retry: ${r.sent} terkirim, ${r.scheduled} dijadwal ulang, ${r.failed} gagal`); })
          .catch(e => console.error('[Cron] email retry:', e.message));
      });
    } catch (e) { console.error('[Cron] email retry schedule:', e.message); }

    // Cleanup log email lama — tiap hari 03:40, hapus baris email_logs lebih
    // lama dari N hari (default 90, dapat diatur via app_settings
    // `email_log_retention_days`). Mencegah tabel email_logs membengkak.
    // Hanya menghapus log final (sent/failed) — baris 'retrying' tak disentuh.
    try {
      cron.schedule('40 3 * * *', () => {
        this._runEmailLogCleanup()
          .then(n => { if (n) console.log(`[Cron] Email log cleanup: ${n} baris dihapus`); })
          .catch(e => console.error('[Cron] email log cleanup:', e.message));
      });
    } catch (e) { console.error('[Cron] email log cleanup schedule:', e.message); }

    // Reseller top-up SLA reminder (#3) — tiap jam cek top-up manual yang
    // menggantung > ambang jam, lalu ingatkan admin via Telegram.
    try {
      const ResellerTopupSlaService = require('./ResellerTopupSlaService');
      cron.schedule('15 * * * *', () => {
        ResellerTopupSlaService.checkPending()
          .then(r => { if (r.count) console.log(`[Cron] Reseller SLA: ${r.count} top-up menggantung`); })
          .catch(e => console.error('[Cron] reseller SLA:', e.message));
      });
    } catch (e) { console.error('[Cron] reseller SLA task:', e.message); }

    // Ringkasan harian via Telegram bot — tick tiap jam (menit ke-2), kirim
    // ringkasan operasional ke chat admin saat jam == telegram_summary_hour.
    // Aktif bila app_settings telegram_summary_enabled=1 (default jam 8).
    // Idempotent per hari (telegram_summary_last menyimpan tanggal terkirim).
    try {
      cron.schedule('2 * * * *', () => {
        this._runTelegramDailySummary()
          .catch(e => console.error('[Cron] telegram summary:', e.message));
      });
    } catch (e) { console.error('[Cron] telegram summary schedule:', e.message); }

    // Jalankan daily alerts sekali saat startup (delay 5 detik)
    setTimeout(() => this._runDailyAlerts(), 5000);
  }

  // Kirim ringkasan harian Telegram bila sudah waktunya (idempotent per hari).
  async _runTelegramDailySummary() {
    const enabled = await this._getSetting('telegram_summary_enabled', '0');
    if (String(enabled) !== '1') return;

    const tz = await this._getSetting('timezone', 'Asia/Jakarta');
    const targetHour = parseInt(await this._getSetting('telegram_summary_hour', '8'), 10) || 8;

    // Jam & tanggal lokal sesuai timezone.
    const now = new Date();
    const localHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now), 10);
    if (localHour !== targetHour) return;

    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const lastSent = await this._getSetting('telegram_summary_last', '');
    if (lastSent === todayKey) return; // sudah dikirim hari ini

    try {
      const TGBot = require('./TelegramBotService');
      const res = await TGBot.sendDailySummary();
      if (res && res.ok) {
        const { AppSetting } = require('../models');
        await AppSetting.upsert({ key: 'telegram_summary_last', value: todayKey, type: 'string' });
        console.log(`[Cron] Telegram ringkasan harian terkirim (${todayKey})`);
      } else {
        console.warn('[Cron] Telegram ringkasan tidak terkirim:', res && res.reason);
      }
    } catch (e) {
      console.error('[Cron] telegram summary send:', e.message);
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────
  start(io = null) {

    // ── Demo account auto-reset (tiap jam) ───────────────────────────
    try {
      const cron = require('node-cron');
      cron.schedule('0 * * * *', () => {
        DemoResetService.reset().catch(e => console.error('[DemoReset]', e));
      });
      // Cleanup demo ephemeral yang expired — tiap 10 menit
      cron.schedule('*/10 * * * *', () => {
        DemoController.cleanupExpired().catch(e => console.error('[DemoCleanup]', e));
      });
      console.log('[Cron] Demo reset & cleanup jobs registered');
    } catch (e) {
      console.error('[Cron] Failed to register demo jobs:', e);
    }

    this.io = io;

    // ── 1. Mark overdue invoices (setiap hari jam 01:00) ─────────────
    this.jobs.push(cron.schedule('0 1 * * *', async () => {
      try {
        const today = moment().format('YYYY-MM-DD');
        const [updated] = await Invoice.update(
          { status: 'overdue' },
          { where: { status: 'unpaid', due_date: { [Op.lt]: today } } }
        );
        if (updated > 0) logger.info(`[Cron] Marked ${updated} invoices as overdue`);
      } catch (err) {
        logger.error('[Cron] Overdue error: ' + (err.message || err));
      }
    }));

    // ── 2. (DINONAKTIFKAN) Auto-isolate DB-only ─────────────────────
    // CATATAN: job lama jam 02:00 ini HANYA meng-update customers.status='isolated'
    // di DATABASE tanpa menyentuh router (tidak men-disable IP binding / PPPoE /
    // address-list). Akibatnya status DB "isolated" tapi akses pelanggan tetap
    // jalan di MikroTik, DAN membuat runAutoIsolir() (jalur benar) men-skip
    // pelanggan tsb karena isolir_status sudah berubah.
    //
    // Auto-isolir yang BENAR ditangani oleh _runAutoIsolir() (cron tiap jam,
    // di constructor) → IsolirService.runAutoIsolir() yang benar-benar memblokir
    // di router sesuai metode tiap pelanggan (hotspot binding / pppoe / static).
    //
    // Job ini sengaja TIDAK didaftarkan lagi. Jangan diaktifkan kembali.

    // ── 3. DATABASE CLEANUP (setiap hari jam 03:00) ──────────────────
    // Master cleanup job — loop ke semua table di registry
    // DatabaseCleanupController.TABLES, baca retention dari app_settings.
    // Tabel yang di-handle: traffic_data, queue_history, device_logs,
    // technician_locations, activity_logs, notifications, wa_logs,
    // wa_messages, isolir_logs, push_notifications.
    this.jobs.push(cron.schedule('0 3 * * *', async () => {
      try {
        const DbCleanup = require('../controllers/DatabaseCleanupController');
        logger.info('[Cron] Database cleanup started');
        let totalDeleted = 0;
        for (const t of DbCleanup.TABLES) {
          try {
            const r = await DbCleanup.runCleanupForTable(t.key);
            if (r.deleted > 0) totalDeleted += r.deleted;
          } catch (e) {
            logger.error(`[Cron] cleanup ${t.key} error: ${e.message}`);
          }
        }
        logger.info(`[Cron] Database cleanup done. Total ${totalDeleted} rows deleted`);
      } catch (err) {
        logger.error('[Cron] DB cleanup error: ' + (err.message || err));
      }
    }));

    // ── 3.5. DATABASE BACKUP (dinamis dari setting) ──────────────────
    // Schedule, retention, dan mode diatur dari halaman Database Management.
    // Defaultnya: tiap hari jam 02:00, retention 7 file, mode auto.
    // Untuk apply schedule baru setelah ubah setting → restart aplikasi.
    this.jobs.push((async () => {
      try {
        const BackupCtrl = require('../controllers/BackupController');
        const enabled  = await BackupCtrl.getSetting('backup_auto_enabled', '0');
        if (enabled !== '1' && String(enabled).toLowerCase() !== 'true') {
          logger.info('[Cron] Auto-backup disabled — skip register');
          return null;
        }
        const schedule  = await BackupCtrl.getSetting('backup_auto_schedule', '0 2 * * *');
        const retention = parseInt(await BackupCtrl.getSetting('backup_auto_retention', '7'), 10);
        const mode      = await BackupCtrl.getSetting('backup_auto_mode', 'auto');

        return cron.schedule(schedule, async () => {
          try {
            logger.info(`[Cron] Auto-backup starting (mode=${mode})`);
            const result = await BackupCtrl.createBackup(mode);
            logger.info(`[Cron] Auto-backup done: ${result.filename} (${result.sizeMB} MB)`);

            // Prune backup lama
            const prune = await BackupCtrl.pruneOldBackups(retention);
            if (prune.deleted > 0) {
              logger.info(`[Cron] Pruned ${prune.deleted} old backup(s)`);
            }
          } catch (err) {
            logger.error('[Cron] Auto-backup error: ' + (err.message || err));
          }
        });
      } catch (e) {
        logger.error('[Cron] Failed to register backup job: ' + (e.message || e));
        return null;
      }
    })());

    // ── 4. (REMOVED) Cleanup device logs — sekarang dihandle job #3 ──
    // Lihat DatabaseCleanupController.TABLES entry `device_logs`.

    // ── 5. Queue traffic history (setiap 1 menit) ────────────────────
    this.jobs.push(cron.schedule('* * * * *', async () => {
      await this._pollQueueHistory();
    }));

    // ── 6. (REMOVED) Cleanup queue history — sekarang dihandle job #3 ─
    // Lihat DatabaseCleanupController.TABLES entry `queue_history`.

    // ── 7. GenieACS ONT poll (setiap 5 menit) ────────────────────────
    this.jobs.push(cron.schedule('*/5 * * * *', async () => {
      await this._pollGenieACS();
    }));

    // ── 8. OLT SNMP poll (setiap 5 menit) — BARU ─────────────────────
    // Berjalan bersamaan dengan GenieACS, tidak saling mengganggu.
    // ONT dari OLT SNMP masuk ke tabel yang sama (ont_devices),
    // dibedakan via kolom 'source'.
    this.jobs.push(cron.schedule('*/5 * * * *', async () => {
      await this._pollOltSNMP();
    }));

    // ── 9. Cleanup ONT signal history (setiap hari jam 03:30) ────────
    this.jobs.push(cron.schedule('30 3 * * *', async () => {
      try {
        const { OntSignalHistory } = require('../models');
        const cutoff = moment().subtract(7, 'days').toDate();
        const deleted = await OntSignalHistory.destroy({
          where: { recorded_at: { [Op.lt]: cutoff } }
        });
        if (deleted > 0) logger.info(`[Cron] Cleaned ${deleted} ONT signal history records`);
      } catch (err) {
        logger.error('[Cron] ONT signal history cleanup error: ' + (err.message || err));
      }
    }));

    // ── 9b. Perekam ONT signal history BERKALA (setiap 10 menit) ─────
    // Selain perekaman saat ONT TR-069 inform, snapshot berkala ini menjamin
    // grafik Signal History selalu punya titik time-series walau ONT jarang
    // inform. Dedup: lewati device yang sudah punya record < 9 menit terakhir.
    this.jobs.push(cron.schedule('*/10 * * * *', async () => {
      try {
        const { OntDevice, OntSignalHistory } = require('../models');
        const since = moment().subtract(9, 'minutes').toDate();

        // Ambil ONT yang punya signal & terbaru aktif (last_inform/last_synced
        // dalam 1 jam terakhir → ONT online). Hindari merekam ONT mati.
        const onlineSince = moment().subtract(60, 'minutes').toDate();
        const devices = await OntDevice.findAll({
          where: {
            signal_strength: { [Op.ne]: null },
            [Op.or]: [
              { last_synced: { [Op.gte]: onlineSince } },
              { last_inform: { [Op.gte]: onlineSince } },
            ],
          },
          attributes: ['id', 'signal_strength'],
          raw: true,
        });
        if (!devices.length) return;

        // Dedup: device yang sudah punya record < 9 menit dilewati.
        const recent = await OntSignalHistory.findAll({
          where: { recorded_at: { [Op.gte]: since } },
          attributes: ['ont_device_id'],
          group: ['ont_device_id'],
          raw: true,
        });
        const recentSet = new Set(recent.map(r => r.ont_device_id));

        const now = new Date();
        const toInsert = devices
          .filter(d => !recentSet.has(d.id))
          .map(d => ({
            ont_device_id: d.id,
            rx_power: parseFloat(d.signal_strength),
            tx_power: null,
            olt_rx_power: null,
            recorded_at: now,
          }))
          .filter(r => !isNaN(r.rx_power));

        if (toInsert.length) {
          await OntSignalHistory.bulkCreate(toInsert);
          logger.info(`[Cron] ONT signal snapshot: ${toInsert.length} record disimpan`);
        }
      } catch (err) {
        logger.error('[Cron] ONT signal recorder error: ' + (err.message || err));
      }
    }));

    // ── 10. WA Reminder Scheduler (setiap 1 menit) ───────────────────
    this.jobs.push(cron.schedule('* * * * *', async () => {
      await this._runReminderScheduler();
    }));

    // ── 11. WA Report Scheduler (setiap 1 menit) ─────────────────────
    this.jobs.push(cron.schedule('* * * * *', async () => {
      await this._runReportScheduler();
    }));

    // ── 12. Broadcast Scheduler (setiap 1 menit) ─────────────────────
    this.jobs.push(cron.schedule('* * * * *', async () => {
      await this._runBroadcastScheduler();
    }));

    // ── 12b. Email Broadcast Scheduler (setiap 1 menit) ──────────────
    // Menjalankan broadcast email berstatus 'scheduled' yang sudah lewat
    // waktu jadwalnya. Paralel dengan WA broadcast scheduler.
    this.jobs.push(cron.schedule('* * * * *', async () => {
      await this._runEmailBroadcastScheduler();
    }));

    // ── 12c. MikroTik Config Backup Scheduler (setiap 1 menit) ───────
    // Service membaca setting (mtbackup_*) tiap tick — perubahan jadwal
    // langsung berlaku tanpa restart. Dedup via mtbackup_last_run_key.
    this.jobs.push(cron.schedule('* * * * *', async () => {
      try {
        const MikrotikBackupService = require('./MikrotikBackupService');
        await MikrotikBackupService.schedulerTick();
      } catch (e) {
        logger.error('[Cron:MTBackup] Error: ' + (e.message || e));
      }
    }));

    // ── 12d. Telegram Report Scheduler (setiap 1 menit) ──────────────
    // Kirim ringkasan operasional ke Telegram sesuai jadwal tgreport_*.
    // Dedup harian via tgreport_last_run_key.
    this.jobs.push(cron.schedule('* * * * *', async () => {
      try {
        await require('./TelegramReportService').schedulerTick();
      } catch (e) {
        logger.error('[Cron:TGReport] Error: ' + (e.message || e));
      }
    }));

    // ── 12e. Telegram Backup Scheduler (setiap 1 menit) ──────────────
    // Backup router terpilih lalu kirim file ke Telegram sesuai tgbackup_*.
    // Dedup harian via tgbackup_last_run_key.
    this.jobs.push(cron.schedule('* * * * *', async () => {
      try {
        await require('./TelegramBackupService').schedulerTick();
      } catch (e) {
        logger.error('[Cron:TGBackup] Error: ' + (e.message || e));
      }
    }));

    // ── 13. Web Push: Reminder tagihan (cek tiap jam, kirim sesuai jam pilihan) ─
    // Berjalan tiap jam menit 0. Jam kirim diatur di Settings (push_reminder_send_hour
    // utk H-3/H-1/H+0, push_reminder_overdue_hour utk overdue). Perubahan jam langsung
    // berlaku pada tick jam berikutnya tanpa restart.
    this.jobs.push(cron.schedule('0 * * * *', async () => {
      try {
        const PushService = require('./PushService');
        if (!PushService.isReady()) return;

        const { AppSetting } = require('../models');
        const getHour = async (key, def) => {
          try {
            const row = await AppSetting.findOne({ where: { key } });
            const h = parseInt(row?.value, 10);
            return (h >= 0 && h <= 23) ? h : def;
          } catch (_) { return def; }
        };
        // Cek apakah reminder diaktifkan
        let enabled = '1';
        try {
          const row = await AppSetting.findOne({ where: { key: 'push_reminder_enabled' } });
          if (row && row.value !== null && row.value !== '') enabled = row.value;
        } catch (_) {}
        if (String(enabled) !== '1') return;

        const nowHour = new Date().getHours();
        const dueHour     = await getHour('push_reminder_send_hour', 8);
        const overdueHour = await getHour('push_reminder_overdue_hour', 9);

        if (nowHour === dueHour) {
          try { await PushService.sendDueSoonReminders(); }
          catch (e) { logger.error('[Cron:PushReminder] ' + (e.message || e)); }
        }
        if (nowHour === overdueHour) {
          try { await PushService.sendOverdueReminders(); }
          catch (e) { logger.error('[Cron:PushOverdue] ' + (e.message || e)); }
        }
      } catch (e) {
        logger.error('[Cron:PushReminder] gate error: ' + (e.message || e));
      }
    }));

    // ── 15. Admin Push Scheduler (setiap 1 menit) ──────────────────────
    // Cek push notification yang scheduled_at <= now dan kirim
    this.jobs.push(cron.schedule('* * * * *', async () => {
      try {
        const PushNotifCtrl = require('../controllers/PushNotificationController');
        if (typeof PushNotifCtrl.processScheduled === 'function') {
          await PushNotifCtrl.processScheduled();
        }
      } catch (e) {
        logger.error('[Cron:PushScheduler] ' + (e.message || e));
      }
    }));

    // ── 16. Device Traffic Poll (setiap 1 menit) ────────────────────────
    // Polling traffic dari device MikroTik yang pakai monitoring API.
    // Data disimpan ke traffic_data untuk bandwidth trends chart di dashboard.
    this.jobs.push(cron.schedule('* * * * *', async () => {
      await this._pollDeviceTraffic();
    }));

    // ── 16b. Telegram Monitoring (interval dinamis dari setting) ────────
    // Deteksi gangguan (perangkat down / ONT disconnect / IP pelanggan
    // timeout) lalu kirim notifikasi ke Telegram. Hanya kirim saat transisi
    // status (anti-spam). Skip otomatis kalau Telegram belum dikonfigurasi.
    // Interval diatur di Settings → Telegram (telegram_interval, menit).
    // Bisa diubah tanpa restart via CronService.rescheduleTelegramMonitoring().
    this._scheduleTelegramMonitoring().catch(e =>
      logger.error('[Cron:TelegramMonitoring] init: ' + (e.message || e)));

    // ── 17. Auto-generate Invoice Bulanan (tiap tgl 1 jam 01:30) ────────
    // Otomatis bikin invoice untuk semua customer aktif tiap awal bulan,
    // tanpa perlu admin klik tombol "Generate Invoice" di halaman billing.
    // Idempotent — kalau invoice sudah ada untuk customer di periode tsb, skip.
    // Bisa dimatikan dengan setting `auto_generate_invoice = 0` di app_settings.
    this.jobs.push(cron.schedule('30 1 1 * *', async () => {
      await this._runAutoGenerateInvoice('cron');
    }));

    // Catch-up at startup: kalau bulan ini sudah lewat tanggal 1 dan belum ada
    // invoice yang ter-generate sama sekali untuk periode bulan ini, bikin sekarang.
    // Berguna kalau server baru di-deploy/restart di pertengahan bulan, atau
    // saat tanggal 1 server sedang down sehingga cron miss.
    setTimeout(() => {
      this._runAutoGenerateInvoice('startup').catch(err => {
        logger.error('[Cron:AutoGenInvoice] Startup catch-up error: ' + (err.message || err));
      });
    }, 8000); // delay 8 detik agar models & DB sudah siap

    logger.info('[CronService] Started: overdue, isolir, db-cleanup, db-backup, queue-history, genieacs, olt-snmp, signal-cleanup, wa-reminder, wa-report, broadcast, push-reminder, push-scheduler, device-traffic, auto-gen-invoice');
  }

  // ═══════════════════════════════════════════════════════════════════
  // PEMASUKAN OTOMATIS — BACKFILL KE KEUANGAN (JARING PENGAMAN)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Tambal payment yang belum punya entri pemasukan di tabel `keuangan`.
   * Pembayaran normal sudah disinkron real-time saat dibuat; ini hanya
   * mengamankan jalur lama / edge case agar tidak perlu klik "Sync" manual.
   * Idempotent: dikunci ref_number = PAY-{payment.id}.
   */
  /**
   * Auto-verifikasi semua sesi Fonnte: cek status device ke API Fonnte,
   * update DB, dan broadcast perubahan ke UI via Socket.IO. Menggantikan klik
   * "Verifikasi Status" manual. Aman dipanggil berkala (hanya membaca status).
   */
  async _autoVerifyFonnte() {
    try {
      const { WaSession } = require('../models');
      const FonnteService = require('./FonnteService');
      const GatewayService = require('./GatewayService');
      const sessions = await WaSession.findAll({ where: { provider: 'fonnte' } });
      if (!sessions || !sessions.length) return;

      // Penghitung kegagalan berturut-turut (in-memory, per session). Fonnte adalah
      // layanan CLOUD: device tetap tersambung di server Fonnte meski CRM sesekali
      // gagal cek status. Karena itu:
      //  - 'connected'    → langsung set connected + reset counter (auto-recover).
      //  - 'unknown'      → JANGAN ubah status (blip jaringan/timeout), abaikan.
      //  - 'disconnected' → baru dianggap benar-benar putus setelah beberapa kali
      //                     BERTURUT-TURUT, agar tidak "sering terputus" palsu.
      this._fonnteFail = this._fonnteFail || {};
      const THRESHOLD = 3; // butuh 3x disconnected beruntun sebelum vonis putus

      for (const s of sessions) {
        if (!s.fonnte_token) continue;               // belum dikonfigurasi
        const prev = s.status;

        let state = 'unknown';
        try { state = await FonnteService.checkConnection(s); }
        catch (_) { state = 'unknown'; }

        if (state === 'connected') {
          // Pulih otomatis tanpa verifikasi manual.
          this._fonnteFail[s.session_id] = 0;
          if (prev !== 'connected') {
            await WaSession.update(
              { status: 'connected', last_seen: new Date() },
              { where: { session_id: s.session_id } }
            );
            GatewayService.invalidateSessionCache(s.session_id);
            if (this.io) this.io.emit('wa:status:' + s.session_id, { status: 'connected', provider: 'fonnte', auto: true });
            console.log(`[Cron] Fonnte ${s.session_id} pulih → connected (auto)`);
          } else {
            // Sudah connected: cukup perbarui last_seen (heartbeat).
            await WaSession.update({ last_seen: new Date() }, { where: { session_id: s.session_id } });
          }
          continue;
        }

        if (state === 'unknown') {
          // Gagal cek (transient). Jangan sentuh status; jangan tambah counter.
          continue;
        }

        // state === 'disconnected' → hitung kegagalan beruntun.
        this._fonnteFail[s.session_id] = (this._fonnteFail[s.session_id] || 0) + 1;
        const fails = this._fonnteFail[s.session_id];
        if (fails < THRESHOLD) {
          // Belum cukup bukti; pertahankan status lama (jangan vonis putus dulu).
          continue;
        }
        // Sudah cukup bukti device benar-benar tidak tersambung.
        if (prev !== 'disconnected') {
          await WaSession.update(
            { status: 'disconnected', last_seen: new Date() },
            { where: { session_id: s.session_id } }
          );
          GatewayService.invalidateSessionCache(s.session_id);
          if (this.io) this.io.emit('wa:status:' + s.session_id, { status: 'disconnected', provider: 'fonnte', auto: true });
          console.log(`[Cron] Fonnte ${s.session_id} → disconnected (${fails}x beruntun)`);
        }
      }
    } catch (e) {
      console.error('[Cron] _autoVerifyFonnte:', e.message);
    }
  }

  // Auto-reconnect session WAHA yang terputus, tanpa aksi manual admin.
  async _autoReconnectWaha() {
    try {
      const { WaSession } = require('../models');
      const WahaService = require('./WahaService');
      const GatewayService = require('./GatewayService');
      const sessions = await WaSession.findAll({ where: { provider: 'waha' } });
      if (!sessions || !sessions.length) return;

      // Cegah start-ulang beruntun terlalu cepat (mis. WAHA butuh waktu naik):
      // beri jeda minimal antar percobaan start per session.
      this._wahaLastRestart = this._wahaLastRestart || {};
      const MIN_RESTART_GAP_MS = 3 * 60 * 1000; // 3 menit
      const now = Date.now();

      for (const s of sessions) {
        if (!s.waha_url) continue; // belum dikonfigurasi

        let result;
        try { result = await WahaService.ensureConnected(s); }
        catch (_) { continue; } // transient, coba lagi siklus berikutnya

        const prev = s.status;

        // WORKING → sinkron connected (auto-recover) + heartbeat.
        if (result.mapped === 'connected') {
          // Sekali saja per proses: pastikan webhook session lama menyertakan
          // 'message.ack' (agar status centang jalan). Ditandai in-memory supaya
          // tidak dipanggil tiap siklus.
          this._wahaHookSynced = this._wahaHookSynced || {};
          if (!this._wahaHookSynced[s.session_id]) {
            this._wahaHookSynced[s.session_id] = true;
            WahaService.ensureWebhookConfig(s).catch(() => {});
          }
          if (prev !== 'connected') {
            await WaSession.update(
              { status: 'connected', last_seen: new Date() },
              { where: { session_id: s.session_id } }
            );
            GatewayService.invalidateSessionCache(s.session_id);
            if (this.io) this.io.emit('wa:status:' + s.session_id, { status: 'connected', provider: 'waha', auto: true });
            console.log(`[Cron] WAHA ${s.session_id} pulih → connected (auto)`);
          } else {
            await WaSession.update({ last_seen: new Date() }, { where: { session_id: s.session_id } });
          }
          continue;
        }

        // Transient (WAHA tak menjawab) → jangan ubah status.
        if (result.mapped === 'unknown') continue;

        // Kita baru saja start ulang / buat ulang session → tandai 'connecting'
        // supaya UI menunjukkan proses, dan catat waktu agar tidak spam start.
        if (result.action === 'restarted' || result.action === 'created') {
          const last = this._wahaLastRestart[s.session_id] || 0;
          if (now - last >= MIN_RESTART_GAP_MS) {
            this._wahaLastRestart[s.session_id] = now;
            console.log(`[Cron] WAHA ${s.session_id} ${result.raw} → start ulang otomatis (${result.action})`);
          }
          if (prev !== 'connecting' && prev !== 'connected') {
            await WaSession.update(
              { status: 'connecting', last_seen: new Date() },
              { where: { session_id: s.session_id } }
            );
            GatewayService.invalidateSessionCache(s.session_id);
            if (this.io) this.io.emit('wa:status:' + s.session_id, { status: 'connecting', provider: 'waha', auto: true });
          }
          continue;
        }

        // Butuh scan QR → di luar kendali; set disconnected supaya admin sadar
        // perlu scan, tapi jangan spam log.
        if (result.action === 'needs_qr') {
          if (prev === 'connected') {
            await WaSession.update(
              { status: 'disconnected', last_seen: new Date() },
              { where: { session_id: s.session_id } }
            );
            GatewayService.invalidateSessionCache(s.session_id);
            if (this.io) this.io.emit('wa:status:' + s.session_id, { status: 'disconnected', provider: 'waha', auto: true, needs_qr: true });
            console.log(`[Cron] WAHA ${s.session_id} butuh scan QR (auth hilang) — perlu aksi manual`);
          }
          continue;
        }

        // action === 'error' → gagal start; biarkan status, coba lagi siklus depan.
      }
    } catch (e) {
      console.error('[Cron] _autoReconnectWaha:', e.message);
    }
  }

  // Rekonsiliasi status pesan WA yang macet di 'pending'. Dua penyebab pending
  // menggantung: (a) wa_message_id gagal terekstrak saat kirim (respons WAHA
  // melambat/berbeda bentuk saat broadcast) → ack tak pernah cocok; (b) webhook
  // 'message.ack' tak terpasang (APP_URL kosong) → WAHA tak kirim update centang.
  // Karena pengiriman SUDAH berhasil di sisi WA (pesan sampai ke pelanggan),
  // membiarkan status 'pending' selamanya itu menyesatkan. Setelah masa tenggang,
  // kita naikkan ke 'sent' agar UI tak menampilkan jam pending abadi.
  // Ack asli (delivered/read) yang datang belakangan tetap akan menaikkan status
  // lebih lanjut — reconcile hanya menyentuh yang masih 'pending'.
  async _reconcilePendingWa() {
    try {
      const { WaMessage, WaSession } = require('../models');
      const { Op } = require('sequelize');

      // Hanya jalan bila ada session WAHA/Fonnte (Baileys punya ack sendiri via socket).
      const hasCloud = await WaSession.count({ where: { provider: { [Op.in]: ['waha', 'fonnte'] } } });
      if (!hasCloud) return;

      const GRACE_MS = 3 * 60 * 1000;   // 3 menit: cukup untuk ack normal tiba
      const MAX_AGE_MS = 24 * 60 * 60 * 1000; // jangan sentuh yang sangat lama (>24 jam)
      const now = Date.now();
      const cutoffNew = new Date(now - GRACE_MS);
      const cutoffOld = new Date(now - MAX_AGE_MS);

      const [affected] = await WaMessage.update(
        { status: 'sent' },
        {
          where: {
            direction: 'outbound',
            status: 'pending',
            created_at: { [Op.lt]: cutoffNew, [Op.gt]: cutoffOld },
          },
        }
      );

      if (affected > 0) {
        console.log('[Cron] Rekonsiliasi WA: ' + affected + ' pesan pending → sent');
        // Beri tahu UI supaya jam pending berubah jadi centang tanpa reload.
        if (this.io) this.io.emit('wa:reconciled', { count: affected });
      }
    } catch (e) {
      console.error('[Cron] _reconcilePendingWa:', e.message);
    }
  }

  async _backfillKeuanganIncome() {
    try {
      const { sequelize, Payment, Invoice, Customer } = require('../models');
      const { syncPaymentToKeuangan } = require('../utils/keuanganSync');

      // Ambil payment yang BELUM punya entri keuangan (LEFT JOIN anti-match).
      // Batasi 200 baris/run agar ringan; sisanya tertangani run berikutnya.
      const rows = await sequelize.query(
        `SELECT p.id
           FROM payments p
           LEFT JOIN keuangan k
             ON k.type = 'pemasukan' AND k.ref_number = CONCAT('PAY-', p.id)
          WHERE k.id IS NULL
          ORDER BY p.id DESC
          LIMIT 200`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (!rows || !rows.length) return { synced: 0 };

      let synced = 0;
      for (const r of rows) {
        const payment = await Payment.findByPk(r.id);
        if (!payment) continue;
        let invoice = payment.invoice_id ? await Invoice.findByPk(payment.invoice_id) : null;
        let customer = (invoice && invoice.customer_id) ? await Customer.findByPk(invoice.customer_id) : null;
        const res = await syncPaymentToKeuangan(payment, {
          invoice, customer,
          recordedBy: payment.recorded_by || null,
          channel: 'auto-backfill'
        });
        if (res && res.synced) synced++;
      }
      if (synced > 0) console.log(`[Cron] Keuangan income backfill: ${synced} pemasukan ditambahkan otomatis`);

      // Jaga PNBP (bila aktif) tetap sinkron dgn pendapatan bulan berjalan.
      try {
        const KeuanganController = require('../controllers/KeuanganController');
        const now = new Date();
        await KeuanganController._materializePnbpExpense(now.getMonth() + 1, now.getFullYear());
      } catch (_) {}

      return { synced };
    } catch (e) {
      console.error('[Cron] _backfillKeuanganIncome:', e.message);
      return { synced: 0, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // AUTO-GENERATE INVOICE BULANAN
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Trigger generate invoice untuk periode bulan saat ini.
   * @param {'cron'|'startup'|'manual'} source
   */
  async _runAutoGenerateInvoice(source = 'cron') {
    try {
      // Cek setting auto-generate. Default ON ('1'). Kalau admin set '0', skip.
      const enabled = await this._getSetting('auto_generate_invoice', '1');
      if (enabled !== '1' && String(enabled).toLowerCase() !== 'true') {
        logger.info(`[Cron:AutoGenInvoice] Skipped (${source}) — disabled di settings`);
        return;
      }

      const moment = require('moment');
      const targetMonth = moment().month() + 1;
      const targetYear  = moment().year();

      // Untuk source 'startup': cek apakah sudah ada invoice di periode bulan ini.
      // Kalau sudah ada (artinya cron sudah jalan atau admin sudah generate manual), skip.
      // Untuk source 'cron': tetap jalan (idempotent — sudah di-handle di generateInvoicesForPeriod).
      if (source === 'startup') {
        const { Invoice } = require('../models');
        const existing = await Invoice.count({
          where: { period_month: targetMonth, period_year: targetYear }
        });
        if (existing > 0) {
          logger.info(`[Cron:AutoGenInvoice] Startup catch-up skipped — period ${targetMonth}/${targetYear} sudah ada ${existing} invoice`);
          return;
        }
        // Hanya catch-up kalau sudah lewat tanggal 1 (kalau hari ini tgl 1, biarkan cron jam 01:30 yg jalan)
        const now = moment();
        if (now.date() === 1 && now.hour() < 2) {
          logger.info(`[Cron:AutoGenInvoice] Startup catch-up skipped — nunggu cron jam 01:30`);
          return;
        }
      }

      const BillingController = require('../controllers/BillingController');
      const result = await BillingController.generateInvoicesForPeriod(targetMonth, targetYear, { source });
      logger.info(`[Cron:AutoGenInvoice] (${source}) period ${result.period}: created=${result.created}, skipped=${result.skipped}`);

      // Notif ke superadmin via in-app notification kalau ada invoice baru
      if (result.created > 0 && this.io) {
        try {
          const { Notification, User } = require('../models');
          const admins = await User.findAll({
            where: { role: ['superadmin', 'admin'], is_active: true },
            attributes: ['id']
          });
          const monthName = moment(`${targetYear}-${String(targetMonth).padStart(2,'0')}-01`).format('MMMM YYYY');
          for (const admin of admins) {
            await Notification.create({
              user_id: admin.id,
              title:    'Tagihan otomatis ter-generate',
              message:  `${result.created} invoice untuk periode ${monthName} berhasil dibuat${source === 'startup' ? ' (catch-up startup)' : ''}.`,
              type:     'info',
              link:     '/billing'
            });
          }
          this.io.emit('notification:new', { title: 'Auto Generate Invoice', count: result.created });
        } catch (notifErr) {
          logger.warn('[Cron:AutoGenInvoice] Notif error: ' + notifErr.message);
        }
      }
    } catch (err) {
      logger.error(`[Cron:AutoGenInvoice] (${source}) Error: ` + (err.message || err));
    }
  }

  /** Helper: ambil setting dari app_settings table */
  async _getSetting(key, fallback = null) {
    try {
      const { AppSetting } = require('../models');
      const row = await AppSetting.findOne({ where: { key } });
      return row ? row.value : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // OLT SNMP POLLING — BARU
  // ═══════════════════════════════════════════════════════════════════

  async _pollOltSNMP() {
    // Load konfigurasi OLT dari file (community/password di-decrypt otomatis).
    // Legacy plaintext files still load fine; ConfigCrypto falls through.
    let configs = [];
    try {
      if (!fs.existsSync(OLT_CONFIG_PATH)) return; // tidak ada OLT yang dikonfigurasi
      configs = ConfigCrypto.load(OLT_CONFIG_PATH, []);
    } catch(e) {
      logger.error('[Cron:OltSNMP] Gagal load olt_config.json: ' + (e.message || e));
      return;
    }

    // Filter OLT yang enabled
    const activeOlts = configs.filter(c => c.enabled !== false);
    if (!activeOlts.length) return;

    logger.debug(`[Cron:OltSNMP] Polling ${activeOlts.length} OLT(s)...`);

    // Jalankan semua OLT secara paralel (max 3 sekaligus)
    const chunks = [];
    for (let i = 0; i < activeOlts.length; i += 3) {
      chunks.push(activeOlts.slice(i, i + 3));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map(cfg => this._syncOneOlt(cfg, configs))
      );
    }
  }

  async _syncOneOlt(cfg, allConfigs) {
    try {
      const OltController = require('../controllers/OltController');
      const cfgIdx = allConfigs.findIndex(c => c.id === cfg.id);
      const result = await OltController._doSync(cfg, cfgIdx, allConfigs);
      logger.info(`[Cron:OltSNMP] ${cfg.name}: ${result.total} ONT, ${result.offline} offline, ${result.elapsed}s`);
    } catch (err) {
      // Update lastError di config file
      try {
        const configs = JSON.parse(fs.readFileSync(OLT_CONFIG_PATH, 'utf8'));
        const idx = configs.findIndex(c => c.id === cfg.id);
        if (idx >= 0) {
          configs[idx].lastError = err.message;
          fs.writeFileSync(OLT_CONFIG_PATH, JSON.stringify(configs, null, 2), 'utf8');
        }
      } catch(e2) { /* silent */ }
      logger.error(`[Cron:OltSNMP] Error sync ${cfg.name}: ` + (err.message || err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GENIEACS POLLING (tidak berubah)
  // ═══════════════════════════════════════════════════════════════════

  async _pollGenieACS() {
    try {
      const GenieACSService = require('./GenieACSService');
      const health = await GenieACSService.healthCheck();
      if (!health.connected) {
        logger.debug(`[Cron:GenieACS] Tidak terhubung: ${health.error || health.url}`);
        return;
      }
      const OntController = require('../controllers/OntController');
      const result = await OntController._performSync(this.io);
      logger.info(`[Cron:GenieACS] Sync selesai: ${result.synced} ONT, ${result.offline_detected} offline`);
    } catch (err) {
      logger.error('[Cron:GenieACS] Error: ' + (err.message || err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // QUEUE HISTORY (tidak berubah)
  // ═══════════════════════════════════════════════════════════════════

  async _pollQueueHistory() {
    try {
      // Pakai resolver berbasis DB (is_primary → router aktif pertama → env)
      // supaya konsisten dengan endpoint /mikrotik/customer-traffic. Sebelumnya
      // pakai getMikrotikInstance() singleton (env-only) — kalau router
      // dikonfigurasi di tabel `devices` dan bukan di .env, polling nge-target
      // host yang salah / kosong, sehingga QueueHistory tidak pernah terisi dan
      // grafik Traffic History di profil pelanggan selalu kosong.
      const { getMikrotikInstanceByDevice } = require('./MikrotikService');
      const mt = await getMikrotikInstanceByDevice(null);
      if (!mt) return;
      const queues = await mt.getQueueStats();
      if (!queues?.length) return;
      const now = new Date();
      const records = queues.map(q => ({
        queue_id:    q.id,
        queue_name:  q.name || '',
        rx_rate:     parseInt(q.rateIn)   || 0,
        tx_rate:     parseInt(q.rateOut)  || 0,
        rx_bytes:    parseInt(q.bytesIn)  || 0,
        tx_bytes:    parseInt(q.bytesOut) || 0,
        recorded_at: now
      }));
      await QueueHistory.bulkCreate(records, { ignoreDuplicates: true });
    } catch (e) {
      if (!e.message?.includes('not configured') && !e.message?.includes('ECONNREFUSED')) {
        logger.error('[Cron:QueueHistory] Error: ' + (e.message || e));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // AUTO ISOLIR & DAILY ALERTS (tidak berubah)
  // ═══════════════════════════════════════════════════════════════════

  async _runAutoIsolir() {
    try {
      const IsolirSvc = require('./IsolirService');
      const { AppSetting } = require('../models');
      const setting = await AppSetting.findOne({ where: { key: 'isolir_auto_enable' } }).catch(() => null);
      if (setting?.value !== '1') return;

      // Hormati jam auto-isolir bila dikonfigurasi (0-23). Kosong / '-1' = setiap jam.
      // Jam dihitung di timezone aplikasi (Asia/Jakarta), BUKAN waktu server,
      // supaya "Jam 08:00" yang diset admin = 08:00 WIB walau VPS pakai UTC.
      const hourRow = await AppSetting.findOne({ where: { key: 'isolir_auto_hour' } }).catch(() => null);
      const cfgHour = hourRow && hourRow.value !== '' ? parseInt(hourRow.value, 10) : -1;
      if (!isNaN(cfgHour) && cfgHour >= 0 && cfgHour <= 23) {
        const nowHour = parseInt(nowInTz(APP_TZ).hhmm.split(':')[0], 10);
        if (nowHour !== cfgHour) return; // belum jamnya (WIB)
      }

      const result = await IsolirSvc.runAutoIsolir();
      if (result.isolated > 0) logger.info('[Cron:AutoIsolir]', result);
    } catch (e) {
      logger.error('[Cron:AutoIsolir] Error: ' + (e.message || e));
    }
  }

  // ── Laporan Keuangan via Email — pemeriksaan jadwal otomatis ──
  // Dipanggil tiap jam. Kirim laporan bila: enabled, jam cocok, dan belum
  // dikirim pada slot periode ini (harian/mingguan/bulanan). Idempotent.
  async _runFinanceReportSchedule() {
    const { AppSetting } = require('../models');
    const { Op } = require('sequelize');
    const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'finrep_%' } } });
    const cfg = {}; rows.forEach(r => { cfg[r.key] = r.value; });
    if (cfg.finrep_enabled !== '1') return;

    const recipients = String(cfg.finrep_recipients || '').trim();
    if (!recipients) return;

    const freq = cfg.finrep_frequency || 'monthly';
    const targetHour = parseInt(cfg.finrep_hour) || 7;
    const now = new Date();
    if (now.getHours() !== targetHour) return;       // belum jamnya

    // Tentukan kunci slot agar tidak dobel kirim dalam satu periode.
    let slotKey;
    if (freq === 'daily') {
      slotKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    } else if (freq === 'weekly') {
      if (now.getDay() !== 1) return;                // mingguan = tiap Senin
      slotKey = `${now.getFullYear()}-W${this._weekNumber(now)}`;
    } else { // monthly
      if (now.getDate() !== 1) return;               // bulanan = tanggal 1
      slotKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
    }
    if (cfg.finrep_last_slot === slotKey) return;     // sudah dikirim slot ini

    // Periode laporan: bulanan/mingguan/harian → laporan bulan berjalan
    // (atau bulan sebelumnya bila dikirim tanggal 1 untuk bulanan).
    let month = now.getMonth() + 1, year = now.getFullYear();
    if (freq === 'monthly') {
      // tanggal 1 → laporkan bulan SEBELUMNYA (yang baru selesai)
      const prev = new Date(year, now.getMonth() - 1, 1);
      month = prev.getMonth() + 1; year = prev.getFullYear();
    }

    try {
      const Svc = require('./FinanceEmailReportService');
      const result = await Svc.sendReport({ to: recipients, period: 'month', month, year });
      // tandai sudah terkirim untuk slot ini (meski sebagian gagal, agar tak spam).
      await AppSetting.upsert({ key: 'finrep_last_slot', value: slotKey, type: 'string' });
      await AppSetting.upsert({ key: 'finrep_last_sent', value: now.toISOString(), type: 'string' });
      logger.info(`[Cron:FinanceReport] Laporan ${freq} terkirim (${result.ok ? 'ok' : 'sebagian gagal'}) ke ${recipients}`);
    } catch (e) {
      logger.error('[Cron:FinanceReport] gagal: ' + (e.message || e));
    }
  }

  // ── Cleanup log email lama — retensi tabel email_logs ──
  // Hapus log final (sent/failed) lebih lama dari N hari. Baris 'retrying'
  // dibiarkan (masih dalam proses). Default 90 hari, override via app_settings.
  async _runEmailLogCleanup() {
    const { EmailLog, AppSetting } = require('../models');
    const { Op } = require('sequelize');
    if (!EmailLog) return 0;
    let days = 90;
    try {
      const row = await AppSetting.findOne({ where: { key: 'email_log_retention_days' } });
      const v = parseInt(row && row.value);
      if (Number.isFinite(v) && v > 0) days = Math.min(3650, v);
    } catch (_) { /* pakai default */ }
    const cutoff = new Date(Date.now() - days * 86400000);
    return EmailLog.destroy({
      where: {
        sent_at: { [Op.lt]: cutoff },
        status: { [Op.in]: ['sent', 'failed'] }
      }
    });
  }

  // ── Email Digest Harian — pemeriksaan jadwal otomatis ──
  // Dipanggil tiap jam. Kirim "pulse harian" operasional bila: enabled, jam
  // cocok, dan belum dikirim hari ini. Idempotent (slot harian).
  async _runDailyDigestSchedule() {
    const { AppSetting } = require('../models');
    const { Op } = require('sequelize');
    const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'digest_%' } } });
    const cfg = {}; rows.forEach(r => { cfg[r.key] = r.value; });
    if (cfg.digest_enabled !== '1') return;

    const recipients = String(cfg.digest_recipients || '').trim();
    if (!recipients) return;

    const targetHour = parseInt(cfg.digest_hour) || 7;
    const now = new Date();
    if (now.getHours() !== targetHour) return;       // belum jamnya

    const slotKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (cfg.digest_last_slot === slotKey) return;    // sudah dikirim hari ini

    try {
      const Svc = require('./DailyDigestService');
      const result = await Svc.sendDigest({ to: recipients });
      await AppSetting.upsert({ key: 'digest_last_slot', value: slotKey, type: 'string' });
      await AppSetting.upsert({ key: 'digest_last_sent', value: now.toISOString(), type: 'string' });
      logger.info(`[Cron:DailyDigest] Ringkasan harian terkirim (${result.ok ? 'ok' : 'sebagian gagal'}) ke ${recipients}`);
    } catch (e) {
      logger.error('[Cron:DailyDigest] gagal: ' + (e.message || e));
    }
  }

  _weekNumber(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  }

  _runDailyAlerts() {
    try {
      const NotifSvc = require('./NotificationService');
      NotifSvc.checkDailyAlerts();
    } catch (e) {
      logger.error('[Cron:DailyAlerts] Error: ' + (e.message || e));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // WA REMINDER (tidak berubah)
  // ═══════════════════════════════════════════════════════════════════

  // Best-effort pemberitahuan saat WA session putus tepat di jam kirim reminder.
  // WA tidak bisa dipakai (channel-nya yang down), jadi: log warning + (kalau
  // Telegram dikonfigurasi) kirim alert ke Telegram. Di-throttle agar tidak
  // spam tiap kali (cukup sekali tahu).
  async _notifyReminderSessionDown(rm, sendTime) {
    try {
      const TelegramService = require('./TelegramService');
      if (TelegramService && typeof TelegramService.sendMessage === 'function') {
        // sendMessage() otomatis no-op kalau Telegram belum dikonfigurasi.
        await TelegramService.sendMessage(
          `⚠️ Reminder WA gagal terkirim: WA session tidak terhubung pada jam ${sendTime} ` +
          `(reminder ${rm.type}, offset ${rm.days_offset}). Hubungkan WA lalu kirim manual via /wa/reminder.`
        );
      }
    } catch (_) { /* Telegram opsional; abaikan kalau tidak ada */ }
  }

  async _runReminderScheduler() {
    try {
      const { ReminderSetting, WaTemplate, WaSession, sequelize } = require('../models');
      const GatewayService = require('./GatewayService');

      // Verifikasi status SECARA LIVE (bukan sekadar kolom DB yang bisa basi).
      // Ini menutup celah: cron jalan tanpa ada yang membuka halaman WA, jadi
      // status DB tak pernah tersegarkan → dulu skip padahal WAHA WORKING.
      const session = await GatewayService.getVerifiedSendingSession();
      const sessionConnected = !!session;

      const allRm      = await ReminderSetting.findAll({ where: { is_active: true } });
      const activeTpls = await WaTemplate.findAll({ where: { is_active: true } });
      const tplMap     = {};
      activeTpls.forEach(t => { tplMap[t.id] = t; });
      const reminders  = allRm
        .filter(r => r.template_id && tplMap[r.template_id])
        .map(r => { r.template = tplMap[r.template_id]; return r; });
      if (!reminders.length) return;

      // Waktu & tanggal dihitung di timezone aplikasi (bukan waktu server).
      const tznow   = nowInTz(APP_TZ);
      const nowTime = tznow.hhmm;        // 'HH:mm' di APP_TZ
      const today   = tznow.date;        // 'YYYY-MM-DD' di APP_TZ
      const MONTHS  = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

      // Pre-fetch company name sekali untuk seluruh batch ini
      let companyName = process.env.COMPANY_NAME || 'Internet Service';
      try {
        const { AppSetting } = require('../models');
        const row = await AppSetting.findOne({ where: { key: 'company_name' } });
        if (row?.value) companyName = row.value;
      } catch(_) { /* fallback ke env */ }

      for (const rm of reminders) {
        const sendTime = (rm.send_time || '08:00:00').substring(0, 5);
        if (sendTime !== nowTime) continue;

        // Jam kirim tiba TAPI WA session putus → jangan biarkan batch WA hilang
        // diam-diam. Catat warning + (best-effort) alert ke admin. CATATAN:
        // email reminder TETAP dikirim di bawah meski WA putus (justru berguna
        // untuk pelanggan yang emailnya aktif tapi WA gagal).
        if (!sessionConnected) {
          logger.warn(`[Cron:Reminder] WA SKIP type=${rm.type} offset=${rm.days_offset}: WA session tidak terhubung pada jam kirim ${sendTime}`);
          try { await this._notifyReminderSessionDown(rm, sendTime); } catch (_) {}
        }

        let targetDate;
        if (rm.type === 'before')   targetDate = dateInTzOffset(APP_TZ, Math.abs(rm.days_offset));
        else if (rm.type === 'due') targetDate = today;
        else                        targetDate = dateInTzOffset(APP_TZ, -Math.abs(rm.days_offset));

        // Query lengkap — SELECT semua field yang dipakai placeholder.
        // Sebelumnya hanya 6 field; sekarang termasuk invoice_number, total,
        // period_month, period_year, status — supaya placeholder {invoice},
        // {periode}, {jumlah}, {status} bisa di-replace dengan benar.
        const targets = await sequelize.query(
          `SELECT DISTINCT c.id, c.name, c.phone, c.email, c.address, c.customer_id AS cid,
                  c.public_link_token,
                  pkg.name AS paket, pkg.price AS harga,
                  i.id AS invoice_id, i.invoice_number, i.due_date,
                  i.total AS jumlah, i.status AS inv_status,
                  i.period_month, i.period_year
           FROM customers c
           LEFT JOIN packages pkg ON pkg.id = c.package_id
           JOIN invoices i ON i.customer_id = c.id
           WHERE i.due_date = :dt AND i.status IN ('unpaid','overdue')
             AND c.status != 'inactive'
             AND ( (c.phone IS NOT NULL AND c.phone != '') OR (c.email IS NOT NULL AND c.email != '') )`,
          { replacements: { dt: targetDate }, type: sequelize.QueryTypes.SELECT }
        );
        if (!targets.length) continue;

        const { ReminderLog } = require('../models');
        const EmailService = require('./EmailService');
        // Cek apakah email reminder diaktifkan (default mengikuti SMTP aktif)
        let emailReminderOn = false;
        try {
          const { AppSetting } = require('../models');
          const erow = await AppSetting.findOne({ where: { key: 'email_reminder_enabled' } });
          const srow = await AppSetting.findOne({ where: { key: 'smtp_enabled' } });
          emailReminderOn = (erow ? erow.value === '1' : false) && (srow ? srow.value === '1' : false);
        } catch (_) {}

        let sent = 0, failed = 0, skipped = 0, emailSent = 0, emailFailed = 0;
        const raw = rm.template.content || rm.template.message || '';
        const fmtRp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

        for (const cust of targets) {
          const periodeStr = cust.period_month
            ? (MONTHS[cust.period_month] || cust.period_month) + ' ' + (cust.period_year || '')
            : '-';
          const dueDateStr = moment(cust.due_date).format('D MMMM YYYY');
          const { buildInvoiceLink, buildCustomerLink } = require('../utils/templateHelper');
          const linkInvoice = cust.invoice_id ? buildInvoiceLink(cust.invoice_id) : '';
          const linkPermanen = cust.public_link_token ? buildCustomerLink(cust.public_link_token) : '';
          const vars = {
            '{nama}':            cust.name || '',
            '{nohp}':            cust.phone || '',
            '{phone}':           cust.phone || '',
            '{alamat}':          cust.address || '-',
            '{invoice}':         cust.invoice_number || '-',
            '{paket}':           cust.paket || '–',
            '{periode}':         periodeStr,
            '{jumlah}':          fmtRp(cust.jumlah || 0),
            '{harga}':           fmtRp(cust.harga  || 0),
            '{jatuh_tempo}':     dueDateStr,
            '{tgl_jatuh_tempo}': dueDateStr,
            '{duedate}':         moment(cust.due_date).format('DD/MM/YYYY'),
            '{status}':          cust.inv_status === 'overdue' ? '⚠️ JATUH TEMPO' : 'segera jatuh tempo',
            '{perusahaan}':      companyName,
            '{cid}':             cust.cid || '',
            '{link_invoice}':        linkInvoice,
            '{link_bayar_permanen}': linkPermanen,
            '{link_permanen}':       linkPermanen,
          };
          const msg = Object.keys(vars).reduce((acc, k) => acc.split(k).join(vars[k]), raw);

          // ── KANAL 1: WhatsApp (hanya kalau session terhubung & ada nomor) ──
          if (sessionConnected && cust.phone) {
            let logRow, created;
            try {
              [logRow, created] = await ReminderLog.findOrCreate({
                where: { reminder_id: rm.id, invoice_id: cust.invoice_id, send_date: targetDate, reminder_type: rm.type },
                defaults: {
                  reminder_id: rm.id, invoice_id: cust.invoice_id, customer_id: cust.id,
                  send_date: targetDate, reminder_type: rm.type, phone: cust.phone, status: 'sent'
                }
              });
            } catch (dupErr) { logRow = null; created = false; }
            if (created) {
              try {
                await GatewayService.sendMessage(session.session_id, cust.phone, msg, null);
                sent++;
                await new Promise(r => setTimeout(r, 600));
              } catch(e) {
                failed++;
                try { await logRow.update({ status: 'failed', error_message: String(e.message || e).slice(0, 255) }); } catch (_) {}
              }
            } else { skipped++; }
          }

          // ── KANAL 2: Email (paralel, dedup terpisah; jalan walau WA down) ──
          if (emailReminderOn && cust.email) {
            let eLog, eCreated;
            try {
              [eLog, eCreated] = await ReminderLog.findOrCreate({
                where: { reminder_id: rm.id, invoice_id: cust.invoice_id, send_date: targetDate, reminder_type: rm.type + '_email' },
                defaults: {
                  reminder_id: rm.id, invoice_id: cust.invoice_id, customer_id: cust.id,
                  send_date: targetDate, reminder_type: rm.type + '_email', phone: cust.email, status: 'sent'
                }
              });
            } catch (dupErr) { eLog = null; eCreated = false; }
            if (eCreated) {
              try {
                // Kirim memakai template "Notifikasi Tagihan Jatuh Tempo" (invoice_overdue)
                // dari halaman Email Template, agar isi/subject bisa dikustom user.
                // Fallback ke layout bawaan bila template nonaktif/gagal.
                let mail = null;
                try {
                  const EmailTpl = require('./EmailTemplateService');
                  if (await EmailTpl.isEnabled('invoice_overdue')) {
                    const tplVars = {
                      nama: cust.name || 'Pelanggan',
                      invoice: cust.invoice_number || '',
                      periode: periodeStr || '',
                      jumlah: fmtRp(cust.jumlah || 0),
                      jatuh_tempo: dueDateStr || '',
                      paket: cust.paket || '-',
                      perusahaan: companyName
                    };
                    const detailRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:10px;overflow:hidden;font-size:13px;">
                        <tr><td style="padding:9px 14px;color:#6b7fa8;">No. Invoice</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;">${EmailTpl.escapeHtml(tplVars.invoice)}</td></tr>
                        <tr style="background:#f8faff;"><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Paket</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(tplVars.paket)}</td></tr>
                        <tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Periode</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(tplVars.periode)}</td></tr>
                        <tr style="background:#f8faff;"><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Jumlah</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(tplVars.jumlah)}</td></tr>
                        <tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Jatuh Tempo</td><td align="right" style="padding:9px 14px;font-weight:700;color:#e08a00;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(tplVars.jatuh_tempo)}</td></tr>
                      </table>`;
                    mail = await EmailTpl.render('invoice_overdue', tplVars, {
                      companyName,
                      bodyExtraHtml: detailRows,
                      buttonUrl: linkInvoice || ''
                    });
                  }
                } catch (tplErr) {
                  logger.warn('[Cron:Reminder] template invoice_overdue gagal, fallback: ' + (tplErr.message || tplErr));
                }

                let ok;
                if (mail) {
                  ok = await EmailService.send({ to: cust.email, subject: mail.subject, html: mail.html, text: mail.text, type: 'invoice_overdue' });
                } else {
                  // Fallback: layout bawaan (perilaku lama, tetap jalan bila template nonaktif).
                  const subjPrefix = cust.inv_status === 'overdue' ? 'Tagihan Jatuh Tempo' : 'Pengingat Tagihan';
                  ok = await EmailService.send({
                    to: cust.email,
                    type: 'invoice_overdue',
                    subject: `${subjPrefix} ${cust.invoice_number || ''} — ${companyName}`,
                    html: this._buildReminderEmailHtml({ cust, vars, companyName, linkInvoice, linkPermanen, periodeStr, dueDateStr, fmtRp }),
                    text: msg.replace(/[*_~`]/g, '')
                  });
                }
                if (ok) emailSent++; else { emailFailed++; try { await eLog.update({ status:'failed', error_message:'Email gagal terkirim (SMTP)' }); } catch(_){} }
              } catch(e) {
                emailFailed++;
                try { await eLog.update({ status: 'failed', error_message: String(e.message || e).slice(0,255) }); } catch (_) {}
              }
            }
          }
        }
        logger.info(`[Cron:Reminder] type=${rm.type} offset=${rm.days_offset} target=${targetDate}: WA ${sent} sent/${failed} failed/${skipped} dedup · Email ${emailSent} sent/${emailFailed} failed`);
      }
    } catch(e) {
      logger.error('[Cron:Reminder] Error: ' + (e.message || e));
    }
  }

  // Bangun HTML email reminder yang rapi (dipakai _runReminderScheduler).
  _buildReminderEmailHtml({ cust, companyName, periodeStr, dueDateStr, fmtRp, linkInvoice }) {
    const overdue = cust.inv_status === 'overdue';
    const accent = overdue ? '#dc2626' : '#1d4ed8';
    const statusTxt = overdue ? 'Tagihan Anda telah melewati jatuh tempo' : 'Tagihan Anda akan segera jatuh tempo';
    const payBtn = linkInvoice
      ? `<a href="${linkInvoice}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;font-size:14px;">Lihat & Bayar Tagihan</a>`
      : '';
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;background:#f8faff;padding:24px;">
      <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e8eef7;">
        <div style="background:${accent};padding:20px 24px;">
          <div style="color:#fff;font-size:18px;font-weight:800;">${companyName}</div>
          <div style="color:rgba(255,255,255,.85);font-size:13px;margin-top:2px;">${statusTxt}</div>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 14px;color:#0f172a;font-size:14px;">Halo <b>${cust.name || 'Pelanggan'}</b>,</p>
          <p style="margin:0 0 18px;color:#475569;font-size:13.5px;line-height:1.6;">Berikut rincian tagihan layanan internet Anda:</p>
          <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
            <tr><td style="padding:8px 0;color:#64748b;">No. Invoice</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;">${cust.invoice_number || '-'}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Customer ID</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${cust.cid || '-'}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Paket</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${cust.paket || '-'}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Periode</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${periodeStr}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Jatuh Tempo</td><td style="padding:8px 0;text-align:right;font-weight:700;color:${accent};border-top:1px solid #eef2f9;">${dueDateStr}</td></tr>
          </table>
          <div style="margin:18px 0;padding:16px;background:#f1f5f9;border-radius:10px;text-align:center;">
            <div style="font-size:12px;color:#64748b;">Total Tagihan</div>
            <div style="font-size:26px;font-weight:800;color:${accent};margin-top:2px;">${fmtRp(cust.jumlah || 0)}</div>
          </div>
          ${payBtn ? `<div style="text-align:center;margin:18px 0;">${payBtn}</div>` : ''}
          <p style="margin:18px 0 0;color:#94a3b8;font-size:11.5px;line-height:1.6;text-align:center;">Email ini dikirim otomatis oleh sistem ${companyName}. Abaikan jika Anda sudah melakukan pembayaran.</p>
        </div>
      </div>
    </div>`;
  }



  async _runReportScheduler() {
    // Cegah dua tick cron berjalan bersamaan (pengiriman lambat: banyak nomor ×
    // jeda 1 dtk bisa melewati batas 1 menit). Tanpa ini, tick berikutnya bisa
    // mulai sebelum yang ini selesai → potensi dobel kirim.
    if (this._reportRunning) return;
    this._reportRunning = true;
    try {
      const { AppSetting, WaSession, sequelize } = require('../models');
      const GatewayService = require('./GatewayService');

      const session = await GatewayService.getDefaultSendingSession();
      if (!session) return;
      await GatewayService.warmSession(session.session_id);
      if (!GatewayService.isConnected(session.session_id)) return;

      const getSet = async (key, def = '') => {
        const r = await AppSetting.findOne({ where: { key } });
        return r ? (r.value || def) : def;
      };

      const phones    = JSON.parse(await getSet('admin_notify_phones', '[]'));
      if (!phones.length) return;

      const schedules = JSON.parse(await getSet('report_schedules', '{}'));
      const sections  = JSON.parse(await getSet('report_sections',  '{}'));

      // Waktu & tanggal DIHITUNG DI TIMEZONE APLIKASI (bukan waktu server).
      // Tanpa ini, di server UTC jadwal "08:00" (maksudnya WIB) akan menembak
      // jam 08:00 UTC = 15:00 WIB — laporan terkirim di jam yang salah / seolah
      // tidak terkirim. Pola ini sama dengan _runReminderScheduler.
      const tznow    = nowInTz(APP_TZ);
      const nowTime  = tznow.hhmm;                // 'HH:mm' di APP_TZ
      const nowDate2 = tznow.date;                // 'YYYY-MM-DD' di APP_TZ
      const mtz      = moment(nowDate2, 'YYYY-MM-DD');
      const nowDay   = mtz.isoWeekday();          // 1=Senin … 7=Minggu (APP_TZ)
      const nowDate  = mtz.date();                // tanggal 1..31 (APP_TZ)

      // Guard idempotensi: tiap schedule kirim maksimal 1× per tanggal jatuhnya,
      // walau menit cocok lebih dari sekali (tick overlap / retry).
      let lastMap = {};
      try { lastMap = JSON.parse(await getSet('report_sched_last', '{}')) || {}; } catch(_) { lastMap = {}; }
      let lastMapDirty = false;

      const now = mtz.clone();
      const PERIODS = {
        this_week:  { from: now.clone().startOf('isoWeek').format('YYYY-MM-DD'),                    to: now.format('YYYY-MM-DD'),                                             label: 'Minggu Ini'        },
        last_week:  { from: now.clone().subtract(1,'week').startOf('isoWeek').format('YYYY-MM-DD'), to: now.clone().subtract(1,'week').endOf('isoWeek').format('YYYY-MM-DD'),  label: 'Minggu Lalu'       },
        this_month: { from: now.clone().startOf('month').format('YYYY-MM-DD'),                      to: now.format('YYYY-MM-DD'),                                             label: now.format('MMMM YYYY') },
        last_month: { from: now.clone().subtract(1,'month').startOf('month').format('YYYY-MM-DD'),  to: now.clone().subtract(1,'month').endOf('month').format('YYYY-MM-DD'),   label: now.clone().subtract(1,'month').format('MMMM YYYY') }
      };

      for (const [pk, sched] of Object.entries(schedules)) {
        if (!sched.enabled) continue;
        const sendTime = (sched.time || '08:00').substring(0, 5);
        if (sendTime !== nowTime) continue;
        if (sched.freq === 'weekly'  && nowDay  !== parseInt(sched.day || 1)) continue;
        if (sched.freq === 'monthly' && nowDate !== parseInt(sched.day || 1)) continue;
        const period = PERIODS[pk];
        if (!period) continue;

        // Sudah terkirim utk tanggal ini? (idempotensi) → lewati.
        if (lastMap[pk] === nowDate2) {
          logger.info(`[Cron:Report] ${pk} sudah terkirim utk ${nowDate2}, dilewati`);
          continue;
        }

        const appName = await getCompanyName();
        // Hormati custom template bila ada — SAMA dgn Preview & "Kirim Sekarang".
        // Sebelumnya cron selalu memakai format bawaan sehingga hasil terjadwal
        // berbeda dari yang di-preview admin (mengabaikan template kustom).
        let msg;
        try {
          const customTpl = (await getSet('report_template', '')).trim();
          if (customTpl) {
            const WaFeatures = require('../controllers/WaFeaturesController');
            const data = await WaFeatures.buildReportData(period.from, period.to);
            msg = WaFeatures.renderCustomTemplate(customTpl, data, appName, 'Laporan ' + period.label);
          }
        } catch (e) {
          logger.warn('[Cron:Report] custom template gagal, pakai format bawaan: ' + (e.message || e));
        }
        if (!msg) {
          msg = await buildReportMessage(sequelize, period.from, period.to, appName, 'Laporan ' + period.label, sections);
        }

        let sent = 0;
        for (const phone of phones) {
          try { await GatewayService.sendMessage(session.session_id, phone, msg, null); sent++; } catch(e) {}
          if (phones.length > 1) await new Promise(r => setTimeout(r, 1000));
        }
        // Tandai terkirim utk tanggal ini SEBELUM lanjut, supaya tidak dobel.
        lastMap[pk] = nowDate2;
        lastMapDirty = true;
        await AppSetting.upsert({ key: 'report_last_sent', value: new Date().toISOString(), type: 'string' });
        logger.info(`[Cron:Report] ${pk} dikirim ke ${sent} nomor`);
      }

      if (lastMapDirty) {
        try { await AppSetting.upsert({ key: 'report_sched_last', value: JSON.stringify(lastMap), type: 'json' }); } catch(_) {}
      }
    } catch(e) {
      logger.error('[Cron:Report] Error: ' + (e.message || e));
    } finally {
      this._reportRunning = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // BROADCAST (tidak berubah)
  // ═══════════════════════════════════════════════════════════════════

  async _runBroadcastScheduler() {
    try {
      const { WaBroadcast } = require('../models');
      const pending = await WaBroadcast.findAll({
        where: { status: 'scheduled', scheduled_at: { [Op.lte]: new Date() } },
        order: [['scheduled_at', 'ASC']],
        limit: 3
      });
      for (const bc of pending) {
        await bc.update({ status: 'running', started_at: new Date() });
        const BroadcastController = require('../controllers/BroadcastController');
        BroadcastController._runBroadcast(bc.id).catch(e =>
          logger.error(`[Cron:Broadcast] Error bc#${bc.id}: ${e.message}`)
        );
      }
    } catch(e) {
      logger.error('[Cron:Broadcast] Error: ' + (e.message || e));
    }
  }

  // ── Email Broadcast Scheduler ──────────────────────────────────────
  // Jalankan broadcast email berstatus 'scheduled' yang sudah lewat
  // jadwal. Limit 2 per tick — engine email sudah throttled per pesan,
  // tidak perlu banyak broadcast paralel.
  async _runEmailBroadcastScheduler() {
    try {
      const { EmailBroadcast } = require('../models');
      if (!EmailBroadcast) return;
      const pending = await EmailBroadcast.findAll({
        where: { status: 'scheduled', scheduled_at: { [Op.lte]: new Date() } },
        order: [['scheduled_at', 'ASC']],
        limit: 2
      });
      for (const bc of pending) {
        await bc.update({ status: 'running', started_at: new Date() });
        const EmailBroadcastController = require('../controllers/EmailBroadcastController');
        EmailBroadcastController._runBroadcast(bc.id).catch(e =>
          logger.error(`[Cron:EmailBC] Error bc#${bc.id}: ${e.message}`)
        );
      }
    } catch(e) {
      logger.error('[Cron:EmailBC] Error: ' + (e.message || e));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEVICE TRAFFIC POLLING — via MikroTik API
  // ═══════════════════════════════════════════════════════════════════
  // Polling traffic tiap 1 menit untuk device router/OLT dengan monitoring API.
  // Data disimpan ke traffic_data supaya chart bandwidth trends di dashboard terisi.
  //
  // Throttling: paralel max 3 device sekaligus (supaya tidak overload DB/network).
  // Kalau device offline / timeout, skip tanpa error.
  async _pollDeviceTraffic() {
    try {
      const { Device } = require('../models');
      const { MikrotikService } = require('./MikrotikService');

      // Ambil semua device aktif yang PUNYA kredensial API MikroTik.
      // Tidak lagi mensyaratkan monitoring_type='api' — banyak device dipakai
      // via API walau monitoring_type masih default 'snmp'. Cukup ada
      // api_username + tipe router/olt. Ini yang mengisi traffic_data untuk
      // Bandwidth Trends di dashboard.
      const devices = await Device.findAll({
        where: {
          is_active: true,
          type: { [Op.in]: ['router', 'olt'] },
          api_username: { [Op.ne]: null }
        },
        attributes: ['id','name','ip_address','api_port','api_username','api_password','api_protocol']
      });

      if (!devices.length) return;

      // Batch processing — paralel max 3
      const batchSize = 3;
      for (let i = 0; i < devices.length; i += batchSize) {
        const batch = devices.slice(i, i + batchSize);
        await Promise.all(batch.map(async (device) => {
          try {
            const mt = new MikrotikService({
              host:         device.ip_address,
              port:         device.api_port || 80,
              username:     device.api_username,
              password:     device.api_password || '',
              api_protocol: device.api_protocol || null,
              timeout:      6000
            });

            // Ambil list interface + bulk traffic stats
            const ifaces = await mt.getInterfaces();
            if (!ifaces || !ifaces.length) return;

            // Filter interface yang running + bukan bridge/vlan (hindari double count)
            const running = ifaces.filter(i =>
              i.running && !['bridge','vlan','vrrp'].includes((i.type||'').toLowerCase())
            );
            if (!running.length) return;

            const stats = await mt.getInterfacesBulkStats(running.map(i => i.name));
            const statsByName = {};
            stats.forEach(s => { statsByName[s.name] = s; });

            // Insert 1 row per interface ke traffic_data
            const now = new Date();
            const rows = running.map(i => ({
              device_id: device.id,
              interface_name: i.name,
              rx_bytes: i.rxByte || 0,
              tx_bytes: i.txByte || 0,
              rx_rate: statsByName[i.name]?.rxBitsPerSecond || 0,
              tx_rate: statsByName[i.name]?.txBitsPerSecond || 0,
              recorded_at: now
            }));

            if (rows.length) await TrafficData.bulkCreate(rows);
          } catch (e) {
            // Silent — device unreachable itu normal
          }
        }));
      }
    } catch (err) {
      logger.error('[Cron:DeviceTraffic] ' + (err.message || err));
    }
  }

  // ── Telegram Monitoring: jadwalkan / jadwalkan ulang ────────────────
  // Baca telegram_interval (menit) dari app_settings, lalu (re)start job.
  // Aman dipanggil kapan saja — job lama distop sebelum bikin yang baru.
  async _scheduleTelegramMonitoring() {
    let menit = 3;
    try {
      const { AppSetting } = require('../models');
      const row = await AppSetting.findOne({ where: { key: 'telegram_interval' } });
      const v = parseInt(row?.value, 10);
      if ([1, 2, 3, 5, 10].includes(v)) menit = v;
    } catch (_) { /* default 3 */ }

    // Stop job lama kalau ada
    if (this._tgJob) {
      try { this._tgJob.stop(); } catch (_) {}
      this.jobs = this.jobs.filter(j => j !== this._tgJob);
      this._tgJob = null;
    }

    const expr = menit === 1 ? '* * * * *' : `*/${menit} * * * *`;
    this._tgJob = cron.schedule(expr, async () => {
      try {
        await require('./MonitoringService').runChecks();
      } catch (e) {
        logger.error('[Cron:TelegramMonitoring] ' + (e.message || e));
      }
    });
    this.jobs.push(this._tgJob);
    this._tgInterval = menit;
    logger.info(`[Cron:TelegramMonitoring] interval = ${menit} menit (${expr})`);
  }

  // Dipanggil dari API setelah user menyimpan setting interval.
  async rescheduleTelegramMonitoring() {
    await this._scheduleTelegramMonitoring();
    return this._tgInterval;
  }

  // ── Stop semua jobs ─────────────────────────────────────────────────
  stop() {
    this.jobs.forEach(job => job.stop());
    this.jobs = [];
    logger.info('[CronService] All jobs stopped');
  }
}

// ─── Helper: Build Report Message ──────────────────────────────────────────
async function buildReportMessage(sequelize, dateFrom, dateTo, appName, label, sections) {
  function fmtRp(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }

  const [[aktif]]   = await sequelize.query("SELECT COUNT(*) AS cnt, COALESCE(SUM(p.price),0) AS total_harga FROM customers c LEFT JOIN packages p ON p.id=c.package_id WHERE c.status='active'");
  const [[bayar]]   = await sequelize.query("SELECT COUNT(*) AS cnt, COALESCE(SUM(py.amount),0) AS total FROM payments py WHERE py.payment_date BETWEEN ? AND ?", { replacements: [dateFrom, dateTo] });
  const methods     = await sequelize.query("SELECT py.payment_method AS method, COUNT(*) AS cnt, COALESCE(SUM(py.amount),0) AS total FROM payments py WHERE py.payment_date BETWEEN ? AND ? GROUP BY py.payment_method ORDER BY total DESC", { replacements: [dateFrom, dateTo], type: sequelize.QueryTypes.SELECT });
  const topPayers   = await sequelize.query("SELECT c.name, c.customer_id AS cid, SUM(py.amount) AS total FROM payments py JOIN invoices i ON py.invoice_id=i.id JOIN customers c ON c.id=i.customer_id WHERE py.payment_date BETWEEN ? AND ? GROUP BY i.customer_id ORDER BY total DESC LIMIT 5", { replacements: [dateFrom, dateTo], type: sequelize.QueryTypes.SELECT });
  const today       = moment().format('YYYY-MM-DD');
  const in7         = moment().add(7, 'days').format('YYYY-MM-DD');
  const [[dueSoon]] = await sequelize.query("SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total FROM invoices WHERE due_date BETWEEN ? AND ? AND status IN ('unpaid','overdue')", { replacements: [today, in7] });

  const unpaidCnt   = Math.max(0, parseInt(aktif?.cnt || 0) - parseInt(bayar?.cnt || 0));
  const unpaidTotal = Math.max(0, parseFloat(aktif?.total_harga || 0) - parseFloat(bayar?.total || 0));
  const rate        = parseInt(aktif?.cnt || 0) > 0 ? Math.round(parseInt(bayar?.cnt || 0) / parseInt(aktif?.cnt) * 100) : 0;
  const sep         = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const nowStr      = new Date().toLocaleString('id-ID');

  let msg = `📊 *${label}*\n*${appName}*\n`;
  msg += `Periode : *${moment(dateFrom).format('DD/MM/YYYY')} - ${moment(dateTo).format('DD/MM/YYYY')}*\n${sep}`;

  if (sections.summary !== false) {
    msg += `\n\n*RINGKASAN TAGIHAN*\n`;
    msg += `Total Pelanggan Aktif : *${aktif?.cnt || 0} pelanggan*\n`;
    msg += `Total Tagihan         : *${fmtRp(aktif?.total_harga)}*\n\n`;
    msg += `*Tagihan Dibayar*\n`;
    msg += `Transaksi  : *${bayar?.cnt || 0} pembayaran*\n`;
    msg += `Diterima   : *${fmtRp(bayar?.total)}*\n\n`;
    msg += `*Belum Dibayar*\n`;
    msg += `Pelanggan  : *${unpaidCnt} pelanggan*\n`;
    msg += `Estimasi   : *${fmtRp(unpaidTotal)}*`;
  }
  if (sections.rate !== false) {
    msg += `\n\n${sep}\n*Collection Rate*\n${rate}% pelanggan sudah bayar`;
  }
  if (sections.method && methods.length) {
    const grandTotal = methods.reduce((a, m) => a + parseFloat(m.total), 0) || 1;
    const { methodLabel } = require('../utils/paymentMethodLabel');
    msg += `\n\n${sep}\n*Metode Pembayaran*\n`;
    methods.forEach(m => {
      const pct = Math.round(parseFloat(m.total) / grandTotal * 100);
      msg += `• ${methodLabel(m.method)}: ${m.cnt}x — ${fmtRp(m.total)} (${pct}%)\n`;
    });
  }
  if (sections.top && topPayers.length) {
    msg += `\n${sep}\n*Top Pembayar*\n`;
    topPayers.slice(0, 5).forEach((p, i) => { msg += `${i + 1}. ${p.name} (${p.cid}) — ${fmtRp(p.total)}\n`; });
  }
  if (sections.due) {
    msg += `\n${sep}\n*Jatuh Tempo 7 Hari ke Depan*\n ${dueSoon?.cnt || 0} pelanggan — ${fmtRp(dueSoon?.total)}`;
  }
  msg += `\n\n${sep}\n_Dikirim otomatis oleh ${appName}_\n_${nowStr}_`;
  return msg;
}

module.exports = new CronService();