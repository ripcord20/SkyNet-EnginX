const moment = require('moment');
const crypto = require('crypto');

// Generate sequential customer ID: CID001, CID002, ...
const generateCustomerId = (prefix = 'CID', number = 1) => {
  return prefix + String(number).padStart(3, '0');
};

// Generate sequential CID: ambil nomor terakhir dari DB, increment
const generateUniqueCustomerId = async (CustomerModel, prefix = 'CID') => {
  const { Op } = require('sequelize');
  // Cari semua customer_id yang format CIDxxx
  const last = await CustomerModel.findOne({
    where: { customer_id: { [Op.like]: prefix + '%' } },
    order: [['customer_id', 'DESC']],
    attributes: ['customer_id']
  });

  let nextNum = 1;
  if (last) {
    // Ekstrak angka dari akhir ID: "CID007" -> 7
    const match = last.customer_id.replace(prefix, '').match(/^(\d+)/);
    if (match) nextNum = parseInt(match[1]) + 1;
  }

  // Coba sequential sampai dapat yang belum ada
  for (let i = nextNum; i < nextNum + 100; i++) {
    const candidate = prefix + String(i).padStart(3, '0');
    const exists = await CustomerModel.findOne({ where: { customer_id: candidate } });
    if (!exists) return candidate;
  }

  // Fallback: pakai timestamp
  return prefix + Date.now().toString().slice(-6);
};

// Generate invoice number. Prefix dapat dikonfigurasi (default 'INV').
const generateInvoiceNumber = (year, month, sequence, prefix = 'INV') => {
  const y = String(year).slice(-2);
  const m = String(month).padStart(2, '0');
  const seq = String(sequence).padStart(5, '0');
  const p = String(prefix || 'INV').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'INV';
  return `${p}-${y}${m}-${seq}`;
};

// Cache prefix invoice (TTL 30 dtk) agar tidak query app_settings tiap kali.
let _invPrefixCache = { v: 'INV', t: 0 };
const getInvoicePrefix = async (sequelize) => {
  const now = Date.now();
  if (now - _invPrefixCache.t < 30000) return _invPrefixCache.v;
  try {
    const { QueryTypes } = require('sequelize');
    const rows = await sequelize.query(
      "SELECT value FROM app_settings WHERE `key`='invoice_prefix' LIMIT 1",
      { type: QueryTypes.SELECT }
    );
    let p = (rows && rows[0] && rows[0].value) ? String(rows[0].value) : 'INV';
    p = p.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'INV';
    _invPrefixCache = { v: p, t: now };
    return p;
  } catch (_) { return _invPrefixCache.v || 'INV'; }
};
const invalidateInvoicePrefixCache = () => { _invPrefixCache = { v: 'INV', t: 0 }; };

/**
 * Tentukan nomor invoice berikutnya untuk sebuah periode, secara terpusat & aman.
 *
 * Strategi: ambil suffix numerik TERBESAR dari semua invoice di periode tsb
 * (period_month/period_year), lalu +1. Memakai MAX angka (bukan COUNT) supaya
 * tahan terhadap:
 *   - gap nomor (mis. ada invoice dihapus),
 *   - nomor besar dari jalur lain (mis. PaymentController auto-create),
 *   - format campuran (suffix non-angka diabaikan).
 *
 * Dengan menyatukan logika ini, BillingController (generate batch) dan
 * PaymentController (auto-create saat pencatatan bayar) tidak lagi memakai
 * basis berbeda (count per-periode vs id global) yang dulu menyebabkan
 * "konflik nomor invoice".
 *
 * @param {object} sequelize  instance sequelize (dari require('../models'))
 * @param {number} month      bulan periode (1-12)
 * @param {number} year       tahun periode
 * @param {object} [opts]      { transaction }
 * @returns {Promise<{ nextSeq: number, invoiceNumber: string }>}
 */
const getNextInvoiceNumber = async (sequelize, month, year, opts = {}) => {
  const { QueryTypes } = require('sequelize');
  const prefix = await getInvoicePrefix(sequelize);
  // Ambil suffix angka terbesar di periode ini. SUBSTRING_INDEX ambil bagian
  // setelah '-' terakhir; CAST ke UNSIGNED → non-angka jadi 0.
  // LIKE memakai prefix aktif agar konsisten meski prefix pernah diganti.
  const rows = await sequelize.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_number, '-', -1) AS UNSIGNED)), 0) AS max_seq
       FROM invoices
      WHERE period_month = :m AND period_year = :y
        AND invoice_number LIKE :likePrefix`,
    {
      replacements: { m: month, y: year, likePrefix: prefix + '-%' },
      type: QueryTypes.SELECT,
      transaction: opts.transaction || null
    }
  );
  const maxSeq = parseInt(rows?.[0]?.max_seq || 0, 10) || 0;
  const nextSeq = maxSeq + 1;
  return { nextSeq, invoiceNumber: generateInvoiceNumber(year, month, nextSeq, prefix), prefix };
};

// Format bytes to human readable
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

// Format bits per second
const formatBps = (bps) => {
  if (bps === 0) return '0 bps';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.floor(Math.log(bps) / Math.log(1000));
  return (bps / Math.pow(1000, i)).toFixed(1) + ' ' + units[i];
};

// Format uptime ticks to human readable
const formatUptime = (ticks) => {
  const seconds = Math.floor(ticks / 100);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
};

// Format currency IDR
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0
  }).format(amount);
};

// Pagination helper
const paginate = (query, { page = 1, limit = 20 }) => {
  const offset = (page - 1) * limit;
  return {
    ...query,
    offset,
    limit: parseInt(limit)
  };
};

// Build pagination response
const paginateResponse = (data, total, page, limit) => {
  const totalPages = Math.ceil(total / limit);
  return {
    data,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  };
};

// Sanitize SNMP response value
const sanitizeSnmpValue = (varbind) => {
  if (!varbind) return null;
  if (Buffer.isBuffer(varbind.value)) {
    return varbind.value.toString('utf8');
  }
  return varbind.value;
};

module.exports = {
  generateCustomerId,
  generateUniqueCustomerId,
  generateInvoiceNumber,
  getNextInvoiceNumber,
  getInvoicePrefix,
  invalidateInvoicePrefixCache,
  formatBytes,
  formatBps,
  formatUptime,
  formatCurrency,
  paginate,
  paginateResponse,
  sanitizeSnmpValue
};