'use strict';

/**
 * CustomerTrafficPoller.js
 * ────────────────────────────────────────────────────────────────────────
 * Poller TERPUSAT untuk status & traffic pelanggan (MikroTik).
 *
 * LATAR: Sebelumnya tiap browser yang membuka halaman /infrastructure
 * menjalankan setInterval(fetch /api/mikrotik/customer-traffic, 2000ms).
 * Akibatnya beban ke router MikroTik berlipat sebanyak jumlah admin yang
 * sedang membuka dashboard (query queue + PPPoE + ARP + DHCP + ping × N).
 *
 * SOLUSI: Satu poller di backend menjalankan computeSnapshot() sekali tiap
 * interval, menyimpan hasil di memori (snapshot), lalu mem-broadcast ke
 * semua admin lewat Socket.IO (room "traffic_monitoring"). Beban ke router
 * kini KONSTAN (×1) berapa pun jumlah admin yang membuka halaman.
 *
 * Poller hanya AKTIF saat ada minimal 1 subscriber (admin membuka halaman).
 * Saat tidak ada yang melihat, poller berhenti — menghemat router.
 *
 * Snapshot disimpan di memori saja (hilang saat restart) — saat start ulang,
 * poll pertama mengisinya kembali dalam <interval> detik.
 *
 * Logika computeSnapshot() di bawah dipindahkan PERSIS dari endpoint lama
 * /api/mikrotik/customer-traffic (termasuk deteksi online berbasis ping yang
 * authoritative untuk customer ber-IP — lihat catatan MAC/IP binding).
 */

const logger = require('../utils/logger');

// ── Konfigurasi ────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 2000; // selaras dengan kebutuhan real-time frontend
// Saat tidak ada admin yang melihat (idle), poller tetap jalan tapi pelan
// (keep-warm) supaya snapshot selalu fresh & status online siap seketika
// ketika halaman dibuka lagi — tanpa membebani router.
const IDLE_POLL_INTERVAL_MS = 30000; // 30 detik saat idle

// Cache hasil ping per-IP (TTL pendek). Ping kini AUTHORITATIVE untuk
// customer ber-IP, jadi TTL dipersingkat supaya perubahan status cepat
// terlihat. 6 detik = 3 poll: cukup tahan beban router, tetap real-time.
// ── Cache & state deteksi online (anti-flapping) ───────────────────────
// _pingCache: hasil ping mentah per IP { online, ts }.
//   TTL dinaikkan ke 30 detik supaya bila siklus ini IP belum sempat diping
//   (karena cap per-poll), status terakhir masih dipakai — bukan langsung
//   dianggap offline. Ini kunci menghilangkan fluktuasi angka online.
const _pingCache = new Map();
const PING_TTL_MS = 30000; // 30 detik (sebelumnya 6s → bikin flapping)

// _statusState: status TERKONFIRMASI per customer + streak untuk histeresis.
//   { online: bool|null, upStreak: n, downStreak: n, ts }
//   - Offline→Online butuh ONLINE_CONFIRM hit berturut (cepat naik, 1 cukup).
//   - Online→Offline butuh OFFLINE_CONFIRM hit berturut (lambat turun → tahan
//     packet loss & ping yang belum sempat jalan). Ini mencegah flapping.
const _statusState = new Map();
const ONLINE_CONFIRM  = 1; // 1 bukti online → langsung hijau (responsif)
const OFFLINE_CONFIRM = 3; // 3x berturut baru merah (tahan glitch/packet loss)
// Bila tidak ada sinyal sama sekali dalam STALE_OFFLINE_MS, baru paksa offline
// walau streak belum tercapai (mencegah "online abadi" untuk modem yang sudah
// lama mati tapi kebetulan tidak pernah masuk batch ping).
const STALE_OFFLINE_MS = 180000; // 180 detik tanpa konfirmasi online → offline
                                 // (dinaikkan dari 90s: dengan ribuan IP & ping
                                 //  round-robin, satu IP bisa wajar baru diping
                                 //  ulang >90s. 180s cegah false-offline berkala.)

// ── State internal ─────────────────────────────────────────────────────
let _io            = null;   // instance Socket.IO
let _timer         = null;   // handle setInterval (mode aktif, cepat)
let _idleTimer     = null;   // handle setInterval (mode idle, lambat/keep-warm)
let _running       = false;  // true jika poll() sedang berjalan (re-entrancy lock)
let _subscribers   = 0;      // jumlah admin yang sedang subscribe
let _lastSnapshot  = null;   // { data, meta } hasil poll terakhir
let _lastError     = null;

/**
 * computeSnapshot(opts) — query MikroTik & susun status semua customer.
 * opts: { explicitDeviceId?:number|null, pingEnabled?:boolean, debug?:boolean }
 * return: { success, data, meta, debug? }   (sama persis dgn payload endpoint lama)
 */
async function computeSnapshot(opts = {}) {
  try {
    const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
    const { Customer, Package }   = require('../models');
    // Pakai device resolver yang sama dengan halaman /monitoring/queue:
    //   - eksplisit deviceId via ?device_id atau header X-Device-Id
    //   - auto-pick is_primary=true → router pertama aktif → fallback ke .env default
    // Penting agar instance MikroTik (host/credential) selalu sinkron dengan tabel
    // `devices` di DB. Sebelumnya pakai getMikrotikInstance() singleton yang hanya
    // baca env, sehingga setelah restart server kadang nge-target host yang salah
    // padahal halaman queue tetap jalan.
    // ── Tentukan router yang akan di-query ──────────────────────────
    // Kalau ?device_id / X-Device-Id diisi → hanya router itu.
    // Kalau TIDAK → query SEMUA router aktif lalu gabung hasilnya. Ini penting
    // supaya pelanggan (terutama yang pakai IP STATIS) yang dilayani router
    // selain primary tetap terdeteksi online & traffic-nya terbaca. Sebelumnya
    // endpoint hanya query 1 router (auto-pick primary), sehingga static IP di
    // router lain selalu tampil OFFLINE.
    const explicitDeviceId = (() => {
      const v = opts.explicitDeviceId;
      if (v == null || v === '') return null;
      const n = parseInt(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    let deviceIds = [];
    if (explicitDeviceId) {
      deviceIds = [explicitDeviceId];
    } else {
      try {
        const { Device } = require('../models');
        const routers = await Device.findAll({
          where: { type: 'router', is_active: true },
          attributes: ['id'],
          order: [['id', 'ASC']],
          raw: true
        });
        deviceIds = routers.map(r => r.id);
      } catch (_) { /* skema lama / tabel tidak ada */ }
    }
    // Fallback: kalau tidak ada device terdaftar, pakai resolver default (null → .env).
    if (!deviceIds.length) deviceIds = [null];

    // Ambil + index data dari SATU router. Mengembalikan instance (untuk ping)
    // beserta map lookup. Dipakai berulang per-router lalu hasilnya digabung.
    const fetchRouter = async (devId) => {
      const inst = await getMikrotikInstanceByDevice(devId);
      const [q, s, a, d] = await Promise.allSettled([
        inst.getQueues(),
        inst.getPPPoESessions(),
        inst.get('/ip/arp'),
        inst.get('/ip/dhcp-server/lease')
      ]);
      const errs = {};
      if (q.status === 'rejected') errs.queues   = q.reason?.message || String(q.reason);
      if (s.status === 'rejected') errs.sessions = s.reason?.message || String(s.reason);
      if (a.status === 'rejected') errs.arp      = a.reason?.message || String(a.reason);
      if (d.status === 'rejected') errs.dhcp     = d.reason?.message || String(d.reason);
      return {
        inst,
        host: inst.host,
        queues:   q.status === 'fulfilled' ? (q.value || []) : [],
        sessions: s.status === 'fulfilled' ? (s.value || []) : [],
        arp:      a.status === 'fulfilled' ? (Array.isArray(a.value) ? a.value : []) : [],
        dhcp:     d.status === 'fulfilled' ? (Array.isArray(d.value) ? d.value : []) : [],
        errs
      };
    };

    const routerResults = await Promise.allSettled(deviceIds.map(fetchRouter));
    const routers = routerResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    // Instance untuk ping: pakai router pertama yang sukses (cukup untuk fallback).
    const mt = routers[0]?.inst || await getMikrotikInstanceByDevice(explicitDeviceId);
    // Daftar instance untuk ping multi-router (static IP bisa di router mana saja).
    const pingInstances = routers.map(r => r.inst).filter(Boolean);

    // Gabungkan semua data dari seluruh router.
    const queueData   = routers.flatMap(r => r.queues);
    const sessionData = routers.flatMap(r => r.sessions);
    const arpData     = routers.flatMap(r => r.arp);
    const dhcpData    = routers.flatMap(r => r.dhcp);

    const fetchErrors = {};
    routers.forEach((r, i) => {
      if (Object.keys(r.errs).length) fetchErrors['router_' + (r.host || i)] = r.errs;
    });
    if (Object.keys(fetchErrors).length) {
      const logger = require('../utils/logger');
      logger.warn(`[customer-traffic] partial fetch failure: ${JSON.stringify(fetchErrors)}`);
    }

    // ── KESEHATAN FETCH (anti-flapping saat router timeout) ────────────
    // Kalau query session/queue ke SALAH SATU router gagal, data PPPoE/queue
    // jadi tidak lengkap → jangan turunkan status pelanggan ke offline karena
    // itu (bisa jadi false-offline massal). Kita tandai supaya histeresis
    // MEMPERTAHANKAN status terakhir (raw=null) ketimbang memvonis offline.
    const anyRouterQueried   = routers.length > 0;
    const sessionsFetchOk = anyRouterQueried && routers.every(r => !r.errs.sessions);
    const queuesFetchOk   = anyRouterQueried && routers.every(r => !r.errs.queues);
    // pollHasData = poll ini benar-benar mendapat sinyal yang bisa dipakai
    // (ada session ATAU ada queue ATAU ada router yang fetch-nya sukses penuh).
    // Bila semua router gagal total → false → JANGAN paksa siapa pun offline.
    const pollHasData = anyRouterQueried &&
      (sessionData.length > 0 || queueData.length > 0 || routers.some(r => Object.keys(r.errs).length === 0));

    // Build lookup maps
    //
    // Dynamic queue PPPoE bernama "<pppoe-USERNAME>" atau kadang "pppoe-USERNAME"
    // (tergantung versi RouterOS & format response REST API). Index by:
    //   - target (IP)        → match simple queue manual yang target-nya IP
    //   - name (lowercase)   → match queue manual yang dibuat dgn nama = pppoe username
    //   - pppoe variants     → match dynamic queue dgn nama "<pppoe-XXX>" / "pppoe-XXX"
    const queueByTarget = {}, queueByName = {}, queueByPPPoEUser = {};
    queueData.forEach(q => {
      // Target queue bisa berformat "10.2.7.4", "10.2.7.4/32", atau beberapa IP
      // dipisah koma. Index BOTH bentuk: dengan dan tanpa "/32" supaya lookup
      // by static IP (yang biasanya disimpan tanpa CIDR) selalu ketemu.
      const targets = (q.target || '').split(',').map(t => t.trim());
      targets.forEach(t => {
        if (!t) return;
        const ipOnly = t.split('/')[0];           // buang CIDR
        if (ipOnly) queueByTarget[ipOnly] = q;     // "10.2.7.4"
        queueByTarget[t] = q;                       // "10.2.7.4/32" (kalau ada)
      });
      if(q.name) queueByName[q.name.toLowerCase()] = q;
      // Ekstrak PPPoE username dari nama queue dynamic.
      // Pola:
      //   "<pppoe-USERNAME>"      → versi RouterOS lama, dgn kurung siku
      //   "<pppoe-USERNAME-N>"    → multi-session (Only One = no), N = 1, 2, ...
      //   "pppoe-USERNAME"        → kadang REST v7 tidak include kurung siku
      // Strip kurung siku dulu, baru match pola pppoe-XXX[-N].
      const nameLower = (q.name || '').toLowerCase();
      const stripped  = nameLower.replace(/^</, '').replace(/>$/, '');
      const m = stripped.match(/^pppoe-(.+?)(?:-\d+)?$/);
      if (m && m[1]) queueByPPPoEUser[m[1]] = q;
    });

    const sessionByName = {}, sessionByIP = {};
    sessionData.forEach(s => {
      if(s.name)    sessionByName[s.name.toLowerCase()] = s;
      if(s.address) sessionByIP[s.address]              = s;
    });

    // ARP: IP yang ada di ARP table = device aktif di jaringan
    // Filter: hanya yang dynamic/reachable (bukan failed/incomplete)
    const arpByIP = {};
    arpData.forEach(a => {
      const ip = a.address || a['address'];
      const st = (a.status || '').toLowerCase();
      if (ip && st !== 'failed' && st !== 'incomplete') {
        arpByIP[ip] = { mac: a['mac-address']||'', interface: a.interface||'', status: st };
      }
    });

    // DHCP leases: aktif = status bound
    const dhcpByIP = {}, dhcpByMac = {};
    dhcpData.forEach(d => {
      const ip  = d.address || d['address'];
      const mac = d['mac-address'] || '';
      const st  = (d.status || '').toLowerCase();
      if (ip)  dhcpByIP[ip]   = { hostname: d.hostname||'', status: st, active: st === 'bound' };
      if (mac) dhcpByMac[mac] = { ip, status: st, active: st === 'bound' };
    });

    // Include semua customer kecuali yang dihapus/berhenti permanen.
    // Customer 'isolated' tetap relevan — mereka punya queue khusus (rate-limit
    // turun) untuk traffic monitoring saat masa isolir. Customer 'suspended'
    // juga bisa punya sesi/queue aktif. Hanya 'inactive' yang biasanya tidak
    // perlu (tapi kita tetap include — biaya filter rendah, dan kalau ada
    // anomaly traffic justru perlu kelihatan).
    const { Op } = require('sequelize');
    const customers = await Customer.findAll({
      attributes: ['id','customer_id','name','static_ip','pppoe_username','status','latitude','longitude'],
      include: [{ model: Package, as: 'package', attributes: ['name','price'], required: false }],
      where: { status: { [Op.in]: ['active', 'isolated', 'suspended', 'inactive'] } }
    });

    const parseK = v => {
      v = v || '0';
      if(v.endsWith('M')) return parseFloat(v)*1000000;
      if(v.endsWith('k')||v.endsWith('K')) return parseFloat(v)*1000;
      return parseFloat(v)||0;
    };

    const result = customers.map(cust => {
      const ip    = cust.static_ip      || null;
      const pppoe = cust.pppoe_username || null;
      const pppoeLc = pppoe ? pppoe.toLowerCase() : null;

      // Cari sesi PPPoE aktif dulu — IP-nya dipakai sebagai fallback target lookup.
      const session = (pppoeLc && sessionByName[pppoeLc])
        || (ip && sessionByIP[ip])
        || null;
      const sessionIP = session?.address || null;

      // Queue lookup, prioritas dari yang paling spesifik:
      //   1. Simple queue manual dgn target = static IP customer (± /32)
      //   2. Simple queue manual dgn target = IP yg di-assign sesi PPPoE aktif
      //   3. Dynamic queue PPPoE dgn nama "<pppoe-USERNAME>" / "pppoe-USERNAME"
      //   4. Simple queue manual yang namanya persis = pppoe username
      //   5. Simple queue dgn comment yang mengandung pppoe username
      //   6. Simple queue dgn comment yang mengandung static IP (fallback static)
      const queue = (ip        && (queueByTarget[ip] || queueByTarget[ip + '/32']))
        || (sessionIP          && (queueByTarget[sessionIP] || queueByTarget[sessionIP + '/32']))
        || (pppoeLc            && queueByPPPoEUser[pppoeLc])
        || (pppoeLc            && queueByName[pppoeLc])
        || (pppoeLc            && queueData.find(q => q.comment && q.comment.toLowerCase().includes(pppoeLc)))
        || (ip                 && queueData.find(q => q.comment && q.comment.includes(ip)))
        || null;

      const qRateIn  = queue ? parseInt(queue.rateIn  || 0) : 0;
      const qRateOut = queue ? parseInt(queue.rateOut || 0) : 0;

      // Multi-signal detection. CATATAN PENTING soal MAC/IP binding:
      // Saat pakai IP binding / MAC binding (hotspot bind), entry ARP TETAP
      // tercatat di router walau modem MATI (cache L2 belum timeout). Akibatnya
      // byARP "berbohong" — customer terlihat online padahal offline. Maka:
      //   • PPPoE session aktif  → online pasti (tidak perlu ping).
      //   • Customer ber-IP      → PING yang jadi penentu. ARP/DHCP/queue HANYA
      //     dipakai sebagai hint diagnosa, BUKAN penentu online.
      // Sinyal mentah (untuk diagnosa / offlineReason):
      const byPPPoE  = !!(session);
      const byARP    = ip ? !!(arpByIP[ip]) : false;
      const byDHCP   = ip ? !!(dhcpByIP[ip]?.active) : false;
      const byQueue  = (qRateIn + qRateOut) > 0;

      // Online awal: HANYA PPPoE session. Untuk customer ber-IP, status online
      // ditentukan oleh ping di tahap berikutnya (ping authoritative).
      const isOnline = byPPPoE;
      const onlineSource = byPPPoE ? 'pppoe' : null;

      let maxDown = 0, maxUp = 0;
      if (queue?.maxLimit) {
        const parts = queue.maxLimit.split('/');
        maxUp   = parseK(parts[0]);
        maxDown = parseK(parts[1] || parts[0]);
      }

      // Alasan offline awal. Untuk customer ber-IP, status final ditentukan
      // PING di bawah, jadi reason-nya juga di-set ulang di sana (rto/online).
      let offlineReason = null;
      if (!isOnline) {
        if (!ip && !pppoe) {
          offlineReason = 'no-config';        // Belum diisi IP statis / PPPoE username
        } else if (pppoe && !session && !ip) {
          offlineReason = 'pppoe-no-session'; // PPPoE user belum login (tanpa IP cadangan)
        } else if (ip) {
          offlineReason = 'pinging';          // Sementara — akan jadi rto/online setelah ping
        } else if (pppoe && !session) {
          offlineReason = 'pppoe-no-session';
        }
      }

      return {
        id: cust.id, customer_id: cust.customer_id, name: cust.name,
        ip, pppoe, latitude: cust.latitude, longitude: cust.longitude,
        package: cust.package?.name || null,
        online:      isOnline,
        onlineSource: onlineSource,
        offlineReason,
        uptime:      session?.uptime || null,
        rateDown: qRateIn, rateUp: qRateOut,
        maxDown, maxUp,
        utilDown: maxDown > 0 ? Math.min(100, Math.round(qRateIn  / maxDown * 100)) : 0,
        utilUp:   maxUp   > 0 ? Math.min(100, Math.round(qRateOut / maxUp   * 100)) : 0,
        bytesDown: queue ? parseInt(queue.bytesIn  || 0) : 0,
        bytesUp:   queue ? parseInt(queue.bytesOut || 0) : 0,
        queueName: queue?.name || null, queueId: queue?.id || null,
        disabled:  queue?.disabled || false,
        // Sinyal mentah L2 — dipakai sebagai fallback HANYA saat ping dimatikan
        // (?ping=0). Tidak dipakai saat ping aktif (ping authoritative).
        _byARP: byARP, _byDHCP: byDHCP, _byQueue: byQueue,
        // Penanda: pelanggan PPPoE TANPA IP statis. Untuk jenis ini, ketiadaan
        // sesi hanya berarti offline bila fetch session sukses (lihat raw logic).
        _isPppoeOnly: !!(pppoe && !ip),
      };
    });

    // ── PING = penentu status untuk SEMUA customer ber-IP ──────────────
    // CATATAN MAC/IP BINDING: saat pakai IP binding / MAC binding, entry ARP
    // tetap ada di router meski modem MATI (cache L2 belum timeout), sehingga
    // ARP/DHCP/queue "berbohong" (terlihat online). Maka untuk customer ber-IP,
    // KEBENARAN diambil dari hasil ping:
    //   • ping reply  → online  (onlineSource = 'ping')
    //   • ping RTO    → offline (offlineReason = 'rto')
    // PPPoE dengan session aktif TIDAK diping (session sudah bukti cukup).
    // Bisa dimatikan dengan ?ping=0 (saat ping=0, fallback ke ARP/DHCP/queue
    // supaya halaman tetap informatif walau tanpa ping).
    const pingEnabled = opts.pingEnabled !== false;
    if (!pingEnabled) {
      // Ping dimatikan → kembali ke perilaku lama (ARP/DHCP/queue dianggap
      // online). Berguna untuk diagnosa/L2 view, tapi ingat: saat MAC binding,
      // ini bisa false-online. Default tetap ping aktif.
      result.forEach(r => {
        if (!r.online && (r._byARP || r._byDHCP || r._byQueue)) {
          r.online = true;
          r.onlineSource = r._byARP ? 'arp' : r._byDHCP ? 'dhcp' : 'queue';
          r.offlineReason = null;
        }
      });
    }
    // ── RAW SIGNAL per customer (sebelum histeresis) ───────────────────
    // rawOnline = bukti "saat ini" online dari sumber paling tepercaya:
    //   PPPoE session > ping reply > traffic aktif. rawOnline=null artinya
    //   "tidak ada sinyal pasti siklus ini" (mis. IP belum sempat diping &
    //   cache habis) → histeresis akan PERTAHANKAN status terakhir.
    const TRAFFIC_ONLINE_BPS = 2000; // 2 Kbps: laju nyata = bukti hidup
    const now = Date.now();

    if (pingEnabled) {
      const byId = {};
      result.forEach(r => { byId[r.id] = r; });

      // Sinyal awal dari cache ping yang masih valid.
      result.forEach(r => {
        if (r.online) { r._raw = true; return; }     // sudah online via PPPoE
        const activeBps = (r.rateDown || 0) + (r.rateUp || 0);
        if (activeBps >= TRAFFIC_ONLINE_BPS) { r._raw = true; r._rawSrc = 'traffic'; return; }

        // Pelanggan PPPoE (tanpa IP statis) yang TIDAK punya sesi:
        //   - Bila fetch session BERHASIL → memang offline (raw=false).
        //   - Bila fetch session GAGAL (router timeout):
        //       • ada queue rate / queue cocok → anggap online (bukti L2 valid).
        //       • sudah pernah online sebelumnya → tahan (raw=null).
        //       • selain itu → raw=false (jangan biarkan "abu-abu" selamanya).
        if (r._isPppoeOnly) {
          if (sessionsFetchOk) { r._raw = false; return; }
          if (r._byQueue) { r._raw = true; r._rawSrc = 'queue'; return; }
          const prev = _statusState.get(r.id);
          r._raw = (prev && prev.online === true) ? null : false;
          return;
        }

        if (!r.ip) { r._raw = false; return; }        // tanpa IP & tanpa pppoe
        const c = _pingCache.get(r.ip);
        if (c && (now - c.ts) < PING_TTL_MS) { r._raw = c.online; r._rawSrc = c.online ? 'ping' : null; }
        else if (r._byQueue) { r._raw = true; r._rawSrc = 'queue'; } // ada traffic/queue → online (sementara, sampai ping konfirmasi)
        else r._raw = null;                            // belum ada sinyal → tahan status lama / akan diping
      });

      // Ping ulang IP yang sinyalnya belum pasti (raw null). Cap dinaikkan &
      // prioritaskan yang paling lama tidak diping supaya semua ter-cover
      // bergiliran (round-robin) tanpa membebani router sekaligus.
      // opts.maxPing: batasi (atau 0 = lewati) ping pada snapshot ini — dipakai
      // poll PERTAMA agar status PPPoE/queue tampil instan tanpa nunggu ping.
      const PING_CAP = (opts.maxPing != null) ? Math.max(0, opts.maxPing) : 300;
      const toPing = (PING_CAP === 0) ? [] : result
        .filter(r => r.ip && r._raw === null)
        .sort((a, b) => {
          const ca = _pingCache.get(a.ip), cb = _pingCache.get(b.ip);
          return (ca ? ca.ts : 0) - (cb ? cb.ts : 0); // paling lama dulu
        })
        .slice(0, PING_CAP);

      if (toPing.length) {
        const CHUNK = 20;
        for (let i = 0; i < toPing.length; i += CHUNK) {
          const chunk = toPing.slice(i, i + CHUNK);
          await Promise.allSettled(chunk.map(async (r) => {
            let gotReply = false;
            for (const inst of (pingInstances.length ? pingInstances : [mt])) {
              try {
                // count:2 → tahan packet loss: 1 dari 2 balas = online.
                const pr = await inst.ping(r.ip, { count: 2, interval: '0.2', timeout: 1000 });
                const rows = Array.isArray(pr) ? pr : (pr ? [pr] : []);
                for (const p of rows) {
                  if (p && typeof p === 'object' && (+p.received) > 0) gotReply = true;
                }
                if (!gotReply) {
                  gotReply = rows.some(p => {
                    if (!p || typeof p !== 'object') return false;
                    const st = String(p.status || '').toLowerCase();
                    return st.includes('reply') || p['response-time'] != null;
                  });
                }
              } catch (_) { /* router ini gagal, coba berikutnya */ }
              if (gotReply) break;
            }
            _pingCache.set(r.ip, { online: gotReply, ts: Date.now() });
            if (byId[r.id]) { byId[r.id]._raw = gotReply; byId[r.id]._rawSrc = gotReply ? 'ping' : null; }
          }));
        }
      }
    } else {
      // Ping dimatikan → fallback L2 (ARP/DHCP/queue) sebagai sinyal raw.
      result.forEach(r => {
        if (r.online) { r._raw = true; return; }
        const activeBps = (r.rateDown || 0) + (r.rateUp || 0);
        if (activeBps >= TRAFFIC_ONLINE_BPS) { r._raw = true; r._rawSrc = 'traffic'; return; }
        if (r._byARP || r._byDHCP || r._byQueue) {
          r._raw = true; r._rawSrc = r._byARP ? 'arp' : r._byDHCP ? 'dhcp' : 'queue';
        } else r._raw = false;
      });
    }

    // ── HISTERESIS: ubah raw signal → status TERKONFIRMASI (anti-flapping) ─
    // Online naik cepat (1 bukti). Offline turun lambat (butuh OFFLINE_CONFIRM
    // hit RTO berturut) supaya glitch/packet-loss/poll yang belum sempat ping
    // tidak bikin angka online naik-turun. raw=null → status terakhir dipakai.
    //
    // Bila poll ini TIDAK punya data sama sekali (semua router tak terjangkau),
    // JANGAN ubah status apa pun — pertahankan snapshot terakhir seutuhnya.
    result.forEach(r => {
      let st = _statusState.get(r.id);
      if (!st) { st = { online: null, upStreak: 0, downStreak: 0, ts: now }; _statusState.set(r.id, st); }

      // Gunakan raw signal apa adanya. Jangan dipaksa null walau poll dianggap
      // "tanpa data" — sinyal nyata (PPPoE/ping/traffic/queue) tetap harus lewat.
      // pollHasData hanya dipakai untuk keputusan forced-offline (stale) di bawah.
      const raw = r._raw;
      if (raw === true) {
        st.upStreak++; st.downStreak = 0; st.ts = now;
        if (st.online !== true && st.upStreak >= ONLINE_CONFIRM) st.online = true;
      } else if (raw === false) {
        st.downStreak++; st.upStreak = 0;
        if (st.online === true) {
          // Turunkan ke offline hanya setelah OFFLINE_CONFIRM hit berturut.
          if (st.downStreak >= OFFLINE_CONFIRM) { st.online = false; st.ts = now; }
        } else {
          st.online = false; st.ts = now; // belum pernah online → langsung offline
        }
      } else {
        // raw === null → tidak ada sinyal pasti siklus ini. Pertahankan status
        // lama. Forced-offline by STALE hanya berlaku saat poll PUNYA data
        // (kalau poll kosong, tidak adil memvonis offline).
        if (pollHasData && st.online === true && (now - st.ts) > STALE_OFFLINE_MS) {
          st.online = false; st.ts = now;
        }
      }

      // Terapkan status terkonfirmasi ke record yang dikirim ke client.
      if (st.online === true) {
        r.online = true;
        r.onlineSource = r.onlineSource || r._rawSrc || 'ping';
        r.offlineReason = null;
      } else if (st.online === false) {
        if (!r.online) { // jangan override bila sudah online via PPPoE di atas
          r.online = false;
          r.onlineSource = null;
          r.offlineReason = r.offlineReason || 'rto';
        }
      }
      // st.online === null (belum pasti) → biarkan nilai r.online apa adanya.
    });

    // Bersihkan field helper internal sebelum kirim ke client.
    result.forEach(r => { delete r._byARP; delete r._byDHCP; delete r._byQueue; delete r._raw; delete r._rawSrc; delete r._isPppoeOnly; });

    return ({
      success: true, data: result,
      meta: { total: result.length, online: result.filter(r=>r.online).length,
              withQueue: result.filter(r=>r.queueName).length,
              pppoeActive: sessionData.length, timestamp: new Date(),
              // Surfacing fetch errors agar frontend & user langsung tahu kalau
              // salah satu source (queue/session/arp/dhcp) gagal. Object kosong
              // = semua sukses.
              fetchErrors: Object.keys(fetchErrors).length ? fetchErrors : undefined,
              queueCount: queueData.length },
      // Debug info: kirim ringkasan queue/session jika ?debug=1, untuk
      // membantu diagnosis kalau ada customer yang seharusnya online tapi
      // tidak match. Tidak expose data sensitif (password dsb).
      ...(opts.debug === true ? {
        debug: {
          mtHost: mt.host, mtPort: mt.port,
          routersQueried: routers.map(r => r.host),
          queueCount: queueData.length,
          dynamicQueueCount: queueData.filter(q => q.dynamic).length,
          pppoeQueueSamples: queueData.filter(q => /pppoe-/i.test(q.name || '')).slice(0, 5)
            .map(q => ({ name: q.name, target: q.target, dynamic: q.dynamic, rateIn: q.rateIn, rateOut: q.rateOut })),
          sessionSamples: sessionData.slice(0, 5).map(s => ({ name: s.name, address: s.address, interface: s.interface })),
          pppoeUserKeys: Object.keys(queueByPPPoEUser).slice(0, 20),
          customersWithPPPoE: customers.filter(c => c.pppoe_username).slice(0, 10).map(c => ({
            id: c.id, name: c.name, pppoe: c.pppoe_username,
            matchedQueue: queueByPPPoEUser[c.pppoe_username.toLowerCase()]?.name || null
          }))
        }
      } : {})
    });
  } catch(e) {
    throw e;
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────
let _firstPollDone = false; // poll pertama: lewati ping → snapshot instan
async function poll() {
  if (_running) return;          // skip kalau poll sebelumnya belum kelar
  _running = true;
  try {
    // Poll PERTAMA (setelah boot/idle): lewati ping (maxPing:0) supaya status
    // PPPoE/queue/traffic tampil seketika (~1-2 dtk). Ping IP statis menyusul
    // di poll-poll berikutnya (round-robin) tanpa menahan tampilan awal.
    const opts = { pingEnabled: true };
    if (!_firstPollDone) opts.maxPing = 0;
    const snap = await computeSnapshot(opts);
    _firstPollDone = true;
    _lastSnapshot = snap;
    _lastError = null;
    if (_io) _io.to('traffic_monitoring').emit('traffic:update', snap);
  } catch (e) {
    _lastError = e.message || String(e);
    logger.warn('[CustomerTrafficPoller] poll error: ' + _lastError);
    // Tetap broadcast snapshot lama + flag error agar frontend tahu.
    if (_io && _lastSnapshot) {
      _io.to('traffic_monitoring').emit('traffic:update', {
        ..._lastSnapshot,
        meta: { ...(_lastSnapshot.meta || {}), stale: true, error: _lastError }
      });
    }
  } finally {
    _running = false;
  }
}

function _startTimer() {
  if (_timer) return;
  logger.info('[CustomerTrafficPoller] start aktif (subscribers=' + _subscribers + ')');
  poll(); // poll segera saat subscriber pertama datang (initial fill)
  _timer = setInterval(poll, POLL_INTERVAL_MS);
}

function _stopTimer() {
  // KEEP-WARM: jangan berhenti total saat idle. Snapshot tetap di-refresh
  // dengan interval lambat supaya saat admin membuka halaman lagi, data online
  // sudah siap seketika (tidak perlu nunggu computeSnapshot dari nol 15-30 dtk).
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_idleTimer) return;
  logger.info('[CustomerTrafficPoller] idle — beralih ke polling lambat (keep-warm)');
  _idleTimer = setInterval(poll, IDLE_POLL_INTERVAL_MS);
}

// Hentikan keep-warm idle timer (dipanggil saat subscriber aktif kembali).
function _clearIdleTimer() {
  if (_idleTimer) { clearInterval(_idleTimer); _idleTimer = null; }
}

module.exports = {
  /** Dipanggil sekali dari server.js setelah io siap. */
  attachIo(io) { _io = io; return this; },

  /** Subscriber bertambah (admin buka halaman). Mulai poller cepat. */
  addSubscriber() {
    _subscribers++;
    _clearIdleTimer();              // hentikan keep-warm idle
    if (!_timer) _startTimer();     // mulai polling cepat (juga poll seketika)
  },

  /** Subscriber berkurang (admin tutup halaman / disconnect). */
  removeSubscriber() {
    _subscribers = Math.max(0, _subscribers - 1);
    if (_subscribers === 0) _stopTimer(); // beralih ke keep-warm (bukan stop total)
  },

  /**
   * prewarm() — dipanggil sekali dari server.js setelah boot supaya snapshot
   * sudah terisi sebelum admin pertama membuka halaman. Mulai juga keep-warm
   * idle polling agar snapshot tetap fresh.
   */
  prewarm() {
    poll().catch(() => {});          // isi snapshot awal di latar belakang
    if (!_timer && !_idleTimer) {
      _idleTimer = setInterval(poll, IDLE_POLL_INTERVAL_MS);
    }
    return this;
  },

  /** Snapshot terakhir (untuk initial load via endpoint REST). */
  getSnapshot() { return _lastSnapshot; },

  /** computeSnapshot on-demand (mis. endpoint dgn ?device_id / ?debug=1). */
  computeSnapshot,

  /** Status internal untuk diagnosa. */
  stats() {
    return {
      subscribers: _subscribers,
      running: _running,
      polling: !!_timer,
      hasSnapshot: !!_lastSnapshot,
      lastError: _lastError,
      intervalMs: POLL_INTERVAL_MS,
    };
  },
};
