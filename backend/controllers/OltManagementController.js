'use strict';

/**
 * OltManagementController.js
 * ─────────────────────────────────────────────────────────────────────
 * Controller untuk OLT Management (live CLI ke ZTE C320/C300).
 *
 * Berbeda dari OltController (SNMP read-only HSGQ), controller ini
 * terhubung langsung ke CLI OLT untuk membaca status ONU, redaman, dan
 * melakukan aksi (authorize, edit, reboot, hapus ONU).
 *
 * Routes (lihat api.js):
 *   GET    /api/olt-mgmt                       → list OLT terdaftar
 *   POST   /api/olt-mgmt                       → tambah OLT
 *   PUT    /api/olt-mgmt/:id                   → edit OLT
 *   DELETE /api/olt-mgmt/:id                   → hapus OLT
 *   POST   /api/olt-mgmt/:id/test              → test koneksi CLI
 *   GET    /api/olt-mgmt/:id/cards             → daftar slot/kartu
 *   GET    /api/olt-mgmt/:id/onus?pon=1/2/1    → daftar ONU pada PON port
 *   GET    /api/olt-mgmt/:id/uncfg             → ONU belum terdaftar
 *   GET    /api/olt-mgmt/:id/onu/detail?if=... → detail satu ONU
 *   GET    /api/olt-mgmt/:id/onu/power?if=...  → redaman satu ONU
 *   POST   /api/olt-mgmt/:id/onu/authorize     → tambah/authorize ONU
 *   PUT    /api/olt-mgmt/:id/onu/edit          → edit nama/deskripsi ONU
 *   POST   /api/olt-mgmt/:id/onu/reboot        → reboot ONU
 *   DELETE /api/olt-mgmt/:id/onu               → hapus ONU
 * ─────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const ZteOltService = require('../services/ZteOltService');
const CdataOltService = require('../services/CdataOltService');
const HiosoOltService = require('../services/HiosoOltService');
const ZimmlinkOltService = require('../services/ZimmlinkOltService');
const HsgqEponOltService = require('../services/HsgqEponOltService');
const ZteSnmpService = require('../services/ZteSnmpService');
const ConfigCrypto = require('../utils/ConfigCrypto');
const oltQueue = require('../services/OltQueue');
const logger = require('../utils/logger');
const { logOltAction } = require('../middleware/activityLogger');

// Merek yang memakai pola interface ZTE (frame/slot/port:onu).
// Merek lain (chipset/EPON) memakai pola port/onu_id.
const ZTE_STYLE = new Set(['zte']);
function isZteStyle(brand) { return ZTE_STYLE.has(String(brand || 'zte').toLowerCase()); }
// Merek EPON (ONU diidentifikasi via MAC, bukan SN GPON).
const EPON_BRANDS = new Set(['hsgq']);
function isEpon(brand) { return EPON_BRANDS.has(String(brand || '').toLowerCase()); }

const CONFIG_PATH = path.join(__dirname, '../../uploads/olt_mgmt_config.json');
// Cache hasil discover terakhir per OLT (tidak berisi credential, jadi plain JSON).
// Tujuan: data ONU langsung tampil saat halaman dibuka tanpa menunggu scan live.
const CACHE_PATH  = path.join(__dirname, '../../uploads/olt_mgmt_cache.json');

const fs = require('fs');

// ── Config helpers (terenkripsi via ConfigCrypto) ──────────────────────────
function loadConfigs() {
  return ConfigCrypto.load(CONFIG_PATH, []);
}
function saveConfigs(cfgs) {
  ConfigCrypto.save(CONFIG_PATH, cfgs);
}

// ── Cache helpers (snapshot discover terakhir) ─────────────────────────────
function loadCacheAll() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) || {};
  } catch (e) { return {}; }
}
function getCache(oltId) {
  const all = loadCacheAll();
  return all[String(oltId)] || null;
}
function setCache(oltId, payload) {
  try {
    const all = loadCacheAll();
    all[String(oltId)] = { ...payload, cachedAt: new Date().toISOString() };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(all), 'utf8');
  } catch (e) { logger.warn('[OltMgmt] Gagal simpan cache: ' + e.message); }
}
function clearCache(oltId) {
  try {
    const all = loadCacheAll();
    if (all[String(oltId)]) { delete all[String(oltId)]; fs.writeFileSync(CACHE_PATH, JSON.stringify(all), 'utf8'); }
  } catch (e) { /* abaikan */ }
}

// Versi aman untuk dikirim ke client (tanpa credential)
function toSafe(c) {
  return {
    id:       c.id,
    name:     c.name,
    host:     c.host,
    brand:    c.brand    || 'zte',
    style:    isZteStyle(c.brand) ? 'zte' : 'chipset',
    epon:     isEpon(c.brand),
    protocol: c.protocol || 'telnet',
    port:     c.port,
    username: c.username || '',
    enabled:  c.enabled  !== false,
    hasEnablePassword: !!c.enablePassword,
    snmpEnabled: !!c.snmpEnabled,
    snmpCommunity: c.snmpCommunity ? '••••' : '',
    snmpPort: c.snmpPort || 161,
    lastTest: c.lastTest || null,
    lastStatus: c.lastStatus || null,
    createdAt: c.createdAt || null,
  };
}

// ── Service factory ────────────────────────────────────────────────────────
function makeService(cfg) {
  const opts = {
    host:           cfg.host,
    protocol:       cfg.protocol || 'telnet',
    port:           cfg.port,
    username:       cfg.username,
    password:       cfg.password,
    enablePassword: cfg.enablePassword,
    timeout:        cfg.timeout || 15000,
    name:           cfg.name || cfg.host,
    brand:          cfg.brand,
  };
  let svc;
  switch ((cfg.brand || 'zte').toLowerCase()) {
    case 'cdata':    svc = new CdataOltService(opts); break;
    case 'hioso':    svc = new HiosoOltService(opts); break;
    case 'zimmlink': svc = new ZimmlinkOltService(opts); break;
    case 'hsgq':     svc = new HsgqEponOltService(opts); break;
    case 'zte':
    default:         svc = new ZteOltService(opts); break;
  }
  return _serialize(svc, cfg);
}

// Bungkus service agar seluruh span connect→…→disconnect ke SATU OLT berjalan
// EKSKLUSIF (tidak tumpang tindih dengan request lain ke OLT yang sama).
// Key antrian = host:port, jadi OLT berbeda tetap paralel.
function _serialize(svc, cfg) {
  const key = `${cfg.host}:${cfg.port || (String(cfg.protocol).toLowerCase() === 'ssh' ? 22 : 23)}`;
  const realConnect = svc.connect.bind(svc);
  const realDisconnect = svc.disconnect.bind(svc);

  svc.connect = function () {
    // Minta slot eksklusif untuk OLT ini. Slot dipegang sampai disconnect().
    return new Promise((resolveConnect, rejectConnect) => {
      // run() menjalankan callback secara serial per-key. Kita TAHAN penyelesaian
      // run() (lewat promise `held`) hingga disconnect() dipanggil, sehingga
      // request lain ke OLT yang sama menunggu giliran.
      let releaseSlot;
      const held = new Promise((res) => { releaseSlot = res; });
      svc.__releaseSlot = releaseSlot;

      oltQueue.run(key, async () => {
        try {
          await realConnect();          // koneksi fisik di dalam slot
          resolveConnect(true);          // beri tahu pemanggil: koneksi siap
        } catch (e) {
          resolveConnect = null;
          rejectConnect(e);              // gagal connect → bebaskan slot segera
          releaseSlot();
          throw e;
        }
        await held;                      // tahan slot sampai disconnect()
      }).catch(() => { /* error sudah diteruskan ke pemanggil */ });
    });
  };

  svc.disconnect = async function () {
    try { await realDisconnect(); }
    finally {
      // Bebaskan slot antrian agar operasi berikutnya ke OLT ini bisa jalan.
      if (typeof svc.__releaseSlot === 'function') { svc.__releaseSlot(); svc.__releaseSlot = null; }
    }
  };

  return svc;
}

// SNMP tersedia untuk ZTE bila dikonfigurasi. Dipakai untuk operasi BACA.
function snmpAvailable(cfg) {
  return isZteStyle(cfg.brand) && cfg.snmpEnabled && cfg.snmpCommunity;
}
function makeSnmp(cfg) {
  return new ZteSnmpService({
    host: cfg.host,
    snmpCommunity: cfg.snmpCommunity,
    snmpVersion: cfg.snmpVersion,
    snmpPort: cfg.snmpPort,
    name: cfg.name || cfg.host,
    timeout: 8000,
  });
}

function getCfgOr404(req, res) {
  const id = parseInt(req.params.id);
  const cfg = loadConfigs().find(c => c.id === id);
  if (!cfg) { res.status(404).json({ success: false, message: 'OLT tidak ditemukan' }); return null; }
  return cfg;
}

class OltManagementController {

  // ── CRUD OLT ──────────────────────────────────────────────────────
  index(req, res) {
    try {
      res.json({ success: true, data: loadConfigs().map(toSafe) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  create(req, res) {
    try {
      const { name, host, brand, protocol, port, username, password, enablePassword, enabled,
              snmpEnabled, snmpCommunity, snmpVersion, snmpPort } = req.body;
      if (!host)     return res.status(400).json({ success: false, message: 'IP/host OLT wajib diisi' });
      if (!username) return res.status(400).json({ success: false, message: 'Username wajib diisi' });

      const proto = (protocol || 'telnet').toLowerCase();
      const cfgs = loadConfigs();
      const newCfg = {
        id:             Date.now(),
        name:           name || host,
        host,
        brand:          brand    || 'zte',
        protocol:       proto,
        port:           parseInt(port) || (proto === 'ssh' ? 22 : 23),
        username,
        password:       password || '',
        enablePassword: enablePassword || '',
        enabled:        enabled !== false,
        snmpEnabled:    !!snmpEnabled,
        snmpCommunity:  snmpCommunity || '',
        snmpVersion:    snmpVersion || '2c',
        snmpPort:       parseInt(snmpPort) || 161,
        createdAt:      new Date().toISOString(),
      };
      cfgs.push(newCfg);
      saveConfigs(cfgs);
      res.json({ success: true, message: 'OLT berhasil ditambahkan', data: toSafe(newCfg) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  update(req, res) {
    try {
      const id = parseInt(req.params.id);
      const cfgs = loadConfigs();
      const idx = cfgs.findIndex(c => c.id === id);
      if (idx === -1) return res.status(404).json({ success: false, message: 'OLT tidak ditemukan' });

      const { name, host, brand, protocol, port, username, password, enablePassword, enabled,
              snmpEnabled, snmpCommunity, snmpVersion, snmpPort } = req.body;
      const cur = cfgs[idx];
      cfgs[idx] = {
        ...cur,
        name:     name     ?? cur.name,
        host:     host     ?? cur.host,
        brand:    brand    ?? cur.brand,
        protocol: protocol ? protocol.toLowerCase() : cur.protocol,
        port:     port     ? parseInt(port) : cur.port,
        username: username ?? cur.username,
        enabled:  enabled  !== undefined ? enabled : cur.enabled,
        snmpEnabled: snmpEnabled !== undefined ? !!snmpEnabled : cur.snmpEnabled,
        snmpVersion: snmpVersion || cur.snmpVersion || '2c',
        snmpPort:    snmpPort ? parseInt(snmpPort) : (cur.snmpPort || 161),
        updatedAt: new Date().toISOString(),
        // Hanya update credential bila dikirim (tidak kosong)
        ...(password       ? { password } : {}),
        ...(enablePassword !== undefined && enablePassword !== '' ? { enablePassword } : {}),
        ...(snmpCommunity  ? { snmpCommunity } : {}),
      };
      saveConfigs(cfgs);
      res.json({ success: true, message: 'OLT berhasil diupdate', data: toSafe(cfgs[idx]) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  destroy(req, res) {
    try {
      const id = parseInt(req.params.id);
      const cfgs = loadConfigs();
      const filtered = cfgs.filter(c => c.id !== id);
      if (filtered.length === cfgs.length) {
        return res.status(404).json({ success: false, message: 'OLT tidak ditemukan' });
      }
      saveConfigs(filtered);
      clearCache(id);   // buang snapshot ONU OLT yang dihapus
      res.json({ success: true, message: 'OLT dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // ── Test koneksi CLI ──────────────────────────────────────────────
  async test(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const svc = makeService(cfg);
    try {
      const result = await svc.testConnection();
      // Simpan hasil test ke config
      const cfgs = loadConfigs();
      const idx = cfgs.findIndex(c => c.id === cfg.id);
      if (idx !== -1) {
        cfgs[idx].lastTest = new Date().toISOString();
        cfgs[idx].lastStatus = result.success ? 'ok' : 'error';
        saveConfigs(cfgs);
      }
      res.json(result);
    } catch (err) {
      res.json({ success: false, error: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Daftar kartu/slot (hanya ZTE) ─────────────────────────────────
  async cards(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) return res.json({ success: true, data: [], message: 'Tidak didukung untuk brand ini' });
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const data = await svc.getCards();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Auto-discover & muat SEMUA ONU (untuk auto-load dashboard) ─────
  // GET /api/olt-mgmt/:id/discover?power=1&ports=1/2/1,1/2/2
  // Satu koneksi: temukan PON port, ambil ONU tiap port, sistem info, dan
  // ringkasan port — supaya halaman langsung terisi tanpa input manual.
  async discover(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const withPower = req.query.power === '1' || req.query.power === 'true';
    const explicitPorts = req.query.ports
      ? String(req.query.ports).split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const maxPorts = Math.min(parseInt(req.query.maxPorts) || 32, 64);
    const cachedOnly = req.query.cached === '1' || req.query.cached === 'true';

    // ── Mode cache: kembalikan snapshot terakhir tanpa konek ke OLT ──
    // Dipakai saat halaman pertama dibuka → data langsung tampil instan.
    if (cachedOnly) {
      const snap = getCache(cfg.id);
      if (snap) return res.json({ success: true, data: snap, via: 'cache', cached: true, cachedAt: snap.cachedAt });
      return res.json({ success: true, data: null, via: 'cache', cached: false });
    }

    // ZTE + SNMP → jalur cepat & andal
    if (snmpAvailable(cfg)) {
      try {
        const snmpSvc = makeSnmp(cfg);
        const result = await snmpSvc.getAllOnus({ withPower: true, ports: explicitPorts, maxPorts });
        setCache(cfg.id, result);                                  // simpan snapshot
        return res.json({ success: true, data: { ...result, cachedAt: new Date().toISOString() }, via: 'snmp' });
      } catch (err) {
        logger.warn('[OltMgmt] SNMP discover gagal, fallback CLI: ' + err.message);
      }
    }

    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (typeof svc.getAllOnus !== 'function') {
        return res.status(400).json({ success: false, message: 'Auto-discover belum didukung untuk brand ini' });
      }
      const result = await svc.getAllOnus({ withPower, ports: explicitPorts, maxPorts });
      // Sertakan info sistem dalam koneksi yang sama (best-effort)
      let system = null;
      try { system = await svc.getSystemInfo(); } catch (e) { /* abaikan */ }
      const payload = { ...result, system };
      setCache(cfg.id, payload);                                   // simpan snapshot
      res.json({ success: true, data: { ...payload, cachedAt: new Date().toISOString() } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Daftar ONU pada PON port ──────────────────────────────────────
  // ZTE: ?pon=1/2/1 (frame/slot/port).  Chipset: ?pon=1 atau 0/1 (port).
  async onus(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const pon = req.query.pon;
    if (!pon) return res.status(400).json({ success: false, message: 'Parameter pon wajib' });
    const withPower = req.query.power === '1' || req.query.power === 'true';

    // ZTE + SNMP aktif → baca via SNMP (cepat, andal, tanpa CLI parsing)
    if (snmpAvailable(cfg)) {
      try {
        const snmpSvc = makeSnmp(cfg);
        const list = await snmpSvc.getOnuState(pon, { withPower: true });
        return res.json({ success: true, data: list, via: 'snmp' });
      } catch (err) {
        // Bila SNMP gagal, jatuh ke CLI di bawah
        logger.warn('[OltMgmt] SNMP onus gagal, fallback CLI: ' + err.message);
      }
    }

    const svc = makeService(cfg);
    try {
      await svc.connect();
      let list;

      if (isZteStyle(cfg.brand)) {
        // ZTE: getOnuState kini sudah memuat nama/SN/type dari running-config
        list = await svc.getOnuState(pon, { withNames: true });
        if (withPower) {
          for (const o of list) {
            try { const p = await svc.getOnuPower(o.onu_if); o.onu_rx_dbm = p.onu_rx_dbm; o.quality = p.quality; }
            catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
          }
        }
      } else {
        // Chipset (CDATA/HIOSO/ZIMMLINK): satu panggilan, redaman opsional di service
        list = await svc.getOnuState(pon, { withPower });
      }

      res.json({ success: true, data: list });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── ONU belum terdaftar ───────────────────────────────────────────
  async uncfg(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const pon = req.query.pon || null;  // chipset bisa per-port
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const data = isZteStyle(cfg.brand) ? await svc.getUncfgOnu() : await svc.getUncfgOnu(pon);
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Detail ONU ────────────────────────────────────────────────────
  // ZTE: ?if=1/2/5:5.  Chipset: ?pon=1&id=5  (atau ?if=1/5)
  async onuDetail(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let data;
      if (isZteStyle(cfg.brand)) {
        const onuIf = req.query.if;
        if (!onuIf) return res.status(400).json({ success: false, message: 'Parameter if wajib (mis. 1/2/5:5)' });
        const [detail, power] = await Promise.all([
          svc.getOnuDetail(onuIf),
          svc.getOnuPower(onuIf).catch(() => null),
        ]);
        data = { ...detail, power };
      } else {
        const { pon, id } = this._chipsetRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'Parameter pon & id wajib' });
        data = await svc.getOnuDetail(pon, id);  // sudah termasuk power
      }
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Redaman ONU (batch / progressive load) ────────────────────────
  // POST /api/olt-mgmt/:id/onu/power-batch  body: { ifs: ["gpon-onu_1/2/1:1", ...] }
  // Mengambil redaman untuk sekumpulan ONU dalam satu koneksi. Frontend
  // memanggil ini per-PON setelah daftar ONU tampil → redaman mengisi menyusul.
  async onuPowerBatch(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) return res.status(400).json({ success: false, message: 'Fitur ini khusus OLT ZTE' });
    let ifs = req.body?.ifs;
    if (!Array.isArray(ifs) || !ifs.length) {
      return res.status(400).json({ success: false, message: 'Body "ifs" (array interface ONU) wajib' });
    }
    // Batasi jumlah per permintaan agar tidak membebani 1 koneksi.
    if (ifs.length > 64) ifs = ifs.slice(0, 64);

    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (typeof svc.getPowerBatch !== 'function') {
        return res.status(400).json({ success: false, message: 'Batch redaman belum didukung untuk brand ini' });
      }
      const data = await svc.getPowerBatch(ifs);
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Redaman ONU ───────────────────────────────────────────────────
  async onuPower(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let data;
      if (isZteStyle(cfg.brand)) {
        const onuIf = req.query.if;
        if (!onuIf) return res.status(400).json({ success: false, message: 'Parameter if wajib' });
        data = await svc.getOnuPower(onuIf);
      } else {
        const { pon, id } = this._chipsetRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'Parameter pon & id wajib' });
        data = await svc.getOnuPower(pon, id);
      }
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // WAN IP & MAC pelanggan (ZTE)
  async onuWanInfo(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) return res.status(400).json({ success: false, message: 'Fitur ini khusus OLT ZTE' });
    const onuIf = req.query.if;
    if (!onuIf) return res.status(400).json({ success: false, message: 'Parameter if wajib' });
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const data = await svc.getOnuWanInfo(onuIf);
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // Traffic real-time satu ONU (ZTE: show interface gpon-onu_x)
  async onuTraffic(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) {
      return res.status(400).json({ success: false, message: 'Monitor traffic per-ONU saat ini untuk ZTE.' });
    }
    const onuIf = req.query.if;
    if (!onuIf) return res.status(400).json({ success: false, message: 'Parameter if wajib' });
    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (typeof svc.getOnuTraffic !== 'function') {
        return res.status(400).json({ success: false, message: 'Traffic ONU belum didukung untuk brand ini' });
      }
      const data = await svc.getOnuTraffic(onuIf);
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // Helper: ekstrak {pon,id} untuk chipset dari query (mendukung if=port/id)
  _chipsetRef(req) {
    let pon = req.query.pon, id = req.query.id;
    if ((pon == null || id == null) && req.query.if) {
      const m = String(req.query.if).match(/(\d+)\s*\/\s*(\d+)/);
      if (m) { pon = m[1]; id = m[2]; }
    }
    return { pon: pon != null ? pon : null, id: id != null ? parseInt(id) : null };
  }

  // ── Authorize / tambah ONU ────────────────────────────────────────
  // ZTE body : { gponOlt:"1/2/1", onuId, type, sn, name?, description? }
  // Chipset  : { port:"1" (atau 0/1), onuId, type, sn, name?, description? }
  async authorizeOnu(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const { gponOlt, port, onuId, type, sn, name, description } = req.body;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let result;
      if (isZteStyle(cfg.brand)) {
        result = await svc.authorizeOnu({ gponOlt, onuId, type, sn });
        if ((name || description) && result.onuIf) {
          await svc.editOnu(result.onuIf, { name, description }).catch(() => {});
        }
      } else {
        result = await svc.authorizeOnu({ port: port || gponOlt, onuId, type, sn, mac: req.body.mac || sn, name, description });
      }
      logger.info(`[OltMgmt] Authorize ONU ${sn} di OLT ${cfg.name} (${cfg.brand})`);
      logOltAction(req, { action: 'create', oltId: cfg.id, target: result?.onuIf || sn,
        description: `Authorize ONU ${sn} di OLT ${cfg.name}`, meta: { sn, type } });
      clearCache(cfg.id);
      res.json({ success: true, message: `ONU ${sn} berhasil di-authorize`, data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Baca profil OLT (untuk wizard provisioning) ───────────────────
  async profiles(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) {
      return res.json({ success: true, data: { tcont: [], traffic: [], onuTypes: [] }, note: 'Profil OLT hanya didukung untuk ZTE' });
    }
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const data = await svc.getProfiles();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // Buat/ubah profil T-CONT atau Traffic (ZTE)
  async createProfile(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) return res.status(400).json({ success: false, message: 'Fitur ini khusus OLT ZTE' });
    const { kind } = req.body;  // 'tcont' | 'traffic'
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let r;
      if (kind === 'tcont') {
        r = await svc.createTcontProfile(req.body);
      } else if (kind === 'traffic') {
        r = await svc.createTrafficProfile(req.body);
      } else {
        return res.status(400).json({ success: false, message: 'kind harus tcont/traffic' });
      }
      logger.info(`[OltMgmt] Buat profil ${kind} "${req.body.name}" di OLT ${cfg.name}`);
      res.json({ success: true, message: `Profil ${kind} "${req.body.name}" tersimpan`, data: r });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // Hapus profil T-CONT/Traffic (ZTE)
  async deleteProfile(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) return res.status(400).json({ success: false, message: 'Fitur ini khusus OLT ZTE' });
    const kind = req.body.kind || req.query.kind;
    const name = req.body.name || req.query.name;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      await svc.deleteProfile(kind, name);
      logger.info(`[OltMgmt] Hapus profil ${kind} "${name}" di OLT ${cfg.name}`);
      logOltAction(req, { action: 'delete', oltId: cfg.id, target: `${kind}:${name}`,
        description: `Hapus profil ${kind} "${name}" di OLT ${cfg.name}` });
      res.json({ success: true, message: `Profil ${kind} "${name}" dihapus` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // ── Provisioning ONU lengkap (wizard) ─────────────────────────────
  async provisionOnu(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) {
      return res.status(400).json({ success: false, message: 'Provisioning wizard saat ini untuk ZTE. Untuk merek lain gunakan Authorize + set VLAN.' });
    }
    const body = req.body;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      // onuId boleh kosong → provisionOnu akan auto-assign & retry bila bentrok.
      const result = await svc.provisionOnu({ ...body });
      const onuId = result.onuId;
      logger.info(`[OltMgmt] Provision ONU ${body.sn} (vlan ${body.vlan}, tcont ${result.tcontProfile || '-'}) di ${cfg.name}`);
      logOltAction(req, { action: 'create', oltId: cfg.id, target: result.onuIf || `${body.gponOlt}:${onuId}`,
        description: `Provision ONU ${body.sn} (ONU-id ${onuId}, VLAN ${body.vlan}) di OLT ${cfg.name}`,
        meta: { sn: body.sn, vlan: body.vlan, onuId } });
      clearCache(cfg.id);
      const profNote = result.tcontProfile ? `, profil ${result.tcontProfile}` : '';
      res.json({ success: true, message: `ONU ${body.sn} berhasil diprovisioning (ONU-id ${onuId}, VLAN ${body.vlan}${profNote})`, data: result });
    } catch (err) {
      logger.warn(`[OltMgmt] Provision ONU ${body.sn} GAGAL di ${cfg.name}: ${err.message.replace(/\n/g, ' | ')}`);
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // ── Bulk provisioning (beberapa ONU sekaligus, profil sama) ───────
  // body: { gponOlt, type, tcontProfile, trafficProfile, vlan, items:[{sn, onuId?, name?, description?}, ...] }
  async bulkProvision(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (!isZteStyle(cfg.brand)) {
      return res.status(400).json({ success: false, message: 'Bulk provisioning saat ini untuk ZTE.' });
    }
    const { gponOlt, type, tcontProfile, trafficProfile, vlan, userVlan, items } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'items wajib (daftar ONU)' });
    }
    const svc = makeService(cfg);
    const results = [];
    const assigned = new Set();   // ONU-id yang sudah dipakai dalam batch ini
    try {
      await svc.connect();
      for (const it of items) {
        try {
          let onuId = it.onuId;
          if (!onuId) {
            onuId = await svc.getNextFreeOnuId(gponOlt);
            // Hindari tabrakan dengan ONU yang baru saja diprovisioning di batch
            // ini (state OLT mungkin belum ter-refresh antar iterasi).
            while (onuId && assigned.has(onuId)) onuId += 1;
          }
          if (!onuId) throw new Error('Tidak ada ONU-id kosong pada PON ini');
          assigned.add(onuId);
          const r = await svc.provisionOnu({
            gponOlt, onuId, type: it.type || type, sn: it.sn,
            name: it.name, description: it.description,
            tcontProfile, trafficProfile, vlan, userVlan,
          });
          results.push({ sn: it.sn, success: true, onuId: r.onuId, onuIf: r.onuIf });
        } catch (e) {
          results.push({ sn: it.sn, success: false, error: e.message });
        }
      }
      const ok = results.filter(r => r.success).length;
      logger.info(`[OltMgmt] Bulk provision ${ok}/${items.length} ONU di ${cfg.name}`);
      clearCache(cfg.id);
      res.json({ success: true, message: `${ok} dari ${items.length} ONU berhasil`, data: results });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // ── Edit ONU ──────────────────────────────────────────────────────
  // ZTE: { onuIf, name?, description? }.  Chipset: { pon, id, name?, description? } (atau onuIf="port/id")
  async editOnu(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const { onuIf, name, description } = req.body;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (isZteStyle(cfg.brand)) {
        if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
        await svc.editOnu(onuIf, { name, description });
      } else {
        const { pon, id } = this._chipsetBodyRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'pon & id wajib' });
        await svc.editOnu(pon, id, { name, description });
      }
      clearCache(cfg.id);
      res.json({ success: true, message: 'ONU berhasil diupdate' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Reboot ONU ────────────────────────────────────────────────────
  async rebootOnu(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const { onuIf } = req.body;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let target = onuIf;
      if (isZteStyle(cfg.brand)) {
        if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
        await svc.rebootOnu(onuIf);
      } else {
        const { pon, id } = this._chipsetBodyRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'pon & id wajib' });
        await svc.rebootOnu(pon, id);
        target = `${pon}:${id}`;
      }
      logger.info(`[OltMgmt] Reboot ONU di OLT ${cfg.name}`);
      logOltAction(req, { action: 'reboot', oltId: cfg.id, target,
        description: `Reboot ONU ${target} (OLT ${cfg.name})` });
      clearCache(cfg.id);
      res.json({ success: true, message: 'ONU sedang reboot' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Factory reset ONU (ZTE) ───────────────────────────────────────
  async factoryResetOnu(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const { onuIf } = req.body;
    if (!isZteStyle(cfg.brand)) return res.status(400).json({ success: false, message: 'Fitur ini khusus OLT ZTE' });
    if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
    const svc = makeService(cfg);
    try {
      await svc.connect();
      await svc.factoryResetOnu(onuIf);
      logger.info(`[OltMgmt] Factory reset ONU ${onuIf} di OLT ${cfg.name}`);
      logOltAction(req, { action: 'reset', oltId: cfg.id, target: onuIf,
        description: `Factory reset ONU ${onuIf} (OLT ${cfg.name})` });
      res.json({ success: true, message: 'Perintah restore factory dikirim ke ONU' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Enable/disable port LAN ONU (ZTE) ─────────────────────────────
  async setOnuEthPort(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const { onuIf, port, enable } = req.body;
    if (!isZteStyle(cfg.brand)) return res.status(400).json({ success: false, message: 'Fitur ini khusus OLT ZTE' });
    if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const r = await svc.setOnuEthPort(onuIf, { port: port || 1, enable: enable !== false });
      logger.info(`[OltMgmt] Port LAN ${r.port} ${r.state} pada ${onuIf} di OLT ${cfg.name}`);
      logOltAction(req, { action: 'update', oltId: cfg.id, target: onuIf,
        description: `Port LAN ${r.port} di-${r.state} pada ONU ${onuIf} (OLT ${cfg.name})`,
        meta: { port: r.port, state: r.state } });
      res.json({ success: true, message: `Port LAN ${r.port} di-${r.state}`, data: r });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Verifikasi pasca-provisioning / troubleshoot (ZTE) ────────────
  async verifyOnu(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const onuIf = req.body.onuIf || req.query.if;
    if (!isZteStyle(cfg.brand)) return res.status(400).json({ success: false, message: 'Fitur ini khusus OLT ZTE' });
    if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
    const svc = makeService(cfg);
    try {
      await svc.connect();
      // tries/interval bisa dioverride dari body untuk verifikasi cepat.
      const tries = Math.min(parseInt(req.body.tries) || 6, 12);
      const intervalMs = Math.min(parseInt(req.body.intervalMs) || 8000, 15000);
      const data = await svc.verifyOnu(onuIf, { tries, intervalMs });
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Hapus ONU ─────────────────────────────────────────────────────
  async deleteOnu(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const onuIf = req.body.onuIf || req.query.if;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let target = onuIf;
      if (isZteStyle(cfg.brand)) {
        if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
        await svc.deleteOnu(onuIf);
      } else {
        const { pon, id } = this._chipsetBodyRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'pon & id wajib' });
        await svc.deleteOnu(pon, id);
        target = `${pon}:${id}`;
      }
      logger.info(`[OltMgmt] Hapus ONU di OLT ${cfg.name}`);
      logOltAction(req, { action: 'delete', oltId: cfg.id, target,
        description: `Hapus ONU ${target} (OLT ${cfg.name})` });
      clearCache(cfg.id);
      res.json({ success: true, message: 'ONU dihapus dari OLT' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // ── Diagnostik: jalankan perintah CLI mentah (read-only, superadmin) ──
  // Berguna untuk memverifikasi format output OLT saat parser belum cocok.
  async rawCommand(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const cmd = (req.body.cmd || '').trim();
    if (!cmd) return res.status(400).json({ success: false, message: 'Parameter cmd wajib' });
    // Hanya izinkan perintah baca (show/display) demi keamanan
    if (!/^(show|display|dir|cat|get)\b/i.test(cmd)) {
      return res.status(400).json({ success: false, message: 'Hanya perintah baca (show/display) yang diizinkan di diagnostik' });
    }
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let out;
      if (typeof svc.exec === 'function') out = await svc.exec(cmd);
      res.json({ success: true, data: { cmd, output: String(out || '').slice(0, 8000) } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally {
      await svc.disconnect().catch(() => {});
    }
  }

  // Helper: ekstrak {pon,id} chipset dari body (mendukung onuIf="port/id")
  _chipsetBodyRef(req) {
    let pon = req.body.pon, id = req.body.id;
    if ((pon == null || id == null) && req.body.onuIf) {
      const m = String(req.body.onuIf).match(/(\d+)\s*\/\s*(\d+)/);
      if (m) { pon = m[1]; id = m[2]; }
    }
    return { pon: pon != null ? pon : null, id: id != null ? parseInt(id) : null };
  }

  // ── Info sistem OLT ───────────────────────────────────────────────
  async systemInfo(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    if (snmpAvailable(cfg)) {
      try {
        const data = await makeSnmp(cfg).getSystemInfo();
        if (data && !data.error) return res.json({ success: true, data, via: 'snmp' });
      } catch (e) { logger.warn('[OltMgmt] SNMP system gagal, fallback CLI: ' + e.message); }
    }
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const data = await svc.getSystemInfo();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // ── Ringkasan per PON port ────────────────────────────────────────
  // ?ports=1,2,3  (chipset)  atau  ?ports=1/1/1,1/1/2 (zte)
  async portSummary(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const raw = (req.query.ports || '').trim();
    if (!raw) return res.status(400).json({ success: false, message: 'Parameter ports wajib (mis. 1,2,3)' });
    const ports = raw.split(',').map(s => s.trim()).filter(Boolean);

    if (snmpAvailable(cfg)) {
      try {
        const data = await makeSnmp(cfg).getPortSummary(ports);
        return res.json({ success: true, data, via: 'snmp' });
      } catch (e) { logger.warn('[OltMgmt] SNMP portSummary gagal, fallback CLI: ' + e.message); }
    }

    const svc = makeService(cfg);
    try {
      await svc.connect();
      let data;
      if (isZteStyle(cfg.brand)) data = await svc.getPortSummary(ports);
      else data = await svc.getPortSummary(ports.map(p => parseInt(p)).filter(n => !isNaN(n)));
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // ── VLAN global ───────────────────────────────────────────────────
  async vlans(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const data = await svc.getVlans();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  async createVlan(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const { vid, name } = req.body;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      const data = await svc.createVlan(vid, name);
      logger.info(`[OltMgmt] Buat VLAN ${vid} di OLT ${cfg.name}`);
      res.json({ success: true, message: `VLAN ${vid} dibuat`, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  async deleteVlan(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const vid = req.params.vid || req.body.vid;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      await svc.deleteVlan(vid);
      logger.info(`[OltMgmt] Hapus VLAN ${vid} di OLT ${cfg.name}`);
      res.json({ success: true, message: `VLAN ${vid} dihapus` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // Detail satu VLAN (profile, port uplink, deskripsi)
  async vlanDetail(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const vid = req.params.vid;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (typeof svc.getVlanDetail !== 'function') {
        return res.status(400).json({ success: false, message: 'Detail VLAN belum didukung untuk brand ini' });
      }
      const data = await svc.getVlanDetail(vid);
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // Ubah deskripsi/nama VLAN
  async updateVlan(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const vid = req.params.vid || req.body.vid;
    const { name } = req.body;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (typeof svc.updateVlan !== 'function') {
        return res.status(400).json({ success: false, message: 'Edit VLAN belum didukung untuk brand ini' });
      }
      const data = await svc.updateVlan(vid, { name });
      logger.info(`[OltMgmt] Update VLAN ${vid} di OLT ${cfg.name}`);
      res.json({ success: true, message: `VLAN ${vid} diperbarui`, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  // ── VLAN per-ONU (service-port) ───────────────────────────────────
  async onuVlans(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      let data;
      if (isZteStyle(cfg.brand)) {
        const onuIf = req.query.if;
        if (!onuIf) return res.status(400).json({ success: false, message: 'Parameter if wajib' });
        data = await svc.getOnuVlans(onuIf);
      } else {
        const { pon, id } = this._chipsetRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'pon & id wajib' });
        data = await svc.getOnuVlans(pon, id);
      }
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  async setOnuVlan(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const { sp, gem, userVlan, vlan } = req.body;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (isZteStyle(cfg.brand)) {
        const onuIf = req.body.onuIf;
        if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
        await svc.setOnuVlan(onuIf, { sp, gem, userVlan, vlan });
      } else {
        const { pon, id } = this._chipsetBodyRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'pon & id wajib' });
        await svc.setOnuVlan(pon, id, { sp, gem, userVlan, vlan });
      }
      logger.info(`[OltMgmt] Set VLAN ONU di OLT ${cfg.name}`);
      res.json({ success: true, message: 'VLAN ONU diterapkan' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }

  async deleteOnuVlan(req, res) {
    const cfg = getCfgOr404(req, res); if (!cfg) return;
    const sp = req.body.sp;
    const svc = makeService(cfg);
    try {
      await svc.connect();
      if (isZteStyle(cfg.brand)) {
        const onuIf = req.body.onuIf;
        if (!onuIf) return res.status(400).json({ success: false, message: 'onuIf wajib' });
        await svc.deleteOnuVlan(onuIf, sp);
      } else {
        const { pon, id } = this._chipsetBodyRef(req);
        if (pon == null || id == null) return res.status(400).json({ success: false, message: 'pon & id wajib' });
        await svc.deleteOnuVlan(pon, id, sp);
      }
      res.json({ success: true, message: 'VLAN ONU dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    } finally { await svc.disconnect().catch(() => {}); }
  }
}

module.exports = new OltManagementController();
