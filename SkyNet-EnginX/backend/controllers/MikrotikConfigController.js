const { getMikrotikInstance, setMikrotikInstance, resetInstance } = require('../services/MikrotikService');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const ConfigCrypto = require('../utils/ConfigCrypto');

const CONFIG_PATH = path.join(__dirname, '../../uploads/mikrotik_config.json');

// Load config dari file (password di-decrypt otomatis oleh ConfigCrypto),
// fallback ke .env. File legacy plaintext tetap terbaca — akan ter-upgrade
// ke ciphertext pada saveConfig() berikutnya.
function loadPersistedConfig() {
  const loaded = ConfigCrypto.load(CONFIG_PATH, null);
  if (loaded) return loaded;
  return {
    host: process.env.MT_HOST || '',
    port: parseInt(process.env.MT_PORT) || 80,
    username: process.env.MT_USER || 'admin',
    password: process.env.MT_PASS || '',
    useSSL: false
  };
}

function savePersistedConfig(cfg) {
  try {
    ConfigCrypto.save(CONFIG_PATH, cfg);
  } catch (e) {
    logger.error('Failed to persist MikroTik config:', e.message);
  }
}

let mikrotikConfig = loadPersistedConfig();

class MikrotikConfigController {
  // GET /api/mikrotik/config
  getConfig(req, res) {
    res.json({
      success: true,
      data: {
        host: mikrotikConfig.host,
        port: mikrotikConfig.port,
        username: mikrotikConfig.username,
        useSSL: mikrotikConfig.useSSL,
        configured: !!mikrotikConfig.host
      }
    });
  }

  // POST /api/mikrotik/config
  async saveConfig(req, res) {
    try {
      const { host, port, username, password, useSSL } = req.body;
      if (!host || !username) {
        return res.status(400).json({ success: false, message: 'Host and username required' });
      }
      mikrotikConfig = { host, port: parseInt(port) || 80, username, password: password || '', useSSL: !!useSSL };

      // Persist ke file agar tidak hilang saat restart
      savePersistedConfig(mikrotikConfig);

      // Update env-level defaults
      process.env.MT_HOST = host;
      process.env.MT_PORT = port || 80;
      process.env.MT_USER = username;
      process.env.MT_PASS = password || '';

      // Update singleton langsung dengan config baru
      setMikrotikInstance(mikrotikConfig);

      res.json({ success: true, message: 'Config saved' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/mikrotik/test
  async testConnection(req, res) {
    try {
      const config = req.body?.host ? req.body : mikrotikConfig;
      const { MikrotikService } = require('../services/MikrotikService');
      const mt = new MikrotikService(config);
      const result = await mt.testConnection();
      res.json(result);
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  }

  // GET /api/mikrotik/system
  async systemInfo(req, res) {
    try {
      const mt = getMikrotikInstance();
      const [resource, identity] = await Promise.all([
        mt.getSystemResource(),
        mt.getSystemIdentity()
      ]);
      res.json({ success: true, data: { ...resource, identity: identity.name } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new MikrotikConfigController();