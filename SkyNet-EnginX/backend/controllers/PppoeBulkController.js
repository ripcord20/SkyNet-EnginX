/**
 * PppoeBulkController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint bulk provisioning user PPPoE ke MikroTik.
 *
 *   GET    /api/pppoe/bulk/template          — download template .xlsx
 *   POST   /api/pppoe/bulk/preview           — upload excel → validasi → buat job (pending)
 *   POST   /api/pppoe/bulk/from-customers    — buat job dari customer existing di CRM
 *   POST   /api/pppoe/bulk/:id/start         — jalankan worker (202, async)
 *   GET    /api/pppoe/bulk/:id/status        — progress polling
 *   GET    /api/pppoe/bulk/:id/items         — daftar item (paginated, filter status)
 *   POST   /api/pppoe/bulk/:id/pause         — hentikan sementara
 *   POST   /api/pppoe/bulk/:id/retry         — reset item failed → pending, jalankan lagi
 *   POST   /api/pppoe/bulk/:id/rollback      — hapus semua secret buatan job ini
 *   GET    /api/pppoe/bulk/:id/report        — export hasil .xlsx
 *   GET    /api/pppoe/bulk                   — daftar job (histori)
 *   DELETE /api/pppoe/bulk/:id               — hapus job + itemnya
 *
 * CATATAN ALUR:
 * `preview` sudah langsung membuat job dengan status 'pending' beserta seluruh
 * itemnya. Tidak pakai in-memory Map seperti CustomerImportController karena
 * batch ribuan baris terlalu besar untuk ditahan di memori, dan job harus
 * selamat dari restart server.
 */

const ExcelJS = require('exceljs');
const fs      = require('fs');
const logger  = require('../utils/logger');
const BulkService = require('../services/PppoeBulkProvisionService');

// ── Definisi kolom template Excel ────────────────────────────────────────────
const COLUMNS = [
  { key: 'username',       header: 'Username PPPoE',  required: true,  width: 24 },
  { key: 'password',       header: 'Password',        required: false, width: 18 },
  { key: 'profile',        header: 'Profile',         required: false, width: 20 },
  { key: 'service',        header: 'Service',         required: false, width: 12 },
  { key: 'remote_address', header: 'Remote Address',  required: false, width: 16 },
  { key: 'local_address',  header: 'Local Address',   required: false, width: 16 },
  { key: 'customer_id',    header: 'ID Pelanggan',    required: false, width: 16 },
  { key: 'customer_name',  header: 'Nama Pelanggan',  required: false, width: 28 },
  { key: 'comment',        header: 'Keterangan',      required: false, width: 30 },
];

const VALID_SERVICE = ['pppoe', 'pptp', 'l2tp', 'ovpn', 'sstp', 'any'];

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize username PPPoE. Lenient — mengikuti aturan yang sama dengan
 * sanitizePppoeManual() di CustomerImportController supaya konsisten:
 * izinkan huruf, angka, @ . - _ (mendukung format realm "user@isp.id").
 */
function sanitizeUsername(input) {
  if (!input) return '';
  let s = String(input).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9@.\-_]/g, '');
  return s.slice(0, 32);
}

function cellText(row, colIndex) {
  if (!colIndex) return '';
  const cell = row.getCell(colIndex);
  let v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    // Handle rich text / hyperlink / formula result
    if (v.richText) v = v.richText.map(t => t.text).join('');
    else if (v.text) v = v.text;
    else if (v.result !== undefined) v = v.result;
    else v = '';
  }
  return String(v).trim();
}

function validateIPv4(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  for (let i = 1; i <= 4; i++) {
    const o = m[i];
    if (o.length > 1 && o.startsWith('0')) return null;
    const n = parseInt(o, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
  }
  return [m[1], m[2], m[3], m[4]].map(o => parseInt(o, 10)).join('.');
}

/**
 * Ambil snapshot kondisi router: secret existing + profile yang tersedia.
 * Dipakai di tahap preview supaya operator tahu SEBELUM eksekusi:
 *   - berapa username yang akan di-skip karena sudah ada
 *   - profile mana yang belum dibuat di router
 */
async function fetchRouterSnapshot(deviceId) {
  const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
  const snap = { online: false, secrets: new Set(), profiles: new Set(), error: null };
  try {
    const mt = await getMikrotikInstanceByDevice(deviceId);
    if (!mt) throw new Error('Instance router tidak tersedia');
    const secrets = await mt.getPPPoESecrets().catch(() => []);
    (secrets || []).forEach(s => { if (s.name) snap.secrets.add(String(s.name).toLowerCase()); });
    const profiles = await mt.getPPPoEProfiles().catch(() => []);
    (profiles || []).forEach(p => { if (p.name) snap.profiles.add(p.name); });
    snap.online = true;
  } catch (e) {
    snap.error = e.message;
  }
  return snap;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pppoe/bulk/template
// ─────────────────────────────────────────────────────────────────────────────
exports.downloadTemplate = async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'FLAYNET-CRM';
    const ws = wb.addWorksheet('User PPPoE');

    ws.columns = COLUMNS.map(c => ({
      header: c.required ? `${c.header} *` : c.header,
      key: c.key,
      width: c.width,
    }));

    const hdr = ws.getRow(1);
    hdr.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    hdr.alignment = { vertical: 'middle', horizontal: 'center' };
    hdr.height = 24;

    // Baris contoh — memperjelas format yang diharapkan
    ws.addRow({
      username: 'budisantoso', password: 'abc12345', profile: '10Mbps',
      service: 'pppoe', remote_address: '', local_address: '',
      customer_id: 'CID0001', customer_name: 'Budi Santoso', comment: 'Blok A No.1',
    });
    ws.addRow({
      username: 'sitiaminah@net.id', password: '', profile: '20Mbps',
      service: 'pppoe', remote_address: '10.10.5.20', local_address: '',
      customer_id: '', customer_name: 'Siti Aminah', comment: '',
    });
    ws.getRow(2).font = { italic: true, color: { argb: 'FF94A3B8' } };
    ws.getRow(3).font = { italic: true, color: { argb: 'FF94A3B8' } };

    // Sheet panduan
    const guide = wb.addWorksheet('Panduan');
    guide.columns = [{ width: 24 }, { width: 90 }];
    const guideRows = [
      ['Kolom', 'Keterangan'],
      ['Username PPPoE *', 'WAJIB. Huruf, angka, dan @ . - _ . Otomatis lowercase. Maks 32 karakter.'],
      ['Password', 'Kosongkan untuk digenerate otomatis (8 karakter, tanpa huruf/angka ambigu).'],
      ['Profile', 'Nama PPP profile di router (mis. "10Mbps"). Kosong = "default". Profile HARUS sudah ada di router.'],
      ['Service', 'pppoe / pptp / l2tp / ovpn / sstp / any. Kosong = pppoe.'],
      ['Remote Address', 'IP static untuk user ini. Kosongkan kalau pakai IP pool dari profile.'],
      ['Local Address', 'IP gateway sisi router. Biasanya dikosongkan (ikut profile).'],
      ['ID Pelanggan', 'CID customer di CRM. Kalau diisi, setelah sukses username akan disimpan ke data customer.'],
      ['Nama Pelanggan', 'Hanya untuk memudahkan pembacaan laporan. Tidak dikirim ke router.'],
      ['Keterangan', 'Diisi ke field comment di secret MikroTik.'],
      ['', ''],
      ['CATATAN PENTING', ''],
      ['1', 'Buat dulu PPP Profile di router sebelum import. Profile yang belum ada akan membuat barisnya gagal.'],
      ['2', 'Hapus baris contoh (baris 2 dan 3) sebelum upload.'],
      ['3', 'Username yang sudah ada di router akan di-skip (atau di-overwrite, tergantung pilihan saat eksekusi).'],
      ['4', 'Untuk router kelas bawah (RB750/hAP lite), turunkan Concurrency ke 1 di opsi eksekusi.'],
    ];
    guideRows.forEach((r, i) => {
      const row = guide.addRow(r);
      if (i === 0 || r[0] === 'CATATAN PENTING') {
        row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      }
      row.alignment = { vertical: 'top', wrapText: true };
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="template-bulk-pppoe.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error('[PppoeBulk] template error: ' + err.message);
    res.status(500).json({ success: false, message: 'Gagal membuat template: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/preview   (multipart: file + device_id)
// ─────────────────────────────────────────────────────────────────────────────
exports.preview = async (req, res) => {
  let tmpPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Tidak ada file diupload' });
    }
    tmpPath = req.file.path;

    const deviceId = parseInt(req.body.device_id);
    if (!deviceId) {
      return res.status(400).json({ success: false, message: 'Router tujuan (device_id) wajib dipilih' });
    }

    const { Device, PppoeProvisionJob, PppoeProvisionItem } = require('../models');

    const device = await Device.findByPk(deviceId);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });
    }

    // ── Parse Excel ─────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(tmpPath);
    const sheet = wb.worksheets[0];
    if (!sheet) {
      return res.status(400).json({ success: false, message: 'File tidak punya sheet data' });
    }

    // Map header → index kolom
    const headerRow = sheet.getRow(1);
    const headerMap = {};
    headerRow.eachCell((cell, colIndex) => {
      const text = String(cell.value || '').trim().replace(/\s*\*\s*$/, '');
      const col = COLUMNS.find(c => c.header === text);
      if (col) headerMap[col.key] = colIndex;
    });

    if (headerMap.username == null) {
      return res.status(400).json({
        success: false,
        message: 'File harus punya kolom "Username PPPoE". Silakan download template.',
      });
    }

    // ── Snapshot router (untuk validasi duplikat & profile) ─────
    const snap = await fetchRouterSnapshot(deviceId);

    // ── Validasi baris ──────────────────────────────────────────
    const rows = [];
    const seenInFile = new Set();       // deteksi duplikat DI DALAM file
    const missingProfiles = new Set();  // profile yang belum ada di router
    let countValid = 0, countDupRouter = 0, countError = 0, countAutoPass = 0;

    const lastRow = sheet.rowCount;
    for (let r = 2; r <= lastRow; r++) {
      const row = sheet.getRow(r);

      const rawUser = cellText(row, headerMap.username);
      // Lewati baris kosong total
      const anyValue = COLUMNS.some(c => cellText(row, headerMap[c.key]));
      if (!anyValue) continue;

      const rec = {
        rowNumber: r,
        username:       sanitizeUsername(rawUser),
        password:       cellText(row, headerMap.password),
        profile:        cellText(row, headerMap.profile),
        service:        (cellText(row, headerMap.service) || 'pppoe').toLowerCase(),
        remote_address: cellText(row, headerMap.remote_address),
        local_address:  cellText(row, headerMap.local_address),
        customer_id:    cellText(row, headerMap.customer_id),
        customer_name:  cellText(row, headerMap.customer_name),
        comment:        cellText(row, headerMap.comment),
        valid: true,
        warnings: [],
        errors: [],
      };

      // Username wajib
      if (!rec.username) {
        rec.valid = false;
        rec.errors.push('Username kosong atau tidak valid setelah sanitasi');
      } else {
        if (rawUser && rec.username !== String(rawUser).toLowerCase()) {
          rec.warnings.push(`Username disesuaikan: "${rawUser}" → "${rec.username}"`);
        }
        // Duplikat di dalam file itu sendiri → error keras
        if (seenInFile.has(rec.username)) {
          rec.valid = false;
          rec.errors.push('Username duplikat di dalam file ini');
        } else {
          seenInFile.add(rec.username);
        }
      }

      // Duplikat terhadap router → warning, bukan error.
      // Perlakuannya (skip/overwrite) ditentukan saat eksekusi.
      if (rec.valid && snap.online && snap.secrets.has(rec.username)) {
        rec.warnings.push('Sudah ada di router');
        rec.duplicateOnRouter = true;
        countDupRouter++;
      }

      // Profile
      if (!rec.profile) {
        rec.profile = 'default';
        rec.warnings.push('Profile kosong → pakai "default"');
      }
      if (rec.valid && snap.online && snap.profiles.size > 0 && !snap.profiles.has(rec.profile)) {
        rec.valid = false;
        rec.errors.push(`Profile "${rec.profile}" belum ada di router`);
        missingProfiles.add(rec.profile);
      }

      // Service
      if (!VALID_SERVICE.includes(rec.service)) {
        rec.warnings.push(`Service "${rec.service}" tidak dikenal → pakai "pppoe"`);
        rec.service = 'pppoe';
      }

      // Password
      if (!rec.password) {
        rec.password = BulkService.generatePassword();
        rec.warnings.push('Password digenerate otomatis');
        countAutoPass++;
      }

      // IP
      if (rec.remote_address) {
        const ip = validateIPv4(rec.remote_address);
        if (!ip) {
          rec.valid = false;
          rec.errors.push(`Remote Address "${rec.remote_address}" bukan IPv4 valid`);
        } else rec.remote_address = ip;
      }
      if (rec.local_address) {
        const ip = validateIPv4(rec.local_address);
        if (!ip) {
          rec.valid = false;
          rec.errors.push(`Local Address "${rec.local_address}" bukan IPv4 valid`);
        } else rec.local_address = ip;
      }

      if (rec.valid) countValid++; else countError++;
      rows.push(rec);
    }

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Tidak ada baris data yang bisa dibaca' });
    }

    // ── Buat job (status pending) + itemnya ─────────────────────
    const job = await PppoeProvisionJob.create({
      device_id:   deviceId,
      device_name: device.name || `Device #${deviceId}`,
      source:      'excel',
      status:      'pending',
      total:       countValid,
      created_by:  req.user?.id || null,
      options: {
        dryRun:      false,
        onDuplicate: 'skip',
        concurrency: BulkService.DEFAULT_CONCURRENCY,
        delayMs:     BulkService.DEFAULT_DELAY_MS,
        syncToCrm:   true,
      },
    });

    // Hanya baris valid yang masuk sebagai item. Baris error ditampilkan
    // di preview tapi tidak dieksekusi.
    const validRows = rows.filter(r => r.valid);
    if (validRows.length) {
      await PppoeProvisionItem.bulkCreate(validRows.map(r => ({
        job_id:         job.id,
        row_number:     r.rowNumber,
        customer_id:    r.customer_id || null,
        customer_name:  r.customer_name || null,
        username:       r.username,
        password:       r.password,
        profile:        r.profile,
        service:        r.service,
        remote_address: r.remote_address || null,
        local_address:  r.local_address || null,
        comment:        r.comment || null,
        status:         'pending',
      })), { ignoreDuplicates: true });
    }

    return res.json({
      success: true,
      job_id: job.id,
      router: { id: deviceId, name: device.name, online: snap.online, error: snap.error },
      summary: {
        total:            rows.length,
        ready:            countValid,
        duplicateOnRouter: countDupRouter,
        error:            countError,
        autoPassword:     countAutoPass,
      },
      missing_profiles:   Array.from(missingProfiles),
      available_profiles: Array.from(snap.profiles),
      // Batasi payload preview — file ribuan baris tidak perlu dikirim semua
      rows: rows.slice(0, 200),
      truncated: rows.length > 200,
    });

  } catch (err) {
    logger.error('[PppoeBulk] preview error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Gagal memproses file: ' + err.message });
  } finally {
    // Bersihkan file upload
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/from-customers
// Body: { device_id, customer_ids: [], filter: {...}, default_profile }
//
// Untuk skenario "customer sudah ada di CRM, routernya baru" — mis. migrasi
// pelanggan ke router baru tanpa perlu bikin Excel manual.
// ─────────────────────────────────────────────────────────────────────────────
exports.fromCustomers = async (req, res) => {
  try {
    const { device_id, customer_ids, default_profile, use_package_profile } = req.body;
    const deviceId = parseInt(device_id);
    if (!deviceId) {
      return res.status(400).json({ success: false, message: 'device_id wajib diisi' });
    }

    const { Device, Customer, Package, PppoeProvisionJob, PppoeProvisionItem } = require('../models');
    const { Op } = require('sequelize');

    const device = await Device.findByPk(deviceId);
    if (!device) return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });

    const where = { pppoe_username: { [Op.ne]: null } };
    if (Array.isArray(customer_ids) && customer_ids.length) {
      where.customer_id = { [Op.in]: customer_ids };
    }

    const customers = await Customer.findAll({
      where,
      attributes: ['customer_id', 'name', 'pppoe_username', 'package_id', 'static_ip'],
      raw: true,
    });

    if (!customers.length) {
      return res.status(400).json({
        success: false,
        message: 'Tidak ada customer dengan username PPPoE yang cocok',
      });
    }

    // Mapping paket → profile MikroTik.
    // Butuh kolom packages.mikrotik_profile (lihat migration).
    const pkgProfile = new Map();
    if (use_package_profile !== false) {
      const pkgs = await Package.findAll({ attributes: ['id', 'name', 'mikrotik_profile'], raw: true })
        .catch(() => []);
      pkgs.forEach(p => {
        if (p.mikrotik_profile) pkgProfile.set(p.id, p.mikrotik_profile);
      });
    }

    const snap = await fetchRouterSnapshot(deviceId);

    const job = await PppoeProvisionJob.create({
      device_id:   deviceId,
      device_name: device.name || `Device #${deviceId}`,
      source:      'customers',
      status:      'pending',
      total:       customers.length,
      created_by:  req.user?.id || null,
      options: {
        dryRun: false, onDuplicate: 'skip',
        concurrency: BulkService.DEFAULT_CONCURRENCY,
        delayMs: BulkService.DEFAULT_DELAY_MS,
        syncToCrm: true,
      },
    });

    const seen = new Set();
    const items = [];
    let droppedIps = 0;
    for (const c of customers) {
      const uname = sanitizeUsername(c.pppoe_username);
      if (!uname || seen.has(uname)) continue;
      seen.add(uname);
      // Validasi static_ip dari DB — nilainya bisa kotor (mis. "10.0.0.5/24",
      // "dhcp", atau spasi) dan kalau diteruskan mentah, router menolak create.
      // Jalur Excel juga memvalidasi ketat, jadi samakan perilakunya. IP tak
      // valid dikosongkan (user tetap dibuat, IP ikut pool) — bukan menggagalkan
      // seluruh baris hanya karena satu field opsional.
      let remoteIp = null;
      if (c.static_ip) {
        remoteIp = validateIPv4(c.static_ip);
        if (!remoteIp) droppedIps++;
      }
      items.push({
        job_id:         job.id,
        customer_id:    c.customer_id,
        customer_name:  c.name,
        username:       uname,
        password:       BulkService.generatePassword(),
        profile:        pkgProfile.get(c.package_id) || default_profile || 'default',
        service:        'pppoe',
        remote_address: remoteIp,
        comment:        `${c.customer_id} - ${c.name || ''}`.slice(0, 128),
        status:         'pending',
      });
    }

    // Semua customer ternyata duplikat/username invalid → tidak ada yang
    // bisa dibuat. Hapus job kosong supaya tidak jadi "hantu" di histori
    // (konsisten dengan jalur Excel yang menolak file tanpa baris valid).
    if (!items.length) {
      await job.destroy().catch(() => {});
      return res.status(400).json({
        success: false,
        message: 'Tidak ada username PPPoE unik yang bisa diproses dari customer terpilih',
      });
    }

    await PppoeProvisionItem.bulkCreate(items, { ignoreDuplicates: true });
    await job.update({ total: items.length });

    const dupCount = snap.online
      ? items.filter(i => snap.secrets.has(i.username)).length
      : 0;

    return res.json({
      success: true,
      job_id: job.id,
      router: { id: deviceId, name: device.name, online: snap.online },
      summary: { total: items.length, duplicateOnRouter: dupCount, invalidStaticIp: droppedIps },
      available_profiles: Array.from(snap.profiles),
    });

  } catch (err) {
    logger.error('[PppoeBulk] fromCustomers error: ' + err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/create-profiles
// Body: { device_id, profiles: [{ name, rateLimit, localAddress, remoteAddress }] }
//
// Membuat PPP profile yang belum ada di router, langsung dari dialog
// pratinjau. Tanpa ini operator harus membuka Winbox, membuat profile
// satu per satu, lalu mengulang upload dari awal.
// ─────────────────────────────────────────────────────────────────────────────
exports.createProfiles = async (req, res) => {
  try {
    const deviceId = parseInt(req.body?.device_id);
    const profiles = Array.isArray(req.body?.profiles) ? req.body.profiles : [];

    if (!deviceId) {
      return res.status(400).json({ success: false, message: 'device_id wajib diisi' });
    }
    if (!profiles.length) {
      return res.status(400).json({ success: false, message: 'Tidak ada profile untuk dibuat' });
    }
    if (profiles.length > 50) {
      return res.status(400).json({ success: false, message: 'Maksimal 50 profile per operasi' });
    }

    const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
    const mt = await getMikrotikInstanceByDevice(deviceId);
    if (!mt) return res.status(502).json({ success: false, message: 'Router tidak bisa dihubungi' });

    // Ambil daftar profile yang sudah ada — jangan buat ulang kalau
    // ternyata sudah dibuat orang lain sejak pratinjau dibuka.
    const existing = new Set(
      (await mt.getPPPoEProfiles().catch(() => [])).map(p => p.name).filter(Boolean)
    );

    const result = { created: [], skipped: [], failed: [] };

    for (const p of profiles) {
      const name = String(p?.name || '').trim();
      if (!name) continue;

      if (existing.has(name)) {
        result.skipped.push({ name, reason: 'Sudah ada di router' });
        continue;
      }

      try {
        await mt.createPPPoEProfile({
          name,
          rateLimit:     p.rateLimit || undefined,
          localAddress:  p.localAddress || undefined,
          remoteAddress: p.remoteAddress || undefined,
          comment:       p.comment || 'Dibuat via FLAYNET bulk provisioning',
        });
        existing.add(name);
        result.created.push({ name, rateLimit: p.rateLimit || null });
        // Jeda kecil — sama alasannya dengan create secret: jangan
        // membanjiri router dengan write beruntun.
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        result.failed.push({ name, message: e.message });
        logger.warn(`[PppoeBulk] createProfile ${name}: ${e.message}`);
      }
    }

    const parts = [];
    if (result.created.length) parts.push(`${result.created.length} profile dibuat`);
    if (result.skipped.length) parts.push(`${result.skipped.length} sudah ada`);
    if (result.failed.length)  parts.push(`${result.failed.length} gagal`);

    return res.json({
      success: result.failed.length === 0,
      message: parts.join(', ') || 'Tidak ada perubahan',
      data: result,
      // Kirim daftar terbaru supaya UI bisa memperbarui tanpa panggilan lagi
      available_profiles: Array.from(existing),
    });
  } catch (err) {
    logger.error('[PppoeBulk] createProfiles error: ' + err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/:id/revalidate
// Jalankan ulang validasi profile terhadap kondisi router terkini.
// Dipanggil setelah profile baru dibuat, supaya baris yang tadinya gagal
// bisa ikut diproses tanpa upload ulang file.
// ─────────────────────────────────────────────────────────────────────────────
exports.revalidate = async (req, res) => {
  try {
    const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');
    const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');

    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    if (job.status === 'running') {
      return res.status(409).json({ success: false, message: 'Job sedang berjalan' });
    }

    const mt = await getMikrotikInstanceByDevice(job.device_id);
    if (!mt) return res.status(502).json({ success: false, message: 'Router tidak bisa dihubungi' });

    const profiles = new Set(
      (await mt.getPPPoEProfiles().catch(() => [])).map(p => p.name).filter(Boolean)
    );

    // Item yang gagal karena profile tidak ada, padahal sekarang profilenya
    // sudah tersedia → kembalikan ke antrian.
    const failed = await PppoeProvisionItem.findAll({
      where: { job_id: job.id, status: 'failed' },
    });

    let restored = 0;
    for (const it of failed) {
      const isProfileError = /Profile ".*" tidak ada di router/.test(it.error || '');
      if (!isProfileError) continue;
      if (!profiles.has(it.profile || 'default')) continue;

      await it.update({ status: 'pending', error: null, attempts: 0 });
      restored++;
    }

    if (restored) {
      const stillFailed = await PppoeProvisionItem.count({ where: { job_id: job.id, status: 'failed' } });
      await job.update({ failed: stillFailed });
    }

    return res.json({
      success: true,
      message: restored
        ? `${restored} baris dikembalikan ke antrian — profilenya sudah tersedia sekarang`
        : 'Tidak ada baris yang bisa dipulihkan',
      data: { restored, available_profiles: Array.from(profiles) },
    });
  } catch (err) {
    logger.error('[PppoeBulk] revalidate error: ' + err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/:id/start
// Balas 202 langsung — worker jalan di background.
// ─────────────────────────────────────────────────────────────────────────────
exports.start = async (req, res) => {
  try {
    const { PppoeProvisionJob } = require('../models');
    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });

    if (job.status === 'running') {
      return res.status(409).json({ success: false, message: 'Job sedang berjalan' });
    }
    if (job.status === 'done') {
      return res.status(409).json({ success: false, message: 'Job sudah selesai. Gunakan Retry untuk mengulang yang gagal.' });
    }

    // Terapkan opsi yang dikirim dari UI
    const incoming = req.body || {};
    const opts = Object.assign({}, job.options || {}, {
      dryRun:      incoming.dryRun === true,
      onDuplicate: incoming.onDuplicate === 'overwrite' ? 'overwrite' : 'skip',
      concurrency: Math.max(1, Math.min(10, parseInt(incoming.concurrency) || BulkService.DEFAULT_CONCURRENCY)),
      // parseInt() mengembalikan NaN (bukan null), jadi ?? tidak menangkapnya —
      // pakai Number.isFinite untuk fallback yang benar. Tanpa ini delayMs
      // tersimpan NaN saat field kosong dan tampil rusak di UI/laporan.
      delayMs:     (() => {
        const d = parseInt(incoming.delayMs, 10);
        return Number.isFinite(d) ? Math.max(0, d) : BulkService.DEFAULT_DELAY_MS;
      })(),
      syncToCrm:   incoming.syncToCrm !== false,
      // Throttle adaptif aktif secara default — matikan hanya kalau operator
      // ingin laju tetap persis seperti yang dipilih.
      adaptiveThrottle: incoming.adaptiveThrottle !== false,
      verifyAfter:      incoming.verifyAfter !== false,
    });
    // ── Penjadwalan ────────────────────────────────────────────
    // Kalau scheduled_at dikirim dan waktunya di masa depan, job tidak
    // langsung jalan — scheduler di CronService yang akan menjalankannya.
    const rawSchedule = incoming.scheduledAt || incoming.scheduled_at;
    if (rawSchedule) {
      const when = new Date(rawSchedule);
      if (isNaN(when.getTime())) {
        return res.status(400).json({ success: false, message: 'Format waktu jadwal tidak valid' });
      }
      // Toleransi 60 detik untuk selisih jam klien-server
      if (when.getTime() > Date.now() + 60000) {
        await job.update({ options: opts, status: 'scheduled', scheduled_at: when, error_message: null });
        return res.status(202).json({
          success: true,
          scheduled: true,
          message: `Job dijadwalkan pada ${when.toLocaleString('id-ID')}`,
          job_id: job.id,
          scheduled_at: when,
          options: opts,
        });
      }
      // Waktu sudah lewat atau terlalu dekat → jalankan sekarang saja
    }

    await job.update({ options: opts, status: 'pending', scheduled_at: null });

    // FIRE AND FORGET — jangan di-await, HTTP request harus balas sekarang.
    BulkService.runJob(job.id).catch(e =>
      logger.error(`[PppoeBulk] runJob#${job.id} unhandled: ${e.message}`)
    );

    return res.status(202).json({
      success: true,
      message: 'Job dijalankan di background',
      job_id: job.id,
      options: opts,
    });
  } catch (err) {
    logger.error('[PppoeBulk] start error: ' + err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/:id/unschedule — batalkan jadwal, kembalikan ke pending
// ─────────────────────────────────────────────────────────────────────────────
exports.unschedule = async (req, res) => {
  try {
    const { PppoeProvisionJob } = require('../models');
    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    if (job.status !== 'scheduled') {
      return res.status(409).json({ success: false, message: 'Job ini tidak sedang dijadwalkan' });
    }
    await job.update({ status: 'pending', scheduled_at: null, error_message: null });
    return res.json({ success: true, message: 'Jadwal dibatalkan — job kembali menunggu' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pppoe/bulk/:id/status
// ─────────────────────────────────────────────────────────────────────────────
exports.status = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');

    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });

    const pending = await PppoeProvisionItem.count({ where: { job_id: job.id, status: 'pending' } });
    const processed = job.succeeded + job.failed + job.skipped;
    const total = job.total || (processed + pending);
    const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

    // Estimasi sisa waktu berdasarkan throughput aktual
    let etaSeconds = null;
    if (job.status === 'running' && job.started_at && processed > 0 && pending > 0) {
      const elapsed = (Date.now() - new Date(job.started_at).getTime()) / 1000;
      etaSeconds = Math.round((elapsed / processed) * pending);
    }

    return res.json({
      success: true,
      data: {
        id: job.id,
        status: job.status,
        device_id: job.device_id,
        device_name: job.device_name,
        total,
        succeeded: job.succeeded,
        failed: job.failed,
        skipped: job.skipped,
        pending,
        processed,
        percent,
        eta_seconds: etaSeconds,
        options: job.options,
        // Hasil verifikasi pasca-job & status throttle adaptif —
        // dipakai UI untuk menampilkan peringatan kalau ada selisih.
        verification: job.verification || null,
        throttle: (job.options && job.options.throttleState) || null,
        scheduled_at: job.scheduled_at || null,
        error_message: job.error_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pppoe/bulk/:id/items?status=failed&page=1&limit=50
// ─────────────────────────────────────────────────────────────────────────────
exports.items = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { PppoeProvisionItem } = require('../models');

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const where = { job_id: req.params.id };
    if (req.query.status && req.query.status !== 'all') {
      where.status = req.query.status;
    }

    const { rows, count } = await PppoeProvisionItem.findAndCountAll({
      where,
      order: [['id', 'ASC']],
      offset: (page - 1) * limit,
      limit,
      attributes: { exclude: ['password'] }, // jangan bocorkan password di listing
    });

    return res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/:id/pause
// Worker mengecek status job setiap batch, jadi pause berlaku dalam <1 detik.
// ─────────────────────────────────────────────────────────────────────────────
exports.pause = async (req, res) => {
  try {
    const { PppoeProvisionJob } = require('../models');
    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    if (job.status !== 'running') {
      return res.status(409).json({ success: false, message: 'Job tidak sedang berjalan' });
    }
    await job.update({ status: 'paused' });
    return res.json({ success: true, message: 'Job dihentikan sementara' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/:id/retry
// Reset item 'failed' → 'pending' lalu jalankan lagi.
// Item 'ok' tidak disentuh, jadi tidak ada duplikat.
// ─────────────────────────────────────────────────────────────────────────────
exports.retry = async (req, res) => {
  try {
    const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');
    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    if (job.status === 'running') {
      return res.status(409).json({ success: false, message: 'Job sedang berjalan' });
    }

    const target = { job_id: job.id, status: 'failed' };
    // Opsional: ikut retry yang di-skip (mis. setelah ganti mode ke overwrite)
    if (req.body?.includeSkipped) {
      target.status = ['failed', 'skipped'];
    }

    const [affected] = await PppoeProvisionItem.update(
      { status: 'pending', error: null, attempts: 0 },
      { where: target }
    );

    if (!affected) {
      return res.status(400).json({ success: false, message: 'Tidak ada item yang perlu diulang' });
    }

    if (req.body?.onDuplicate) {
      await job.update({
        options: Object.assign({}, job.options || {}, { onDuplicate: req.body.onDuplicate }),
      });
    }
    await job.update({ status: 'pending', finished_at: null });

    BulkService.runJob(job.id).catch(e =>
      logger.error(`[PppoeBulk] retry job#${job.id}: ${e.message}`)
    );

    return res.status(202).json({ success: true, message: `${affected} item diulang`, retried: affected });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/:id/verify
// Verifikasi ulang secara manual — berguna kalau operator curiga ada
// perubahan di router setelah job selesai (mis. secret dihapus manual),
// atau untuk job lama yang dijalankan sebelum fitur verifikasi ada.
// ─────────────────────────────────────────────────────────────────────────────
exports.verify = async (req, res) => {
  try {
    const { PppoeProvisionJob } = require('../models');
    const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');

    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    if (job.status === 'running') {
      return res.status(409).json({ success: false, message: 'Tunggu job selesai sebelum verifikasi' });
    }

    const mt = await getMikrotikInstanceByDevice(job.device_id);
    if (!mt) return res.status(502).json({ success: false, message: 'Router tidak bisa dihubungi' });

    const result = await BulkService.verifyJob(job.id, mt);
    await job.update({ verification: result });

    // Item yang hilang dikembalikan ke 'pending' oleh verifyJob,
    // jadi hitung ulang counter supaya konsisten.
    const { PppoeProvisionItem } = require('../models');
    const stillOk = await PppoeProvisionItem.count({ where: { job_id: job.id, status: 'ok' } });
    await job.update({ succeeded: stillOk });

    return res.json({
      success: true,
      message: result.missing
        ? `Verifikasi: ${result.confirmed} terkonfirmasi, ${result.missing} tidak ditemukan di router (siap diulang)`
        : `Verifikasi: semua ${result.confirmed} secret terkonfirmasi ada di router`,
      data: result,
    });
  } catch (err) {
    logger.error('[PppoeBulk] verify error: ' + err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pppoe/bulk/:id/rollback
// ─────────────────────────────────────────────────────────────────────────────
exports.rollback = async (req, res) => {
  try {
    const { PppoeProvisionJob } = require('../models');
    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    if (job.status === 'running') {
      return res.status(409).json({ success: false, message: 'Hentikan job dulu sebelum rollback' });
    }

    const stats = await BulkService.rollbackJob(job.id);

    // Susun pesan yang mencerminkan hasil sebenarnya — jangan bilang
    // "selesai" kalau ternyata tidak ada yang terhapus.
    const parts = [`${stats.deleted} secret dihapus`];
    if (stats.failed)   parts.push(`${stats.failed} gagal dihapus`);
    if (stats.notFound) parts.push(`${stats.notFound} tidak ditemukan di router`);
    if (stats.skipped)  parts.push(`${stats.skipped} dilewati`);

    return res.json({
      success: stats.failed === 0,
      message: (stats.deleted === 0 && stats.failed === 0 && stats.notFound === 0)
        ? (stats.message || 'Tidak ada yang perlu di-rollback')
        : 'Rollback: ' + parts.join(', '),
      stats,
    });
  } catch (err) {
    logger.error('[PppoeBulk] rollback error: ' + err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pppoe/bulk/:id/report  → .xlsx
// ─────────────────────────────────────────────────────────────────────────────
exports.report = async (req, res) => {
  try {
    const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');
    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });

    const items = await PppoeProvisionItem.findAll({
      where: { job_id: job.id },
      order: [['id', 'ASC']],
      raw: true,
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'FLAYNET-CRM';

    // Sheet ringkasan
    const sum = wb.addWorksheet('Ringkasan');
    sum.columns = [{ width: 24 }, { width: 40 }];
    [
      ['Job ID', job.id],
      ['Router', job.device_name || job.device_id],
      ['Status', job.status],
      ['Total', job.total],
      ['Berhasil', job.succeeded],
      ['Dilewati', job.skipped],
      ['Gagal', job.failed],
      ['Mulai', job.started_at ? new Date(job.started_at).toLocaleString('id-ID') : '-'],
      ['Selesai', job.finished_at ? new Date(job.finished_at).toLocaleString('id-ID') : '-'],
      ['Mode duplikat', job.options?.onDuplicate || 'skip'],
      ['Dry run', job.options?.dryRun ? 'Ya' : 'Tidak'],
    ].forEach(r => sum.addRow(r));
    sum.getColumn(1).font = { bold: true };

    // Sheet detail — password disertakan karena banyak yang digenerate otomatis
    // dan teknisi butuh ini untuk setup di sisi pelanggan.
    const ws = wb.addWorksheet('Detail');
    ws.columns = [
      { header: 'Baris',       key: 'row_number',    width: 8 },
      { header: 'Username',    key: 'username',      width: 24 },
      { header: 'Password',    key: 'password',      width: 16 },
      { header: 'Profile',     key: 'profile',       width: 18 },
      { header: 'Service',     key: 'service',       width: 10 },
      { header: 'Remote IP',   key: 'remote_address',width: 16 },
      { header: 'ID Pelanggan',key: 'customer_id',   width: 14 },
      { header: 'Nama',        key: 'customer_name', width: 26 },
      { header: 'Status',      key: 'status',        width: 12 },
      { header: 'MikroTik ID', key: 'mikrotik_id',   width: 12 },
      { header: 'Keterangan',  key: 'error',         width: 50 },
    ];
    const hdr = ws.getRow(1);
    hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };

    const COLOR = { ok: 'FFDCFCE7', failed: 'FFFEE2E2', skipped: 'FFFEF3C7', pending: 'FFF1F5F9' };
    items.forEach(it => {
      const row = ws.addRow(it);
      const c = COLOR[it.status];
      if (c) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c } };
        });
      }
    });
    ws.autoFilter = { from: 'A1', to: 'K1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="laporan-bulk-pppoe-${job.id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error('[PppoeBulk] report error: ' + err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pppoe/bulk  — histori job
// ─────────────────────────────────────────────────────────────────────────────
exports.list = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { PppoeProvisionJob } = require('../models');

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const where = {};
    if (req.query.device_id) where.device_id = parseInt(req.query.device_id);
    if (req.query.status)    where.status    = req.query.status;

    const { rows, count } = await PppoeProvisionJob.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      offset: (page - 1) * limit,
      limit,
    });

    return res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/pppoe/bulk/:id
// Hanya menghapus catatan job di CRM — tidak menyentuh secret di router.
// Untuk menghapus secretnya, gunakan Rollback dulu.
// ─────────────────────────────────────────────────────────────────────────────
exports.destroy = async (req, res) => {
  try {
    const { PppoeProvisionJob, PppoeProvisionItem } = require('../models');
    const job = await PppoeProvisionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    if (job.status === 'running') {
      return res.status(409).json({ success: false, message: 'Hentikan job dulu sebelum menghapus' });
    }

    await PppoeProvisionItem.destroy({ where: { job_id: job.id } });
    await job.destroy();

    return res.json({ success: true, message: 'Job dihapus' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
