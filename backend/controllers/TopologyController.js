const { sequelize } = require('../models');
const logger = require('../utils/logger');

console.log('[TopologyController] Loading ULTIMATE SIMPLE VERSION v2');

// ============================================
// STANDALONE HELPER FUNCTIONS (NO CLASS)
// ============================================

// Try to load MikroTik service
let getMikrotikInstance = null;
try {
  const MikrotikService = require('../services/MikrotikService');
  getMikrotikInstance = MikrotikService.getMikrotikInstance;
  console.log('[Topology] MikrotikService loaded');
} catch(e) {
  console.log('[Topology] MikrotikService not available:', e.message);
}

// Try to load SNMP
let snmp = null;
try {
  snmp = require('net-snmp');
  console.log('[Topology] net-snmp loaded');
} catch(e) {
  console.log('[Topology] net-snmp not available');
}

// ============================================
// MIKROTIK STATS FUNCTION (STANDALONE)
// ============================================
async function fetchMikrotikStats(host, username, password, port) {
  if (!getMikrotikInstance) {
    return { discovered: false, error: 'MikrotikService not available' };
  }

  try {
    console.log(`[Topology] Fetching MikroTik from ${host}:${port || 80}`);

    const mikrotik = getMikrotikInstance({
      host,
      username: username || 'admin',
      password: password || '',
      port: port || 80,
      timeout: 8000
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), 8000)
    );

    const [identity, resource, interfaces] = await Promise.race([
      Promise.all([
        mikrotik.getSystemIdentity(),
        mikrotik.getSystemResource(),
        mikrotik.getInterfaces()
      ]),
      timeoutPromise
    ]);

    console.log(`[Topology] MikroTik connected: ${identity.name}`);

    const interfaceNames = interfaces.filter(i => i.running).map(i => i.name);
    const trafficStats = await mikrotik.getInterfacesBulkStats(interfaceNames).catch(() => []);

    let totalRxBps = 0;
    let totalTxBps = 0;

    trafficStats.forEach(stat => {
      totalRxBps += stat.rxBitsPerSecond || 0;
      totalTxBps += stat.txBitsPerSecond || 0;
    });

    const topInterfaces = trafficStats
      .sort((a, b) => ((b.rxBitsPerSecond + b.txBitsPerSecond) - (a.rxBitsPerSecond + a.txBitsPerSecond)))
      .slice(0, 5)
      .map(stat => ({
        name: stat.name,
        running: true,
        rxBps: stat.rxBitsPerSecond || 0,
        txBps: stat.txBitsPerSecond || 0
      }));

    const usedMemory = resource.totalMemory - resource.freeMemory;
    const memoryPercent = resource.totalMemory > 0 
      ? Math.round((usedMemory / resource.totalMemory) * 100) 
      : 0;

    console.log(`[Topology] MikroTik OK - CPU: ${resource.cpuLoad}%, Mem: ${memoryPercent}%`);

    return {
      identity: identity.name || 'Unknown',
      version: resource.version || 'Unknown',
      boardName: resource.boardName || 'Unknown',
      uptime: resource.uptime || 'Unknown',
      cpuLoad: resource.cpuLoad || 0,
      totalMemory: resource.totalMemory || 0,
      usedMemory: usedMemory,
      memoryPercent: memoryPercent,
      totalRxBps: totalRxBps,
      totalTxBps: totalTxBps,
      interfaceCount: interfaces.length || 0,
      interfaces: topInterfaces,
      discovered: true
    };
  } catch(e) {
    console.error('[Topology] MikroTik error:', e.message);
    return { discovered: false, error: e.message };
  }
}

// ============================================
// SNMP STATS FUNCTION (STANDALONE)
// ============================================
async function fetchSNMPStats(host, community = 'public') {
  if (!snmp) {
    return { discovered: false, error: 'net-snmp not installed' };
  }

  return new Promise((resolve) => {
    try {
      console.log(`[Topology] Fetching SNMP from ${host}`);

      const session = snmp.createSession(host, community, {
        version: snmp.Version2c,
        timeout: 5000,
        retries: 1
      });

      const oids = [
        '1.3.6.1.2.1.1.1.0',
        '1.3.6.1.2.1.1.5.0',
        '1.3.6.1.2.1.1.3.0',
        '1.3.6.1.2.1.25.3.3.1.2.1',
        '1.3.6.1.2.1.25.2.3.1.5.1',
        '1.3.6.1.2.1.25.2.3.1.6.1',
        '1.3.6.1.2.1.25.2.3.1.4.1',
        '1.3.6.1.2.1.2.1.0',
      ];

      session.get(oids, (error, varbinds) => {
        session.close();
        
        if (error) {
          console.error('[Topology] SNMP error:', error.toString());
          return resolve({ discovered: false, error: error.toString() });
        }

        const sysDescr = varbinds[0]?.value?.toString() || 'Unknown';
        const sysName = varbinds[1]?.value?.toString() || 'Unknown';
        const sysUpTime = varbinds[2]?.value?.toString() || '0';
        const cpuLoad = parseInt(varbinds[3]?.value) || 0;
        const storageSize = parseInt(varbinds[4]?.value) || 0;
        const storageUsed = parseInt(varbinds[5]?.value) || 0;
        const allocationUnits = parseInt(varbinds[6]?.value) || 1;
        const ifCount = parseInt(varbinds[7]?.value) || 0;

        const totalMemory = storageSize * allocationUnits;
        const usedMemory = storageUsed * allocationUnits;
        const memoryPercent = totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0;

        console.log(`[Topology] SNMP OK - CPU: ${cpuLoad}%, Mem: ${memoryPercent}%`);

        resolve({
          sysDescr,
          sysName,
          sysUpTime,
          cpuLoad,
          totalMemory,
          usedMemory,
          memoryPercent,
          interfaceCount: ifCount,
          totalRxBps: 0,
          totalTxBps: 0,
          interfaces: [],
          discovered: true
        });
      });
    } catch(e) {
      console.error('[Topology] SNMP exception:', e.message);
      resolve({ discovered: false, error: e.message });
    }
  });
}

// ============================================
// SIMPLE CONTROLLER (NO COMPLEX CLASS METHODS)
// ============================================
class TopologyController {

  async getDevices(req, res) {
    try {
      const devices = await sequelize.query(
        `SELECT * FROM topology_devices ORDER BY created_at DESC`,
        { type: sequelize.QueryTypes.SELECT }
      ).catch(() => []);

      res.json({ success: true, data: devices });
    } catch(e) {
      console.error('[Topology.getDevices]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async getConnections(req, res) {
    try {
      const connections = await sequelize.query(
        `SELECT * FROM topology_connections`,
        { type: sequelize.QueryTypes.SELECT }
      ).catch(() => []);

      res.json({ success: true, data: connections });
    } catch(e) {
      console.error('[Topology.getConnections]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async addDevice(req, res) {
    try {
      const { name, type, ip_address, protocol, snmp_community, position_x, position_y, username, password, port, icon_data } = req.body;

      const result = await sequelize.query(
        `INSERT INTO topology_devices 
         (name, type, ip_address, protocol, snmp_community, position_x, position_y, 
          username, password, port, icon_data, status, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
        {
          replacements: [
            name, type, ip_address || null, protocol || 'manual',
            snmp_community || null, position_x || 0, position_y || 0,
            username || null, password || null, port || null,
            icon_data || null
          ],
          type: sequelize.QueryTypes.INSERT
        }
      );

      res.status(201).json({ success: true, data: { id: result[0] } });
    } catch(e) {
      console.error('[Topology.addDevice]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async updateDevice(req, res) {
    try {
      const { id } = req.params;
      const { name, ip_address, protocol, snmp_community, username, password, port, icon_data } = req.body;

      // Build dynamic SET clause — only update provided fields
      const fields = [];
      const vals   = [];

      if (name        !== undefined) { fields.push('name = ?');         vals.push(name); }
      if (ip_address  !== undefined) { fields.push('ip_address = ?');   vals.push(ip_address || null); }
      if (protocol    !== undefined) { fields.push('protocol = ?');     vals.push(protocol); }
      if (snmp_community !== undefined) { fields.push('snmp_community = ?'); vals.push(snmp_community || null); }
      if (username    !== undefined) { fields.push('username = ?');     vals.push(username || null); }
      if (password    !== undefined) { fields.push('password = ?');     vals.push(password || null); }
      if (port        !== undefined) { fields.push('port = ?');         vals.push(port || null); }
      // icon_data: null means "clear icon", undefined means "don't touch"
      if (icon_data !== undefined)  { fields.push('icon_data = ?');    vals.push(icon_data || null); }

      if (fields.length === 0) {
        return res.json({ success: true, message: 'Nothing to update' });
      }

      fields.push('updated_at = NOW()');
      vals.push(id);

      await sequelize.query(
        `UPDATE topology_devices SET ${fields.join(', ')} WHERE id = ?`,
        { replacements: vals, type: sequelize.QueryTypes.UPDATE }
      );

      res.json({ success: true });
    } catch(e) {
      console.error('[Topology.updateDevice]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async updatePosition(req, res) {
    try {
      const { id } = req.params;
      const { position_x, position_y } = req.body;

      await sequelize.query(
        `UPDATE topology_devices SET position_x = ?, position_y = ?, updated_at = NOW() WHERE id = ?`,
        { replacements: [position_x, position_y, id], type: sequelize.QueryTypes.UPDATE }
      );

      res.json({ success: true });
    } catch(e) {
      console.error('[Topology.updatePosition]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async deleteDevice(req, res) {
    try {
      const { id } = req.params;
      
      await sequelize.query(
        `DELETE FROM topology_connections WHERE source_id = ? OR target_id = ?`,
        { replacements: [id, id], type: sequelize.QueryTypes.DELETE }
      );

      await sequelize.query(
        `DELETE FROM topology_devices WHERE id = ?`,
        { replacements: [id], type: sequelize.QueryTypes.DELETE }
      );

      res.json({ success: true });
    } catch(e) {
      console.error('[Topology.deleteDevice]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async addConnection(req, res) {
    try {
      const { source_id, target_id, label, connection_type } = req.body;

      const result = await sequelize.query(
        `INSERT INTO topology_connections 
         (source_id, target_id, label, connection_type, status, created_at, updated_at) 
         VALUES (?, ?, ?, ?, 'active', NOW(), NOW())`,
        {
          replacements: [source_id, target_id, label || null, connection_type || 'ethernet'],
          type: sequelize.QueryTypes.INSERT
        }
      );

      res.status(201).json({ success: true, data: { id: result[0] } });
    } catch(e) {
      console.error('[Topology.addConnection]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async deleteConnection(req, res) {
    try {
      const { id } = req.params;
      
      await sequelize.query(
        `DELETE FROM topology_connections WHERE id = ?`,
        { replacements: [id], type: sequelize.QueryTypes.DELETE }
      );

      res.json({ success: true });
    } catch(e) {
      console.error('[Topology.deleteConnection]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // SIMPLE REFRESH - Using standalone functions (NO this. context issues!)
  async refreshDevice(req, res) {
    console.log('[Topology.refreshDevice] CALLED');
    
    try {
      const { id } = req.params;
      console.log('[Topology.refreshDevice] ID:', id);
      
      const [device] = await sequelize.query(
        `SELECT * FROM topology_devices WHERE id = ?`,
        { replacements: [id], type: sequelize.QueryTypes.SELECT }
      );

      if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
      }

      console.log('[Topology.refreshDevice] Device:', device.name, device.protocol);

      // Manual or no IP
      if (device.protocol === 'manual' || !device.ip_address) {
        return res.json({
          success: true,
          data: {
            status: 'offline',
            deviceInfo: {
              discovered: false,
              error: 'Manual device or no IP'
            }
          }
        });
      }

      let deviceInfo = null;
      let status = 'offline';

      // Try MikroTik (using standalone function - NO this. issues!)
      if (device.protocol === 'mikrotik') {
        console.log('[Topology.refreshDevice] Calling fetchMikrotikStats...');
        deviceInfo = await fetchMikrotikStats(
          device.ip_address,
          device.username,
          device.password,
          device.port
        );
        status = deviceInfo.discovered ? 'online' : 'offline';
        console.log('[Topology.refreshDevice] MikroTik result:', status);
      }
      // Try SNMP (using standalone function - NO this. issues!)
      else if (device.protocol === 'snmp') {
        console.log('[Topology.refreshDevice] Calling fetchSNMPStats...');
        deviceInfo = await fetchSNMPStats(
          device.ip_address,
          device.snmp_community || 'public'
        );
        status = deviceInfo.discovered ? 'online' : 'offline';
        console.log('[Topology.refreshDevice] SNMP result:', status);
      }

      // Update database
      await sequelize.query(
        `UPDATE topology_devices SET status = ?, updated_at = NOW() WHERE id = ?`,
        { replacements: [status, id], type: sequelize.QueryTypes.UPDATE }
      );

      console.log('[Topology.refreshDevice] Success, returning response');

      res.json({
        success: true,
        data: {
          status,
          deviceInfo
        }
      });

    } catch(e) {
      console.error('[Topology.refreshDevice] EXCEPTION:', e);
      console.error('[Topology.refreshDevice] Stack:', e.stack);
      
      res.status(500).json({ 
        success: false, 
        message: e.message,
        stack: e.stack
      });
    }
  }

  async refreshAllDevices(req, res) {
    try {
      const devices = await sequelize.query(
        `SELECT * FROM topology_devices WHERE protocol IN ('mikrotik', 'snmp')`,
        { type: sequelize.QueryTypes.SELECT }
      );

      const results = [];

      for (const device of devices) {
        let deviceInfo = null;
        let status = 'offline';

        if (device.protocol === 'mikrotik') {
          deviceInfo = await fetchMikrotikStats(
            device.ip_address,
            device.username,
            device.password,
            device.port
          );
          status = deviceInfo.discovered ? 'online' : 'offline';
        } else if (device.protocol === 'snmp') {
          deviceInfo = await fetchSNMPStats(
            device.ip_address,
            device.snmp_community || 'public'
          );
          status = deviceInfo.discovered ? 'online' : 'offline';
        }

        await sequelize.query(
          `UPDATE topology_devices SET status = ?, updated_at = NOW() WHERE id = ?`,
          { replacements: [status, device.id], type: sequelize.QueryTypes.UPDATE }
        );

        results.push({
          id: device.id,
          name: device.name,
          status,
          discovered: deviceInfo?.discovered || false
        });
      }

      res.json({
        success: true,
        message: `Refreshed ${results.length} devices`,
        data: results
      });
    } catch(e) {
      console.error('[Topology.refreshAllDevices]', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

console.log('[TopologyController] ULTIMATE SIMPLE VERSION v2 LOADED');

module.exports = new TopologyController();
