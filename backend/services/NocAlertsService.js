/**
 * NocAlertsService.js
 * ──────────────────────────────────────────────────────────────────────
 * In-memory tracker untuk Live Alerts di NOC Dashboard.
 *
 * Hanya track 3 kategori alert operational:
 *   1. Device (router) Up/Down — transition dari status online ↔ offline
 *   2. PPPoE Session Online/Offline — per-user connect ↔ disconnect
 *   3. Resources Overload — CPU > 90% atau RAM > 95% pada router
 *
 * Sengaja TIDAK pakai DB persisten supaya:
 *   - Tidak perlu migration baru
 *   - Tidak ada bloat tabel kalau alert sering
 *   - Restart pm2 → state reset ke kondisi terbaru (intended behavior)
 *
 * Retention: event lebih dari 24 jam auto-dibuang.
 * Polling: setiap 30 detik untuk semua router aktif.
 *
 * Thresholds:
 *   - CPU_HIGH_THRESHOLD: 90% (configurable di constructor)
 *   - RAM_HIGH_THRESHOLD: 95% (configurable di constructor)
 *
 * PPPoE per-user tracking:
 *   - State per router simpan Set<username> dari sesi aktif
 *   - Tiap cycle: bandingkan username baru vs lama
 *   - Generate event individual untuk setiap connect / disconnect
 *   - Saat first cycle (state belum ada), skip generate event (cuma catat baseline)
 *   - Rate limit: kalau > PPPOE_MASS_THRESHOLD event di 1 cycle, group jadi
 *     1 summary event "mass disconnect/connect" supaya tidak flood UI
 */

const logger = require('../utils/logger');

// ─── Configuration ──────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 30 * 1000;   // 30 detik
const EVENT_RETENTION_MS  = 24 * 3600 * 1000; // 24 jam
const MAX_EVENTS          = 500;          // safety cap

// Grace 5 menit: SNMP poll default 60s, butuh buffer untuk slow poll/network lag.
// Sebelumnya 60s — sama dengan poll interval → race condition trigger false offline.
const DEVICE_OFFLINE_GRACE_MS = 5 * 60 * 1000;  // 5 menit

// Dedup cooldown: kalau alert offline/online sama untuk router yang sama terjadi
// dalam window ini, suppress. Hindari spam dari router yg flapping (unstable).
const DEDUP_COOLDOWN_MS = 10 * 60 * 1000;  // 10 menit

const PPPOE_MASS_THRESHOLD = 10;          // > N event dalam 1 cycle = group jadi summary
const CPU_HIGH_THRESHOLD  = 90;           // %
const RAM_HIGH_THRESHOLD  = 95;           // %

class NocAlertsService {
  constructor() {
    // Event log — array of alert events, descending by timestamp
    this.events = [];

    // State terakhir setiap router (untuk detect transition)
    // Map: routerId → {
    //   status: 'online'|'offline',
    //   lastSeenAt: timestamp,
    //   pppoeUsers: Set<string>,   // username sesi aktif (track per-user)
    //   cpuHigh: boolean,
    //   ramHigh: boolean,
    // }
    this.routerStates = new Map();

    this.pollHandle = null;
    this.io = null;
    this.isPolling = false; // re-entry guard
    this.lastError = null;
    this.lastPollAt = null;
    this.lastPollDurationMs = null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────
  start(io = null) {
    this.io = io;
    if (this.pollHandle) {
      logger.warn('[NocAlertsService] already running, skip start');
      return;
    }
    // Initial poll: jalan segera (tidak tunggu 5 detik) supaya state cepat ter-isi.
    // Pakai setImmediate supaya tidak block event loop saat boot.
    setImmediate(() => {
      this._poll().catch(err => {
        this.lastError = err.message;
        logger.error(`[NocAlertsService] initial poll error: ${err.message}\n${err.stack}`);
      });
    });
    // Schedule periodic poll
    this.pollHandle = setInterval(() => {
      this._poll().catch(err => {
        this.lastError = err.message;
        logger.error(`[NocAlertsService] periodic poll error: ${err.message}`);
      });
    }, POLL_INTERVAL_MS);
    logger.info(`[NocAlertsService] started — polling every ${POLL_INTERVAL_MS/1000}s, thresholds CPU>${CPU_HIGH_THRESHOLD}% RAM>${RAM_HIGH_THRESHOLD}%`);
  }

  stop() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────
  /**
   * Get recent alerts, sorted descending by timestamp.
   * @param {number} limit
   * @returns {Array<{id, type, severity, title, detail, router_id, router_name, timestamp, category}>}
   */
  getRecent(limit = 20) {
    this._cleanupOldEvents();
    return this.events.slice(0, Math.min(limit, MAX_EVENTS));
  }

  /**
   * Debug snapshot — untuk troubleshoot kenapa alert tidak muncul.
   * Return: { running, lastPollAt, routerStates, eventCount, thresholds, lastError }
   */
  getDebugSnapshot() {
    return {
      running: !!this.pollHandle,
      isPolling: this.isPolling,
      lastPollAt: this.lastPollAt || null,
      lastPollDurationMs: this.lastPollDurationMs || null,
      lastError: this.lastError || null,
      routerCount: this.routerStates.size,
      routerStates: Array.from(this.routerStates.entries()).map(([id, s]) => ({
        router_id: id,
        status: s.status,
        lastSeenAt: s.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : null,
        // pppoeUsers adalah Set — di-render sebagai count + sample untuk hemat space
        pppoeUserCount: s.pppoeUsers ? s.pppoeUsers.size : 0,
        pppoeUsersSample: s.pppoeUsers ? Array.from(s.pppoeUsers).slice(0, 5) : [],
        cpuHigh: s.cpuHigh,
        ramHigh: s.ramHigh,
      })),
      eventCount: this.events.length,
      events: this.events.slice(0, 10),
      thresholds: {
        cpu: CPU_HIGH_THRESHOLD,
        ram: RAM_HIGH_THRESHOLD,
        pollIntervalSec: POLL_INTERVAL_MS / 1000,
        pppoeMassThreshold: PPPOE_MASS_THRESHOLD,
      },
    };
  }

  // ─── Polling ──────────────────────────────────────────────────────────
  async _poll() {
    if (this.isPolling) {
      logger.debug('[NocAlertsService] previous poll still running, skip');
      return;
    }
    this.isPolling = true;
    const pollStart = Date.now();
    try {
      const { Device } = require('../models');

      // Query semua router (tidak filter is_active supaya bisa lihat semua kandidat).
      // Filter is_active dilakukan setelah load supaya kita bisa log apa yang ada.
      // Note: field timestamp di model Device adalah `last_polled` (bukan last_ping/last_seen)
      const allRouters = await Device.findAll({
        where: { type: 'router' },
        attributes: ['id', 'name', 'status', 'last_polled', 'is_active'],
        raw: true,
      });

      const activeRouters = allRouters.filter(r => r.is_active !== false); // null/undefined/true → keep
      logger.info(`[NocAlertsService] db query: ${allRouters.length} total router(s), ${activeRouters.length} active`);

      if (allRouters.length === 0) {
        logger.warn(`[NocAlertsService] NO ROUTER found with type='router'. Cek tabel devices: SELECT id, name, type, is_active FROM devices;`);
      }
      if (allRouters.length > activeRouters.length) {
        const inactive = allRouters.filter(r => r.is_active === false).map(r => r.name).join(', ');
        logger.warn(`[NocAlertsService] router inactive (is_active=false): ${inactive}`);
      }

      // Poll setiap router secara paralel dengan timeout
      await Promise.allSettled(activeRouters.map(r => this._pollRouter(r)));

      this.lastPollAt = new Date().toISOString();
      this.lastPollDurationMs = Date.now() - pollStart;
      this.lastError = null; // clear kalau berhasil
      logger.info(`[NocAlertsService] poll done in ${this.lastPollDurationMs}ms, events total=${this.events.length}`);
    } catch (err) {
      this.lastError = err.message;
      logger.error(`[NocAlertsService] poll error: ${err.message}\n${err.stack}`);
    } finally {
      this.isPolling = false;
    }
  }

  async _pollRouter(router) {
    const routerId = router.id;
    const routerName = router.name || `Router #${routerId}`;
    const prev = this.routerStates.get(routerId) || {};
    const isFirstCycle = !this.routerStates.has(routerId);

    // ─── 1. Device Up/Down detection ─────────────────────────────────
    // Pakai field status + last_polled dari tabel `devices` yang di-update
    // oleh service lain (IsolirService, SNMPService). Threshold offline:
    // last_polled > DEVICE_OFFLINE_GRACE_MS yang lalu = offline.
    const now = Date.now();
    const lastSeen = router.last_polled;
    const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : null;
    let currentStatus = router.status || 'unknown';

    // Override: kalau last_ping terlalu lama, anggap offline meski DB bilang online
    if (lastSeenMs && (now - lastSeenMs > DEVICE_OFFLINE_GRACE_MS) && currentStatus === 'online') {
      currentStatus = 'offline';
    }

    if (prev.status && prev.status !== currentStatus && currentStatus !== 'unknown') {
      // Transition detected!
      // Cek dedup cooldown: kalau alert untuk router ini baru saja keluar
      // (dalam DEDUP_COOLDOWN_MS), jangan emit lagi. Hindari spam dari
      // router yg flapping (unstable network, polling slow, dll).
      const lastDeviceEvent = this.events.find(e =>
        e.category === 'device_status' && e.router_id === routerId
      );
      const sinceLastMs = lastDeviceEvent
        ? Date.now() - new Date(lastDeviceEvent.timestamp).getTime()
        : Infinity;
      const inCooldown = sinceLastMs < DEDUP_COOLDOWN_MS;

      if (inCooldown) {
        logger.info(`[NocAlertsService] suppress ${routerName} ${currentStatus} event (dedup cooldown ${Math.round(sinceLastMs/1000)}s < ${DEDUP_COOLDOWN_MS/1000}s)`);
      } else if (currentStatus === 'offline') {
        this._pushEvent({
          category: 'device_status',
          severity: 'danger',
          title: `${routerName} OFFLINE`,
          detail: `Router tidak responsif sejak ${this._fmtTime(lastSeenMs)}`,
          router_id: routerId,
          router_name: routerName,
        });
      } else if (currentStatus === 'online' && prev.status === 'offline') {
        this._pushEvent({
          category: 'device_status',
          severity: 'success',
          title: `${routerName} ONLINE kembali`,
          detail: `Router pulih dari kondisi offline`,
          router_id: routerId,
          router_name: routerName,
        });
      }
    }

    // ─── 2 & 3. Resources & PPPoE: butuh live query ke MikroTik ──────
    // Polling resource selama router NOT offline. Status 'warning' atau
    // 'maintenance' tetap di-poll karena router masih hidup. Kalau API call
    // gagal, kita catch & biarkan state lama.
    let pppoeUsers = prev.pppoeUsers; // undefined kalau first cycle
    let cpuHigh = prev.cpuHigh || false;
    let ramHigh = prev.ramHigh || false;

    const shouldPollLive = currentStatus !== 'offline' && currentStatus !== 'unknown';
    logger.info(`[NocAlertsService] poll ${routerName} status=${currentStatus} shouldPollLive=${shouldPollLive} firstCycle=${isFirstCycle}`);

    if (shouldPollLive) {
      try {
        const { getMikrotikInstanceByDevice } = require('./MikrotikService');
        const mt = await Promise.race([
          getMikrotikInstanceByDevice(routerId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 5000))
        ]);

        // Fetch system resource + pppoe active secara paralel
        // Pakai getPPPoESessions() yang sudah wrapped (return {name, address, ...}).
        // Sebelumnya saya pakai getActivePPPoEUsers yang ternyata tidak ada di
        // MikrotikService — fallback ke raw /ppp/active berfungsi tapi field
        // formatnya pakai dash (mis. 'caller-id') yang tidak konsisten.
        const [resource, pppoeActive] = await Promise.allSettled([
          Promise.race([
            mt.getSystemResource(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('resource timeout')), 5000))
          ]),
          Promise.race([
            mt.getPPPoESessions(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('pppoe timeout')), 5000))
          ])
        ]);

        // ─── Resource overload check ──────────────────────────────
        if (resource.status === 'fulfilled' && resource.value) {
          const r = resource.value;
          const cpu = r.cpuLoad || 0;
          const ramPct = r.totalMemory > 0
            ? Math.round((1 - r.freeMemory / r.totalMemory) * 100)
            : 0;

          const newCpuHigh = cpu > CPU_HIGH_THRESHOLD;
          const newRamHigh = ramPct > RAM_HIGH_THRESHOLD;

          logger.info(`[NocAlertsService] ${routerName} cpu=${cpu}% ram=${ramPct}% cpuHigh=${newCpuHigh} ramHigh=${newRamHigh} (prev cpuHigh=${cpuHigh} ramHigh=${ramHigh}) isFirstCycle=${isFirstCycle}`);

          // CPU transition: low → high = alert.
          // PENTING: kalau ini polling pertama untuk router dan kondisi SUDAH high,
          // kita TETAP fire alert (supaya admin yang baru deploy bisa langsung
          // lihat kondisi router yang sudah overload sejak sebelumnya).
          if (newCpuHigh && (!cpuHigh || isFirstCycle)) {
            this._pushEvent({
              category: 'resource_cpu',
              severity: 'warning',
              title: `${routerName} CPU overload`,
              detail: `CPU load ${cpu}% (threshold: ${CPU_HIGH_THRESHOLD}%)`,
              router_id: routerId,
              router_name: routerName,
            });
          } else if (!newCpuHigh && cpuHigh && !isFirstCycle) {
            this._pushEvent({
              category: 'resource_cpu',
              severity: 'success',
              title: `${routerName} CPU pulih`,
              detail: `CPU load turun ke ${cpu}%`,
              router_id: routerId,
              router_name: routerName,
            });
          }

          // RAM transition (sama pattern)
          if (newRamHigh && (!ramHigh || isFirstCycle)) {
            this._pushEvent({
              category: 'resource_ram',
              severity: 'warning',
              title: `${routerName} RAM overload`,
              detail: `RAM usage ${ramPct}% (threshold: ${RAM_HIGH_THRESHOLD}%)`,
              router_id: routerId,
              router_name: routerName,
            });
          } else if (!newRamHigh && ramHigh && !isFirstCycle) {
            this._pushEvent({
              category: 'resource_ram',
              severity: 'success',
              title: `${routerName} RAM pulih`,
              detail: `RAM usage turun ke ${ramPct}%`,
              router_id: routerId,
              router_name: routerName,
            });
          }

          cpuHigh = newCpuHigh;
          ramHigh = newRamHigh;
        } else if (resource.status === 'rejected') {
          logger.warn(`[NocAlertsService] ${routerName} resource fetch failed: ${resource.reason?.message || resource.reason}`);
        }

        // ─── PPPoE session change check (PER-USER) ────────────────
        if (pppoeActive.status === 'fulfilled') {
          const sessions = Array.isArray(pppoeActive.value) ? pppoeActive.value : [];
          // Build set username dari session aktif (filter yang valid string)
          const newUsers = new Set(
            sessions
              .map(s => s && s.name ? String(s.name).trim() : null)
              .filter(Boolean)
          );

          // Hanya generate event kalau ini BUKAN first cycle (state sebelumnya ada).
          // First cycle = baseline saja supaya tidak flag "semua user connect" saat boot.
          if (pppoeUsers instanceof Set) {
            // Diff: connected = di newUsers tapi tidak di pppoeUsers
            //       disconnected = di pppoeUsers tapi tidak di newUsers
            const connected = [];
            const disconnected = [];
            newUsers.forEach(u => { if (!pppoeUsers.has(u)) connected.push(u); });
            pppoeUsers.forEach(u => { if (!newUsers.has(u)) disconnected.push(u); });

            // Build session detail map untuk include caller-id (IP) di event
            const detailMap = new Map();
            sessions.forEach(s => {
              if (s && s.name) {
                detailMap.set(String(s.name).trim(), {
                  address: s.address || s['caller-id'] || null,
                  service: s.service || null,
                });
              }
            });

            // ── Disconnect events ───────────────────────────────────
            if (disconnected.length > 0) {
              if (disconnected.length > PPPOE_MASS_THRESHOLD) {
                // Mass disconnect — group jadi 1 event supaya tidak flood UI
                const sample = disconnected.slice(0, 5).join(', ');
                this._pushEvent({
                  category: 'pppoe_disconnect',
                  severity: 'warning',
                  title: `${routerName} mass disconnect PPPoE`,
                  detail: `${disconnected.length} session terputus: ${sample}${disconnected.length > 5 ? ` +${disconnected.length - 5} lainnya` : ''}`,
                  router_id: routerId,
                  router_name: routerName,
                });
              } else {
                // Per-user event
                disconnected.forEach(username => {
                  this._pushEvent({
                    category: 'pppoe_disconnect',
                    severity: 'warning',
                    title: `PPPoE disconnect: ${username}`,
                    detail: `Session di router ${routerName} terputus`,
                    router_id: routerId,
                    router_name: routerName,
                    username,
                  });
                });
              }
            }

            // ── Connect events ──────────────────────────────────────
            if (connected.length > 0) {
              if (connected.length > PPPOE_MASS_THRESHOLD) {
                // Mass connect (mungkin recovery) — group
                const sample = connected.slice(0, 5).join(', ');
                this._pushEvent({
                  category: 'pppoe_connect',
                  severity: 'success',
                  title: `${routerName} mass connect PPPoE`,
                  detail: `${connected.length} session baru aktif: ${sample}${connected.length > 5 ? ` +${connected.length - 5} lainnya` : ''}`,
                  router_id: routerId,
                  router_name: routerName,
                });
              } else {
                // Per-user event
                connected.forEach(username => {
                  const info = detailMap.get(username) || {};
                  const ipPart = info.address ? ` (${info.address})` : '';
                  this._pushEvent({
                    category: 'pppoe_connect',
                    severity: 'info',
                    title: `PPPoE connect: ${username}`,
                    detail: `Session aktif di router ${routerName}${ipPart}`,
                    router_id: routerId,
                    router_name: routerName,
                    username,
                  });
                });
              }
            }
          } else {
            // First cycle untuk router ini — hanya log info, tidak ada event
            logger.info(`[NocAlertsService] ${routerName} pppoe baseline: ${newUsers.size} session aktif`);
          }

          pppoeUsers = newUsers;
        } else if (pppoeActive.status === 'rejected') {
          logger.debug(`[NocAlertsService] ${routerName} pppoe fetch failed: ${pppoeActive.reason?.message || pppoeActive.reason}`);
        }
      } catch (err) {
        // Router unreachable — biarkan state lama, jangan generate alert palsu
        logger.warn(`[NocAlertsService] ${routerName} live fetch error: ${err.message}`);
      }
    }

    // Update state — selalu di-set, jadi cycle berikutnya tahu router ini sudah pernah di-poll
    this.routerStates.set(routerId, {
      status: currentStatus,
      lastSeenAt: lastSeenMs,
      pppoeUsers,
      cpuHigh,
      ramHigh,
    });
  }

  // ─── Event Management ─────────────────────────────────────────────────
  _pushEvent(ev) {
    const event = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...ev,
    };
    this.events.unshift(event);
    // Cap total events
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS;
    }
    logger.info(`[NocAlertsService] event: ${event.severity.toUpperCase()} ${event.title}`);

    // Optional: emit via socket.io kalau ada
    if (this.io) {
      try {
        this.io.emit('noc:alert', event);
      } catch (e) { /* ignore */ }
    }
  }

  _cleanupOldEvents() {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    this.events = this.events.filter(e => new Date(e.timestamp).getTime() > cutoff);
  }

  /**
   * Hapus semua event dari log. Dipakai dari endpoint admin untuk clear UI
   * tanpa restart service. State router (online/offline) TIDAK direset —
   * jadi tidak akan trigger alert ulang seketika.
   */
  clearAll() {
    const removed = this.events.length;
    this.events = [];
    logger.info(`[NocAlertsService] cleared all events (${removed} removed)`);
    return removed;
  }

  _fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
}

module.exports = new NocAlertsService();