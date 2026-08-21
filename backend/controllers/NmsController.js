/**
 * NmsController.js
 * ─────────────────────────────────────────────────────────────────
 * FlayNMS — halaman NMS monitoring interface MikroTik.
 *
 * Endpoint:
 *   GET    /api/nms/routers                 → daftar router (device) + status
 *   GET    /api/nms/routers/:id/interfaces  → list interface live di router (untuk picker)
 *   GET    /api/nms/interfaces              → daftar preset interface yang dipantau (global)
 *   POST   /api/nms/interfaces              → tambah interface ke monitoring
 *   DELETE /api/nms/interfaces/:id          → hapus dari monitoring
 *   PATCH  /api/nms/interfaces/reorder      → ubah urutan
 *   GET    /api/nms/live                     → live bitrate semua interface preset (untuk polling 5s)
 */
const { NmsInterfacePreset, Device } = require('../models');
const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const logger = require('../utils/logger');

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

const NmsController = {

  // ── Daftar router MikroTik yang bisa dipantau ───────────────────
  // NMS butuh akses API (REST atau Binary) untuk baca traffic interface.
  // Router dianggap "API-capable" bila ada minimal satu indikator API:
  //   - monitoring_type 'api'/'both', ATAU
  //   - api_protocol terisi (rest-http/rest-https/api-plain/api-ssl), ATAU
  //   - api_username terisi, ATAU
  //   - api_port terisi
  // Sengaja longgar: konfigurasi API di Device Management bisa bervariasi
  // (REST tanpa set monitoring_type, dsb). Auth sebenarnya akan di-resolve
  // oleh getMikrotikInstanceByDevice (yang juga bisa fallback ke kredensial
  // env). Tambah ?debug=1 untuk melihat alasan device di-skip.
  async routers(req, res) {
    try {
      const debug = req.query.debug === '1' || req.query.all === '1';
      const rows = await Device.findAll({
        where: { type: 'router' },
        attributes: ['id', 'name', 'ip_address', 'status', 'monitoring_type', 'api_protocol', 'api_username', 'api_port', 'is_active'],
        order: [['name', 'ASC']]
      });

      const isApiCapable = (r) => {
        const monApi  = ['api', 'both'].includes(r.monitoring_type);
        const hasProto = !!r.api_protocol;
        const hasUser  = !!r.api_username;
        const hasPort  = !!r.api_port;
        return monApi || hasProto || hasUser || hasPort;
      };

      const eligible = rows.filter(isApiCapable);
      const data = eligible.map(r => ({
        id: r.id,
        name: r.name,
        ip_address: r.ip_address,
        status: r.status,
        api_protocol: r.api_protocol || null
      }));

      const payload = { success: true, data };
      if (debug) {
        payload.debug = {
          total_router: rows.length,
          eligible: eligible.length,
          all: rows.map(r => ({
            id: r.id, name: r.name, type: 'router',
            monitoring_type: r.monitoring_type,
            api_protocol: r.api_protocol,
            api_username: r.api_username ? '(set)' : null,
            api_port: r.api_port,
            is_active: r.is_active,
            eligible: isApiCapable(r)
          }))
        };
      }
      res.json(payload);
    } catch (e) {
      logger.error('[NMS] routers error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── List interface live pada satu router (untuk picker) ─────────
  async routerInterfaces(req, res) {
    try {
      const deviceId = parseInt(req.params.id);
      const mt = await getMikrotikInstanceByDevice(deviceId);
      const ifaces = await mt.getInterfaces();

      // Set interface yang sudah jadi preset → ditandai already-added
      const existing = await NmsInterfacePreset.findAll({
        where: { router_id: deviceId }, attributes: ['iface_name']
      });
      const added = new Set(existing.map(e => e.iface_name));

      const data = (ifaces || [])
        .map(i => ({
          name: i.name,
          type: i.type || 'ether',
          running: !!i.running,
          disabled: !!i.disabled,
          comment: i.comment || '',
          added: added.has(i.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      res.json({ success: true, data });
    } catch (e) {
      logger.error('[NMS] routerInterfaces error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── List preset interface yang dipantau (global, sinkron) ───────
  async listPresets(req, res) {
    try {
      const rows = await NmsInterfacePreset.findAll({
        include: [{ model: Device, as: 'router', attributes: ['id', 'name', 'ip_address', 'status'] }],
        order: [['position', 'ASC'], ['id', 'ASC']]
      });
      res.json({ success: true, data: rows });
    } catch (e) {
      logger.error('[NMS] listPresets error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Tambah interface ke monitoring ──────────────────────────────
  async addPreset(req, res) {
    try {
      const { router_id, iface_name, label } = req.body || {};
      if (!router_id || !iface_name) {
        return res.status(400).json({ success: false, message: 'router_id & iface_name wajib' });
      }
      const exists = await NmsInterfacePreset.findOne({ where: { router_id, iface_name } });
      if (exists) {
        return res.status(409).json({ success: false, message: 'Interface ini sudah dimonitoring' });
      }
      const count = await NmsInterfacePreset.count();
      const preset = await NmsInterfacePreset.create({
        router_id,
        iface_name,
        label: label || null,
        color: PALETTE[count % PALETTE.length],
        position: count,
        created_by: req.user?.id || null
      });
      const full = await NmsInterfacePreset.findByPk(preset.id, {
        include: [{ model: Device, as: 'router', attributes: ['id', 'name', 'ip_address', 'status'] }]
      });
      res.status(201).json({ success: true, data: full });
    } catch (e) {
      logger.error('[NMS] addPreset error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Hapus dari monitoring ───────────────────────────────────────
  async removePreset(req, res) {
    try {
      const id = parseInt(req.params.id);
      const row = await NmsInterfacePreset.findByPk(id);
      if (!row) return res.status(404).json({ success: false, message: 'Preset tidak ditemukan' });
      await row.destroy();
      res.json({ success: true });
    } catch (e) {
      logger.error('[NMS] removePreset error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Reorder presets ─────────────────────────────────────────────
  async reorder(req, res) {
    try {
      const { order } = req.body || {}; // array of preset id, urutan baru
      if (!Array.isArray(order)) {
        return res.status(400).json({ success: false, message: 'order harus array' });
      }
      await Promise.all(order.map((id, idx) =>
        NmsInterfacePreset.update({ position: idx }, { where: { id } })
      ));
      res.json({ success: true });
    } catch (e) {
      logger.error('[NMS] reorder error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Riwayat traffic interface (1d/3d/7d/30d) ────────────────────
  async historyRange(req, res) {
    try {
      const id = parseInt(req.params.id);
      const preset = await NmsInterfacePreset.findByPk(id);
      if (!preset) return res.status(404).json({ success: false, message: 'Preset tidak ditemukan' });
      let range = String(req.query.range || '1d');
      if (!['1d', '3d', '7d', '30d'].includes(range)) range = '1d';
      const TrafficHistory = require('../services/TrafficHistoryService');
      const hist = await TrafficHistory.history({ deviceId: preset.router_id, iface: preset.iface_name, range });
      res.json({ success: true, data: hist });
    } catch (e) {
      logger.error('[NMS] history error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Ubah warna chart interface ──────────────────────────────────
  async setColor(req, res) {
    try {
      const id = parseInt(req.params.id);
      const { color } = req.body || {};
      if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
        return res.status(400).json({ success: false, message: 'Warna tidak valid' });
      }
      const row = await NmsInterfacePreset.findByPk(id);
      if (!row) return res.status(404).json({ success: false, message: 'Preset tidak ditemukan' });
      await row.update({ color });
      res.json({ success: true, data: { id, color } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Detail satu interface preset (untuk popup) ──────────────────
  // Gabungkan info statis (/interface) + live stats (monitor-traffic).
  async detail(req, res) {
    try {
      const id = parseInt(req.params.id);
      const preset = await NmsInterfacePreset.findByPk(id, {
        include: [{ model: Device, as: 'router', attributes: ['id', 'name', 'ip_address', 'status'] }]
      });
      if (!preset) return res.status(404).json({ success: false, message: 'Preset tidak ditemukan' });

      const mt = await getMikrotikInstanceByDevice(preset.router_id);
      const [ifaces, stat] = await Promise.all([
        mt.getInterfaces().catch(() => []),
        mt.getInterfaceStats(preset.iface_name).catch(() => null)
      ]);
      const info = (ifaces || []).find(i => i.name === preset.iface_name) || null;

      res.json({
        success: true,
        data: {
          preset: {
            id: preset.id, iface_name: preset.iface_name, label: preset.label,
            color: preset.color, router: preset.router
          },
          info,  // { type, mtu, running, disabled, macAddress, rxByte, txByte, rxPacket, txPacket, comment }
          stat   // { rxBitsPerSecond, txBitsPerSecond, rxPacketsPerSecond, txPacketsPerSecond }
        }
      });
    } catch (e) {
      logger.error('[NMS] detail error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ── Live bitrate semua interface preset (polling 5s) ────────────
  // Mengelompokkan preset per router → 1 koneksi MikroTik per router,
  // fetch bulk stats sekaligus (efisien).
  async live(req, res) {
    try {
      const presets = await NmsInterfacePreset.findAll({
        order: [['position', 'ASC'], ['id', 'ASC']]
      });
      if (!presets.length) return res.json({ success: true, data: [], ts: Date.now() });

      // Group by router
      const byRouter = {};
      for (const p of presets) {
        (byRouter[p.router_id] = byRouter[p.router_id] || []).push(p);
      }

      const out = [];
      await Promise.all(Object.keys(byRouter).map(async (routerId) => {
        const group = byRouter[routerId];
        try {
          const mt = await getMikrotikInstanceByDevice(parseInt(routerId));
          const names = group.map(g => g.iface_name);
          const stats = await mt.getInterfacesBulkStats(names);
          const statByName = {};
          (stats || []).forEach(s => { statByName[s.name] = s; });

          for (const g of group) {
            const s = statByName[g.iface_name] || {};
            out.push({
              id: g.id,
              router_id: g.router_id,
              iface_name: g.iface_name,
              label: g.label,
              color: g.color,
              position: g.position,
              rx_bps: s.rxBitsPerSecond || 0,
              tx_bps: s.txBitsPerSecond || 0,
              rx_pps: s.rxPacketsPerSecond || 0,
              tx_pps: s.txPacketsPerSecond || 0,
              reachable: !!s.name
            });
          }
        } catch (err) {
          // Router unreachable → kirim panel dengan reachable=false
          logger.warn(`[NMS] live fetch failed router ${routerId}: ${err.message}`);
          for (const g of group) {
            out.push({
              id: g.id, router_id: g.router_id, iface_name: g.iface_name,
              label: g.label, color: g.color, position: g.position,
              rx_bps: 0, tx_bps: 0, rx_pps: 0, tx_pps: 0, reachable: false
            });
          }
        }
      }));

      out.sort((a, b) => a.position - b.position);
      res.json({ success: true, data: out, ts: Date.now() });
    } catch (e) {
      logger.error('[NMS] live error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }
};

module.exports = NmsController;
