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

class FirewallController {
  // GET /api/mikrotik/firewall/filter
  async filter(req, res) {
    try {
      const mt = await getMt(req);
      const rules = await mt.getFirewallFilter();
      const { chain, action, search } = req.query;
      let filtered = rules;
      if (chain) filtered = filtered.filter(r => r.chain === chain);
      if (action) filtered = filtered.filter(r => r.action === action);
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(r =>
          r.comment.toLowerCase().includes(q) ||
          r.srcAddress.includes(q) ||
          r.dstAddress.includes(q) ||
          r.srcPort.includes(q) ||
          r.dstPort.includes(q)
        );
      }
      res.json({ success: true, data: filtered, total: filtered.length });
    } catch (err) {
      logger.error('Firewall filter error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/firewall/nat
  async nat(req, res) {
    try {
      const mt = await getMt(req);
      const rules = await mt.getFirewallNAT();
      res.json({ success: true, data: rules, total: rules.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/firewall/stats
  async stats(req, res) {
    try {
      const mt = await getMt(req);
      const [filter, nat] = await Promise.all([
        mt.getFirewallFilter(),
        mt.getFirewallNAT()
      ]);

      const filterStats = {
        total: filter.length,
        active: filter.filter(r => !r.disabled).length,
        disabled: filter.filter(r => r.disabled).length,
        byChain: {}
      };
      filter.forEach(r => {
        filterStats.byChain[r.chain] = (filterStats.byChain[r.chain] || 0) + 1;
      });

      res.json({
        success: true,
        data: {
          filter: filterStats,
          nat: { total: nat.length, active: nat.filter(r => !r.disabled).length }
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/mikrotik/firewall/toggle
  async toggle(req, res) {
    try {
      const mt = await getMt(req);
      const { chain, id, disable } = req.body;
      await mt.toggleFirewallRule(chain, id, disable);
      res.json({ success: true, message: `Rule ${disable ? 'disabled' : 'enabled'}` });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }
}

module.exports = new FirewallController();
