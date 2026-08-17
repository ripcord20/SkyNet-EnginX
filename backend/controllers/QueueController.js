const { getMikrotikInstance, getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const logger = require('../utils/logger');

// Helper: ambil device_id dari query/header lalu return instance MikroTik
function resolveDeviceId(req) {
  const q = req.query?.device_id;
  const h = req.headers?.['x-device-id'];
  const v = q || h;
  if (v == null || v === '') return null;
  const n = parseInt(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getMt(req) {
  return getMikrotikInstanceByDevice(resolveDeviceId(req));
}

// Resolve device record juga (untuk active-device endpoint & error context)
async function resolveDevice(req) {
  const { Device } = require('../models');
  const id = resolveDeviceId(req);
  if (id) {
    const d = await Device.findByPk(id, { attributes: ['id', 'name', 'ip_address', 'api_port', 'status', 'is_active', 'type'] });
    if (d) return d;
  }
  // auto-pick: primary > router pertama yg aktif
  try {
    const p = await Device.findOne({
      where: { is_primary: true, type: 'router', is_active: true },
      attributes: ['id', 'name', 'ip_address', 'api_port', 'status']
    });
    if (p) return p;
  } catch (_) { /* kolom is_primary belum ada */ }
  return Device.findOne({
    where: { type: 'router', is_active: true },
    attributes: ['id', 'name', 'ip_address', 'api_port', 'status'],
    order: [['id', 'ASC']]
  });
}

// 
function validateQueueId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^\*[A-Za-z0-9]+$/.test(id);
}

// Bungkus error MikroTik agar message-nya konsisten & mudah di-handle frontend
function mtError(err, fallback = 'Operasi gagal') {
  const msg = err?.message || fallback;
  // Map error spesifik ke status code yg lebih masuk akal
  if (/timeout|timed out/i.test(msg))           return { status: 504, message: 'Connection timeout — MikroTik tidak merespons' };
  if (/ECONNREFUSED|Cannot connect/i.test(msg)) return { status: 502, message: 'Tidak bisa konek ke MikroTik. Cek host/port' };
  if (/Koneksi.*terputus|ECONNRESET/i.test(msg))return { status: 502, message: 'Koneksi ke MikroTik terputus' };
  if (/401|unauthor/i.test(msg))                return { status: 401, message: 'Username/password MikroTik salah' };
  if (/403|forbid/i.test(msg))                  return { status: 403, message: 'User MikroTik tidak punya akses REST API' };
  if (/no such item|not found/i.test(msg))      return { status: 404, message: 'Queue tidak ditemukan' };
  return { status: 500, message: msg };
}

class QueueController {
  // GET /api/mikrotik/queues
  async index(req, res) {
    try {
      const mt = await getMt(req);
      const queues = await mt.getQueues();
      res.json({ success: true, data: queues, total: queues.length });
    } catch (err) {
      logger.error('Queue list error:', err.message);
      const e = mtError(err, 'Gagal load queue');
      res.status(e.status).json({ success: false, message: e.message });
    }
  }

  // GET /api/mikrotik/queues/stats  (lightweight, untuk polling)
  async stats(req, res) {
    try {
      const mt = await getMt(req);
      const stats = await mt.getQueueStats();
      res.json({ success: true, data: stats, timestamp: new Date() });
    } catch (err) {
      // Untuk polling, kita tidak log error tiap request — log di route /queues saja
      const e = mtError(err, 'Gagal poll stats');
      res.status(e.status).json({ success: false, message: e.message });
    }
  }

  // GET /api/mikrotik/queues/active-device
  // Memberitahu frontend device mana yg sedang dipakai (setelah resolve di server).
  // Berguna kalau frontend pakai auto-pick (tidak kirim device_id) — agar banner akurat.
  async activeDevice(req, res) {
    try {
      const dev = await resolveDevice(req);
      if (!dev) {
        return res.json({ success: true, data: null, source: 'global', message: 'Tidak ada device router terdaftar — pakai config global' });
      }
      res.json({
        success: true,
        source: 'device',
        data: {
          id:         dev.id,
          name:       dev.name,
          ip_address: dev.ip_address,
          api_port:   dev.api_port || 80,
          status:     dev.status || 'unknown'
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/mikrotik/queues
  async create(req, res) {
    try {
      const { name, target } = req.body || {};
      if (!name || !target) {
        return res.status(400).json({ success: false, message: 'Nama queue dan target IP wajib diisi' });
      }
      const mt = await getMt(req);
      const result = await mt.createQueue(req.body);
      res.status(201).json({ success: true, data: result, message: 'Queue dibuat' });
    } catch (err) {
      logger.error('Queue create error:', err.message);
      const e = mtError(err, 'Gagal buat queue');
      res.status(e.status === 500 ? 400 : e.status).json({ success: false, message: e.message });
    }
  }

  // PUT /api/mikrotik/queues/:id
  async update(req, res) {
    try {
      if (!validateQueueId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'ID queue tidak valid' });
      }
      const mt = await getMt(req);
      const result = await mt.updateQueue(req.params.id, req.body);
      res.json({ success: true, data: result, message: 'Queue diperbarui' });
    } catch (err) {
      logger.error('Queue update error:', err.message);
      const e = mtError(err, 'Gagal update queue');
      res.status(e.status === 500 ? 400 : e.status).json({ success: false, message: e.message });
    }
  }

  // DELETE /api/mikrotik/queues/:id
  async destroy(req, res) {
    try {
      if (!validateQueueId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'ID queue tidak valid' });
      }
      const mt = await getMt(req);
      await mt.deleteQueue(req.params.id);
      res.json({ success: true, message: 'Queue dihapus' });
    } catch (err) {
      logger.error('Queue delete error:', err.message);
      const e = mtError(err, 'Gagal hapus queue');
      res.status(e.status === 500 ? 400 : e.status).json({ success: false, message: e.message });
    }
  }

  // POST /api/mikrotik/queues/:id/enable
  async enable(req, res) {
    try {
      if (!validateQueueId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'ID queue tidak valid' });
      }
      const mt = await getMt(req);
      await mt.enableQueue(req.params.id);
      res.json({ success: true, message: 'Queue diaktifkan' });
    } catch (err) {
      const e = mtError(err, 'Gagal enable queue');
      res.status(e.status === 500 ? 400 : e.status).json({ success: false, message: e.message });
    }
  }

  // POST /api/mikrotik/queues/:id/disable
  async disable(req, res) {
    try {
      if (!validateQueueId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'ID queue tidak valid' });
      }
      const mt = await getMt(req);
      await mt.disableQueue(req.params.id);
      res.json({ success: true, message: 'Queue dinonaktifkan' });
    } catch (err) {
      const e = mtError(err, 'Gagal disable queue');
      res.status(e.status === 500 ? 400 : e.status).json({ success: false, message: e.message });
    }
  }
}

module.exports = new QueueController();