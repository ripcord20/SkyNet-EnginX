/**
 * CustomerImportController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint untuk import & export data customer via Excel.
 *
 * Fitur:
 *   - GET    /api/customers/export          — download semua customer sebagai .xlsx
 *   - GET    /api/customers/import-template — download template kosong .xlsx
 *   - POST   /api/customers/import-preview  — parse upload file, return preview JSON
 *   - POST   /api/customers/import-confirm  — eksekusi import setelah preview
 */

const ExcelJS = require('exceljs');
const path    = require('path');
const fs      = require('fs');
const logger  = require('../utils/logger');

// Kolom yang ada di Excel (urutan = urutan di sheet)
// `required: true` = wajib diisi user. `customer_id` boleh kosong → auto-generate.
// `pppoe_username` juga boleh kosong → auto-generate dari Nama (sanitize: huruf+angka, lowercase).
// `router_name` boleh kosong → backend akan coba auto-detect router dari pppoe_username
//   (cari di router mana secret dengan nama itu berada).
// `static_ip` untuk customer dengan IP static (bukan PPPoE). Format IPv4.
//   Sistem akan cek ARP semua router untuk auto-detect mikrotik_id.
const COLUMNS = [
  { key: 'customer_id',       header: 'ID Pelanggan',       required: false, width: 16 },
  { key: 'name',              header: 'Nama',               required: true,  width: 30 },
  { key: 'pppoe_username',    header: 'Username PPPoE',     required: false, width: 22 },
  { key: 'static_ip',         header: 'Static IP',          required: false, width: 16 },
  { key: 'mac_address',       header: 'MAC Perangkat',      required: false, width: 20 },
  { key: 'router_name',       header: 'Router MikroTik',    required: false, width: 22 },
  { key: 'phone',             header: 'No. HP',             required: false, width: 16 },
  { key: 'email',             header: 'Email',              required: false, width: 28 },
  { key: 'address',           header: 'Alamat',             required: false, width: 40 },
  { key: 'package_name',      header: 'Nama Paket',         required: false, width: 18 },
  { key: 'status',            header: 'Status',             required: false, width: 12 },
  { key: 'latitude',          header: 'Latitude',           required: false, width: 12 },
  { key: 'longitude',         header: 'Longitude',          required: false, width: 12 },
  { key: 'infra_parent_name', header: 'Parent ODP',         required: false, width: 18 },
  { key: 'ont_sn',            header: 'ONT Serial Number',  required: false, width: 22 },
  { key: 'ont_mac',           header: 'ONT MAC Address',    required: false, width: 18 },
  { key: 'installation_date', header: 'Tanggal Instalasi',  required: false, width: 14 },
  { key: 'notes',             header: 'Catatan',            required: false, width: 30 },
];

const VALID_STATUS = ['active', 'inactive', 'isolated', 'suspended'];

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: slugify nama jadi PPPoE username (sinkron dengan helper di
// frontend `customers.js → _slugifyForPppoe`). Aturannya:
//   - normalisasi diakritik (é → e, ñ → n)
//   - lowercase
//   - hanya huruf a-z dan angka 0-9; semua karakter lain di-drop
//   - max 32 char
//
// CATATAN: function ini HANYA dipakai untuk AUTO-GENERATE dari Nama
// (output bersih & predictable). Untuk input MANUAL user, pakai
// `sanitizePppoeManual` yang lebih lenient (izinkan @ . - _).
//
// Contoh: "Budi Santoso"  → "budisantoso"
//         "PT. Maju Jaya" → "ptmajujaya"
// ─────────────────────────────────────────────────────────────────────────────
function slugifyForPppoe(name) {
  if (!name) return '';
  let s = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.slice(0, 32);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: sanitize INPUT MANUAL user (dari kolom Excel) jadi PPPoE username
// yang valid untuk MikroTik. Lebih lenient dari `slugifyForPppoe`:
//   - normalisasi diakritik
//   - lowercase
//   - karakter yang DIIZINKAN: a-z, 0-9, @, ., -, _
//     (mendukung format realm-style seperti "avinda@net.id")
//   - karakter lain (spasi, ', ", /, dll) di-drop
//   - max 32 char
//
// Contoh: "avinda@net.id"      → "avinda@net.id"  (unchanged)
//         "User.Name-01"       → "user.name-01"
//         "apinda@dsr"         → "apinda@dsr"     (unchanged, sebelumnya jadi "apindadsr")
//         "budi santoso"       → "budisantoso"    (spasi tetap dibuang)
//         "USER@DOMAIN.ID"     → "user@domain.id" (di-lowercase)
// ─────────────────────────────────────────────────────────────────────────────
function sanitizePppoeManual(input) {
  if (!input) return '';
  let s = String(input).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Izinkan: huruf, angka, @, ., -, _
  s = s.toLowerCase().replace(/[^a-z0-9@.\-_]/g, '');
  return s.slice(0, 32);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: validasi IPv4 dasar.
// Return null kalau invalid, atau string IP yang sudah dinormalisasi
// (trim + tanpa leading zero di tiap octet).
//
// Diterima: "192.168.1.10", "10.0.0.1", "172.16.5.100"
// Ditolak: "192.168.1.256" (>255), "192.168.1" (cuma 3 octet),
//          "abc.def.ghi.jkl", "192.168.01.10" (leading zero curiga),
//          "192.168.1.10/24" (CIDR — buang prefix dulu kalau mau)
// ─────────────────────────────────────────────────────────────────────────────
function validateIPv4(input) {
  if (!input) return null;
  const s = String(input).trim();
  // Cocokkan dengan regex 4 octet
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]];
  // Validasi setiap octet
  for (const o of octets) {
    // Tolak leading zero kecuali "0" itu sendiri ("00", "01" tidak boleh)
    if (o.length > 1 && o.startsWith('0')) return null;
    const n = parseInt(o, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
  }
  // Return normalized (re-join supaya konsisten)
  return octets.map(o => parseInt(o, 10)).join('.');
}

// Validasi & normalisasi MAC address → uppercase, separator ':'.
// Terima format: AA:BB:CC:DD:EE:FF, AA-BB-..., aabbccddeeff.
// Return null kalau bukan MAC valid (12 hex digit).
function validateMac(input) {
  if (!input) return null;
  const hex = String(input).trim().replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.toUpperCase().match(/.{2}/g).join(':');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: pastikan PPPoE username unik (tidak bentrok dengan customer lain
// di DB maupun dengan baris yang sudah diparse di file Excel ini).
// Kalau bentrok, append angka: budisantoso → budisantoso2, budisantoso3, ...
//
// Param:
//   - base:              username hasil slugify
//   - existingDbSet:     Set berisi semua pppoe_username yang sudah ada di DB
//   - takenInFileSet:    Set berisi username yang sudah dipakai baris-baris
//                        sebelumnya di file ini
//   - excludeCustomerId: customer_id baris ini (kalau action 'update', jangan
//                        anggap username dirinya sendiri sebagai konflik)
//   - dbUsernameToCid:   Map<pppoe_username, customer_id> untuk cek exclude
// ─────────────────────────────────────────────────────────────────────────────
function uniqifyPppoeUsername(base, existingDbSet, takenInFileSet, excludeCustomerId, dbUsernameToCid) {
  if (!base) return '';
  const conflict = (cand) => {
    if (takenInFileSet.has(cand)) return true;
    if (existingDbSet.has(cand)) {
      // Kecuali username itu memang milik customer yang sama (mode update)
      if (excludeCustomerId && dbUsernameToCid.get(cand) === excludeCustomerId) return false;
      return true;
    }
    return false;
  };

  if (!conflict(base)) return base;
  for (let n = 2; n <= 999; n++) {
    const cand = (base + n).slice(0, 32);
    if (!conflict(cand)) return cand;
  }
  // Fallback super jarang — pakai timestamp suffix
  return (base + Date.now().toString().slice(-4)).slice(0, 32);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — generate Excel berisi semua customer
// ─────────────────────────────────────────────────────────────────────────────
exports.exportExcel = async (req, res) => {
  try {
    const { Customer, Package, Device, sequelize } = require('../models');

    // Ambil semua customer dengan relasi paket
    const customers = await Customer.findAll({
      include: [{ model: Package, as: 'package', attributes: ['name'] }],
      order: [['customer_id', 'ASC']],
    });

    // Ambil daftar router (Device tipe router) untuk lookup id → name
    // supaya kolom Router MikroTik di Excel ter-isi nama, bukan id mentah.
    // PENTING: customers.mikrotik_id berisi mikrotik_devices.id (bukan devices.id),
    // jadi map harus di-key dengan mikrotik_devices.id → nama device master.
    const routers = await Device.findAll({
      where: { type: 'router' },
      attributes: ['id', 'name'],
      raw: true,
    });
    const deviceIdToName = new Map(routers.map(r => [r.id, r.name]));
    // Join mikrotik_devices → devices untuk dapat mikrotik_devices.id → nama.
    const routerIdToName = new Map();
    try {
      const mdRows = await sequelize.query(
        'SELECT id, device_id FROM mikrotik_devices',
        { type: sequelize.QueryTypes.SELECT }
      );
      mdRows.forEach(md => {
        const nm = deviceIdToName.get(md.device_id);
        if (nm) routerIdToName.set(md.id, nm);
      });
    } catch (_) { /* tabel belum ada → biarkan kosong */ }

    // Ambil daftar ODP/ODC/POP untuk lookup infra_parent_id → name
    // supaya kolom Parent ODP di Excel ter-isi nama induk yang readable.
    const { InfrastructurePoint } = require('../models');
    const infraParents = await InfrastructurePoint.findAll({
      where: { type: ['odp', 'odc', 'pop'] },
      attributes: ['id', 'name', 'type'],
      raw: true,
    });
    const infraParentIdToName = new Map(
      infraParents.map(p => [p.id, p.name])
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DIGSnet';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Customers');

    // Header row
    sheet.columns = COLUMNS.map(c => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));

    // Style header
    sheet.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A6EF5' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } };
    });
    sheet.getRow(1).height = 24;

    // Data rows
    customers.forEach(c => {
      sheet.addRow({
        customer_id:        c.customer_id,
        name:               c.name,
        pppoe_username:     c.pppoe_username || '',
        static_ip:          c.static_ip || '',
        mac_address:        c.mac_address || '',
        router_name:        c.mikrotik_id ? (routerIdToName.get(c.mikrotik_id) || '') : '',
        phone:              c.phone || '',
        email:              c.email || '',
        address:            c.address || '',
        package_name:       c.package?.name || '',
        status:             c.status || 'active',
        latitude:           c.latitude || '',
        longitude:          c.longitude || '',
        infra_parent_name:  c.infra_parent_id ? (infraParentIdToName.get(c.infra_parent_id) || '') : '',
        ont_sn:             c.ont_sn || '',
        ont_mac:            c.ont_mac || '',
        installation_date:  c.installation_date || '',
        notes:              c.notes || '',
      });
    });

    // Format kolom tertentu
    sheet.getColumn('latitude').numFmt = '0.00000000';
    sheet.getColumn('longitude').numFmt = '0.00000000';

    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // Set response headers
    const filename = `customers-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error('[CustomerImport] Export failed:', err);
    res.status(500).json({ success: false, message: 'Gagal export: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE — generate Excel kosong dengan header + contoh
// ─────────────────────────────────────────────────────────────────────────────
exports.downloadTemplate = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DIGSnet';
    const sheet = workbook.addWorksheet('Customers');

    sheet.columns = COLUMNS.map(c => ({
      header: c.header + (c.required ? ' *' : ''),
      key: c.key,
      width: c.width,
    }));

    // Style header
    sheet.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A6EF5' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    sheet.getRow(1).height = 24;

    // Contoh row 1 — router diisi eksplisit
    sheet.addRow({
      customer_id:        'CUST001',
      name:               'Budi Santoso',
      pppoe_username:     'budisantoso',
      router_name:        'CHR-CLOUD',
      phone:              '081234567890',
      email:              'budi@example.com',
      address:            'Jl. Mawar No. 5, Jakarta',
      package_name:       'Home 20Mbps',
      status:             'active',
      latitude:           -6.200000,
      longitude:          106.816666,
      infra_parent_name:  'ODP-01',
      ont_sn:             'HWTC12345678',
      ont_mac:            '00:11:22:33:44:55',
      installation_date:  '2024-01-15',
      notes:              'Router diisi eksplisit dengan nama dari Device Management',
    });

    // Contoh row 2 — router kosong (akan auto-detect dari pppoe_username)
    sheet.addRow({
      customer_id:        'CUST002',
      name:               'Siti Rahmawati',
      pppoe_username:     'siti@home.id',
      // router_name sengaja kosong → backend cari di router mana secret "siti@home.id" berada
      phone:              '081298765432',
      status:             'active',
      notes:              'Router auto-detect: backend cari di semua router, secret ada di router mana → auto set',
    });

    // Contoh row 3 — semua minimal (ID, PPPoE, router akan auto)
    sheet.addRow({
      // customer_id sengaja kosong → auto-generate (CID001, CID002, ...)
      name:               'Ahmad (ID auto)',
      // pppoe_username sengaja kosong → auto-generate dari Nama ("ahmadidauto")
      // router_name kosong → auto-detect (kemungkinan tidak ketemu kalau secret belum dibuat)
      phone:              '081311112222',
      status:             'active',
      notes:              'ID & PPPoE username akan dibuat otomatis dari Nama',
    });

    // Contoh row 4 — customer dengan IP Static (bukan PPPoE)
    sheet.addRow({
      customer_id:        'CUST003',
      name:               'PT. Klien Corporate',
      // pppoe_username sengaja kosong → tidak pakai PPPoE
      static_ip:          '192.168.10.50',
      // router_name kosong → backend cari di ARP router mana IP itu muncul → auto-set
      phone:              '081333334444',
      package_name:       'Business 100Mbps',
      status:             'active',
      notes:              'Customer pakai IP Static. Router auto-detect dari ARP table.',
    });

    // Contoh row 5 — customer Hotspot IP Binding (MAC + IP, router eksplisit)
    sheet.addRow({
      customer_id:        'CUST004',
      name:               'Warung Kopi Hotspot',
      static_ip:          '10.9.90.20',
      mac_address:        'AA:BB:CC:DD:EE:FF',
      router_name:        'CHR-CLOUD',
      phone:              '081355556666',
      package_name:       'Hotspot 10Mbps',
      status:             'active',
      notes:              'MAC diisi → otomatis jadi tipe Hotspot & dibuatkan IP Binding di router saat import.',
    });

    // Style contoh rows (italic, abu-abu) supaya user tahu itu contoh
    [2, 3, 4, 5, 6].forEach(rowNum => {
      sheet.getRow(rowNum).eachCell(cell => {
        cell.font = { italic: true, color: { argb: 'FF94A3B8' } };
      });
    });

    // Sheet kedua: petunjuk pengisian
    const guideSheet = workbook.addWorksheet('Petunjuk');
    guideSheet.columns = [
      { header: 'Kolom',     width: 22 },
      { header: 'Wajib?',    width: 10 },
      { header: 'Format',    width: 30 },
      { header: 'Contoh',    width: 30 },
      { header: 'Catatan',   width: 50 },
    ];
    guideSheet.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    });

    const guideRows = [
      ['ID Pelanggan',      'Opsional',   'Teks unik, max 20 char',     'CUST001 (atau kosong)',       'Kalau kosong, sistem akan auto-generate (CID001, CID002, ...). Kalau diisi dan ID sudah ada, akan di-update sesuai mode import.'],
      ['Nama',              'Wajib',      'Teks max 150 char',          'Budi Santoso',                ''],
      ['Username PPPoE',    'Opsional',   'a-z 0-9 @ . - _, max 32',    'avinda@net.id (atau kosong)', 'Kalau kosong, sistem auto-generate dari Nama (lowercase, hanya huruf+angka). Kalau diisi manual boleh pakai @ . - _ (mendukung format realm seperti "avinda@net.id"). Karakter lain (spasi, simbol) di-drop. Kalau bentrok dengan yang sudah ada, ditambah angka. SAAT PREVIEW: sistem akan cek apakah username sudah ada di router MikroTik aktif — kalau belum ada, akan muncul warning (row tetap valid &amp; bisa di-import).'],
      ['Static IP',         'Opsional',   'Format IPv4 (xxx.xxx.xxx.xxx)', '192.168.10.50 (atau kosong)', 'Untuk customer dengan tipe langganan IP Static (BUKAN PPPoE). Format IPv4 standard, oktet 0-255. Kalau diisi, sistem akan cek ARP table semua router untuk auto-detect router mana IP itu aktif. IP yang tidak ditemukan di ARP manapun akan dapat warning (row tetap valid). Customer bisa pakai PPPoE saja, IP Static saja, atau keduanya (hybrid). IP harus UNIK di seluruh sistem.'],
      ['MAC Perangkat',     'Opsional',   'Format MAC (12 digit hex)',  'AA:BB:CC:DD:EE:FF (atau kosong)', 'MAC address perangkat pelanggan untuk metode HOTSPOT IP BINDING. Terima format apa pun (AA:BB:.., AA-BB-.., aabbcc..) → dinormalkan ke AA:BB:CC:DD:EE:FF. KALAU DIISI: customer otomatis di-set tipe koneksi = Hotspot, dan saat import sistem akan otomatis membuat entry IP Binding (type=bypassed, aktif) di router yang dipilih kalau belum ada. Isi kolom Router MikroTik (atau biarkan auto-detect via Static IP/ARP) supaya tahu router tujuan binding. MAC harus UNIK di seluruh file. Saat isolir, binding ini akan di-disable; saat bayar, di-enable kembali.'],
      ['Router MikroTik',   'Opsional',   'Nama router (sesuai Device Mgmt)', 'CHR-CLOUD (atau kosong)', 'Nama router tempat PPPoE secret / IP Static / MAC customer berada. Harus PERSIS sama dengan nama di halaman Device Management (case-insensitive OK). KALAU KOSONG: backend otomatis cari (1) di router mana secret PPPoE berada, atau (2) di ARP router mana IP Static aktif. Cocok untuk skenario multi-router. Kalau tidak ditemukan dimanapun, kolom mikrotik_id customer di-set NULL.'],
      ['No. HP',            'Opsional',   'Angka diawali 0/62/+',       '081234567890',                'Akan dinormalisasi ke format 62…'],
      ['Email',             'Opsional',   'Email valid',                'budi@example.com',            ''],
      ['Alamat',            'Opsional',   'Teks bebas',                 'Jl. Mawar No. 5',             ''],
      ['Nama Paket',        'Opsional',   'Harus cocok dengan paket',   'Home 20Mbps',                 'Kalau paket tidak ditemukan, customer tetap di-save tanpa paket.'],
      ['Status',            'Opsional',   'active / inactive / isolated / suspended', 'active',         'Default: active'],
      ['Latitude',          'Opsional',   'Desimal -90 sampai 90',      '-6.200000',                   'Kalau diisi bersama Longitude, customer otomatis ditandai sebagai titik di peta infrastruktur (type=customer).'],
      ['Longitude',         'Opsional',   'Desimal -180 sampai 180',    '106.816666',                  'Kalau diisi bersama Latitude, customer otomatis ditandai sebagai titik di peta infrastruktur (type=customer).'],
      ['Parent ODP',        'Opsional',   'Nama ODP/ODC/POP induk',     'ODP-01',                      'Nama ODP/ODC/POP tempat customer ini terhubung. Harus PERSIS sama dengan nama di halaman /infrastructure (case-insensitive OK). Kalau diisi, titik customer di peta akan otomatis terhubung ke ODP itu (parent_id). Kalau kosong, customer tetap muncul di peta tanpa parent — admin bisa set belakangan dari halaman infrastructure.'],
      ['ONT Serial Number', 'Opsional',   'Teks max 50 char',           'HWTC12345678',                ''],
      ['ONT MAC Address',   'Opsional',   'Format MAC',                 '00:11:22:33:44:55',           ''],
      ['Tanggal Instalasi', 'Opsional',   'YYYY-MM-DD',                 '2024-01-15',                  ''],
      ['Catatan',           'Opsional',   'Teks bebas',                 'Pelanggan loyal',             ''],
    ];
    guideRows.forEach(row => guideSheet.addRow(row));

    const filename = 'customers-import-template.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error('[CustomerImport] Template download failed:', err);
    res.status(500).json({ success: false, message: 'Gagal generate template: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW — parse upload file, return JSON dengan validasi
// ─────────────────────────────────────────────────────────────────────────────
exports.importPreview = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Tidak ada file diupload' });
    }

    const { Customer, Package } = require('../models');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0]; // sheet pertama

    if (!sheet) {
      return res.status(400).json({ success: false, message: 'File tidak punya sheet data' });
    }

    // Map header → column index
    const headerRow = sheet.getRow(1);
    const headerMap = {};
    headerRow.eachCell((cell, colIndex) => {
      const text = String(cell.value || '').trim().replace(/\s*\*\s*$/, '');
      const col = COLUMNS.find(c => c.header === text);
      if (col) headerMap[col.key] = colIndex;
    });

    // Validasi: minimal kolom Nama harus ada (ID Pelanggan boleh tidak ada → semua auto-generate)
    if (headerMap.name == null) {
      return res.status(400).json({
        success: false,
        message: 'File harus punya kolom "Nama". Download template untuk format yang benar.'
      });
    }

    // Ambil semua existing customer_id untuk deteksi duplicate
    // + pppoe_username untuk uniqify saat auto-generate
    // + static_ip untuk uniqueness check IP
    const existingCustomers = await Customer.findAll({
      attributes: ['id', 'customer_id', 'pppoe_username', 'static_ip'],
      raw: true,
    });
    const existingMap = new Map(existingCustomers.map(c => [c.customer_id, c.id]));

    // Set semua pppoe_username yang sudah dipakai di DB (non-null, lowercase)
    // + Map pppoe_username → customer_id untuk exclude diri sendiri saat update
    const existingPppoeSet = new Set();
    const dbPppoeToCid = new Map();
    // Idem untuk static_ip
    const existingStaticIpSet = new Set();
    const dbStaticIpToCid = new Map();
    existingCustomers.forEach(c => {
      if (c.pppoe_username) {
        const u = String(c.pppoe_username).toLowerCase();
        existingPppoeSet.add(u);
        dbPppoeToCid.set(u, c.customer_id);
      }
      if (c.static_ip) {
        const ip = String(c.static_ip).trim();
        existingStaticIpSet.add(ip);
        dbStaticIpToCid.set(ip, c.customer_id);
      }
    });

    // Ambil semua paket untuk lookup nama → id
    const packages = await Package.findAll({
      attributes: ['id', 'name'],
      raw: true,
    });
    const packageMap = new Map(packages.map(p => [p.name.toLowerCase(), p.id]));

    // Ambil daftar ODP/ODC/POP untuk lookup nama Parent ODP → id.
    // Dipakai untuk parsing kolom "Parent ODP" di Excel. Hanya tipe yang
    // bisa jadi parent customer (ODP utamanya, tapi ODC/POP juga dibolehkan
    // untuk fleksibilitas kalau ada deployment kecil yg customer langsung
    // konek ke POP/ODC).
    const { InfrastructurePoint } = require('../models');
    const infraParents = await InfrastructurePoint.findAll({
      where: { type: ['odp', 'odc', 'pop'] },
      attributes: ['id', 'name', 'type'],
      raw: true,
    });
    const infraParentMap = new Map();        // name (lowercase) → id
    const infraParentNamesInMultiple = new Set(); // nama yg duplikat → ambigu
    infraParents.forEach(p => {
      const key = String(p.name || '').toLowerCase().trim();
      if (!key) return;
      if (infraParentMap.has(key)) {
        infraParentNamesInMultiple.add(key);
      } else {
        infraParentMap.set(key, p.id);
      }
    });

    // ─────────────────────────────────────────────────────────────────────
    // Fetch daftar PPPoE secret dari semua router MikroTik aktif.
    // Digunakan untuk soft-validation + auto-detect router dari pppoe_username
    // + lookup kolom "Router MikroTik" di Excel (nama → id).
    //
    // Strategi:
    //   - Paralel fetch ke semua router via Promise.allSettled (fail-soft)
    //   - Router yang error/timeout → di-skip dari validation
    //   - Build:
    //     * routerSecretsSet     : set semua secret name (untuk soft-validation)
    //     * secretToRouterId     : map secret name → router id (untuk auto-detect)
    //     * routerNameToId       : map nama router → id (untuk parsing kolom Excel)
    //     * routerNameToIdAmbig  : kalau ada nama router duplikat → di sini
    // ─────────────────────────────────────────────────────────────────────
    const routerSecretsSet  = new Set();
    const secretToRouterId  = new Map(); // pppoe_username (lowercase) → mikrotik_id
    const secretsInMultiple = new Set(); // pppoe_username yang ada di > 1 router (ambigu)
    const routerNameToId    = new Map(); // router name (lowercase) → mikrotik_id
    const routerIdToOriginalName = new Map(); // id → nama asli (preserve casing)
    // ARP lookup (untuk auto-detect router dari static_ip)
    const arpIpSet          = new Set(); // semua IP yang ada di ARP table (untuk soft-validation)
    const arpIpToRouterId   = new Map(); // IP → router id (untuk auto-detect)
    const arpIpsInMultiple  = new Set(); // IP yang ada di > 1 router (ambigu)
    const routerCheckWarnings = []; // warnings untuk frontend (router yang gagal di-cek)
    const checkedRouterNames = []; // nama router yang berhasil di-cek

    try {
      const { Device } = require('../models');
      const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');

      const routers = await Device.findAll({
        where: { type: 'router', is_active: true },
        attributes: ['id', 'name'],
        raw: true,
      });

      // Bangun routerNameToId dari semua router aktif (untuk parsing kolom Excel
      // — dipakai bahkan untuk router yang nanti gagal fetch, karena user mungkin
      // mau set router eksplisit walau cek gagal).
      routers.forEach(r => {
        if (r.name) {
          routerNameToId.set(String(r.name).toLowerCase(), r.id);
          routerIdToOriginalName.set(r.id, r.name);
        }
      });

      if (routers.length > 0) {
        // Paralel fetch ke setiap router: SECRETS + ARP TABLE (digabung untuk hemat
        // round-trip). Timeout 8 detik per fetch supaya router lambat tidak block.
        const fetchOne = async (router) => {
          try {
            const mt = await Promise.race([
              getMikrotikInstanceByDevice(router.id),
              new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 8000))
            ]);
            // Fetch secrets + ARP secara paralel di dalam satu router
            const [secrets, arp] = await Promise.all([
              Promise.race([
                mt.getPPPoESecrets(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('secrets timeout')), 8000))
              ]).catch(e => { logger.warn(`[MT] secrets fetch failed for router ${router.id}: ${e.message}`); return []; }),
              Promise.race([
                mt.get('/ip/arp'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('arp timeout')), 8000))
              ]).catch(e => { logger.warn(`[MT] arp fetch failed for router ${router.id}: ${e.message}`); return []; })
            ]);
            return { router, secrets: secrets || [], arp: arp || [], ok: true };
          } catch (err) {
            return { router, ok: false, error: err.message };
          }
        };

        const results = await Promise.allSettled(routers.map(fetchOne));

        results.forEach(r => {
          if (r.status !== 'fulfilled') return;
          const v = r.value;
          if (v.ok) {
            checkedRouterNames.push(v.router.name);
            // Process secrets
            (v.secrets || []).forEach(s => {
              if (!s || !s.name) return;
              const lname = String(s.name).toLowerCase();
              routerSecretsSet.add(lname);
              if (secretToRouterId.has(lname) && secretToRouterId.get(lname) !== v.router.id) {
                secretsInMultiple.add(lname);
              } else {
                secretToRouterId.set(lname, v.router.id);
              }
            });
            // Process ARP table — extract address dari setiap entry
            // Entry shape: { address: '192.168.1.10', 'mac-address': '...', interface: '...' }
            (v.arp || []).forEach(a => {
              if (!a || !a.address) return;
              const ip = String(a.address).trim();
              if (!ip) return;
              arpIpSet.add(ip);
              if (arpIpToRouterId.has(ip) && arpIpToRouterId.get(ip) !== v.router.id) {
                arpIpsInMultiple.add(ip);
              } else {
                arpIpToRouterId.set(ip, v.router.id);
              }
            });
          } else {
            routerCheckWarnings.push(`Router "${v.router.name}": ${v.error}`);
          }
        });
      } else {
        routerCheckWarnings.push('Tidak ada router MikroTik aktif yang terdaftar di FLAYNET. Validasi PPPoE/IP ke router di-skip.');
      }
    } catch (err) {
      // Fail-soft: kalau seluruh proses fetch gagal, lanjut tanpa validation
      routerCheckWarnings.push(`Gagal cek secret/ARP di router: ${err.message}. Validasi di-skip.`);
    }

    // Bersihkan: secret/IP yang ambigu (ada di > 1 router) tidak boleh dipakai auto-detect
    secretsInMultiple.forEach(name => secretToRouterId.delete(name));
    arpIpsInMultiple.forEach(ip => arpIpToRouterId.delete(ip));

    // Parse rows
    const rows = [];
    const seenInFile = new Set();
    const pppoeTakenInFile = new Set(); // tracking pppoe_username yang sudah dipakai dalam file
    const staticIpTakenInFile = new Set(); // tracking static_ip yang sudah dipakai dalam file
    const macTakenInFile = new Set();      // tracking mac_address yang sudah dipakai dalam file
    let rowIndex = 2; // mulai baris ke-2 (skip header)

    while (rowIndex <= sheet.rowCount) {
      const row = sheet.getRow(rowIndex);
      const rowData = {};
      let hasData = false;

      COLUMNS.forEach(col => {
        const colIdx = headerMap[col.key];
        if (colIdx == null) return;
        let val = row.getCell(colIdx).value;
        // Handle hyperlink object dari Excel
        if (val && typeof val === 'object' && 'text' in val) val = val.text;
        if (val && typeof val === 'object' && 'result' in val) val = val.result;
        if (val !== null && val !== undefined && val !== '') hasData = true;
        rowData[col.key] = val;
      });

      // Skip baris kosong
      if (!hasData) {
        rowIndex++;
        continue;
      }

      const errors = [];
      const warnings = [];

      // Validasi required
      const customerId = String(rowData.customer_id || '').trim();
      const name = String(rowData.name || '').trim();
      if (!name) errors.push('Nama wajib diisi');

      // Customer ID: kalau kosong, akan di-auto-generate saat confirm.
      // Tidak dianggap error.
      const willAutoGenerate = !customerId;

      // Validasi customer_id length (kalau diisi)
      if (customerId.length > 20) errors.push('ID Pelanggan max 20 karakter');

      // Cek duplicate dalam file (hanya kalau ada ID)
      if (customerId && seenInFile.has(customerId)) {
        errors.push(`ID "${customerId}" duplikat dalam file ini`);
      } else if (customerId) {
        seenInFile.add(customerId);
      }

      // Cek apakah sudah ada di database (akan jadi update)
      // Kalau auto-generate, pasti create (ID baru tidak mungkin ada)
      const existsId = customerId ? existingMap.get(customerId) : null;
      let action;
      if (willAutoGenerate) action = 'create_auto';  // create dengan ID auto-generate
      else if (existsId)    action = 'update';
      else                  action = 'create';

      // Validasi email format
      const email = String(rowData.email || '').trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push(`Email "${email}" tidak valid`);
      }

      // Validasi status
      let status = String(rowData.status || 'active').trim().toLowerCase();
      if (status && !VALID_STATUS.includes(status)) {
        warnings.push(`Status "${status}" tidak dikenal, akan di-set ke "active"`);
        status = 'active';
      }

      // Lookup package
      let packageId = null;
      const packageName = String(rowData.package_name || '').trim();
      if (packageName) {
        packageId = packageMap.get(packageName.toLowerCase()) || null;
        if (!packageId) {
          warnings.push(`Paket "${packageName}" tidak ditemukan, customer akan di-save tanpa paket`);
        }
      }

      // Validasi latitude/longitude
      let latitude = null, longitude = null;
      if (rowData.latitude != null && rowData.latitude !== '') {
        latitude = parseFloat(rowData.latitude);
        if (isNaN(latitude) || latitude < -90 || latitude > 90) {
          errors.push('Latitude harus angka -90 sampai 90');
          latitude = null;
        }
      }
      if (rowData.longitude != null && rowData.longitude !== '') {
        longitude = parseFloat(rowData.longitude);
        if (isNaN(longitude) || longitude < -180 || longitude > 180) {
          errors.push('Longitude harus angka -180 sampai 180');
          longitude = null;
        }
      }

      // Lookup Parent ODP (opsional). Nama harus cocok dengan ODP/ODC/POP
      // existing di tabel infrastructure_points. Kalau tidak ditemukan,
      // customer tetap di-save (cuma tidak terhubung ke parent — admin bisa
      // set belakangan via halaman /infrastructure).
      let infraParentId = null;
      const infraParentNameInput = String(rowData.infra_parent_name || '').trim();
      if (infraParentNameInput) {
        const lookupKey = infraParentNameInput.toLowerCase();
        if (infraParentNamesInMultiple.has(lookupKey)) {
          warnings.push(`⚠ Parent ODP "${infraParentNameInput}" ada lebih dari 1 di sistem (ambigu). Customer tetap disimpan tapi tanpa parent — set manual via halaman Infrastruktur.`);
        } else if (infraParentMap.has(lookupKey)) {
          infraParentId = infraParentMap.get(lookupKey);
        } else {
          warnings.push(`Parent ODP "${infraParentNameInput}" tidak ditemukan di sistem. Customer tetap disimpan tapi tanpa parent.`);
        }
      }

      // Normalisasi phone
      let phone = String(rowData.phone || '').trim().replace(/[^\d+]/g, '');
      if (phone.startsWith('+62')) phone = '62' + phone.slice(3);
      else if (phone.startsWith('0')) phone = '62' + phone.slice(1);

      // Format installation_date
      let instDate = null;
      if (rowData.installation_date) {
        const d = rowData.installation_date instanceof Date
          ? rowData.installation_date
          : new Date(rowData.installation_date);
        if (!isNaN(d.getTime())) {
          instDate = d.toISOString().slice(0, 10);
        } else {
          warnings.push('Tanggal instalasi tidak valid, akan dikosongkan');
        }
      }

      // ── PPPoE Username ────────────────────────────────────────
      // Kalau user isi manual di Excel: pakai itu via sanitizePppoeManual
      //   → diizinkan: a-z, 0-9, @, ., -, _  (mendukung "avinda@net.id")
      // Kalau kosong: auto-generate dari Nama via slugifyForPppoe (strict a-z0-9).
      // Lalu pastikan unik terhadap DB & file ini.
      // Kalau bentrok, di-suffix angka (budisantoso → budisantoso2, ...).
      let pppoeUsername = String(rowData.pppoe_username || '').trim();
      const pppoeOriginal = pppoeUsername; // simpan input asli untuk warning message
      let pppoeAutoGenerated = false;

      if (pppoeUsername) {
        // User mengisi manual → sanitize lenient (izinkan @ . - _)
        const cleaned = sanitizePppoeManual(pppoeUsername);
        if (cleaned !== pppoeUsername.toLowerCase()) {
          warnings.push(`Username PPPoE "${pppoeOriginal}" dibersihkan jadi "${cleaned}" (karakter yang diizinkan: huruf, angka, @, titik, strip, underscore — max 32 char)`);
        }
        pppoeUsername = cleaned;
      } else if (name) {
        // Kosong → auto-generate dari Nama (strict slugify, hanya a-z0-9)
        pppoeUsername = slugifyForPppoe(name);
        pppoeAutoGenerated = true;
      }

      if (pppoeUsername) {
        // Cek uniqueness (kecuali kalau dirinya sendiri di mode update)
        const excludeCid = (action === 'update') ? customerId : null;
        const unique = uniqifyPppoeUsername(
          pppoeUsername,
          existingPppoeSet,
          pppoeTakenInFile,
          excludeCid,
          dbPppoeToCid
        );
        if (unique !== pppoeUsername) {
          warnings.push(`Username PPPoE "${pppoeUsername}" sudah dipakai, diubah jadi "${unique}"`);
          pppoeUsername = unique;
        } else if (pppoeAutoGenerated) {
          warnings.push(`Username PPPoE auto-generate dari Nama: "${pppoeUsername}"`);
        }
        // Reservasi username ini supaya baris berikutnya tidak pakai yang sama
        pppoeTakenInFile.add(pppoeUsername);

        // ── Soft validation: cek apakah secret ada di router ────────
        // Hanya jalan kalau ada minimal 1 router yang berhasil di-cek.
        // Kalau username TIDAK ada di router manapun → warning info supaya
        // admin tahu konsekuensi. Row tetap valid.
        if (checkedRouterNames.length > 0 && !routerSecretsSet.has(pppoeUsername.toLowerCase())) {
          const routerList = checkedRouterNames.length === 1
            ? `router "${checkedRouterNames[0]}"`
            : `${checkedRouterNames.length} router yang di-cek`;
          warnings.push(`⚠ Username PPPoE "${pppoeUsername}" TIDAK ditemukan di ${routerList}. Pastikan secret sudah dibuat manual di router sebelum customer aktif, atau buat secret setelah import via halaman PPPoE Manager.`);
        }
      }

      // ── Static IP ──────────────────────────────────────────────────
      // Customer mode IP Static (alternatif/komplemen dari PPPoE).
      // Validasi:
      //   - Format IPv4 valid
      //   - Tidak duplikat dengan customer lain di DB (kecuali update diri sendiri)
      //   - Tidak duplikat dalam file Excel sendiri
      //   - Soft-validation: cek apakah IP ada di ARP table router → kalau tidak,
      //     warning info (row tetap valid)
      let staticIp = null;
      const staticIpRaw = String(rowData.static_ip || '').trim();
      if (staticIpRaw) {
        const validated = validateIPv4(staticIpRaw);
        if (!validated) {
          errors.push(`Static IP "${staticIpRaw}" tidak valid (format harus IPv4: xxx.xxx.xxx.xxx, oktet 0-255)`);
        } else {
          // Cek duplikat di file
          if (staticIpTakenInFile.has(validated)) {
            errors.push(`Static IP "${validated}" duplikat — sudah dipakai baris lain di file ini`);
          } else {
            // Cek duplikat di DB (kecuali kalau memang dirinya sendiri di mode update)
            const dbOwnerCid = dbStaticIpToCid.get(validated);
            const isOwnSelf = (action === 'update' && dbOwnerCid && dbOwnerCid === customerId);
            if (dbOwnerCid && !isOwnSelf) {
              errors.push(`Static IP "${validated}" sudah dipakai customer lain: ${dbOwnerCid}`);
            } else {
              staticIp = validated;
              staticIpTakenInFile.add(validated);
              // Soft-validation: cek apakah IP ada di ARP table router yang berhasil di-cek
              if (checkedRouterNames.length > 0 && !arpIpSet.has(validated)) {
                const routerList = checkedRouterNames.length === 1
                  ? `router "${checkedRouterNames[0]}"`
                  : `${checkedRouterNames.length} router yang di-cek`;
                warnings.push(`⚠ Static IP "${validated}" TIDAK ditemukan di ARP table ${routerList}. Mungkin customer offline saat ini, IP belum dipakai, atau typo. Row tetap valid.`);
              }
            }
          }
        }
      }

      // ── MAC Address perangkat (untuk IP Binding hotspot) ────────────
      //   - Format MAC apa pun → dinormalkan ke AA:BB:CC:DD:EE:FF
      //   - Cek duplikat dalam file
      //   - Kalau diisi, customer otomatis jadi connection_type='hotspot'
      //     dan akan dibuatkan entry IP Binding di router saat confirm.
      let macAddress = null;
      const macRaw = String(rowData.mac_address || '').trim();
      if (macRaw) {
        const macV = validateMac(macRaw);
        if (!macV) {
          errors.push(`MAC Perangkat "${macRaw}" tidak valid (harus 12 digit hex, contoh AA:BB:CC:DD:EE:FF)`);
        } else if (macTakenInFile.has(macV)) {
          errors.push(`MAC Perangkat "${macV}" duplikat — sudah dipakai baris lain di file ini`);
        } else {
          macAddress = macV;
          macTakenInFile.add(macV);
        }
      }

      // ── Router MikroTik ─────────────────────────────────────────────
      // Strategi resolusi mikrotik_id (urutan prioritas):
      //   1. Kolom "Router MikroTik" di Excel diisi → lookup ke routerNameToId
      //      (case-insensitive). Kalau nama tidak match → warning, mikrotik_id null.
      //   2. Kosong + pppoe_username ada di tepat 1 router → auto-detect via
      //      secretToRouterId.
      //   3. Kosong + pppoe_username ambigu (di multi-router) → null + warning.
      //   4. Kosong + static_ip ada di tepat 1 router via ARP → auto-detect via
      //      arpIpToRouterId. (Dipakai sebagai fallback kalau PPPoE tidak resolve)
      //   5. Kosong + static_ip ambigu → null + warning.
      //   6. Kosong + tidak ada info → null.
      let mikrotikId = null;
      let routerAutoDetectSource = null; // 'pppoe' | 'arp' | null
      const routerNameInput = String(rowData.router_name || '').trim();

      if (routerNameInput) {
        // Sumber 1: explicit dari Excel
        const lookupKey = routerNameInput.toLowerCase();
        if (routerNameToId.has(lookupKey)) {
          mikrotikId = routerNameToId.get(lookupKey);
        } else {
          // Nama tidak match — warning + null
          const knownRouters = Array.from(routerNameToId.keys()).join('", "');
          warnings.push(`⚠ Router MikroTik "${routerNameInput}" tidak ditemukan di Device Management${knownRouters ? ` (router yang ada: "${knownRouters}")` : ''}. Customer akan di-save tanpa router.`);
        }
      } else {
        // Auto-detect path
        // Priority A: PPPoE lookup (kalau ada pppoe_username)
        if (pppoeUsername && secretToRouterId.size > 0) {
          const lname = pppoeUsername.toLowerCase();
          if (secretToRouterId.has(lname)) {
            mikrotikId = secretToRouterId.get(lname);
            routerAutoDetectSource = 'pppoe';
            const routerName = routerIdToOriginalName.get(mikrotikId) || `id #${mikrotikId}`;
            warnings.push(`Router auto-detect (PPPoE): secret "${pppoeUsername}" ditemukan di router "${routerName}"`);
          } else if (secretsInMultiple.has(lname)) {
            warnings.push(`⚠ Username PPPoE "${pppoeUsername}" ada di lebih dari 1 router (ambigu). Isi kolom "Router MikroTik" untuk eksplisit memilih.`);
          }
        }
        // Priority B (fallback): Static IP via ARP (kalau PPPoE tidak resolve dan ada static_ip)
        if (!mikrotikId && staticIp && arpIpToRouterId.size > 0) {
          if (arpIpToRouterId.has(staticIp)) {
            mikrotikId = arpIpToRouterId.get(staticIp);
            routerAutoDetectSource = 'arp';
            const routerName = routerIdToOriginalName.get(mikrotikId) || `id #${mikrotikId}`;
            warnings.push(`Router auto-detect (ARP): IP "${staticIp}" aktif di router "${routerName}"`);
          } else if (arpIpsInMultiple.has(staticIp)) {
            warnings.push(`⚠ Static IP "${staticIp}" muncul di ARP > 1 router (ambigu, mungkin NAT/VLAN duplikat). Isi kolom "Router MikroTik" untuk eksplisit memilih.`);
          }
        }
      }

      rows.push({
        rowNumber: rowIndex,
        action, // 'create' atau 'update'
        valid: errors.length === 0,
        errors,
        warnings,
        data: {
          customer_id: customerId,
          name,
          pppoe_username: pppoeUsername || null,
          static_ip: staticIp || null,
          mac_address: macAddress || null,
          // connection_type: kalau ada MAC → hotspot (untuk IP Binding).
          // Kalau tidak, biarkan null supaya tidak menimpa data customer existing
          // saat mode update (logika di confirm yang memutuskan).
          connection_type: macAddress ? 'hotspot' : null,
          mikrotik_id: mikrotikId,
          phone: phone || null,
          email: email || null,
          address: String(rowData.address || '').trim() || null,
          package_id: packageId,
          package_name: packageName || null, // hanya untuk display preview
          router_name_input: routerNameInput || null, // untuk display preview
          router_auto_source: routerAutoDetectSource, // untuk display preview (badge "auto: PPPoE" atau "auto: ARP")
          status,
          latitude,
          longitude,
          infra_parent_id:    infraParentId,
          infra_parent_name_input: infraParentNameInput || null, // untuk display preview
          ont_sn: String(rowData.ont_sn || '').trim() || null,
          ont_mac: String(rowData.ont_mac || '').trim() || null,
          installation_date: instDate,
          notes: String(rowData.notes || '').trim() || null,
        }
      });

      rowIndex++;
    }

    // Cleanup uploaded file
    try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }

    // Hitung summary
    const summary = {
      total:        rows.length,
      valid:        rows.filter(r => r.valid).length,
      invalid:      rows.filter(r => !r.valid).length,
      toCreate:     rows.filter(r => r.valid && (r.action === 'create' || r.action === 'create_auto')).length,
      toCreateAuto: rows.filter(r => r.valid && r.action === 'create_auto').length,
      toUpdate:     rows.filter(r => r.valid && r.action === 'update').length,
    };

    // Generate import token (uuid singkat) — disimpan di session/cache untuk konfirmasi
    // Sederhana: simpan rows di global memory dengan TTL 5 menit
    const importToken = Math.random().toString(36).slice(2, 14);
    pendingImports.set(importToken, {
      rows,
      userId: req.user?.id,
      createdAt: Date.now(),
    });
    cleanExpiredImports();

    return res.json({
      success: true,
      summary,
      rows,
      importToken,
      // Info hasil cek secret + ARP di router (untuk display di preview)
      routerCheck: {
        checkedRouters:  checkedRouterNames, // list nama router yang berhasil di-cek
        warnings:        routerCheckWarnings, // list warning kalau ada router yang gagal di-cek
        totalSecrets:    routerSecretsSet.size, // total secret yang ditemukan di semua router
        totalArpEntries: arpIpSet.size,     // total IP yang ditemukan di ARP table semua router
        // Map id → name (original casing) untuk semua router aktif
        routerIdToName: Object.fromEntries(routerIdToOriginalName.entries()),
      },
    });
  } catch (err) {
    logger.error('[CustomerImport] Preview failed:', err);
    // Cleanup uploaded file kalau ada
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
    }
    return res.status(500).json({ success: false, message: 'Gagal parse file: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM — eksekusi import setelah preview disetujui
// ─────────────────────────────────────────────────────────────────────────────
exports.importConfirm = async (req, res) => {
  try {
    const { importToken, mode = 'skip_duplicate' } = req.body;
    if (!importToken) {
      return res.status(400).json({ success: false, message: 'importToken tidak ada' });
    }

    const pending = pendingImports.get(importToken);
    if (!pending) {
      return res.status(404).json({
        success: false,
        message: 'Sesi import tidak ditemukan atau sudah expired. Silakan upload ulang file.'
      });
    }

    // Cek ownership
    if (req.user?.id && pending.userId && pending.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Sesi import bukan milik Anda' });
    }

    const { Customer, sequelize } = require('../models');
    const { generateUniqueCustomerId } = require('../utils/helpers');
    const InfraSync = require('../services/CustomerInfraSyncService');
    const validRows = pending.rows.filter(r => r.valid);

    // ── Resolver devices.id → mikrotik_devices.id ───────────────────
    // PENTING: import me-resolve mikrotik_id ke devices.id (dari Device table),
    // tapi customers.mikrotik_id HARUS berisi mikrotik_devices.id supaya isolir
    // (loadDeviceWithMaster) bisa resolve router. Tanpa konversi ini, customer
    // hasil import akan gagal diisolir ("Device tidak ditemukan").
    // Kalau device belum punya baris mikrotik_devices, kita auto-create.
    const _mdCache = new Map(); // devices.id → mikrotik_devices.id
    async function resolveMikrotikDeviceId(deviceId) {
      if (!deviceId) return null;
      if (_mdCache.has(deviceId)) return _mdCache.get(deviceId);
      let mdId = null;
      try {
        const found = await sequelize.query(
          'SELECT id FROM mikrotik_devices WHERE device_id=? LIMIT 1',
          { replacements: [deviceId], type: sequelize.QueryTypes.SELECT }
        );
        if (found && found.length) {
          mdId = found[0].id;
        } else {
          // Auto-create extension isolir untuk device ini (default port binary 8728).
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
      } catch (e) {
        logger.warn(`[CustomerImport] resolveMikrotikDeviceId(${deviceId}) gagal: ${e.message}`);
      }
      _mdCache.set(deviceId, mdId);
      return mdId;
    }

    let created = 0, updated = 0, skipped = 0, failed = 0;
    let createdAuto = 0;
    const errors = [];
    const generatedIds = []; // simpan ID auto-generate untuk return ke frontend
    // Kumpulkan ID customer yang berhasil disimpan untuk batch infra-sync di akhir.
    // Sync dijalankan setelah semua loop selesai supaya tidak menambah latency
    // per-row, dan biar gagal sync 1 customer tidak block customer lain.
    const syncCandidateIds = [];
    // Customer (id) yang punya MAC + mikrotik_id → perlu push IP Binding ke router.
    // Dikumpulkan di loop, dieksekusi batch setelah semua row tersimpan.
    const bindingCandidates = []; // { customerId(cid), mac, ip, mikrotikId }

    // Loop dengan transaction per row supaya satu error tidak rollback semuanya
    for (const row of validRows) {
      try {
        const data = { ...row.data };
        delete data.package_name; // hanya display field, bukan kolom DB
        delete data.router_name_input; // hanya display field, bukan kolom DB
        delete data.router_auto_source; // hanya display field, bukan kolom DB
        delete data.infra_parent_name_input; // hanya display field, bukan kolom DB

        // connection_type null artinya "tidak diubah" — buang supaya tidak
        // menimpa nilai existing customer saat update (atau set NULL saat create).
        if (data.connection_type == null) delete data.connection_type;
        // mac_address null juga jangan dipakai untuk menimpa data existing.
        if (data.mac_address == null) delete data.mac_address;

        // Catat kandidat binding (MAC + router) untuk push ke MikroTik nanti.
        // _deviceId = devices.id (dipakai getServiceFor untuk push binding).
        const _mac = row.data.mac_address || null;
        const _ip  = row.data.static_ip || null;
        const _deviceId = row.data.mikrotik_id || null;
        const _cid = row.data.customer_id || null;

        // Konversi mikrotik_id: devices.id (hasil resolve import) → mikrotik_devices.id
        // supaya isolir bisa resolve router untuk customer ini.
        if (data.mikrotik_id) {
          const mdId = await resolveMikrotikDeviceId(data.mikrotik_id);
          data.mikrotik_id = mdId; // bisa null kalau gagal — biarkan, jangan blokir import
        }

        if (row.action === 'create_auto') {
          // Generate ID baru sebelum insert
          const newId = await generateUniqueCustomerId(Customer, 'CID');
          data.customer_id = newId;
          const c = await Customer.create(data);
          created++;
          createdAuto++;
          syncCandidateIds.push(c.id);
          if (_mac && _deviceId) bindingCandidates.push({ customerId: newId, mac: _mac, ip: _ip, deviceId: _deviceId });
          generatedIds.push({
            rowNumber: row.rowNumber,
            customer_id: newId,
            name: data.name,
            pppoe_username: data.pppoe_username || null
          });
        } else if (row.action === 'create') {
          const c = await Customer.create(data);
          created++;
          syncCandidateIds.push(c.id);
          if (_mac && _deviceId) bindingCandidates.push({ customerId: _cid, mac: _mac, ip: _ip, deviceId: _deviceId });
        } else if (row.action === 'update') {
          if (mode === 'skip_duplicate') {
            skipped++;
            continue;
          }
          await Customer.update(data, { where: { customer_id: data.customer_id } });
          // Untuk update, cari ID customer-nya supaya bisa di-sync
          const existing = await Customer.findOne({
            where: { customer_id: data.customer_id },
            attributes: ['id'],
            raw: true,
          });
          if (existing) syncCandidateIds.push(existing.id);
          if (_mac && _deviceId) bindingCandidates.push({ customerId: data.customer_id, mac: _mac, ip: _ip, deviceId: _deviceId });
          updated++;
        }
      } catch (e) {
        failed++;
        errors.push({
          customer_id: row.data.customer_id || '(auto)',
          message: e.message,
        });
      }
    }

    // Hapus pending import
    pendingImports.delete(importToken);

    // ── Batch sync ke InfrastructurePoint type='customer' ────────────────
    // Fetch semua customer yang baru saja create/update sekaligus, lalu sync
    // satu per satu. Best-effort: gagal sync tidak mempengaruhi response import.
    let infraSyncStats = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
    if (syncCandidateIds.length > 0) {
      try {
        const fresh = await Customer.findAll({
          where: { id: syncCandidateIds },
          attributes: ['id', 'name', 'latitude', 'longitude', 'address', 'status', 'infra_parent_id'],
        });
        infraSyncStats = await InfraSync.syncBatchCustomersToInfra(fresh);
      } catch (e) {
        logger.warn('[CustomerImport] Batch infra sync gagal: ' + e.message);
      }
    }

    // ── Push IP Binding ke MikroTik untuk customer dengan MAC ────────────
    // Untuk setiap customer yang punya MAC + router, buat entry IP binding
    // (type=bypassed, enabled) di router kalau belum ada. Best-effort &
    // per-router di-cache supaya tidak fetch binding berulang.
    let bindingStats = { created: 0, exists: 0, failed: 0, skipped: 0 };
    if (bindingCandidates.length > 0) {
      try {
        const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
        const HotspotService = require('../services/HotspotService');
        const IsolirHotspotBinding = require('../services/IsolirHotspotBinding');

        // Cache service + daftar binding per devices.id (hindari fetch berulang)
        const svcCache = new Map();      // deviceId → HotspotService
        const bindingsCache = new Map(); // deviceId → array binding existing

        for (const cand of bindingCandidates) {
          try {
            let svc = svcCache.get(cand.deviceId);
            if (!svc) {
              const mt = await getMikrotikInstanceByDevice(cand.deviceId);
              svc = new HotspotService(mt);
              svcCache.set(cand.deviceId, svc);
              bindingsCache.set(cand.deviceId, await svc.getIpBindings().catch(() => []));
            }
            const existing = bindingsCache.get(cand.deviceId) || [];
            const macN = IsolirHotspotBinding.normalizeMac(cand.mac);
            const dup = existing.find(b =>
              (macN && String(b.macAddress || '').toUpperCase() === macN) ||
              (cand.ip && String(b.address || '') === cand.ip)
            );
            if (dup) { bindingStats.exists++; continue; }
            await svc.createIpBinding({
              type: 'bypassed',
              macAddress: macN || undefined,
              address: cand.ip || undefined,
              comment: IsolirHotspotBinding.BINDING_COMMENT_PREFIX + '-' + cand.customerId,
            });
            // Tambahkan ke cache supaya duplikat dalam batch yang sama ke-detect
            existing.push({ macAddress: macN, address: cand.ip });
            bindingStats.created++;
          } catch (be) {
            bindingStats.failed++;
            logger.warn(`[CustomerImport] push binding gagal (cust ${cand.customerId}): ${be.message}`);
          }
        }
      } catch (e) {
        logger.warn('[CustomerImport] Batch binding push gagal: ' + e.message);
      }
    }

    return res.json({
      success: true,
      summary: { created, createdAuto, updated, skipped, failed },
      generatedIds: generatedIds.slice(0, 100), // ID auto-generate untuk display
      errors: errors.slice(0, 50),
      infra_sync: infraSyncStats,
      binding_sync: bindingStats,
    });
  } catch (err) {
    logger.error('[CustomerImport] Confirm failed:', err);
    return res.status(500).json({ success: false, message: 'Gagal import: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// In-memory store untuk pending import (TTL 5 menit)
// ─────────────────────────────────────────────────────────────────────────────
const pendingImports = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function cleanExpiredImports() {
  const now = Date.now();
  for (const [token, data] of pendingImports.entries()) {
    if (now - data.createdAt > PENDING_TTL_MS) {
      pendingImports.delete(token);
    }
  }
}

// Cleanup setiap 5 menit
setInterval(cleanExpiredImports, PENDING_TTL_MS);
