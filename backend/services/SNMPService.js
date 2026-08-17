const logger = require('../utils/logger');
const { Device, DeviceLog, TrafficData, Notification, User } = require('../models');
const { SNMP_OIDS, DEVICE_STATUS } = require('../config/constants');
const { formatUptime, sanitizeSnmpValue } = require('../utils/helpers');

let snmp;
try {
  snmp = require('net-snmp');
} catch (e) {
  logger.warn('net-snmp not installed, SNMP monitoring disabled');
}

class SNMPService {
  constructor(io) {
    this.io = io;
    this.pollingIntervals = new Map();
    this.previousTraffic = new Map();
  }

  // Start monitoring all active devices
  async startAll() {
    try {
      const devices = await Device.findAll({
        where: { is_active: true, monitoring_type: ['snmp', 'both'] }
      });
      logger.info(`Starting SNMP monitoring for ${devices.length} devices`);
      for (const device of devices) {
        this.startDevice(device);
      }
    } catch (error) {
      logger.error('Failed to start SNMP monitoring:', error);
    }
  }

  // Start monitoring a single device
  startDevice(device) {
    if (this.pollingIntervals.has(device.id)) {
      this.stopDevice(device.id);
    }

    const interval = (device.poll_interval || 60) * 1000;
    logger.info(`Starting SNMP poll for ${device.name} (${device.ip_address}) every ${device.poll_interval}s`);

    // Initial poll
    this.pollDevice(device);

    // Set interval
    const timer = setInterval(() => this.pollDevice(device), interval);
    this.pollingIntervals.set(device.id, timer);
  }

  stopDevice(deviceId) {
    const timer = this.pollingIntervals.get(deviceId);
    if (timer) {
      clearInterval(timer);
      this.pollingIntervals.delete(deviceId);
    }
  }

  stopAll() {
    for (const [id, timer] of this.pollingIntervals) {
      clearInterval(timer);
    }
    this.pollingIntervals.clear();
    logger.info('Stopped all SNMP monitoring');
  }

  async pollDevice(device) {
    if (!snmp) return;

    // Cek device masih ada di DB sebelum poll
    const exists = await Device.findByPk(device.id, { attributes: ['id'] });
    if (!exists) {
      this.stopDevice(device.id);
      return;
    }

    const session = snmp.createSession(device.ip_address, device.snmp_community || 'public', {
      port: device.snmp_port || 161,
      version: device.snmp_version === 1 ? snmp.Version1 : snmp.Version2c,
      timeout: 5000,
      retries: 1
    });

    try {
      const data = await this.getDeviceData(session, device);

      // Update device status
      const prevStatus = device.status;
      await Device.update({
        status: DEVICE_STATUS.ONLINE,
        cpu_load: data.cpu || 0,
        memory_usage: data.memory || 0,
        uptime: data.uptime || '',
        firmware: data.firmware || device.firmware,
        last_polled: new Date()
      }, { where: { id: device.id } });

      // Log
      try {
        await DeviceLog.create({
          device_id: device.id,
          cpu_load: data.cpu || 0,
          memory_usage: data.memory || 0,
          uptime: data.uptime || '',
          status: 'online',
          interfaces: data.interfaces || null,
          polled_at: new Date()
        });
      } catch(logErr) { /* device mungkin sudah dihapus */ }

      // Save traffic data
      if (data.interfaces) {
        await this.saveTrafficData(device.id, data.interfaces);
      }

      // Emit real-time update
      if (this.io) {
        this.io.to(`device_${device.id}`).emit('device:update', {
          device_id: device.id,
          status: 'online',
          cpu_load: data.cpu,
          memory_usage: data.memory,
          uptime: data.uptime,
          interfaces: data.interfaces,
          timestamp: new Date()
        });

        this.io.emit('monitoring:update', {
          device_id: device.id,
          name: device.name,
          status: 'online',
          cpu_load: data.cpu,
          memory_usage: data.memory
        });
      }

      // Device came back online
      if (prevStatus === DEVICE_STATUS.OFFLINE) {
        await this.createAlert(device, 'device_up', 'info',
          `Device ${device.name} is back online`);
      }

      // CPU overload alert
      if (data.cpu > 90) {
        await this.createAlert(device, 'cpu_overload', 'warning',
          `CPU load on ${device.name}: ${data.cpu}%`);
      }

    } catch (error) {
      // Device is offline
      const prevStatus = device.status;
      await Device.update({
        status: DEVICE_STATUS.OFFLINE,
        last_polled: new Date()
      }, { where: { id: device.id } });

      try {
        await DeviceLog.create({
          device_id: device.id,
          status: 'offline',
          polled_at: new Date()
        });
      } catch(logErr) { /* device mungkin sudah dihapus */ }

      if (this.io) {
        this.io.emit('monitoring:update', {
          device_id: device.id,
          name: device.name,
          status: 'offline'
        });
      }

      if (prevStatus !== DEVICE_STATUS.OFFLINE) {
        await this.createAlert(device, 'device_down', 'critical',
          `Device ${device.name} (${device.ip_address}) is DOWN`);
      }

      logger.debug(`Device ${device.name} (${device.ip_address}) unreachable`);
    } finally {
      session.close();
    }
  }

  getDeviceData(session, device) {
    return new Promise((resolve, reject) => {
      const oids = [
        SNMP_OIDS.SYSTEM_UPTIME,
        SNMP_OIDS.SYSTEM_NAME,
        SNMP_OIDS.SYSTEM_DESCR
      ];

      // Add Mikrotik specific OIDs
      if (device.brand?.toLowerCase() === 'mikrotik') {
        oids.push(SNMP_OIDS.MT_CPU_LOAD);
        oids.push(SNMP_OIDS.MT_TOTAL_MEMORY);
        oids.push(SNMP_OIDS.MT_USED_MEMORY);
        oids.push(SNMP_OIDS.MT_FIRMWARE);
      }

      session.get(oids, (error, varbinds) => {
        if (error) return reject(error);

        const data = { cpu: 0, memory: 0, uptime: '', firmware: '', interfaces: [] };

        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;

          const oid = vb.oid.join ? vb.oid.join('.') : vb.oid;
          
          if (oid === SNMP_OIDS.SYSTEM_UPTIME) {
            data.uptime = formatUptime(vb.value);
          } else if (oid === SNMP_OIDS.MT_CPU_LOAD) {
            data.cpu = parseInt(vb.value) || 0;
          } else if (oid === SNMP_OIDS.MT_FIRMWARE) {
            data.firmware = sanitizeSnmpValue(vb) || '';
          }
        }

        // Get interface data
        this.getInterfaces(session).then(interfaces => {
          data.interfaces = interfaces;
          resolve(data);
        }).catch(() => resolve(data));
      });
    });
  }

  getInterfaces(session) {
    return new Promise((resolve) => {
      const interfaces = [];
      const columns = [2, 8, 10, 16]; // ifDescr, ifOperStatus, ifInOctets, ifOutOctets

      session.tableColumns(SNMP_OIDS.IF_TABLE, columns, 50, (error, table) => {
        if (error) return resolve([]);

        for (const index in table) {
          const row = table[index];
          const name = row[2] ? (Buffer.isBuffer(row[2]) ? row[2].toString() : String(row[2])) : `if${index}`;
          const status = row[8] === 1 ? 'up' : 'down';
          const rxBytes = parseInt(row[10]) || 0;
          const txBytes = parseInt(row[16]) || 0;

          interfaces.push({
            index: parseInt(index),
            name,
            status,
            rx_bytes: rxBytes,
            tx_bytes: txBytes
          });
        }

        resolve(interfaces);
      });
    });
  }

  async saveTrafficData(deviceId, interfaces) {
    const prevKey = `device_${deviceId}`;
    const prev = this.previousTraffic.get(prevKey) || {};
    const now = Date.now();
    const prevTime = prev._timestamp || now;
    const elapsed = (now - prevTime) / 1000;

    for (const iface of interfaces) {
      const prevIface = prev[iface.name] || {};
      let rxRate = 0;
      let txRate = 0;

      if (elapsed > 0 && prevIface.rx_bytes !== undefined) {
        const rxDiff = iface.rx_bytes - prevIface.rx_bytes;
        const txDiff = iface.tx_bytes - prevIface.tx_bytes;
        if (rxDiff >= 0) rxRate = Math.round((rxDiff * 8) / elapsed);
        if (txDiff >= 0) txRate = Math.round((txDiff * 8) / elapsed);
      }

      try {
        await TrafficData.create({
          device_id: deviceId,
          interface_name: iface.name,
          rx_bytes: iface.rx_bytes,
          tx_bytes: iface.tx_bytes,
          rx_rate: rxRate,
          tx_rate: txRate,
          recorded_at: new Date()
        });
      } catch (e) {
        // Ignore individual insert errors
      }
    }

    // Store current values for rate calculation
    const current = { _timestamp: now };
    for (const iface of interfaces) {
      current[iface.name] = { rx_bytes: iface.rx_bytes, tx_bytes: iface.tx_bytes };
    }
    this.previousTraffic.set(prevKey, current);
  }

  async createAlert(device, type, severity, message) {
    try {
      const admins = await User.findAll({
        where: { is_active: true },
        attributes: ['id']
      });

      for (const admin of admins) {
        await Notification.create({
          user_id: admin.id,
          type,
          title: `Device Alert: ${device.name}`,
          message,
          severity,
          metadata: { device_id: device.id, ip: device.ip_address }
        });
      }

      if (this.io) {
        this.io.emit('notification:new', { type, title: `Device Alert: ${device.name}`, message, severity });
      }
    } catch (e) {
      logger.error('Create alert error:', e.message);
    }
  }
}

// Singleton instance — bisa diakses dari controller
let _instance = null;

module.exports = SNMPService;
module.exports.getInstance = () => _instance;
module.exports.setInstance = (inst) => { _instance = inst; };