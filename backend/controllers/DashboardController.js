const { Device, Customer, Invoice, OntDevice, Payment, TrafficData, Ticket, QueueHistory, sequelize } = require('../models');
const { Op } = require('sequelize');
const moment = require('moment');
const { getMikrotikInstance, getMikrotikInstanceByDevice } = require('../services/MikrotikService');

// Cache hasil peta sebaran pelanggan (60s) — lihat customerMapPoints()
let _custMapCache = { ts: 0, data: null };

class DashboardController {
  async overview(req, res) {
    try {
      // Ambil device terpilih dari query (?device_id=) atau auto-pick primary/first
      const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;

      // ── PPPoE aktif dari MikroTik REST API ──────────────────
      let pppoeActive = 0;
      let totalBandwidthMbps = 0;
      try {
        const mt = await getMikrotikInstanceByDevice(deviceId);
        const sessions = await mt.getPPPoESessions();
        pppoeActive = sessions.length;

        // Bandwidth total dari queue stats MikroTik
        const queues = await mt.getQueueStats();
        queues.forEach(q => {
          totalBandwidthMbps += parseFloat(q.rateIn || 0) / 1_000_000;
        });
      } catch (mtErr) {
        // Fallback ke DB jika MikroTik tidak bisa diakses
        pppoeActive = await Customer.count({ where: { status: 'active' } });
        const bwResult = await sequelize.query(
          `SELECT COALESCE(SUM(p.speed_down), 0) as total_download
           FROM customers c JOIN packages p ON c.package_id = p.id
           WHERE c.status = 'active'`,
          { type: sequelize.QueryTypes.SELECT }
        );
        totalBandwidthMbps = (bwResult[0]?.total_download || 0) / 1000;
      }

      // ── ONT stats — dari GenieACS langsung ──────────────────
      let ontOnline = 0, ontOffline = 0;
      try {
        const { AppSetting } = require('../models');
        const row = await AppSetting.findOne({ where: { key: 'genieacs_nbi_url' } });
        const genieUrl = row?.value || process.env.GENIEACS_NBI_URL || '';
        if (genieUrl) {
          const axios = require('axios');
          const resp  = await axios.get(`${genieUrl}/devices`, { timeout: 5000 });
          const devices = Array.isArray(resp.data) ? resp.data : [];
          const now = Date.now();
          devices.forEach(d => {
            const lastInform = d._lastInform;
            if (lastInform) {
              const minutesAgo = (now - new Date(lastInform).getTime()) / 60000;
              if (minutesAgo < 5) ontOnline++; else ontOffline++;
            } else {
              ontOffline++;
            }
          });
        } else {
          // Fallback ke DB jika GenieACS belum dikonfigurasi
          ontOnline  = await OntDevice.count({ where: { status: 'online' } });
          ontOffline = await OntDevice.count({ where: { status: 'offline' } });
        }
      } catch (genieErr) {
        // Fallback ke DB
        ontOnline  = await OntDevice.count({ where: { status: 'online' } });
        ontOffline = await OntDevice.count({ where: { status: 'offline' } });
      }

      // ── CPU Load — dari MikroTik /system/resource ────────────
      let cpuLoad = 0;
      let cpuDeviceName = 'Router';
      try {
        const mt  = await getMikrotikInstanceByDevice(deviceId);
        const res2 = await mt.getSystemResource();
        cpuLoad = res2?.cpuLoad ?? 0;
        try {
          const ident = await mt.getSystemIdentity();
          cpuDeviceName = ident?.name || 'Router';
        } catch (_) { /* identity optional */ }
      } catch (cpuErr) {
        // Fallback ke rata-rata CPU device di DB
        const avgCpuFallback = await Device.findOne({
          attributes: [[sequelize.fn('AVG', sequelize.col('cpu_load')), 'avg_cpu']],
          where: { status: 'online', is_active: true },
          raw: true
        });
        cpuLoad = Math.round((avgCpuFallback?.avg_cpu || 0) * 100) / 100;
      }

      // ── Device stats ─────────────────────────────────────────
      const devicesOnline  = await Device.count({ where: { status: 'online',  is_active: true } });
      const devicesOffline = await Device.count({ where: { status: 'offline', is_active: true } });
      const devicesTotal   = await Device.count({ where: { is_active: true } });

      // ── Billing stats ────────────────────────────────────────
      const currentMonth = moment().month() + 1;
      const unpaidInvoices   = await Invoice.count({ where: { status: 'unpaid' } });
      const overdueInvoices  = await Invoice.count({ where: { status: 'overdue' } });
      const revenueThisMonth = await Payment.sum('amount', {
        where: sequelize.where(sequelize.fn('MONTH', sequelize.col('payment_date')), currentMonth)
      }) || 0;

      // ── Customer stats ───────────────────────────────────────
      const totalCustomers    = await Customer.count();
      const activeCustomers   = await Customer.count({ where: { status: 'active' } });
      const isolatedCustomers = await Customer.count({ where: { status: 'isolated' } });

      // ── Interface traffic dari MikroTik ──────────────────────
      let interfaceTraffic = [];
      try {
        const mt = await getMikrotikInstanceByDevice(deviceId);
        const ifaces = await mt.getInterfaces();
        // Ambil top 5 interface yang running saja
        const running = ifaces.filter(i => i.running && !i.disabled).slice(0, 5);
        const statsPromises = running.map(iface =>
          mt.getInterfaceStats(iface.name).catch(() => ({
            name: iface.name,
            rxBitsPerSecond: 0,
            txBitsPerSecond: 0
          }))
        );
        const stats = await Promise.all(statsPromises);
        interfaceTraffic = stats.map(s => ({
          name: s.name,
          rxRate: s.rxBitsPerSecond,
          txRate: s.txBitsPerSecond,
          rxMbps: (s.rxBitsPerSecond / 1_000_000).toFixed(2),
          txMbps: (s.txBitsPerSecond / 1_000_000).toFixed(2),
          status: 'online'
        }));

        // Hitung total bandwidth dari interface utama jika queue kosong
        if (totalBandwidthMbps === 0) {
          totalBandwidthMbps = interfaceTraffic.reduce((sum, i) => sum + parseFloat(i.rxMbps), 0);
        }
      } catch (e) { /* MikroTik tidak tersedia */ }

      res.json({
        success: true,
        data: {
          pppoe:     { active: pppoeActive },
          bandwidth: { total_download: Math.round(totalBandwidthMbps * 1000), mbps: totalBandwidthMbps.toFixed(1) },
          ont:       { online: ontOnline, offline: ontOffline },
          devices:   { online: devicesOnline, offline: devicesOffline, total: devicesTotal },
          cpu:       { average: cpuLoad, deviceName: cpuDeviceName },
          billing:   { unpaid: unpaidInvoices, overdue: overdueInvoices, revenueThisMonth },
          customers: { total: totalCustomers, active: activeCustomers, isolated: isolatedCustomers },
          interfaces: interfaceTraffic
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── TOP CUSTOMERS BY BANDWIDTH USAGE ────────────────────────
  async topCustomersBandwidth(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const period = req.query.period || 'total'; // 'total','24h','7d','30d'

      let startDate;
      switch (period) {
        case '7d':
          startDate = moment().subtract(7, 'days').toDate();
          break;
        case '30d':
          startDate = moment().subtract(30, 'days').toDate();
          break;
        case '24h':
          startDate = moment().subtract(24, 'hours').toDate();
          break;
        default: // 'total' — akumulatif dari Simple Queue, tidak pakai window waktu
          startDate = null;
      }

      let topCustomers = [];

      // ─── METHOD 1: Agregasi Simple Queue dari SEMUA router MikroTik ───
      // Bytes diambil dari field `bytes` Simple Queue (= Total Statistics:
      // upload/download kumulatif). Cocokkan queue → customer via beberapa cara
      // karena penamaan queue bervariasi (PPPoE pakai username, static/hotspot
      // sering pakai nama/CID + target IP).
      try {
        const { Device, Package } = require('../models');

        // Ambil semua customer aktif sekali (untuk matching)
        const customers = await Customer.findAll({
          where: { status: 'active' },
          include: [{ model: Package, as: 'package', attributes: ['name', 'speed_down', 'speed_up', 'price'] }],
          attributes: ['id', 'customer_id', 'name', 'pppoe_username', 'static_ip']
        });

        // Index pencocokan: 3 kunci → customer
        const byPppoe = new Map();   // pppoe_username (lowercase)
        const byIp    = new Map();   // static_ip
        const byName  = new Map();   // nama & customer_id (lowercase, dinormalisasi)
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const c of customers) {
          if (c.pppoe_username) byPppoe.set(String(c.pppoe_username).toLowerCase(), c);
          if (c.static_ip)      byIp.set(String(c.static_ip).trim(), c);
          if (c.name)           byName.set(norm(c.name), c);
          if (c.customer_id)    byName.set(norm(c.customer_id), c);
        }

        // Cocokkan satu queue ke customer. Urutan: pppoe → IP target → nama.
        const matchQueue = (q) => {
          const qn = String(q.name || '');
          // 1) PPPoE: nama queue == pppoe_username (kadang berformat <pppoe-USER>)
          const pppoeKey = qn.toLowerCase().replace(/^<?pppoe-?/, '').replace(/>$/, '');
          if (byPppoe.has(qn.toLowerCase())) return byPppoe.get(qn.toLowerCase());
          if (byPppoe.has(pppoeKey))         return byPppoe.get(pppoeKey);
          // 2) Static: target IP queue cocok dengan static_ip customer
          if (q.target) {
            const ip = String(q.target).split('/')[0].split(',')[0].trim();
            if (byIp.has(ip)) return byIp.get(ip);
          }
          // 3) Nama queue mengandung nama/CID customer (mis. "<43. WARUNG NIA>")
          const qnNorm = norm(qn);
          if (byName.has(qnNorm)) return byName.get(qnNorm);
          for (const [key, cust] of byName) {
            if (key.length >= 4 && qnNorm.includes(key)) return cust;
          }
          return null;
        };

        // Loop semua router aktif, kumpulkan queue, akumulasi per-customer
        const devices = await Device.findAll({
          where: { type: 'router', is_active: true },
          attributes: ['id', 'name']
        });
        // Fallback: kalau tidak ada device router terdaftar, pakai instance default
        const deviceIds = devices.length ? devices.map(d => d.id) : [null];

        const acc = new Map(); // customer.id → { customer, bytes, rxMbps, txMbps }
        for (const devId of deviceIds) {
          let queues = [];
          try {
            const mt = devId ? await getMikrotikInstanceByDevice(devId) : getMikrotikInstance();
            queues = await mt.getQueueStats();
          } catch (e) {
            console.log(`[TopCustomers] Router ${devId || 'default'} tidak terjangkau: ${e.message}`);
            continue;
          }
          for (const q of (queues || [])) {
            const customer = matchQueue(q);
            if (!customer) continue;
            const rxMbps = parseFloat(q.rateIn  || 0) / 1000000;
            const txMbps = parseFloat(q.rateOut || 0) / 1000000;
            const bytes  = parseFloat(q.bytesIn || 0) + parseFloat(q.bytesOut || 0);
            const prev = acc.get(customer.id) || { customer, bytes: 0, rxMbps: 0, txMbps: 0 };
            prev.bytes  += bytes;       // akumulasi antar-router (jaga-jaga split queue)
            prev.rxMbps += rxMbps;
            prev.txMbps += txMbps;
            acc.set(customer.id, prev);
          }
        }

        topCustomers = Array.from(acc.values())
          .map(({ customer, bytes, rxMbps, txMbps }) => {
            const totalGB = bytes / 1073741824;
            return {
              id: customer.id,
              customer_id: customer.customer_id,
              name: customer.name,
              pppoe_username: customer.pppoe_username,
              package_name: customer.package?.name || '-',
              speed_down: customer.package?.speed_down || 0,
              speed_up: customer.package?.speed_up || 0,
              total_gb: totalGB.toFixed(2),
              avg_download_mbps: rxMbps.toFixed(2),
              avg_upload_mbps: txMbps.toFixed(2),
              peak_download_mbps: rxMbps.toFixed(2),
              usage_percent: customer.package?.speed_down
                ? ((rxMbps / customer.package.speed_down) * 100).toFixed(1)
                : 0
            };
          })
          .sort((a, b) => parseFloat(b.total_gb) - parseFloat(a.total_gb))
          .slice(0, limit);
      } catch (mtErr) {
        console.log('[TopCustomers] MikroTik agregasi gagal, fallback ke database:', mtErr.message);
      }

      // ─── METHOD 2: Fallback to queue_history if MikroTik fails ───
      if (topCustomers.length === 0) {
        // Untuk period 'total' (startDate null) → tanpa filter tanggal (semua histori).
        const dateClause = startDate ? 'AND qh.recorded_at >= ?' : '';
        const repl = startDate ? [startDate, limit] : [limit];
        topCustomers = await sequelize.query(`
          SELECT 
            c.id,
            c.customer_id,
            c.name,
            c.pppoe_username,
            p.name as package_name,
            p.speed_down,
            p.speed_up,
            COALESCE(SUM(qh.rx_bytes + qh.tx_bytes) / 1073741824, 0) as total_gb,
            COALESCE(AVG(qh.rx_rate) / 1000000, 0) as avg_download_mbps,
            COALESCE(AVG(qh.tx_rate) / 1000000, 0) as avg_upload_mbps,
            COALESCE(MAX(qh.rx_rate) / 1000000, 0) as peak_download_mbps
          FROM customers c
          LEFT JOIN packages p ON c.package_id = p.id
          LEFT JOIN queue_history qh ON c.pppoe_username = qh.queue_name 
            ${dateClause}
          WHERE c.status = 'active'
          GROUP BY c.id, c.customer_id, c.name, c.pppoe_username, p.name, p.speed_down, p.speed_up
          HAVING total_gb > 0
          ORDER BY total_gb DESC
          LIMIT ?
        `, {
          replacements: repl,
          type: sequelize.QueryTypes.SELECT
        });

        topCustomers = topCustomers.map(c => ({
          ...c,
          total_gb: parseFloat(c.total_gb).toFixed(2),
          avg_download_mbps: parseFloat(c.avg_download_mbps).toFixed(2),
          avg_upload_mbps: parseFloat(c.avg_upload_mbps).toFixed(2),
          peak_download_mbps: parseFloat(c.peak_download_mbps).toFixed(2),
          usage_percent: c.speed_down ? ((c.avg_download_mbps / c.speed_down) * 100).toFixed(1) : 0
        }));
      }

      res.json({
        success: true,
        data: topCustomers,
        period,
        source: topCustomers.length > 0 && topCustomers[0].total_gb > 0 ? 'mikrotik' : 'database'
      });
    } catch (error) {
      console.error('Error fetching top customers:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── NETWORK UPTIME STATISTICS ───────────────────────────────
  async networkUptime(req, res) {
    try {
      const period = req.query.period || '7d'; // '7d', '30d'
      
      let startDate;
      switch (period) {
        case '30d':
          startDate = moment().subtract(30, 'days').toDate();
          break;
        default: // 7d
          startDate = moment().subtract(7, 'days').toDate();
      }

      // Ambil data uptime dari device logs
      const devices = await Device.findAll({
        where: { is_active: true },
        attributes: ['id', 'name', 'ip_address', 'type', 'status']
      });

      const uptimeStats = await Promise.all(devices.map(async (device) => {
        // Hitung uptime dari device logs
        const logs = await sequelize.query(`
          SELECT 
            COUNT(*) as total_checks,
            SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online_checks,
            MIN(created_at) as first_check,
            MAX(created_at) as last_check
          FROM device_logs
          WHERE device_id = ? AND created_at >= ?
        `, {
          replacements: [device.id, startDate],
          type: sequelize.QueryTypes.SELECT
        });

        const log = logs[0];
        const uptime_percent = log.total_checks > 0 
          ? ((log.online_checks / log.total_checks) * 100).toFixed(2)
          : 0;

        // Hitung downtime incidents
        const downtime = await sequelize.query(`
          SELECT COUNT(*) as incidents
          FROM device_logs
          WHERE device_id = ? 
            AND status = 'offline'
            AND created_at >= ?
        `, {
          replacements: [device.id, startDate],
          type: sequelize.QueryTypes.SELECT
        });

        return {
          device_id: device.id,
          device_name: device.name,
          device_ip: device.ip_address,
          device_type: device.type,
          current_status: device.status,
          uptime_percent: parseFloat(uptime_percent),
          total_checks: log.total_checks,
          downtime_incidents: downtime[0].incidents,
          period_days: moment().diff(moment(startDate), 'days')
        };
      }));

      // Summary statistics
      const totalDevices = uptimeStats.length;
      const avgUptime = totalDevices > 0
        ? (uptimeStats.reduce((sum, d) => sum + parseFloat(d.uptime_percent), 0) / totalDevices).toFixed(2)
        : 0;
      const criticalDevices = uptimeStats.filter(d => parseFloat(d.uptime_percent) < 95).length;

      res.json({
        success: true,
        data: {
          summary: {
            total_devices: totalDevices,
            average_uptime: parseFloat(avgUptime),
            critical_devices: criticalDevices,
            period
          },
          devices: uptimeStats.sort((a, b) => a.uptime_percent - b.uptime_percent)
        }
      });
    } catch (error) {
      console.error('Error fetching network uptime:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── TICKET/SUPPORT STATISTICS ───────────────────────────────
  async ticketStats(req, res) {
    try {
      const period = req.query.period || '30d'; // '7d', '30d', '90d'
      
      let startDate;
      switch (period) {
        case '7d':
          startDate = moment().subtract(7, 'days').toDate();
          break;
        case '90d':
          startDate = moment().subtract(90, 'days').toDate();
          break;
        default: // 30d
          startDate = moment().subtract(30, 'days').toDate();
      }

      // Overall ticket statistics
      const stats = await Ticket.findAll({
        where: {
          createdAt: { [Op.gte]: startDate }
        },
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
          'status',
          'priority',
          'type'
        ],
        group: ['status', 'priority', 'type'],
        raw: true
      });

      // Calculate metrics
      const totalTickets = await Ticket.count({
        where: { createdAt: { [Op.gte]: startDate } }
      });

      const resolvedTickets = await Ticket.count({
        where: {
          createdAt: { [Op.gte]: startDate },
          status: { [Op.in]: ['resolved', 'closed'] }
        }
      });

      const openTickets = await Ticket.count({
        where: {
          status: { [Op.in]: ['open', 'in_progress', 'pending'] }
        }
      });

      // Average resolution time
      const resolvedWithTime = await Ticket.findAll({
        where: {
          createdAt: { [Op.gte]: startDate },
          status: { [Op.in]: ['resolved', 'closed'] },
          resolved_at: { [Op.ne]: null }
        },
        attributes: ['createdAt', 'resolved_at'],
        raw: true
      });

      let avgResolutionHours = 0;
      if (resolvedWithTime.length > 0) {
        const totalHours = resolvedWithTime.reduce((sum, ticket) => {
          const hours = moment(ticket.resolved_at).diff(moment(ticket.createdAt), 'hours');
          return sum + hours;
        }, 0);
        avgResolutionHours = (totalHours / resolvedWithTime.length).toFixed(1);
      }

      // Tickets by type
      const byType = await Ticket.findAll({
        where: { createdAt: { [Op.gte]: startDate } },
        attributes: [
          'type',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: ['type'],
        raw: true
      });

      // Tickets by priority
      const byPriority = await Ticket.findAll({
        where: { createdAt: { [Op.gte]: startDate } },
        attributes: [
          'priority',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: ['priority'],
        raw: true
      });

      // Recent critical tickets
      const criticalTickets = await Ticket.findAll({
        where: {
          priority: 'critical',
          status: { [Op.notIn]: ['closed'] }
        },
        limit: 5,
        order: [['createdAt', 'DESC']],
        include: [{
          model: Customer,
          as: 'customer',
          attributes: ['name', 'customer_id', 'phone']
        }]
      });

      // List ticket yang open (open / in_progress / pending) untuk
      // ditampilkan di card Ticket Statistics dashboard.
      // Dibatasi 10 terbaru, di-order by priority (critical/high dulu)
      // lalu createdAt DESC, sehingga ticket yang urgent muncul di atas.
      const openTicketsRows = await Ticket.findAll({
        where: { status: { [Op.in]: ['open', 'in_progress', 'pending'] } },
        limit: 10,
        order: [
          // FIELD() di MySQL → custom enum ordering: critical > high > medium > low
          [sequelize.literal(`FIELD(priority, 'critical', 'high', 'medium', 'low')`), 'ASC'],
          ['created_at', 'DESC']
        ],
        include: [{
          model: Customer,
          as: 'customer',
          attributes: ['name', 'customer_id'],
          required: false
        }],
        attributes: [
          'id', 'ticket_number', 'title', 'type',
          'priority', 'status', 'created_at', 'due_at'
        ]
      });

      // Bentuk ulang menjadi shape ringan (hilangkan nested-yang-tidak-perlu)
      const openTicketsList = openTicketsRows.map(t => {
        const plain = t.get ? t.get({ plain: true }) : t;
        return {
          id:            plain.id,
          ticket_number: plain.ticket_number,
          title:         plain.title,
          type:          plain.type,
          priority:      plain.priority,
          status:        plain.status,
          created_at:    plain.created_at || plain.createdAt,
          due_at:        plain.due_at,
          customer_name: plain.customer?.name || null,
          customer_id:   plain.customer?.customer_id || null
        };
      });

      res.json({
        success: true,
        data: {
          summary: {
            total_tickets: totalTickets,
            open_tickets: openTickets,
            resolved_tickets: resolvedTickets,
            resolution_rate: totalTickets > 0 ? ((resolvedTickets / totalTickets) * 100).toFixed(1) : 0,
            avg_resolution_hours: parseFloat(avgResolutionHours)
          },
          by_type: byType,
          by_priority: byPriority,
          critical_tickets: criticalTickets,
          open_tickets_list: openTicketsList,
          period
        }
      });
    } catch (error) {
      console.error('Error fetching ticket stats:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── BANDWIDTH USAGE TRENDS ──────────────────────────────────
  // Query params:
  //   - period:    'realtime' (1h, per minute) | 'daily' (30d, per hour) | 'weekly' (7d, per day)
  //   - device_id: optional, filter ke device tertentu (MikroTik). Tanpa ini = semua device.
  //   - interface: optional, filter ke interface_name tertentu (mis. 'ether1','sfp1','VLAN_DDCUP').
  //                Tanpa ini = aggregate SEMUA interface di device yang dipilih.
  async bandwidthTrends(req, res) {
    try {
      const period = req.query.period || 'daily'; // 'realtime' | 'daily' | 'weekly'

      // Filter device & interface (opsional)
      const deviceId  = req.query.device_id ? parseInt(req.query.device_id) : null;
      const ifaceName = req.query.interface ? String(req.query.interface).trim() : '';

      // Build WHERE clause replacements dynamically.
      // Pakai sequelize replacement positional (?) karena query raw SQL.
      const extraWhere   = [];
      const extraValues  = [];
      if (deviceId && Number.isFinite(deviceId) && deviceId > 0) {
        extraWhere.push('device_id = ?');
        extraValues.push(deviceId);
      }
      if (ifaceName) {
        extraWhere.push('interface_name = ?');
        extraValues.push(ifaceName);
      }
      const extraWhereSql = extraWhere.length ? (' AND ' + extraWhere.join(' AND ')) : '';

      // ── MODE: Realtime (1 jam terakhir, per menit) ──
      if (period === 'realtime') {
        const startDate = moment().subtract(1, 'hour').toDate();

        const rows = await sequelize.query(`
          SELECT
            DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:00') AS bucket,
            AVG(rx_rate) / 1000000 AS avg_download_mbps,
            AVG(tx_rate) / 1000000 AS avg_upload_mbps,
            MAX(rx_rate) / 1000000 AS peak_download_mbps,
            MAX(tx_rate) / 1000000 AS peak_upload_mbps,
            SUM(rx_bytes + tx_bytes) / 1073741824 AS total_gb
          FROM traffic_data
          WHERE recorded_at >= ?${extraWhereSql}
          GROUP BY bucket
          ORDER BY bucket DESC
        `, {
          replacements: [startDate, ...extraValues],
          type: sequelize.QueryTypes.SELECT
        });

        const groupedData = rows.map(r => ({
          date: r.bucket.substring(0, 10),
          hour: parseInt(r.bucket.substring(11, 13)),
          minute: parseInt(r.bucket.substring(14, 16)),
          avg_download_mbps: parseFloat(r.avg_download_mbps || 0).toFixed(2),
          avg_upload_mbps: parseFloat(r.avg_upload_mbps || 0).toFixed(2),
          peak_download_mbps: parseFloat(r.peak_download_mbps || 0).toFixed(2),
          peak_upload_mbps: parseFloat(r.peak_upload_mbps || 0).toFixed(2),
          total_gb: parseFloat(r.total_gb || 0).toFixed(2)
        }));

        return res.json({
          success: true,
          data: groupedData,
          period,
          filter: { device_id: deviceId, interface: ifaceName || null }
        });
      }

      // ── MODE: Daily / Weekly ──
      const days = period === 'weekly' ? 7 : 30;
      
      const startDate = moment().subtract(days, 'days').startOf('day').toDate();

      // Query untuk trend bandwidth
      const trends = await sequelize.query(`
        SELECT 
          DATE(recorded_at) as date,
          HOUR(recorded_at) as hour,
          AVG(rx_rate) / 1000000 as avg_download_mbps,
          AVG(tx_rate) / 1000000 as avg_upload_mbps,
          MAX(rx_rate) / 1000000 as peak_download_mbps,
          MAX(tx_rate) / 1000000 as peak_upload_mbps,
          SUM(rx_bytes + tx_bytes) / 1073741824 as total_gb
        FROM traffic_data
        WHERE recorded_at >= ?${extraWhereSql}
        GROUP BY DATE(recorded_at), HOUR(recorded_at)
        ORDER BY date DESC, hour DESC
      `, {
        replacements: [startDate, ...extraValues],
        type: sequelize.QueryTypes.SELECT
      });

      // Group by day for weekly view, by hour for daily view
      let groupedData;
      if (period === 'weekly') {
        groupedData = trends.reduce((acc, row) => {
          const existing = acc.find(d => d.date === row.date);
          if (existing) {
            existing.avg_download_mbps += parseFloat(row.avg_download_mbps);
            existing.avg_upload_mbps += parseFloat(row.avg_upload_mbps);
            existing.peak_download_mbps = Math.max(existing.peak_download_mbps, parseFloat(row.peak_download_mbps));
            existing.peak_upload_mbps = Math.max(existing.peak_upload_mbps, parseFloat(row.peak_upload_mbps));
            existing.total_gb += parseFloat(row.total_gb);
            existing.count++;
          } else {
            acc.push({
              date: row.date,
              avg_download_mbps: parseFloat(row.avg_download_mbps),
              avg_upload_mbps: parseFloat(row.avg_upload_mbps),
              peak_download_mbps: parseFloat(row.peak_download_mbps),
              peak_upload_mbps: parseFloat(row.peak_upload_mbps),
              total_gb: parseFloat(row.total_gb),
              count: 1
            });
          }
          return acc;
        }, []);

        // Calculate averages
        groupedData = groupedData.map(d => ({
          ...d,
          avg_download_mbps: (d.avg_download_mbps / d.count).toFixed(2),
          avg_upload_mbps: (d.avg_upload_mbps / d.count).toFixed(2),
          peak_download_mbps: d.peak_download_mbps.toFixed(2),
          peak_upload_mbps: d.peak_upload_mbps.toFixed(2),
          total_gb: d.total_gb.toFixed(2)
        }));
      } else {
        groupedData = trends.map(row => ({
          date: row.date,
          hour: row.hour,
          avg_download_mbps: parseFloat(row.avg_download_mbps).toFixed(2),
          avg_upload_mbps: parseFloat(row.avg_upload_mbps).toFixed(2),
          peak_download_mbps: parseFloat(row.peak_download_mbps).toFixed(2),
          peak_upload_mbps: parseFloat(row.peak_upload_mbps).toFixed(2),
          total_gb: parseFloat(row.total_gb).toFixed(2)
        }));
      }

      res.json({
        success: true,
        data: groupedData,
        period,
        filter: { device_id: deviceId, interface: ifaceName || null }
      });
    } catch (error) {
      console.error('Error fetching bandwidth trends:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── BANDWIDTH INTERFACES LIST ───────────────────────────────
  // Mengembalikan daftar nama interface yang ADA datanya di traffic_data
  // untuk device tertentu (atau semua device jika device_id tidak dikirim).
  // Dipakai oleh dropdown "Pilih interface" di Bandwidth Trends.
  //
  // Query params:
  //   - device_id: opsional, MikroTik device id
  //   - days: opsional (default 30), batasi lookback agar query cepat
  async bandwidthInterfaces(req, res) {
    try {
      const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
      const days     = req.query.days ? parseInt(req.query.days) : 30;
      const startDate = moment().subtract(days, 'days').toDate();

      const extraWhere  = [];
      const extraValues = [];
      if (deviceId && Number.isFinite(deviceId) && deviceId > 0) {
        extraWhere.push('device_id = ?');
        extraValues.push(deviceId);
      }
      const extraWhereSql = extraWhere.length ? (' AND ' + extraWhere.join(' AND ')) : '';

      const rows = await sequelize.query(`
        SELECT interface_name, COUNT(*) AS rows_count, MAX(recorded_at) AS last_seen
        FROM traffic_data
        WHERE recorded_at >= ?${extraWhereSql}
        GROUP BY interface_name
        ORDER BY rows_count DESC
        LIMIT 50
      `, {
        replacements: [startDate, ...extraValues],
        type: sequelize.QueryTypes.SELECT
      });

      const data = rows
        .filter(r => r.interface_name)
        .map(r => ({
          name: r.interface_name,
          rows: parseInt(r.rows_count),
          last_seen: r.last_seen
        }));

      // Fallback: kalau traffic_data masih kosong (cron baru jalan / belum ada
      // histori), ambil daftar interface LIVE dari MikroTik supaya dropdown
      // tetap terisi & user bisa langsung memilih.
      if (data.length === 0) {
        try {
          const mt = await getMikrotikInstanceByDevice(deviceId);
          const ifaces = await mt.getInterfaces();
          const live = (ifaces || [])
            .filter(i => i.running && !['bridge','vlan','vrrp'].includes((i.type||'').toLowerCase()))
            .map(i => ({ name: i.name, rows: 0, last_seen: null }));
          return res.json({ success: true, data: live, device_id: deviceId, source: 'live' });
        } catch (e) {
          // MikroTik tak terjangkau → kembalikan kosong saja
        }
      }

      res.json({ success: true, data, device_id: deviceId });
    } catch (error) {
      console.error('Error fetching bandwidth interfaces:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── CUSTOMER GROWTH CHART ───────────────────────────────────
  async customerGrowth(req, res) {
    try {
      const months = parseInt(req.query.months) || 12;
      const startDate = moment().subtract(months, 'months').startOf('month').toDate();

      // Query untuk mendapatkan customer growth per bulan
      const growth = await sequelize.query(`
        SELECT 
          DATE_FORMAT(created_at, '%Y-%m') as month,
          COUNT(*) as new_customers,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_customers,
          SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) as inactive_customers
        FROM customers
        WHERE created_at >= ?
        GROUP BY DATE_FORMAT(created_at, '%Y-%m')
        ORDER BY month ASC
      `, {
        replacements: [startDate],
        type: sequelize.QueryTypes.SELECT
      });

      // Calculate cumulative totals
      let cumulativeTotal = await Customer.count({
        where: { createdAt: { [Op.lt]: startDate } }
      });

      const growthWithCumulative = growth.map(row => {
        cumulativeTotal += parseInt(row.new_customers);
        return {
          month: row.month,
          new_customers: parseInt(row.new_customers),
          active_customers: parseInt(row.active_customers),
          inactive_customers: parseInt(row.inactive_customers),
          cumulative_total: cumulativeTotal
        };
      });

      // Current month stats
      const currentMonthNew = await Customer.count({
        where: {
          createdAt: {
            [Op.gte]: moment().startOf('month').toDate()
          }
        }
      });

      const totalActive = await Customer.count({ where: { status: 'active' } });
      const totalInactive = await Customer.count({ where: { status: 'inactive' } });
      const totalCustomers = await Customer.count();

      // Calculate growth rate
      const lastMonth = growthWithCumulative[growthWithCumulative.length - 2];
      const currentMonth = growthWithCumulative[growthWithCumulative.length - 1];
      const growthRate = lastMonth 
        ? (((currentMonth.cumulative_total - lastMonth.cumulative_total) / lastMonth.cumulative_total) * 100).toFixed(1)
        : 0;

      res.json({
        success: true,
        data: {
          summary: {
            total_customers: totalCustomers,
            active_customers: totalActive,
            inactive_customers: totalInactive,
            current_month_new: currentMonthNew,
            growth_rate: parseFloat(growthRate)
          },
          monthly_data: growthWithCumulative
        }
      });
    } catch (error) {
      console.error('Error fetching customer growth:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── DAFTAR PELANGGAN BARU PER BULAN ─────────────────────────
  // GET /api/dashboard/customer-growth-list?month=YYYY-MM
  // Kembalikan nama, ID, paket, dan tanggal aktivasi pelanggan yang
  // terdaftar/aktivasi pada bulan tsb. "Tanggal aktivasi" = installation_date
  // bila ada, jika tidak pakai created_at. Filter bulan berbasis created_at
  // (konsisten dgn hitungan pertumbuhan yang memakai created_at).
  async customerGrowthList(req, res) {
    try {
      const mParam = String(req.query.month || '').trim();
      const m = /^\d{4}-\d{2}$/.test(mParam) ? mParam : moment().format('YYYY-MM');
      const start = moment(m + '-01', 'YYYY-MM-DD').startOf('month').format('YYYY-MM-DD HH:mm:ss');
      const end   = moment(m + '-01', 'YYYY-MM-DD').endOf('month').format('YYYY-MM-DD HH:mm:ss');
      const limit = Math.min(parseInt(req.query.limit) || 100, 300);

      const rows = await sequelize.query(`
        SELECT
          c.id, c.customer_id, c.name, c.status,
          c.installation_date, c.created_at,
          p.name AS package_name, p.price AS package_price,
          p.speed_down AS package_speed
        FROM customers c
        LEFT JOIN packages p ON p.id = c.package_id
        WHERE c.created_at BETWEEN ? AND ?
        ORDER BY c.created_at ASC
        LIMIT ?
      `, {
        replacements: [start, end, limit],
        type: sequelize.QueryTypes.SELECT
      });

      const data = rows.map(r => ({
        id: r.id,
        customer_id: r.customer_id,
        name: r.name,
        status: r.status,
        package_name: r.package_name || null,
        package_price: r.package_price != null ? Number(r.package_price) : null,
        package_speed: r.package_speed != null ? Number(r.package_speed) : null,
        activation_date: r.installation_date || (r.created_at ? moment(r.created_at).format('YYYY-MM-DD') : null),
      }));

      res.json({ success: true, month: m, count: data.length, data });
    } catch (error) {
      console.error('Error fetching customer growth list:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── REVENUE FORECAST ────────────────────────────────────────
  async revenueForecast(req, res) {
    try {
      const months = parseInt(req.query.months) || 6;
      const startDate = moment().subtract(months, 'months').startOf('month').toDate();

      // Query untuk mendapatkan revenue historical
      const historical = await sequelize.query(`
        SELECT 
          DATE_FORMAT(payment_date, '%Y-%m') as month,
          SUM(amount) as total_revenue,
          COUNT(*) as payment_count,
          AVG(amount) as avg_payment
        FROM payments
        WHERE payment_date >= ?
        GROUP BY DATE_FORMAT(payment_date, '%Y-%m')
        ORDER BY month ASC
      `, {
        replacements: [startDate],
        type: sequelize.QueryTypes.SELECT
      });

      // Calculate forecast using simple linear regression
      const forecastMonths = 3; // Forecast untuk 3 bulan ke depan
      const revenueData = historical.map(h => parseFloat(h.total_revenue));
      
      // Simple moving average untuk forecast
      let forecast = [];
      if (revenueData.length >= 3) {
        const avgGrowth = revenueData.slice(-3).reduce((sum, val, idx, arr) => {
          if (idx === 0) return 0;
          return sum + ((val - arr[idx - 1]) / arr[idx - 1]);
        }, 0) / 2;

        let lastRevenue = revenueData[revenueData.length - 1];
        for (let i = 1; i <= forecastMonths; i++) {
          const forecastMonth = moment().add(i, 'months').format('YYYY-MM');
          const forecastRevenue = lastRevenue * (1 + avgGrowth);
          forecast.push({
            month: forecastMonth,
            forecasted_revenue: Math.round(forecastRevenue),
            is_forecast: true
          });
          lastRevenue = forecastRevenue;
        }
      }

      // Current month projection
      const currentMonthRevenue = await Payment.sum('amount', {
        where: {
          payment_date: {
            [Op.gte]: moment().startOf('month').toDate()
          }
        }
      }) || 0;

      // Expected monthly revenue from active customers
      const expectedRevenue = await sequelize.query(`
        SELECT SUM(p.price) as expected
        FROM customers c
        JOIN packages p ON c.package_id = p.id
        WHERE c.status = 'active'
      `, {
        type: sequelize.QueryTypes.SELECT
      });

      res.json({
        success: true,
        data: {
          summary: {
            current_month_revenue: currentMonthRevenue,
            expected_monthly_revenue: expectedRevenue[0]?.expected || 0,
            projection_accuracy: expectedRevenue[0]?.expected > 0 
              ? ((currentMonthRevenue / expectedRevenue[0].expected) * 100).toFixed(1)
              : 0
          },
          historical: historical.map(h => ({
            month: h.month,
            total_revenue: parseFloat(h.total_revenue),
            payment_count: parseInt(h.payment_count),
            avg_payment: parseFloat(h.avg_payment),
            is_forecast: false
          })),
          forecast: forecast
        }
      });
    } catch (error) {
      console.error('Error fetching revenue forecast:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── PANEL "PERLU PERHATIAN" (active alerts) ─────────────────
  // Menggabungkan 4 sumber kejadian penting: device offline, ONT baru putus,
  // pelanggan terisolir, dan tiket urgent/open. Diurutkan by severity & waktu.
  async alerts(req, res) {
    try {
      const alerts = [];

      // 1) Device offline (router/olt/switch/dll yang status offline)
      try {
        const devices = await Device.findAll({
          where: { is_active: true, status: 'offline' },
          attributes: ['id', 'name', 'type', 'ip_address', 'updatedAt'],
          limit: 20,
        });
        devices.forEach(d => alerts.push({
          kind: 'device_offline',
          severity: 'critical',
          icon: 'device',
          title: d.name || ('Device #' + d.id),
          detail: `${(d.type || 'device').toUpperCase()} • ${d.ip_address || '-'} tidak terjangkau`,
          time: d.updatedAt,
          link: '/devices',
        }));
      } catch (_) {}

      // 2) ONT offline (yang baru putus diutamakan via updatedAt)
      try {
        const onts = await OntDevice.findAll({
          where: { status: 'offline' },
          attributes: ['id', 'serial_number', 'name', 'updatedAt'],
          include: [{ model: Customer, as: 'customer', attributes: ['name', 'customer_id'], required: false }],
          order: [['updatedAt', 'DESC']],
          limit: 20,
        });
        onts.forEach(o => alerts.push({
          kind: 'ont_offline',
          severity: 'warning',
          icon: 'ont',
          title: (o.customer?.name) || o.name || o.serial_number || 'ONT',
          detail: `ONT offline${o.customer?.customer_id ? ' • ' + o.customer.customer_id : ''} • SN ${o.serial_number || '-'}`,
          time: o.updatedAt,
          link: '/ont-management',
        }));
      } catch (_) {}

      // 3) Pelanggan terisolir
      try {
        const isolated = await Customer.findAll({
          where: { [Op.or]: [{ status: 'isolated' }, { isolir_status: 'isolated' }] },
          attributes: ['id', 'customer_id', 'name', 'updatedAt'],
          order: [['updatedAt', 'DESC']],
          limit: 20,
        });
        isolated.forEach(c => alerts.push({
          kind: 'customer_isolated',
          severity: 'warning',
          icon: 'isolir',
          title: c.name || ('Customer #' + c.id),
          detail: `Pelanggan terisolir • ${c.customer_id || ''}`,
          time: c.updatedAt,
          link: '/customers/profile/' + c.id,
        }));
      } catch (_) {}

      // 4) Tiket urgent (critical/high) yang masih open/in_progress
      try {
        const tickets = await Ticket.findAll({
          where: {
            status: { [Op.in]: ['open', 'in_progress', 'pending'] },
            priority: { [Op.in]: ['critical', 'high'] },
          },
          attributes: ['id', 'title', 'priority', 'status', 'created_at'],
          order: [['created_at', 'DESC']],
          limit: 20,
        });
        tickets.forEach(t => alerts.push({
          kind: 'ticket_urgent',
          severity: t.priority === 'critical' ? 'critical' : 'warning',
          icon: 'ticket',
          title: t.title || ('Tiket #' + t.id),
          detail: `Tiket ${t.priority} • ${String(t.status).replace('_', ' ')}`,
          time: t.created_at,
          link: '/tickets/' + t.id,
        }));
      } catch (_) {}

      // Urutkan: critical dulu, lalu terbaru
      const sevRank = { critical: 0, warning: 1, info: 2 };
      alerts.sort((a, b) => {
        const s = (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3);
        if (s !== 0) return s;
        return new Date(b.time || 0) - new Date(a.time || 0);
      });

      const counts = {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        device_offline: alerts.filter(a => a.kind === 'device_offline').length,
        ont_offline: alerts.filter(a => a.kind === 'ont_offline').length,
        customer_isolated: alerts.filter(a => a.kind === 'customer_isolated').length,
        ticket_urgent: alerts.filter(a => a.kind === 'ticket_urgent').length,
      };

      res.json({ success: true, data: alerts.slice(0, 30), counts });
    } catch (error) {
      console.error('Error fetching dashboard alerts:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── PETA SEBARAN PELANGGAN + STATUS UP/DOWN ─────────────────
  // Customer berkoordinat + status online real-time. Online ditentukan dari
  // sesi PPPoE aktif (semua router): cocok via pppoe_username ATAU IP (address
  // sesi == static_ip). Marker: hijau=up, merah=down.
  async customerMapPoints(req, res) {
    try {
      const pointsOnly = req.query.points_only === '1' || req.query.points_only === 'true';

      // Cache 60 detik untuk mode FULL (dengan status online). Mode points_only
      // tidak pakai cache karena query DB-nya sudah cepat.
      const now = Date.now();
      if (!pointsOnly && _custMapCache.data && (now - _custMapCache.ts) < 60000) {
        return res.json(_custMapCache.data);
      }

      const { Device } = require('../models');

      const customers = await Customer.findAll({
        where: {
          status: 'active',
          latitude:  { [Op.ne]: null },
          longitude: { [Op.ne]: null },
        },
        attributes: ['id','customer_id','name','address','status','latitude','longitude','pppoe_username','static_ip','regency','district'],
      });

      // ── MODE CEPAT: hanya titik, tanpa cek PPPoE (online=null) ──
      // Dipakai frontend untuk render marker SEGERA, status menyusul via background.
      if (pointsOnly) {
        const quick = customers.map(c => ({
          id: c.id, customer_id: c.customer_id, name: c.name,
          address: c.address || '', regency: c.regency || '', district: c.district || '',
          latitude: Number(c.latitude), longitude: Number(c.longitude),
          online: null, // belum diketahui
        })).filter(c => !isNaN(c.latitude) && !isNaN(c.longitude));
        return res.json({ success: true, data: quick, total: quick.length, points_only: true });
      }

      // Kumpulkan sesi PPPoE aktif dari semua router (username + IP online)
      const onlineUsers = new Set();
      const onlineIps   = new Set();
      try {
        const devices = await Device.findAll({
          where: { type: 'router', is_active: true, api_username: { [Op.ne]: null } },
          attributes: ['id'],
        });
        const ids = devices.length ? devices.map(d => d.id) : [null];
        for (const devId of ids) {
          try {
            const mt = devId ? await getMikrotikInstanceByDevice(devId) : getMikrotikInstance();
            const sessions = await mt.getPPPoESessions();
            (sessions || []).forEach(s => {
              if (s.name)    onlineUsers.add(String(s.name).toLowerCase());
              if (s.address) onlineIps.add(String(s.address).trim());
            });
          } catch (_) { /* router offline → skip */ }
        }
      } catch (_) { /* abaikan, semua dianggap unknown/down */ }

      const data = customers.map(c => {
        let online = false;
        if (c.pppoe_username && onlineUsers.has(String(c.pppoe_username).toLowerCase())) online = true;
        else if (c.static_ip && onlineIps.has(String(c.static_ip).trim())) online = true;
        return {
          id: c.id,
          customer_id: c.customer_id,
          name: c.name,
          address: c.address || '',
          regency: c.regency || '',
          district: c.district || '',
          latitude:  Number(c.latitude),
          longitude: Number(c.longitude),
          online,
        };
      }).filter(c => !isNaN(c.latitude) && !isNaN(c.longitude));

      const up = data.filter(d => d.online).length;
      const payload = { success: true, data, total: data.length, up, down: data.length - up };
      _custMapCache = { ts: Date.now(), data: payload };
      res.json(payload);
    } catch (error) {
      console.error('Error fetching customer map points:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new DashboardController();