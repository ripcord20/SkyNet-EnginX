'use strict';

/**
 * PublicLookupController
 * ----------------------
 * Endpoint publik (TANPA login) untuk fitur "Cek Tagihan" di landing page ISP.
 * Pelanggan memasukkan CID (customer_id) + 4 digit terakhir nomor HP sebagai
 * verifikasi ringan, lalu sistem mengembalikan ringkasan tagihan aktif beserta
 * URL halaman pembayaran (/pub/invoice/:token) yang SUDAH ADA — sehingga proses
 * bayar (Tripay) memakai mesin pembayaran yang sudah berjalan, tanpa duplikasi.
 *
 * Keamanan:
 *  - Verifikasi 2 faktor ringan: CID + 4 digit akhir HP (mencegah orang asing
 *    mengintip data pelanggan lain hanya dengan menebak CID berurutan).
 *  - Rate limit dipasang di layer route (pubLookupLimiter).
 *  - Respons TIDAK membocorkan data sensitif berlebih: hanya nama (disamarkan
 *    sebagian), status, nominal tagihan, dan token bayar.
 *  - Pesan error dibuat seragam ("data tidak cocok") agar tidak bisa dipakai
 *    menebak CID mana yang valid (anti-enumeration).
 */

const { Customer, Invoice } = require('../models');
const { generateInvoiceToken } = require('../utils/templateHelper');

// Samarkan nama: "Budi Santoso" → "Budi S****o" (cukup untuk konfirmasi visual
// bahwa pelanggan menemukan dirinya sendiri, tanpa memaparkan nama penuh).
function maskName(name) {
  if (!name) return '-';
  return String(name)
    .split(' ')
    .map((w) => {
      if (w.length <= 2) return w;
      return w[0] + '*'.repeat(Math.max(1, w.length - 2)) + w[w.length - 1];
    })
    .join(' ');
}

// Ambil hanya digit dari string HP (buang +62, spasi, strip, dll).
function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

exports.checkBill = async (req, res) => {
  try {
    const rawCid = String((req.body && req.body.cid) || '').trim();
    const rawPhone4 = digitsOnly((req.body && req.body.phone4) || '');

    // Validasi input dasar.
    if (!rawCid || rawPhone4.length !== 4) {
      return res.status(400).json({
        success: false,
        message: 'Masukkan CID dan 4 digit terakhir nomor HP.',
      });
    }

    // Cari pelanggan by customer_id (CID). Case-insensitive, toleran spasi.
    const customer = await Customer.findOne({
      where: { customer_id: rawCid },
    });

    // Pesan seragam untuk semua kegagalan → anti-enumeration.
    const mismatch = () =>
      res.status(404).json({
        success: false,
        message: 'CID atau nomor HP tidak cocok. Periksa kembali data Anda.',
      });

    if (!customer) return mismatch();

    // Verifikasi 4 digit terakhir HP.
    const custPhone = digitsOnly(customer.phone);
    if (!custPhone || custPhone.slice(-4) !== rawPhone4) return mismatch();

    // Ambil tagihan: (1) belum lunas terlama, (2) fallback terbaru apa pun.
    let invoice = await Invoice.findOne({
      where: { customer_id: customer.id, status: ['unpaid', 'overdue'] },
      order: [['period_year', 'ASC'], ['period_month', 'ASC'], ['id', 'ASC']],
    });
    let hasUnpaid = !!invoice;
    if (!invoice) {
      invoice = await Invoice.findOne({
        where: { customer_id: customer.id },
        order: [['period_year', 'DESC'], ['period_month', 'DESC'], ['id', 'DESC']],
      });
    }

    // Pelanggan valid tapi belum punya invoice sama sekali.
    if (!invoice) {
      return res.json({
        success: true,
        found: true,
        has_invoice: false,
        customer: { name: maskName(customer.name), status: customer.status },
        message: 'Belum ada tagihan yang terbit untuk akun ini.',
      });
    }

    // Bentuk URL halaman bayar yang SUDAH ADA (token HMAC per-invoice).
    const token = generateInvoiceToken(invoice.id);
    const payPath = '/pub/invoice/' + token;

    const monthNames = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

    return res.json({
      success: true,
      found: true,
      has_invoice: true,
      has_unpaid: hasUnpaid,
      customer: {
        name: maskName(customer.name),
        status: customer.status,
      },
      invoice: {
        number: invoice.invoice_number,
        period: (monthNames[invoice.period_month] || '') + ' ' + invoice.period_year,
        amount: Number(invoice.total || invoice.amount || 0),
        status: invoice.status,
        due_date: invoice.due_date,
      },
      // Path relatif — landing page menggabungkannya dengan base URL billing.
      pay_path: payPath,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan. Coba lagi beberapa saat.',
    });
  }
};
