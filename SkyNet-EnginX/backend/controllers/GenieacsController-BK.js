/**
 * GenieACS Controller
 * API endpoints untuk monitoring & konfigurasi ONT via GenieACS
 */

const genieacs = require('../services/GenieacsService');
const logger = require('../utils/logger');

// ============================================================
// GET /api/genieacs/devices — List semua ONT
// ============================================================
exports.getDevices = async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = {};

    if (search) {
      query = {
        '$or': [
          { '_id': { '$regex': search } },
          { 'InternetGatewayDevice.DeviceInfo.SerialNumber._value': { '$regex': search } },
          { 'InternetGatewayDevice.DeviceInfo.ModelName._value': { '$regex': search } }
        ]
      };
    }

    // Projection: ambil field yang diperlukan saja agar response lebih ringan
    const projection = [
      '_id',
      '_lastInform',
      '_registered',
      '_tags',
      '_deviceId',
      'InternetGatewayDevice.DeviceInfo.Manufacturer',
      'InternetGatewayDevice.DeviceInfo.ModelName',
      'InternetGatewayDevice.DeviceInfo.ProductClass',
      'InternetGatewayDevice.DeviceInfo.SerialNumber',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'InternetGatewayDevice.DeviceInfo.HardwareVersion',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice',
      'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ConnectionStatus',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ConnectionStatus',
      'InternetGatewayDevice.WANDevice.2.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.2.WANConnectionDevice.1.WANIPConnection.1.ConnectionStatus',
      'InternetGatewayDevice.WANDevice.2.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.2.WANConnectionDevice.1.WANPPPConnection.1.ConnectionStatus',
      // VirtualParameters — sudah diproses oleh provision script
      'VirtualParameters.RXPower',
      'VirtualParameters.gettemp',
      'VirtualParameters.pppoeIP',
      'VirtualParameters.gettemp',
      'VirtualParameters.getdeviceuptime',
      'VirtualParameters.getpppuptime',
      'VirtualParameters.WlanPassword',
      'VirtualParameters.pppoeUsername',
      'VirtualParameters.pppoeMac',
    ].join(',');

    const result = await genieacs.getDevices(query, projection);
    if (!result.success) {
      return res.json({ success: false, error: result.error, data: [] });
    }

    // Process & format data
    const now = Date.now();

    // Format uptime helper (handles seconds, formatted string from VP, or null)
    const formatUptime = (val) => {
      if (val == null || val === '') return null;
      // VP getdeviceuptime sometimes returns string already (e.g., "5d 3h 12m")
      if (typeof val === 'string' && /[a-zA-Z]/.test(val)) return val;
      const secs = parseInt(val);
      if (isNaN(secs) || secs <= 0) return null;
      const d2 = Math.floor(secs / 86400);
      const h  = Math.floor((secs % 86400) / 3600);
      const m  = Math.floor((secs % 3600) / 60);
      if (d2 > 0) return `${d2}h ${h}j`;
      if (h > 0)  return `${h}j ${m}m`;
      return `${m}m`;
    };

    const devices = result.data.map(d => {
      const info = genieacs.extractDeviceInfo(d);
      const wifi = genieacs.extractWifiInfo(d);
      const signal = genieacs.extractSignalInfo(d);

      // Status: online jika last inform < 5 menit
      const lastInform = d._lastInform ? new Date(d._lastInform).getTime() : 0;
      const minutesAgo = lastInform ? Math.floor((now - lastInform) / 60000) : null;
      const isOnline = minutesAgo !== null && minutesAgo < 5;

      // Parse serial dari device ID untuk lookup customer
      const decoded = decodeURIComponent(d._id);
      const parts   = decoded.split('-');
      const rawSn   = info.serial_number || (parts.length >= 3 ? parts.slice(2).join('-') : decoded);
      // Normalisasi sekali lagi untuk fallback dari _id (mis. format hex Huawei)
      const sn      = genieacs._normalizeSerial(rawSn) || rawSn;

      // Temperature: parse to number
      const tempRaw = signal.temperature || info.temperature || null;
      const tempVal = tempRaw != null && tempRaw !== '' ? parseFloat(tempRaw) : null;

      // Connected clients: prefer Hosts.HostNumberOfEntries (LAN+WLAN total),
      // fallback ke jumlah AssociatedDevice di SSID 2.4G + 5G
      let clientCount = 0;
      try {
        const hostCount = parseInt(d?.InternetGatewayDevice?.LANDevice?.[1]?.Hosts?.HostNumberOfEntries?._value);
        if (!isNaN(hostCount) && hostCount >= 0) {
          clientCount = hostCount;
        } else {
          // fallback: count AssociatedDevice keys per SSID
          const lan = d?.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration || {};
          [1, 5].forEach(ssidIdx => {
            // try TotalAssociations first
            const ta = parseInt(lan?.[ssidIdx]?.TotalAssociations?._value);
            if (!isNaN(ta) && ta >= 0) {
              clientCount += ta;
            } else {
              const assoc = lan?.[ssidIdx]?.AssociatedDevice || {};
              clientCount += Object.keys(assoc).filter(k => /^\d+$/.test(k)).length;
            }
          });
        }
      } catch(e) { /* ignore — keep 0 */ }

      return {
        id: d._id,
        serial: info.serial_number,
        serial_clean: sn,
        manufacturer: info.manufacturer,
        model: info.model,
        hardware_version: info.hardware_version,
        software_version: info.software_version,
        last_inform: d._lastInform,
        minutes_ago: minutesAgo,
        registered: d._registered,
        online: isOnline,
        tags: d._tags || [],
        ssid: wifi.ssid_2g,
        ssid_5g: wifi.ssid_5g,
        wan_ip: signal.wan_ip,
        wan_status: signal.wan_status,
        uptime: info.uptime,
        uptime_formatted: formatUptime(signal.uptime_str || info.uptime),
        rx_power: signal.rx_power || null,
        temperature: tempVal != null && !isNaN(tempVal) ? tempVal : null,
        connected_clients: clientCount,
        customer_name: null,
        customer_id: null
      };
    });

    // Enrich dengan data pelanggan dari DB
    try {
      const { Customer } = require('../models');
      const { Op } = require('sequelize');
      const serials = devices.map(d => d.serial_clean).filter(Boolean);
      if (serials.length) {
        const customers = await Customer.findAll({
          where: { ont_sn: { [Op.in]: serials } },
          attributes: ['ont_sn', 'name', 'customer_id', 'status']
        });
        const custMap = {};
        customers.forEach(c => { custMap[c.ont_sn] = c; });
        devices.forEach(d => {
          const c = custMap[d.serial_clean];
          if (c) { d.customer_name = c.name; d.customer_id = c.customer_id; d.customer_status = c.status; }
        });
      }
    } catch(e) { /* silently skip if customer lookup fails */ }

    // Filter device tidak valid / junk dari GenieACS auto-discovery
    // Syarat valid ONT:
    //  1. Serial tidak cocok pattern junk (probe, discoveryservice, default, test, unknown, 00000..., 99999...)
    //  2. Serial minimal 6 karakter alfanumerik
    //  3. Model name ada dan bukan "000000" / junk
    //  4. Salah satu: ada RX power (pernah registered sebagai ONT)
    //     ATAU online dan punya model yang valid (ONT baru yang belum sempat polling signal)
    const JUNK_SERIAL_RE = /^(discoveryservice|probe|default|test|unknown|0{4,}|9{8,}|1{8,})/i;
    const JUNK_MODEL_RE  = /^(discoveryservice|probe|000+|default|test|unknown|decade)$/i;

    const validDevices = devices.filter(d => {
      const serial = (d.serial || d.serial_clean || d.id || '').toLowerCase();
      const model  = (d.model  || '').toLowerCase();

      // Hard junk rejection
      if (JUNK_SERIAL_RE.test(serial))             return false;
      if (serial.includes('discoveryservice'))      return false;
      if (model.includes('discoveryservice'))       return false;
      if (JUNK_MODEL_RE.test(model))                return false;

      // Serial terlalu pendek
      if (serial.length < 6) return false;

      // Harus ada model sama sekali (non-empty)
      if (!model || model === '—') return false;

      // Harus ada identifier ONT yang jelas:
      //  - punya RX power (= pernah registered & polling signal sukses), ATAU
      //  - device masih online (last inform < 5 menit, active ONT)
      const hasRx     = d.rx_power != null && d.rx_power !== '' && !isNaN(parseFloat(d.rx_power));
      const isOnline  = d.online === true;
      if (!hasRx && !isOnline) return false;

      return true;
    });

    // Filter by status if requested
    let filtered = validDevices;
    if (status === 'online') filtered = validDevices.filter(d => d.online);
    if (status === 'offline') filtered = validDevices.filter(d => !d.online);

    const onlineCount = validDevices.filter(d => d.online).length;
    const offlineCount = validDevices.filter(d => !d.online).length;

    res.json({
      success: true,
      data: filtered,
      stats: {
        total: validDevices.length,
        online: onlineCount,
        offline: offlineCount,
        raw_total: devices.length,
        junk_filtered: devices.length - validDevices.length
      }
    });
  } catch (err) {
    logger.error('getDevices error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// GET /api/genieacs/devices/:id — Detail ONT lengkap
// ============================================================
exports.getDevice = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    // Full projection untuk detail - include semua path signal vendor
    const detailProjection = [
      '_id', '_lastInform', '_registered', '_tags', '_deviceId',
      'InternetGatewayDevice.DeviceInfo',
      'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig',
      'InternetGatewayDevice.WANDevice.1.X_ZTE_COM_GPON',
      'InternetGatewayDevice.WANDevice.1.X_ZICG_COM_GPON',
      'InternetGatewayDevice.WANDevice.1.X_CT_COM_GPON',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5',
      'InternetGatewayDevice.ManagementServer.ConnectionRequestURL',
      // VirtualParameters
      'VirtualParameters.RXPower',
      'VirtualParameters.pppoeIP',
      'VirtualParameters.gettemp',
      'VirtualParameters.getdeviceuptime',
      'VirtualParameters.getpppuptime',
      'VirtualParameters.getponmode',
      'VirtualParameters.PonMac',
      'VirtualParameters.WlanPassword',
      'VirtualParameters.pppoeUsername',
      'VirtualParameters.pppoeMac',
      'VirtualParameters.activedevices',
      // ZTE signal path (dengan tanda -)
      'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig',
      // CT-COM signal path
      'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig',
      'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig',
      // FiberHome
      'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig',
    ].join(',');

    const result = await genieacs.getDevice(deviceId, detailProjection);

    if (!result.success || !result.data) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const d = result.data;
    const info = genieacs.extractDeviceInfo(d);
    const wifi = genieacs.extractWifiInfo(d);
    const signal = genieacs.extractSignalInfo(d);

    const now = Date.now();
    const lastInform = d._lastInform ? new Date(d._lastInform).getTime() : 0;
    const minutesAgo = lastInform ? Math.floor((now - lastInform) / 60000) : null;

    // Format uptime — coba VP dulu (string), fallback ke seconds
    let uptimeFormatted = '-';
    if (signal.uptime_str) {
      uptimeFormatted = signal.uptime_str;
    } else if (signal.uptime) {
      const secs = parseInt(signal.uptime);
      if (!isNaN(secs)) {
        const d2 = Math.floor(secs / 86400);
        const h  = Math.floor((secs % 86400) / 3600);
        const m  = Math.floor((secs % 3600) / 60);
        uptimeFormatted = `${d2}d ${h}h ${m}m`;
      }
    }

    res.json({
      success: true,
      data: {
        id: d._id,
        ...info,
        wifi,
        signal: {
          ...signal,
          uptime_formatted: uptimeFormatted
        },
        online: minutesAgo !== null && minutesAgo < 5,
        minutes_ago: minutesAgo,
        tags: d._tags || [],
        raw: d // raw data untuk advanced view
      }
    });
  } catch (err) {
    logger.error('getDevice error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/devices/:id/wifi — Ubah WiFi SSID & Password
// ============================================================
exports.setWifi = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const { ssid, password, band = '2g', ssid_5g, password_5g } = req.body;

    const parameters = [];

    // 2.4GHz
    if (band === '2g' || band === 'both') {
      if (ssid) {
        parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', ssid, 'xsd:string']);
      }
      if (password) {
        parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', password, 'xsd:string']);
        parameters.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', password, 'xsd:string']);
      }
    }

    // 5GHz
    if (band === '5g' || band === 'both') {
      const idx5g = '5'; // bisa '2' atau '5' tergantung vendor
      if (ssid_5g || ssid) {
        parameters.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx5g}.SSID`, ssid_5g || ssid, 'xsd:string']);
      }
      if (password_5g || password) {
        parameters.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx5g}.PreSharedKey.1.PreSharedKey`, password_5g || password, 'xsd:string']);
        parameters.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx5g}.KeyPassphrase`, password_5g || password, 'xsd:string']);
      }
    }

    if (parameters.length === 0) {
      return res.json({ success: false, error: 'No parameters to set' });
    }

    const result = await genieacs.setParameterValues(deviceId, parameters);
    res.json(result);
  } catch (err) {
    logger.error('setWifi error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/devices/:id/reboot — Reboot ONT
// ============================================================
exports.rebootDevice = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const result = await genieacs.rebootDevice(deviceId);
    res.json(result);
  } catch (err) {
    logger.error('rebootDevice error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/devices/:id/factory-reset
// ============================================================
exports.factoryReset = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const result = await genieacs.factoryResetDevice(deviceId);
    res.json(result);
  } catch (err) {
    logger.error('factoryReset error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/devices/:id/refresh — Refresh params dari device
// ============================================================
exports.refreshDevice = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const { objectName = 'InternetGatewayDevice' } = req.body;
    const result = await genieacs.refreshObject(deviceId, objectName);
    res.json(result);
  } catch (err) {
    logger.error('refreshDevice error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/devices/:id/set-param — Set custom parameter
// ============================================================
exports.setParam = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const { path, value, type = 'xsd:string' } = req.body;

    if (!path || value === undefined) {
      return res.json({ success: false, error: 'path and value required' });
    }

    const result = await genieacs.setParameterValues(deviceId, [[path, value, type]]);
    res.json(result);
  } catch (err) {
    logger.error('setParam error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// GET /api/genieacs/devices/:id/faults — Lihat fault/error device
// ============================================================
exports.getFaults = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const result = await genieacs.getFaults(deviceId);
    res.json(result);
  } catch (err) {
    logger.error('getFaults error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// GET /api/genieacs/devices/:id/clients — Connected devices (WiFi/LAN)
// ============================================================
exports.getClients = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);

    const clientProjection = [
      '_id',
      'InternetGatewayDevice.LANDevice.1.Hosts',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.AssociatedDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.AssociatedDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
    ].join(',');

    const result = await genieacs.getDevice(deviceId, clientProjection);
    if (!result.success || !result.data) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const d = result.data;
    const clients = [];
    const seen = new Set();

    // ── 1. Dari Hosts (IP + MAC + Hostname + Type) ──
    try {
      const hostsObj = d?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host || {};
      for (const key of Object.keys(hostsObj)) {
        const h = hostsObj[key];
        if (!h || typeof h !== 'object') continue;
        const mac    = h.MACAddress?._value    || '';
        const ip     = h.IPAddress?._value     || '';
        const name   = h.HostName?._value      || '';
        const type   = h.InterfaceType?._value || 'Unknown';
        const active = h.Active?._value;
        if (!mac && !ip) continue;
        const uid = mac || ip;
        if (seen.has(uid)) continue;
        seen.add(uid);
        clients.push({ mac, ip, hostname: name, type, active, source: 'host' });
      }
    } catch(e) { logger.error('getClients hosts error:', e.message); }

    // ── 2. Dari AssociatedDevice per SSID ──
    try {
      const wlanConf = d?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
      for (const wIdx of Object.keys(wlanConf)) {
        const wlan = wlanConf[wIdx];
        if (!wlan || typeof wlan !== 'object') continue;
        const ssid = wlan?.SSID?._value || `SSID${wIdx}`;
        const assoc = wlan?.AssociatedDevice || {};
        for (const key of Object.keys(assoc)) {
          const a = assoc[key];
          if (!a || typeof a !== 'object') continue;
          const mac  = a.AssociatedDeviceMACAddress?._value || '';
          const ip   = a.AssociatedDeviceIPAddress?._value  || '';
          const rssi = a.AssociatedDeviceRssi?._value
                    || a['X_ZTE-COM_Rssi']?._value
                    || a.X_HW_RSSI?._value || null;
          const bw   = a.AssociatedDeviceBandWidth?._value  || null;
          const name = a['X_ZTE-COM_AssociatedDeviceName']?._value || '';
          if (!mac) continue;
          const existing = clients.find(c => c.mac === mac);
          if (existing) {
            existing.ssid = ssid; existing.rssi = rssi;
            existing.bandwidth = bw; existing.type = 'WiFi';
            if (!existing.hostname && name) existing.hostname = name;
          } else {
            if (seen.has(mac)) continue;
            seen.add(mac);
            clients.push({ mac, ip, hostname: name, type: 'WiFi', ssid, rssi, bandwidth: bw, source: 'assoc' });
          }
        }
      }
    } catch(e) { logger.error('getClients assoc error:', e.message); }

    res.json({
      success: true,
      data: clients,
      total: clients.length,
      wifi: clients.filter(c => ['WiFi','802.11'].includes(c.type)).length,
      ethernet: clients.filter(c => c.type === 'Ethernet').length,
    });
  } catch (err) {
    logger.error('getClients error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};


// ============================================================
// GET /api/genieacs/settings/load — Load settings dari DB
// ============================================================
exports.loadSettings = async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const keys = ['genieacs_nbi_url','genieacs_username','genieacs_password'];
    const rows = await AppSetting.findAll({ where: { key: keys } });
    const cfg  = {};
    rows.forEach(r => { cfg[r.key] = r.value; });

    // Apply ke service
    if (cfg.genieacs_nbi_url) {
      const genieacs = require('../services/GenieacsService');
      genieacs.updateConfig({
        nbiUrl:   cfg.genieacs_nbi_url,
        username: cfg.genieacs_username || '',
        password: cfg.genieacs_password || ''
      });
    }
    res.json({ success: true, data: { nbi_url: cfg.genieacs_nbi_url || '', username: cfg.genieacs_username || '' } });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
};

// ============================================================
// GET /api/genieacs/devices/:id/bandwidth — Traffic dari MikroTik
// berdasarkan pelanggan yang di-assign ke ONT ini
// ============================================================
exports.getBandwidth = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const { Customer } = require('../models');

    // 1. Cari pelanggan yang assign ke ONT ini
    const decoded = decodeURIComponent(deviceId);
    const parts   = decoded.split('-');
    const sn      = parts.length >= 3 ? parts.slice(2).join('-') : decoded;

    const customer = await Customer.findOne({
      where: { ont_sn: sn },
      attributes: ['id','name','customer_id','static_ip','pppoe_username']
    });

    if (!customer) {
      return res.json({
        success: false,
        source: 'none',
        error: 'ONT belum di-assign ke pelanggan. Assign pelanggan dulu di tab Assign Pelanggan.'
      });
    }

    // 2. Ambil data dari MikroTik
    const { getMikrotikInstance } = require('../services/MikrotikService');
    const mt = getMikrotikInstance();

    let trafficData = null;
    let source = 'unknown';

    // Coba PPPoE session dulu (lebih real-time)
    if (customer.pppoe_username) {
      try {
        const sessions = await mt.getPPPoESessions();
        const session  = sessions?.find(s =>
          s.name?.toLowerCase() === customer.pppoe_username.toLowerCase()
        );
        if (session) {
          trafficData = {
            rx_bytes:  parseInt(session['bytes-in']  || session['rx-byte']  || 0),
            tx_bytes:  parseInt(session['bytes-out'] || session['tx-byte']  || 0),
            rx_rate:   parseInt(session['rx-rate']   || 0),
            tx_rate:   parseInt(session['tx-rate']   || 0),
            uptime:    session.uptime || null,
            pppoe_ip:  session.address || null,
          };
          source = 'pppoe';
        }
      } catch(e) { logger.error('PPPoE fetch error:', e.message); }
    }

    // Fallback: Simple Queue berdasarkan IP atau nama
    if (!trafficData) {
      try {
        const queues = await mt.getQueues();
        const ip     = customer.static_ip;
        const pppoe  = customer.pppoe_username;

        const queue = queues?.find(q =>
          (ip    && (q.target?.includes(ip) || q.name?.toLowerCase() === ip)) ||
          (pppoe && (q.name?.toLowerCase()    === pppoe.toLowerCase() ||
                     q.comment?.toLowerCase().includes(pppoe.toLowerCase())))
        );

        if (queue) {
          trafficData = {
            rx_bytes:  parseInt(queue['bytes-in']  || queue.bytesIn  || 0),
            tx_bytes:  parseInt(queue['bytes-out'] || queue.bytesOut || 0),
            rx_rate:   parseInt(queue['rate-in']   || queue.rateIn   || 0),
            tx_rate:   parseInt(queue['rate-out']  || queue.rateOut  || 0),
            max_rx:    queue['max-limit']?.split('/')[1] || null,
            max_tx:    queue['max-limit']?.split('/')[0] || null,
            queue_name: queue.name || null,
            disabled:  queue.disabled === 'true',
          };
          source = 'queue';
        }
      } catch(e) { logger.error('Queue fetch error:', e.message); }
    }

    if (!trafficData) {
      return res.json({
        success: false,
        source: 'mikrotik',
        customer: { name: customer.name, customer_id: customer.customer_id },
        error: `Pelanggan "${customer.name}" ditemukan tapi tidak ada sesi aktif di MikroTik`
      });
    }

    // Format bytes
    const fmt = (bytes) => {
      if (!bytes) return { value: '0', unit: 'B', raw: 0 };
      const gb = bytes / 1073741824;
      const mb = bytes / 1048576;
      const kb = bytes / 1024;
      if (gb >= 1)  return { value: gb.toFixed(2),  unit: 'GB', raw: bytes };
      if (mb >= 1)  return { value: mb.toFixed(1),  unit: 'MB', raw: bytes };
      if (kb >= 1)  return { value: kb.toFixed(0),  unit: 'KB', raw: bytes };
      return { value: bytes.toString(), unit: 'B', raw: bytes };
    };

    const fmtRate = (bps) => {
      if (!bps) return '0 bps';
      const mbps = bps / 1000000;
      const kbps = bps / 1000;
      if (mbps >= 1) return mbps.toFixed(1) + ' Mbps';
      if (kbps >= 1) return kbps.toFixed(0) + ' Kbps';
      return bps + ' bps';
    };

    const rxFmt = fmt(trafficData.rx_bytes);
    const txFmt = fmt(trafficData.tx_bytes);
    const total  = trafficData.rx_bytes + trafficData.tx_bytes;

    res.json({
      success: true,
      source,
      customer: { name: customer.name, customer_id: customer.customer_id,
                  ip: customer.static_ip, pppoe: customer.pppoe_username },
      data: {
        rx_bytes:   trafficData.rx_bytes,
        tx_bytes:   trafficData.tx_bytes,
        rx_display: rxFmt,
        tx_display: txFmt,
        rx_rate:    fmtRate(trafficData.rx_rate),
        tx_rate:    fmtRate(trafficData.tx_rate),
        uptime:     trafficData.uptime     || null,
        pppoe_ip:   trafficData.pppoe_ip   || null,
        max_rx:     trafficData.max_rx     || null,
        max_tx:     trafficData.max_tx     || null,
        queue_name: trafficData.queue_name || null,
        disabled:   trafficData.disabled   || false,
        total_bytes: total,
        dl_pct: total > 0 ? Math.round(trafficData.rx_bytes / total * 100) : 50,
        ul_pct: total > 0 ? Math.round(trafficData.tx_bytes / total * 100) : 50,
        // GB format
        rx_gb: (trafficData.rx_bytes / 1073741824).toFixed(3),
        tx_gb: (trafficData.tx_bytes / 1073741824).toFixed(3),
        rx_mb: (trafficData.rx_bytes / 1048576).toFixed(2),
        tx_mb: (trafficData.tx_bytes / 1048576).toFixed(2),
      }
    });
  } catch(err) {
    logger.error('getBandwidth error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// GET /api/genieacs/devices/:id/rx-history — RX Power history dari ont_devices DB
// ============================================================
exports.getRxHistory = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const hours    = parseInt(req.query.hours) || 24;
    const { sequelize } = require('../models');

    // Ambil dari tabel ont_devices — kolom signal_strength (RX Power) & last_synced
    const [rows] = await sequelize.query(`
      SELECT signal_strength, last_synced, last_inform
      FROM ont_devices
      WHERE device_id = :deviceId
        AND COALESCE(last_synced, last_inform) >= DATE_SUB(NOW(), INTERVAL :hours HOUR)
        AND signal_strength IS NOT NULL
      ORDER BY COALESCE(last_synced, last_inform) ASC
      LIMIT 200
    `, { replacements: { deviceId, hours } });

    // Jika tidak ada history, ambil data current dari GenieACS
    if (!rows || rows.length === 0) {
      const result = await genieacs.getDevice(deviceId, 'VirtualParameters.RXPower,_lastInform');
      const current = result.data?.VirtualParameters?.RXPower?._value;
      return res.json({
        success: true,
        data: current ? [{ time: new Date(), value: parseFloat(current) }] : [],
        message: 'Belum ada historis tersimpan di database'
      });
    }

    const data = rows.map(r => ({
      time:  r.last_synced || r.last_inform,
      value: parseFloat(r.signal_strength)
    }));

    res.json({ success: true, data });
  } catch(err) {
    logger.error('getRxHistory error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// GET /api/genieacs/customers/search — Cari pelanggan untuk assign
// ============================================================
exports.searchCustomers = async (req, res) => {
  try {
    const { q = '' } = req.query;
    const { Customer } = require('../models');
    const { Op } = require('sequelize');

    const customers = await Customer.findAll({
      where: {
        [Op.or]: [
          { name:        { [Op.like]: `%${q}%` } },
          { customer_id: { [Op.like]: `%${q}%` } },
          { phone:       { [Op.like]: `%${q}%` } },
        ]
      },
      attributes: ['id','customer_id','name','phone','status','ont_sn','ont_mac'],
      limit: 20,
      order: [['name','ASC']]
    });

    res.json({ success: true, data: customers });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/devices/:id/assign — Assign ONT ke pelanggan
// ============================================================
exports.assignCustomer = async (req, res) => {
  try {
    const deviceId   = decodeURIComponent(req.params.id);
    const { customer_id, serial } = req.body; // customer_id = DB id, serial = ONT serial
    const { Customer } = require('../models');

    if (!customer_id) {
      // Unassign: hapus ont_sn dari pelanggan yang punya serial ini
      if (serial) {
        await Customer.update({ ont_sn: null, ont_mac: null }, { where: { ont_sn: serial } });
      }
      return res.json({ success: true, message: 'ONT berhasil di-unassign' });
    }

    const customer = await Customer.findByPk(customer_id);
    if (!customer) return res.status(404).json({ success: false, error: 'Pelanggan tidak ditemukan' });

    // Parse serial dari deviceId: format OUI-ProductClass-Serial
    const decoded = decodeURIComponent(deviceId);
    const parts   = decoded.split('-');
    const rawSn   = serial || (parts.length >= 3 ? parts.slice(2).join('-') : decoded);
    // Normalisasi format SN (hex Huawei → ASCII) agar match dengan ont_sn di DB
    const sn      = genieacs._normalizeSerial(rawSn) || rawSn;

    // Hapus assign lama jika ada
    await Customer.update({ ont_sn: null, ont_mac: null }, { where: { ont_sn: sn } });

    // Assign ke pelanggan baru
    await customer.update({ ont_sn: sn });

    res.json({
      success: true,
      message: `ONT berhasil di-assign ke ${customer.name} (${customer.customer_id})`,
      data: { customer_id: customer.customer_id, name: customer.name, ont_sn: sn }
    });
  } catch(err) {
    logger.error('assignCustomer error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// GET /api/genieacs/devices/:id/customer — Cek pelanggan yang assign ke ONT ini
// ============================================================
exports.getAssignedCustomer = async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.id);
    const { Customer, Package } = require('../models');

    // Parse serial dari deviceId
    const decoded = decodeURIComponent(deviceId);
    const parts   = decoded.split('-');
    const rawSn   = parts.length >= 3 ? parts.slice(2).join('-') : decoded;
    // Normalisasi format SN (hex Huawei → ASCII) agar match dengan ont_sn di DB
    const sn      = genieacs._normalizeSerial(rawSn) || rawSn;

    const customer = await Customer.findOne({
      where: { ont_sn: sn },
      attributes: ['id','customer_id','name','phone','address','status'],
      include: [{ model: Package, as: 'package', attributes: ['name','price'], required: false }]
    });

    res.json({ success: true, data: customer || null });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/test — Test koneksi ke GenieACS server
// ============================================================
exports.testConnection = async (req, res) => {
  try {
    // Jika ada config baru di body, update dulu
    const { nbi_url, username, password } = req.body;
    if (nbi_url) {
      genieacs.updateConfig({
        nbiUrl: nbi_url,
        username: username || '',
        password: password || ''
      });
    }
    const result = await genieacs.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// POST /api/genieacs/settings — Simpan konfigurasi GenieACS
// ============================================================
exports.saveSettings = async (req, res) => {
  try {
    const { nbi_url, username, password } = req.body;

    // Update runtime config
    genieacs.updateConfig({
      nbiUrl:   nbi_url,
      username: username || '',
      password: password || ''
    });

    // Simpan ke tabel app_settings agar persist setelah restart
    const { AppSetting } = require('../models');
    await AppSetting.upsert({ key: 'genieacs_nbi_url',  value: nbi_url   || '', type: 'string' });
    await AppSetting.upsert({ key: 'genieacs_username',  value: username  || '', type: 'string' });
    if (password) {
      await AppSetting.upsert({ key: 'genieacs_password', value: password, type: 'string' });
    }

    res.json({
      success: true,
      message: 'Pengaturan GenieACS berhasil disimpan',
      config: { nbi_url, username }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================
// GET /api/genieacs/stats — Summary statistik
// ============================================================
exports.getStats = async (req, res) => {
  try {
    const result = await genieacs.getDevices({}, '_id,_lastInform,InternetGatewayDevice.DeviceInfo.Manufacturer,InternetGatewayDevice.DeviceInfo.ModelName,InternetGatewayDevice.DeviceInfo.SerialNumber,VirtualParameters.RXPower');
    if (!result.success) return res.json({ success: false, data: {} });

    const now = Date.now();
    const JUNK_SERIAL_RE = /^(discoveryservice|probe|default|test|unknown|0{4,}|9{8,}|1{8,})/i;
    const JUNK_MODEL_RE  = /^(discoveryservice|probe|000+|default|test|unknown|decade)$/i;

    const validDevices = result.data.filter(d => {
      const info = genieacs.extractDeviceInfo(d);
      const serial = (info.serial_number || d._id || '').toLowerCase();
      const model  = (info.model || '').toLowerCase();

      if (JUNK_SERIAL_RE.test(serial))             return false;
      if (serial.includes('discoveryservice'))      return false;
      if (model.includes('discoveryservice'))       return false;
      if (JUNK_MODEL_RE.test(model))                return false;
      if (serial.length < 6)                        return false;
      if (!model)                                   return false;

      const rxRaw = d?.VirtualParameters?.RXPower?._value;
      const hasRx = rxRaw != null && rxRaw !== '' && !isNaN(parseFloat(rxRaw));
      const lastInform = d._lastInform ? new Date(d._lastInform).getTime() : 0;
      const isOnline = lastInform && (now - lastInform) < 5 * 60 * 1000;
      if (!hasRx && !isOnline) return false;

      return true;
    });

    const online = validDevices.filter(d => {
      if (!d._lastInform) return false;
      return (now - new Date(d._lastInform).getTime()) < 5 * 60 * 1000;
    });

    const manufacturers = {};
    validDevices.forEach(d => {
      const mfr = d?.InternetGatewayDevice?.DeviceInfo?.Manufacturer?._value || 'Unknown';
      manufacturers[mfr] = (manufacturers[mfr] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        total: validDevices.length,
        online: online.length,
        offline: validDevices.length - online.length,
        raw_total: result.data.length,
        junk_filtered: result.data.length - validDevices.length,
        manufacturers
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};