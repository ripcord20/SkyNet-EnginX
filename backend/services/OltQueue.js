'use strict';

/**
 * OltQueue — antrian eksekusi per-OLT.
 *
 * MASALAH yang dipecahkan:
 *   OLT (mis. ZTE C320) hanya punya sedikit sesi CLI dan satu shell stateful.
 *   Bila dua request menembak OLT yang sama bersamaan (mis. auto-refresh ONU +
 *   admin menekan "reboot", atau dua admin sekaligus), output CLI bisa tercampur,
 *   parsing kacau, atau OLT menolak koneksi baru. Ini sumber bug yang sulit dilacak.
 *
 * SOLUSI:
 *   Semua operasi ke satu OLT (di-key oleh host:port) dijalankan BERURUTAN.
 *   Operasi ke OLT berbeda tetap berjalan paralel. Antrian per-key, bukan global,
 *   jadi satu OLT lambat tidak memblokir OLT lain.
 *
 * Pemakaian:
 *   const result = await oltQueue.run(key, async () => {
 *     await svc.connect();
 *     try { return await svc.sesuatu(); }
 *     finally { await svc.disconnect().catch(()=>{}); }
 *   });
 */

class OltQueue {
  constructor() {
    // key → Promise rantai terakhir (tail). Operasi berikutnya menyambung ke tail.
    this._tails = new Map();
    // key → jumlah operasi yang sedang antre/berjalan (untuk cleanup & observability).
    this._counts = new Map();
    // Batas waktu tunggu dalam antrian sebelum dianggap macet (mencegah deadlock).
    this.maxWaitMs = 90000;
  }

  /**
   * Jalankan fn() secara serial untuk `key`. Mengembalikan hasil fn().
   * Error dari fn() diteruskan ke pemanggil, TANPA memutus rantai antrian
   * (operasi berikutnya tetap jalan).
   */
  run(key, fn) {
    const k = String(key || 'default');
    this._counts.set(k, (this._counts.get(k) || 0) + 1);

    const prev = this._tails.get(k) || Promise.resolve();

    // Sambungkan: tunggu operasi sebelumnya selesai (sukses ATAU gagal),
    // baru jalankan operasi ini.
    const runThis = prev
      .catch(() => {})                 // jangan biarkan error sebelumnya memutus rantai
      .then(() => this._withTimeoutGuard(k, fn));

    // Tail baru = penyelesaian operasi ini (apa pun hasilnya), supaya operasi
    // berikutnya menunggu operasi ini, bukan operasi lama.
    const newTail = runThis.then(
      () => this._afterDone(k),
      () => this._afterDone(k)
    );
    this._tails.set(k, newTail);

    return runThis;   // pemanggil menerima hasil/again error operasi ini
  }

  async _withTimeoutGuard(k, fn) {
    // Guard ringan: bila fn() menggantung melebihi maxWaitMs, lempar error
    // agar antrian tidak macet selamanya. fn() sendiri tetap berjalan, tapi
    // pemanggil dibebaskan. (Operasi OLT punya timeout sendiri di layer CLI.)
    let timer;
    const guard = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`Operasi OLT (${k}) melebihi batas waktu antrian`)), this.maxWaitMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(fn), guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  _afterDone(k) {
    const n = (this._counts.get(k) || 1) - 1;
    if (n <= 0) {
      this._counts.delete(k);
      // Bersihkan tail bila tidak ada lagi yang antre, supaya Map tidak tumbuh.
      this._tails.delete(k);
    } else {
      this._counts.set(k, n);
    }
  }

  /** Jumlah operasi antre/berjalan untuk sebuah key (untuk observability). */
  pending(key) {
    return this._counts.get(String(key || 'default')) || 0;
  }
}

// Singleton — dibagikan ke seluruh aplikasi.
module.exports = new OltQueue();
