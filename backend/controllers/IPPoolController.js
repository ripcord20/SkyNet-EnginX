const { getMikrotikInstance, getMikrotikInstanceByDevice } = require('../services/MikrotikService');

// Helper: ambil device_id dari query/header lalu return instance MikroTik
function resolveDeviceId(req) {
  const q = req.query?.device_id;
  const h = req.headers?.['x-device-id'];
  const v = q || h;
  return v ? parseInt(v) : null;
}
async function getMt(req) {
  return getMikrotikInstanceByDevice(resolveDeviceId(req));
}
const logger = require('../utils/logger');

class IPPoolController {
  // GET /api/mikrotik/ippool
  async index(req, res) {
    try {
      const mt = await getMt(req);
      const [pools, used] = await Promise.all([
        mt.getIPPools(),
        mt.getIPPoolUsed()
      ]);

      // Calculate usage per pool
      const usageMap = {};
      used.forEach(u => {
        if (!usageMap[u.pool]) usageMap[u.pool] = [];
        usageMap[u.pool].push(u);
      });

      const result = pools.map(pool => {
        const usedIPs = usageMap[pool.name] || [];
        // Count total IPs from ranges
        let totalIPs = 0;
        if (pool.ranges) {
          pool.ranges.split(',').forEach(range => {
            range = range.trim();
            if (range.includes('-')) {
              const [start, end] = range.split('-');
              totalIPs += ipToInt(end.trim()) - ipToInt(start.trim()) + 1;
            } else {
              totalIPs += 1;
            }
          });
        }
        return {
          ...pool,
          totalIPs,
          usedCount: usedIPs.length,
          freeCount: Math.max(0, totalIPs - usedIPs.length),
          usedPercent: totalIPs > 0 ? Math.round((usedIPs.length / totalIPs) * 100) : 0,
          usedIPs
        };
      });

      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('IP Pool error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/ippool/used
  async used(req, res) {
    try {
      const mt = await getMt(req);
      const { pool } = req.query;
      const used = await mt.getIPPoolUsed();
      const filtered = pool ? used.filter(u => u.pool === pool) : used;
      res.json({ success: true, data: filtered, total: filtered.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/mikrotik/ippool — buat pool baru
  async create(req, res) {
    try {
      const { name, ranges, nextPool, comment } = req.body || {};
      if (!name)   return res.status(400).json({ success: false, message: 'Nama pool wajib' });
      if (!ranges) return res.status(400).json({ success: false, message: 'Range wajib (mis. 10.5.50.2-10.5.50.254)' });
      const mt = await getMt(req);
      await mt.createIPPool({ name, ranges, nextPool, comment });
      res.json({ success: true, message: `Pool "${name}" dibuat` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // DELETE /api/mikrotik/ippool/:id
  async destroy(req, res) {
    try {
      const mt = await getMt(req);
      await mt.deleteIPPool(req.params.id);
      res.json({ success: true, message: 'Pool dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/ippool/addresses — IP terpasang di interface
  async addresses(req, res) {
    try {
      const mt = await getMt(req);
      const data = await mt.getIPAddresses();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/ippool/suggest?interface=ether15 — saran range dari IP interface
  async suggest(req, res) {
    try {
      const iface = req.query.interface;
      if (!iface) return res.status(400).json({ success: false, message: 'Parameter interface wajib' });
      const mt = await getMt(req);
      const data = await mt.suggestPoolRange(iface);
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

function ipToInt(ip) {
  const parts = ip.split('.');
  return ((parseInt(parts[0]) << 24) + (parseInt(parts[1]) << 16) +
          (parseInt(parts[2]) << 8) + parseInt(parts[3])) >>> 0;
}

module.exports = new IPPoolController();
