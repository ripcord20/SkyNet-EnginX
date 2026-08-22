'use strict';

/**
 * MonitorStateStore.js
 * ─────────────────────────────────────────────────────────────────────
 * Lapisan persistensi + flapping-guard untuk MonitoringService.
 *
 * Tujuan:
 *   1. PERSIST  — status transisi (up/down) tiap entitas disimpan ke tabel
 *      monitor_states, dimuat kembali saat startup. Restart tidak lagi
 *      menghapus state → transisi tetap akurat (tidak ada notif hilang/dobel).
 *   2. FLAPPING GUARD — perubahan status harus stabil minimal N detik sebelum
 *      dipromosikan jadi status resmi & memicu notifikasi. Mencegah spam saat
 *      link "kedip" (down<guard lalu up lagi).
 *
 * Dipakai oleh MonitoringService via evaluate(kind, refId, isDown, opts).
 * Mengembalikan 'down' | 'recover' | null (tidak ada transisi yg perlu dikirim).
 *
 * Cache in-memory dipakai untuk kecepatan; DB di-update best-effort (async,
 * tidak memblok evaluasi). Tabel monitor_states adalah sumber kebenaran saat
 * cold-start.
 */

const logger = require('../utils/logger');

// Cache: `${kind}:${refId}` → { status, pending, pendingSince(ms), baselineDone }
const _cache = new Map();
let _loaded = false;

const keyOf = (kind, refId) => `${kind}:${String(refId)}`;

/**
 * load() — muat seluruh status tersimpan ke cache. Dipanggil sekali saat
 * startup (server.js) sebelum monitoring jalan. Aman dipanggil ulang.
 */
async function load() {
  try {
    const { MonitorState } = require('../models');
    if (!MonitorState) { _loaded = true; return; }
    const rows = await MonitorState.findAll();
    for (const r of rows) {
      _cache.set(keyOf(r.kind, r.ref_id), {
        status: r.status || 'up',
        pending: r.pending_status || null,
        pendingSince: r.pending_since ? new Date(r.pending_since).getTime() : 0,
        baselineDone: true, // sudah ada di DB → bukan baseline lagi
      });
    }
    _loaded = true;
    logger.info(`[MonitorStore] Loaded ${rows.length} persisted states`);
  } catch (e) {
    _loaded = true; // jangan blokir monitoring kalau tabel belum ada
    logger.warn('[MonitorStore] load gagal (lanjut tanpa persistensi): ' + (e.message || e));
  }
}

function isLoaded() { return _loaded; }

// Upsert satu state ke DB (best-effort, tidak melempar).
async function _persist(kind, refId, entry, changed) {
  try {
    const { MonitorState } = require('../models');
    if (!MonitorState) return;
    await MonitorState.upsert({
      kind, ref_id: String(refId),
      status: entry.status,
      pending_status: entry.pending || null,
      pending_since: entry.pendingSince ? new Date(entry.pendingSince) : null,
      last_change_at: changed ? new Date() : undefined,
    });
  } catch (e) {
    if (!/unique|duplicate/i.test(e.message || '')) {
      logger.debug('[MonitorStore] persist gagal: ' + (e.message || e));
    }
  }
}

/**
 * evaluate(kind, refId, isDown, opts) → 'down' | 'recover' | null
 *
 * opts:
 *   isBaseline     : true → polling pertama untuk kind ini & belum ada state
 *                    tersimpan; jadikan baseline (set status, jangan kirim).
 *   flapGuardSec   : detik stabil minimum sebelum transisi dipromosikan (0=off).
 *   now            : timestamp ms (default Date.now()), untuk testability.
 */
function evaluate(kind, refId, isDown, opts = {}) {
  const now = opts.now || Date.now();
  const guardMs = Math.max(0, (opts.flapGuardSec || 0) * 1000);
  const k = keyOf(kind, refId);
  const cur = isDown ? 'down' : 'up';

  let entry = _cache.get(k);

  // Belum pernah terlihat sama sekali.
  if (!entry) {
    entry = { status: cur, pending: null, pendingSince: 0, baselineDone: true };
    _cache.set(k, entry);
    // Pertama kali terlihat & langsung down (bukan baseline run) → kirim down.
    const fire = (!opts.isBaseline && isDown) ? 'down' : null;
    _persist(kind, refId, entry, true);
    return fire;
  }

  // Run baseline (mis. dipaksa manual) saat belum ada perubahan tersimpan:
  // sinkronkan status tanpa kirim.
  if (opts.isBaseline && !entry.baselineDone) {
    entry.status = cur; entry.pending = null; entry.pendingSince = 0; entry.baselineDone = true;
    _persist(kind, refId, entry, false);
    return null;
  }

  // Status sama dengan yang resmi → reset pending (link stabil kembali).
  if (cur === entry.status) {
    if (entry.pending) { entry.pending = null; entry.pendingSince = 0; _persist(kind, refId, entry, false); }
    return null;
  }

  // Status BERBEDA dari resmi → kandidat transisi.
  // Flapping guard: tunggu stabil guardMs sebelum promosi.
  if (guardMs > 0) {
    if (entry.pending !== cur) {
      // Mulai/ganti kandidat — catat waktu mulai.
      entry.pending = cur; entry.pendingSince = now;
      _persist(kind, refId, entry, false);
      return null; // belum stabil
    }
    // Kandidat sama; sudah cukup stabil?
    if (now - entry.pendingSince < guardMs) return null; // masih menunggu
  }

  // Promosikan transisi.
  const tr = (entry.status === 'up' && cur === 'down') ? 'down'
           : (entry.status === 'down' && cur === 'up') ? 'recover' : null;
  entry.status = cur; entry.pending = null; entry.pendingSince = 0; entry.baselineDone = true;
  _persist(kind, refId, entry, true);
  return tr;
}

// Hitung berapa entitas per-kind yang sedang DOWN (untuk stat & /status bot nanti).
function countDown(kind) {
  let n = 0;
  for (const [k, v] of _cache) {
    if (k.startsWith(kind + ':') && v.status === 'down') n++;
  }
  return n;
}

// Reset baseline flag (dipakai run manual agar mengevaluasi transisi).
function resetBaseline() {
  for (const v of _cache.values()) v.baselineDone = true; // sudah persist → tetap evaluasi transisi
}

module.exports = { load, isLoaded, evaluate, countDown, resetBaseline, keyOf };
