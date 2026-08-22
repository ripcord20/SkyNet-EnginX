'use strict';

/**
 * BotCommandSeed — isi perintah bot bawaan ke tabel bot_commands (idempotent).
 * Hanya menambah command yang belum ada (berdasarkan keyword). Tidak menimpa
 * yang sudah diedit admin. Dipanggil saat startup setelah tabel disync.
 */

const DEFAULTS = [
  {
    keyword: 'menu', aliases: '', type: 'builtin', handler: 'menu',
    description: 'Tampilkan menu tombol interaktif (Jaringan, Pelanggan, Infrastruktur, dll). Sama dengan /cek tanpa argumen.',
    require_control: false, is_system: true, sort_order: 5,
    reply_template: '',
  },
  {
    keyword: 'status', aliases: '', type: 'builtin', handler: 'status',
    description: 'Ringkasan jumlah gangguan (down) per jenis saat ini.',
    require_control: false, is_system: true, sort_order: 10,
    reply_template: '', // builtin status pakai format dinamis di kode
  },
  {
    keyword: 'down', aliases: '', type: 'builtin', handler: 'down',
    description: 'Daftar entitas yang sedang down. Opsional: /down device|ont|ip|pppoe.',
    require_control: false, is_system: true, sort_order: 20,
    reply_template: '',
  },
  {
    keyword: 'cek', aliases: 'cari', type: 'builtin', handler: 'cek',
    description: 'Cari pelanggan & tampilkan status. Tanpa argumen membuka menu tombol. Contoh: /cek FLAYNET.COM atau /cek CID010.',
    require_control: false, is_system: true, sort_order: 30,
    reply_template: '',
  },
  {
    keyword: 'ping', aliases: '', type: 'builtin', handler: 'ping',
    description: 'Cek ICMP ke IP/domain atau ke IP pelanggan. Contoh: /ping 8.8.8.8, /ping google.com, /ping CID010.',
    require_control: false, is_system: true, sort_order: 35,
    reply_template: '',
  },
  {
    keyword: 'cekcustdata', aliases: 'datacust,custdata', type: 'builtin', handler: 'cekcustdata',
    description: 'Detail data pelanggan (nama, CID, aktivasi, alamat, paket, IP, PPPoE, titik Maps). Contoh: /cekcustdata FLAYNET.COM atau /cekcustdata CID010.',
    require_control: false, is_system: true, sort_order: 36,
    reply_template: '',
  },
  {
    keyword: 'cekodp', aliases: 'odp', type: 'builtin', handler: 'cekodp',
    description: 'Cek status & ketersediaan port ODP + daftar pelanggan terkoneksi. Contoh: /cekodp ODP-12 atau /cekodp ODP Bogor.',
    require_control: false, is_system: true, sort_order: 37,
    reply_template: '',
  },
  {
    keyword: 'cekodc', aliases: 'odc', type: 'builtin', handler: 'cekodc',
    description: 'Cek ODC + ODP yang ada di bawahnya. Contoh: /cekodc ODC-01 atau /cekodc ODC Bogor.',
    require_control: false, is_system: true, sort_order: 38,
    reply_template: '',
  },
  {
    keyword: 'cekpop', aliases: 'pop', type: 'builtin', handler: 'cekpop',
    description: 'Cek POP + perangkat (router/switch/OLT) di bawahnya beserta status online/offline. Contoh: /cekpop POP-Pusat.',
    require_control: false, is_system: true, sort_order: 39,
    reply_template: '',
  },
  {
    keyword: 'cekont', aliases: 'ont,rxpower', type: 'builtin', handler: 'cekont',
    description: 'Cek status ONT + RX power dari GenieACS (by pelanggan). Contoh: /cekont FLAYNET.COM atau /cekont CID010.',
    require_control: false, is_system: true, sort_order: 40,
    reply_template: '',
  },
  {
    keyword: 'cekbayar', aliases: 'bayar,riwayatbayar', type: 'builtin', handler: 'cekbayar',
    description: 'Riwayat & status pembayaran pelanggan (tunggakan + 5 pembayaran terakhir). Contoh: /cekbayar FLAYNET.COM atau /cekbayar CID010.',
    require_control: false, is_system: true, sort_order: 41,
    reply_template: '',
  },
  {
    keyword: 'jatuhtempo', aliases: 'nunggak,tempo', type: 'builtin', handler: 'jatuhtempo',
    description: 'Daftar pelanggan menunggak / lewat jatuh tempo. Tambah "hari ini" untuk yang tempo hari-H. Contoh: /jatuhtempo atau /jatuhtempo hari ini.',
    require_control: false, is_system: true, sort_order: 42,
    reply_template: '',
  },
  {
    keyword: 'ringkasan', aliases: 'laporan,laporanharian', type: 'builtin', handler: 'ringkasan',
    description: 'Ringkasan harian: pemasukan, pelanggan baru, jatuh tempo, tunggakan, tiket, gangguan. Contoh: /ringkasan.',
    require_control: false, is_system: true, sort_order: 43,
    reply_template: '',
  },
  {
    keyword: 'tiket', aliases: 'ticket,gangguan', type: 'builtin', handler: 'tiket',
    description: 'Daftar tiket aktif. Filter opsional: open/progress/pending. Contoh: /tiket atau /tiket open.',
    require_control: false, is_system: true, sort_order: 44,
    reply_template: '',
  },
  {
    keyword: 'cekreseller', aliases: 'reseller', type: 'builtin', handler: 'cekreseller',
    description: 'Info reseller: saldo, status, komisi, jumlah voucher, sub-reseller, transaksi terakhir. Contoh: /cekreseller RS-001.',
    require_control: false, is_system: true, sort_order: 45,
    reply_template: '',
  },
  {
    keyword: 'cekvoucher', aliases: 'voucher', type: 'builtin', handler: 'cekvoucher',
    description: 'Status voucher hotspot by username (aktif/terpakai/expired, paket, harga, reseller). Contoh: /cekvoucher abc123.',
    require_control: false, is_system: true, sort_order: 46,
    reply_template: '',
  },
  {
    keyword: 'cekhotspot', aliases: 'hotspotaktif,useraktif', type: 'builtin', handler: 'cekhotspot',
    description: 'Daftar user hotspot yang sedang aktif (online) + bandwidth. Filter opsional by username. Target router lain: /cekhotspot @NamaRouter. Contoh: /cekhotspot atau /cekhotspot budi.',
    require_control: false, is_system: true, sort_order: 47,
    reply_template: '',
  },
  {
    keyword: 'cekmikrotik', aliases: 'mikrotik,router', type: 'builtin', handler: 'cekmikrotik',
    description: 'Detail & resource router MikroTik: identity, board, versi, uptime, CPU, RAM, disk. Tanpa arg = router utama. Contoh: /cekmikrotik atau /cekmikrotik POP-Pusat atau /cekmikrotik 192.168.1.1.',
    require_control: false, is_system: true, sort_order: 48,
    reply_template: '',
  },
  {
    keyword: 'cekpppoe', aliases: 'pppoe,ppp', type: 'builtin', handler: 'cekpppoe',
    description: 'Cek user PPPoE: status/active/offline/all atau cari username. /cekpppoe status = ringkasan total user, active session, offline. Target router lain: /cekpppoe @NamaRouter. Contoh: /cekpppoe status, /cekpppoe active, /cekpppoe budi.',
    require_control: false, is_system: true, sort_order: 49,
    reply_template: '',
  },
  {
    keyword: 'backupmikrotik', aliases: 'backuprouter,backup', type: 'builtin', handler: 'backupmikrotik',
    description: 'Backup konfigurasi router MikroTik (.rsc + .backup) lalu kirim file ke chat. Butuh izin kontrol & SSH router. Tanpa arg = router utama. Contoh: /backupmikrotik atau /backupmikrotik POP-Pusat.',
    require_control: true, is_system: true, sort_order: 50,
    reply_template: '',
  },
  {
    keyword: 'createpppoe', aliases: 'buatpppoe,addpppoe', type: 'builtin', handler: 'createpppoe',
    description: 'Buat user PPPoE baru (wizard: pilih router > pilih profile > username > password). Butuh izin kontrol. Ketik /createpppoe atau buka menu PPPoE > Buat PPPoE User.',
    require_control: true, is_system: true, sort_order: 51,
    reply_template: '',
  },
  {
    keyword: 'cekqueue', aliases: 'queue,simplequeue', type: 'builtin', handler: 'cekqueue',
    description: 'Lihat daftar simple queue di router (nama, target, max-limit, prioritas). Tambah "all" untuk queue dinamis. Router lain: /cekqueue @NamaRouter. Contoh: /cekqueue atau /cekqueue budi.',
    require_control: false, is_system: true, sort_order: 52,
    reply_template: '',
  },
  {
    keyword: 'cekinterface', aliases: 'interface,interfaces', type: 'builtin', handler: 'cekinterface',
    description: 'Cek status interface router: yang UP/running vs DOWN/not-running (+ disabled). Banyak router → muncul tombol pilih router. Router lain: /cekinterface @NamaRouter. Contoh: /cekinterface.',
    require_control: false, is_system: true, sort_order: 54,
    reply_template: '',
  },
  {
    keyword: 'cekip', aliases: 'ip,ipaddress', type: 'builtin', handler: 'cekip',
    description: 'Cek IP: pilih IP Router (daftar IP address per router) atau IP Pelanggan (cari by nama/CID). Contoh: /cekip lalu pilih, atau /cekip router, atau /cekip CID010.',
    require_control: false, is_system: true, sort_order: 55,
    reply_template: '',
  },
  {
    keyword: 'cektrafik', aliases: 'trafik,traffic', type: 'builtin', handler: 'cektrafik',
    description: 'Trafik realtime interface router (RX/TX bps). Banyak router → muncul tombol pilih router. Router lain: /cektrafik @NamaRouter. Contoh: /cektrafik.',
    require_control: false, is_system: true, sort_order: 57,
    reply_template: '',
  },
  {
    keyword: 'cekisolir', aliases: 'isolirlist,daftarisolir', type: 'builtin', handler: 'cekisolir',
    description: 'Daftar pelanggan yang sedang terisolir (nama, CID, PPPoE, sejak kapan). Filter: /cekisolir <kata kunci>. Contoh: /cekisolir.',
    require_control: false, is_system: true, sort_order: 56,
    reply_template: '',
  },
  {
    keyword: 'createqueue', aliases: 'buatqueue,addqueue', type: 'builtin', handler: 'createqueue',
    description: 'Buat simple queue baru (wizard: pilih router > nama > target IP > max upload > max download). Butuh izin kontrol. Ketik /createqueue atau menu Jaringan > Simple Queue > Buat Simple Queue.',
    require_control: true, is_system: true, sort_order: 53,
    reply_template: '',
  },
  {
    keyword: 'tagihan', aliases: 'bill,invoice', type: 'data', handler: null,
    data_source: 'customer_billing',
    description: 'Cek tagihan & saldo pelanggan. Contoh: /tagihan CID010.',
    require_control: false, is_system: true, sort_order: 40,
    reply_template:
      'Tagihan Pelanggan\n\n' +
      'Nama : <b>{nama}</b> ({customer_id})\n' +
      'Paket : {paket}\n' +
      'Status : {status}\n' +
      'Tagihan belum bayar : <b>{jumlah_tunggakan}</b> invoice\n' +
      'Total tunggakan : <b>{total_tunggakan}</b>\n' +
      'Invoice terlama : {invoice_terlama}\n' +
      'Jatuh tempo : {jatuh_tempo}',
  },
  {
    keyword: 'isolir', aliases: '', type: 'builtin', handler: 'isolir',
    description: 'Isolir pelanggan (perlu izin kontrol). Contoh: /isolir CID010.',
    require_control: true, is_system: true, sort_order: 50,
    reply_template: '',
  },
  {
    keyword: 'restore', aliases: 'pulihkan', type: 'builtin', handler: 'restore',
    description: 'Pulihkan pelanggan (perlu izin kontrol). Contoh: /restore CID010.',
    require_control: true, is_system: true, sort_order: 60,
    reply_template: '',
  },
  {
    keyword: 'help', aliases: 'start,bantuan', type: 'builtin', handler: 'help',
    description: 'Tampilkan daftar perintah yang tersedia.',
    require_control: false, is_system: true, sort_order: 1,
    reply_template: '',
  },
];

async function seedDefaults() {
  const { BotCommand } = require('../models');
  if (!BotCommand) return;
  for (const def of DEFAULTS) {
    const exists = await BotCommand.findOne({ where: { keyword: def.keyword } });
    if (!exists) {
      await BotCommand.create(def);
    } else if (exists.is_system) {
      // Pastikan flag penting builtin tetap benar (handler/type/is_system),
      // tanpa menimpa keyword/aliases/description/reply_template yang mungkin diedit.
      const patch = {};
      if (exists.type !== def.type) patch.type = def.type;
      if (def.handler && exists.handler !== def.handler) patch.handler = def.handler;
      if (def.data_source && exists.data_source !== def.data_source) patch.data_source = def.data_source;
      if (!exists.is_system) patch.is_system = true;
      // Refresh deskripsi HANYA bila masih memakai contoh placeholder lama
      // (budi / CUST-001) — tidak menimpa deskripsi yang sudah diedit admin.
      if (def.description && exists.description &&
          /\bbudi\b|CUST-001/i.test(exists.description) &&
          exists.description !== def.description) {
        patch.description = def.description;
      }
      if (Object.keys(patch).length) await exists.update(patch);
    }
  }
}

module.exports = { seedDefaults, DEFAULTS };
