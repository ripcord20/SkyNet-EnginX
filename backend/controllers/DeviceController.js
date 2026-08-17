const { Device, DeviceLog, TrafficData, sequelize } = require('../models');
const { Op } = require('sequelize');
const { paginateResponse } = require('../utils/helpers');
const net = require('net');
const logger = require('../utils/logger');

class DeviceController {
  async index(req, res) {
    try {
      const { page = 1, limit = 20, search, status, type } = req.query;
      const where = {};
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { ip_address: { [Op.like]: `%${search}%` } }
        ];
      }
      if (status) where.status = status;
      if (type) where.type = type;

      const offset = (page - 1) * limit;
      const { count, rows } = await Device.findAndCountAll({
        where,
        offset,
        limit: parseInt(limit),
        order: [['name', 'ASC']]
      });

      res.json({ success: true, ...paginateResponse(rows, count, page, limit) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // GET /api/devices/mikrotik-list
  // List ringan device tipe router/MikroTik untuk dropdown selector di dashboard.
  // Tidak expose api_password / sensitive fields.
  async mikrotikList(req, res) {
    try {
      const rows = await Device.findAll({
        where: { type: 'router', is_active: true },
        attributes: ['id', 'name', 'ip_address', 'status'],
        order: [['name', 'ASC']]
      });
      // Tandai primary kalau kolomnya ada
      let primaryId = null;
      try {
        const primary = await Device.findOne({
          where: { is_primary: true, type: 'router', is_active: true },
          attributes: ['id']
        });
        if (primary) primaryId = primary.id;
      } catch (_) { /* kolom is_primary belum ada → abaikan */ }

      res.json({
        success: true,
        data: rows.map(r => ({
          id: r.id,
          name: r.name,
          ip_address: r.ip_address,
          status: r.status,
          is_primary: r.id === primaryId
        }))
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // POST /api/devices/:id/set-primary
  // Tandai 1 device sebagai primary MikroTik. Membutuhkan kolom `is_primary` di tabel devices.
  // Idempotent: kalau kolom belum ada, return 501 dengan instruksi migrasi.
  async setPrimary(req, res) {
    try {
      const id = parseInt(req.params.id);
      const dev = await Device.findByPk(id);
      if (!dev) return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
      if (dev.type !== 'router') {
        return res.status(400).json({ success: false, message: 'Hanya device tipe router (MikroTik) yang bisa dijadikan primary' });
      }
      try {
        await sequelize.transaction(async (t) => {
          await Device.update({ is_primary: false }, { where: { is_primary: true }, transaction: t });
          await dev.update({ is_primary: true }, { transaction: t });
        });
        // Reset cache agar request berikutnya pakai instance baru
        try { require('../services/MikrotikService').resetInstance(); } catch (_) {}
        res.json({ success: true, message: 'Primary MikroTik diperbarui' });
      } catch (e) {
        if (/Unknown column|no such column/i.test(e.message)) {
          return res.status(501).json({
            success: false,
            message: 'Kolom is_primary belum ada di tabel devices. Jalankan: ALTER TABLE devices ADD COLUMN is_primary TINYINT(1) NOT NULL DEFAULT 0;'
          });
        }
        throw e;
      }
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async create(req, res) {
    try {
      const device = await Device.create(req.body);
      res.status(201).json({ success: true, data: device });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async show(req, res) {
    try {
      const device = await Device.findByPk(req.params.id, {
        include: [{
          model: DeviceLog,
          as: 'logs',
          limit: 100,
          order: [['polled_at', 'DESC']]
        }]
      });
      if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
      res.json({ success: true, data: device });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async update(req, res) {
    try {
      const device = await Device.findByPk(req.params.id);
      if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
      await device.update(req.body);
      res.json({ success: true, data: device });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async destroy(req, res) {
    const t = await sequelize.transaction();
    try {
      const device = await Device.findByPk(req.params.id, { transaction: t });
      if (!device) {
        await t.rollback();
        return res.status(404).json({ success: false, message: 'Device not found' });
      }

      // Stop SNMP polling dulu sebelum hapus
      try {
        const SNMPService = require('../services/SNMPService');
        const snmp = SNMPService.getInstance();
        if (snmp) snmp.stopDevice(device.id);
      } catch(e) {}

      // ─── Cleanup child tables yang reference devices.id ──────────
      // Beberapa tabel punya FK ke devices tapi TIDAK punya ON DELETE CASCADE
      // di DB schema-nya. Kita manual delete supaya `device.destroy()` tidak
      // gagal karena foreign key constraint.
      //
      // Pendekatan: best-effort delete dari setiap child table. Kalau tabel
      // tidak ada (mis. fitur belum migrate), catch & lanjut.
      const cleanups = [
        // Sequelize models (sudah ada di codebase)
        { name: 'DeviceLog',         where: { device_id: device.id } },
        { name: 'TrafficData',       where: { device_id: device.id } },
        { name: 'NocMonitorPreset',  where: { router_id: device.id } },
      ];

      for (const c of cleanups) {
        try {
          const Model = require('../models')[c.name];
          if (Model) {
            const n = await Model.destroy({ where: c.where, transaction: t });
            if (n > 0) {
              logger.info(`[Device.destroy] cleaned ${n} ${c.name} row(s) for device ${device.id}`);
            }
          }
        } catch (e) {
          // Model tidak ada / column tidak ada — fail soft
          logger.warn(`[Device.destroy] cleanup ${c.name} skipped: ${e.message}`);
        }
      }

      // Customer.mikrotik_id — jangan delete customer, tapi set mikrotik_id = NULL
      // (customer tetap ada, hanya unlink dari router yang akan dihapus)
      try {
        const Customer = require('../models').Customer;
        if (Customer) {
          const [updated] = await Customer.update(
            { mikrotik_id: null },
            { where: { mikrotik_id: device.id }, transaction: t }
          );
          if (updated > 0) {
            logger.info(`[Device.destroy] unlinked ${updated} customer(s) from device ${device.id}`);
          }
        }
      } catch (e) {
        logger.warn(`[Device.destroy] customer unlink skipped: ${e.message}`);
      }

      // Generic raw SQL cleanup untuk child tables yang tidak punya model di Sequelize
      // (fail-soft kalau tabel tidak ada). Tambahkan di sini kalau ada FK error baru.
      const rawCleanups = [
        // tabel monitoring/snmp lain yang mungkin reference devices
        `DELETE FROM device_metrics WHERE device_id = ?`,
        `DELETE FROM device_alerts WHERE device_id = ?`,
        `DELETE FROM interface_stats WHERE device_id = ?`,
      ];
      for (const sql of rawCleanups) {
        try {
          await sequelize.query(sql, {
            replacements: [device.id],
            transaction: t,
          });
        } catch (e) {
          // Tabel tidak ada — abaikan. ER_NO_SUCH_TABLE = code 1146
          if (!String(e.message).match(/doesn'?t exist|Unknown table|no such table/i)) {
            logger.warn(`[Device.destroy] raw cleanup failed: ${e.message}`);
          }
        }
      }

      // Sekarang hapus device-nya
      await device.destroy({ transaction: t });
      await t.commit();
      res.json({ success: true, message: 'Device deleted' });
    } catch (error) {
      try { await t.rollback(); } catch(_) {}
      logger.error(`[Device.destroy] failed: ${error.message}`);
      // Pesan ramah ke user: kalau FK error, hint apa yang perlu dihapus dulu
      let msg = error.message || 'Gagal menghapus device';
      if (String(msg).match(/foreign key constraint/i)) {
        const m = msg.match(/`(\w+)`\.\.?`(\w+)`/);
        const tableHint = m ? m[2] : '(tabel anak)';
        msg = `Device tidak bisa dihapus karena masih terhubung dengan ${tableHint}. Hapus data terkait dulu, atau hubungi admin untuk update schema FK.`;
      }
      res.status(500).json({ success: false, message: msg });
    }
  }

  // Device stats for dashboard
  async stats(req, res) {
    try {
      const total = await Device.count({ where: { is_active: true } });
      const online = await Device.count({ where: { status: 'online', is_active: true } });
      const offline = await Device.count({ where: { status: 'offline', is_active: true } });
      const warning = await Device.count({ where: { status: 'warning', is_active: true } });

      res.json({
        success: true,
        data: { total, online, offline, warning }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Get traffic data for charts
  async trafficData(req, res) {
    try {
      const { id } = req.params;
      const { hours = 1, interface_name } = req.query;

      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      const where = {
        device_id: id,
        recorded_at: { [Op.gte]: since }
      };
      if (interface_name) where.interface_name = interface_name;

      const data = await TrafficData.findAll({
        where,
        order: [['recorded_at', 'ASC']],
        limit: 1000
      });

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Get all devices for monitoring overview
  async monitoringOverview(req, res) {
    try {
      const devices = await Device.findAll({
        where: { is_active: true },
        attributes: ['id', 'name', 'ip_address', 'type', 'status', 'cpu_load', 'memory_usage', 'uptime', 'last_polled'],
        order: [['name', 'ASC']]
      });
      res.json({ success: true, data: devices });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Get device interfaces with live traffic
  async interfaces(req, res) {
    try {
      const { id } = req.params;
      
      // Get latest traffic data per interface
      const latestTraffic = await TrafficData.findAll({
        where: { device_id: id },
        attributes: [
          'interface_name',
          [sequelize.fn('MAX', sequelize.col('recorded_at')), 'latest']
        ],
        group: ['interface_name'],
        raw: true
      });

      const interfaces = [];
      for (const t of latestTraffic) {
        const latest = await TrafficData.findOne({
          where: {
            device_id: id,
            interface_name: t.interface_name,
            recorded_at: t.latest
          }
        });
        if (latest) interfaces.push(latest);
      }

      res.json({ success: true, data: interfaces });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ── Get realtime stats untuk 1 interface (dipakai chart live) ──
  async interfaceStats(req, res) {
    try {
      const device = await Device.findByPk(req.params.id);
      if (!device) return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });

      const ifName = req.query.name;
      if (!ifName) return res.status(400).json({ success: false, message: 'Parameter name wajib' });

      if (!['router', 'olt'].includes(device.type) || !['api','both'].includes(device.monitoring_type) || !device.api_username) {
        return res.status(400).json({ success: false, message: 'Device tidak mendukung MikroTik API' });
      }

      const { MikrotikService } = require('../services/MikrotikService');
      const mt = new MikrotikService({
        host: device.ip_address,
        port: device.api_port || 80,
        username: device.api_username,
        password: device.api_password || '',
        api_protocol: device.api_protocol || null,
        timeout: 6000
      });

      // Fetch live stats + current counters secara paralel
      const [stats, ifaces] = await Promise.all([
        mt.getInterfaceStats(ifName),
        mt.getInterfaces()
      ]);

      const ifData = (ifaces || []).find(i => i.name === ifName);
      const result = {
        name: ifName,
        timestamp: Date.now(),
        rxBitsPerSecond: stats?.rxBitsPerSecond || 0,
        txBitsPerSecond: stats?.txBitsPerSecond || 0,
        rxPacketsPerSecond: stats?.rxPacketsPerSecond || 0,
        txPacketsPerSecond: stats?.txPacketsPerSecond || 0,
        rxByte: ifData?.rxByte || 0,
        txByte: ifData?.txByte || 0,
        rxPacket: ifData?.rxPacket || 0,
        txPacket: ifData?.txPacket || 0,
        running: ifData?.running || false,
        disabled: ifData?.disabled || false,
        macAddress: ifData?.macAddress || '',
        type: ifData?.type || 'ether',
        comment: ifData?.comment || ''
      };

      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ── Test connection ke device yang SUDAH tersimpan ──
  async testConnection(req, res) {
    try {
      const device = await Device.findByPk(req.params.id);
      if (!device) return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });

      const result = await _probeDevice({
        ip_address: device.ip_address,
        type: device.type,
        monitoring_type: device.monitoring_type,
        snmp_community: device.snmp_community,
        snmp_port: device.snmp_port,
        snmp_version: device.snmp_version,
        api_username: device.api_username,
        api_password: device.api_password,
        api_port: device.api_port,
        api_protocol: device.api_protocol
      });

      // Update status device di DB
      await device.update({
        status: result.success ? 'online' : 'offline',
        last_polled: new Date()
      });

      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ── Test connection untuk device yang BELUM disimpan (dari modal) ──
  async testConnectionByConfig(req, res) {
    try {
      const cfg = req.body || {};
      if (!cfg.ip_address) {
        return res.status(400).json({ success: false, message: 'IP address wajib diisi' });
      }
      const result = await _probeDevice(cfg);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ── Live data dari device (resource, identity, interfaces live) ──
  async liveData(req, res) {
    try {
      const device = await Device.findByPk(req.params.id);
      if (!device) return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });

      const result = {
        device: {
          id: device.id,
          name: device.name,
          ip_address: device.ip_address,
          type: device.type,
          brand: device.brand,
          model: device.model,
          status: device.status,
          last_polled: device.last_polled
        },
        identity: null,
        resource: null,
        interfaces: [],
        fetched_at: new Date(),
        errors: []
      };

      // Hanya coba MikroTik API untuk tipe router/olt yang pakai API
      const canUseMt = ['router', 'olt'].includes(device.type)
                    && ['api', 'both'].includes(device.monitoring_type)
                    && device.api_username;

      if (canUseMt) {
        try {
          const { MikrotikService } = require('../services/MikrotikService');
          const mt = new MikrotikService({
            host: device.ip_address,
            port: device.api_port || 80,
            username: device.api_username,
            password: device.api_password || '',
            api_protocol: device.api_protocol || null,
            timeout: 8000
          });

          // Parallel: identity + resource + interfaces
          const [idRes, resRes, ifRes] = await Promise.allSettled([
            mt.getSystemIdentity(),
            mt.getSystemResource(),
            mt.getInterfaces()
          ]);

          if (idRes.status === 'fulfilled') {
            result.identity = idRes.value?.name || null;
          } else {
            result.errors.push({ step: 'identity', error: idRes.reason?.message });
          }

          if (resRes.status === 'fulfilled') {
            result.resource = resRes.value;
          } else {
            result.errors.push({ step: 'resource', error: resRes.reason?.message });
          }

          if (ifRes.status === 'fulfilled') {
            const ifaces = ifRes.value || [];
            // Ambil live bitrate untuk interface yang running (top 10)
            const running = ifaces.filter(i => i.running).slice(0, 10);
            let liveStats = [];
            try {
              liveStats = await mt.getInterfacesBulkStats(running.map(i => i.name));
            } catch (_) {}
            const statsByName = {};
            liveStats.forEach(s => { statsByName[s.name] = s; });

            result.interfaces = ifaces.map(i => ({
              ...i,
              rxBitsPerSecond: statsByName[i.name]?.rxBitsPerSecond || 0,
              txBitsPerSecond: statsByName[i.name]?.txBitsPerSecond || 0
            }));
          } else {
            result.errors.push({ step: 'interfaces', error: ifRes.reason?.message });
          }

          // Update status & last_polled kalau sukses
          if (result.resource) {
            await device.update({
              status: 'online',
              cpu_load: result.resource.cpuLoad,
              memory_usage: result.resource.totalMemory > 0
                ? Math.round(((result.resource.totalMemory - result.resource.freeMemory) / result.resource.totalMemory) * 100)
                : 0,
              uptime: result.resource.uptime,
              firmware: result.resource.version,
              last_polled: new Date()
            });
            result.device.status = 'online';
          }
        } catch (e) {
          result.errors.push({ step: 'mikrotik', error: e.message });
        }
      } else {
        result.errors.push({
          step: 'api',
          error: `Live data API hanya tersedia untuk device ${['router','olt'].includes(device.type) ? 'dengan monitoring API' : 'tipe router/OLT'}`
        });
      }

      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helper functions (outside class)
// ────────────────────────────────────────────────────────────

/**
 * TCP-ping ke host:port dengan timeout.
 * Dipakai sebagai alternatif ICMP (ICMP butuh root privilege).
 */
function _tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (ok) resolve({ reachable: true, ms: Date.now() - start, port });
      else   reject(err || new Error('unreachable'));
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, new Error('timeout')));
    socket.once('error',   (e) => finish(false, e));
    socket.connect(parseInt(port), host);
  });
}

/**
 * Probe device: TCP ping → API auth (kalau config) → SNMP query.
 * Return { success, reachable, ping_ms, identity, method, error, checks[] }.
 */
async function _probeDevice(cfg) {
  const result = {
    success: false,
    reachable: false,
    ping_ms: null,
    identity: null,
    method: null,
    error: null,
    checks: []
  };

  const host = cfg.ip_address;

  // ── Step 1: TCP ping (coba beberapa port umum) ──
  const portsToTry = [
    parseInt(cfg.api_port) || 80,
    443,
    22,
    parseInt(cfg.snmp_port) || 161
  ].filter((p, i, arr) => arr.indexOf(p) === i); // unique

  for (const port of portsToTry) {
    try {
      const pr = await _tcpPing(host, port, 2500);
      if (pr.reachable) {
        result.reachable = true;
        result.ping_ms   = pr.ms;
        result.checks.push({ step: 'TCP Ping', ok: true, detail: `${pr.ms}ms (port ${pr.port})` });
        break;
      }
    } catch (_) { /* coba port berikutnya */ }
  }

  if (!result.reachable) {
    result.error = `Host ${host} tidak dapat dijangkau`;
    result.checks.push({ step: 'TCP Ping', ok: false, detail: 'All ports timeout / refused' });
    return result;
  }

  // ── Step 2: API auth check (MikroTik REST) ──
  const useApi = ['api', 'both'].includes(cfg.monitoring_type);
  if (useApi && cfg.api_username) {
    try {
      const { MikrotikService } = require('../services/MikrotikService');
      const mt = new MikrotikService({
        host,
        port: cfg.api_port || 80,
        username: cfg.api_username,
        password: cfg.api_password || '',
        api_protocol: cfg.api_protocol || null,
        timeout: 6000
      });
      const test = await mt.testConnection();
      if (test.success) {
        result.identity = test.identity;
        result.method   = 'API';
        result.checks.push({ step: 'API Auth', ok: true, detail: `identity: ${test.identity}` });
      } else {
        result.checks.push({ step: 'API Auth', ok: false, detail: test.error || 'auth failed' });
      }
    } catch (e) {
      result.checks.push({ step: 'API Auth', ok: false, detail: e.message });
    }
  } else if (useApi && !cfg.api_username) {
    result.checks.push({ step: 'API Auth', ok: false, detail: 'username/password tidak diisi' });
  }

  // ── Step 3: SNMP check ──
  const useSnmp = ['snmp', 'both'].includes(cfg.monitoring_type) || !cfg.monitoring_type;
  if (useSnmp) {
    try {
      const snmp = require('net-snmp');
      const session = snmp.createSession(host, cfg.snmp_community || 'public', {
        port:    parseInt(cfg.snmp_port) || 161,
        version: cfg.snmp_version === 1 ? snmp.Version1 : snmp.Version2c,
        timeout: 4000,
        retries: 1
      });
      const snmpResult = await new Promise((resolve) => {
        session.get(['1.3.6.1.2.1.1.5.0'], (err, varbinds) => {
          try { session.close(); } catch(_) {}
          if (err) return resolve({ ok: false, error: err.message });
          if (varbinds && varbinds[0] && !snmp.isVarbindError(varbinds[0])) {
            resolve({ ok: true, identity: varbinds[0].value.toString() });
          } else {
            resolve({ ok: false, error: 'SNMP varbind error' });
          }
        });
      });
      if (snmpResult.ok) {
        if (!result.identity) result.identity = snmpResult.identity;
        result.method = result.method ? result.method + '+SNMP' : 'SNMP';
        result.checks.push({ step: 'SNMP', ok: true, detail: `sysName: ${snmpResult.identity}` });
      } else {
        result.checks.push({ step: 'SNMP', ok: false, detail: snmpResult.error });
      }
    } catch (e) {
      result.checks.push({ step: 'SNMP', ok: false, detail: e.message });
    }
  }

  // ── Verdict ──
  const authOk = result.checks.some(c => (c.step === 'API Auth' || c.step === 'SNMP') && c.ok);
  result.success = result.reachable && (authOk || (!useApi && !useSnmp));
  if (!result.success && !result.error) {
    result.error = 'Host tercapai tapi autentikasi SNMP/API gagal';
  }

  return result;
}

module.exports = new DeviceController();