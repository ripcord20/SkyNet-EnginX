'use strict';

/**
 * OltController.js
 * ─────────────────────────────────────────────────────────────────────
 * Controller untuk:
 *  - Manajemen konfigurasi OLT (CRUD)
 *  - Sync ONT dari OLT via SNMP (tanpa GenieACS)
 *  - Test koneksi ke OLT
 *
 * Routes (tambahkan ke api.js):
 *   GET    /api/olt              → index (list semua OLT)
 *   POST   /api/olt              → create OLT config
 *   PUT    /api/olt/:id          → update OLT config
 *   DELETE /api/olt/:id          → delete OLT config
 *   POST   /api/olt/:id/test     → test koneksi SNMP
 *   POST   /api/olt/:id/sync     → sync ONT dari OLT ini
 *   POST   /api/olt/sync-all     → sync semua OLT
 * ─────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const { OntDevice, OntSignalHistory, Notification } = require('../models');
const HsgqOltService = require('../services/HsgqOltService');
const logger = require('../utils/logger');
const ConfigCrypto = require('../utils/ConfigCrypto');

// Simpan konfigurasi OLT ke file JSON (bisa diganti ke DB kalau mau)
const OLT_CONFIG_PATH = path.join(__dirname, '../../uploads/olt_config.json');

// ── Config helpers ────────────────────────────────────────────────────────
// ConfigCrypto handles community/password encryption transparently, and
// returns legacy plaintext files as-is (they'll re-encrypt on next save).
function loadOltConfigs() {
  return ConfigCrypto.load(OLT_CONFIG_PATH, []);
}

function saveOltConfigs(configs) {
  ConfigCrypto.save(OLT_CONFIG_PATH, configs);
}

// ── OLT Service factory ───────────────────────────────────────────────────
function createOltService(cfg) {
  // Saat ini support HSGQ, bisa ditambah brand lain di sini
  switch ((cfg.brand || 'hsgq').toLowerCase()) {
    case 'hsgq':
    default:
      return new HsgqOltService({
        host:      cfg.host,
        community: cfg.community || 'public',
        port:      cfg.snmpPort  || 161,
        timeout:   cfg.timeout   || 10000,
        retries:   cfg.retries   || 2,
        name:      cfg.name      || cfg.host,
        mibMode:   cfg.mibMode   || 'auto',
      });
  }
}

// ── Controller ────────────────────────────────────────────────────────────
class OltController {

  // GET /api/olt
  index(req, res) {
    const configs = loadOltConfigs();
    // Jangan return password/community ke client mentah
    const safe = configs.map(c => ({
      id:        c.id,
      name:      c.name,
      host:      c.host,
      brand:     c.brand || 'hsgq',
      snmpPort:  c.snmpPort  || 161,
      mibMode:   c.mibMode   || 'auto',
      enabled:   c.enabled   !== false,
      lastSync:  c.lastSync  || null,
      ontCount:  c.ontCount  || 0,
    }));
    res.json({ success: true, data: safe });
  }

  // POST /api/olt
  create(req, res) {
    try {
      const { name, host, community, brand, snmpPort, mibMode, timeout } = req.body;
      if (!host) return res.status(400).json({ success: false, message: 'Host wajib diisi' });

      const configs = loadOltConfigs();
      const newCfg = {
        id:        Date.now(),
        name:      name || host,
        host,
        brand:     brand     || 'hsgq',
        community: community || 'public',
        snmpPort:  parseInt(snmpPort)  || 161,
        mibMode:   mibMode   || 'auto',
        timeout:   parseInt(timeout)   || 10000,
        enabled:   true,
        createdAt: new Date().toISOString(),
      };
      configs.push(newCfg);
      saveOltConfigs(configs);
      res.json({ success: true, data: { ...newCfg, community: undefined }, message: 'OLT berhasil ditambahkan' });
    } catch(err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // PUT /api/olt/:id
  update(req, res) {
    try {
      const id = parseInt(req.params.id);
      const configs = loadOltConfigs();
      const idx = configs.findIndex(c => c.id === id);
      if (idx === -1) return res.status(404).json({ success: false, message: 'OLT tidak ditemukan' });

      const { name, host, community, brand, snmpPort, mibMode, timeout, enabled } = req.body;
      configs[idx] = {
        ...configs[idx],
        name:      name      ?? configs[idx].name,
        host:      host      ?? configs[idx].host,
        brand:     brand     ?? configs[idx].brand,
        snmpPort:  snmpPort  ? parseInt(snmpPort)  : configs[idx].snmpPort,
        mibMode:   mibMode   ?? configs[idx].mibMode,
        timeout:   timeout   ? parseInt(timeout)   : configs[idx].timeout,
        enabled:   enabled   !== undefined ? enabled : configs[idx].enabled,
        updatedAt: new Date().toISOString(),
        // Hanya update community kalau dikirim (tidak kosong)
        ...(community ? { community } : {}),
      };
      saveOltConfigs(configs);
      res.json({ success: true, message: 'OLT berhasil diupdate' });
    } catch(err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // DELETE /api/olt/:id
  destroy(req, res) {
    try {
      const id = parseInt(req.params.id);
      const configs = loadOltConfigs();
      const filtered = configs.filter(c => c.id !== id);
      if (filtered.length === configs.length) {
        return res.status(404).json({ success: false, message: 'OLT tidak ditemukan' });
      }
      saveOltConfigs(filtered);
      res.json({ success: true, message: 'OLT dihapus' });
    } catch(err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/olt/:id/test
  async test(req, res) {
    try {
      const id = parseInt(req.params.id);
      const configs = loadOltConfigs();
      const cfg = configs.find(c => c.id === id);
      if (!cfg) return res.status(404).json({ success: false, message: 'OLT tidak ditemukan' });

      const svc    = createOltService(cfg);
      const result = await svc.testConnection();
      res.json(result);
    } catch(err) {
      res.json({ success: false, error: err.message });
    }
  }

  // POST /api/olt/:id/sync
  // Sync ONT dari satu OLT → simpan ke tabel ont_devices
  async sync(req, res) {
    try {
      const id = parseInt(req.params.id);
      const configs = loadOltConfigs();
      const cfgIdx = configs.findIndex(c => c.id === id);
      if (cfgIdx === -1) return res.status(404).json({ success: false, message: 'OLT tidak ditemukan' });

      const cfg = configs[cfgIdx];
      res.json({ success: true, message: `Sync OLT ${cfg.name} dimulai di background` });

      // Jalankan sync di background (tidak block response)
      setImmediate(() => this._doSync(cfg, cfgIdx, configs).catch(e =>
        logger.error(`[OltController] Sync error ${cfg.name}:`, e)
      ));
    } catch(err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/olt/sync-all
  async syncAll(req, res) {
    const configs = loadOltConfigs().filter(c => c.enabled !== false);
    if (!configs.length) {
      return res.json({ success: true, message: 'Tidak ada OLT yang dikonfigurasi' });
    }
    res.json({ success: true, message: `Sync ${configs.length} OLT dimulai di background` });
    setImmediate(async () => {
      const allCfgs = loadOltConfigs();
      for (const cfg of configs) {
        const idx = allCfgs.findIndex(c => c.id === cfg.id);
        await this._doSync(cfg, idx, allCfgs).catch(e =>
          logger.error(`[OltController] Sync error ${cfg.name}:`, e)
        );
      }
    });
  }

  // ── Core sync logic ────────────────────────────────────────────────
  async _doSync(cfg, cfgIdx, configs) {
    logger.info(`[OltController] Mulai sync OLT: ${cfg.name} (${cfg.host})`);
    const startTime = Date.now();

    const svc = createOltService(cfg);
    const onts = await svc.getAllONTs();
    logger.info(`[OltController] ${cfg.name}: ${onts.length} ONT ditemukan`);

    let created = 0, updated = 0, offline = 0;

    for (const ont of onts) {
      try {
        // Upsert berdasarkan serial_number
        const [record, isNew] = await OntDevice.findOrCreate({
          where: { serial_number: ont.serial_number },
          defaults: {
            serial_number:   ont.serial_number,
            manufacturer:    ont.manufacturer,
            model:           ont.model,
            firmware:        ont.firmware,
            status:          ont.status,
            signal_strength: ont.signal_strength,
            ip_address:      ont.ip_address,
            mac_address:     ont.mac_address,
            uptime:          ont.uptime,
            last_inform:     ont.last_inform,
            last_synced:     ont.last_synced,
            tr069_params:    ont.tr069_params,
            // device_id pakai format olt_id:index untuk source tracking
            device_id:       `olt${cfg.id}:${ont.olt_index}`,
          }
        });

        if (isNew) {
          created++;
        } else {
          // Cek status change untuk notifikasi
          const prevStatus = record.status;

          await record.update({
            model:           ont.model           || record.model,
            firmware:        ont.firmware        || record.firmware,
            status:          ont.status,
            signal_strength: ont.signal_strength,
            ip_address:      ont.ip_address      || record.ip_address,
            mac_address:     ont.mac_address     || record.mac_address,
            uptime:          ont.uptime,
            last_inform:     ont.last_inform,
            last_synced:     ont.last_synced,
            tr069_params:    ont.tr069_params,
            device_id:       record.device_id    || `olt${cfg.id}:${ont.olt_index}`,
          });

          // Notifikasi jika ONT baru offline
          if (prevStatus === 'online' && ont.status === 'offline') {
            offline++;
            await Notification.create({
              type:    'ont_offline',
              title:   `ONT Offline: ${ont.serial_number}`,
              message: `ONT ${ont.serial_number} dari OLT ${cfg.name} tidak merespons (RX: ${ont.signal_strength ?? 'N/A'} dBm)`,
              data:    JSON.stringify({ serial: ont.serial_number, olt: cfg.name }),
            }).catch(() => {}); // silent if notifications table not ready
          }

          updated++;
        }

        // Simpan signal history jika ada sinyal
        if (ont.signal_strength !== null && ont.signal_strength !== undefined) {
          await OntSignalHistory.create({
            ont_device_id: record.id,
            rx_power:      ont.signal_strength,
            tx_power:      ont.tr069_params?.tx_power   || null,
            olt_rx_power:  ont.tr069_params?.olt_rx_power || null,
            recorded_at:   new Date(),
          }).catch(() => {}); // silent jika model belum ada kolom
        }

      } catch(e) {
        logger.error(`[OltController] Error upsert ONT ${ont.serial_number}:`, e.message);
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Update config dengan stats sync terakhir
    if (cfgIdx >= 0 && configs[cfgIdx]) {
      configs[cfgIdx].lastSync  = new Date().toISOString();
      configs[cfgIdx].ontCount  = onts.length;
      configs[cfgIdx].lastError = null;
      saveOltConfigs(configs);
    }

    logger.info(`[OltController] Sync selesai ${cfg.name}: ${created} baru, ${updated} update, ${offline} offline — ${elapsed}s`);
    return { created, updated, offline, total: onts.length, elapsed };
  }
}

module.exports = new OltController();