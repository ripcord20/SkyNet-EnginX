/**
 * HrisAttendanceService
 * ──────────────────────────────────────────────────────────────────
 * Perhitungan turunan absensi: keterlambatan, pulang cepat, menit kerja,
 * lembur, dan penentuan status harian berdasarkan shift.
 *
 * Waktu shift disimpan sebagai 'HH:MM:SS' zona lokal. Untuk sebuah
 * work_date kita bentuk Date lokal gabungan tanggal + jam shift.
 */

const moment = require('moment');

/** Bangun moment untuk jam shift pada tanggal tertentu (opsional +1 hari). */
function shiftMoment(workDate, timeStr, addDay = 0) {
  const m = moment(`${workDate} ${timeStr}`, 'YYYY-MM-DD HH:mm:ss');
  if (addDay) m.add(addDay, 'day');
  return m;
}

/**
 * Hitung metrik & status dari satu record absensi.
 * @param {object} p
 * @param {string} p.workDate      'YYYY-MM-DD'
 * @param {object} p.shift         HrisShift-like { start_time,end_time,crosses_midnight,grace_late_minutes,early_leave_minutes,break_minutes }
 * @param {Date|string} [p.checkIn]
 * @param {Date|string} [p.checkOut]
 * @returns {object} { late_minutes, early_leave_minutes, work_minutes, overtime_minutes, status }
 */
function computeMetrics(p) {
  const { workDate, shift, checkIn, checkOut } = p;
  const out = {
    late_minutes: 0,
    early_leave_minutes: 0,
    work_minutes: 0,
    overtime_minutes: 0,
    status: 'hadir'
  };

  if (!checkIn) {
    out.status = 'alfa';
    return out;
  }

  const ci = moment(checkIn);
  const co = checkOut ? moment(checkOut) : null;

  if (!shift) {
    // Tanpa shift: hanya hitung durasi kerja bila ada check-out.
    if (co) out.work_minutes = Math.max(0, co.diff(ci, 'minutes'));
    out.status = 'hadir';
    return out;
  }

  const start = shiftMoment(workDate, shift.start_time);
  const end   = shiftMoment(workDate, shift.end_time, shift.crosses_midnight ? 1 : 0);
  const grace = Number(shift.grace_late_minutes) || 0;
  const earlyTol = Number(shift.early_leave_minutes) || 0;
  const breakMin = Number(shift.break_minutes) || 0;

  // ── Keterlambatan ──
  const lateBy = ci.diff(start, 'minutes');
  if (lateBy > grace) {
    out.late_minutes = lateBy;
    out.status = 'terlambat';
  }

  // ── Pulang cepat & durasi kerja ──
  if (co) {
    const earlyBy = end.diff(co, 'minutes');
    if (earlyBy > earlyTol) {
      out.early_leave_minutes = earlyBy;
      if (out.status === 'hadir') out.status = 'pulang_cepat';
    }
    let worked = co.diff(ci, 'minutes') - breakMin;
    out.work_minutes = Math.max(0, worked);

    // ── Lembur: menit setelah jam pulang shift ──
    const otMin = co.diff(end, 'minutes');
    if (otMin > 0) out.overtime_minutes = otMin;
  }

  return out;
}

module.exports = { computeMetrics, shiftMoment };
