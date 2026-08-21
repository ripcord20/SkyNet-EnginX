const { getMikrotikInstance, getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const logger = require('../utils/logger');

const monitoringSessions = new Map();

// Helper: ambil device_id dari query/header dan resolve instance
function resolveDeviceId(req) {
  const q = req.query?.device_id;
  const h = req.headers?.['x-device-id'];
  const v = q || h;
  return v ? parseInt(v) : null;
}

class InterfaceTrafficController {

  // GET /api/mikrotik/interfaces
  async index(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const interfaces = await mt.getInterfaces();
      res.json({ success: true, data: interfaces, total: interfaces.length });
    } catch (err) {
      logger.error('Interface list error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/interfaces/:name/stats
  async stats(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const stat = await mt.getInterfaceStats(decodeURIComponent(req.params.name));
      res.json({ success: true, data: stat });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/mikrotik/interfaces/monitor
   * Ambil live traffic semua interface running sekaligus (bulk)
   * Dipakai oleh dashboard & traffic page untuk real-time update
   */
  async monitorAll(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const interfaces = await mt.getInterfaces();
      const running = interfaces.filter(i => i.running && !i.disabled);

      // Limit 10 interface untuk performa
      const names = running.slice(0, 10).map(i => i.name);

      // Bulk request - 1 call ke MikroTik untuk semua interface
      const stats = await mt.getInterfacesBulkStats(names);

      res.json({
        success: true,
        data: stats,
        interfaces: running.map(i => ({
          name: i.name, type: i.type,
          running: i.running, comment: i.comment,
          // Total byte kumulatif sejak interface up — dipakai kartu
          // "Total Bytes Download/Upload" di halaman monitoring mobile.
          rxByte: i.rxByte || 0, txByte: i.txByte || 0
        })),
        timestamp: new Date()
      });
    } catch (err) {
      logger.error('Interface monitor error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/mikrotik/interfaces/monitor-selected?names=ether1,ether2[&device_id=N]
   * Untuk request interface tertentu saja (dari dashboard/traffic page)
   */
  async monitorSelected(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const names = req.query.names
        ? req.query.names.split(',').map(n => n.trim()).filter(Boolean).slice(0, 10)
        : [];

      if (!names.length) {
        return res.json({ success: true, data: [], timestamp: new Date() });
      }

      const stats = await mt.getInterfacesBulkStats(names);
      res.json({ success: true, data: stats, timestamp: new Date() });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

/**
 * Socket.IO handler untuk live traffic - dipanggil dari SocketHandler.js
 */
function setupInterfaceMonitoring(io) {
  io.on('connection', (socket) => {
    socket.on('interface:start_monitor', async (data) => {
      const { interfaces: ifaceNames = [], interval = 2000 } = data || {};
      const mt = getMikrotikInstance();

      if (monitoringSessions.has(socket.id)) {
        clearInterval(monitoringSessions.get(socket.id));
      }

      const poll = async () => {
        try {
          const stats = await mt.getInterfacesBulkStats(ifaceNames);
          // Apply demo masking kalau user adalah demo
          let payload = { data: stats, timestamp: new Date() };
          if (socket.userRole && String(socket.userRole).toLowerCase() === 'demo') {
            try {
              const { maskDeep } = require('../middleware/demoDataMasker');
              payload = maskDeep(payload, 0, { isMikrotik: true });
            } catch (e) { /* fallback ke unmasked kalau error */ }
          }
          socket.emit('interface:traffic_update', payload);
        } catch (err) {
          socket.emit('interface:error', { message: err.message });
        }
      };

      poll();
      const timer = setInterval(poll, Math.max(interval, 2000));
      monitoringSessions.set(socket.id, timer);
    });

    socket.on('interface:stop_monitor', () => {
      if (monitoringSessions.has(socket.id)) {
        clearInterval(monitoringSessions.get(socket.id));
        monitoringSessions.delete(socket.id);
      }
    });

    socket.on('disconnect', () => {
      if (monitoringSessions.has(socket.id)) {
        clearInterval(monitoringSessions.get(socket.id));
        monitoringSessions.delete(socket.id);
      }
    });
  });
}

module.exports = {
  controller: new InterfaceTrafficController(),
  setupInterfaceMonitoring
};