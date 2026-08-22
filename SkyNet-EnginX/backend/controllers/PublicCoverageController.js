/**
 * PublicCoverageController.js
 * ──────────────────────────────────────────────────────────────────
 * Endpoint PUBLIK (tanpa login) yang menyediakan data cakupan jaringan
 * untuk halaman /coverage di landing page CMS.
 *
 * Berbeda dengan InfrastructureController.mapData() yang dipakai panel
 * admin, controller ini SENGAJA hanya mengirim data minimum:
 *
 *   - Hanya titik bertipe ODP dan ODC yang berstatus 'active'.
 *     ONT adalah perangkat di rumah pelanggan — tidak boleh ikut,
 *     karena itu sama saja mengumumkan alamat pelanggan.
 *   - Nama internal (mis. "ODP-BTM-03") TIDAK dikirim. Penamaan
 *     internal membocorkan struktur jaringan dan pola penomoran.
 *   - capacity / used_ports / notes / metadata TIDAK dikirim.
 *     Informasi "ODP ini penuh" berguna bagi kompetitor untuk menilai
 *     beban jaringan, dan tidak dibutuhkan calon pelanggan.
 *   - Koordinat DIBULATKAN ke 4 desimal (~11 meter). Cukup untuk
 *     menunjukkan area terjangkau, tapi tidak menuntun orang ke tiang
 *     atau kotak perangkat yang persis.
 *
 * Respons di-cache di memori beberapa menit supaya lonjakan pengunjung
 * landing page tidak membebani database billing.
 * ──────────────────────────────────────────────────────────────────
 */
const { Op } = require('sequelize');
const { InfrastructurePoint } = require('../models');

// Tipe yang boleh tampil di publik. ONT dan 'customer' sengaja TIDAK
// dimasukkan — keduanya menunjuk lokasi rumah pelanggan.
const TIPE_PUBLIK = ['odp', 'odc'];

// Pembulatan koordinat: 4 desimal ≈ 11 meter di khatulistiwa.
const PRESISI = 4;

// Cache sederhana di memori (proses tunggal). Tidak perlu Redis untuk
// data yang jarang berubah seperti ini.
const CACHE_MS = 5 * 60 * 1000;
let cache = { data: null, waktu: 0 };

function bulatkan(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Number(v.toFixed(PRESISI)) : null;
}

class PublicCoverageController {
  /**
   * GET /pub/coverage
   *
   * Respons:
   * {
   *   success: true,
   *   updated_at: "2026-07-24T08:00:00.000Z",
   *   count: 42,
   *   points: [ { type: "odp", lat: -6.2431, lng: 106.8412 }, ... ]
   * }
   */
  async points(req, res) {
    try {
      const sekarang = Date.now();
      if (cache.data && (sekarang - cache.waktu) < CACHE_MS) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cache.data);
      }

      const rows = await InfrastructurePoint.findAll({
        where: {
          type: { [Op.in]: TIPE_PUBLIK },
          status: 'active',
        },
        // Hanya kolom yang benar-benar dikirim. Jangan ambil kolom lain
        // supaya tidak ada data sensitif yang tanpa sengaja ikut terbawa
        // bila kode ini diubah orang lain di kemudian hari.
        attributes: ['type', 'latitude', 'longitude'],
      });

      const points = rows
        .map((r) => ({
          type: r.type,
          lat: bulatkan(r.latitude),
          lng: bulatkan(r.longitude),
        }))
        .filter((p) => p.lat !== null && p.lng !== null);

      const hasil = {
        success: true,
        updated_at: new Date().toISOString(),
        count: points.length,
        points,
      };

      cache = { data: hasil, waktu: sekarang };
      res.setHeader('X-Cache', 'MISS');
      return res.json(hasil);
    } catch (e) {
      console.error('[PublicCoverage] gagal:', e.message);
      // Jangan bocorkan pesan error internal ke publik.
      return res.status(500).json({ success: false, message: 'Data cakupan tidak tersedia.' });
    }
  }

  /**
   * GET /pub/coverage/check?lat=..&lng=..
   *
   * Menjawab apakah sebuah titik berada dalam jangkauan, TANPA
   * memberitahu ODP mana yang terdekat atau berapa jaraknya secara persis.
   * Dipakai fitur "cek ketersediaan di alamat saya" di landing page.
   */
  async check(req, res) {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ success: false, message: 'Koordinat tidak valid.' });
      }

      // Radius layanan wajar dari sebuah ODP (meter). Bisa disesuaikan
      // lewat env bila kondisi lapangan berbeda.
      const RADIUS = Number(process.env.COVERAGE_RADIUS_M || 300);

      const rows = await InfrastructurePoint.findAll({
        where: { type: { [Op.in]: TIPE_PUBLIK }, status: 'active' },
        attributes: ['latitude', 'longitude'],
      });

      // Haversine — cukup akurat untuk jarak pendek seperti ini.
      const R = 6371000;
      const rad = (d) => (d * Math.PI) / 180;
      let terjangkau = false;

      for (const r of rows) {
        const dLat = rad(Number(r.latitude) - lat);
        const dLng = rad(Number(r.longitude) - lng);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(rad(lat)) * Math.cos(rad(Number(r.latitude))) * Math.sin(dLng / 2) ** 2;
        const jarak = 2 * R * Math.asin(Math.sqrt(a));
        if (jarak <= RADIUS) { terjangkau = true; break; }
      }

      // Sengaja hanya boolean: jarak persis ke ODP terdekat akan
      // memungkinkan orang melakukan trilaterasi untuk menemukan
      // lokasi perangkat meski koordinatnya tidak dikirim.
      return res.json({ success: true, covered: terjangkau });
    } catch (e) {
      console.error('[PublicCoverage] cek gagal:', e.message);
      return res.status(500).json({ success: false, message: 'Pengecekan tidak tersedia.' });
    }
  }
}

module.exports = new PublicCoverageController();
