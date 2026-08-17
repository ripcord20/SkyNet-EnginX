'use strict';
const { InfrastructurePoint } = require('../models');
const { Op } = require('sequelize');

/**
 * CoverageService
 * ──────────────────────────────────────────────────────────────────
 * Mengecek ketersediaan jaringan untuk satu titik koordinat dengan
 * membandingkan terhadap infrastructure_points (ODP/ODC/POP).
 *
 * Metode:
 *   - Jarak udara dihitung dengan formula Haversine (meter).
 *   - Estimasi panjang kabel = jarak udara × ROAD_FACTOR (default 1.4)
 *     untuk memperkirakan rute kabel mengikuti jalan/tiang.
 *   - Coverage dinyatakan "available" jika ada ODP dalam radius
 *     MAX_ODP_RADIUS meter DAN ODP tersebut masih punya port kosong.
 */

const ROAD_FACTOR     = 1.4;   // faktor rute jalan vs garis lurus
const MAX_ODP_RADIUS  = 250;   // meter — batas drop core dari ODP ke rumah
const NEAR_ODP_RADIUS = 500;   // meter — masih "mungkin" (perlu survey)

function toRad(deg) { return (deg * Math.PI) / 180; }

// Haversine — hasil dalam meter
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function freePorts(p) {
  if (p.capacity == null) return null; // kapasitas tidak diketahui
  return Math.max(0, p.capacity - (p.used_ports || 0));
}

/**
 * @param {number} lat
 * @param {number} lng
 * @returns object hasil coverage check
 */
async function check(lat, lng) {
  lat = parseFloat(lat); lng = parseFloat(lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return { ok: false, message: 'Koordinat tidak valid' };
  }

  // Ambil semua titik aktif bertipe odp/odc/pop yang punya koordinat.
  // Dataset infrastruktur ISP umumnya ratusan baris → aman di-load semua
  // lalu dihitung jarak di aplikasi (lebih akurat dari bounding box SQL).
  const points = await InfrastructurePoint.findAll({
    where: {
      type: { [Op.in]: ['odp', 'odc', 'pop', 'tower'] },
      status: { [Op.ne]: 'inactive' },
      latitude:  { [Op.ne]: null },
      longitude: { [Op.ne]: null }
    },
    attributes: ['id', 'name', 'type', 'latitude', 'longitude', 'capacity', 'used_ports', 'status']
  });

  const odps = [];
  const pops = [];

  for (const p of points) {
    const d = haversineMeters(lat, lng, parseFloat(p.latitude), parseFloat(p.longitude));
    const entry = {
      id: p.id,
      name: p.name,
      type: p.type,
      distance: d,
      capacity: p.capacity,
      used_ports: p.used_ports || 0,
      free_ports: freePorts(p),
      cable_estimate: Math.round(d * ROAD_FACTOR)
    };
    if (p.type === 'odp' || p.type === 'odc') odps.push(entry);
    if (p.type === 'pop' || p.type === 'tower') pops.push(entry);
  }

  odps.sort((a, b) => a.distance - b.distance);
  pops.sort((a, b) => a.distance - b.distance);

  const nearestOdp = odps[0] || null;
  const nearestPop = pops[0] || null;

  // ODP terdekat yang masih punya port kosong (atau kapasitas tak diketahui)
  const usableOdp = odps.find(o => o.distance <= MAX_ODP_RADIUS && (o.free_ports == null || o.free_ports > 0)) || null;

  let coverage_status = 'not_covered';
  let message = 'Belum Terjangkau';

  if (usableOdp) {
    coverage_status = 'available';
    message = 'Coverage Available';
  } else if (nearestOdp && nearestOdp.distance <= NEAR_ODP_RADIUS) {
    coverage_status = 'unknown';
    message = 'Perlu Survey — ODP terdekat agak jauh / port penuh';
  }

  return {
    ok: true,
    coverage_status,
    message,
    road_factor: ROAD_FACTOR,
    nearest_odp: nearestOdp,
    nearest_pop: nearestPop,
    usable_odp: usableOdp,
    cable_estimate: (usableOdp || nearestOdp)?.cable_estimate ?? null,
    odps: odps.slice(0, 5),
    pops: pops.slice(0, 3)
  };
}

module.exports = { check, haversineMeters, ROAD_FACTOR, MAX_ODP_RADIUS };
