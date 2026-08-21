'use strict';

/**
 * BotDataSources — sumber data untuk perintah bot bertipe 'data'.
 * ─────────────────────────────────────────────────────────────────────
 * Tiap sumber: fungsi async(arg) → { ok, vars, error }.
 *   - arg  : argumen perintah (mis. ID/nama pelanggan setelah "/tagihan ").
 *   - vars : objek field untuk mengisi placeholder reply_template
 *            (mis. {nama}, {total_tunggakan}). Semua nilai string.
 *
 * Untuk menambah sumber baru: daftarkan di SOURCES dengan key unik, lalu
 * pilih key itu di UI saat membuat command type 'data'.
 *
 * Daftar placeholder yang dihasilkan tiap sumber ditampilkan di UI
 * (lihat describe()) supaya admin tahu variabel apa yang bisa dipakai.
 */

const fmtRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function periodeLabel(m, y) {
  const mm = parseInt(m, 10);
  if (!mm || mm < 1 || mm > 12 || !y) return '-';
  return `${BULAN[mm - 1]} ${y}`;
}
function fmtDate(d) {
  try { return new Date(d).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric' }); }
  catch (_) { return '-'; }
}

// Lookup pelanggan dari argumen (id/nama/ip/user/hp).
async function _findCustomer(arg) {
  const q = (arg || '').trim();
  if (!q) return null;
  const { Customer, Package } = require('../models');
  const { Op } = require('sequelize');
  return Customer.findOne({
    where: {
      [Op.or]: [
        { customer_id: q },
        { name: { [Op.like]: `%${q}%` } },
        { static_ip: q },
        { pppoe_username: q },
        { phone: { [Op.like]: `%${q}%` } },
      ],
    },
    include: [{ model: Package, as: 'package', attributes: ['name', 'price'], required: false }],
    attributes: ['id', 'customer_id', 'name', 'status', 'isolir_status', 'phone'],
  });
}

const STATUS_LABEL = { active: 'Aktif', inactive: 'Nonaktif', suspended: 'Ditangguhkan', pending: 'Menunggu' };

const SOURCES = {
  // Cek tagihan + tunggakan pelanggan.
  customer_billing: {
    label: 'Tagihan & Tunggakan Pelanggan',
    needsArg: true,
    argHint: 'ID/nama/IP/user/HP pelanggan',
    placeholders: ['{nama}', '{customer_id}', '{paket}', '{status}', '{jumlah_tunggakan}', '{total_tunggakan}', '{invoice_terlama}', '{jatuh_tempo}'],
    run: async (arg) => {
      const cust = await _findCustomer(arg);
      if (!cust) return { ok: false, error: `Pelanggan "${arg}" tidak ditemukan.` };
      const { Invoice } = require('../models');
      const { Op } = require('sequelize');
      const unpaid = await Invoice.findAll({
        where: { customer_id: cust.id, status: { [Op.in]: ['unpaid', 'overdue'] } },
        order: [['due_date', 'ASC']],
        attributes: ['invoice_number', 'total', 'amount', 'due_date', 'period_month', 'period_year'],
      });
      const totalTunggakan = unpaid.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
      const oldest = unpaid[0];
      return {
        ok: true,
        vars: {
          nama: cust.name || '-',
          customer_id: cust.customer_id || cust.id,
          paket: cust.package?.name || '-',
          status: STATUS_LABEL[cust.status] || cust.status || '-',
          jumlah_tunggakan: String(unpaid.length),
          total_tunggakan: fmtRp(totalTunggakan),
          invoice_terlama: oldest ? `${oldest.invoice_number} (${periodeLabel(oldest.period_month, oldest.period_year)})` : '-',
          jatuh_tempo: oldest ? fmtDate(oldest.due_date) : '-',
        },
      };
    },
  },

  // Cek status koneksi/akun pelanggan.
  customer_status: {
    label: 'Status Akun Pelanggan',
    needsArg: true,
    argHint: 'ID/nama/IP/user/HP pelanggan',
    placeholders: ['{nama}', '{customer_id}', '{paket}', '{status}', '{isolir}', '{hp}'],
    run: async (arg) => {
      const cust = await _findCustomer(arg);
      if (!cust) return { ok: false, error: `Pelanggan "${arg}" tidak ditemukan.` };
      return {
        ok: true,
        vars: {
          nama: cust.name || '-',
          customer_id: cust.customer_id || cust.id,
          paket: cust.package?.name || '-',
          status: STATUS_LABEL[cust.status] || cust.status || '-',
          isolir: (cust.isolir_status && cust.isolir_status !== 'active') ? cust.isolir_status : 'tidak',
          hp: cust.phone || '-',
        },
      };
    },
  },
};

// Daftar sumber untuk UI (key + label + placeholder + butuh argumen).
function listSources() {
  return Object.entries(SOURCES).map(([key, s]) => ({
    key, label: s.label, needsArg: !!s.needsArg, argHint: s.argHint || '',
    placeholders: s.placeholders || [],
  }));
}

// Jalankan satu sumber data.
async function run(sourceKey, arg) {
  const src = SOURCES[sourceKey];
  if (!src) return { ok: false, error: 'Sumber data tidak dikenal: ' + sourceKey };
  try {
    return await src.run(arg);
  } catch (e) {
    return { ok: false, error: 'Gagal mengambil data: ' + (e.message || e) };
  }
}

module.exports = { listSources, run, SOURCES };
