// ════════════════════════════════════════════════════════════════════
//  TrafficHistoryService
//  Menyimpan sampel traffic (rx/tx bps) per interface hotspot tiap router,
//  lalu menyediakan agregasi (avg & peak) per jam/hari untuk analisis kapasitas.
//
//  Tabel: hotspot_traffic_log (device_id, interface, rx_bps, tx_bps, sampled_at)
//  Sampler dipanggil cron tiap 5 menit. Retensi default 30 hari.
// ════════════════════════════════════════════════════════════════════
const { sequelize } = require('../models');
const { getMikrotikInstanceByDevice } = require('./MikrotikService');
const HotspotService = require('./HotspotService');

let _schemaReady = false;
async function ensureSchema() {
  if (_schemaReady) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS hotspot_traffic_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NULL,
      \`interface\` VARCHAR(64) NOT NULL,
      rx_bps BIGINT DEFAULT 0,
      tx_bps BIGINT DEFAULT 0,
      sampled_at DATETIME NOT NULL,
      INDEX idx_dev_if_time (device_id, \`interface\`, sampled_at),
      INDEX idx_time (sampled_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});
  _schemaReady = true;
}

// Ambil daftar device aktif (mikrotik_devices) untuk disampling.
async function _activeDevices() {
  const rows = await sequelize.query(
    `SELECT id, device_id FROM mikrotik_devices WHERE is_active=1`,
    { type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  return rows || [];
}

// Sampler: untuk tiap device, ambil interface hotspot + rate-nya, simpan.
async function sample() {
  try {
    await ensureSchema();
    const devices = await _activeDevices();
    const now = new Date();
    const rows = [];

    // Interface preset NMS yang perlu direkam (per device_id → set nama interface)
    let nmsByDevice = {};
    try {
      const { NmsInterfacePreset } = require('../models');
      const presets = await NmsInterfacePreset.findAll({ attributes: ['router_id', 'iface_name'] });
      presets.forEach(p => { (nmsByDevice[p.router_id] = nmsByDevice[p.router_id] || new Set()).add(p.iface_name); });
    } catch (_) { nmsByDevice = {}; }

    for (const dev of devices) {
      try {
        const devId = dev.id;
        const mt = await getMikrotikInstanceByDevice(dev.device_id || dev.id);
        const hs = new HotspotService(mt);
        const [servers, ifaces] = await Promise.all([hs.getServers(), mt.getInterfaces()]);
        const ifMap = {}; for (const i of ifaces) ifMap[i.name] = i;
        const seen = new Set();
        // 1) interface hotspot (perilaku lama)
        for (const s of servers) {
          const name = s.interface;
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const st = await mt.getInterfaceStats(name).catch(() => null);
          if (!st) continue;
          rows.push([devId, name, Math.round(+st.rxBitsPerSecond || 0), Math.round(+st.txBitsPerSecond || 0), now]);
        }
        // 2) interface preset NMS (yang belum terekam dari hotspot)
        const nmsSet = nmsByDevice[devId];
        if (nmsSet) {
          for (const name of nmsSet) {
            if (!name || seen.has(name)) continue;
            seen.add(name);
            const st = await mt.getInterfaceStats(name).catch(() => null);
            if (!st) continue;
            rows.push([devId, name, Math.round(+st.rxBitsPerSecond || 0), Math.round(+st.txBitsPerSecond || 0), now]);
          }
        }
      } catch (_) { /* skip device error */ }
    }
    if (rows.length) {
      await sequelize.query(
        `INSERT INTO hotspot_traffic_log (device_id, \`interface\`, rx_bps, tx_bps, sampled_at) VALUES ?`,
        { replacements: [rows] }
      ).catch(() => {});
    }
    return rows.length;
  } catch (e) {
    console.error('[TrafficHistory] sample error:', e.message);
    return 0;
  }
}

// Hapus sampel lebih tua dari N hari (default 30).
async function prune(days = 30) {
  await ensureSchema();
  await sequelize.query(
    `DELETE FROM hotspot_traffic_log WHERE sampled_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    { replacements: [days] }
  ).catch(() => {});
}

// Agregasi histori: range '24h' (per jam) atau '7d'/'30d' (per hari).
// Return: { interface, points:[{t, rxAvg, txAvg, rxPeak, txPeak}] }
async function history({ deviceId, iface, range = '24h' }) {
  await ensureSchema();
  let intervalExpr, sinceExpr, fmt;
  if (range === '7d')      { intervalExpr = "DATE_FORMAT(sampled_at,'%Y-%m-%d')";    sinceExpr = '7 DAY';  fmt = 'day'; }
  else if (range === '30d'){ intervalExpr = "DATE_FORMAT(sampled_at,'%Y-%m-%d')";    sinceExpr = '30 DAY'; fmt = 'day'; }
  else if (range === '3d') { intervalExpr = "DATE_FORMAT(sampled_at,'%Y-%m-%d %H:00')"; sinceExpr = '3 DAY';  fmt = 'hour'; }
  else                     { intervalExpr = "DATE_FORMAT(sampled_at,'%Y-%m-%d %H:00')"; sinceExpr = '24 HOUR'; fmt = 'hour'; } // 1d / 24h

  const where = ['sampled_at >= DATE_SUB(NOW(), INTERVAL ' + sinceExpr + ')'];
  const repl = [];
  if (deviceId) { where.push('device_id = ?'); repl.push(deviceId); }
  if (iface)    { where.push('`interface` = ?'); repl.push(iface); }

  const rows = await sequelize.query(
    `SELECT ${intervalExpr} AS bucket,
            AVG(rx_bps) AS rxAvg, AVG(tx_bps) AS txAvg,
            MAX(rx_bps) AS rxPeak, MAX(tx_bps) AS txPeak,
            COUNT(*) AS samples
       FROM hotspot_traffic_log
      WHERE ${where.join(' AND ')}
      GROUP BY bucket
      ORDER BY bucket ASC`,
    { replacements: repl, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);

  return {
    range, fmt, iface: iface || null,
    points: (rows || []).map(r => ({
      t: r.bucket,
      rxAvg: Math.round(+r.rxAvg || 0), txAvg: Math.round(+r.txAvg || 0),
      rxPeak: Math.round(+r.rxPeak || 0), txPeak: Math.round(+r.txPeak || 0),
      samples: +r.samples || 0,
    })),
  };
}

// Daftar interface yang punya histori (untuk dropdown).
async function interfaces(deviceId) {
  await ensureSchema();
  const where = ['sampled_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'];
  const repl = [];
  if (deviceId) { where.push('device_id = ?'); repl.push(deviceId); }
  const rows = await sequelize.query(
    `SELECT DISTINCT \`interface\` FROM hotspot_traffic_log WHERE ${where.join(' AND ')} ORDER BY \`interface\``,
    { replacements: repl, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  return (rows || []).map(r => r.interface);
}

module.exports = { ensureSchema, sample, prune, history, interfaces };
