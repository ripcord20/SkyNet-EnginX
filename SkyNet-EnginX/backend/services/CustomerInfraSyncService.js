/**
 * CustomerInfraSyncService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Helper untuk sinkronisasi otomatis Customer ↔ InfrastructurePoint (type='customer').
 *
 * Tujuan:
 *   Setiap kali customer disimpan/diupdate/dihapus, record InfrastructurePoint
 *   bertipe 'customer' yang merepresentasikan customer tersebut di peta
 *   infrastruktur ikut tersinkron. Sehingga admin TIDAK perlu manual menambahkan
 *   titik customer dari halaman /infrastructure setelah membuat customer.
 *
 * Kontrak data:
 *   InfrastructurePoint.type        = 'customer'
 *   InfrastructurePoint.name        = customer.name
 *   InfrastructurePoint.latitude    = customer.latitude
 *   InfrastructurePoint.longitude   = customer.longitude
 *   InfrastructurePoint.address     = customer.address
 *   InfrastructurePoint.parent_id   = customer.infra_parent_id  (ID ODP/ODC induk)
 *   InfrastructurePoint.metadata    = { customer_id: customer.id }  ← KUNCI LINK
 *   InfrastructurePoint.status      = 'active' / 'inactive' / 'maintenance'
 *                                     (mapping dari customer.status)
 *
 * Strategi (full sync):
 *   - Punya koord + customer aktif/isolated → CREATE atau UPDATE point
 *   - Koord null/dihapus                    → DELETE point yang ada
 *   - Customer dihapus                      → DELETE point yang ada (cascade)
 *
 * Idempoten: aman dipanggil berkali-kali dengan customer yang sama.
 * Best-effort: error pada sync TIDAK membatalkan operasi customer utama.
 *              Error di-log saja agar customer flow tidak ke-block kalau
 *              tabel infrastructure_points ada masalah.
 */

'use strict';

const logger = require('../utils/logger');

/**
 * Map customer.status → InfrastructurePoint.status
 *   active    → active
 *   isolated  → maintenance  (masih tertandai di peta tapi visual berbeda)
 *   suspended → maintenance
 *   inactive  → inactive
 */
function mapCustomerStatus(custStatus) {
  switch (String(custStatus || '').toLowerCase()) {
    case 'active':    return 'active';
    case 'isolated':  return 'maintenance';
    case 'suspended': return 'maintenance';
    case 'inactive':  return 'inactive';
    default:          return 'active';
  }
}

/**
 * Cari InfrastructurePoint type='customer' milik customer_id tertentu.
 * Mencocokkan via metadata.customer_id. Karena metadata adalah JSON,
 * cara paling reliable di MySQL adalah scan semua type='customer' lalu
 * filter di JS. Tabel infrastructure_points biasanya kecil (per-customer)
 * jadi scan ini murah; kalau jumlahnya membengkak nanti, bisa di-optimalkan
 * dengan generated column atau index JSON path.
 */
async function findInfraPointForCustomer(customerId) {
  const { InfrastructurePoint } = require('../models');
  const points = await InfrastructurePoint.findAll({
    where: { type: 'customer' },
    attributes: ['id', 'metadata', 'parent_id', 'name', 'latitude', 'longitude', 'address', 'status', 'notes'],
  });
  for (const pt of points) {
    let meta = pt.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { meta = null; }
    }
    if (meta && Number(meta.customer_id) === Number(customerId)) {
      return pt;
    }
  }
  return null;
}

/**
 * Sinkronisasi 1 customer ke InfrastructurePoint.
 *
 * @param {Object} customer  - Instance Customer Sequelize (atau plain object dgn id/name/lat/lng/address/status/infra_parent_id)
 * @param {Object} [opts]
 * @param {boolean} [opts.deletePointIfNoCoord=true] - Hapus point kalau koord null
 * @returns {Promise<{action: 'created'|'updated'|'deleted'|'skipped', infraPointId?: number}>}
 */
async function syncCustomerToInfra(customer, opts = {}) {
  const { deletePointIfNoCoord = true } = opts;

  if (!customer || !customer.id) {
    return { action: 'skipped' };
  }

  try {
    const { InfrastructurePoint } = require('../models');

    const lat = customer.latitude == null || customer.latitude === '' ? null : parseFloat(customer.latitude);
    const lng = customer.longitude == null || customer.longitude === '' ? null : parseFloat(customer.longitude);
    const hasCoord = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);

    const existing = await findInfraPointForCustomer(customer.id);

    // CASE 1: Tidak ada koord
    if (!hasCoord) {
      if (existing && deletePointIfNoCoord) {
        await existing.destroy();
        return { action: 'deleted', infraPointId: existing.id };
      }
      return { action: 'skipped' };
    }

    // CASE 2: Ada koord
    const payload = {
      type:      'customer',
      name:      customer.name || 'Pelanggan',
      latitude:  lat,
      longitude: lng,
      address:   customer.address || null,
      parent_id: customer.infra_parent_id || null,
      status:    mapCustomerStatus(customer.status),
      metadata:  { customer_id: Number(customer.id) },
    };

    let infraPointId;
    let action;

    if (existing) {
      // Idempotent: kalau semua field target sudah sama, skip update untuk
      // mengurangi noise di activity log + hindari unnecessary write contention.
      const same = (
        String(existing.name)      === String(payload.name) &&
        Number(existing.latitude)  === Number(payload.latitude) &&
        Number(existing.longitude) === Number(payload.longitude) &&
        String(existing.address || '') === String(payload.address || '') &&
        Number(existing.parent_id || 0) === Number(payload.parent_id || 0) &&
        String(existing.status)    === String(payload.status)
      );
      if (same) {
        action = 'skipped';
        infraPointId = existing.id;
      } else {
        await existing.update(payload);
        action = 'updated';
        infraPointId = existing.id;
      }
    } else {
      const created = await InfrastructurePoint.create(payload);
      infraPointId = created.id;
      action = 'created';
      // Dedup-after-create: tangani race condition saat user menyimpan pin customer
      // dari halaman /infrastructure (yang paralel POST infra + PUT customer).
      // Kalau ada >1 point dgn metadata.customer_id yang sama, sisakan yang ID
      // paling kecil (umumnya yg dibuat lebih dulu) dan hapus duplikat lainnya.
      try {
        const all = await InfrastructurePoint.findAll({
          where: { type: 'customer' },
          attributes: ['id', 'metadata'],
        });
        const dupes = [];
        for (const pt of all) {
          let meta = pt.metadata;
          if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); } catch (_) { meta = null; }
          }
          if (meta && Number(meta.customer_id) === Number(customer.id)) {
            dupes.push(pt.id);
          }
        }
        if (dupes.length > 1) {
          dupes.sort((a, b) => a - b);
          const keepId = dupes[0]; // ID terkecil = yang paling dulu dibuat
          const removeIds = dupes.slice(1);
          await InfrastructurePoint.destroy({ where: { id: removeIds } });
          logger.warn(`[CustomerInfraSync] Dedup race: customer ${customer.id} punya ${dupes.length} points, sisakan id=${keepId}, hapus ${removeIds.join(',')}`);
          infraPointId = keepId;
        }
      } catch (dedupErr) {
        logger.warn(`[CustomerInfraSync] Dedup check gagal: ${dedupErr.message}`);
      }
    }

    // ── Sync InfrastructureLink customer ↔ parent ─────────────
    // Tujuan: garis kabel di peta jadi record manual (bisa di-klik, hapus,
    // edit waypoints) — bukan polyline virtual dari parent_id.
    //
    // Aturan:
    //   - parent_id ada → ensure ada 1 link (customer ↔ parent), TIDAK timpa
    //     link manual yang sudah dibuat user (deteksi via metadata.auto_from_customer)
    //   - parent_id null → hapus link auto yang ada (kalau user pernah set
    //     parent lalu di-clear, link auto-nya ikut hilang). Link manual tetap.
    //   - User boleh hapus link manual dari UI → kalau saat sync berikutnya
    //     ditemukan tidak ada link, akan dibuat ulang. Itu OK untuk user yang
    //     mau "redraw" — dia bisa hapus → gambar ulang via Draw Link, dan
    //     link manual barunya akan dihormati helper (tidak ditimpa).
    try {
      await syncCustomerLink(customer, infraPointId, payload.parent_id);
    } catch (linkErr) {
      logger.warn(`[CustomerInfraSync] Sync link gagal: ${linkErr.message}`);
    }

    return { action, infraPointId };
  } catch (err) {
    logger.warn(`[CustomerInfraSync] Gagal sync customer ${customer.id}: ${err.message}`);
    return { action: 'skipped', error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// syncCustomerLink — ensure InfrastructureLink record customer ↔ parent
// ─────────────────────────────────────────────────────────────────────
//
// Strategi:
//   1. Kalau parent_id null → hapus link auto (yang punya metadata.auto_from_customer=true).
//   2. Kalau parent_id ada:
//      a. Cek apakah sudah ada link manual atau auto antara titik customer & parent.
//         Pakai pasangan (from, to) yang di-normalize (id kecil dulu).
//      b. Kalau ada link MANUAL (auto_from_customer != true) → biarkan, jangan timpa.
//      c. Kalau ada link AUTO existing → biarkan (idempotent), TIDAK timpa
//         waypoints/distance yang mungkin sudah di-edit user di link auto itu.
//         (User bisa convert link auto jadi manual dengan edit; helper hormati.)
//      d. Kalau tidak ada link → buat link AUTO baru, garis lurus tanpa waypoints.
//
async function syncCustomerLink(customer, customerPointId, parentId) {
  const { InfrastructureLink } = require('../models');
  const { Op } = require('sequelize');

  if (!customerPointId) return;

  // Cari semua link yang melibatkan titik customer ini
  const existingLinks = await InfrastructureLink.findAll({
    where: {
      [Op.or]: [
        { from_point_id: customerPointId },
        { to_point_id:   customerPointId },
      ],
    },
  });

  // Kalau parent_id kosong → hapus semua link AUTO yang melibatkan customer ini.
  // Link manual tidak disentuh.
  if (!parentId) {
    for (const link of existingLinks) {
      let meta = link.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch (_) { meta = null; }
      }
      if (meta && meta.auto_from_customer === true) {
        await link.destroy();
      }
    }
    return;
  }

  // Cek apakah sudah ada link (manual atau auto) antara customer & parent
  const matchingLink = existingLinks.find(link =>
    (link.from_point_id === customerPointId && link.to_point_id === parentId) ||
    (link.from_point_id === parentId && link.to_point_id === customerPointId)
  );

  if (matchingLink) {
    // Sudah ada link customer↔parent — biarkan apa adanya (idempotent).
    // Tidak overwrite waypoints/distance/notes yang mungkin sudah di-edit user.
    return;
  }

  // Hapus dulu link AUTO ke parent LAIN (kalau ada) — user mungkin baru saja
  // ganti parent dari ODP-X ke ODP-Y, link auto ke ODP-X harus hilang.
  for (const link of existingLinks) {
    let meta = link.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { meta = null; }
    }
    if (meta && meta.auto_from_customer === true) {
      await link.destroy();
    }
  }

  // Buat link AUTO baru customer → parent (garis lurus, tanpa waypoints)
  await InfrastructureLink.create({
    name:          `${customer.name || 'Pelanggan'} ↔ parent`,
    from_point_id: customerPointId,
    to_point_id:   parentId,
    link_type:     'fiber',
    status:        'active',
    waypoints:     null,
    notes:         null,
    metadata:      { auto_from_customer: true, customer_id: Number(customer.id) },
  });
}

/**
 * Hapus InfrastructurePoint milik customer (dipanggil sebelum/sesudah customer.destroy).
 * Idempoten — kalau point tidak ada, return action='skipped' tanpa error.
 *
 * Sekaligus hapus semua InfrastructureLink yang melibatkan titik customer ini,
 * agar tidak ada FK orphan / garis menggantung di peta.
 *
 * @param {number} customerId
 * @returns {Promise<{action: 'deleted'|'skipped', infraPointId?: number}>}
 */
async function removeInfraForCustomer(customerId) {
  if (!customerId) return { action: 'skipped' };
  try {
    const existing = await findInfraPointForCustomer(customerId);
    if (!existing) return { action: 'skipped' };

    // Hapus dulu semua link yang melibatkan titik ini (manual + auto)
    try {
      const { InfrastructureLink } = require('../models');
      const { Op } = require('sequelize');
      await InfrastructureLink.destroy({
        where: {
          [Op.or]: [
            { from_point_id: existing.id },
            { to_point_id:   existing.id },
          ],
        },
      });
    } catch (linkErr) {
      logger.warn(`[CustomerInfraSync] Gagal hapus link untuk infra point ${existing.id}: ${linkErr.message}`);
    }

    await existing.destroy();
    return { action: 'deleted', infraPointId: existing.id };
  } catch (err) {
    logger.warn(`[CustomerInfraSync] Gagal hapus infra point customer ${customerId}: ${err.message}`);
    return { action: 'skipped', error: err.message };
  }
}

/**
 * Versi batch untuk import Excel — sync banyak customer sekaligus.
 * Mengembalikan ringkasan agar bisa di-include ke response import.
 *
 * @param {Array<Object>} customers - List object {id,name,lat,lng,address,status,infra_parent_id}
 * @returns {Promise<{created:number, updated:number, deleted:number, skipped:number, errors:number}>}
 */
async function syncBatchCustomersToInfra(customers) {
  const stats = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
  for (const c of customers) {
    const result = await syncCustomerToInfra(c);
    if (result.error) stats.errors++;
    else stats[result.action] = (stats[result.action] || 0) + 1;
  }
  return stats;
}

module.exports = {
  syncCustomerToInfra,
  syncCustomerLink,
  removeInfraForCustomer,
  syncBatchCustomersToInfra,
  findInfraPointForCustomer,
};
