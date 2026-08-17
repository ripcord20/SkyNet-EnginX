/**
 * AreaAssignService.js
 * ──────────────────────────────────────────────────────────────────
 * Auto-assign lead (registrasi tanpa kode referral) ke sales berdasarkan
 * AREA: kecamatan/kota dari koordinat lead dicocokkan dengan teks
 * `region` di SalesProfile.
 *
 * Alur:
 *   1. Reverse-geocode lat/lng → ambil nama wilayah (kelurahan, kecamatan,
 *      kota/kabupaten) via Nominatim OpenStreetMap.
 *   2. Cocokkan nama-nama wilayah itu dengan `region` tiap sales aktif
 *      (case-insensitive, substring dua arah).
 *   3. Kembalikan sales pertama yang cocok (atau null bila tidak ada).
 *
 * Catatan:
 *   - Tidak menggagalkan pendaftaran bila geocode gagal — cukup return null.
 *   - Hasil reverse-geocode di-cache sederhana per proses (hemat panggilan).
 * ──────────────────────────────────────────────────────────────────
 */
const { SalesProfile, User } = require('../models');

const _geoCache = new Map(); // key: "lat,lng" (3 desimal) → array nama wilayah

// Normalisasi teks utk pencocokan: lowercase, buang prefix umum & spasi ganda.
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(kecamatan|kec\.?|kelurahan|kel\.?|desa|kota|kabupaten|kab\.?|administrasi)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reverse geocode → daftar nama wilayah (paling spesifik dulu).
async function reverseGeocode(lat, lng) {
  const key = `${(+lat).toFixed(3)},${(+lng).toFixed(3)}`;
  if (_geoCache.has(key)) return _geoCache.get(key);

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=id&zoom=14`;
  let names = [];
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000); // timeout 6s
    const r = await fetch(url, {
      headers: { 'User-Agent': 'FLAYNET-Sales/1.0', 'Accept': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(to);
    if (r.ok) {
      const j = await r.json();
      const a = j.address || {};
      // Urut dari spesifik → umum
      names = [
        a.village, a.suburb, a.neighbourhood, a.hamlet,
        a.city_district, a.municipality, a.subdistrict, a.county,
        a.town, a.city, a.regency, a.state_district
      ].filter(Boolean);
    }
  } catch (_) { /* timeout / network → names kosong */ }

  _geoCache.set(key, names);
  return names;
}

/**
 * Cari sales_id yang area-nya cocok dengan koordinat lead.
 * @returns {Promise<{sales_id:number, sales_name:string, referral_code:string, matched_area:string} | null>}
 */
async function assignByArea(lat, lng) {
  if (lat == null || lng == null) return null;

  const areaNames = await reverseGeocode(lat, lng);
  if (!areaNames.length) return null;
  const areaNorm = areaNames.map(norm).filter(Boolean);

  // Ambil sales aktif yang punya region terisi
  const profiles = await SalesProfile.findAll({
    where: { is_active: true },
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'is_active'] }]
  });

  for (const prof of profiles) {
    if (!prof.region || !prof.user || prof.user.is_active === false) continue;
    const regNorm = norm(prof.region);
    if (!regNorm) continue;
    // region sales bisa berisi beberapa area dipisah koma
    const regParts = regNorm.split(/[,/;]+/).map(s => s.trim()).filter(Boolean);

    const hit = areaNorm.some(an =>
      regParts.some(rp => rp && an && (an.includes(rp) || rp.includes(an)))
    );
    if (hit) {
      return {
        sales_id: prof.user.id,
        sales_name: prof.user.name,
        referral_code: prof.referral_code,
        matched_area: areaNames[0] || prof.region
      };
    }
  }
  return null;
}

module.exports = { assignByArea, reverseGeocode, norm };
