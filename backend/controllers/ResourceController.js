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
const os = require('os');

class ResourceController {

  // ── Get Router Resources (Mikrotik) ──────────────────────────
  async getRouterResources(req, res) {
    try {
      const mikrotik = await getMt(req);
      
      // Get system resource dari Mikrotik
      const resource = await mikrotik.getSystemResource();
      const identity = await mikrotik.getSystemIdentity();

      // Calculate memory usage percentage
      const memoryUsed = resource.totalMemory - resource.freeMemory;
      const memoryUsagePercent = resource.totalMemory > 0 
        ? Math.round((memoryUsed / resource.totalMemory) * 100) 
        : 0;

      res.json({
        success: true,
        data: {
          identity: identity.name || 'MikroTik',
          version: resource.version,
          boardName: resource.boardName,
          platform: resource.platform,
          uptime: resource.uptime,
          cpuLoad: resource.cpuLoad,
          totalMemory: resource.totalMemory,
          freeMemory: resource.freeMemory,
          usedMemory: memoryUsed,
          memoryUsagePercent: memoryUsagePercent
        }
      });
    } catch(e) {
      logger.error('[ResourceController.getRouterResources]', e.message);
      res.status(500).json({ 
        success: false, 
        message: 'Gagal mengambil data router: ' + e.message 
      });
    }
  }

  // ── Get Server Resources (Node.js Server) ────────────────────
  async getServerResources(req, res) {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = Math.round((usedMem / totalMem) * 100);

      // CPU Load Average (1, 5, 15 minutes)
      const loadAvg = os.loadavg();
      const cpuCount = os.cpus().length;
      const cpuLoadPercent = Math.round((loadAvg[0] / cpuCount) * 100);

      // Uptime
      const uptimeSec = os.uptime();
      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const uptimeStr = `${days}d ${hours}h ${minutes}m`;

      // Platform info
      const platform = os.platform();
      const arch = os.arch();
      const hostname = os.hostname();
      const nodeVersion = process.version;

      res.json({
        success: true,
        data: {
          hostname,
          platform: `${platform} ${arch}`,
          nodeVersion,
          uptime: uptimeStr,
          uptimeSeconds: uptimeSec,
          cpuCount,
          cpuLoadPercent,
          loadAvg: loadAvg.map(v => v.toFixed(2)),
          totalMemory: totalMem,
          freeMemory: freeMem,
          usedMemory: usedMem,
          memoryUsagePercent: memUsagePercent
        }
      });
    } catch(e) {
      logger.error('[ResourceController.getServerResources]', e.message);
      res.status(500).json({ 
        success: false, 
        message: 'Gagal mengambil data server: ' + e.message 
      });
    }
  }

  // ── Get All Resources (Router + Server) ──────────────────────
  async getAllResources(req, res) {
    try {
      // Get router resources
      let routerData = null;
      try {
        const mikrotik = await getMt(req);
        const resource = await mikrotik.getSystemResource();
        const identity = await mikrotik.getSystemIdentity();
        
        const memoryUsed = resource.totalMemory - resource.freeMemory;
        const memoryUsagePercent = resource.totalMemory > 0 
          ? Math.round((memoryUsed / resource.totalMemory) * 100) 
          : 0;

        routerData = {
          identity: identity.name || 'MikroTik',
          version: resource.version,
          boardName: resource.boardName,
          platform: resource.platform,
          uptime: resource.uptime,
          cpuLoad: resource.cpuLoad,
          totalMemory: resource.totalMemory,
          freeMemory: resource.freeMemory,
          usedMemory: memoryUsed,
          memoryUsagePercent: memoryUsagePercent
        };
      } catch(routerErr) {
        logger.warn('[ResourceController] Router unavailable:', routerErr.message);
        routerData = { error: routerErr.message };
      }

      // Get server resources
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = Math.round((usedMem / totalMem) * 100);

      const loadAvg = os.loadavg();
      const cpuCount = os.cpus().length;
      const cpuLoadPercent = Math.round((loadAvg[0] / cpuCount) * 100);

      const uptimeSec = os.uptime();
      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const uptimeStr = `${days}d ${hours}h ${minutes}m`;

      const serverData = {
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        nodeVersion: process.version,
        uptime: uptimeStr,
        uptimeSeconds: uptimeSec,
        cpuCount,
        cpuLoadPercent,
        loadAvg: loadAvg.map(v => v.toFixed(2)),
        totalMemory: totalMem,
        freeMemory: freeMem,
        usedMemory: usedMem,
        memoryUsagePercent: memUsagePercent
      };

      res.json({
        success: true,
        data: {
          router: routerData,
          server: serverData
        }
      });
    } catch(e) {
      logger.error('[ResourceController.getAllResources]', e.message);
      res.status(500).json({ 
        success: false, 
        message: 'Gagal mengambil data resources: ' + e.message 
      });
    }
  }
}

module.exports = new ResourceController();
