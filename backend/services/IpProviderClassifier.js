/**
 * IpProviderClassifier.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Klasifikasi destination IP → Provider/CDN + Kategori konten.
 *
 * MikroTik connection tracking hanya kasih IP mentah. Untuk summary "akses ke
 * Google CDN / Meta CDN / dll", kita cocokkan IP ke blok CIDR milik provider
 * besar yang dipublikasikan. Cara ini jauh lebih akurat daripada reverse DNS
 * (banyak IP CDN tidak punya PTR jelas).
 *
 * Mapping ini SNAPSHOT manual dari blok IP utama tiap provider (per 2026).
 * Tidak 100% lengkap — blok CDN besar berubah & sangat banyak. Tapi cukup
 * meng-cover mayoritas traffic ISP rumahan/UMKM (streaming, social, gaming).
 * IP yang tidak match → kategori "Lainnya".
 *
 * Cara kerja lookup: konversi IP & CIDR ke integer 32-bit, cek apakah
 * (ip & mask) === (network & mask). Linear scan — daftar < 200 entri jadi
 * murah; kalau perlu skala besar nanti bisa diganti dengan radix/patricia trie.
 */

'use strict';

// ── Definisi provider: { name, category, color, cidrs: [...] } ──
// category dipakai untuk grouping kasar (Streaming/Social/dll).
// color dipakai konsisten di donut chart frontend.
const PROVIDERS = [
  {
    name: 'Google / YouTube',
    category: 'Streaming & Search',
    color: '#ea4335',
    cidrs: [
      '8.8.4.0/24', '8.8.8.0/24', '8.34.208.0/20', '8.35.192.0/20',
      '23.236.48.0/20', '23.251.128.0/19',
      '34.0.0.0/9', '35.184.0.0/13', '35.192.0.0/14', '35.196.0.0/15',
      '35.198.0.0/16', '35.199.0.0/17', '35.200.0.0/13', '35.208.0.0/12',
      '64.233.160.0/19', '66.102.0.0/20', '66.249.64.0/19',
      '72.14.192.0/18', '74.125.0.0/16',
      '108.177.0.0/17', '130.211.0.0/16',
      '142.250.0.0/15', '142.251.0.0/16',
      '172.217.0.0/16', '172.253.0.0/16',
      '173.194.0.0/16', '209.85.128.0/17', '216.58.192.0/19', '216.239.32.0/19',
    ],
  },
  {
    name: 'Meta (Facebook/Instagram/WA)',
    category: 'Social Media',
    color: '#1877f2',
    cidrs: [
      '31.13.24.0/21', '31.13.64.0/18', '31.13.96.0/19',
      '45.64.40.0/22', '57.144.0.0/14',
      '66.220.144.0/20', '69.63.176.0/20', '69.171.224.0/19',
      '74.119.76.0/22', '102.132.96.0/20',
      '103.4.96.0/22', '129.134.0.0/16',
      '157.240.0.0/16', '173.252.64.0/18',
      '179.60.192.0/22', '185.60.216.0/22',
      '204.15.20.0/22',
    ],
  },
  {
    name: 'Cloudflare',
    category: 'CDN & Hosting',
    color: '#f48120',
    cidrs: [
      '104.16.0.0/13', '104.24.0.0/14',
      '108.162.192.0/18', '131.0.72.0/22',
      '141.101.64.0/18', '162.158.0.0/15',
      '172.64.0.0/13', '173.245.48.0/20',
      '188.114.96.0/20', '190.93.240.0/20',
      '197.234.240.0/22', '198.41.128.0/17',
    ],
  },
  {
    name: 'Amazon AWS / CloudFront',
    category: 'CDN & Hosting',
    color: '#ff9900',
    cidrs: [
      '3.0.0.0/9', '13.32.0.0/15', '13.224.0.0/14',
      '18.64.0.0/10', '52.84.0.0/15', '54.182.0.0/16',
      '54.192.0.0/16', '54.230.0.0/16', '54.239.128.0/18',
      '99.84.0.0/16', '143.204.0.0/16', '204.246.164.0/22',
    ],
  },
  {
    name: 'Microsoft / Azure',
    category: 'CDN & Hosting',
    color: '#0078d4',
    cidrs: [
      '13.64.0.0/11', '13.104.0.0/14',
      '20.0.0.0/8',
      '40.64.0.0/10', '52.96.0.0/12', '52.224.0.0/11',
      '104.40.0.0/13', '131.253.1.0/24',
      '157.55.0.0/16', '204.79.195.0/24',
    ],
  },
  {
    name: 'Netflix',
    category: 'Streaming',
    color: '#e50914',
    cidrs: [
      '23.246.0.0/18', '37.77.184.0/21', '45.57.0.0/17',
      '64.120.128.0/17', '66.197.128.0/17',
      '108.175.32.0/20', '185.2.220.0/22', '185.9.188.0/22',
      '192.173.64.0/18', '198.38.96.0/19', '198.45.48.0/20',
      '208.75.76.0/22',
    ],
  },
  {
    name: 'Akamai',
    category: 'CDN & Hosting',
    color: '#0099cc',
    cidrs: [
      '23.0.0.0/12', '23.32.0.0/11', '23.192.0.0/11',
      '72.246.0.0/15', '88.221.0.0/16', '92.122.0.0/15',
      '95.100.0.0/15', '96.16.0.0/15', '104.64.0.0/10',
      '184.24.0.0/13', '184.50.0.0/15', '184.84.0.0/14',
    ],
  },
  {
    name: 'TikTok / ByteDance',
    category: 'Social Media',
    color: '#000000',
    cidrs: [
      '23.236.112.0/20', '101.36.96.0/19',
      '147.92.128.0/17', '161.117.0.0/16',
      '163.181.0.0/16', '170.33.0.0/16',
      '180.184.0.0/16', '184.78.0.0/16',
    ],
  },
  {
    name: 'Apple',
    category: 'CDN & Hosting',
    color: '#555555',
    cidrs: [
      '17.0.0.0/8',
      '139.178.128.0/18', '144.178.0.0/19',
    ],
  },
  {
    name: 'Twitter / X',
    category: 'Social Media',
    color: '#1da1f2',
    cidrs: [
      '104.244.40.0/21', '192.133.76.0/22',
      '199.16.156.0/22', '199.59.148.0/22', '209.237.192.0/19',
    ],
  },
];

// ── Build flat lookup array sekali di module load ──
// Setiap entri: { netInt, maskInt, provider, category, color, name }
function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = parseInt(p, 10);
    if (isNaN(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0; // unsigned
}

function cidrToRange(cidr) {
  const [ip, bitsStr] = String(cidr).split('/');
  const bits = parseInt(bitsStr, 10);
  const netInt = ipToInt(ip);
  if (netInt == null || isNaN(bits) || bits < 0 || bits > 32) return null;
  const maskInt = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return { netInt: (netInt & maskInt) >>> 0, maskInt };
}

const _LOOKUP = [];
for (const prov of PROVIDERS) {
  for (const cidr of prov.cidrs) {
    const range = cidrToRange(cidr);
    if (!range) continue;
    _LOOKUP.push({
      netInt: range.netInt,
      maskInt: range.maskInt,
      name: prov.name,
      category: prov.category,
      color: prov.color,
    });
  }
}
// Urutkan dari mask paling spesifik (terbesar) ke umum supaya match paling
// presisi menang kalau ada overlap.
_LOOKUP.sort((a, b) => b.maskInt - a.maskInt);

/**
 * Klasifikasi 1 IP → { name, category, color } atau null kalau tidak match.
 */
function classifyIp(ip) {
  const ipInt = ipToInt(ip);
  if (ipInt == null) return null;
  for (const entry of _LOOKUP) {
    if (((ipInt & entry.maskInt) >>> 0) === entry.netInt) {
      return { name: entry.name, category: entry.category, color: entry.color };
    }
  }
  return null;
}

const UNKNOWN = { name: 'Lainnya', category: 'Lainnya', color: '#94a3b8' };

/**
 * Agregasi list connection (hasil getTopConnections, sebelum slice top-N
 * idealnya pakai SEMUA connection) → summary per provider & per kategori.
 *
 * @param {Array<{dst, bytes, connections}>} connItems
 * @returns {{
 *   providers: Array<{name, category, color, bytes, connections, pct}>,
 *   categories: Array<{category, color, bytes, connections, pct}>,
 *   totalBytes, totalConnections, classifiedBytes, unknownBytes
 * }}
 */
function summarize(connItems) {
  const byProvider = {}; // name → {name,category,color,bytes,connections}
  const byCategory = {}; // category → {category,color,bytes,connections}
  let totalBytes = 0, totalConnections = 0, classifiedBytes = 0;

  for (const item of (connItems || [])) {
    const bytes = item.bytes || 0;
    const conns = item.connections || 1;
    totalBytes += bytes;
    totalConnections += conns;

    const cls = classifyIp(item.dst) || UNKNOWN;
    if (cls !== UNKNOWN) classifiedBytes += bytes;

    if (!byProvider[cls.name]) {
      byProvider[cls.name] = { name: cls.name, category: cls.category, color: cls.color, bytes: 0, connections: 0 };
    }
    byProvider[cls.name].bytes += bytes;
    byProvider[cls.name].connections += conns;

    if (!byCategory[cls.category]) {
      // Warna kategori = warna provider pertama yang muncul di kategori itu
      byCategory[cls.category] = { category: cls.category, color: cls.color, bytes: 0, connections: 0 };
    }
    byCategory[cls.category].bytes += bytes;
    byCategory[cls.category].connections += conns;
  }

  const pct = (b) => totalBytes > 0 ? Math.round((b / totalBytes) * 1000) / 10 : 0;

  const providers = Object.values(byProvider)
    .sort((a, b) => b.bytes - a.bytes)
    .map(p => ({ ...p, pct: pct(p.bytes) }));

  const categories = Object.values(byCategory)
    .sort((a, b) => b.bytes - a.bytes)
    .map(c => ({ ...c, pct: pct(c.bytes) }));

  return {
    providers,
    categories,
    totalBytes,
    totalConnections,
    classifiedBytes,
    unknownBytes: totalBytes - classifiedBytes,
  };
}

module.exports = { classifyIp, summarize, PROVIDERS, aggregateByDomain };

/**
 * Ekstrak "registrable domain" dari hostname penuh.
 * Contoh:
 *   r1---sn-x.googlevideo.com  → googlevideo.com
 *   scontent-sin.fbcdn.net     → fbcdn.net
 *   www.tokopedia.com          → tokopedia.com
 *
 * Catatan: ini heuristik sederhana (ambil 2 label terakhir), plus daftar
 * kecil ccTLD bertingkat (co.id, co.uk, dll) supaya "x.co.id" → "x.co.id".
 * Bukan PSL penuh, tapi cukup untuk tampilan top-domain.
 */
const MULTI_TLD = new Set([
  'co.id','or.id','go.id','ac.id','sch.id','web.id','my.id','biz.id',
  'co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','co.jp','com.sg',
  'com.my','com.br','com.cn','com.hk','co.kr',
]);
function registrableDomain(host) {
  if (!host) return '';
  let h = String(host).toLowerCase().replace(/\.$/, '');
  // Buang skema/path kalau ada
  h = h.replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0];
  // Kalau IP literal, kembalikan apa adanya
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  const last3 = parts.slice(-3).join('.');
  if (MULTI_TLD.has(last2)) return last3;
  return last2;
}

/**
 * Agregasi traffic per DOMAIN.
 *
 * @param {Array<{dst, bytes, connections}>} connItems  agregat per IP
 * @param {Array<{name, address}>}           dnsCache    DNS cache router
 * @returns {{ domains: Array<{domain, bytes, connections, pct}>, matchedBytes, totalBytes }}
 *
 * Cara kerja: bangun map IP → domain dari dnsCache (1 IP bisa punya banyak
 * domain; ambil yang pertama/terpendek sebagai representatif), lalu jumlahkan
 * bytes tiap IP ke registrable-domain-nya. IP yang tidak ada di cache → skip.
 */
function aggregateByDomain(connItems, dnsCache) {
  // IP → hostname representatif (pilih hostname terpendek = paling "akar")
  const ipToHost = {};
  for (const r of (dnsCache || [])) {
    const ip = (r.address || '').trim();
    const nm = (r.name || '').trim();
    if (!ip || !nm) continue;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue; // hanya A record IPv4
    if (!ipToHost[ip] || nm.length < ipToHost[ip].length) ipToHost[ip] = nm;
  }

  const byDomain = {};
  let totalBytes = 0, matchedBytes = 0;
  for (const item of (connItems || [])) {
    const bytes = item.bytes || 0;
    const conns = item.connections || 1;
    totalBytes += bytes;
    const host = ipToHost[item.dst];
    if (!host) continue; // tidak ketemu di DNS cache
    const dom = registrableDomain(host);
    if (!dom) continue;
    matchedBytes += bytes;
    if (!byDomain[dom]) byDomain[dom] = { domain: dom, bytes: 0, connections: 0 };
    byDomain[dom].bytes += bytes;
    byDomain[dom].connections += conns;
  }

  const pct = (b) => matchedBytes > 0 ? Math.round((b / matchedBytes) * 1000) / 10 : 0;
  const domains = Object.values(byDomain)
    .sort((a, b) => b.bytes - a.bytes)
    .map(d => ({ ...d, pct: pct(d.bytes) }));

  return { domains, matchedBytes, totalBytes };
}
