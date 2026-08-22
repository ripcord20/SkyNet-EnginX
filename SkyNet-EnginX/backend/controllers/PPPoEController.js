const { getMikrotikInstance, getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const logger = require('../utils/logger');

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

class PPPoEController {
  // GET /api/mikrotik/pppoe/active
  async activeSessions(req, res) {
    try {
      // No-cache: client should always see fresh session list
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const mt = await getMt(req);
      const sessions = await mt.getPPPoESessions();
      const { search, service } = req.query;

      let filtered = sessions;

      // Filter by search (null-safe)
      if (search) {
        const q = String(search).toLowerCase();
        filtered = filtered.filter(s =>
          (s.name     || '').toLowerCase().includes(q) ||
          (s.address  || '').toLowerCase().includes(q) ||
          (s.callerID || '').toLowerCase().includes(q)
        );
      }

      // Filter by service (pppoe / l2tp / pptp / etc.)
      if (service) {
        filtered = filtered.filter(s => (s.service || '').toLowerCase() === service.toLowerCase());
      }

      res.json({ success: true, data: filtered, total: filtered.length });
    } catch (err) {
      logger.error(`PPPoE sessions error: ${err.message}`);
      // Return empty list dengan warning daripada 500 untuk connection issues
      if (err.message.includes('ECONNRESET') || err.message.includes('timeout') || err.message.includes('ECONNREFUSED')) {
        return res.json({ success: true, data: [], total: 0, warning: err.message });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/pppoe/secrets
  async secrets(req, res) {
    try {
      // No-cache: after create/update/delete, client must see the fresh list
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const mt = await getMt(req);
      const secrets = await mt.getPPPoESecrets();
      const data = secrets || [];
      res.json({ success: true, data, total: data.length });
    } catch (err) {
      logger.error(`PPPoE secrets error: ${err.message}`);
      // Return empty array instead of 500 on connection issues
      if (err.message.includes('ECONNRESET') || err.message.includes('timeout')) {
        return res.json({ success: true, data: [], total: 0, warning: err.message });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/mikrotik/pppoe/disconnect/:id
  async disconnect(req, res) {
    try {
      const mt = await getMt(req);
      await mt.disconnectPPPoE(req.params.id);
      res.json({ success: true, message: 'Session disconnected' });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/pppoe/stats
  async stats(req, res) {
    try {
      const mt = await getMt(req);
      const sessions = await mt.getPPPoESessions();
      const services = {};
      sessions.forEach(s => {
        services[s.service] = (services[s.service] || 0) + 1;
      });
      res.json({
        success: true,
        data: {
          total: sessions.length,
          pppoe: services.pppoe || 0,
          l2tp:  services.l2tp  || 0,
          other: sessions.length - (services.pppoe || 0) - (services.l2tp || 0)
        }
      });
    } catch (err) {
      logger.error(`PPPoE stats error: ${err.message}`);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/mikrotik/pppoe/profiles
  async getProfiles(req, res) {
    try {
      const mt = await getMt(req);
      const profiles = await mt.getPPPoEProfiles();
      res.json({ success: true, data: profiles || [] });
    } catch (err) {
      logger.error(`PPPoE profiles error: ${err.message}`);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/mikrotik/pppoe/secrets
  async createSecret(req, res) {
    try {
      const mt = await getMt(req);
      if (!req.body.name)     return res.status(400).json({ success:false, message:'Username wajib diisi' });
      if (!req.body.password) return res.status(400).json({ success:false, message:'Password wajib diisi' });
      await mt.createPPPoESecret(req.body);
      // null response = ECONNRESET after write = operation succeeded
      res.json({ success: true, message: 'User PPPoE berhasil dibuat' });
    } catch (err) {
      logger.error('PPPoE createSecret error:', err.message);
      res.status(400).json({ success:false, message: err.message, detail: String(err.message) });
    }
  }

  // PUT /api/mikrotik/pppoe/secrets/:id
  async updateSecret(req, res) {
    try {
      const mt = await getMt(req);
      await mt.updatePPPoESecret(req.params.id, req.body);
      res.json({ success: true, message: 'User PPPoE berhasil diupdate' });
    } catch (err) {
      logger.error(`PPPoE updateSecret error (id=${req.params.id}): ${err.message}`);
      res.status(400).json({ success:false, message:err.message });
    }
  }

  // DELETE /api/mikrotik/pppoe/secrets/:id
  async deleteSecret(req, res) {
    try {
      const mt = await getMt(req);
      await mt.deletePPPoESecret(req.params.id);
      res.json({ success: true, message: 'User PPPoE berhasil dihapus' });
    } catch (err) {
      logger.error(`PPPoE deleteSecret error (id=${req.params.id}): ${err.message}`);
      res.status(400).json({ success:false, message:err.message });
    }
  }

  // POST /api/mikrotik/pppoe/secrets/:id/enable
  async enableSecret(req, res) {
    try {
      const mt = await getMt(req);
      await mt.enablePPPoESecret(req.params.id);
      res.json({ success: true, message: 'User diaktifkan' });
    } catch (err) {
      logger.error(`PPPoE enableSecret error (id=${req.params.id}): ${err.message}`);
      res.status(400).json({ success:false, message:err.message });
    }
  }

  // POST /api/mikrotik/pppoe/secrets/:id/disable
  async disableSecret(req, res) {
    try {
      const mt = await getMt(req);
      await mt.disablePPPoESecret(req.params.id);
      res.json({ success: true, message: 'User dinonaktifkan' });
    } catch (err) {
      logger.error(`PPPoE disableSecret error (id=${req.params.id}): ${err.message}`);
      res.status(400).json({ success:false, message:err.message });
    }
  }
}

module.exports = new PPPoEController();
