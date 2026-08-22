'use strict';
const { SalesProfile, SalesCommission, Package } = require('../models');

/**
 * CommissionService
 * ──────────────────────────────────────────────────────────────────
 * Menghitung komisi sales untuk satu aktivasi pelanggan.
 *
 * Urutan prioritas skema (sesuai konfigurasi):
 *   1. flat_package      — Package.commission_flat   (jika > 0)
 *   2. percent_monthly   — Package.commission_percent (% dari Package.price)
 *   3. category_default  — SalesProfile.commission_<category>
 *
 * Komisi di-"earn" saat Work Order instalasi selesai (done).
 */

function num(v) { const n = parseFloat(v); return Number.isNaN(n) ? 0 : n; }

/**
 * Hitung nominal komisi (tanpa menyimpan).
 * @param {object} pkg     instance/POJO Package (boleh null)
 * @param {object} profile instance/POJO SalesProfile (boleh null)
 * @returns {{amount:number, scheme:string, detail:string}}
 */
function compute(pkg, profile) {
  // 1) Flat per paket
  if (pkg && num(pkg.commission_flat) > 0) {
    const amount = num(pkg.commission_flat);
    return {
      amount,
      scheme: 'flat_package',
      detail: `Komisi flat paket ${pkg.name}`
    };
  }

  // 2) Persentase dari harga paket bulanan
  if (pkg && num(pkg.commission_percent) > 0) {
    const pct = num(pkg.commission_percent);
    const amount = Math.round((num(pkg.price) * pct) / 100);
    return {
      amount,
      scheme: 'percent_monthly',
      detail: `${pct}% × Rp${num(pkg.price).toLocaleString('id-ID')}`
    };
  }

  // 3) Default per kategori dari profil sales
  const category = (pkg && pkg.category) || 'home';
  const map = {
    home:       profile ? num(profile.commission_home) : 50000,
    business:   profile ? num(profile.commission_business) : 250000,
    enterprise: profile ? num(profile.commission_enterprise) : 1000000,
    custom:     profile ? num(profile.commission_custom) : 0
  };
  const amount = map[category] ?? 0;
  return {
    amount,
    scheme: 'category_default',
    detail: `Default kategori ${category}`
  };
}

/**
 * Buat record komisi 'earned' untuk satu registrasi yang baru aktif.
 * Idempoten: kalau sudah ada komisi non-void untuk registration_id ini,
 * tidak membuat duplikat.
 *
 * @param {object} opts { sales_id, registration_id, customer_id, package_id, transaction }
 * @returns {SalesCommission|null}
 */
async function createForActivation({ sales_id, registration_id, customer_id, package_id, transaction = null }) {
  if (!sales_id) return null;

  // Cegah duplikat
  const existing = await SalesCommission.findOne({
    where: { registration_id, status: ['pending', 'earned', 'paid'] },
    transaction
  });
  if (existing) return existing;

  const [profile, pkg] = await Promise.all([
    SalesProfile.findOne({ where: { user_id: sales_id }, transaction }),
    package_id ? Package.findByPk(package_id, { transaction }) : Promise.resolve(null)
  ]);

  const { amount, scheme, detail } = compute(pkg, profile);

  try {
    return await SalesCommission.create({
      sales_id,
      registration_id,
      customer_id,
      package_id,
      amount,
      scheme,
      scheme_detail: detail,
      status: 'earned',
      earned_at: new Date()
    }, { transaction });
  } catch (e) {
    // Race condition: dua proses membuat komisi untuk registrasi sama secara
    // bersamaan. Unique index DB menolak yang kedua → ambil yang sudah ada.
    if (e && (e.name === 'SequelizeUniqueConstraintError' || e.name === 'SequelizeForeignKeyConstraintError')) {
      const found = await SalesCommission.findOne({ where: { registration_id }, transaction });
      if (found) return found;
    }
    throw e;
  }
}

module.exports = { compute, createForActivation };
