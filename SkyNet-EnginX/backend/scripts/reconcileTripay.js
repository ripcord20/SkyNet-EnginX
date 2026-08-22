#!/usr/bin/env node
/**
 * reconcileTripay.js
 * ────────────────────────────────────────────────────────────────────────
 * Rekonsiliasi pembayaran Tripay yang SUKSES di sisi Tripay tapi TIDAK
 * tercatat di CRM (mis. karena callback ditolak akibat bug raw-body).
 *
 * Cara kerja:
 *  1. Ambil invoice ber-status 'unpaid'/'overdue' yang punya jejak transaksi
 *     Tripay di kolom `notes` (format: |tripay_ref:INV-..|tripay_tref:T....),
 *     yang ditulis PublicPaymentService.createGatewayTransaction().
 *  2. Untuk tiap invoice, query Tripay `transaction/detail?reference=<tref>`.
 *  3. Jika status Tripay = PAID → buat Payment + set invoice paid +
 *     finalizePaidInvoice() (IDENTIK dengan jalur webhook tripayNotif).
 *  4. Idempotent: invoice yang sudah paid / sudah punya Payment akan dilewati.
 *
 * Aman: DRY-RUN secara default (hanya menampilkan apa yang AKAN dilakukan).
 * Tambahkan flag --commit untuk benar-benar menulis ke database.
 *
 * Jalankan dari root project (agar path require './models' benar):
 *   node backend/scripts/reconcileTripay.js            # dry-run (preview)
 *   node backend/scripts/reconcileTripay.js --commit   # eksekusi
 *
 * Opsi tambahan:
 *   --days=30      Batasi ke invoice yang dibuat dalam N hari terakhir (default 90)
 *   --invoice=123  Proses hanya 1 invoice id tertentu
 *   --verbose      Tampilkan detail respons Tripay per invoice
 * ────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

// models/index.js relatif ke folder backend/
const {
  sequelize, Invoice, Payment, Customer, Package, AppSetting
} = require('../models');
const { Op: SeqOp } = require('sequelize');
const logger = require('../utils/logger');
const { finalizePaidInvoice } = require('../utils/paymentFinalizer');

// ── Parse argumen CLI ──────────────────────────────────────────────
const args = process.argv.slice(2);
const COMMIT   = args.includes('--commit');
const VERBOSE  = args.includes('--verbose');
const daysArg  = args.find(a => a.startsWith('--days='));
const invArg   = args.find(a => a.startsWith('--invoice='));
const DAYS     = daysArg ? parseInt(daysArg.split('=')[1]) || 90 : 90;
const ONLY_INV = invArg ? parseInt(invArg.split('=')[1]) : null;

async function getSetting(key, fallback = '') {
  try {
    const s = await AppSetting.findOne({ where: { key } });
    return s ? s.value : fallback;
  } catch { return fallback; }
}

// Ekstrak tripay reference (tref) dari kolom notes invoice.
// Format ditulis service: |tripay_ref:INV-{id}-{ts}|tripay_tref:{reference}
function extractTripayRefs(notes) {
  if (!notes) return [];
  const refs = [];
  const re = /tripay_tref:([A-Za-z0-9\-]+)/g;
  let m;
  while ((m = re.exec(notes)) !== null) refs.push(m[1]);
  // Dedup, urutkan terbaru dulu (biasanya ref terakhir = percobaan terakhir)
  return [...new Set(refs)].reverse();
}

// Map payment_method Tripay → enum Payment.payment_method (sama dgn tripayNotif)
function mapPayMethod(pm) {
  pm = String(pm || '').toUpperCase();
  if (pm.includes('QRIS')) return 'qris';
  if (pm.includes('VA') || pm.includes('VIRTUAL') || /BCA|BNI|BRI|MANDIRI|PERMATA|CIMB|MUAMALAT|BSI|DANAMON|SAMPOERNA/.test(pm)) return 'transfer';
  if (pm.includes('OVO')) return 'ovo';
  if (pm.includes('DANA')) return 'dana';
  if (pm.includes('ALFA') || pm.includes('INDOMARET') || pm.includes('RETAIL')) return 'other';
  if (pm.includes('SHOPEE') || pm.includes('LINKAJA') || pm.includes('WALLET')) return 'ewallet';
  return 'gateway';
}

async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log(' REKONSILIASI PEMBAYARAN TRIPAY');
  console.log(`  Mode      : ${COMMIT ? '⚠️  COMMIT (menulis ke DB)' : '🔍 DRY-RUN (preview saja)'}`);
  console.log(`  Rentang   : ${ONLY_INV ? `invoice #${ONLY_INV}` : `${DAYS} hari terakhir`}`);
  console.log('════════════════════════════════════════════════════════\n');

  await sequelize.authenticate();

  const apiKey       = await getSetting('payment_gateway_server_key', '');
  const privateKey   = await getSetting('payment_gateway_private_key', '');
  const merchantCode = await getSetting('payment_gateway_merchant_code', '');
  const provider     = await getSetting('payment_gateway_provider', '');
  const isProd       = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
  const apiBase      = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';

  if (provider !== 'tripay') {
    console.error(`✗ Provider aktif bukan tripay (provider=${provider}). Batal.`);
    process.exit(1);
  }
  if (!apiKey || !privateKey || !merchantCode) {
    console.error('✗ Konfigurasi Tripay tidak lengkap (server_key/private_key/merchant_code). Batal.');
    process.exit(1);
  }
  console.log(`Environment Tripay: ${isProd ? 'PRODUCTION' : 'SANDBOX'} (${apiBase})\n`);

  // ── Ambil invoice kandidat ────────────────────────────────────────
  // Termasuk status 'paid' — kasus invoice sudah ditandai lunas (mis. via
  // verifikasi manual / proses lain) TAPI record Payment tidak pernah dibuat
  // karena callback Tripay gagal. Guard "sudah ada Payment" di bawah tetap
  // mencegah dobel; jadi invoice paid yang SUDAH punya Payment akan dilewati.
  const where = {
    status: { [SeqOp.in]: ['unpaid', 'overdue', 'paid'] },
    notes:  { [SeqOp.like]: '%tripay_tref:%' }
  };
  if (ONLY_INV) where.id = ONLY_INV;
  else {
    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
    where.createdAt = { [SeqOp.gte]: since };
  }

  const invoices = await Invoice.findAll({
    where,
    order: [['id', 'ASC']]
  });

  console.log(`Ditemukan ${invoices.length} invoice kandidat (ada jejak Tripay, termasuk paid tanpa record Payment).\n`);

  const summary = { checked: 0, paidOnTripay: 0, reconciled: 0, alreadyPaid: 0, notPaid: 0, errors: 0, skippedHasPayment: 0 };

  for (const invoice of invoices) {
    summary.checked++;
    const label = `Invoice #${invoice.id} (${invoice.invoice_number || '-'})`;

    // Guard: kalau sudah ada Payment, lewati (idempotent)
    const existingPay = await Payment.findOne({ where: { invoice_id: invoice.id } });
    if (existingPay) {
      summary.skippedHasPayment++;
      console.log(`↷ ${label}: sudah ada Payment (#${existingPay.id}), lewati.`);
      continue;
    }

    const trefs = extractTripayRefs(invoice.notes);
    if (!trefs.length) {
      console.log(`↷ ${label}: tak ada tripay_tref valid, lewati.`);
      continue;
    }

    let paidData = null;
    let usedRef = null;
    for (const tref of trefs) {
      try {
        const resp = await axios.get(`${apiBase}/transaction/detail`, {
          params: { reference: tref },
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 15000
        });
        const d = resp?.data?.data;
        if (VERBOSE) console.log(`   · ${tref} → status=${d?.status || '?'} amount=${d?.amount_received || d?.amount || '?'}`);
        if (d && String(d.status).toUpperCase() === 'PAID') {
          paidData = d; usedRef = tref;
          break;
        }
      } catch (e) {
        const msg = e.response?.data?.message || e.message;
        if (VERBOSE) console.log(`   · ${tref} → error: ${msg}`);
      }
    }

    if (!paidData) {
      summary.notPaid++;
      console.log(`— ${label}: belum PAID di Tripay (${trefs.length} ref dicek).`);
      continue;
    }

    summary.paidOnTripay++;

    // Validasi nominal (sama dgn webhook)
    const expectedAmount = Math.round(parseFloat(invoice.total));
    const callbackAmount = Math.round(parseFloat(paidData.amount_received || paidData.amount || 0));
    if (callbackAmount && callbackAmount !== expectedAmount) {
      summary.errors++;
      console.log(`✗ ${label}: AMOUNT MISMATCH (tripay=${callbackAmount}, invoice=${expectedAmount}) — lewati, cek manual.`);
      continue;
    }

    const alreadyPaid = invoice.status === 'paid';
    console.log(`✓ ${label}: PAID di Tripay (ref=${usedRef}, method=${paidData.payment_method}, amount=${callbackAmount || expectedAmount})${alreadyPaid ? ' [invoice sudah paid — buat record Payment yg hilang]' : ''}.`);

    if (!COMMIT) {
      console.log(`   → [DRY-RUN] akan: ${alreadyPaid ? 'buat Payment (status tetap paid)' : 'set invoice paid + buat Payment'} + finalize.`);
      continue;
    }

    // ── COMMIT: transaksi DB ──────────────────────────────────────
    const t = await sequelize.transaction();
    try {
      // Kalau invoice belum paid, tandai paid. Kalau sudah paid (kasus record
      // Payment hilang), JANGAN ubah status/paid_date yang sudah benar.
      if (!alreadyPaid) {
        await Invoice.update(
          { status: 'paid', paid_date: new Date() },
          { where: { id: invoice.id }, transaction: t }
        );
      }
      const newPayment = await Payment.create({
        invoice_id: invoice.id,
        amount: callbackAmount || expectedAmount,
        payment_method: mapPayMethod(paidData.payment_method),
        payment_date: (invoice.paid_date ? new Date(invoice.paid_date) : new Date()).toISOString().slice(0, 10),
        reference_number: usedRef,
        gateway: 'tripay',
        notes: `Rekonsiliasi: Tripay ${paidData.payment_method || ''} (ref: ${usedRef})`
      }, { transaction: t });
      await t.commit();

      // finalize di luar transaksi (mengikuti pola webhook; melakukan side-effect
      // seperti restore isolir, sync keuangan, notifikasi)
      try {
        const fin = await finalizePaidInvoice({
          invoiceId: invoice.id, paymentId: newPayment.id,
          channel: 'tripay', referenceNo: usedRef
        });
        console.log(`   → OK: Payment #${newPayment.id} dibuat, finalize=${JSON.stringify(fin)}`);
      } catch (finErr) {
        console.log(`   → Payment #${newPayment.id} dibuat, tapi finalize error: ${finErr.message} (invoice tetap paid).`);
      }
      summary.reconciled++;
      logger.info(`[reconcileTripay] Invoice #${invoice.id} direkonsiliasi PAID via Tripay (ref=${usedRef})`);
    } catch (dbErr) {
      await t.rollback();
      summary.errors++;
      console.log(`✗ ${label}: gagal tulis DB — ${dbErr.message} (rolled back).`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log(' RINGKASAN');
  console.log(`  Invoice dicek           : ${summary.checked}`);
  console.log(`  Sudah punya Payment     : ${summary.skippedHasPayment}`);
  console.log(`  PAID di Tripay          : ${summary.paidOnTripay}`);
  console.log(`  ${COMMIT ? 'Direkonsiliasi (ditulis)' : 'Akan direkonsiliasi     '}: ${COMMIT ? summary.reconciled : summary.paidOnTripay}`);
  console.log(`  Belum PAID di Tripay    : ${summary.notPaid}`);
  console.log(`  Error / mismatch        : ${summary.errors}`);
  console.log('════════════════════════════════════════════════════════');
  if (!COMMIT && summary.paidOnTripay > 0) {
    console.log('\nℹ️  Ini DRY-RUN. Jalankan ulang dengan --commit untuk menerapkan.');
  }

  await sequelize.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('FATAL:', e.message);
  try { await sequelize.close(); } catch (_) {}
  process.exit(1);
});
