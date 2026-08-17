'use strict';
/**
 * PingService — ICMP ping via child_process (Linux/Windows adaptive)
 * Fallback ke TCP connect bila ICMP tidak tersedia (permission issue)
 */

const { exec }  = require('child_process');
const net        = require('net');
const os         = require('os');

const IS_WIN = os.platform() === 'win32';

// ─── ICMP ping via system ping command ───────────────────────────────────────
function pingICMP(host, timeoutSec = 4, count = 4) {
  return new Promise((resolve) => {
    // Linux: ping -c <count> -W <timeout> <host>
    // Windows: ping -n <count> -w <timeoutMs> <host>
    const cmd = IS_WIN
      ? `ping -n ${count} -w ${timeoutSec * 1000} ${host}`
      : `ping -c ${count} -W ${timeoutSec} -w ${timeoutSec * count} ${host}`;

    const startAt = Date.now();

    exec(cmd, { timeout: (timeoutSec * count + 2) * 1000 }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      const elapsed = Date.now() - startAt;

      if (err && !stdout) {
        resolve({ success: false, host, method: 'icmp', error: 'Host unreachable or timeout', raw: output.trim() });
        return;
      }

      // Parse hasil ping
      const result = IS_WIN ? parseWinPing(output, host, elapsed) : parseLinuxPing(output, host, elapsed);
      resolve(result);
    });
  });
}

// ─── TCP connect fallback (port 80, 443, 22) ─────────────────────────────────
function pingTCP(host, port = 80, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const startAt = Date.now();
    const sock = new net.Socket();

    sock.setTimeout(timeoutMs);
    sock.connect(port, host, () => {
      const ms = Date.now() - startAt;
      sock.destroy();
      resolve({
        success:    true,
        host,
        method:     `tcp:${port}`,
        sent:       1,
        received:   1,
        loss:       0,
        rtt_min:    ms,
        rtt_avg:    ms,
        rtt_max:    ms,
        pings:      [{ seq: 1, ttl: null, ms }],
        raw:        `TCP connect to ${host}:${port} OK in ${ms}ms`
      });
    });

    sock.on('error', (e) => {
      sock.destroy();
      resolve({ success: false, host, method: `tcp:${port}`, error: e.message, raw: '' });
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ success: false, host, method: `tcp:${port}`, error: 'TCP timeout', raw: '' });
    });
  });
}

// ─── Smart ping: ICMP first, TCP fallback ────────────────────────────────────
async function ping(host, timeoutSec = 4, count = 4) {
  if (!host || !host.trim()) {
    return { success: false, host: host || '', error: 'No host specified', method: 'none' };
  }

  // Sanitize — cegah command injection
  const clean = host.trim().replace(/[^a-zA-Z0-9.\-:_]/g, '');
  if (!clean) return { success: false, host, error: 'Invalid host', method: 'none' };

  const icmp = await pingICMP(clean, timeoutSec, count);

  // Kalau ICMP sukses atau host memang unreachable, kembalikan hasil ICMP
  if (icmp.success || icmp.error === 'Host unreachable or timeout') return icmp;

  // ICMP gagal karena permission / not supported → coba TCP port 80, 443
  const tcp80  = await pingTCP(clean, 80,  timeoutSec * 1000);
  if (tcp80.success) return tcp80;

  const tcp443 = await pingTCP(clean, 443, timeoutSec * 1000);
  if (tcp443.success) return tcp443;

  // Semua gagal — kembalikan hasil ICMP asli
  return icmp;
}

// ─── Parse Linux ping output ──────────────────────────────────────────────────
function parseLinuxPing(output, host, elapsed) {
  // Contoh: 64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=12.3 ms
  const lineRe   = /icmp_seq=(\d+).*?ttl=(\d+).*?time=([\d.]+)\s*ms/gi;
  const statsRe  = /(\d+) packets transmitted,\s*(\d+) (?:packets )?received/i;
  const rttRe    = /rtt.*?=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/i;

  const pings = [];
  let m;
  while ((m = lineRe.exec(output)) !== null) {
    pings.push({ seq: parseInt(m[1]), ttl: parseInt(m[2]), ms: parseFloat(m[3]) });
  }

  const stats = statsRe.exec(output);
  const rtt   = rttRe.exec(output);

  const sent     = stats ? parseInt(stats[1]) : 0;
  const received = stats ? parseInt(stats[2]) : pings.length;
  const loss     = sent > 0 ? Math.round(((sent - received) / sent) * 100) : 100;

  return {
    success:  received > 0,
    host,
    method:   'icmp',
    sent,
    received,
    loss,
    rtt_min:  rtt ? parseFloat(rtt[1]) : (pings[0]?.ms ?? null),
    rtt_avg:  rtt ? parseFloat(rtt[2]) : (pings.reduce((a, p) => a + p.ms, 0) / (pings.length || 1) || null),
    rtt_max:  rtt ? parseFloat(rtt[3]) : (pings[pings.length - 1]?.ms ?? null),
    pings,
    raw: output.trim().split('\n').slice(-5).join('\n')
  };
}

// ─── Parse Windows ping output ────────────────────────────────────────────────
function parseWinPing(output, host, elapsed) {
  const lineRe  = /Reply from.*?time[=<]([\d.]+)ms.*?TTL=(\d+)/gi;
  const statsRe = /Packets: Sent = (\d+), Received = (\d+)/i;
  const rttRe   = /Minimum = (\d+)ms.*?Maximum = (\d+)ms.*?Average = (\d+)ms/i;

  const pings = [];
  let m, seq = 1;
  while ((m = lineRe.exec(output)) !== null) {
    pings.push({ seq: seq++, ttl: parseInt(m[2]), ms: parseFloat(m[1]) });
  }

  const stats = statsRe.exec(output);
  const rtt   = rttRe.exec(output);

  const sent     = stats ? parseInt(stats[1]) : 0;
  const received = stats ? parseInt(stats[2]) : pings.length;
  const loss     = sent > 0 ? Math.round(((sent - received) / sent) * 100) : 100;

  return {
    success:  received > 0,
    host,
    method:   'icmp',
    sent,
    received,
    loss,
    rtt_min:  rtt ? parseInt(rtt[1]) : (pings[0]?.ms ?? null),
    rtt_avg:  rtt ? parseInt(rtt[3]) : (pings.reduce((a, p) => a + p.ms, 0) / (pings.length || 1) || null),
    rtt_max:  rtt ? parseInt(rtt[2]) : (pings[pings.length - 1]?.ms ?? null),
    pings,
    raw: output.trim().split('\n').slice(-6).join('\n')
  };
}

module.exports = { ping, pingICMP, pingTCP };
