/**
 * PushService.js
 * Hybrid push notification for Customer Portal:
 *  - Web Push (VAPID)   → browser subscribers
 *  - Firebase Cloud Msg → Android APK (Capacitor) subscribers
 *
 * Env vars:
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  (for web push)
 *   FCM_SERVICE_ACCOUNT_PATH  (path to service-account.json for FCM)
 *     OR
 *   FCM_SERVICE_ACCOUNT_JSON  (inline JSON string, for containerized deploys)
 *
 * Either push channel can run independently — if only VAPID is configured,
 * only web subs get sent to; if only FCM is configured, only APK subs.
 * If neither, sendToCustomer() is a no-op that returns {sent:0, failed:0}.
 *
 * Generate VAPID keys once:
 *   node -e "const wp=require('web-push'); console.log(JSON.stringify(wp.generateVAPIDKeys()));"
 *
 * Download FCM service account from:
 *   Firebase Console → Project settings → Service accounts → Generate new private key
 */

const webpush = require('web-push');
const { CustomerPushSubscription, Customer, sequelize } = require('../models');
const { Op } = require('sequelize');
const logger  = require('../utils/logger');

// ── Pengaturan reminder tagihan (dari app_settings) ───────────
// Default dipakai kalau setting belum pernah disimpan admin.
const REMINDER_DEFAULTS = {
  push_reminder_enabled:        '1',
  push_reminder_send_hour:      '8',
  push_reminder_h3_enabled:     '1',
  push_reminder_h1_enabled:     '1',
  push_reminder_h0_enabled:     '1',
  push_reminder_overdue_enabled:'1',
  push_reminder_overdue_hour:   '9',
  push_reminder_h3_title: '⏰ Tagihan 3 Hari Lagi',
  push_reminder_h3_body:  'Tagihan Anda sebesar {jumlah} jatuh tempo {tgl}. Bayar sekarang untuk menghindari isolir.',
  push_reminder_h1_title: '⚠️ Tagihan Besok Jatuh Tempo',
  push_reminder_h1_body:  'Tagihan {jumlah} jatuh tempo besok ({tgl}). Segera bayar!',
  push_reminder_h0_title: '🚨 Tagihan Jatuh Tempo Hari Ini!',
  push_reminder_h0_body:  'Tagihan {jumlah} harus dibayar hari ini untuk menjaga koneksi internet Anda.',
  push_reminder_overdue_title: '🔴 Tagihan Melewati Jatuh Tempo',
  push_reminder_overdue_body:  'Tagihan {jumlah} melewati tanggal jatuh tempo. Bayar sekarang untuk menghindari pemutusan layanan.',
};

async function loadReminderSettings() {
  try {
    const keys = Object.keys(REMINDER_DEFAULTS);
    const rows = await sequelize.query(
      `SELECT \`key\`, value FROM app_settings WHERE \`key\` IN (:keys)`,
      { replacements: { keys }, type: sequelize.QueryTypes.SELECT }
    );
    const cfg = { ...REMINDER_DEFAULTS };
    rows.forEach(r => { if (r.value !== null && r.value !== '') cfg[r.key] = r.value; });
    return cfg;
  } catch (e) {
    logger.warn('[PushService] loadReminderSettings gagal, pakai default: ' + e.message);
    return { ...REMINDER_DEFAULTS };
  }
}

// Ganti placeholder {nama} {jumlah} {tgl} di teks notif.
function fillTemplate(text, vars) {
  return String(text || '')
    .replace(/\{nama\}/g,   vars.nama   || '')
    .replace(/\{jumlah\}/g, vars.jumlah || '')
    .replace(/\{tgl\}/g,    vars.tgl    || '');
}

// ── Setup VAPID (Web Push) ────────────────────────────────────
let _vapidReady = false;
let _fcmReady   = false;
let _fcmAdmin   = null;  // firebase-admin instance, loaded lazily

function init() {
  _initWebPush();
  _initFcm();
  return _vapidReady || _fcmReady;
}

function _initWebPush() {
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:admin@isp.com';

  if (!pub || !priv) {
    logger.warn('[PushService] VAPID keys not set — web push disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env');
    return false;
  }

  try {
    webpush.setVapidDetails(subj, pub, priv);
    _vapidReady = true;
    logger.info('[PushService] VAPID (web push) initialized ✓');
    return true;
  } catch (e) {
    logger.error('[PushService] VAPID init error: ' + e.message);
    return false;
  }
}

function _initFcm() {
  const path = process.env.FCM_SERVICE_ACCOUNT_PATH;
  const json = process.env.FCM_SERVICE_ACCOUNT_JSON;

  if (!path && !json) {
    logger.warn('[PushService] FCM not configured — APK push disabled. Set FCM_SERVICE_ACCOUNT_PATH or FCM_SERVICE_ACCOUNT_JSON in .env to enable.');
    return false;
  }

  try {
    // Require lazily so firebase-admin stays optional at install time.
    // If the package isn't installed yet, log and skip gracefully.
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');

    let credential;
    if (json) {
      credential = admin.credential.cert(JSON.parse(json));
    } else {
      // resolve relative paths from project root
      const resolvedPath = require('path').isAbsolute(path)
        ? path
        : require('path').join(process.cwd(), path);
      credential = admin.credential.cert(require(resolvedPath));
    }

    // Reuse existing default app if already initialized (hot-reload safety)
    if (!admin.apps.length) {
      admin.initializeApp({ credential });
    }
    _fcmAdmin = admin;
    _fcmReady = true;
    logger.info('[PushService] FCM (Firebase Admin) initialized ✓');
    return true;
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && /firebase-admin/.test(e.message)) {
      logger.warn('[PushService] firebase-admin package not installed — run: npm i firebase-admin');
    } else {
      logger.error('[PushService] FCM init error: ' + e.message);
    }
    return false;
  }
}

function isReady() { return _vapidReady || _fcmReady; }
function isWebReady() { return _vapidReady; }
function isFcmReady() { return _fcmReady; }

// ── Build payload objects per channel ─────────────────────────
function _buildWebPayload(payload) {
  return JSON.stringify({
    title:   payload.title   || 'Notifikasi',
    body:    payload.body    || '',
    icon:    payload.icon    || '/img/icon-192.png',
    badge:   payload.badge   || '/img/badge-96.png',
    tag:     payload.tag     || 'default',
    url:     payload.url     || '/portal',
    data:    payload.data    || {},
    timestamp: Date.now()
  });
}

function _buildFcmMessage(token, payload) {
  // FCM payload: notification block (shown by OS) + data block (read by app).
  // Keys inside `data` must all be strings.
  const dataStrings = {};
  const rawData = payload.data || {};
  Object.keys(rawData).forEach(k => {
    dataStrings[k] = String(rawData[k]);
  });

  return {
    token,
    notification: {
      title: payload.title || 'Notifikasi',
      body:  payload.body  || ''
    },
    data: {
      url:   payload.url   || '/portal',
      tag:   payload.tag   || 'default',
      ...dataStrings
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'netops_portal',
        sound:     'default',
        // icon name must match a drawable bundled in the APK
        icon: 'ic_notification',
        color: '#1d4ed8',
        defaultSound: true,
        defaultVibrateTimings: true
      }
    }
  };
}

// ── Kirim push ke satu customer (semua platform) ──────────────
/**
 * @param {number} customerId
 * @param {{ title, body, icon?, badge?, url?, tag?, data? }} payload
 */
async function sendToCustomer(customerId, payload) {
  if (!isReady()) return { sent: 0, failed: 0 };

  const subs = await CustomerPushSubscription.findAll({
    where: { customer_id: customerId, is_active: true }
  });

  if (!subs.length) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const deadIds = [];

  await Promise.all(subs.map(async (sub) => {
    try {
      if (sub.platform === 'fcm') {
        if (!_fcmReady || !sub.fcm_token) { failed++; return; }
        await _fcmAdmin.messaging().send(_buildFcmMessage(sub.fcm_token, payload));
        await sub.update({ last_used: new Date() });
        sent++;
      } else {
        // default / legacy = web
        if (!_vapidReady || !sub.endpoint) { failed++; return; }
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          _buildWebPayload(payload),
          { TTL: 86400 }
        );
        await sub.update({ last_used: new Date() });
        sent++;
      }
    } catch (e) {
      // Detect dead subscriptions per channel:
      //   Web Push: 410 Gone, 404 Not Found
      //   FCM:      messaging/registration-token-not-registered,
      //             messaging/invalid-registration-token
      const webDead = e.statusCode === 410 || e.statusCode === 404;
      const fcmDead = e.code === 'messaging/registration-token-not-registered'
                   || e.code === 'messaging/invalid-registration-token'
                   || e.errorInfo?.code === 'messaging/registration-token-not-registered';
      if (webDead || fcmDead) {
        deadIds.push(sub.id);
      } else {
        logger.error(`[PushService] Send error sub#${sub.id} (${sub.platform}): ${e.message}`);
      }
      failed++;
    }
  }));

  // Prune dead subscriptions
  if (deadIds.length) {
    await CustomerPushSubscription.destroy({ where: { id: { [Op.in]: deadIds } } });
    logger.info(`[PushService] Removed ${deadIds.length} dead subscriptions`);
  }

  return { sent, failed };
}

// ── Kirim push ke banyak customer sekaligus ───────────────────
async function sendToCustomers(customerIds, payload) {
  if (!isReady() || !customerIds.length) return { total_sent: 0, total_failed: 0 };

  let total_sent = 0, total_failed = 0;
  // Proses batch 20 sekaligus agar tidak overload
  const BATCH = 20;
  for (let i = 0; i < customerIds.length; i += BATCH) {
    const batch = customerIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (cid) => {
      const r = await sendToCustomer(cid, payload);
      total_sent   += r.sent;
      total_failed += r.failed;
    }));
  }
  return { total_sent, total_failed };
}

// ── Tagihan H-3 / H-1 / H+0: reminder sebelum & saat jatuh tempo ─
async function sendDueSoonReminders() {
  if (!isReady()) return;
  try {
    const moment = require('moment');
    const cfg = await loadReminderSettings();
    if (cfg.push_reminder_enabled !== '1') {
      logger.info('[PushService] Due reminders di-skip (push_reminder_enabled=0)');
      return;
    }

    // Hari yang aktif sesuai setting (H-3/H-1/H+0)
    const activeDays = [];
    if (cfg.push_reminder_h3_enabled === '1') activeDays.push(3);
    if (cfg.push_reminder_h1_enabled === '1') activeDays.push(1);
    if (cfg.push_reminder_h0_enabled === '1') activeDays.push(0);
    if (!activeDays.length) { logger.info('[PushService] Due reminders: tidak ada hari aktif'); return; }

    const targets = await sequelize.query(
      `SELECT DISTINCT c.id AS cid, c.name, i.due_date,
              DATEDIFF(i.due_date, CURDATE()) AS days_left,
              SUM(i.total) AS total
       FROM customers c
       JOIN invoices i ON i.customer_id = c.id
       WHERE i.status IN ('unpaid','overdue')
         AND DATEDIFF(i.due_date, CURDATE()) IN (:days)
       GROUP BY c.id, c.name, i.due_date`,
      { replacements: { days: activeDays }, type: sequelize.QueryTypes.SELECT }
    );

    let sent3 = 0, sent1 = 0, sent0 = 0;

    for (const row of targets) {
      const daysLeft = parseInt(row.days_left);
      const total    = parseFloat(row.total) || 0;
      const fmtRp    = (v) => 'Rp ' + Math.round(v).toLocaleString('id-ID');
      const fmtDate  = (d) => moment(d).format('DD MMM YYYY');
      const vars = { nama: row.name, jumlah: fmtRp(total), tgl: fmtDate(row.due_date) };

      let payload = null;
      if (daysLeft === 3) {
        payload = { title: fillTemplate(cfg.push_reminder_h3_title, vars),
                    body: fillTemplate(cfg.push_reminder_h3_body, vars),
                    tag: 'due-soon-3', url: '/portal/dashboard', data: { type: 'due_soon', days: 3 } };
        sent3++;
      } else if (daysLeft === 1) {
        payload = { title: fillTemplate(cfg.push_reminder_h1_title, vars),
                    body: fillTemplate(cfg.push_reminder_h1_body, vars),
                    tag: 'due-soon-1', url: '/portal/dashboard', data: { type: 'due_soon', days: 1 } };
        sent1++;
      } else if (daysLeft === 0) {
        payload = { title: fillTemplate(cfg.push_reminder_h0_title, vars),
                    body: fillTemplate(cfg.push_reminder_h0_body, vars),
                    tag: 'due-today', url: '/portal/dashboard', data: { type: 'due_today', days: 0 } };
        sent0++;
      }

      if (payload) await sendToCustomer(row.cid, payload);
    }

    logger.info(`[PushService] Due reminders sent — H-3:${sent3} H-1:${sent1} H+0:${sent0}`);
  } catch (e) {
    logger.error('[PushService] sendDueSoonReminders error: ' + e.message);
  }
}

// ── Tagihan overdue: setelah jatuh tempo ─────────────────────
async function sendOverdueReminders() {
  if (!isReady()) return;
  try {
    const moment = require('moment');
    const cfg = await loadReminderSettings();
    if (cfg.push_reminder_enabled !== '1' || cfg.push_reminder_overdue_enabled !== '1') {
      logger.info('[PushService] Overdue reminders di-skip (disabled)');
      return;
    }

    const targets = await sequelize.query(
      `SELECT DISTINCT c.id AS cid, c.name,
              SUM(i.total) AS total,
              MIN(i.due_date) AS earliest_due
       FROM customers c
       JOIN invoices i ON i.customer_id = c.id
       WHERE i.status = 'overdue'
         AND c.isolir_status != 'isolated'
       GROUP BY c.id, c.name`,
      { type: sequelize.QueryTypes.SELECT }
    );

    for (const row of targets) {
      const total  = parseFloat(row.total) || 0;
      const fmtRp  = (v) => 'Rp ' + Math.round(v).toLocaleString('id-ID');
      const vars = { nama: row.name, jumlah: fmtRp(total), tgl: moment(row.earliest_due).format('DD MMM YYYY') };
      await sendToCustomer(row.cid, {
        title: fillTemplate(cfg.push_reminder_overdue_title, vars),
        body:  fillTemplate(cfg.push_reminder_overdue_body, vars),
        tag:   'overdue',
        url:   '/portal/dashboard',
        data:  { type: 'overdue' }
      });
    }

    if (targets.length) logger.info(`[PushService] Overdue push sent to ${targets.length} customers`);
  } catch (e) {
    logger.error('[PushService] sendOverdueReminders error: ' + e.message);
  }
}

// Default teks notif isolir/restore (bisa dikustom via app_settings)
const ISOLIR_PUSH_DEFAULTS = {
  push_isolir_enabled:       '1',
  push_isolir_title:         '🚫 Layanan Internet Terisolir',
  push_isolir_body:          'Halo {nama}, layanan internet Anda dinonaktifkan sementara. Silakan lakukan pembayaran melalui portal untuk mengaktifkan kembali.',
  push_restore_title:        '✅ Layanan Internet Aktif Kembali',
  push_restore_body:         'Halo {nama}, layanan internet Anda telah aktif kembali. Terima kasih.',
};

async function _loadIsolirPushCfg() {
  try {
    const keys = Object.keys(ISOLIR_PUSH_DEFAULTS);
    const rows = await sequelize.query(
      'SELECT `key`, value FROM app_settings WHERE `key` IN (:keys)',
      { replacements: { keys }, type: sequelize.QueryTypes.SELECT }
    );
    const cfg = { ...ISOLIR_PUSH_DEFAULTS };
    rows.forEach(r => { if (r.value !== null && r.value !== '') cfg[r.key] = r.value; });
    return cfg;
  } catch (e) {
    return { ...ISOLIR_PUSH_DEFAULTS };
  }
}

function _applyVars(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

// ── Push ke pelanggan yang baru di-isolir ─────────────────────
async function sendIsolirNotif(customerId, customerName, customerCid = '') {
  if (!isReady()) return;
  const cfg = await _loadIsolirPushCfg();
  if (String(cfg.push_isolir_enabled) !== '1') return;
  const vars = { nama: customerName || 'Pelanggan', cid: customerCid || '' };
  await sendToCustomer(customerId, {
    title: _applyVars(cfg.push_isolir_title, vars),
    body:  _applyVars(cfg.push_isolir_body, vars),
    tag:   'isolir',
    url:   '/portal/dashboard',
    data:  { type: 'isolir' }
  });
}

// ── Push ke pelanggan yang baru di-restore / aktif kembali ────
async function sendRestoreNotif(customerId, customerName, customerCid = '') {
  if (!isReady()) return;
  const cfg = await _loadIsolirPushCfg();
  if (String(cfg.push_isolir_enabled) !== '1') return; // satu toggle utk isolir & restore
  const vars = { nama: customerName || 'Pelanggan', cid: customerCid || '' };
  await sendToCustomer(customerId, {
    title: _applyVars(cfg.push_restore_title, vars),
    body:  _applyVars(cfg.push_restore_body, vars),
    tag:   'restore',
    url:   '/portal/dashboard',
    data:  { type: 'restore' }
  });
}

// ── VAPID public key untuk client ────────────────────────────
function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

module.exports = {
  init,
  isReady,
  isWebReady,
  isFcmReady,
  getPublicKey,
  sendToCustomer,
  sendToCustomers,
  sendDueSoonReminders,
  sendOverdueReminders,
  sendIsolirNotif,
  sendRestoreNotif,
  getReminderSettings: loadReminderSettings
};