/**
 * NocController.js
 * ─────────────────────────────────────────────────────────────────
 * NOC Dashboard endpoints — DATA REAL dari MikroTik via API (binary
 * atau REST sesuai konfigurasi device). TIDAK menggunakan SNMP.
 *
 * Pattern mengikuti ResourceController & DeviceMonitorController:
 *   const mt = await getMikrotikInstanceByDevice(deviceId)
 *   const r  = await mt.getSystemResource()
 *
 * Endpoint:
 *   - GET /api/noc/overview                  → KPI aggregate dari DB
 *   - GET /api/noc/alerts                    → activity log + tickets
 *   - GET /api/noc/routers                   → list router untuk selector
 *   - GET /api/noc/router/:id/resource       → CPU/mem/uptime real-time
 *   - GET /api/noc/router/:id/realtime       → snapshot lengkap (cpu+pppoe+traffic)
 *   - GET /api/noc/router/:id/history?points → time-series dari ring buffer
 *   - GET /api/noc/ticket-stats              → breakdown tiket
 *
 * Ring buffer:
 *   Setiap call /realtime menyimpan snapshot ke in-memory buffer per
 *   router (max 60 entry). Buffer ini di-return /history untuk chart
 *   timeline tanpa polling berulang. Dihapus saat process restart.
 */
const { Op } = require('sequelize');
const {
  Customer, Device, InfrastructurePoint, Ticket, ActivityLog,
  NocMonitorPreset, sequelize
} = require('../models');
const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const logger = require('../utils/logger');
const dns = require('dns').promises;

// ═══ Reverse DNS cache ════════════════════════════════════════════
// PTR lookup bisa lambat (50-500ms) & IP yg sama sering muncul berulang,
// jadi di-cache. TTL 1 jam. Negative cache (IP tanpa PTR) juga disimpan
// supaya tidak retry terus.
const _dnsCache = new Map(); // ip → { host, exp }
const _DNS_TTL = 60 * 60 * 1000; // 1 jam

async function _reverseDnsCached(ip) {
  if (!ip) return null;
  const now = Date.now();
  const cached = _dnsCache.get(ip);
  if (cached && cached.exp > now) return cached.host;

  let host = null;
  try {
    // Timeout manual 1.5s — kalau PTR lambat, skip biar response tidak gantung
    const lookup = dns.reverse(ip);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 1500));
    const names = await Promise.race([lookup, timeout]);
    if (Array.isArray(names) && names.length) host = names[0];
  } catch (_) {
    host = null; // negative cache
  }
  _dnsCache.set(ip, { host, exp: now + _DNS_TTL });
  return host;
}


// ═══ Ring buffer per router ═══════════════════════════════════════
const _history = new Map();
const HISTORY_MAX = 60;
function _pushHistory(deviceId, sample) {
  if (!deviceId) return;
  const key = Number(deviceId);
  let arr = _history.get(key);
  if (!arr) { arr = []; _history.set(key, arr); }
  arr.push(sample);
  while (arr.length > HISTORY_MAX) arr.shift();
}
function _getHistory(deviceId) {
  return _history.get(Number(deviceId)) || [];
}

class NocController {

  /**
   * GET /api/noc/overview
   * Aggregate KPI dari DB.
   */
  async overview(req, res) {
    try {
      const custTotal     = await Customer.count().catch(() => 0);
      const custActive    = await Customer.count({ where:{ status:'active' } }).catch(() => 0);
      const custIsolated  = await Customer.count({ where:{ isolir_status:'isolated' } }).catch(() => 0);
      const custSuspended = await Customer.count({ where:{ status:'suspended' } }).catch(() => 0);

      let deviceTotal = 0, deviceOnline = 0, deviceOffline = 0;
      try {
        deviceTotal   = await Device.count();
        deviceOnline  = await Device.count({ where:{ status:'online' } });
        deviceOffline = deviceTotal - deviceOnline;
      } catch (_) {}

      let infraTotal = 0;
      try { infraTotal = await InfrastructurePoint.count(); } catch (_) {}

      let openTickets = 0;
      try {
        openTickets = await Ticket.count({
          where:{ status:{ [Op.in]:['open','in_progress'] } }
        });
      } catch (_) {}

      let ontTotal = 0, ontOnline = 0, ontOffline = 0;
      try {
        const GenieAcsService = require('../services/GenieacsService');
        if (GenieAcsService && typeof GenieAcsService.getStats === 'function') {
          const s = await GenieAcsService.getStats();
          ontTotal   = parseInt(s?.total   || 0);
          ontOnline  = parseInt(s?.online  || 0);
          ontOffline = parseInt(s?.offline || 0);
        }
      } catch (_) {}

      res.json({
        success:true,
        data:{
          timestamp: new Date().toISOString(),
          customers:      { total:custTotal, active:custActive, isolated:custIsolated, suspended:custSuspended },
          devices:        { total:deviceTotal, online:deviceOnline, offline:deviceOffline },
          ont:            { total:ontTotal, online:ontOnline, offline:ontOffline, health_pct: ontTotal > 0 ? Math.round((ontOnline/ontTotal)*1000)/10 : 0 },
          infrastructure: { total:infraTotal },
          tickets:        { open:openTickets },
        }
      });
    } catch (e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  /**
   * GET /api/noc/alerts?limit=20
   * Live alerts dari NocAlertsService (in-memory cache).
   * Hanya track 3 kategori:
   *   - Device (router) Up/Down
   *   - Resources CPU/RAM overload
   *   - PPPoE session mass disconnect/connect
   * History disimpan di memory, retention 24 jam, hilang saat pm2 restart.
   */
  async alerts(req, res) {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const NocAlertsService = require('../services/NocAlertsService');
      const events = NocAlertsService.getRecent(limit);

      // Transform supaya kompatibel dengan format yang frontend harapkan
      const items = events.map(ev => ({
        id: ev.id,
        type: ev.category,        // 'device_status' | 'resource_cpu' | 'resource_ram' | 'pppoe_drop' | 'pppoe_up'
        severity: ev.severity,    // 'danger' | 'warning' | 'success' | 'info'
        title: ev.title,
        detail: ev.detail,
        description: ev.detail,   // alias untuk backward compat dengan frontend
        action: ev.category,
        module: 'noc',
        target_type: 'router',
        target_id: ev.router_id,
        router_name: ev.router_name,
        created_at: ev.timestamp,
      }));

      res.json({ success: true, data: items });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/noc/alerts/debug
   * Snapshot internal NocAlertsService — untuk troubleshoot kenapa alert
   * tidak muncul. Return state semua router yang di-poll, threshold,
   * last poll timestamp, dan 10 event terakhir.
   */
  async alertsDebug(req, res) {
    try {
      const NocAlertsService = require('../services/NocAlertsService');
      const snapshot = NocAlertsService.getDebugSnapshot();
      res.json({ success: true, data: snapshot });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * DELETE /api/noc/alerts
   * Clear semua event/alert dari in-memory log NocAlertsService.
   * Berguna kalau ada accumulation alert lama yg sudah tidak relevan.
   * State router (online/offline) TIDAK direset, jadi tidak akan trigger
   * ulang alert yg sama setelah clear.
   */
  async clearAlerts(req, res) {
    try {
      const NocAlertsService = require('../services/NocAlertsService');
      const removed = NocAlertsService.clearAll();
      res.json({ success: true, removed, message: `${removed} alert dihapus dari log` });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/noc/routers
   * List router untuk selector dropdown.
   */
  async routers(req, res) {
    try {
      const baseAttrs = ['id','name','ip_address','api_port','api_protocol','is_active','status'];
      let hasIsPrimary = false;
      try {
        await Device.findOne({ where:{ is_primary:true }, attributes:['id'] });
        hasIsPrimary = true;
      } catch (_) {}

      let rows = [];
      try {
        rows = await Device.findAll({
          where:{ type:'router', is_active:true },
          attributes: hasIsPrimary ? [...baseAttrs, 'is_primary'] : baseAttrs,
          order: hasIsPrimary
            ? [['is_primary','DESC'], ['name','ASC']]
            : [['name','ASC']],
        });
      } catch (_) {
        // Fallback kalau kolom 'type' tidak ada
        rows = await Device.findAll({
          where:{ is_active:true },
          attributes: baseAttrs,
          order:[['name','ASC']]
        });
      }

      res.json({
        success:true,
        data: rows.map(r => ({
          id:           r.id,
          name:         r.name,
          ip_address:   r.ip_address,
          api_port:     r.api_port,
          api_protocol: r.api_protocol,
          status:       r.status,
          is_primary:   r.is_primary || false,
        }))
      });
    } catch (e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  /**
   * GET /api/noc/router/:id/resource
   */
  async routerResource(req, res) {
    try {
      const deviceId = parseInt(req.params.id);
      if (!deviceId) return res.status(400).json({ success:false, message:'router id wajib' });

      const mt = await getMikrotikInstanceByDevice(deviceId);
      const [resource, identity] = await Promise.all([
        mt.getSystemResource(),
        mt.getSystemIdentity().catch(() => ({}))
      ]);

      const memUsed = (resource.totalMemory || 0) - (resource.freeMemory || 0);
      const memPct  = resource.totalMemory > 0
        ? Math.round((memUsed / resource.totalMemory) * 1000) / 10
        : 0;

      res.json({
        success:true,
        data:{
          identity:    identity.name || identity.identity || 'MikroTik',
          version:     resource.version,
          board:       resource.boardName,
          platform:    resource.platform,
          uptime:      resource.uptime,
          cpuLoad:     resource.cpuLoad,
          memoryTotal: resource.totalMemory,
          memoryFree:  resource.freeMemory,
          memoryUsed:  memUsed,
          memoryPct:   memPct,
        }
      });
    } catch (e) {
      logger.error('[NocController.routerResource]', e.message);
      res.status(500).json({ success:false, message:'Gagal ambil resource: ' + e.message });
    }
  }

  /**
   * GET /api/noc/router/:id/realtime
   * Snapshot lengkap: resource + PPPoE + traffic. Disimpan ke ring buffer.
   * Per-interface stats juga disimpan, supaya history bisa di-filter per
   * interface dari frontend tanpa polling baru.
   */
  async routerRealtime(req, res) {
    try {
      const deviceId = parseInt(req.params.id);
      if (!deviceId) return res.status(400).json({ success:false, message:'router id wajib' });

      const mt = await getMikrotikInstanceByDevice(deviceId);

      // Parallel fetch supaya cepat
      const [resource, identity, pppoe, ifaces] = await Promise.all([
        mt.getSystemResource(),
        mt.getSystemIdentity().catch(() => ({})),
        mt.getPPPoESessions().catch(() => []),
        mt.getInterfaces().catch(() => [])
      ]);

      const memUsed = (resource.totalMemory || 0) - (resource.freeMemory || 0);
      const memPct  = resource.totalMemory > 0
        ? Math.round((memUsed / resource.totalMemory) * 1000) / 10
        : 0;

      // Total traffic dari interface ether/sfp/wlan yang running, skip virtual
      // (pppoe-out, vlan, bridge) supaya tidak double-count pada AGREGAT total.
      const physicalRunning = ifaces.filter(i =>
        i.running && !i.disabled && /^(ether|sfp|wlan)/i.test(i.type || '')
      );
      const physicalNames = physicalRunning.slice(0, 16).map(i => i.name);

      // Interface "extra" yang dipantau lewat monitor preset tapi BUKAN fisik
      // (mis. VLAN, bridge, pppoe). Ini perlu di-sample juga supaya per-interface
      // stats-nya tersedia, TAPI tidak ikut dijumlahkan ke total agregat.
      let extraNames = [];
      try {
        const presets = await NocMonitorPreset.findAll({
          where: { router_id: deviceId },
          attributes: ['ifaces']
        });
        const wanted = new Set();
        for (const p of presets) {
          for (const nm of (p.ifaces || [])) wanted.add(nm);
        }
        // Hanya yang benar-benar ada di router, running, dan belum termasuk fisik
        const physSet = new Set(physicalNames);
        extraNames = ifaces
          .filter(i => wanted.has(i.name) && !physSet.has(i.name) && i.running && !i.disabled)
          .map(i => i.name)
          .slice(0, 16);
      } catch (_) { /* abaikan — fallback ke fisik saja */ }

      // Gabungan untuk di-sample (unik). Fisik untuk total, extra untuk per-iface.
      const sampleIfaces = [...physicalNames, ...extraNames];
      const physSetFinal = new Set(physicalNames);
      let totalRxBps = 0, totalTxBps = 0;
      const perIface = {}; // { name: { rxMbps, txMbps } }
      if (sampleIfaces.length) {
        try {
          const stats = await mt.getInterfacesBulkStats(sampleIfaces);
          for (const s of stats) {
            const rx = s.rxBitsPerSecond || 0;
            const tx = s.txBitsPerSecond || 0;
            // Hanya interface fisik yang masuk ke total agregat (hindari double-count)
            if (physSetFinal.has(s.name)) {
              totalRxBps += rx;
              totalTxBps += tx;
            }
            perIface[s.name] = {
              rxMbps: Math.round((rx / 1e6) * 100) / 100,
              txMbps: Math.round((tx / 1e6) * 100) / 100,
            };
          }
        } catch (_) {}
      }
      const rxMbps = Math.round((totalRxBps / 1e6) * 100) / 100;
      const txMbps = Math.round((totalTxBps / 1e6) * 100) / 100;

      const ts = Date.now();
      _pushHistory(deviceId, {
        ts,
        cpu:    resource.cpuLoad || 0,
        memPct,
        pppoe:  pppoe.length,
        rxMbps, txMbps,
        perIface, // ← per-interface stats untuk filter di history
      });

      res.json({
        success:true,
        data:{
          timestamp: ts,
          identity:  identity.name || identity.identity || 'MikroTik',
          uptime:    resource.uptime,
          version:   resource.version,
          board:     resource.boardName,
          cpu:       resource.cpuLoad || 0,
          memoryTotal: resource.totalMemory,
          memoryFree:  resource.freeMemory,
          memoryUsed:  memUsed,
          memoryPct:   memPct,
          pppoeActive: pppoe.length,
          interfacesTotal:   ifaces.length,
          interfacesRunning: physicalRunning.length,
          interfacesSampled: sampleIfaces.length,
          totalRxMbps: rxMbps,
          totalTxMbps: txMbps,
          perIface, // current snapshot per interface
        }
      });
    } catch (e) {
      logger.error('[NocController.routerRealtime]', e.message);
      res.status(500).json({ success:false, message:'Gagal koneksi router: ' + e.message });
    }
  }

  /**
   * GET /api/noc/router/:id/interfaces
   * List interface fisik untuk selector (ether/sfp/wlan).
   * Comment di-include supaya user bisa identify (mis. "ether1-WAN").
   */
  /**
   * GET /api/noc/router/:id/top-destinations?limit=15
   * Top destination IP yang paling banyak traffic-nya, dari connection tracking
   * MikroTik (/ip/firewall/connection). Disertai reverse DNS (PTR) supaya IP
   * diterjemahkan ke hostname (mis. 142.250.x.x → *.1e100.net / google).
   *
   * Snapshot real-time — bytes adalah akumulasi per koneksi aktif saat ini.
   */
  async routerTopDestinations(req, res) {
    try {
      const deviceId = parseInt(req.params.id);
      if (!deviceId) return res.status(400).json({ success:false, message:'router id wajib' });
      const limit = Math.min(parseInt(req.query.limit) || 15, 50);

      const mt = await getMikrotikInstanceByDevice(deviceId);
      const result = await mt.getTopConnections({ limit, excludeLocal: true });

      if (!result.available) {
        return res.json({
          success: true,
          available: false,
          message: 'Connection tracking tidak tersedia di router ini',
          data: [],
        });
      }

      // Reverse DNS untuk tiap IP (paralel, dgn cache + timeout per lookup).
      const enriched = await Promise.all(result.data.map(async (item) => {
        const host = await _reverseDnsCached(item.dst);
        return { ...item, hostname: host || null };
      }));

      res.json({
        success: true,
        available: true,
        totalConnections: result.totalConnections,
        data: enriched,
      });
    } catch (e) {
      logger.error('[NocController.routerTopDestinations]', e.message);
      res.status(500).json({ success:false, message:'Gagal ambil top destinations: ' + e.message });
    }
  }

  /**
   * GET /api/noc/router/:id/traffic-summary
   * Summary agregat traffic per Provider/CDN + per Kategori, dari connection
   * tracking router. IP dicocokkan ke blok CIDR provider besar (Google, Meta,
   * Cloudflare, Netflix, dll) via IpProviderClassifier.
   *
   * Snapshot real-time — proporsi berdasarkan akumulasi bytes koneksi aktif.
   */
  async routerTrafficSummary(req, res) {
    try {
      const deviceId = parseInt(req.params.id);
      if (!deviceId) return res.status(400).json({ success:false, message:'router id wajib' });

      const mt = await getMikrotikInstanceByDevice(deviceId);
      // limit besar supaya ambil hampir semua koneksi untuk agregasi summary
      const result = await mt.getTopConnections({ limit: 5000, excludeLocal: true });

      if (!result.available) {
        return res.json({
          success: true, available: false,
          message: 'Connection tracking tidak tersedia di router ini',
          providers: [], categories: [],
        });
      }

      const { summarize, aggregateByDomain } = require('../services/IpProviderClassifier');
      // Pakai allAgg (semua IP) bukan data (top-N) supaya summary akurat
      const allAgg = result.allAgg || result.data || [];
      const summary = summarize(allAgg);

      // "Web" tab: petakan IP → domain via DNS cache router, lalu agregasi
      // per registrable-domain. Hanya terisi jika router jadi DNS resolver klien.
      let webDomains = [];
      try {
        const dnsCache = await mt.getDnsCache();
        const web = aggregateByDomain(allAgg, dnsCache);
        webDomains = web.domains.slice(0, 15); // top 15 domain
      } catch (_) { /* DNS cache tidak tersedia → web kosong */ }

      res.json({
        success: true, available: true,
        totalConnections: result.totalConnections,
        ...summary,
        web: webDomains,
      });
    } catch (e) {
      logger.error('[NocController.routerTrafficSummary]', e.message);
      res.status(500).json({ success:false, message:'Gagal ambil traffic summary: ' + e.message });
    }
  }

  async routerInterfaces(req, res) {
    try {
      const deviceId = parseInt(req.params.id);
      if (!deviceId) return res.status(400).json({ success:false, message:'router id wajib' });

      const mt = await getMikrotikInstanceByDevice(deviceId);
      const ifaces = await mt.getInterfaces();

      const filtered = (ifaces || [])
        .filter(i => /^(ether|sfp|wlan|bridge|vlan)/i.test(i.type || ''))
        .map(i => ({
          name:    i.name,
          type:    i.type,
          comment: i.comment || '',
          running: !!i.running,
          disabled:!!i.disabled,
          macAddress: i.macAddress,
        }));

      res.json({ success:true, data: filtered });
    } catch (e) {
      logger.error('[NocController.routerInterfaces]', e.message);
      res.status(500).json({ success:false, message:'Gagal ambil interface: ' + e.message });
    }
  }

  /**
   * GET /api/noc/router/:id/history?points=N&ifaces=ether1,sfp1
   * Return time-series dari ring buffer.
   * - Tanpa `ifaces` → bandwidth = total (semua interface fisik dijumlah)
   * - Dengan `ifaces` → bandwidth = sum hanya interface yang dipilih
   *   per setiap sample point.
   */
  async routerHistory(req, res) {
    try {
      const deviceId = parseInt(req.params.id);
      if (!deviceId) return res.status(400).json({ success:false, message:'router id wajib' });

      const N = Math.min(parseInt(req.query.points) || HISTORY_MAX, HISTORY_MAX);
      const buf = _getHistory(deviceId);
      const slice = buf.slice(-N);

      // Parse filter ifaces (comma-separated). Empty / '*' → semua.
      const raw = (req.query.ifaces || '').trim();
      const selected = (raw && raw !== '*')
        ? raw.split(',').map(s => s.trim()).filter(Boolean)
        : null;

      // Hitung rx/tx per sample: kalau ada filter, sum dari sample.perIface
      // hanya untuk iface yang dipilih. Kalau tidak, pakai total agregat.
      function pickBandwidth(sample) {
        if (!selected) return { rx:sample.rxMbps || 0, tx:sample.txMbps || 0 };
        const pi = sample.perIface || {};
        let rx = 0, tx = 0;
        for (const name of selected) {
          if (pi[name]) {
            rx += pi[name].rxMbps || 0;
            tx += pi[name].txMbps || 0;
          }
        }
        return {
          rx: Math.round(rx * 100) / 100,
          tx: Math.round(tx * 100) / 100,
        };
      }

      const series = {
        cpu:     slice.map(s => ({ x:s.ts, y:s.cpu     })),
        mem:     slice.map(s => ({ x:s.ts, y:s.memPct  })),
        pppoe:   slice.map(s => ({ x:s.ts, y:s.pppoe   })),
        rx_mbps: slice.map(s => ({ x:s.ts, y:pickBandwidth(s).rx })),
        tx_mbps: slice.map(s => ({ x:s.ts, y:pickBandwidth(s).tx })),
      };
      res.json({
        success:true,
        data:series,
        points: slice.length,
        capacity: HISTORY_MAX,
        selected_ifaces: selected || [],
      });
    } catch (e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  /**
   * GET /api/noc/ticket-stats
   */
  async ticketStats(req, res) {
    try {
      let stats = { byStatus:{}, byPriority:{}, recent:[], total:0 };
      try {
        // Field yang ada di schema (lihat Ticket.js): ticket_number, type,
        // priority, status, title, description, dll. Tidak ada 'subject'.
        const all = await Ticket.findAll({
          attributes:['id','ticket_number','title','status','priority','type','createdAt','updatedAt'],
          order:[['createdAt','DESC']], limit:200
        });
        stats.total = all.length;
        for (const t of all) {
          const s = (t.status   || 'unknown').toLowerCase();
          const p = (t.priority || 'medium').toLowerCase();
          stats.byStatus[s]   = (stats.byStatus[s]   || 0) + 1;
          stats.byPriority[p] = (stats.byPriority[p] || 0) + 1;
        }
        stats.recent = all.slice(0, 8).map(t => ({
          id: t.id,
          ticket_number: t.ticket_number,
          title:    t.title,
          status:   t.status,
          priority: t.priority,
          type:     t.type,
          created_at: t.createdAt,
          updated_at: t.updatedAt,
        }));
      } catch (err) {
        // Log error supaya gampang debug — sebelumnya silent fail yang
        // bikin section ticket tampak kosong padahal sebenarnya error
        // query.
        logger.error('[NocController.ticketStats] Query failed: ' + (err.message || err));
      }
      res.json({ success:true, data:stats });
    } catch (e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ═══ NOC MONITOR PRESETS (bandwidth-chart cards) ═══════════════
  //
  // Setiap user bisa create multiple "monitor card" yang menampilkan
  // bandwidth chart untuk kombinasi interface tertentu per router.
  // Mis. "WAN 1", "WAN 2", "Distribusi". State tersimpan di DB jadi
  // persist antar session & antar device.

  /**
   * GET /api/noc/monitors
   * List semua preset milik user yang sedang login, sorted by position.
   */
  async listMonitors(req, res) {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ success:false, message:'Auth required' });

      const rows = await NocMonitorPreset.findAll({
        where: { user_id: userId },
        order: [['position','ASC'], ['id','ASC']],
        include: [{ model: Device, as: 'router', attributes:['id','name','ip_address'] }]
      });
      // Di MySQL, kolom DataTypes.JSON kadang dikembalikan sebagai STRING mentah
      // (mis. '["ether1","sfp1"]') alih-alih array — tergantung versi mysql2 &
      // cara tabel dibuat. Normalisasi di sini supaya UI selalu dapat array.
      const normIfaces = (v) => {
        if (Array.isArray(v)) return v;
        if (typeof v === 'string' && v.trim()) {
          try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; }
          catch (_) { return v.split(',').map(s => s.trim()).filter(Boolean); }
        }
        return [];
      };
      res.json({
        success:true,
        data: rows.map(r => ({
          id:       r.id,
          name:     r.name,
          router:   r.router ? { id:r.router.id, name:r.router.name, ip:r.router.ip_address } : null,
          router_id: r.router_id,
          ifaces:   normIfaces(r.ifaces),
          color:    r.color || '#3b82f6',
          position: r.position,
        }))
      });
    } catch (e) {
      logger.error('[NocController.listMonitors] ' + e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  /**
   * POST /api/noc/monitors
   * Body: { name, router_id, ifaces:[], color? }
   */
  async createMonitor(req, res) {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ success:false, message:'Auth required' });

      const { name, router_id, ifaces, color } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ success:false, message:'Nama monitor wajib diisi' });
      }
      if (!router_id) {
        return res.status(400).json({ success:false, message:'Router wajib dipilih' });
      }
      if (!Array.isArray(ifaces) || !ifaces.length) {
        return res.status(400).json({ success:false, message:'Pilih minimal 1 interface' });
      }

      // Position = max(existing) + 1 supaya muncul di akhir
      const maxPos = await NocMonitorPreset.max('position', { where:{ user_id:userId } }) || 0;

      const row = await NocMonitorPreset.create({
        user_id:   userId,
        router_id: parseInt(router_id),
        name:      String(name).trim().slice(0, 80),
        ifaces:    ifaces.map(s => String(s).slice(0, 64)).slice(0, 32),
        color:     color || '#3b82f6',
        position:  maxPos + 1,
      });

      res.json({
        success:true,
        data:{
          id: row.id, name: row.name, router_id: row.router_id,
          ifaces: row.ifaces, color: row.color, position: row.position,
        }
      });
    } catch (e) {
      logger.error('[NocController.createMonitor] ' + e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  /**
   * PATCH /api/noc/monitors/:id
   * Body: any of { name, router_id, ifaces, color, position }
   * Hanya owner yang boleh update.
   */
  async updateMonitor(req, res) {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ success:false, message:'Auth required' });

      const id = parseInt(req.params.id);
      const row = await NocMonitorPreset.findOne({ where:{ id, user_id:userId } });
      if (!row) return res.status(404).json({ success:false, message:'Monitor tidak ditemukan' });

      const updates = {};
      if (req.body.name !== undefined)      updates.name      = String(req.body.name).trim().slice(0, 80);
      if (req.body.router_id !== undefined) updates.router_id = parseInt(req.body.router_id);
      if (req.body.color !== undefined)     updates.color     = String(req.body.color).slice(0, 20);
      if (req.body.position !== undefined)  updates.position  = parseInt(req.body.position) || 0;
      if (Array.isArray(req.body.ifaces)) {
        updates.ifaces = req.body.ifaces.map(s => String(s).slice(0, 64)).slice(0, 32);
      }

      await row.update(updates);
      res.json({ success:true, data: { id:row.id, ...updates } });
    } catch (e) {
      logger.error('[NocController.updateMonitor] ' + e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  /**
   * DELETE /api/noc/monitors/:id
   */
  async deleteMonitor(req, res) {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ success:false, message:'Auth required' });

      const id = parseInt(req.params.id);
      const row = await NocMonitorPreset.findOne({ where:{ id, user_id:userId } });
      if (!row) return res.status(404).json({ success:false, message:'Monitor tidak ditemukan' });

      await row.destroy();
      res.json({ success:true });
    } catch (e) {
      logger.error('[NocController.deleteMonitor] ' + e.message);
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ─── PPPoE Username → Customer Name Mapping ────────────────────
  // Endpoint lightweight untuk join data PPPoE sessions/secrets dengan
  // customer name. Frontend cache hasil ini di memory, refresh setiap
  // beberapa menit (data jarang berubah).
  //
  // Response shape:
  //   { success: true, data: { "username1": "Nama Customer 1", ... } }
  //
  // Hanya return customer yang punya pppoe_username (non-null & non-empty).
  // Username di-lowercase untuk konsisten dengan match di frontend.
  //
  // Performance: server-side cache 60 detik. Data customer jarang berubah,
  // tapi endpoint ini sering di-hit (NOC dashboard refresh tiap 10s). Cache
  // membatasi DB query jadi 1x per menit, bukan tiap call.
  async pppoeCustomerMap(req, res) {
    try {
      // Cek cache: kalau masih fresh (<60s), serve langsung
      const now = Date.now();
      if (NocController._pppoeMapCache && (now - NocController._pppoeMapAt) < 60000) {
        res.set('Cache-Control', 'no-store');
        return res.json({
          success: true,
          data: NocController._pppoeMapCache,
          total: NocController._pppoeMapTotal,
          cached: true,
        });
      }

      const rows = await Customer.findAll({
        attributes: ['pppoe_username', 'name'],
        where: {
          pppoe_username: { [Op.and]: [
            { [Op.ne]: null },
            { [Op.ne]: '' },
          ] }
        },
        raw: true,
      });
      const map = {};
      for (const r of rows) {
        const u = String(r.pppoe_username || '').toLowerCase().trim();
        if (u) map[u] = r.name || '';
      }
      // Update cache
      NocController._pppoeMapCache = map;
      NocController._pppoeMapTotal = rows.length;
      NocController._pppoeMapAt    = now;

      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: map, total: rows.length });
    } catch (e) {
      logger.error('[NocController.pppoeCustomerMap] ' + e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

// Static cache untuk pppoeCustomerMap (1 instance per process)
NocController._pppoeMapCache = null;
NocController._pppoeMapTotal = 0;
NocController._pppoeMapAt    = 0;

function _inferSeverity(action, desc) {
  const a = String(action || '').toLowerCase();
  const d = String(desc   || '').toLowerCase();
  if (/down|offline|fail|error|disconnect|critical|crash/.test(a + ' ' + d)) return 'danger';
  if (/warn|slow|degrade|retry/.test(a + ' ' + d)) return 'warning';
  if (/restore|recover|up|online|connect/.test(a + ' ' + d)) return 'success';
  return 'info';
}

module.exports = new NocController();
