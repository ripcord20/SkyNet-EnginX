/**
 * WaFeaturesController.js
 * Handle: Templates, Reminder Settings, Report Settings & Preview
 */
const { WaTemplate, ReminderSetting, AppSetting, Invoice, Payment, Customer, Package, WaSession, sequelize } = require('../models');
const { Op } = require('sequelize');
const moment = require('moment');
const { getCompanyName } = require('../utils/companyInfo');

const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

// Tanggal "hari ini" di timezone aplikasi (selaras dgn CronService).
const APP_TZ = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Jakarta';
function nowDateAppTz() {
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    return `${p.year}-${p.month}-${p.day}`;
  } catch (_) { return moment().format('YYYY-MM-DD'); }
}

// Tanggal hari-ini-di-APP_TZ digeser N hari (date-only, selaras CronService).
function dateAppTzOffset(offsetDays) {
  return moment(nowDateAppTz(), 'YYYY-MM-DD').add(offsetDays, 'days').format('YYYY-MM-DD');
}

// ── Helpers ──────────────────────────────────────────────────
async function getSetting(key, def = '') {
  const row = await AppSetting.findOne({ where: { key } });
  return row ? (row.value ?? def) : def;
}
async function setSetting(key, value, type = 'string') {
  await AppSetting.upsert({ key, value: String(value), type });
}
function fmtRp(n) { return 'Rp ' + Number(n).toLocaleString('id-ID'); }

// ── TEMPLATE CRUD ─────────────────────────────────────────────
const templates = {
  async list(req, res) {
    try {
      const rows = await WaTemplate.findAll({ order: [['category','ASC'],['name','ASC']] });

      // ── Hitung status "dipakai sistem" per template ──────────────────────
      // Kategori yang dipilih OTOMATIS oleh sistem berdasar kategori (ambil
      // template AKTIF dengan updated_at terbaru). Template yg akan terpilih
      // itulah yang berstatus LIVE untuk kategori tsb.
      const AUTO_CATS = ['payment_confirm','reminder_overdue','reminder_due',
                         'isolir','restore','welcome','invoice_paid','invoice_unpaid'];
      // Untuk tiap kategori auto, cari id template aktif paling baru (winner).
      const winners = {}; // category -> template id yang akan dipakai
      AUTO_CATS.forEach(cat => {
        const active = rows.filter(t => t.category === cat && t.is_active);
        if (!active.length) return;
        active.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        winners[cat] = active[0].id;
      });

      // Template reminder bisa juga "live" karena ditautkan manual ke jadwal
      // Reminder (ReminderSetting.template_id).
      let linkedMap = {}; // template_id -> [ {type, days_offset, is_active} ]
      try {
        const rsets = await ReminderSetting.findAll();
        rsets.forEach(r => {
          if (!r.template_id) return;
          (linkedMap[r.template_id] = linkedMap[r.template_id] || []).push({
            type: r.type, days_offset: r.days_offset, is_active: !!r.is_active
          });
        });
      } catch (_) { /* tabel reminder mungkin belum ada */ }

      const data = rows.map(t => {
        const o = t.toJSON ? t.toJSON() : t;
        const linked = linkedMap[t.id] || [];
        const isWinner = winners[t.category] === t.id;
        // LIVE bila: jadi winner kategori auto, ATAU tertaut ke ≥1 jadwal reminder aktif.
        const activeLinks = linked.filter(l => l.is_active);
        let is_live = false, live_reason = '';
        if (isWinner && t.is_active) {
          is_live = true;
          live_reason = 'Dipakai otomatis untuk kategori ini';
        } else if (activeLinks.length) {
          is_live = true;
          live_reason = 'Tertaut ' + activeLinks.length + ' jadwal reminder';
        } else if (linked.length) {
          live_reason = 'Tertaut jadwal reminder (nonaktif)';
        } else if (AUTO_CATS.includes(t.category) && !t.is_active) {
          live_reason = 'Nonaktif — tidak dipakai';
        } else if (AUTO_CATS.includes(t.category) && !isWinner) {
          live_reason = 'Tidak terpilih (ada template lebih baru)';
        } else if (t.category === 'broadcast') {
          live_reason = 'Dipakai saat dipilih di Broadcast';
        } else if (t.category === 'custom') {
          live_reason = 'Template bebas / referensi';
        }
        o.is_live = is_live;
        o.live_reason = live_reason;
        o.linked_reminders = linked.length;
        return o;
      });

      res.json({ success: true, data });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async create(req, res) {
    try {
      const { name, category, content } = req.body;
      if (!name || !content) return res.status(400).json({ success: false, message: 'Nama dan isi template wajib diisi' });
      const variables = (content.match(/\{(\w+)\}/g) || []).map(v => v.slice(1,-1));
      const tpl = await WaTemplate.create({
        name, category: category || 'custom', content, message: content,
        variables, is_active: true, created_by: req.user?.id || null
      });
      res.status(201).json({ success: true, data: tpl, message: 'Template berhasil dibuat' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async update(req, res) {
    try {
      const tpl = await WaTemplate.findByPk(req.params.id);
      if (!tpl) return res.status(404).json({ success: false, message: 'Template tidak ditemukan' });
      const { name, category, content } = req.body;
      const variables = (content.match(/\{(\w+)\}/g) || []).map(v => v.slice(1,-1));
      await tpl.update({ name, category, content, message: content, variables });
      res.json({ success: true, data: tpl, message: 'Template diupdate' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async toggle(req, res) {
    try {
      const tpl = await WaTemplate.findByPk(req.params.id);
      if (!tpl) return res.status(404).json({ success: false, message: 'Template tidak ditemukan' });
      await tpl.update({ is_active: !tpl.is_active });
      res.json({ success: true, is_active: tpl.is_active, message: `Template ${tpl.is_active ? 'diaktifkan' : 'dinonaktifkan'}` });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async destroy(req, res) {
    try {
      const tpl = await WaTemplate.findByPk(req.params.id);
      if (!tpl) return res.status(404).json({ success: false, message: 'Template tidak ditemukan' });
      await tpl.destroy();
      res.json({ success: true, message: 'Template dihapus' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  // Preview - render template dengan data dummy
  async preview(req, res) {
    try {
      const { content } = req.body;
      if (!content) return res.json({ success: true, preview: '' });
      const now = moment();
      // Helper: format tanggal Indonesia ("13 Mei 2026") tanpa butuh moment locale.
      // Pakai konstanta MONTHS modul (sudah Indonesia, baris 9).
      const fmtID = (m) => m.date() + ' ' + MONTHS[m.month()+1] + ' ' + m.year();
      const dummy = {
        // ── Identitas pelanggan ───────────────────────────────────────
        nama:           'FLAYNET.COM',
        cid:            'CID0042',
        phone:          '628123456789',
        nohp:           '628123456789',
        email:          'budi.santoso@example.com',
        alamat:         'Jl. Mawar No. 12, RT 03/RW 05, Depok',

        // ── Layanan / paket ───────────────────────────────────────────
        paket:          'Paket 20 Mbps Home',
        harga_paket:    'Rp 250.000',
        harga:          'Rp 250.000',  // alias lama
        tgl_install:    fmtID(now.clone()),

        // ── Tagihan / invoice ─────────────────────────────────────────
        invoice:        'INV-' + now.format('DDMM') + '-00042',
        periode:        MONTHS[now.month()+1] + ' ' + now.year(),
        jumlah:         'Rp 250.000',
        jatuh_tempo:    fmtID(now.clone().add(3,'days')),
        tgl_jatuh_tempo:fmtID(now.clone().add(3,'days')),
        duedate:        now.clone().add(3,'days').format('DD/MM/YYYY'),
        status:         'segera jatuh tempo',

        // ── Pembayaran (untuk kategori payment_confirm) ───────────────
        tgl_bayar:      fmtID(now.clone()),
        metode:         'Transfer BCA',
        ref_no:         'TRF' + now.format('YYYYMMDD'),
        due_date_baru:  fmtID(now.clone().add(30,'days')),

        // ── Identitas ISP / perusahaan ────────────────────────────────
        perusahaan:     await getCompanyName(),
        phone_cs:       process.env.COMPANY_PHONE || process.env.SUPPORT_PHONE || '0800-1234-5678',
        pppoe_user:     'budi.santoso',
        static_ip:      '10.10.10.42',

        // ── Link (contoh; URL nyata dibangun saat pengiriman sebenarnya) ──
        link_invoice:        ((process.env.APP_URL || process.env.BASE_URL || 'https://domain.com').replace(/\/+$/,'')) + '/pub/invoice/42.contoh',
        link_bayar_permanen: ((process.env.APP_URL || process.env.BASE_URL || 'https://domain.com').replace(/\/+$/,'')) + '/pub/cust/contohtokenpermanen',
        link_permanen:       ((process.env.APP_URL || process.env.BASE_URL || 'https://domain.com').replace(/\/+$/,'')) + '/pub/cust/contohtokenpermanen'
      };
      let preview = content;
      Object.keys(dummy).forEach(k => { preview = preview.split(`{${k}}`).join(dummy[k]); });
      res.json({ success: true, preview });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }
};

// ── REMINDER SETTINGS ─────────────────────────────────────────
const reminder = {
  async list(req, res) {
    try {
      // Pakai raw query untuk hindari masalah association
      const rows = await ReminderSetting.findAll({
        order: [['type', 'ASC'], ['days_offset', 'ASC']]
      });
      const typeOrder = { before: 0, due: 1, overdue: 2 };
      rows.sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || (a.days_offset - b.days_offset));

      // Ambil template secara terpisah lalu gabungkan manual.
      // Sertakan `content`/`message` agar halaman bisa menampilkan PREVIEW LANGSUNG
      // (bubble WhatsApp) dari template yang dipilih pada tiap reminder.
      const tpls = await WaTemplate.findAll({
        where: { is_active: true },
        attributes: ['id','name','category','content','message'],
        order: [['name','ASC']]
      });
      const tplMap = {};
      tpls.forEach(t => {
        const j = t.toJSON();
        // Normalisasi body: pakai `content`, fallback ke `message` (backward compat).
        j.body = j.content || j.message || '';
        tplMap[t.id] = j;
      });

      const data = rows.map(r => {
        const json = r.toJSON();
        json.template = json.template_id ? (tplMap[json.template_id] || null) : null;
        return json;
      });

      // Kirim daftar template lengkap dengan body untuk preview di frontend.
      const tplsOut = tpls.map(t => {
        const j = t.toJSON();
        j.body = j.content || j.message || '';
        return j;
      });

      res.json({ success: true, data, templates: tplsOut });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async seed(req, res) {
    try {
      const defaults = [
        { id:1, type:'before',  days_offset:-3, send_time:'08:00:00', is_active:true },
        { id:2, type:'before',  days_offset:-1, send_time:'08:00:00', is_active:true },
        { id:3, type:'due',     days_offset:0,  send_time:'08:00:00', is_active:true },
        { id:4, type:'overdue', days_offset:1,  send_time:'08:00:00', is_active:true },
        { id:5, type:'overdue', days_offset:3,  send_time:'08:00:00', is_active:true },
      ];
      for (const d of defaults) {
        await ReminderSetting.upsert(d);
      }
      res.json({ success: true, message: '5 reminder settings berhasil dibuat' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async save(req, res) {
    try {
      const { reminders } = req.body; // array of {id, template_id, send_time, is_active}
      if (!Array.isArray(reminders)) return res.status(400).json({ success: false, message: 'Invalid data' });
      for (const r of reminders) {
        if (!r.id) continue;
        await ReminderSetting.update({
          template_id: r.template_id || null,
          send_time:   r.send_time || '08:00:00',
          is_active:   r.is_active ? 1 : 0
        }, { where: { id: r.id } });
      }
      res.json({ success: true, message: 'Pengaturan reminder berhasil disimpan' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  // Run reminder manually - send WA ke pelanggan yang sesuai kondisi
  async runNow(req, res) {
    try {
      const allReminders = await ReminderSetting.findAll({ where: { is_active: true } });
      const activeTpls = await WaTemplate.findAll({ where: { is_active: true } });
      const tplMap = {};
      activeTpls.forEach(t => { tplMap[t.id] = t; });
      const activeReminders = allReminders
        .filter(r => r.template_id && tplMap[r.template_id])
        .map(r => { r.template = tplMap[r.template_id]; return r; });
      if (!activeReminders.length) return res.json({ success: true, message: 'Tidak ada reminder aktif dengan template', sent: 0 });

      const GatewayService = require('../services/GatewayService');
      const session = await GatewayService.getDefaultSendingSession();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Tidak ada WA session terhubung' });
      }
      await GatewayService.warmSession(session.session_id);
      if (!GatewayService.isConnected(session.session_id)) {
        return res.status(400).json({ success: false, message: 'Tidak ada WA session terhubung' });
      }

      const today = nowDateAppTz();
      let sent = 0, failed = 0, skipped = 0;
      let totalMatched = 0;                 // total pelanggan yang cocok kondisi
      const targetInfo = [];                // ringkasan per reminder utk pesan

      for (const rm of activeReminders) {
        // Hitung target date berdasarkan type & days_offset (timezone aplikasi).
        let targetDate;
        if (rm.type === 'before') targetDate = dateAppTzOffset(Math.abs(rm.days_offset));
        else if (rm.type === 'due') targetDate = today;
        else targetDate = dateAppTzOffset(-Math.abs(rm.days_offset));

        // Cari customer + invoice dengan due_date = targetDate (unpaid/overdue)
        // FIX: hapus destructuring [customers] — saat type:SELECT digunakan,
        // sequelize.query() return array langsung, bukan [results, metadata].
        const customers = await sequelize.query(
          `SELECT DISTINCT c.id, c.name, c.phone, c.customer_id AS cid,
                  c.public_link_token,
                  pkg.name AS paket, pkg.price AS harga,
                  i.id AS invoice_id, i.invoice_number, i.due_date,
                  i.total AS jumlah, i.status AS inv_status,
                  i.period_month, i.period_year
           FROM customers c
           LEFT JOIN packages pkg ON pkg.id = c.package_id
           JOIN invoices i ON i.customer_id = c.id
           WHERE i.due_date = :dt AND i.status IN ('unpaid','overdue')
             AND c.phone IS NOT NULL AND c.phone != ''`,
          { replacements: { dt: targetDate }, type: sequelize.QueryTypes.SELECT }
        );

        totalMatched += customers.length;
        // Label tipe untuk pesan hasil
        const _tlabel = rm.type === 'before' ? ('H-' + Math.abs(rm.days_offset))
                      : rm.type === 'due' ? 'Jatuh Tempo'
                      : ('Overdue +' + Math.abs(rm.days_offset));
        targetInfo.push({ label: _tlabel, date: targetDate, count: customers.length });

        const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        const companyName = await getCompanyName();
        const { ReminderLog } = require('../models');

        for (const cust of customers) {
          // Dedup: lewati kalau reminder ini sudah tercatat terkirim untuk
          // invoice ini di tanggal target (mencegah dobel dgn cron / klik ganda).
          let logRow, created;
          try {
            [logRow, created] = await ReminderLog.findOrCreate({
              where: { reminder_id: rm.id, invoice_id: cust.invoice_id, send_date: targetDate },
              defaults: {
                reminder_id: rm.id, invoice_id: cust.invoice_id, customer_id: cust.id,
                send_date: targetDate, reminder_type: rm.type, phone: cust.phone, status: 'sent'
              }
            });
          } catch (_) { skipped++; continue; }
          if (!created) { skipped++; continue; }
          // Render template dengan placeholder lengkap (sinkron dengan
          // BillingController.sendReminder & WAController.bulkReminder)
          const periodeStr = cust.period_month
            ? (MONTHS[cust.period_month] || cust.period_month) + ' ' + (cust.period_year || '')
            : '';
          const dueDateStr = moment(cust.due_date).format('D MMMM YYYY');
          const raw = rm.template.content || rm.template.message || '';
          const { buildInvoiceLink, buildCustomerLink } = require('../utils/templateHelper');
          const _linkInv = cust.invoice_id ? buildInvoiceLink(cust.invoice_id) : '';
          const _linkPerm = cust.public_link_token ? buildCustomerLink(cust.public_link_token) : '';
          const vars = {
            '{nama}':             cust.name || '',
            '{nohp}':             cust.phone || '',
            '{phone}':            cust.phone || '',          // alias
            '{invoice}':          cust.invoice_number || '',
            '{paket}':            cust.paket || '–',
            '{periode}':          periodeStr,
            '{jumlah}':           fmtRp(cust.jumlah || 0),
            '{jatuh_tempo}':      dueDateStr,
            '{tgl_jatuh_tempo}':  dueDateStr,                 // alias
            '{status}':           cust.inv_status === 'overdue' ? '⚠️ JATUH TEMPO' : 'segera jatuh tempo',
            '{perusahaan}':       companyName,
            // Backward-compat dengan placeholder lama
            '{cid}':              cust.cid || '',
            '{harga}':            fmtRp(cust.harga || 0),
            '{duedate}':          moment(cust.due_date).format('DD/MM/YYYY'),
            '{link_invoice}':         _linkInv,
            '{link_bayar_permanen}':  _linkPerm,
            '{link_permanen}':        _linkPerm
          };
          const msg = Object.keys(vars).reduce(
            (acc, k) => acc.split(k).join(vars[k]),
            raw
          );
          try {
            await GatewayService.sendMessage(session.session_id, cust.phone, msg, null);
            sent++;
          } catch(e) {
            failed++;
            try { await logRow.update({ status: 'failed', error_message: String(e.message || e).slice(0,255) }); } catch (_) {}
          }
          await new Promise(r => setTimeout(r, 500)); // delay 500ms antar pesan
        }
      }

      // Pesan hasil yang informatif — terutama saat 0 (biar admin paham kenap).
      let message;
      const fmtTgl = (d) => {
        const m = moment(d, 'YYYY-MM-DD');
        return m.date() + ' ' + MONTHS[m.month() + 1] + ' ' + m.year();
      };
      if (totalMatched === 0) {
        // Tidak ada pelanggan yang cocok kondisi mana pun.
        const detail = targetInfo
          .map(t => `${t.label} (jatuh tempo ${fmtTgl(t.date)})`)
          .join(', ');
        message = `Tidak ada pelanggan yang perlu diingatkan saat ini. ` +
          `Reminder aktif mencari tagihan belum dibayar dengan: ${detail}. ` +
          `Belum ada yang cocok — ini normal, reminder akan terkirim otomatis saat ada tagihan mendekati jatuh tempo.`;
      } else if (sent === 0 && skipped > 0 && failed === 0) {
        message = `Semua reminder yang cocok (${skipped}) sudah pernah terkirim hari ini, jadi tidak dikirim ulang.`;
      } else {
        message = `Reminder dikirim: ${sent} sukses` +
          (failed ? `, ${failed} gagal` : '') +
          (skipped ? `, ${skipped} dilewati (sudah terkirim)` : '') + '.';
      }
      res.json({ success: true, message, sent, failed, skipped, matched: totalMatched, targets: targetInfo });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  // ── TEST SEND — kirim 1 reminder ke nomor HP custom untuk uji template render
  // Body: { phone, reminder_id?, template_id? }
  // Akan ambil 1 invoice unpaid/overdue real sebagai sample data; kalau tidak ada,
  // pakai data dummy.
  // ── HISTORY — riwayat pengiriman reminder (untuk UI) ────────────────
  // Query: ?date=YYYY-MM-DD (opsional, default 7 hari terakhir), ?limit
  async history(req, res) {
    try {
      const { ReminderLog, Customer, sequelize } = require('../models');
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const where = {};
      if (req.query.date) {
        where.send_date = req.query.date;
      }
      const rows = await ReminderLog.findAll({
        where,
        order: [['createdAt', 'DESC']],
        limit
      });
      // Ambil nama pelanggan sekaligus
      const custIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))];
      let custMap = {};
      if (custIds.length) {
        const custs = await Customer.findAll({ where: { id: custIds }, attributes: ['id', 'name', 'customer_id'] });
        custs.forEach(c => { custMap[c.id] = { name: c.name, customer_id: c.customer_id }; });
      }
      const data = rows.map(r => ({
        id: r.id,
        reminder_type: r.reminder_type,
        send_date: r.send_date,
        phone: r.phone,
        status: r.status,
        error_message: r.error_message,
        created_at: r.createdAt,
        customer: custMap[r.customer_id] || null
      }));
      // Ringkasan hari ini
      const todayStr = nowDateAppTz();
      const [summary] = await sequelize.query(
        `SELECT
            SUM(status='sent') AS sent_today,
            SUM(status='failed') AS failed_today
         FROM reminder_logs WHERE send_date = :d`,
        { replacements: { d: todayStr }, type: sequelize.QueryTypes.SELECT }
      );
      res.json({
        success: true,
        data,
        summary: {
          date: todayStr,
          sent_today: parseInt(summary?.sent_today || 0),
          failed_today: parseInt(summary?.failed_today || 0)
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async testSend(req, res) {
    try {
      const { phone, reminder_id, template_id } = req.body || {};
      if (!phone) return res.status(400).json({ success: false, message: 'Nomor HP tujuan wajib diisi' });

      // Validasi format nomor (harus angka, minimal 8 digit)
      const cleanPhone = String(phone).replace(/[^\d]/g, '');
      if (cleanPhone.length < 8) return res.status(400).json({ success: false, message: 'Format nomor HP tidak valid' });

      // Resolve template — bisa dari reminder_id atau template_id langsung
      let tpl = null;
      if (template_id) {
        tpl = await WaTemplate.findByPk(template_id);
      } else if (reminder_id) {
        const rm = await ReminderSetting.findByPk(reminder_id);
        if (rm && rm.template_id) tpl = await WaTemplate.findByPk(rm.template_id);
      }
      if (!tpl) return res.status(400).json({ success: false, message: 'Template tidak ditemukan. Pilih reminder dengan template terlebih dulu.' });
      if (!(tpl.content || tpl.message)) return res.status(400).json({ success: false, message: 'Template kosong' });

      // Cek WA session
      const GatewayService = require('../services/GatewayService');
      const session = await GatewayService.getDefaultSendingSession();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Tidak ada WA session terhubung' });
      }
      await GatewayService.warmSession(session.session_id);
      if (!GatewayService.isConnected(session.session_id)) {
        return res.status(400).json({ success: false, message: 'Tidak ada WA session terhubung' });
      }

      // Ambil 1 invoice unpaid/overdue real sebagai sample (kalau ada)
      const sampleRows = await sequelize.query(
        `SELECT c.name, c.phone, c.customer_id AS cid, c.public_link_token,
                pkg.name AS paket, pkg.price AS harga,
                i.id AS invoice_id, i.invoice_number, i.due_date, i.total AS jumlah,
                i.status AS inv_status, i.period_month, i.period_year
         FROM customers c
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         JOIN invoices i ON i.customer_id = c.id
         WHERE i.status IN ('unpaid','overdue')
         ORDER BY i.due_date DESC
         LIMIT 1`,
        { type: sequelize.QueryTypes.SELECT }
      );

      const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      const companyName = await getCompanyName();
      const sample = sampleRows[0];

      let vars;
      let dataSource;
      if (sample) {
        dataSource = `customer real "${sample.name}" (invoice ${sample.invoice_number})`;
        const periodeStr = sample.period_month
          ? (MONTHS[sample.period_month] || sample.period_month) + ' ' + (sample.period_year || '')
          : '';
        const dueDateStr = moment(sample.due_date).format('D MMMM YYYY');
        vars = {
          '{nama}':             sample.name || '',
          '{nohp}':             sample.phone || '',
          '{phone}':            sample.phone || '',
          '{invoice}':          sample.invoice_number || '',
          '{paket}':            sample.paket || '–',
          '{periode}':          periodeStr,
          '{jumlah}':           fmtRp(sample.jumlah || 0),
          '{jatuh_tempo}':      dueDateStr,
          '{tgl_jatuh_tempo}':  dueDateStr,
          '{status}':           sample.inv_status === 'overdue' ? '⚠️ JATUH TEMPO' : 'segera jatuh tempo',
          '{perusahaan}':       companyName,
          '{cid}':              sample.cid || '',
          '{harga}':            fmtRp(sample.harga || 0),
          '{duedate}':          moment(sample.due_date).format('DD/MM/YYYY')
        };
        try {
          const { buildInvoiceLink, buildCustomerLink } = require('../utils/templateHelper');
          vars['{link_invoice}']        = sample.invoice_id ? buildInvoiceLink(sample.invoice_id) : '';
          vars['{link_bayar_permanen}'] = sample.public_link_token ? buildCustomerLink(sample.public_link_token) : '';
          vars['{link_permanen}']       = vars['{link_bayar_permanen}'];
        } catch (_) {}
      } else {
        dataSource = 'data dummy (tidak ada invoice unpaid di DB)';
        const now = moment();
        const dueIn3 = moment().add(3, 'days');
        vars = {
          '{nama}':             'FLAYNET.COM (TEST)',
          '{nohp}':             cleanPhone,
          '{phone}':            cleanPhone,
          '{invoice}':          'INV-' + now.format('DDMM') + '-TEST',
          '{paket}':            'Paket 20 Mbps Home',
          '{periode}':          MONTHS[now.month()+1] + ' ' + now.year(),
          '{jumlah}':           'Rp 250.000',
          '{jatuh_tempo}':      dueIn3.format('D MMMM YYYY'),
          '{tgl_jatuh_tempo}':  dueIn3.format('D MMMM YYYY'),
          '{status}':           'segera jatuh tempo',
          '{perusahaan}':       companyName,
          '{cid}':              'TEST001',
          '{harga}':            'Rp 250.000',
          '{duedate}':          dueIn3.format('DD/MM/YYYY')
        };
        const _baseUrl = (process.env.APP_URL || process.env.BASE_URL || 'https://domain.com').replace(/\/+$/, '');
        vars['{link_invoice}']        = _baseUrl + '/pub/invoice/42.contoh';
        vars['{link_bayar_permanen}'] = _baseUrl + '/pub/cust/contohtokenpermanen';
        vars['{link_permanen}']       = vars['{link_bayar_permanen}'];
      }

      const raw = tpl.content || tpl.message;
      const msg = '🧪 *[TEST]* — pesan ini dikirim untuk uji template\n\n' +
        Object.keys(vars).reduce((acc, k) => acc.split(k).join(vars[k]), raw);

      try {
        await GatewayService.sendMessage(session.session_id, cleanPhone, msg, null);
        res.json({
          success: true,
          message: `Test pesan terkirim ke ${cleanPhone}`,
          template_used: tpl.name,
          data_source: dataSource,
          preview: msg
        });
      } catch (e) {
        return res.status(500).json({ success: false, message: 'Gagal mengirim WA: ' + e.message });
      }
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }
};

// ── REPORT ────────────────────────────────────────────────────
const report = {
  async getSettings(req, res) {
    try {
      const keys = ['admin_notify_phones','report_enabled','report_schedules','report_sections','report_range','report_last_sent'];
      const rows = await AppSetting.findAll({ where: { key: { [Op.in]: keys } } });
      const cfg = {};
      rows.forEach(r => { cfg[r.key] = r.value; });
      res.json({ success: true, data: cfg });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async saveSettings(req, res) {
    try {
      const { phones, schedules, sections, range } = req.body;
      if (phones !== undefined) await setSetting('admin_notify_phones', JSON.stringify(phones), 'json');
      if (schedules) await setSetting('report_schedules', JSON.stringify(schedules), 'json');
      if (sections)  await setSetting('report_sections',  JSON.stringify(sections), 'json');
      if (range)     await setSetting('report_range', range);
      res.json({ success: true, message: 'Pengaturan laporan disimpan' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async preview(req, res) {
    try {
      const { range = 'this_month', from, to } = req.query;
      const sections = JSON.parse(req.query.sections || '{}');
      const { dateFrom, dateTo, label } = resolveRange(range, from, to);
      const data = await buildReportData(dateFrom, dateTo);
      const appName = await getCompanyName();
      // Load custom template if exists
      const { AppSetting } = require('../models');
      const tplRow = await AppSetting.findOne({ where: { key: 'report_template' } }).catch(() => null);
      const customTpl = tplRow?.value || '';
      const message = customTpl
        ? renderCustomTemplate(customTpl, data, appName, label)
        : buildReportMessage(data, appName, label, sections);
      res.json({ success: true, message, data, label, dateFrom, dateTo });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async sendNow(req, res) {
    try {
      const { range = 'this_month', sections = {}, phones: reqPhones } = req.body;
      const phonesRaw = await getSetting('admin_notify_phones', '[]');
      const phones = reqPhones?.length ? reqPhones : JSON.parse(phonesRaw || '[]');
      if (!phones.length) return res.status(400).json({ success: false, message: 'Belum ada nomor admin. Tambahkan di pengaturan.' });

      const GatewayService = require('../services/GatewayService');
      const session = await GatewayService.getDefaultSendingSession();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Tidak ada WA session terhubung' });
      }
      await GatewayService.warmSession(session.session_id);
      if (!GatewayService.isConnected(session.session_id)) {
        return res.status(400).json({ success: false, message: 'Tidak ada WA session terhubung' });
      }

      const { dateFrom, dateTo, label } = resolveRange(range);
      const data = await buildReportData(dateFrom, dateTo);
      const appName = await getCompanyName();
      const tplRowS = await AppSetting.findOne({ where: { key: 'report_template' } }).catch(() => null);
      const customTplS = tplRowS?.value || '';
      const message = customTplS
        ? renderCustomTemplate(customTplS, data, appName, 'Laporan ' + label)
        : buildReportMessage(data, appName, 'Laporan ' + label, sections);

      let sent = 0, failed = 0;
      for (const phone of phones) {
        try {
          await GatewayService.sendMessage(session.session_id, phone, message, null);
          sent++;
        } catch(e) { failed++; }
        if (phones.length > 1) await new Promise(r => setTimeout(r, 1000));
      }

      await setSetting('report_last_sent', new Date().toISOString());
      res.json({ success: true, message: `Laporan dikirim ke ${sent} nomor`, sent, failed });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }
};

// ── Render custom template ────────────────────────────────────
function renderCustomTemplate(tpl, data, appName, label) {
  const sep  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const now  = new Date().toLocaleString('id-ID');
  const period = data.dateFrom && data.dateTo
    ? moment(data.dateFrom).format('DD/MM/YYYY') + ' - ' + moment(data.dateTo).format('DD/MM/YYYY')
    : '';

  return tpl
    .replace(/\{label\}/g,        label || '')
    .replace(/\{app_name\}/g,     appName)
    .replace(/\{period\}/g,       period)
    .replace(/\{aktif_cnt\}/g,    String(data.aktif?.cnt || 0))
    .replace(/\{aktif_total\}/g,  fmtRp(data.aktif?.total_harga || 0))
    .replace(/\{bayar_cnt\}/g,    String(data.bayar?.cnt || 0))
    .replace(/\{bayar_total\}/g,  fmtRp(data.bayar?.total || 0))
    .replace(/\{unpaid_cnt\}/g,   String(data.unpaidCnt || 0))
    .replace(/\{unpaid_total\}/g, fmtRp(data.unpaidTotal || 0))
    .replace(/\{rate\}/g,         String(data.rate || 0))
    .replace(/\{due_cnt\}/g,      String(data.dueSoon?.cnt || 0))
    .replace(/\{due_total\}/g,    fmtRp(data.dueSoon?.total || 0))
    .replace(/\{total_inv\}/g,    String(data.invPeriod?.total_inv || 0))
    .replace(/\{paid_inv\}/g,     String(data.invPeriod?.paid_inv || 0))
    .replace(/\{paid_list\}/g,    (data.paidList||[]).map((p,i)=>`${i+1}. ${p.name} (${p.cid}) — ${fmtRp(p.amount)}`).join('\n') || '–')
    .replace(/\{unpaid_list\}/g,  (data.unpaidList||[]).map((p,i)=>`${i+1}. ${p.name} (${p.cid}) — ${fmtRp(p.total)} — JT: ${moment(p.due_date).format('DD/MM/YYYY')}`).join('\n') || '–')
    .replace(/\{due_today_list\}/g,(data.dueTodayList||[]).map((p,i)=>`${i+1}. ${p.name} (${p.cid}) — ${fmtRp(p.total)}`).join('\n') || 'Tidak ada')
    .replace(/\{due_list\}/g,     (data.dueSoonList||[]).map(p=>`• ${p.name} (${p.cid}) tgl ${moment(p.due_date).format('DD/MM')}`).join('\n') || 'Tidak ada')
    .replace(/\{sep\}/g,          sep)
    .replace(/\{now\}/g,          now);
}

// ── Internal helpers ──────────────────────────────────────────
function resolveRange(range, customFrom, customTo) {
  const now = moment();
  let dateFrom, dateTo, label;
  switch(range) {
    case 'this_week':
      dateFrom = now.clone().startOf('isoWeek').format('YYYY-MM-DD');
      dateTo   = now.format('YYYY-MM-DD');
      label    = 'Minggu Ini'; break;
    case 'last_week':
      dateFrom = now.clone().subtract(1,'week').startOf('isoWeek').format('YYYY-MM-DD');
      dateTo   = now.clone().subtract(1,'week').endOf('isoWeek').format('YYYY-MM-DD');
      label    = 'Minggu Lalu'; break;
    case 'this_month':
      dateFrom = now.clone().startOf('month').format('YYYY-MM-DD');
      dateTo   = now.format('YYYY-MM-DD');
      label    = now.format('MMMM YYYY'); break;
    case 'last_month':
      const lm = now.clone().subtract(1,'month');
      dateFrom = lm.startOf('month').format('YYYY-MM-DD');
      dateTo   = lm.endOf('month').format('YYYY-MM-DD');
      label    = lm.format('MMMM YYYY'); break;
    default:
      dateFrom = customFrom || now.clone().subtract(30,'days').format('YYYY-MM-DD');
      dateTo   = customTo   || now.format('YYYY-MM-DD');
      label    = moment(dateFrom).format('DD/MM/YY') + ' - ' + moment(dateTo).format('DD/MM/YY');
  }
  return { dateFrom, dateTo, label };
}

async function buildReportData(dateFrom, dateTo) {
  const today = moment().format('YYYY-MM-DD');
  const in7   = moment().add(7,'days').format('YYYY-MM-DD');

  // Total pelanggan aktif & total tagihan bulanan (dari paket)
  const [[aktif]] = await sequelize.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(p.price),0) AS total_harga
     FROM customers c LEFT JOIN packages p ON p.id=c.package_id WHERE c.status='active'`
  );

  // Invoice yang di-generate dalam periode (berdasarkan created_at invoice)
  const [[invPeriod]] = await sequelize.query(
    `SELECT COUNT(*) AS total_inv,
            SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_inv,
            COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END),0) AS paid_total,
            COALESCE(SUM(CASE WHEN status IN ('unpaid','overdue') THEN total ELSE 0 END),0) AS unpaid_total,
            SUM(CASE WHEN status IN ('unpaid','overdue') THEN 1 ELSE 0 END) AS unpaid_cnt
     FROM invoices
     WHERE period_month = MONTH(:dateFrom) AND period_year = YEAR(:dateFrom)`,
    { replacements: { dateFrom } }
  );

  // Pembayaran diterima untuk invoice PERIODE ini (basis periode invoice,
  // konsisten dgn dashboard /finance & /laporan). Tagihan Juli yang dibayar
  // di Juni tetap terhitung sebagai penerimaan Juli.
  const [[bayar]] = await sequelize.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(py.amount),0) AS total
     FROM payments py JOIN invoices i ON i.id = py.invoice_id
     WHERE i.period_month = MONTH(:dateFrom) AND i.period_year = YEAR(:dateFrom)`,
    { replacements: { dateFrom } }
  );

  // Metode pembayaran (basis periode invoice)
  const methods = await sequelize.query(
    `SELECT py.payment_method AS method, COUNT(*) AS cnt, COALESCE(SUM(py.amount),0) AS total
     FROM payments py JOIN invoices i ON i.id = py.invoice_id
     WHERE i.period_month = MONTH(:dateFrom) AND i.period_year = YEAR(:dateFrom)
     GROUP BY py.payment_method ORDER BY total DESC`,
    { replacements: { dateFrom }, type: sequelize.QueryTypes.SELECT }
  );

  // Top pembayar (basis periode invoice)
  const topPayers = await sequelize.query(
    `SELECT c.name, c.customer_id AS cid, SUM(py.amount) AS total
     FROM payments py
     JOIN invoices i ON py.invoice_id=i.id
     JOIN customers c ON c.id=i.customer_id
     WHERE i.period_month = MONTH(:dateFrom) AND i.period_year = YEAR(:dateFrom)
     GROUP BY i.customer_id ORDER BY total DESC LIMIT 5`,
    { replacements: { dateFrom }, type: sequelize.QueryTypes.SELECT }
  );

  // Jatuh tempo 7 hari ke depan (saat ini)
  const [[dueSoon]] = await sequelize.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total
     FROM invoices WHERE DATE(due_date) BETWEEN :today AND :in7
     AND status IN ('unpaid','overdue')`,
    { replacements: { today, in7 } }
  );

  // Detail: pelanggan sudah bayar untuk periode ini (basis periode invoice)
  const paidList = await sequelize.query(
    `SELECT c.name, c.customer_id AS cid, py.amount, py.payment_date
     FROM payments py
     JOIN invoices i ON py.invoice_id=i.id
     JOIN customers c ON c.id=i.customer_id
     WHERE i.period_month = MONTH(:dateFrom) AND i.period_year = YEAR(:dateFrom)
     ORDER BY py.payment_date DESC LIMIT 20`,
    { replacements: { dateFrom }, type: sequelize.QueryTypes.SELECT }
  );

  // Detail: pelanggan belum bayar periode ini
  const unpaidList = await sequelize.query(
    `SELECT c.name, c.customer_id AS cid, i.total, i.due_date, i.invoice_number
     FROM invoices i
     JOIN customers c ON c.id=i.customer_id
     WHERE i.period_month=MONTH(:dateFrom) AND i.period_year=YEAR(:dateFrom)
     AND i.status IN ('unpaid','overdue')
     ORDER BY i.due_date ASC LIMIT 20`,
    { replacements: { dateFrom }, type: sequelize.QueryTypes.SELECT }
  );

  // Detail: jatuh tempo hari ini
  const dueTodayList = await sequelize.query(
    `SELECT c.name, c.customer_id AS cid, i.total, i.invoice_number
     FROM invoices i
     JOIN customers c ON c.id=i.customer_id
     WHERE DATE(i.due_date) = :today
     AND i.status IN ('unpaid','overdue')
     ORDER BY c.name ASC LIMIT 15`,
    { replacements: { today }, type: sequelize.QueryTypes.SELECT }
  );

  // Detail: jatuh tempo 3 hari ke depan (tidak termasuk hari ini)
  const in3 = moment().add(3,'days').format('YYYY-MM-DD');
  const dueSoonList = await sequelize.query(
    `SELECT c.name, c.customer_id AS cid, i.total, i.due_date
     FROM invoices i
     JOIN customers c ON c.id=i.customer_id
     WHERE DATE(i.due_date) BETWEEN DATE_ADD(:today, INTERVAL 1 DAY) AND :in3
     AND i.status IN ('unpaid','overdue')
     ORDER BY i.due_date ASC LIMIT 15`,
    { replacements: { today, in3 }, type: sequelize.QueryTypes.SELECT }
  );

  const unpaidCnt   = parseInt(invPeriod?.unpaid_cnt  || 0);
  const unpaidTotal = parseFloat(invPeriod?.unpaid_total || 0);
  const totalInv    = parseInt(invPeriod?.total_inv   || 0);
  const paidInv     = parseInt(invPeriod?.paid_inv    || 0);
  const rate        = totalInv > 0 ? Math.round(paidInv / totalInv * 100) : 0;

  return {
    aktif,
    bayar,
    invPeriod,
    methods,
    topPayers,
    dueSoon,
    paidList,
    unpaidList,
    dueTodayList,
    dueSoonList,
    unpaidCnt,
    unpaidTotal,
    rate,
    dateFrom,
    dateTo
  };
}

function buildReportMessage(data, appName, label, sections) {
  const sep = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const now = new Date().toLocaleString('id-ID');
  let msg = '';

  // Header
  msg += `📊 *${label}*\n*${appName}*\n`;
  msg += `Periode : *${moment(data.dateFrom).format('DD/MM/YYYY')} - ${moment(data.dateTo).format('DD/MM/YYYY')}*\n${sep}`;

  // Summary
  if (sections.summary !== false) {
    msg += `\n\n*RINGKASAN TAGIHAN*\n`;
    msg += `Total Pelanggan Aktif : *${data.aktif?.cnt||0} pelanggan*\n`;
    msg += `Total Tagihan Periode : *${fmtRp(data.aktif?.total_harga||0)}*\n\n`;
    msg += `*Pembayaran Diterima*\n`;
    msg += `Transaksi  : *${data.bayar?.cnt||0} pembayaran*\n`;
    msg += `Diterima   : *${fmtRp(data.bayar?.total||0)}*\n\n`;
    msg += `*Belum Dibayar*\n`;
    msg += `Invoice    : *${data.unpaidCnt} invoice*\n`;
    msg += `Estimasi   : *${fmtRp(data.unpaidTotal)}*`;
  }

  // Collection rate
  if (sections.rate !== false) {
    msg += `\n\n${sep}\n*Collection Rate*\n`;
    msg += `${data.rate}% pelanggan sudah bayar`;
  }

  // Method breakdown
  if (sections.method && data.methods?.length) {
    const grandTotal = data.methods.reduce((a,m) => a+parseFloat(m.total), 0) || 1;
    const { methodLabel } = require('../utils/paymentMethodLabel');
    msg += `\n\n${sep}\n*Metode Pembayaran*\n`;
    data.methods.forEach(m => {
      const pct = Math.round(parseFloat(m.total)/grandTotal*100);
      msg += `• ${methodLabel(m.method)}: ${m.cnt}x - ${fmtRp(m.total)} (${pct}%)\n`;
    });
  }

  // Top payers
  if (sections.top && data.topPayers?.length) {
    msg += `\n${sep}\n*Top Pembayar*\n`;
    data.topPayers.slice(0,5).forEach((p,i) => {
      msg += `${i+1}. ${p.name} (${p.cid}) - ${fmtRp(p.total)}\n`;
    });
  }

  // Due soon
  if (sections.due) {
    msg += `\n${sep}\n*Jatuh Tempo 7 Hari ke Depan*\n`;
    msg += ` ${data.dueSoon?.cnt||0} pelanggan - ${fmtRp(data.dueSoon?.total||0)}`;
  }

  // Footer
  msg += `\n\n${sep}\n_Dikirim otomatis oleh ${appName}_\n_${now}_`;
  return msg;
}

module.exports = { templates, reminder, report, buildReportData, renderCustomTemplate, buildReportMessage, resolveRange };
