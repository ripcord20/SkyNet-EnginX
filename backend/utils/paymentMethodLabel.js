/**
 * paymentMethodLabel.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sumber TUNGGAL untuk label metode pembayaran yang tampil ke pengguna.
 *
 * Sebelumnya tiap controller/service punya map sendiri-sendiri dan beberapa
 * tidak lengkap (mis. 'field_collection' tidak terdaftar) sehingga nilai mentah
 * seperti "field_collection" bocor ke pesan WA / email / tabel. Pusatkan di sini
 * agar konsisten di seluruh aplikasi.
 *
 * Pakai:
 *   const { methodLabel } = require('../utils/paymentMethodLabel');
 *   methodLabel('field_collection')  // → 'Cash Collect'
 *   methodLabel('transfer', 'BCA')   // → 'Transfer Bank (BCA)'
 */

// Label kanonik. Kunci = nilai tersimpan di DB (payment_method) atau channel.
const LABELS = {
  cash:            'Tunai',
  transfer:        'Transfer Bank',
  field_collection:'Cash Collect',
  dana:            'DANA',
  ovo:             'OVO',
  gopay:           'GoPay',
  shopeepay:       'ShopeePay',
  linkaja:         'LinkAja',
  qris:            'QRIS',
  va:              'Virtual Account',
  ewallet:         'E-Wallet',
  gateway:         'Payment Gateway',
  // channel gateway eksternal (kadang tersimpan sebagai method/channel)
  midtrans:        'Midtrans',
  xendit:          'Xendit',
  duitku:          'Duitku',
  tripay:          'Tripay',
  mutasibank:      'Mutasi Bank',
  manual:          'Manual',
  other:           'Lainnya'
};

// Warna aksen per metode (untuk badge/chart). Hindari ungu sesuai aturan UI.
const COLORS = {
  cash:            '#059669',
  transfer:        '#2563eb',
  field_collection:'#0d9488',
  dana:            '#0ea5e9',
  ovo:             '#1d4ed8',
  gopay:           '#16a34a',
  shopeepay:       '#ea580c',
  linkaja:         '#dc2626',
  qris:            '#d97706',
  va:              '#1565e0',
  ewallet:         '#0891b2',
  gateway:         '#475569',
  midtrans:        '#1e3a8a',
  xendit:          '#1d4ed8',
  duitku:          '#0284c7',
  tripay:          '#2563eb',
  mutasibank:      '#0d9488',
  manual:          '#64748b',
  other:           '#94a3b8'
};

/**
 * methodLabel(method, bank?) → string label ramah-pengguna.
 * Tidak dikenal → Title-case dari nilai mentah (mis. 'foo_bar' → 'Foo Bar')
 * supaya tidak pernah menampilkan snake_case mentah.
 */
function methodLabel(method, bank) {
  const key = String(method || '').trim().toLowerCase();
  let label = LABELS[key];
  if (!label) {
    label = key
      ? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : '-';
  }
  if (bank && String(bank).trim()) label += ` (${String(bank).trim()})`;
  return label;
}

function methodColor(method) {
  return COLORS[String(method || '').trim().toLowerCase()] || '#94a3b8';
}

/**
 * gatewayFromNotes(notes) → 'tripay'|'midtrans'|'xendit'|'duitku'|null
 * Semua webhook gateway menulis notes berpola "Auto: <Gateway> ..." (mis.
 * "Auto: Tripay QRIS (ref: ...)"), termasuk skrip rekonsiliasi ("Rekonsiliasi:
 * Tripay ..."). Fungsi ini mengekstrak nama gateway dari pola tersebut supaya
 * kolom Metode bisa menampilkan gateway yang dipakai TANPA perlu kolom DB baru.
 */
function gatewayFromNotes(notes) {
  const s = String(notes || '');
  const m = s.match(/(?:Auto|Rekonsiliasi)\s*:\s*(Tripay|Midtrans|Xendit|Duitku)\b/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * displayMethodLabel(paymentMethod, notesOrOpts, bank?) → label untuk tabel/riwayat.
 * Kalau pembayaran berasal dari gateway online, tampilkan nama gateway-nya
 * (mis. "Tripay") — lebih informatif daripada "Lainnya"/"Payment Gateway".
 *
 * Sumber gateway (prioritas): kolom `gateway` eksplisit → fallback parsing `notes`.
 * Argumen kedua fleksibel demi kompatibilitas pemanggilan lama:
 *   displayMethodLabel(method, notesString, bank)
 *   displayMethodLabel(method, { gateway, notes }, bank)
 */
function displayMethodLabel(paymentMethod, notesOrOpts, bank) {
  let gateway = null, notes = null;
  if (notesOrOpts && typeof notesOrOpts === 'object') {
    gateway = notesOrOpts.gateway || null;
    notes   = notesOrOpts.notes || null;
  } else {
    notes = notesOrOpts || null;
  }
  const gw = (gateway && String(gateway).trim().toLowerCase()) || gatewayFromNotes(notes);
  if (gw && LABELS[gw]) return LABELS[gw];
  if (gw) return methodLabel(gw);
  return methodLabel(paymentMethod, bank);
}

module.exports = { methodLabel, methodColor, gatewayFromNotes, displayMethodLabel, LABELS, COLORS };
