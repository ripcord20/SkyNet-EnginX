/**
 * HrisGeoService
 * ──────────────────────────────────────────────────────────────────
 * Validasi anti-fake-GPS untuk absensi.
 *
 * Lapisan pemeriksaan:
 *   1. RADIUS   — jarak Haversine titik absen ke lokasi kerja ≤ radius.
 *   2. MOCK     — perangkat melaporkan mock/fake location (is_mock).
 *   3. ACCURACY — akurasi GPS harus ≤ max_accuracy_meters lokasi.
 *   4. IP/DEVICE— IP publik & device fingerprint dicatat; opsional
 *                 dibandingkan dengan whitelist / deteksi anomali.
 *
 * Hasil: { ok, hard_fail, distance, checks:{...}, reasons:[...] }
 *   - hard_fail = true  → absensi DITOLAK (radius luar / mock / akurasi buruk).
 *   - ok        = true  → semua lolos.
 *   - Selain itu absensi diterima tapi ditandai (flagged) untuk audit.
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg) { return (deg * Math.PI) / 180; }

/** Jarak Haversine antar dua titik (meter). */
function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Validasi satu event absensi (check-in / check-out).
 *
 * @param {object} p
 * @param {object} p.location   HrisWorkLocation instance/obj (lat,lng,radius,...)
 * @param {number} p.lat        Latitude yang dilaporkan perangkat
 * @param {number} p.lng        Longitude yang dilaporkan perangkat
 * @param {number} [p.accuracy] Akurasi GPS (meter) dari perangkat
 * @param {boolean}[p.isMock]   Flag mock location dari perangkat
 * @param {string} [p.ip]       IP publik
 * @param {string} [p.deviceId] Fingerprint perangkat
 * @param {string} [p.userAgent]
 */
function validateAttendance(p) {
  const {
    location, lat, lng,
    accuracy = null, isMock = false,
    ip = null, deviceId = null, userAgent = null
  } = p || {};

  const checks = {};
  const reasons = [];
  let hardFail = false;

  // Koordinat valid?
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  checks.coords_present = hasCoords;
  if (!hasCoords) {
    hardFail = true;
    reasons.push('Koordinat GPS tidak tersedia');
  }

  // ── 1. RADIUS ──────────────────────────────────────────────
  let distance = null;
  const allowAny = !!(location && location.allow_any_location);
  if (location && hasCoords) {
    distance = haversine(
      Number(location.latitude), Number(location.longitude),
      Number(lat), Number(lng)
    );
    const radius = Number(location.radius_meters) || 100;
    // Beri margin akurasi: titik dianggap dalam radius bila
    // (jarak - akurasi) ≤ radius, supaya GPS yang wajar tidak salah tolak.
    const effective = accuracy && Number.isFinite(accuracy)
      ? Math.max(0, distance - accuracy)
      : distance;
    checks.within_radius = allowAny ? true : effective <= radius;
    checks.distance_m = Math.round(distance);
    checks.radius_m = radius;
    if (!allowAny && !checks.within_radius) {
      hardFail = true;
      reasons.push(`Di luar radius lokasi kerja (${Math.round(distance)}m > ${radius}m)`);
    }
  } else if (!location) {
    checks.within_radius = null; // tidak ada lokasi → tidak divalidasi radius
    reasons.push('Lokasi kerja belum diset');
  }

  // ── 2. MOCK LOCATION ───────────────────────────────────────
  const rejectMock = !location || location.reject_mock_location !== false;
  checks.mock_detected = !!isMock;
  if (isMock && rejectMock) {
    hardFail = true;
    reasons.push('Terdeteksi fake/mock GPS');
  }

  // ── 3. ACCURACY ────────────────────────────────────────────
  if (accuracy != null && Number.isFinite(accuracy)) {
    const maxAcc = location ? (Number(location.max_accuracy_meters) || 50) : 50;
    checks.accuracy_m = Math.round(accuracy);
    checks.accuracy_ok = accuracy <= maxAcc;
    if (!checks.accuracy_ok) {
      // Akurasi buruk = soft flag, bukan hard fail (bisa karena sinyal),
      // KECUALI sangat buruk (> 3x batas) yang mengindikasikan spoof.
      if (accuracy > maxAcc * 3) {
        hardFail = true;
        reasons.push(`Akurasi GPS sangat buruk (${Math.round(accuracy)}m)`);
      } else {
        reasons.push(`Akurasi GPS rendah (${Math.round(accuracy)}m > ${maxAcc}m)`);
      }
    }
  } else {
    checks.accuracy_ok = null;
  }

  // ── 4. IP / DEVICE (dicatat untuk audit) ───────────────────
  checks.ip = ip || null;
  checks.device_id = deviceId || null;
  checks.user_agent = userAgent ? String(userAgent).slice(0, 200) : null;

  return {
    ok: !hardFail && reasons.length === 0,
    hard_fail: hardFail,
    flagged: !hardFail && reasons.length > 0,
    distance: distance == null ? null : Math.round(distance),
    checks,
    reasons
  };
}

module.exports = { haversine, validateAttendance };
