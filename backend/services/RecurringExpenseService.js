// ════════════════════════════════════════════════════════════════
//  RecurringExpenseService
//  Membuat entri 'pengeluaran' di tabel keuangan dari template
//  recurring_expenses yang aktif, sekali per bulan (idempotent).
//
//  ref_number entri = 'RECUR-{templateId}-{YYYY-MM}' → dipakai untuk
//  cek duplikat supaya tidak dobel walau cron jalan berkali-kali.
// ════════════════════════════════════════════════════════════════
const { RecurringExpense, Keuangan, sequelize } = require('../models');
const { Op } = require('sequelize');
const moment = require('moment');

// Generate entri untuk satu periode (default: bulan berjalan).
// Return { created, skipped, details:[] }
async function generate(forDate) {
  const now = forDate ? moment(forDate) : moment();
  const period = now.format('YYYY-MM');               // mis. '2026-06'
  const year = now.year();
  const month = now.month() + 1;

  const templates = await RecurringExpense.findAll({ where: { active: true } });
  let created = 0, skipped = 0;
  const details = [];

  for (const t of templates) {
    // Hanya generate kalau tanggal hari ini >= day_of_month template
    // (supaya pengeluaran muncul pada/ setelah tanggal jatuh temponya).
    // Saat dijalankan manual (forDate null) di awal bulan, day_of_month
    // yang lebih besar akan menunggu cron harian.
    const dom = Math.min(Math.max(parseInt(t.day_of_month) || 1, 1), 28);
    const ref = `RECUR-${t.id}-${period}`;

    // Sudah pernah dibuat utk periode ini?
    const exists = await Keuangan.findOne({ where: { ref_number: ref } });
    if (exists) { skipped++; continue; }

    // Belum waktunya (tanggal hari ini < day_of_month) → tunggu
    if (!forDate && now.date() < dom) { skipped++; continue; }

    const entryDate = now.clone().date(dom).format('YYYY-MM-DD');
    await Keuangan.create({
      type: 'pengeluaran',
      category: t.category || 'Operasional',
      description: t.name + ' (' + now.format('MMMM YYYY') + ')',
      amount: t.amount,
      date: entryDate,
      party_name: t.party_name || null,
      source: 'recurring',
      ref_number: ref,
      notes: t.notes || null,
      recorded_by: t.created_by || null
    });

    // Tandai template
    await t.update({ last_generated_period: period });
    created++;
    details.push({ id: t.id, name: t.name, amount: t.amount, date: entryDate });
  }

  return { created, skipped, period, details };
}

module.exports = { generate };
