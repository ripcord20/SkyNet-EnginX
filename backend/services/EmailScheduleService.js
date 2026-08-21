/**
 * EmailScheduleService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Registry terpusat untuk SEMUA jadwal pengiriman email otomatis.
 * Dipakai halaman "Email Schedule" sebagai pusat kendali. Tiap jadwal
 * memetakan field UI (enabled/frequency/hour/recipients) ke key app_settings
 * yang SUDAH dibaca oleh cron — jadi mengubah di sini benar-benar berefek.
 *
 * Menambah jadwal baru cukup tambahkan satu entri di SCHEDULES.
 */

const { AppSetting } = require('../models');
const { Op } = require('sequelize');

/**
 * Tiap jadwal:
 *  - key           : id unik
 *  - label, desc   : tampilan
 *  - icon          : nama ikon (dipakai di UI)
 *  - fields        : daftar field yg bisa diatur ('enabled','frequency','hour','recipients')
 *  - freqOptions   : opsi frekuensi bila ada field frequency
 *  - settingMap     : pemetaan field → key app_settings (sumber kebenaran cron)
 *  - lastSentKey   : (opsional) key app_settings penanda terakhir terkirim
 *  - note          : (opsional) catatan di UI
 */
const SCHEDULES = {
  finance_report: {
    key: 'finance_report',
    label: 'Laporan Keuangan',
    desc: 'Kirim laporan keuangan (ringkasan, pembayaran, laba-rugi) ke email secara berkala.',
    icon: 'chart',
    fields: ['enabled', 'frequency', 'hour', 'recipients'],
    freqOptions: [
      { value: 'daily', label: 'Harian' },
      { value: 'weekly', label: 'Mingguan (Senin)' },
      { value: 'monthly', label: 'Bulanan (tanggal 1)' }
    ],
    settingMap: {
      enabled: 'finrep_enabled',
      frequency: 'finrep_frequency',
      hour: 'finrep_hour',
      recipients: 'finrep_recipients'
    },
    defaults: { enabled: '0', frequency: 'monthly', hour: '7', recipients: '' },
    lastSentKey: 'finrep_last_sent',
    note: 'Laporan periode (bulan/minggu/hari) berjalan dikirim ke email penerima.'
  },

  daily_digest: {
    key: 'daily_digest',
    label: 'Email Digest Harian',
    desc: 'Ringkasan operasional tiap pagi: pelanggan baru, penunggak, uang masuk kemarin, tiket terbuka, perangkat offline.',
    icon: 'pulse',
    fields: ['enabled', 'hour', 'recipients'],
    settingMap: {
      enabled: 'digest_enabled',
      hour: 'digest_hour',
      recipients: 'digest_recipients'
    },
    defaults: { enabled: '0', hour: '7', recipients: '' },
    lastSentKey: 'digest_last_sent',
    note: '"Pulse harian" operasional — beda dari Laporan Keuangan yang fokus angka rupiah.'
  },

  invoice_reminder_email: {
    key: 'invoice_reminder_email',
    label: 'Reminder Tagihan (Email)',
    desc: 'Kirim email pengingat tagihan ke pelanggan menjelang & saat jatuh tempo.',
    icon: 'clock',
    // Jadwal ini hanya on/off + jam (jam memakai pengaturan reminder global).
    fields: ['enabled', 'hour_due', 'hour_overdue'],
    settingMap: {
      enabled: 'email_reminder_enabled',
      hour_due: 'push_reminder_send_hour',      // jam kirim H-3/H-1/H+0
      hour_overdue: 'push_reminder_overdue_hour' // jam kirim menunggak
    },
    defaults: { enabled: '0', hour_due: '8', hour_overdue: '9' },
    note: 'Isi & template email diatur di halaman Email Template (Notifikasi Jatuh Tempo). '
        + 'Jam ini dipakai bersama dengan reminder Push/WA.'
  }
};

const FIELD_KEYS = ['enabled', 'frequency', 'hour', 'hour_due', 'hour_overdue', 'recipients'];

// Ambil semua nilai app_settings yang relevan sekali jalan.
async function _loadAll() {
  const keys = new Set();
  Object.values(SCHEDULES).forEach(s => {
    Object.values(s.settingMap).forEach(k => keys.add(k));
    if (s.lastSentKey) keys.add(s.lastSentKey);
  });
  const rows = await AppSetting.findAll({ where: { key: { [Op.in]: [...keys] } } });
  const map = {}; rows.forEach(r => { map[r.key] = r.value; });
  return map;
}

// Untuk UI: daftar jadwal dengan nilai saat ini.
async function listForUi() {
  const all = await _loadAll();
  return Object.values(SCHEDULES).map(s => {
    const current = {};
    for (const f of s.fields) {
      const k = s.settingMap[f];
      let v = (k && all[k] !== undefined && all[k] !== null && all[k] !== '') ? all[k] : (s.defaults[f] ?? '');
      // normalisasi enabled jadi boolean string
      current[f] = v;
    }
    const lastSent = s.lastSentKey ? (all[s.lastSentKey] || '') : '';
    return {
      key: s.key, label: s.label, desc: s.desc, icon: s.icon,
      fields: s.fields, freqOptions: s.freqOptions || null, note: s.note || '',
      current, lastSent
    };
  });
}

// Simpan satu jadwal. payload: { enabled, frequency, hour, hour_due, hour_overdue, recipients }
async function saveSchedule(key, payload = {}) {
  const s = SCHEDULES[key];
  if (!s) throw new Error('Jadwal tidak dikenal: ' + key);

  // Validasi recipients bila jadwal punya field tsb & diaktifkan.
  if (s.fields.includes('recipients')) {
    const recips = String(payload.recipients || '').split(',').map(x => x.trim()).filter(Boolean);
    const bad = recips.find(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    const enabled = !!payload.enabled;
    if (enabled && !recips.length) return { ok: false, message: 'Isi minimal satu email penerima' };
    if (bad) return { ok: false, message: 'Email tidak valid: ' + bad };
    payload.recipients = recips.join(', ');
  }

  for (const f of s.fields) {
    const settingKey = s.settingMap[f];
    if (!settingKey) continue;
    let value;
    if (f === 'enabled') value = payload.enabled ? '1' : '0';
    else if (f === 'frequency') {
      const allowed = (s.freqOptions || []).map(o => o.value);
      value = allowed.includes(payload.frequency) ? payload.frequency : (s.defaults.frequency || 'monthly');
    } else if (f === 'hour' || f === 'hour_due' || f === 'hour_overdue') {
      const h = Math.min(23, Math.max(0, parseInt(payload[f]) || parseInt(s.defaults[f]) || 0));
      value = String(h);
    } else if (f === 'recipients') {
      value = String(payload.recipients || '');
    } else {
      value = String(payload[f] ?? '');
    }
    await AppSetting.upsert({ key: settingKey, value, type: 'string' });
  }
  return { ok: true, message: 'Jadwal "' + s.label + '" disimpan' };
}

module.exports = { SCHEDULES, FIELD_KEYS, listForUi, saveSchedule };
