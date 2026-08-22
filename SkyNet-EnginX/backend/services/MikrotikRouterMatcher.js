/**
 * MikrotikRouterMatcher.js
 * ────────────────────────────────────────────────────────────────────
 * Auto-detect mikrotik_id untuk customer yang belum di-assign router.
 *
 * Strategi (live presence — paling akurat):
 *   - Untuk static_ip  → scan /ip/arp/print di setiap router → match address
 *   - Untuk pppoe_user → scan /ppp/active/print di setiap router → match name
 *
 * Fallback ke /ppp/secret/print kalau /ppp/active tidak match
 * (user PPPoE belum connect tapi punya secret di router itu).
 *
 * Karakteristik:
 *   - 1 batch call scan semua router 1x (paralel), cache hasilnya
 *   - Per-customer lookup dari cache (instant)
 *   - Skip customer yang tidak match — admin handle manual
 *   - Log detection_method ke customer untuk audit trail
 * ────────────────────────────────────────────────────────────────────
 */
const { sequelize } = require('../models');
const IsolirService = require('./IsolirService');

// Helper retry untuk API call (sama pattern dengan modul lain)
async function runWithRetry(api, words, maxRetry = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      const result = await api.run(words);
      return result;
    } catch (e) {
      lastErr = e;
      const isTransient = /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|ECONNREFUSED/i.test(e.message || '');
      if (isTransient && attempt < maxRetry) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Ensure schema additions: kolom detection_method di customers.
 * Idempotent.
 */
async function ensureSchema() {
  try {
    const cols = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const have = new Set(cols.map(c => c.COLUMN_NAME));
    const alters = [];
    if (!have.has('mikrotik_detected_at')) {
      alters.push("ADD COLUMN `mikrotik_detected_at` TIMESTAMP NULL DEFAULT NULL");
    }
    if (!have.has('mikrotik_detection_method')) {
      alters.push("ADD COLUMN `mikrotik_detection_method` ENUM('manual','arp','active_ppp','ppp_secret') DEFAULT 'manual'");
    }
    if (alters.length) {
      await sequelize.query(`ALTER TABLE customers ${alters.join(', ')}`);
      console.log('[MikrotikRouterMatcher] customers schema migrated:', alters.length, 'columns');
    }
  } catch(e) {
    if (!/duplicate column|already exists/i.test(e.message || '')) {
      console.error('[MikrotikRouterMatcher] ensureSchema error:', e.message);
    }
  }
}

/**
 * Scan 1 router untuk dapat:
 *   - ARP table (IP → MAC mapping, untuk match static_ip)
 *   - PPP active sessions (untuk match pppoe_username yang lagi connect)
 *   - PPP secrets (untuk match pppoe_username yang punya akun di sini)
 *
 * Returns: { device_id, arp: Set<ip>, activePPP: Set<name>, secrets: Set<name>, error }
 */
async function scanRouter(device) {
  const result = {
    device_id: device.id,
    device_name: device.name,
    arp: new Set(),
    activePPP: new Set(),
    secrets: new Set(),
    error: null
  };
  let api;
  try {
    api = await IsolirService.connectDevice(device);

    // ── ARP scan (untuk static IP match) ──
    try {
      const arpRows = await runWithRetry(api, ['/ip/arp/print']);
      for (const r of arpRows) {
        if (r.address) result.arp.add(String(r.address).trim());
      }
    } catch (e) {
      result.error = `ARP: ${e.message}`;
    }

    // ── PPP active sessions (untuk PPPoE yang lagi online) ──
    try {
      const pppActive = await runWithRetry(api, ['/ppp/active/print']);
      for (const r of pppActive) {
        if (r.name) result.activePPP.add(String(r.name).trim());
      }
    } catch (e) {
      // tidak fatal, mungkin router static-IP-only
    }

    // ── PPP secrets (untuk PPPoE yang punya akun tapi belum connect) ──
    try {
      const pppSecrets = await runWithRetry(api, ['/ppp/secret/print']);
      for (const r of pppSecrets) {
        if (r.name) result.secrets.add(String(r.name).trim());
      }
    } catch (e) {
      // tidak fatal
    }
  } catch (e) {
    result.error = `Connect: ${e.message}`;
  } finally {
    if (api) { try { api.close(); } catch(_) {} }
  }

  return result;
}

/**
 * Scan SEMUA router aktif secara paralel, return cache.
 * Cache structure: array dari hasil scanRouter per device.
 */
async function scanAllRouters() {
  // Ambil semua extension isolir + JOIN devices (master) yang aktif & MikroTik.
  // Filter MikroTik longgar: brand starts with 'mikrotik' (case-insensitive)
  // OR name mengandung 'mikrotik' (handle brand=NULL).
  // Hasilnya di-map ke virtual device object yang dipahami connectDevice().
  const extRows = await sequelize.query(
    `SELECT md.id FROM mikrotik_devices md
     INNER JOIN devices d ON d.id = md.device_id
     WHERE d.is_active=1 AND d.type='router'
       AND (
            LOWER(TRIM(COALESCE(d.brand,''))) LIKE 'mikrotik%'
         OR LOWER(COALESCE(d.name,'')) LIKE '%mikrotik%'
       )
     ORDER BY d.name`,
    { type: sequelize.QueryTypes.SELECT }
  );
  if (extRows.length === 0) return [];

  // Load tiap device pakai loader gabungan
  const devices = [];
  for (const row of extRows) {
    const dev = await IsolirService.loadDeviceWithMaster(row.id, true);
    if (dev) devices.push(dev);
  }
  if (devices.length === 0) return [];

  // Paralel — semua router di-scan bersamaan
  const results = await Promise.all(devices.map(d => scanRouter(d)));
  return results;
}

/**
 * Dari cache scan, cari router yang match dengan 1 customer.
 *
 * @returns { device_id, device_name, method, evidence } | null
 *   method: 'arp' | 'active_ppp' | 'ppp_secret' | null
 *   evidence: string deskripsi match (untuk audit)
 */
function findRouterForCustomer(customer, cache) {
  const staticIp  = customer.static_ip ? String(customer.static_ip).trim() : null;
  const pppoeName = customer.pppoe_username ? String(customer.pppoe_username).trim() : null;

  // ── Tier 1: ARP match (static IP, paling akurat — IP lagi online di router) ──
  if (staticIp) {
    for (const router of cache) {
      if (router.arp.has(staticIp)) {
        return {
          device_id: router.device_id,
          device_name: router.device_name,
          method: 'arp',
          evidence: `IP ${staticIp} terdeteksi di ARP table router "${router.device_name}"`
        };
      }
    }
  }

  // ── Tier 2: PPP active match (PPPoE user lagi online) ──
  if (pppoeName) {
    for (const router of cache) {
      if (router.activePPP.has(pppoeName)) {
        return {
          device_id: router.device_id,
          device_name: router.device_name,
          method: 'active_ppp',
          evidence: `PPPoE "${pppoeName}" aktif di router "${router.device_name}"`
        };
      }
    }
  }

  // ── Tier 3: PPP secret match (akun PPPoE ada di router walau belum connect) ──
  if (pppoeName) {
    const matches = [];
    for (const router of cache) {
      if (router.secrets.has(pppoeName)) {
        matches.push(router);
      }
    }
    if (matches.length === 1) {
      return {
        device_id: matches[0].device_id,
        device_name: matches[0].device_name,
        method: 'ppp_secret',
        evidence: `PPP secret "${pppoeName}" ditemukan di router "${matches[0].device_name}"`
      };
    } else if (matches.length > 1) {
      // Ambigu — secret ada di banyak router. Skip, admin handle manual.
      return {
        device_id: null,
        method: null,
        evidence: `PPP secret "${pppoeName}" ada di ${matches.length} router (${matches.map(m=>m.device_name).join(', ')}) — perlu manual review`,
        conflict: true,
        conflictRouters: matches.map(m => ({ id: m.device_id, name: m.device_name }))
      };
    }
  }

  return null;
}

/**
 * Preview batch detection: scan semua router + match semua customer NULL mikrotik_id.
 * TIDAK menyimpan ke DB — hanya return rencana.
 *
 * @returns {
 *   scanned_routers: [{ device_id, device_name, arp_count, active_count, secret_count, error }],
 *   detected:        [{ customer_id, cid, name, static_ip, pppoe_username, suggested_device_id, method, evidence }],
 *   conflicts:       [...] // PPPoE ada di banyak router
 *   no_match:        [{ customer_id, cid, name, static_ip, pppoe_username, reason }]
 * }
 */
async function previewBatchDetect() {
  // ── Step 1: scan semua router ──
  const cache = await scanAllRouters();
  const routerSummary = cache.map(r => ({
    device_id: r.device_id,
    device_name: r.device_name,
    arp_count: r.arp.size,
    active_count: r.activePPP.size,
    secret_count: r.secrets.size,
    error: r.error
  }));

  // ── Step 2: ambil customer yang belum di-assign router ──
  const customers = await sequelize.query(
    `SELECT id, customer_id, name, static_ip, pppoe_username
       FROM customers
      WHERE mikrotik_id IS NULL
        AND status != 'inactive'
        AND ( (static_ip IS NOT NULL AND static_ip != '')
           OR (pppoe_username IS NOT NULL AND pppoe_username != '') )
      ORDER BY name`,
    { type: sequelize.QueryTypes.SELECT }
  );

  const detected = [];
  const conflicts = [];
  const no_match = [];

  for (const cust of customers) {
    const match = findRouterForCustomer(cust, cache);

    if (!match) {
      no_match.push({
        customer_id: cust.id,
        cid: cust.customer_id,
        name: cust.name,
        static_ip: cust.static_ip,
        pppoe_username: cust.pppoe_username,
        reason: 'Tidak ditemukan di ARP/PPP table router manapun'
      });
    } else if (match.conflict) {
      conflicts.push({
        customer_id: cust.id,
        cid: cust.customer_id,
        name: cust.name,
        static_ip: cust.static_ip,
        pppoe_username: cust.pppoe_username,
        evidence: match.evidence,
        possible_routers: match.conflictRouters
      });
    } else {
      detected.push({
        customer_id: cust.id,
        cid: cust.customer_id,
        name: cust.name,
        static_ip: cust.static_ip,
        pppoe_username: cust.pppoe_username,
        suggested_device_id: match.device_id,
        suggested_device_name: match.device_name,
        method: match.method,
        evidence: match.evidence
      });
    }
  }

  return {
    scanned_routers: routerSummary,
    total_routers: cache.length,
    total_customers: customers.length,
    detected,
    conflicts,
    no_match
  };
}

/**
 * Apply batch detection: simpan hasil ke DB.
 *
 * @param {Array} decisions - [{ customer_id, device_id, method }] dari preview
 * @returns { applied, failed }
 */
async function applyBatchDetect(decisions) {
  let applied = 0, failed = 0;
  for (const d of decisions) {
    if (!d.customer_id || !d.device_id) { failed++; continue; }
    try {
      await sequelize.query(
        `UPDATE customers
            SET mikrotik_id = ?,
                mikrotik_detection_method = ?,
                mikrotik_detected_at = NOW()
          WHERE id = ? AND mikrotik_id IS NULL`,
        { replacements: [d.device_id, d.method || 'manual', d.customer_id] }
      );
      applied++;
    } catch (e) {
      console.error('[MikrotikRouterMatcher] apply error customer', d.customer_id, ':', e.message);
      failed++;
    }
  }
  return { applied, failed };
}

/**
 * Detect router untuk 1 customer secara on-demand (live scan).
 * Dipakai dari tombol "🔍 Detect" per-customer.
 */
async function detectSingle(customerId) {
  const rows = await sequelize.query(
    `SELECT id, customer_id, name, static_ip, pppoe_username
       FROM customers WHERE id = ? LIMIT 1`,
    { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
  );
  const cust = rows[0];
  if (!cust) throw new Error('Customer tidak ditemukan');
  if (!cust.static_ip && !cust.pppoe_username) {
    throw new Error('Customer belum punya Static IP atau PPPoE Username');
  }

  const cache = await scanAllRouters();
  const match = findRouterForCustomer(cust, cache);

  if (!match || match.conflict) {
    return {
      success: false,
      cache_summary: cache.map(r => ({
        name: r.device_name,
        arp_count: r.arp.size,
        active_count: r.activePPP.size,
        secret_count: r.secrets.size
      })),
      conflict: !!(match && match.conflict),
      evidence: match?.evidence || 'Tidak ditemukan di router manapun'
    };
  }

  // Save ke DB
  await sequelize.query(
    `UPDATE customers
        SET mikrotik_id = ?,
            mikrotik_detection_method = ?,
            mikrotik_detected_at = NOW()
      WHERE id = ?`,
    { replacements: [match.device_id, match.method, customerId] }
  );

  return {
    success: true,
    device_id: match.device_id,
    device_name: match.device_name,
    method: match.method,
    evidence: match.evidence
  };
}

// Run schema migration on module load
ensureSchema();

module.exports = {
  ensureSchema,
  scanAllRouters,
  scanRouter,
  findRouterForCustomer,
  previewBatchDetect,
  applyBatchDetect,
  detectSingle,
};
