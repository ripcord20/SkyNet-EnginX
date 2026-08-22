/**
 * GenieACS Service
 * Handles all communication with GenieACS NBI API (external server)
 * GenieACS NBI runs on port 7557 by default
 */

const axios = require('axios');
const logger = require('../utils/logger');

class GenieacsService {
  constructor() {
    this.nbiUrl = process.env.GENIEACS_NBI_URL || 'http://192.168.1.10:7557';
    this.username = process.env.GENIEACS_USERNAME || '';
    this.password = process.env.GENIEACS_PASSWORD || '';
    this.timeout = parseInt(process.env.GENIEACS_TIMEOUT) || 15000;
  }

  // Normalisasi nilai power dBm dari device
  // Beberapa vendor kirim dalam 0.001 dBm (perlu dibagi 1000)
  // atau 0.01 dBm (perlu dibagi 100)
  _normalizePower(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = parseFloat(val);
    if (isNaN(n)) return null;
    // Nilai normal RX: -50 sampai 0 dBm
    // Nilai normal TX: 0 sampai 10 dBm
    // Jika nilai absolut > 100, kemungkinan dalam satuan 0.001 dBm
    if (Math.abs(n) > 100) return (n / 1000).toFixed(2);
    // Jika nilai absolut > 50 tapi <= 100, kemungkinan 0.01 dBm
    if (Math.abs(n) > 50)  return (n / 100).toFixed(2);
    return n.toFixed(2);
  }

  // Normalisasi nilai power dBm dari device
  // RX: vendor kirim dalam 0.001 dBm → dibagi 1000  (misal -18200 → -18.2 dBm)
  // TX: vendor kirim dalam μW×10 → konversi mW → dBm (misal 17579 → 2.45 dBm)
  _normalizePower(val, type = 'rx') {
    if (val === null || val === undefined || val === '') return null;
    const n = parseFloat(val);
    if (isNaN(n)) return null;

    // Jika sudah dalam range normal dBm (-50 s/d 15), langsung pakai
    if (n >= -50 && n <= 15) return n.toFixed(2);

    if (type === 'tx') {
      // TX Power: raw dalam 0.0001 mW (μW×10)
      // Formula: 10 * log10(raw / 10000)
      if (n > 0 && n > 100) {
        const mw = n / 10000;
        return (10 * Math.log10(mw)).toFixed(2);
      }
    }

    // RX Power: raw dalam 0.001 dBm → dibagi 1000
    if (Math.abs(n) > 100) return (n / 1000).toFixed(2);
    if (Math.abs(n) > 15)  return (n / 100).toFixed(2);
    return n.toFixed(2);
  }

    _getAxios() {
    const config = {
      baseURL: this.nbiUrl,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json' }
    };
    if (this.username) {
      config.auth = { username: this.username, password: this.password };
    }
    return axios.create(config);
  }

  /**
   * Normalisasi Serial Number ONT.
   *
   * Beberapa firmware Huawei (mis. HS8145C5) men-encode SerialNumber sebagai
   * full hex 16 karakter, di mana 4 byte pertama (8 hex char) merupakan ASCII
   * printable berisi vendor prefix (mis. "HWTC" = Huawei Technology Co.) dan
   * 4 byte sisanya adalah bagian unik device.
   *
   * Contoh:
   *   GenieACS NBI value : "48575443B9DDBD9F"  (16 hex chars)
   *   GenieACS UI display: "HWTCB9DDBD9F"     (auto-decoded oleh UI)
   *   Pelanggan / OLT    : "HWTCB9DDBD9F"     (format yang dipakai operator)
   *
   * Helper ini menyamakan output dengan GenieACS UI / OLT, sehingga matching
   * SN ke `customers.ont_sn` di database dan tampilan ke pengguna konsisten.
   *
   * Vendor lain (ZTE "ZTEG...", FiberHome "FHTT...", dll) yang sudah ASCII
   * tidak akan tersentuh karena tidak match pola full-hex.
   */
  _normalizeSerial(serial) {
    if (!serial || typeof serial !== 'string') return serial;
    const s = serial.trim();
    // Harus tepat 16 karakter hex (8 byte). Format SN Huawei TR-069 selalu 16.
    if (!/^[0-9A-Fa-f]{16}$/.test(s)) return s;
    const prefixHex = s.substring(0, 8);
    let prefixAscii = '';
    for (let i = 0; i < prefixHex.length; i += 2) {
      const ch = String.fromCharCode(parseInt(prefixHex.substr(i, 2), 16));
      // Hanya decode jika 4 byte pertama berupa huruf/angka ASCII printable.
      // Jika tidak, ini bukan format hex-encoded vendor — biarkan apa adanya.
      if (!/[A-Za-z0-9]/.test(ch)) return s;
      prefixAscii += ch;
    }
    return prefixAscii + s.substring(8).toUpperCase();
  }

  // Update config dari settings (dipanggil setelah save settings)
  updateConfig(config) {
    if (config.nbiUrl) this.nbiUrl = config.nbiUrl;
    if (config.username !== undefined) this.username = config.username;
    if (config.password !== undefined) this.password = config.password;
  }

  // ========== DEVICE MANAGEMENT ==========

  async getDevices(query = {}, projection = null) {
    try {
      const client = this._getAxios();
      const params = {};
      if (Object.keys(query).length) params.query = JSON.stringify(query);
      if (projection) params.projection = projection;

      const res = await client.get('/devices', { params });
      return { success: true, data: res.data };
    } catch (err) {
      logger.error('GenieACS getDevices error:', err.message);
      return { success: false, error: err.message, data: [] };
    }
  }

  async getDevice(deviceId, projection = null) {
    try {
      const client = this._getAxios();
      const params = { query: JSON.stringify({ '_id': deviceId }) };
      if (projection) params.projection = projection;
      const res = await client.get(`/devices`, { params });
      if (res.data && res.data.length > 0) {
        return { success: true, data: res.data[0] };
      }
      return { success: false, error: 'Device not found', data: null };
    } catch (err) {
      logger.error('GenieACS getDevice error:', err.message);
      return { success: false, error: err.message, data: null };
    }
  }

  // ========== PARAMETER READING ==========

  async getDeviceParam(deviceId, paramPath) {
    try {
      const client = this._getAxios();
      const projection = paramPath;
      const res = await client.get(`/devices`, {
        params: {
          query: JSON.stringify({ '_id': deviceId }),
          projection: projection
        }
      });
      if (res.data && res.data.length > 0) {
        return { success: true, data: res.data[0] };
      }
      return { success: false, error: 'Device not found' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ========== TASK MANAGEMENT ==========

  async createTask(deviceId, task, options = {}) {
    try {
      const client = this._getAxios();
      // Decode dulu untuk hindari double-encoding (%2D -> - -> %2D lagi)
      // lalu encode sekali untuk URL yang benar
      const decoded   = decodeURIComponent(deviceId);
      const encodedId = encodeURIComponent(decoded);
      const params = {};
      if (options.timeout)    params.timeout = options.timeout;
      if (options.connection !== undefined) params.connection = options.connection;

      // PENTING: validateStatus override supaya 202 (Accepted, task queued tapi
      // Connection Request gagal) tidak throw. Kita perlu bedakan:
      //   - 200 OK: task sudah execute langsung (Connection Request sukses)
      //   - 202 Accepted: task di-queue, akan execute saat ONT periodic inform
      //   - >=400: error sebenarnya
      const res = await client.post(`/devices/${encodedId}/tasks`, task, {
        params,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      // Status 202 = task queued (Connection Request fail/timeout)
      // Status 200 = task executed
      const executed = res.status === 200;
      const queued   = res.status === 202;
      return { success: true, data: res.data, executed, queued, httpStatus: res.status };
    } catch (err) {
      logger.error('GenieACS createTask error:', err.message);
      return { success: false, error: err.response?.data || err.message };
    }
  }

  // Set parameter value
  async setParameterValues(deviceId, parameters) {
    // parameters: [ [path, value, type], ... ]
    const task = {
      name: 'setParameterValues',
      parameterValues: parameters
    };
    // connection: '1' = trigger connection request ke ONT → task execute seketika (2-10 detik)
    return this.createTask(deviceId, task, { connection: '1', timeout: 30000 });
  }

  // Get/Refresh parameter values
  async getParameterValues(deviceId, parameterNames) {
    const task = {
      name: 'getParameterValues',
      parameterNames: parameterNames
    };
    return this.createTask(deviceId, task, { connection: '1', timeout: 30000 });
  }

  // Reboot device
  async rebootDevice(deviceId) {
    const task = { name: 'reboot' };
    return this.createTask(deviceId, task, { connection: '1', timeout: 30000 });
  }

  // ── Set PeriodicInformInterval via setParameterValues ────────
  // Dipanggil saat device pertama kali connect atau via admin
  // interval: detik (recommended: 30-60 untuk produksi)
  async setPeriodicInform(deviceId, intervalSeconds = 60) {
    return this.setParameterValues(deviceId, [
      ['InternetGatewayDevice.ManagementServer.PeriodicInformEnable', true,              'xsd:boolean'],
      ['InternetGatewayDevice.ManagementServer.PeriodicInformInterval', intervalSeconds, 'xsd:unsignedInt']
    ]);
  }

  // Factory Reset
  async factoryResetDevice(deviceId) {
    const task = { name: 'factoryReset' };
    return this.createTask(deviceId, task, { connection: '1', timeout: 30000 });
  }

  // Refresh object/param
  async refreshObject(deviceId, objectName) {
    const task = {
      name: 'refreshObject',
      objectName: objectName
    };
    return this.createTask(deviceId, task, { connection: '1', timeout: 30000 });
  }

  // ========== FAULT MANAGEMENT ==========

  async getFaults(deviceId) {
    try {
      const client = this._getAxios();
      const decoded = decodeURIComponent(deviceId);
      const res = await client.get(`/faults`, {
        params: { query: JSON.stringify({ '_id': { '$regex': `^${decoded}:` } }) }
      });
      return { success: true, data: res.data };
    } catch (err) {
      return { success: false, error: err.message, data: [] };
    }
  }

  // ========== PRESET MANAGEMENT ==========

  async getPresets() {
    try {
      const client = this._getAxios();
      const res = await client.get('/presets');
      return { success: true, data: res.data };
    } catch (err) {
      return { success: false, error: err.message, data: [] };
    }
  }

  // ========== HELPERS ==========

  // Get WiFi info dari device object
  extractWifiInfo(deviceData) {
    const wifi = { ssid_2g: null, password_2g: null, ssid_5g: null, password_5g: null };
    if (!deviceData) return wifi;

    // Common TR-069 paths untuk WiFi
    const paths2g = [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID._value',
      'Device.WiFi.SSID.1.SSID._value'
    ];
    const paths5g = [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID._value',
      'Device.WiFi.SSID.5.SSID._value'
    ];

    // Traverse object path
    const getNestedValue = (obj, path) => {
      const parts = path.split('.');
      let current = obj;
      for (const part of parts) {
        if (current && current[part] !== undefined) {
          current = current[part];
        } else {
          return null;
        }
      }
      return current;
    };

    // Try to find SSID dari berbagai possible paths
    try {
      const igdWlan = deviceData?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;
      if (igdWlan) {
        // 2.4GHz: selalu index 1
        const wlan1 = igdWlan['1'];
        // 5GHz: coba index 5, 3, 2 (tergantung vendor)
        const wlan5 = igdWlan['5'] || igdWlan['3'] || igdWlan['2'];

        if (wlan1) {
          wifi.ssid_2g     = wlan1.SSID?._value || null;
          wifi.password_2g = wlan1.PreSharedKey?.['1']?.KeyPassphrase?._value ||
                             wlan1.PreSharedKey?.['1']?.PreSharedKey?._value  ||
                             wlan1.KeyPassphrase?._value                      ||
                             wlan1['X_ZTE-COM_WPAPreSharedKey']?._value       || null;
          wifi.channel_2g  = wlan1.Channel?._value || null;
          wifi.security_2g = wlan1.BeaconType?._value || null;
        }
        if (wlan5) {
          wifi.ssid_5g     = wlan5.SSID?._value || null;
          wifi.password_5g = wlan5.PreSharedKey?.['1']?.KeyPassphrase?._value ||
                             wlan5.PreSharedKey?.['1']?.PreSharedKey?._value  ||
                             wlan5.KeyPassphrase?._value                      ||
                             wlan5['X_ZTE-COM_WPAPreSharedKey']?._value       || null;
          wifi.channel_5g  = wlan5.Channel?._value || null;
          wifi.security_5g = wlan5.BeaconType?._value || null;
        }
      }

      // Try Device.WiFi path (TR-181)
      const devWifi = deviceData?.Device?.WiFi?.SSID;
      if (devWifi && !wifi.ssid_2g) {
        wifi.ssid_2g = devWifi['1']?.SSID?._value || null;
        wifi.ssid_5g = devWifi['5']?.SSID?._value || null;
      }
    } catch (e) {
      logger.error('extractWifiInfo error:', e.message);
    }

    return wifi;
  }

  // Extract signal / optical info
  extractSignalInfo(deviceData) {
    const signal = {};
    if (!deviceData) return signal;

    try {
      const igd     = deviceData?.InternetGatewayDevice;
      const wanDev  = igd?.WANDevice;
      const devInfo = igd?.DeviceInfo || deviceData?.Device?.DeviceInfo;

      // ── VirtualParameters (paling akurat, sudah diproses provision) ──
      const vp = deviceData?.VirtualParameters;
      if (vp) {
        signal.rx_power     = this._normalizePower(vp?.RXPower?._value) || null;
        signal.temperature  = vp?.gettemp?._value     || null;
        signal.wan_ip       = vp?.pppoeIP?._value     || null;
        signal.uptime_str   = vp?.getdeviceuptime?._value || null;
        signal.pppoe_uptime = vp?.getpppuptime?._value || null;
        signal.pon_mode     = vp?.getponmode?._value  || null;
        signal.pon_mac      = vp?.PonMac?._value      || null;
        signal.pppoe_user   = vp?.pppoeUsername?._value || null;
        signal.pppoe_mac    = vp?.pppoeMac?._value    || null;
      }

      if (wanDev) {
        const wan1 = wanDev['1'];

        // RX Power — path berdasarkan provisions aktual
        // ZTE: X_ZTE-COM_WANPONInterfaceConfig (dengan tanda -)
        const ztePon  = wan1?.['X_ZTE-COM_WANPONInterfaceConfig'];
        // CT-COM: X_CT-COM_GponInterfaceConfig & X_CT-COM_EponInterfaceConfig
        const ctGpon  = wan1?.['X_CT-COM_GponInterfaceConfig'];
        const ctEpon  = wan1?.['X_CT-COM_EponInterfaceConfig'];
        // FH (FiberHome)
        const fhGpon  = wan1?.X_FH_GponInterfaceConfig;
        // Generic
        const genGpon = wan1?.X_GponInterafceConfig;

        const rawRx =
          (signal.rx_power) ||
          ztePon?.RXPower?._value  ||
          ctGpon?.RXPower?._value  ||
          ctEpon?.RXPower?._value  ||
          fhGpon?.RXPower?._value  ||
          genGpon?.RXPower?._value ||
          wan1?.['X_ZICG_COM_GPON']?.RXPower?._value ||
          null;

        const rawTx =
          ztePon?.TXPower?._value  ||
          ctGpon?.TXPower?._value  ||
          ctEpon?.TXPower?._value  ||
          fhGpon?.TXPower?._value  ||
          genGpon?.TXPower?._value ||
          null;

        const rawOltRx =
          ztePon?.OLTRXPower?._value ||
          ctGpon?.OLTRXPower?._value ||
          null;

        signal.rx_power     = this._normalizePower(rawRx,    'rx');
        signal.tx_power     = this._normalizePower(rawTx,    'tx');
        signal.olt_rx_power = this._normalizePower(rawOltRx, 'rx');
        signal.voltage      = ztePon?.Voltage?._value || null;
        signal.bias_current = ztePon?.Current?._value || null;
      }

      // Temperature fallback dari DeviceInfo
      if (!signal.temperature) {
        signal.temperature =
          devInfo?.['X_ZTE-COM_Temperature']?._value ||
          devInfo?.X_ZTE_COM_Temperature?._value     ||
          devInfo?.['X_CT-COM_Temperature']?._value  ||
          devInfo?.X_Temperature?._value             ||
          null;
      }

      // Uptime
      signal.uptime = devInfo?.UpTime?._value || null;

      // WAN IP — scan semua WANDevice & WANConnectionDevice
      if (!signal.wan_ip) {
        const scanWan = (connDevs) => {
          for (const cdKey of Object.keys(connDevs)) {
            const cd = connDevs[cdKey];
            if (!cd || typeof cd !== 'object') continue;
            // WANIPConnection
            const ipConns = cd?.WANIPConnection || {};
            for (const k of Object.keys(ipConns)) {
              const c = ipConns[k];
              const ip = c?.ExternalIPAddress?._value;
              const st = (c?.ConnectionStatus?._value || '').toLowerCase();
              if (ip && ip !== '0.0.0.0') {
                if (!signal.wan_ip || st === 'connected') {
                  signal.wan_ip     = ip;
                  signal.wan_status = c.ConnectionStatus?._value || null;
                  signal.wan_type   = c.ConnectionType?._value   || null;
                }
                if (st === 'connected') return true; // prioritas connected
              }
            }
            // WANPPPConnection
            const pppConns = cd?.WANPPPConnection || {};
            for (const k of Object.keys(pppConns)) {
              const c = pppConns[k];
              const ip = c?.ExternalIPAddress?._value;
              const st = (c?.ConnectionStatus?._value || '').toLowerCase();
              if (ip && ip !== '0.0.0.0') {
                if (!signal.wan_ip || st === 'connected') {
                  signal.wan_ip     = ip;
                  signal.wan_status = c.ConnectionStatus?._value || null;
                  signal.wan_type   = c.ConnectionType?._value   || null;
                }
                if (st === 'connected') return true;
              }
            }
          }
          return false;
        };

        // Scan semua WANDevice index (1, 2, dst)
        if (wanDev) {
          for (const wdKey of Object.keys(wanDev)) {
            const wd = wanDev[wdKey];
            if (!wd || typeof wd !== 'object') continue;
            const connDevs = wd.WANConnectionDevice || {};
            if (scanWan(connDevs)) break; // stop jika sudah dapat yg connected
          }
        }
      }

    } catch (e) {
      logger.error('extractSignalInfo error:', e.message);
    }

    return signal;
  }

  // Extract device basic info
  extractDeviceInfo(deviceData) {
    const info = {};
    if (!deviceData) return info;

    try {
      const devInfo = deviceData?.InternetGatewayDevice?.DeviceInfo ||
                      deviceData?.Device?.DeviceInfo;

      // _deviceId: {OUI, ProductClass, SerialNumber} — struktur internal GenieACS
      const did = deviceData?.['_deviceId'] || {};

      // Parse _id format: OUI-ProductClass-SerialNumber (decode %2D = -)
      let parsedOui = '', parsedProduct = '', parsedSerial = '';
      const rawId = deviceData?.['_id'] || '';
      if (rawId) {
        const decoded = decodeURIComponent(rawId);
        const parts = decoded.split('-');
        if (parts.length >= 3) {
          parsedOui     = parts[0] || '';
          parsedProduct = parts[1] || '';
          parsedSerial  = parts.slice(2).join('-') || '';
        }
      }

      info.manufacturer     = devInfo?.Manufacturer?._value    || did['Manufacturer']  || parsedOui    || '-';
      info.model            = devInfo?.ModelName?._value       || devInfo?.ProductClass?._value
                            || did['ProductClass']             || parsedProduct         || '-';
      info.hardware_version = devInfo?.HardwareVersion?._value || '-';
      info.software_version = devInfo?.SoftwareVersion?._value || '-';
      // Beberapa firmware Huawei mengembalikan SN dalam format hex 16 karakter
      // (mis. "48575443B9DDBD9F") padahal SN asli yang ditampilkan GenieACS UI
      // & dipakai operator adalah "HWTCB9DDBD9F". Normalisasi agar konsisten.
      const rawSerial       = devInfo?.SerialNumber?._value    || did['SerialNumber']   || parsedSerial || '-';
      info.serial_number    = rawSerial && rawSerial !== '-' ? this._normalizeSerial(rawSerial) : '-';
      info.uptime           = devInfo?.UpTime?._value          || null;
      info.oui              = did['OUI'] || parsedOui || null;
      info.connection_request_url = deviceData?.['_registrationParams']?.['connectionRequestURL'] ||
                                    deviceData?.InternetGatewayDevice?.ManagementServer?.ConnectionRequestURL?._value || null;
      info.last_inform = deviceData?.['_lastInform'] || null;
      info.device_id   = deviceData?.['_id']         || null;

    } catch (e) {
      logger.error('extractDeviceInfo error:', e.message);
    }

    return info;
  }

  // Test connection ke GenieACS
  async testConnection() {
    try {
      const client = this._getAxios();
      const res = await client.get('/devices', { params: { limit: 1 } });
      return { success: true, message: 'Connected', status: res.status };
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) return { success: false, error: 'Authentication failed (401)' };
      if (status === 403) return { success: false, error: 'Forbidden (403)' };
      return { success: false, error: err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Hitung estimasi waktu task akan execute kalau Connection Request gagal.
  // ONT akan inform ke ACS secara periodik dengan interval di
  // ManagementServer.PeriodicInformInterval (detik). Task yang sudah di queue
  // akan execute saat ONT inform berikutnya.
  //
  // Return:
  //   {
  //     interval:   number   // detik (default 300 = 5 menit kalau tidak ada data)
  //     lastInform: ISO date | null
  //     nextInform: ISO date | null   // last + interval
  //     etaMinutes: number   // berapa menit lagi (rounded up)
  //     etaText:    string   // human-readable: "5 menit", "± 1-5 menit", dll
  //   }
  // ─────────────────────────────────────────────────────────────────
  async getInformEta(deviceId) {
    try {
      const decoded   = decodeURIComponent(deviceId);
      const projection = '_id,_lastInform,InternetGatewayDevice.ManagementServer.PeriodicInformInterval';
      const result = await this.getDevice(decoded, projection);
      if (!result.success || !result.data) {
        return { interval: 300, lastInform: null, nextInform: null, etaMinutes: 5, etaText: '± 1-15 menit' };
      }

      const d = result.data;
      const interval = parseInt(
        d?.InternetGatewayDevice?.ManagementServer?.PeriodicInformInterval?._value || '300',
        10
      ) || 300;

      const lastInformMs = d._lastInform ? new Date(d._lastInform).getTime() : null;
      const nextInformMs = lastInformMs ? lastInformMs + (interval * 1000) : null;
      const now = Date.now();

      let etaMinutes;
      let etaText;
      if (nextInformMs && nextInformMs > now) {
        const diffSec = Math.ceil((nextInformMs - now) / 1000);
        etaMinutes = Math.ceil(diffSec / 60);
        if (etaMinutes <= 1) etaText = '< 1 menit';
        else if (etaMinutes <= 5) etaText = `± ${etaMinutes} menit`;
        else etaText = `± ${etaMinutes} menit`;
      } else if (nextInformMs && nextInformMs <= now) {
        // Sudah lewat next inform — ONT mungkin offline atau sedang sinkron
        etaMinutes = 1;
        etaText = 'sebentar lagi (ONT seharusnya inform sekarang)';
      } else {
        // Tidak ada data inform sebelumnya
        const fallbackMin = Math.ceil(interval / 60);
        etaMinutes = fallbackMin;
        etaText = `± ${fallbackMin} menit`;
      }

      return {
        interval,
        lastInform: d._lastInform || null,
        nextInform: nextInformMs ? new Date(nextInformMs).toISOString() : null,
        etaMinutes,
        etaText,
      };
    } catch (err) {
      logger.warn('[GenieACS] getInformEta failed:', err.message);
      return { interval: 300, lastInform: null, nextInform: null, etaMinutes: 5, etaText: '± 1-15 menit' };
    }
  }
}

module.exports = new GenieacsService();