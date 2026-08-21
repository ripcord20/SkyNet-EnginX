'use strict';

/**
 * ACSServer.js — TR-069 CWMP ACS Server
 * ─────────────────────────────────────────────────────────────────────
 * Raw TCP server (bukan Express) agar kompatibel dengan ONT ZTE/ZICG
 *
 * Flow ONT ZTE/ZICG GM219:
 *   Koneksi 1: POST Inform    → ACS: InformResponse
 *   Koneksi 2: POST empty     → ACS: GetParameterValues (atau SetPV)
 *   Koneksi 3: POST GPVResp   → ACS: 204
 *
 * Session di-track by SN (bukan IP) karena ONT bisa ganti source port
 * ─────────────────────────────────────────────────────────────────────
 */

const net    = require('net');
const logger = require('../utils/logger');

// ── Parameter yang diminta saat GPV ──────────────────────────────────
const PARAMS_GPV = [
  'InternetGatewayDevice.DeviceInfo.Manufacturer',
  'InternetGatewayDevice.DeviceInfo.ModelName',
  'InternetGatewayDevice.DeviceInfo.HardwareVersion',
  'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
  'InternetGatewayDevice.DeviceInfo.SerialNumber',
  'InternetGatewayDevice.DeviceInfo.UpTime',
  // IP WAN
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  // Signal GPON — ZTE
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GponInterfaceConfig.TXPower',
  // Signal EPON — ZTE
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_EponInterfaceConfig.RXPower',
  // Signal — Huawei
  'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.TXPower',
  // Signal — Fiberhome
  'InternetGatewayDevice.WANDevice.1.X_FIBERHOME_GponInterfaceConfig.RXPower',
  // Signal — Generic
  'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
  // WiFi
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BeaconType',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Standard',
];

// ── SOAP Builders ─────────────────────────────────────────────────────
function soapInformResponse(msgId = '1') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <SOAP-ENV:Header><cwmp:ID SOAP-ENV:mustUnderstand="1">${msgId}</cwmp:ID></SOAP-ENV:Header>
  <SOAP-ENV:Body><cwmp:InformResponse><MaxEnvelopes>1</MaxEnvelopes></cwmp:InformResponse></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function soapGetParameterValues(params = PARAMS_GPV) {
  const list = params.map(p => `<string>${p}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <SOAP-ENV:Header><cwmp:ID SOAP-ENV:mustUnderstand="1">2</cwmp:ID></SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <cwmp:GetParameterValues>
      <ParameterNames SOAP-ENC:arrayType="xsd:string[${params.length}]">${list}</ParameterNames>
    </cwmp:GetParameterValues>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function soapSetParameterValues(params) {
  // params = [{ name, value, type }]
  const count = params.length;
  const list  = params.map(p =>
    `<ParameterValueStruct>
      <Name>${p.name}</Name>
      <Value xsi:type="${p.type || 'xsd:string'}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${p.value}</Value>
    </ParameterValueStruct>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SOAP-ENV:Header><cwmp:ID SOAP-ENV:mustUnderstand="1">3</cwmp:ID></SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <cwmp:SetParameterValues>
      <ParameterList SOAP-ENC:arrayType="cwmp:ParameterValueStruct[${count}]">${list}</ParameterList>
      <ParameterKey>ui-set</ParameterKey>
    </cwmp:SetParameterValues>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function soapReboot() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <SOAP-ENV:Header><cwmp:ID SOAP-ENV:mustUnderstand="1">9</cwmp:ID></SOAP-ENV:Header>
  <SOAP-ENV:Body><cwmp:Reboot><CommandKey>reboot</CommandKey></cwmp:Reboot></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

// ── HTTP Response ─────────────────────────────────────────────────────
function httpResp(code, body = '') {
  const buf  = Buffer.from(body, 'utf8');
  const text = code === 204 ? 'No Content' : 'OK';
  return `HTTP/1.1 ${code} ${text}\r\nContent-Type: text/xml; charset="utf-8"\r\nContent-Length: ${buf.length}\r\nConnection: close\r\n\r\n${body}`;
}

// ── XML Helpers ───────────────────────────────────────────────────────
function xTag(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}
function xAll(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'gi');
  const r  = [];
  let m;
  while ((m = re.exec(xml)) !== null) r.push(m[1].trim());
  return r;
}
function parseParams(xml) {
  const p = {};
  xAll(xml, 'ParameterValueStruct').forEach(pv => {
    const n = xTag(pv,'Name') || xTag(pv,'n') || '';
    const v = xTag(pv,'Value')|| xTag(pv,'v') || '';
    if (n) p[n] = v;
  });
  return p;
}
function parseInform(xml) {
  const dev = xTag(xml,'DeviceId') || '';
  return {
    manufacturer: xTag(dev,'Manufacturer') || xTag(xml,'Manufacturer') || '',
    productClass: xTag(dev,'ProductClass') || xTag(xml,'ProductClass') || '',
    serialNumber: xTag(dev,'SerialNumber') || xTag(xml,'SerialNumber') || '',
    msgId:        xTag(xml,'ID') || '1',
    eventCodes:   xAll(xml,'EventCode'),
    params:       parseParams(xml),
  };
}

// ── Value extractors ─────────────────────────────────────────────────
function getRx(p) {
  const keys = [
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_FIBERHOME_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
  ];
  for (const k of keys) {
    if (p[k] !== undefined && p[k] !== '') {
      const v = parseFloat(p[k]);
      if (!isNaN(v)) return Math.abs(v) > 100 ? parseFloat((v/1000).toFixed(2)) : parseFloat(v.toFixed(2));
    }
  }
  return null;
}
function getTx(p) {
  const keys = [
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.TXPower',
  ];
  for (const k of keys) {
    if (p[k] !== undefined && p[k] !== '') {
      const v = parseFloat(p[k]);
      if (!isNaN(v)) return Math.abs(v) > 100 ? parseFloat((v/1000).toFixed(2)) : parseFloat(v.toFixed(2));
    }
  }
  return null;
}
function getIp(p, fallback) {
  const v1 = p['InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'];
  const v2 = p['InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'];
  return (v1 && v1 !== '0.0.0.0') ? v1 : (v2 && v2 !== '0.0.0.0') ? v2 : (fallback || null);
}
function getUptime(p) {
  const s = parseInt(p['InternetGatewayDevice.DeviceInfo.UpTime'] || '0');
  if (!s) return null;
  const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── WiFi params extractor ─────────────────────────────────────────────
function getWifi(p) {
  return {
    ssid:     p['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'] || null,
    password: p['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase'] ||
              p['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase'] || null,
    channel:  p['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel'] || null,
    standard: p['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Standard'] || null,
  };
}

// ── Save to DB ────────────────────────────────────────────────────────
async function saveOnt(sn, inform, extraParams, remoteIp) {
  try {
    const { OntDevice, OntSignalHistory } = require('../models');
    const all = { ...inform.params, ...extraParams };

    const rxPower  = getRx(all);
    const txPower  = getTx(all);
    const ip       = getIp(all, remoteIp);
    const uptime   = getUptime(all);
    const mfr      = all['InternetGatewayDevice.DeviceInfo.Manufacturer']   || inform.manufacturer || '';
    const model    = all['InternetGatewayDevice.DeviceInfo.ModelName']       || inform.productClass  || '';
    const firmware = all['InternetGatewayDevice.DeviceInfo.SoftwareVersion'] || null;
    const hardware = all['InternetGatewayDevice.DeviceInfo.HardwareVersion'] || null;
    const wifi     = getWifi(all);

    let status = 'online';
    if (rxPower !== null && rxPower < -27) status = 'warning';

    const tr069_params = {
      rx_power:    rxPower,
      tx_power:    txPower,
      olt_rx_power:null,
      hw_version:  hardware,
      fw_version:  firmware,
      wifi_ssid:   wifi.ssid,
      wifi_pass:   wifi.password,
      wifi_channel:wifi.channel,
      wifi_std:    wifi.standard,
    };

    const [rec, isNew] = await OntDevice.findOrCreate({
      where:    { serial_number: sn },
      defaults: { serial_number:sn, manufacturer:mfr, model, firmware, status, signal_strength:rxPower, ip_address:ip, uptime, last_inform:new Date(), last_synced:new Date(), tr069_params, source:'tr069', device_id:`tr069:${sn}` }
    });

    if (!isNew) {
      await rec.update({
        manufacturer: mfr      || rec.manufacturer,
        model:        model    || rec.model,
        firmware:     firmware || rec.firmware,
        status,
        signal_strength: rxPower ?? rec.signal_strength,
        ip_address:   ip       || rec.ip_address,
        uptime:       uptime   || rec.uptime,
        last_inform:  new Date(),
        last_synced:  new Date(),
        tr069_params,
        source: 'tr069',
      });
    }

    if (rxPower !== null) {
      await OntSignalHistory.create({
        ont_device_id: rec.id, rx_power: rxPower, tx_power: txPower, olt_rx_power: null, recorded_at: new Date()
      }).catch(() => {});
    }

    logger.info(`[ACS] ${isNew?'NEW':'UPD'} ${sn} | ${mfr} ${model} | rx:${rxPower} dBm | wifi:${wifi.ssid||'-'} | fw:${firmware} | ${status}`);
    return rec;
  } catch(e) {
    logger.error('[ACS] DB error:', e.message);
  }
}

// ── Session store (by SN + IP) ────────────────────────────────────────
// key = remoteIp, value = { sn, step, inform, lastSeen, pendingCmd }
const sessions = new Map();

// Cari session by SN (untuk kasus ONT ganti port/IP)
function getSessionBySn(sn) {
  for (const [ip, sess] of sessions) {
    if (sess.sn === sn) return { ip, sess };
  }
  return null;
}

// ── Command Queue ─────────────────────────────────────────────────────
const cmdQueue = new Map(); // sn → [{ type, data }]
const ACSCommandQueue = {
  push(sn, type, data) {
    if (!cmdQueue.has(sn)) cmdQueue.set(sn, []);
    cmdQueue.get(sn).push({ type, data, created: Date.now() });
    logger.info(`[ACS] Cmd queued: ${sn} → ${type} ${JSON.stringify(data)}`);
  },
  pop(sn) {
    const q = cmdQueue.get(sn);
    if (!q?.length) return null;
    return q.shift();
  },
  peek(sn) {
    return cmdQueue.get(sn)?.[0] || null;
  },
  size(sn) { return cmdQueue.get(sn)?.length || 0; }
};

// ── Build next command for ONT ─────────────────────────────────────────
function buildNextCommand(sn) {
  const cmd = ACSCommandQueue.pop(sn);
  if (!cmd) return null;

  switch (cmd.type) {
    case 'reboot':
      logger.info(`[ACS] Executing reboot for ${sn}`);
      return soapReboot();

    case 'set_wifi': {
      // cmd.data = { ssid, password }
      const params = [];
      if (cmd.data.ssid !== undefined) {
        params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', value: cmd.data.ssid });
      }
      if (cmd.data.password !== undefined) {
        params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', value: cmd.data.password });
        params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase', value: cmd.data.password });
      }
      logger.info(`[ACS] Executing set_wifi for ${sn}: ssid=${cmd.data.ssid}`);
      return soapSetParameterValues(params);
    }

    case 'set_param': {
      const params = [{ name: cmd.data.parameter, value: cmd.data.value, type: cmd.data.type || 'xsd:string' }];
      logger.info(`[ACS] Executing set_param for ${sn}: ${cmd.data.parameter}=${cmd.data.value}`);
      return soapSetParameterValues(params);
    }

    case 'get_wifi':
      return soapGetParameterValues([
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Standard',
      ]);

    default:
      return null;
  }
}

// ── Request Handler ───────────────────────────────────────────────────
async function handleRequest(remoteIp, body) {
  const preview = body.substring(0, 60).replace(/\s+/g,' ').trim();
  logger.debug(`[ACS] ${remoteIp} | ${body.length}b | ${preview || '(empty)'}`);

  // ── INFORM ───────────────────────────────────────────────────────
  const isInform = (body.includes('cwmp:Inform') || body.includes(':Inform>') || body.includes('>Inform<')) &&
                    body.includes('DeviceId');

  if (isInform) {
    const inform = parseInform(body);
    const sn     = inform.serialNumber || `UNKNOWN-${remoteIp}`;

    logger.info(`[ACS] Inform: ${sn} | ${inform.manufacturer} ${inform.productClass} | events:${inform.eventCodes.join(',')} | ip:${remoteIp}`);
    await saveOnt(sn, inform, {}, remoteIp);

    // Set session — next empty POST akan trigger GPV atau command
    sessions.set(remoteIp, { sn, step: 'need_cmd', inform, lastSeen: Date.now() });
    return { status: 200, body: soapInformResponse(inform.msgId) };
  }

  // ── GPV / SPV RESPONSE ────────────────────────────────────────────
  const hasParamStruct = body.includes('ParameterValueStruct');
  const isGPVResp = (body.includes('GetParameterValuesResponse') || body.includes('SetParameterValuesResponse') ||
                    (body.length > 100 && hasParamStruct && !isInform));

  if (isGPVResp) {
    // Cari session yang paling baru dari IP ini ATAU SN apapun yang step=gpv_sent
    let sess = sessions.get(remoteIp);
    if (!sess) {
      // Cari session aktif lain yang menunggu GPV response
      for (const [ip, s] of sessions) {
        if (s.step === 'gpv_sent' && Date.now() - s.lastSeen < 30000) {
          sess = s;
          break;
        }
      }
    }

    if (sess) {
      const params = parseParams(body);
      logger.info(`[ACS] GPV/SPV Response: ${sess.sn} | ${Object.keys(params).length} params`);
      if (Object.keys(params).length > 0) {
        await saveOnt(sess.sn, sess.inform, params, remoteIp);
      }
      sess.step = 'done';
      sessions.delete(remoteIp);
    } else {
      logger.warn(`[ACS] GPV Response from ${remoteIp} — no active session`);
    }
    return { status: 204, body: '' };
  }

  // ── TRANSFER COMPLETE ────────────────────────────────────────────
  if (body.includes('TransferComplete')) {
    logger.info(`[ACS] TransferComplete from ${remoteIp}`);
    return { status: 204, body: '' };
  }

  // ── EMPTY POST — ONT minta perintah ──────────────────────────────
  let sess = sessions.get(remoteIp);

  // Kalau tidak ada session by IP, cari by waktu terbaru
  if (!sess) {
    let latest = null;
    for (const [ip, s] of sessions) {
      if (s.step === 'need_cmd' && (!latest || s.lastSeen > latest.lastSeen)) {
        latest = { ip, s };
      }
    }
    if (latest && Date.now() - latest.s.lastSeen < 60000) {
      // Pindahkan session ke IP baru
      sess = latest.s;
      sessions.delete(latest.ip);
      sessions.set(remoteIp, sess);
      logger.debug(`[ACS] Session moved from ${latest.ip} to ${remoteIp} for ${sess.sn}`);
    }
  }

  if (sess?.step === 'need_cmd') {
    const sn = sess.sn;

    // Cek apakah ada command yang antri
    const nextCmd = buildNextCommand(sn);
    if (nextCmd) {
      sess.step = 'gpv_sent';
      sess.lastSeen = Date.now();
      return { status: 200, body: nextCmd };
    }

    // Tidak ada command → kirim GPV untuk refresh data
    sess.step = 'gpv_sent';
    sess.lastSeen = Date.now();
    logger.info(`[ACS] Sending GPV to ${sn}`);
    return { status: 200, body: soapGetParameterValues() };
  }

  logger.debug(`[ACS] Empty POST from ${remoteIp} | sessions: ${[...sessions.keys()].join(',') || 'none'}`);
  return { status: 204, body: '' };
}

// ── Raw TCP Server ────────────────────────────────────────────────────
function createRawServer() {
  return net.createServer((socket) => {
    const remoteIp = (socket.remoteAddress || '').replace('::ffff:','');
    let   buf      = Buffer.alloc(0);
    let   handled  = false;

    socket.setTimeout(15000);
    socket.on('timeout', () => socket.destroy());
    socket.on('error',   () => {});

    socket.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (handled) return;

      const text    = buf.toString('utf8');
      const hdrEnd  = text.indexOf('\r\n\r\n');
      if (hdrEnd === -1) return;

      const hdr     = text.substring(0, hdrEnd);
      const clMatch = hdr.match(/Content-Length:\s*(\d+)/i);
      const cl      = clMatch ? parseInt(clMatch[1]) : 0;
      const bStart  = hdrEnd + 4;
      if (buf.length - bStart < cl) return;

      handled    = true;
      const body = buf.slice(bStart, bStart + cl).toString('utf8');

      if (!hdr.startsWith('POST')) {
        socket.write(httpResp(404, ''));
        socket.end();
        return;
      }

      try {
        const result = await handleRequest(remoteIp, body);
        socket.write(httpResp(result.status, result.body));
      } catch(e) {
        logger.error('[ACS] Handler error:', e.message);
        socket.write(httpResp(204, ''));
      }
      socket.end();
    });
  });
}

// ── Local IP helper ───────────────────────────────────────────────────
function getLocalIP() {
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  const os = require('os');
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')) return i.address;
    }
  }
  return '127.0.0.1';
}

// ── Start ─────────────────────────────────────────────────────────────
function startACSServer(port = 7547) {
  const server = createRawServer();

  server.listen(port, '0.0.0.0', () => {
    const ip = getLocalIP();
    logger.info(`[ACS] TR-069 CWMP Server listening on 0.0.0.0:${port}`);
    logger.info(`[ACS] ONT ACS URL: http://${ip}:${port}/acs`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') logger.error(`[ACS] Port ${port} sudah dipakai`);
    else logger.error('[ACS] Server error:', err.message);
  });

  // Cleanup stale sessions (> 15 menit)
  setInterval(() => {
    const cut = Date.now() - 15 * 60 * 1000;
    for (const [ip, s] of sessions) if (s.lastSeen < cut) sessions.delete(ip);
  }, 5 * 60 * 1000);

  return server;
}

module.exports = { startACSServer, ACSCommandQueue };