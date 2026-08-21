'use strict';

/**
 * ZteOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * Live management OLT ZTE GPON (C320 / C300) via CLI (Telnet / SSH).
 *
 * Berbeda dengan HsgqOltService (SNMP read-only), service ini terhubung
 * langsung ke CLI OLT untuk:
 *   - Baca daftar ONU + status   (show gpon onu state ...)
 *   - Baca redaman / optical power (show pon power attenuation ...)
 *   - Lihat detail ONU            (show gpon onu detail-info ...)
 *   - Lihat ONU belum terdaftar   (show gpon onu uncfg)
 *   - Authorize / tambah ONU      (interface gpon-olt ... → onu N type T sn SN)
 *   - Reboot ONU                  (pon-onu-mng ... → reboot)
 *   - Hapus / unauthorize ONU     (no onu N)
 *
 * Protokol koneksi:
 *   - telnet (default, paling umum di OLT ZTE)
 *   - ssh    (jika OLT dikonfigurasi SSH)
 *
 * CATATAN PENTING:
 *   Perintah CLI ZTE dapat sedikit berbeda antar versi firmware (V1.x vs V2.x).
 *   Parser di sini dibuat toleran terhadap variasi spasi/kolom. Tetap lakukan
 *   "Test Koneksi" setelah menambah OLT untuk memverifikasi.
 *
 * Format index ONU ZTE: gpon-onu_<frame>/<slot>/<port>:<onu_id>
 *   contoh: gpon-onu_1/2/5:5  → frame 1, slot 2, port 5, onu 5
 * Format index PON port:  gpon-olt_<frame>/<slot>/<port>
 * ─────────────────────────────────────────────────────────────────────
 */


const BaseCliOltService = require('./BaseCliOltService');
const logger = require('../utils/logger');

class ZteOltService extends BaseCliOltService {
  constructor(config = {}) {
    super(config);  // koneksi Telnet/SSH ditangani BaseCliOltService
    this.brand = 'zte';
    // ZTE ZXAN: matikan paging. Default base 'terminal length 0' kadang tak cukup.
    this.pagingOffCmd = config.pagingOffCmd || 'terminal length 0';
  }

  // ════════════════════════════════════════════════════════════════════
  // SANITASI INPUT CLI — cegah command injection.
  // CLI OLT berbasis baris: nilai yang mengandung newline/CR bisa MENYUNTIKKAN
  // perintah kedua ke OLT. Semua nilai dari user WAJIB lewat sanitizer ini
  // sebelum disisipkan ke perintah. Tiap tipe punya aturan ketat sendiri.
  // ════════════════════════════════════════════════════════════════════

  // Buang semua karakter kontrol (newline, CR, tab, dll) — pertahanan utama
  // terhadap injeksi perintah, dipakai sebagai dasar semua sanitizer lain.
  _stripCtrl(v) {
    return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '');
  }

  // SN ONU: huruf, angka, titik, strip, titik-dua. Maks 32. (mis. ZTEGD11369BD)
  _sanSn(v) {
    const s = this._stripCtrl(v).trim();
    const clean = s.replace(/[^A-Za-z0-9.:_-]/g, '');
    if (!clean) throw new Error('SN tidak valid');
    return clean.slice(0, 32);
  }

  // Type ONU: huruf, angka, strip, titik, garis bawah. (mis. ZTE-F660, F663NV3a)
  _sanType(v) {
    const s = this._stripCtrl(v).trim();
    const clean = s.replace(/[^A-Za-z0-9._-]/g, '');
    if (!clean) throw new Error('Type ONU tidak valid');
    return clean.slice(0, 32);
  }

  // Nama profil / VLAN-name / nama service: huruf, angka, titik, strip, garis bawah.
  // Spasi → underscore (ZTE tak menerima spasi tanpa kutip). Maks 32.
  _sanName(v) {
    const s = this._stripCtrl(v).trim().replace(/\s+/g, '_');
    const clean = s.replace(/[^A-Za-z0-9._-]/g, '');
    return clean.slice(0, 32);
  }

  // Deskripsi/teks bebas: izinkan lebih luas TAPI tetap tanpa karakter kontrol
  // & tanpa metakarakter yang bisa mengubah parsing. Spasi → underscore.
  _sanText(v) {
    const s = this._stripCtrl(v).trim().replace(/\s+/g, '_');
    const clean = s.replace(/[^A-Za-z0-9._\-]/g, '');
    return clean.slice(0, 64);
  }

  // Angka dalam rentang. Lempar bila di luar rentang (cegah nilai liar).
  _sanInt(v, { min = 0, max = 4294967295, label = 'angka' } = {}) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || isNaN(n)) throw new Error(`${label} harus angka`);
    if (n < min || n > max) throw new Error(`${label} harus ${min}-${max}`);
    return n;
  }

  // Setelah konek, pastikan paging benar-benar mati (coba beberapa varian).
  async connect() {
    const r = await super.connect();
    // Beberapa firmware C320/C300 memakai perintah berbeda untuk disable paging.
    await this._safeExec('terminal length 0');
    await this._safeExec('screen-length 0 temporary');
    return r;
  }

  // ── Test koneksi ───────────────────────────────────────────────────
  async testConnection() {
    try {
      await this.connect();
      const out = await this._safeExec('show system-group')
              || await this._safeExec('show version-running')
              || await this._safeExec('show card');
      await this.disconnect();
      const firstLine = String(out).split('\n').map(s => s.trim()).filter(Boolean)[0] || 'OK';
      return { success: true, message: `Terhubung ke ${this.name} (${this.protocol.toUpperCase()})`, info: firstLine.slice(0, 160) };
    } catch (err) {
      await this.disconnect();
      return { success: false, error: err.message };
    }
  }

  // ── Daftar kartu / slot PON ────────────────────────────────────────
  // Mengembalikan rincian lengkap tiap slot: rack/shelf/slot, CfgType,
  // RealType, jumlah PON port, HW Ver, SW Ver, status, suhu (show temperature),
  // CPU 5-menit, Memory% (show processor). Berguna untuk UI Sistem.
  async getCards() {
    const out = await this.exec('show card');
    const cards = this._parseCards(out);
    // Pengayaan: suhu + CPU + memory per-slot dari show temperature / show processor
    try {
      const env = await this._getEnvironment();
      if (env) {
        for (const c of cards) {
          if (env.perSlot && env.perSlot[c.slot] != null) c.temperature_c = env.perSlot[c.slot];
          if (env.perSlotCpu && env.perSlotCpu[c.slot] != null) c.cpu_percent = env.perSlotCpu[c.slot];
          if (env.perSlotMem && env.perSlotMem[c.slot] != null) c.mem_percent = env.perSlotMem[c.slot];
          if (env.perSlotMemMb && env.perSlotMemMb[c.slot] != null) c.mem_mb = env.perSlotMemMb[c.slot];
        }
      }
    } catch (e) { /* abaikan — kartu tetap dikembalikan walau tanpa enrichment */ }
    return cards;
  }

  // ── Auto-discover daftar PON port (frame/slot/port) ────────────────
  // Dipakai untuk auto-load saat halaman pertama dibuka, tanpa perlu user
  // mengetik PON port satu per satu. Sumber utama: "show card" → cari kartu
  // GPON (GTGO/GTGH/etc) lalu turunkan port sesuai jumlah port kartu. Bila
  // gagal, fallback ke "show gpon onu state" global untuk menyimpulkan port
  // yang sedang dipakai.
  async discoverPonPorts({ maxPortsPerCard = 16 } = {}) {
    const ports = new Set();

    // 1) Dari show card — kartu GPON punya kolom Port (jumlah PON).
    try {
      const cardOut = await this.exec('show card');
      String(cardOut).split('\n').forEach(line => {
        const l = line.trim();
        // Rack Shelf Slot CfgType RealType Port HardVer SoftVer Status
        const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\b/);
        if (!m) return;
        const realType = m[5];
        // Kartu PON GPON ZTE biasanya diawali GT (GTGO/GTGH/GTGOG) atau mengandung "GPON".
        if (!/^GT|GPON/i.test(realType)) return;
        if (!/INSERVICE/i.test(l)) return; // hanya kartu aktif
        const frame = parseInt(m[1]) || 1;
        const slot  = parseInt(m[3]);
        const portCount = Math.min(parseInt(m[6]) || 0, maxPortsPerCard);
        for (let p = 1; p <= portCount; p++) ports.add(`${frame}/${slot}/${p}`);
      });
    } catch (e) { /* lanjut ke fallback */ }

    // 2) Fallback: simpulkan dari state ONU global (port yang punya ONU).
    if (!ports.size) {
      try {
        const out = await this._safeExec('show gpon onu state');
        String(out).split('\n').forEach(line => {
          const m = line.trim().match(/(?:gpon-onu_)?(\d+\/\d+\/\d+):\d+/i);
          if (m) ports.add(m[1]);
        });
      } catch (e) { /* abaikan */ }
    }

    return [...ports].sort((a, b) => {
      const pa = a.split('/').map(Number), pb = b.split('/').map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
  }

  // ── Ambil SEMUA ONU lintas PON port dalam satu koneksi ─────────────
  // Mengembalikan { onus, ports } siap pakai untuk dashboard auto-load.
  async getAllOnus({ withPower = false, ports = null, maxPorts = 32 } = {}) {
    const ponPorts = (ports && ports.length) ? ports : await this.discoverPonPorts();
    // Dedup + urutkan PON agar tidak ada ONU dobel bila discovery mengembalikan duplikat.
    const seenPon = new Set();
    const slice = ponPorts
      .map(p => this._normOltIf(p).replace('gpon-olt_', ''))
      .filter(p => { if (seenPon.has(p)) return false; seenPon.add(p); return true; })
      .slice(0, maxPorts);

    const allOnus = [];
    const portSummary = [];

    // Ambil SEKALI dari running-config penuh: nama, deskripsi, SN, dan type
    // untuk SELURUH ONU lintas PON. Ini menghindari pemanggilan
    // "show running-config" berulang per-PON (bug performa lama).
    let globalMeta = {};
    try { globalMeta = await this._fetchAllOnuMeta(); } catch (e) { /* lanjut tanpa meta */ }

    const seenOnu = new Set();   // dedup ONU global (key onu_if)

    for (const ponPart of slice) {
      const pon = `gpon-olt_${ponPart}`;
      let list = null;
      // Resilient: coba sekali, bila gagal (CLI hiccup) ulangi sekali lagi.
      for (let attempt = 0; attempt < 2 && list === null; attempt++) {
        try {
          // skipMeta:true → JANGAN baca running-config per-PON (sudah ada di globalMeta).
          list = await this.getOnuState(pon, { withNames: false, skipMeta: true });
        } catch (e) {
          if (attempt === 1) {
            portSummary.push({ port: pon, total: 0, online: 0, offline: 0, error: e.message });
          }
        }
      }
      if (list === null) continue;

      // Terapkan meta global (nama/desc/sn/type) + dedup.
      const deduped = [];
      for (const o of list) {
        if (seenOnu.has(o.onu_if)) continue;
        seenOnu.add(o.onu_if);
        const meta = globalMeta[`${ponPart}:${o.onu_id}`];
        if (meta) {
          if (meta.name) o.name = meta.name;
          if (meta.desc) o.description = meta.desc;
          if (meta.sn && !o.sn) o.sn = meta.sn;
          if (meta.type && !o.type) o.type = meta.type;
        }
        o.pon = pon;
        deduped.push(o);
      }

      if (withPower) {
        for (const o of deduped) {
          try { const p = await this.getOnuPower(o.onu_if); o.onu_rx_dbm = p.onu_rx_dbm; o.quality = p.quality; }
          catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
        }
      }

      allOnus.push(...deduped);
      const online = deduped.filter(o => o.status === 'online').length;
      portSummary.push({ port: pon, total: deduped.length, online, offline: deduped.length - online });
    }
    return { onus: allOnus, ports: portSummary, scannedPorts: slice.map(p => `gpon-olt_${p}`) };
  }

  // Ambil META lengkap (nama, deskripsi, SN, type) SEMUA ONU dari running-config
  // penuh OLT — satu perintah untuk seluruh PON. Return { "F/S/P:N": {name,desc,sn,type} }.
  async _fetchAllOnuMeta() {
    const map = {};
    const cmds = ['show running-config', 'show current-config', 'show run'];
    let cfg = '';
    for (const c of cmds) {
      cfg = await this._safeExec(c);
      if (cfg && /interface\s+gpon-onu_/i.test(cfg)) break;
    }
    if (!cfg) return map;

    const ensure = (key) => (map[key] = map[key] || {});
    let curOnuKey = null;   // saat di dalam blok "interface gpon-onu_F/S/P:N"
    let curOltPon = null;   // saat di dalam blok "interface gpon-olt_F/S/P"

    cfg.split('\n').forEach(raw => {
      const line = raw.trim();

      // Masuk blok interface gpon-onu_ (punya name/description)
      const onuEnt = line.match(/^interface\s+gpon-onu_(\d+\/\d+\/\d+:\d+)/i);
      if (onuEnt) { curOnuKey = onuEnt[1]; curOltPon = null; ensure(curOnuKey); return; }

      // Masuk blok interface gpon-olt_ (punya "onu N type X sn Y")
      const oltEnt = line.match(/^interface\s+gpon-olt_(\d+\/\d+\/\d+)/i);
      if (oltEnt) { curOltPon = oltEnt[1]; curOnuKey = null; return; }

      // Keluar blok
      if (line === '!' || /^interface\s/i.test(line)) {
        if (!onuEnt && !oltEnt) { curOnuKey = null; curOltPon = null; }
      }

      // Di dalam blok gpon-onu: nama & deskripsi
      if (curOnuKey) {
        const nm = line.match(/^name\s+(.+)/i);
        if (nm) { const v = nm[1].trim(); if (!/^ONU-\d+[:_]\d+$/i.test(v)) ensure(curOnuKey).name = v; return; }
        const ds = line.match(/^description\s+(.+)/i);
        if (ds) { const v = ds[1].trim(); if (!/^ONU-\d+[:_]\d+$/i.test(v)) ensure(curOnuKey).desc = v; return; }
      }

      // Di dalam blok gpon-olt: "onu N type TYPE sn SN"
      if (curOltPon) {
        const om = line.match(/^onu\s+(\d+)\s+type\s+(\S+)\s+sn\s+(\S+)/i);
        if (om) {
          const key = `${curOltPon}:${parseInt(om[1])}`;
          const e = ensure(key);
          e.type = om[2]; e.sn = om[3];
        }
      }
    });
    return map;
  }

  // Ambil nama/deskripsi SEMUA ONU dari running-config penuh OLT.
  // Return map { "F/S/P:N": {name, desc} }.  (dipakai jalur lama/single-PON)
  async _fetchAllOnuNames() {
    const meta = await this._fetchAllOnuMeta();
    const map = {};
    Object.keys(meta).forEach(k => {
      const { name, desc } = meta[k];
      if (name || desc) map[k] = { name, desc };
    });
    return map;
  }

  // ── Daftar semua ONU pada satu PON port ────────────────────────────
  // gponOlt: contoh "gpon-olt_1/2/1" atau hanya "1/2/1"
  async getOnuState(gponOlt, { withNames = true, deepNames = true, skipMeta = false } = {}) {
    const ifc = this._normOltIf(gponOlt);
    const out = await this.exec(`show gpon onu state ${ifc}`);
    const list = this._parseOnuState(out, ifc);

    // Lengkapi SN/type/nama dari running-config — HANYA bila tidak di-skip.
    // getAllOnus mem-pass skipMeta:true karena sudah punya meta global
    // (mencegah "show running-config" dijalankan berulang per-PON).
    if (withNames && !skipMeta && list.length) {
      try {
        const cfgOlt = await this.exec(`show running-config interface ${ifc}`);
        const metaSn = this._parseRunConfigNames(cfgOlt);
        list.forEach(o => {
          const m = metaSn[o.onu_id];
          if (m) { if (m.sn) o.sn = m.sn; if (m.type) o.type = m.type; }
        });
      } catch (e) { /* abaikan */ }

      // Nama & deskripsi ada di blok "interface gpon-onu_F/S/P:N" yang TERPISAH
      // dari interface gpon-olt. Ambil sekali untuk seluruh ONU pada PON ini.
      try {
        const ponPart = ifc.replace('gpon-olt_', '');           // "1/2/2"
        const nameMap = await this._fetchOnuNames(ponPart, list.map(o => o.onu_id), { allowPerOnu: deepNames });
        list.forEach(o => {
          const nm = nameMap[o.onu_id];
          if (nm) {
            if (nm.name) o.name = nm.name;
            if (nm.desc) o.description = nm.desc;
          }
        });
      } catch (e) { /* abaikan; list tetap tampil tanpa nama */ }
    }
    return list;
  }

  // Ambil nama/deskripsi semua ONU pada satu PON. Strategi:
  //   1) running-config penuh (paling andal, 1 perintah) → filter PON ini
  //   2) per-ONU (bila diizinkan & cara 1 gagal), dibatasi agar tak lambat
  async _fetchOnuNames(ponPart, onuIds = [], { allowPerOnu = true } = {}) {
    const map = {};
    // 1) Dari running-config penuh — andal lintas firmware.
    try {
      const all = await this._fetchAllOnuNames();   // { "F/S/P:N": {name,desc} }
      Object.keys(all).forEach(key => {
        const m = key.match(/^(.+):(\d+)$/);
        if (m && m[1] === ponPart) map[parseInt(m[2])] = all[key];
      });
      if (Object.keys(map).length) return map;
    } catch (e) { /* lanjut ke per-ONU */ }

    // 2) Fallback per-ONU (bentuk perintah yang valid: dengan id spesifik).
    if (allowPerOnu) {
      const ids = onuIds.slice(0, 64);
      for (const id of ids) {
        const out = await this._safeExec(`show running-config interface gpon-onu_${ponPart}:${id}`);
        const m = this._parseOnuIfNames(out);
        if (m[id] && (m[id].name || m[id].desc)) map[id] = m[id];
      }
    }
    return map;
  }

  // Parse blok "interface gpon-onu_F/S/P:N" → {N: {name, desc}}
  _parseOnuIfNames(out) {
    const map = {};
    let cur = null;
    String(out).split('\n').forEach(raw => {
      const line = raw.trim();
      const ent = line.match(/^interface\s+gpon-onu_\d+\/\d+\/\d+:(\d+)/i);
      if (ent) { cur = parseInt(ent[1]); map[cur] = map[cur] || {}; return; }
      if (cur != null) {
        const nm = line.match(/^name\s+(.+)/i);
        if (nm) {
          const val = nm[1].trim();
          // Abaikan nama default otomatis "ONU-x:y" (bukan nama pelanggan asli).
          if (!/^ONU-\d+[:_]\d+$/i.test(val)) map[cur].name = val;
          return;
        }
        const ds = line.match(/^description\s+(.+)/i);
        if (ds) {
          const val = ds[1].trim();
          if (!/^ONU-\d+[:_]\d+$/i.test(val)) map[cur].desc = val;
          return;
        }
        if (line === '!' || /^interface\s/i.test(line)) cur = null;
      }
    });
    return map;
  }

  // ── ONU belum terdaftar (uncfg) ────────────────────────────────────
  async getUncfgOnu() {
    const out = await this.exec('show gpon onu uncfg');
    return this._parseUncfg(out);
  }

  // ── Verifikasi pasca-provisioning / auto-troubleshoot ──────────────
  // Polling status ONU sampai online atau timeout, lalu kembalikan diagnosa
  // actionable. Dipakai setelah provisioning agar user tahu hasil sebenarnya.
  //   onuIf: "gpon-onu_1/2/2:30"
  //   opts:  { tries=6, intervalMs=8000 } → default ±48 detik
  async verifyOnu(onuIf, { tries = 6, intervalMs = 8000 } = {}) {
    const ifc = this._normOnuIf(onuIf);
    const { gponOlt, onuId } = this._splitOnuIf(ifc);
    if (!gponOlt || !onuId) throw new Error('Format ONU interface tidak valid: ' + onuIf);

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let lastPhase = '', detail = null, rx = null;

    for (let i = 0; i < tries; i++) {
      // 1) Cek phase via show gpon onu state pada PON port
      const list = await this.getOnuState(gponOlt, { withNames: false });
      const me = list.find(o => o.onu_id === onuId);
      lastPhase = me ? String(me.phase_state || '').toLowerCase().replace(/\(.*\)$/, '') : 'notfound';

      if (lastPhase === 'working' || lastPhase === 'online') {
        // sudah online → ambil power sekalian
        try { rx = await this.getOnuPower(ifc); } catch (e) {}
        return {
          online: true, phase: lastPhase, attempts: i + 1,
          onu_rx_dbm: rx?.onu_rx_dbm ?? null, quality: rx?.quality ?? null,
          message: 'ONU online & working.',
          rx_warning: rx?.onu_rx_dbm != null && rx.onu_rx_dbm < -27
            ? `Sinyal lemah (${rx.onu_rx_dbm} dBm) — periksa redaman optik.` : null,
        };
      }
      if (lastPhase === 'los' || lastPhase === 'loss') break; // LOS jelas → tak perlu nunggu
      if (i < tries - 1) await sleep(intervalMs);
    }

    // Tidak online → ambil detail-info untuk diagnosa akurat
    try { detail = await this.getOnuDetail(ifc); } catch (e) {}
    const seenUncfg = await this._snInUncfg(detail?.serial_number || '');

    let diagnosis, action;
    if (lastPhase === 'los' || lastPhase === 'loss') {
      diagnosis = 'LOS — OLT tidak menerima sinyal optik dari ONU.';
      action = 'Cek fisik: ONU menyala? fiber tercolok & bersih? redaman tidak terlalu tinggi?';
    } else if (lastPhase === 'notfound') {
      diagnosis = `ONU-id ${onuId} tidak muncul di ${gponOlt}.`;
      action = seenUncfg ? `SN terdeteksi di uncfg port LAIN — kemungkinan ONU ter-authorize di PON salah. Provision ulang di port yang benar.`
                         : 'Pastikan ONU benar ter-authorize di PON ini.';
    } else if (detail && detail.never_online) {
      diagnosis = 'Konfigurasi OK tapi ONU belum pernah ranging (Online Duration 0, Distance N/A).';
      action = 'Penyebab umum: ONU mati/booting, fiber belum sampai, atau SN ter-authorize di PON port berbeda dari letak fisik fiber.';
    } else {
      diagnosis = `ONU masih offline (phase: ${lastPhase || 'unknown'}).`;
      action = 'Tunggu beberapa saat lagi lalu refresh; bila menetap, cek fisik ONU & fiber.';
    }

    return {
      online: false, phase: lastPhase, attempts: tries,
      distance_m: detail?.distance_m ?? null,
      online_duration: detail?.online_duration ?? null,
      config_state: detail?.config_state ?? null,
      diagnosis, action,
    };
  }

  // ── WAN IP & MAC pelanggan (ZTE) ───────────────────────────────────
  // Mengambil IP WAN ONT (DHCP/PPPoE) dan daftar MAC yang terlihat OLT.
  //   onuIf: "gpon-onu_1/2/2:30"
  async getOnuWanInfo(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    const result = { onu_if: ifc, wan: [], macs: [], mac_count: 0 };

    // 1) WAN IP — beberapa firmware beda perintah, coba berurutan.
    const wanCmds = [
      `show gpon remote-onu wan-ip ${ifc}`,
      `show gpon remote-onu ip-host ${ifc}`,
    ];
    for (const cmd of wanCmds) {
      const out = await this._safeExec(cmd);
      if (out && !/invalid input|%\s*error|no related/i.test(out)) {
        result.wan = this._parseWanIp(out);
        if (result.wan.length) break;
      }
    }

    // 2) MAC address yang dipelajari OLT untuk ONU ini.
    const macOut = await this._safeExec(`show mac gpon onu ${ifc}`);
    if (macOut && !/invalid input|%\s*error/i.test(macOut)) {
      result.macs = this._parseOnuMac(macOut);
      result.mac_count = result.macs.length;
      // sebagian firmware hanya cetak "Total mac address : N"
      const tot = macOut.match(/Total\s+mac\s+address\s*:\s*(\d+)/i);
      if (tot && !result.mac_count) result.mac_count = parseInt(tot[1]);
    }
    return result;
  }

  _parseWanIp(out) {
    const hosts = [];
    let cur = null;
    String(out).split('\n').forEach(raw => {
      const line = raw.trim();
      const h = line.match(/Host\s*ID\s*:\s*(\d+)/i);
      if (h) { cur = { host_id: parseInt(h[1]) }; hosts.push(cur); return; }
      if (!cur) { cur = {}; hosts.push(cur); }
      const grab = (label, key) => {
        const m = line.match(new RegExp('(?:' + label + ')\\s*:\\s*([0-9.]+)', 'i'));
        if (m && m[1] !== '0.0.0.0') cur[key] = m[1];
      };
      grab('CurIP|IP', 'ip');
      grab('CurMask|Mask', 'mask');
      grab('CurGateway|Gateway', 'gateway');
      grab('CurPriDNS|Primary DNS', 'dns1');
      grab('CurSecDNS|Second DNS', 'dns2');
      const mac = line.match(/MAC\s*:\s*([0-9A-Fa-f.:-]{6,})/i);
      if (mac && /[0-9A-Fa-f]/.test(mac[1])) cur.mac = mac[1].trim();
    });
    // buang host kosong (tanpa IP)
    return hosts.filter(h => h.ip);
  }

  _parseOnuMac(out) {
    const macs = [];
    String(out).split('\n').forEach(line => {
      // Cari pola MAC: xxxx.xxxx.xxxx atau xx:xx:xx:xx:xx:xx
      const m = line.match(/([0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}|(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2})/);
      if (!m) return;
      const vlan = line.match(/\bvlan\s*[:=]?\s*(\d+)/i) || line.match(/\s(\d{1,4})\s/);
      macs.push({ mac: m[1], vlan: vlan ? parseInt(vlan[1]) : null, raw: line.trim().slice(0, 120) });
    });
    return macs;
  }

  // ── Detail satu ONU ────────────────────────────────────────────────
  // onuIf: "gpon-onu_1/2/5:5" atau "1/2/5:5"
  async getOnuDetail(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    const out = await this.exec(`show gpon onu detail-info ${ifc}`);
    return this._parseOnuDetail(out, ifc);
  }

  // ── Redaman / optical power satu ONU ───────────────────────────────
  async getOnuPower(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    const out = await this.exec(`show pon power attenuation ${ifc}`);
    return this._parsePower(out, ifc);
  }

  // Ambil redaman untuk SEKUMPULAN ONU dalam satu koneksi (progressive load).
  // Dipakai frontend untuk mengisi redaman menyusul setelah daftar ONU tampil.
  // Mengembalikan { "gpon-onu_F/S/P:N": { onu_rx_dbm, quality } , ... }.
  // CLI bersifat serial per-koneksi; keuntungan utamanya adalah memisahkan
  // pengambilan redaman dari pemuatan daftar (daftar tampil instan).
  async getPowerBatch(onuIfs = []) {
    const result = {};
    for (const raw of onuIfs) {
      let ifc;
      try { ifc = this._normOnuIf(raw); } catch (e) { continue; }   // lewati interface tak valid
      try {
        const p = await this.getOnuPower(ifc);
        result[ifc] = { onu_rx_dbm: p.onu_rx_dbm ?? null, quality: p.quality ?? 'unknown' };
      } catch (e) {
        result[ifc] = { onu_rx_dbm: null, quality: 'unknown' };
      }
    }
    return result;
  }

  // ── Traffic real-time satu ONU ─────────────────────────────────────
  // C320: "show interface gpon-onu_x/x/x:y" → ONU statistic Input/Output rate.
  async getOnuTraffic(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    const out = await this.exec(`show interface ${ifc}`);
    return this._parseOnuTraffic(out, ifc);
  }

  // Parse statistik ONU. Contoh output C320:
  //   ONU statistic:
  //     Input rate : 1471 Bps 12 pps
  //     Output rate: 2212 Bps 13 pps
  //     Input bandwidth throughput :0.0%
  //     Output bandwidth throughput: N/A
  _parseOnuTraffic(out, onuIf) {
    const s = String(out);
    const numUnit = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : null; };
    // Input/Output rate dalam Bps (Byte/s) + pps (packet/s)
    const inBps  = numUnit(/Input\s*rate\s*:?\s*(-?\d+(?:\.\d+)?)\s*Bps/i);
    const inPps  = numUnit(/Input\s*rate\s*:?[^\n]*?(\d+)\s*pps/i);
    const outBps = numUnit(/Output\s*rate\s*:?\s*(-?\d+(?:\.\d+)?)\s*Bps/i);
    const outPps = numUnit(/Output\s*rate\s*:?[^\n]*?(\d+)\s*pps/i);
    // throughput (%) bila ada
    const inPct  = numUnit(/Input\s*bandwidth\s*throughput\s*:?\s*(-?\d+(?:\.\d+)?)\s*%/i);
    const outPct = numUnit(/Output\s*bandwidth\s*throughput\s*:?\s*(-?\d+(?:\.\d+)?)\s*%/i);

    // Konversi Byte/s → bit/s (×8) untuk tampilan bandwidth umum
    const inBps_bits  = inBps  != null ? inBps  * 8 : null;
    const outBps_bits = outBps != null ? outBps * 8 : null;

    return {
      onu_if: onuIf,
      // Byte/s mentah
      input_bps: inBps, output_bps: outBps,
      // bit/s hasil konversi (untuk tampilan Mbps/Kbps)
      input_bits: inBps_bits, output_bits: outBps_bits,
      input_pps: inPps, output_pps: outPps,
      input_pct: inPct, output_pct: outPct,
      raw: s.trim().slice(0, 1500),
    };
  }

  // ── Cari ONU berdasarkan Serial Number ─────────────────────────────
  async findOnuBySn(sn) {
    const out = await this.exec(`show gpon onu by sn ${sn}`);
    const m = String(out).match(/gpon-onu_(\d+\/\d+\/\d+:\d+)/i);
    return m ? `gpon-onu_${m[1]}` : null;
  }

  // ── Running config sebuah PON port (lihat ONU terdaftar + SN) ───────
  async getOltRunConfig(gponOlt) {
    const ifc = this._normOltIf(gponOlt);
    const out = await this.exec(`show running-config interface ${ifc}`);
    return this._parseRunConfig(out);
  }

  // ── Info sistem OLT (ZTE) ──────────────────────────────────────────
  async getSystemInfo() {
    // C320 V2.1.0: 'show version' = Ambiguous. Pakai 'show system-group'.
    //   System Description: C320 Version V2.1.0 Software, Copyright (c) by ZTE...
    //   Started before: 137 days, 1 hours, 29 minutes
    //   System name: ZXAN
    const sys = await this._safeExec('show system-group');
    const cpu = await this._safeExec('show processor') || await this._safeExec('show cpu');
    const card = await this._safeExec('show card');
    const all = String(sys);
    const grab = (re, src = all) => { const m = String(src).match(re); return m ? m[1].trim() : null; };

    // Description: "C320 Version V2.1.0 Software, Copyright..."
    const desc = grab(/System Description\s*:\s*(.+)/i);
    // MODEL = kata pertama description (mis. C320 / C300), bukan "ZXAN"
    const modelM = desc ? desc.match(/\b(C\d{3}\w*)\b/i) : null;
    const model = modelM ? modelM[1].toUpperCase() : (desc ? desc.split(/\s+/)[0] : null);
    // VERSI = setelah "Version"
    const verM = (desc || all).match(/Version\s+(V?[\d.]+\w*)/i);

    // Uptime: "Started before: 137 days, 1 hours, 29 minutes"
    const upM = all.match(/Started before\s*:\s*(.+?)(?:\n|$)/i);

    // Hardware/SoftVer dari kartu kontrol (SMXA) di show card
    //   1 1 4 SMXA SMXA 3 V1.0.0 V2.1.0 INSERVICE
    let hw = null;
    String(card).split('\n').forEach(l => {
      const cm = l.trim().match(/^\d+\s+\d+\s+\d+\s+\S+\s+(SMXA|SCXM|SCXN\w*)\s+\d+\s+(V[\d.]+)\s+(V[\d.]+)/i);
      if (cm && !hw) hw = cm[2];   // HardVer kartu kontrol
    });

    // CPU dari show processor: cari persen pertama
    const cpuM = String(cpu).match(/(\d+(?:\.\d+)?)\s*%/);

    // Suhu chassis (best-effort, tidak semua firmware mendukung)
    let temperatureC = null;
    try {
      const env = await this._getEnvironment();
      if (env && env.chassis != null) temperatureC = env.chassis;
    } catch (e) { /* abaikan */ }

    return {
      model:        model,
      version:      verM ? verM[1] : null,
      hw_version:   hw,
      uptime:       upM ? upM[1].trim() : null,
      system_name:  grab(/System name\s*:\s*(.+)/i),
      location:     grab(/Location\s*:\s*(.+)/i),
      cpu_percent:  cpuM ? parseFloat(cpuM[1]) : null,
      temperature_c: temperatureC,
      raw: all.trim().slice(0, 2000),
    };
  }

  // ── Ringkasan tiap PON port (ZTE) ──────────────────────────────────
  // ifs: array string gpon-olt mis. ['1/1/1','1/1/2']
  async getPortSummary(ifs = []) {
    const result = [];
    for (const ifr of ifs) {
      try {
        const list = await this.getOnuState(ifr);
        const online = list.filter(o => o.status === 'online').length;
        result.push({ port: this._normOltIf(ifr).replace('gpon-olt_', ''), total: list.length, online, offline: list.length - online });
      } catch (e) {
        result.push({ port: ifr, total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return result;
  }

  // ── VLAN global (ZTE) ──────────────────────────────────────────────
  async getVlans() {
    // C320 tidak punya satu daftar "VLAN global" yang lengkap. VLAN tersebar di:
    //   1) show vlan summary           → VLAN yang dibuat manual
    //   2) show gpon onu profile vlan  → VLAN profile (PPPoE/HOTSPOT/dst, ada nama)
    //   3) uplink xgei/gei switchport vlan ... tag → VLAN yang dilewatkan ke uplink
    // Kita gabungkan ketiganya agar tab VLAN benar-benar informatif.
    const byVid = new Map();
    const merge = (vid, fields) => {
      vid = parseInt(vid);
      if (!vid || vid < 1 || vid > 4094) return;
      const cur = byVid.get(vid) || { vid, name: null, type: null, status: null, ports: null, sources: [] };
      if (fields.name && !cur.name) cur.name = fields.name;
      if (fields.type && !cur.type) cur.type = fields.type;
      if (fields.status && !cur.status) cur.status = fields.status;
      if (fields.ports) cur.ports = cur.ports ? `${cur.ports}, ${fields.ports}` : fields.ports;
      if (fields.source && !cur.sources.includes(fields.source)) cur.sources.push(fields.source);
      byVid.set(vid, cur);
    };

    // 1) show vlan summary (+ varian, lewati pesan error)
    const candidates = ['show vlan summary', 'show vlan all', 'show vlan brief'];
    for (const cmd of candidates) {
      const out = await this._safeExec(cmd);
      if (!out || /invalid input|incomplete command|unknown command|%\s*error/i.test(out)) continue;
      const parsed = this._parseVlanListZte(out);
      parsed.forEach(v => merge(v.vid, { name: v.name, type: v.type, status: v.status, ports: v.ports, source: 'summary' }));
      if (parsed.length) break;   // satu sumber summary cukup
    }

    // 2) VLAN profile bernama (paling berguna di C320)
    try {
      const prof = await this._safeExec('show gpon onu profile vlan');
      this._parseVlanProfiles(prof).forEach(p => merge(p.cvlan, { name: p.name, type: 'profile', source: 'profile' }));
    } catch (e) { /* abaikan */ }

    // 3) VLAN ter-tag di port uplink (cari port xgei/gei dengan switchport vlan)
    try {
      const upPorts = await this._discoverUplinkPorts();
      for (const up of upPorts) {
        const cfg = await this._safeExec(`show running-config interface ${up}`);
        this._parseSwitchportVlans(cfg).forEach(vid => merge(vid, { type: 'uplink', ports: up, source: 'uplink' }));
      }
    } catch (e) { /* abaikan */ }

    const list = [...byVid.values()].sort((a, b) => a.vid - b.vid);
    // type ditampilkan: prioritas profile > uplink > summary status
    list.forEach(v => { if (!v.type && v.status) v.type = v.status; });
    return list;
  }

  // Parse "show gpon onu profile vlan" → [{name, cvlan, tagMode}]
  _parseVlanProfiles(out) {
    const profiles = [];
    let cur = null;
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      let m = t.match(/^Profile\s*name\s*:\s*(.+)$/i);
      if (m) { cur = { name: m[1].trim(), cvlan: null, tagMode: null }; profiles.push(cur); return; }
      if (!cur) return;
      m = t.match(/^Tag\s*mode\s*:\s*(\S+)/i); if (m) { cur.tagMode = m[1]; return; }
      m = t.match(/^CVLAN\s*:\s*(\d+)/i);      if (m) { cur.cvlan = parseInt(m[1]); return; }
    });
    return profiles.filter(p => p.cvlan);
  }

  // Cari port uplink (SMXA) dari "show card": kembalikan ref port xgei/gei.
  async _discoverUplinkPorts() {
    const ports = [];
    try {
      const cardOut = await this._safeExec('show card');
      String(cardOut).split('\n').forEach(line => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\b/);
        if (!m) return;
        if (!/SMXA|SCXL|GUSQ|UCDC/i.test(m[5])) return;     // kartu uplink/kontrol
        if (!/INSERVICE/i.test(line)) return;
        const frame = parseInt(m[1]) || 1, slot = parseInt(m[3]), pc = Math.min(parseInt(m[6]) || 0, 4);
        // Coba xgei lalu gei (vendor beda penamaan); caller pakai _safeExec jadi aman.
        for (let p = 1; p <= pc; p++) { ports.push(`xgei_${frame}/${slot}/${p}`); ports.push(`gei_${frame}/${slot}/${p}`); }
      });
    } catch (e) { /* abaikan */ }
    return ports;
  }

  // Parse "switchport vlan 99-100,200,300 tag" → daftar VID (range diexpand).
  _parseSwitchportVlans(out) {
    const vids = new Set();
    String(out).split('\n').forEach(line => {
      const m = line.trim().match(/switchport\s+vlan\s+([\d,\-\s]+?)(?:\s+tag|\s+untag|$)/i);
      if (!m) return;
      m[1].split(',').forEach(part => {
        const r = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (r) { for (let v = parseInt(r[1]); v <= parseInt(r[2]); v++) vids.add(v); }
        else { const v = parseInt(part); if (v) vids.add(v); }
      });
    });
    return [...vids];
  }

  async createVlan(vid, name) {
    vid = this._sanInt(vid, { min: 1, max: 4094, label: 'VLAN ID' });
    await this._enterConfig();
    let out = await this.exec(`vlan ${vid}`);
    const nm = this._sanName(name);
    if (nm) out += '\n' + await this._safeExec(`name ${nm}`);
    out += '\n' + await this._safeExec('exit');
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error('Buat VLAN gagal: ' + this._firstError(out));
    return { success: true, vid };
  }

  async deleteVlan(vid) {
    vid = this._sanInt(vid, { min: 1, max: 4094, label: 'VLAN ID' });
    await this._enterConfig();
    const out = await this.exec(`no vlan ${vid}`);
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error('Hapus VLAN gagal: ' + this._firstError(out));
    return { success: true };
  }

  // Ubah deskripsi/nama VLAN. Untuk VLAN profile, ubah juga nama profile bila diminta.
  async updateVlan(vid, { name } = {}) {
    vid = this._sanInt(vid, { min: 1, max: 4094, label: 'VLAN ID' });
    await this._enterConfig();
    let out = await this.exec(`vlan ${vid}`);
    // C320: deskripsi VLAN diatur via "description <txt>" di mode config-vlan.
    const nm = this._sanName(name);
    if (nm) {
      out += '\n' + await this._safeExec(`description ${nm}`);
      // beberapa firmware pakai "name <txt>"
      if (/invalid|error|incomplete/i.test(out)) out += '\n' + await this._safeExec(`name ${nm}`);
    }
    out += '\n' + await this._safeExec('exit');
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error('Update VLAN gagal: ' + this._firstError(out));
    return { success: true, vid };
  }

  // Detail VLAN: profile (nama/tag/cvlan), port uplink yang membawa, & deskripsi.
  async getVlanDetail(vid) {
    vid = parseInt(vid);
    const detail = { vid, name: null, description: null, profile: null, uplinkPorts: [], sources: [] };

    // 1) VLAN profile (cocokkan CVLAN == vid)
    try {
      const prof = await this._safeExec('show gpon onu profile vlan');
      const match = this._parseVlanProfiles(prof).find(p => p.cvlan === vid);
      if (match) {
        detail.profile = match;
        detail.name = match.name;
        detail.sources.push('profile');
      }
    } catch (e) { /* abaikan */ }

    // 2) Port uplink yang membawa VLAN ini
    try {
      const upPorts = await this._discoverUplinkPorts();
      for (const up of upPorts) {
        const cfg = await this._safeExec(`show running-config interface ${up}`);
        if (this._parseSwitchportVlans(cfg).includes(vid)) detail.uplinkPorts.push(up);
      }
      if (detail.uplinkPorts.length && !detail.sources.includes('uplink')) detail.sources.push('uplink');
    } catch (e) { /* abaikan */ }

    // 3) Deskripsi VLAN dari running-config (bila ada)
    try {
      const vcfg = await this._safeExec(`show running-config vlan ${vid}`)
                || await this._safeExec(`show vlan ${vid}`);
      const m = String(vcfg).match(/(?:description|name)\s+(.+)/i);
      if (m) { detail.description = m[1].trim(); if (!detail.name) detail.name = detail.description; }
    } catch (e) { /* abaikan */ }

    return detail;
  }

  // ── VLAN per-ONU (ZTE pakai pon-onu-mng + service-port) ────────────
  async getOnuVlans(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    // Perintah paling andal di C320: show service-port interface gpon-onu_x:x
    const out = await this._safeExec(`show service-port interface ${ifc}`)
            || await this._safeExec(`show onu running config ${ifc}`)
            || await this._safeExec(`show pon-onu-mng ${ifc}`);
    return this._parseOnuVlansZte(out);
  }

  // ZTE service-port: dilakukan dari mode interface gpon-onu
  async setOnuVlan(onuIf, { sp = 1, gem = 1, userVlan, vlan }) {
    const ifc = this._normOnuIf(onuIf);
    if (!vlan) throw new Error('vlan wajib diisi');
    const vSp   = this._sanInt(sp, { min: 1, max: 64, label: 'service-port' });
    const vGem  = this._sanInt(gem, { min: 1, max: 64, label: 'vport' });
    const vVlan = this._sanInt(vlan, { min: 1, max: 4094, label: 'VLAN' });
    const vUser = userVlan ? this._sanInt(userVlan, { min: 1, max: 4094, label: 'User VLAN' }) : vVlan;
    await this._enterConfig();
    const cmds = [
      `interface ${ifc}`,
      `service-port ${vSp} vport ${vGem} user-vlan ${vUser} vlan ${vVlan}`,
      'exit',
    ];
    const out = await this.execSequence(cmds);
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error('Set VLAN ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  async deleteOnuVlan(onuIf, sp) {
    const ifc = this._normOnuIf(onuIf);
    const vSp = this._sanInt(sp, { min: 1, max: 64, label: 'service-port' });
    await this._enterConfig();
    const cmds = [`interface ${ifc}`, `no service-port ${vSp}`, 'exit'];
    const out = await this.execSequence(cmds);
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error('Hapus VLAN ONU gagal: ' + this._firstError(out));
    return { success: true };
  }

  _parseVlanListZte(out) {
    const vlans = [];
    const seen = new Set();
    const push = (vid, name, status, ports) => {
      vid = parseInt(vid);
      if (!vid || vid < 1 || vid > 4094 || seen.has(vid)) return;
      seen.add(vid);
      vlans.push({ vid, name: name || null, type: status || null, status: status || null, ports: ports || null });
    };
    const isStatus = (s) => s && /^(active|suspend|enable|disable|enabled|disabled|up|down)$/i.test(s);

    String(out).split('\n').forEach(line => {
      const t = line.trim();
      if (!t || /^[-=\s]+$/.test(t)) return;                 // baris pemisah

      // ── Format 1 (paling umum di C320): "vlan 671" / "vlan 671 INTERNET"
      // Output `show vlan summary` sering satu VLAN per baris diawali kata "vlan".
      let m = t.match(/^vlan\s+(\d{1,4})\b\s*(.*)$/i);
      if (m) {
        const rest = (m[2] || '').trim();
        // sisa baris bisa nama/deskripsi (abaikan bila hanya angka/“count”)
        const name = rest && !/^\d+$/.test(rest) && !/count|total/i.test(rest) ? rest : null;
        push(m[1], name, null, null);
        return;
      }

      // Lewati header tabel (mengandung kata kunci & tidak diawali angka)
      if (/vlan\s*id|vlanid|status|^name\b|summary|total|description|portnum|ports|member/i.test(t) && !/^\d/.test(t)) return;

      // ── Format 2: tabel diawali VID — "671  active  INTERNET  ge_1/1"
      m = t.match(/^(\d{1,4})\b(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(.*))?$/);
      if (!m) return;
      const c2 = m[2], c3 = m[3], c4 = m[4];
      let name = null, status = null, ports = null;
      if (isStatus(c2)) { status = c2; name = c3 || null; ports = c4 ? c4.trim() : null; }
      else if (isStatus(c3)) { name = c2 || null; status = c3; ports = c4 ? c4.trim() : null; }
      else {
        name = (c2 && !/^\d/.test(c2)) ? c2 : null;
        // sisa kolom (angka portnum / daftar port) → ports
        ports = [c3, c4].filter(Boolean).join(' ').trim() || null;
      }
      push(m[1], name, status, ports);
    });
    return vlans;
  }

  _parseOnuVlansZte(out) {
    const list = [];
    const seen = new Set();
    const add = (sp, vlan, svlan) => {
      sp = parseInt(sp); vlan = parseInt(vlan);
      if (!sp || !vlan) return;
      const key = sp + ':' + vlan;
      if (seen.has(key)) return; seen.add(key);
      list.push({ service_port: sp, vlan, svlan: svlan ? parseInt(svlan) : null });
    };
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      // Format config: "service-port 1 vport 1 user-vlan 100 vlan 100 svlan 9"
      let m = t.match(/service-port\s+(\d+).*?\bvlan\s+(\d+)(?:.*?\bsvlan\s+(\d+))?/i);
      if (m) { add(m[1], m[2], m[3]); return; }
      // Format tabel `show service-port interface`: kolom diawali "Sport Vport ... Vlan ..."
      // Baris data diawali angka (Sport). Ambil Sport (kolom-1) & Vlan (cari angka VLAN).
      m = t.match(/^(\d+)\s+\d+\s+.*?\b(\d{1,4})\b/);
      if (m && /^\d/.test(t) && !/sport|vport|status|interface/i.test(t)) {
        // heuristik: cari nilai vlan pada baris tabel (kolom Vlan biasanya 2-4 digit)
        const nums = t.split(/\s+/).map(n => parseInt(n)).filter(n => !isNaN(n));
        // nums[0]=Sport; cari kandidat VLAN (1..4094) setelahnya
        const vlan = nums.slice(1).find(n => n >= 1 && n <= 4094);
        if (vlan) add(nums[0], vlan);
      }
    });
    return list;
  }

  // ════════════════════════════════════════════════════════════════════
  // ACTIONS (write) — butuh privilege & configure terminal
  // ════════════════════════════════════════════════════════════════════

  async _enterConfig() {
    if (this.enablePassword) {
      await this._safeExec('enable');
      await this._safeExec(this.enablePassword);
    }
    await this.exec('configure terminal');
  }
  async _exitConfig() {
    await this._safeExec('end');
  }

  /**
   * Authorize / tambah ONU baru pada PON port.
   * @param {object} p
   *   p.gponOlt  : "gpon-olt_1/2/1"
   *   p.onuId    : nomor ONU (mis. 3)
   *   p.type     : tipe ONU (mis. "ZTEG-F660")
   *   p.sn       : serial number (mis. "ZTEGC0B82FE8")
   *   p.name     : (opsional) nama ONU
   *   p.description : (opsional) deskripsi
   */
  async authorizeOnu(p) {
    const ifc = this._normOltIf(p.gponOlt);
    if (!ifc || !p.type || !p.sn) {
      throw new Error('gponOlt, type, dan sn wajib diisi');
    }
    // Sanitasi nilai user sebelum masuk ke perintah CLI (cegah injeksi).
    p = { ...p, sn: this._sanSn(p.sn), type: this._sanType(p.type) };
    // Auto-assign ONU-id bila tidak diberikan.
    let onuId = parseInt(p.onuId);
    if (!onuId) {
      onuId = await this.getNextFreeOnuId(ifc);
      if (!onuId) throw new Error('Tidak ada ONU-id kosong pada PON ini');
    }
    onuId = this._sanInt(onuId, { min: 1, max: 1024, label: 'ONU-id' });
    const ERR = /invalid|fail(?!-safe)|error|incomplete|unknown command|denied|not\s+exist|no\s+such|bad parameter|%\s*error|not\s+support|cannot|\breject/i;
    const ERR_CODE = /%\s*code\s*(63904|20200|20202|20405|33865|40256|11010|13050)\b/i;
    const isErr = (out) => ERR.test(out) || ERR_CODE.test(out);
    const EXISTS = /already configured|already exist|profile.*exist|duplicate name|no related information/i;
    const TYPE_UNSUPPORTED = /not\s+support\s+this\s+onu|63904|unsupport|unknown\s+onu\s*type|invalid.*type/i;

    const candidates = await this._buildTypeCandidates(p.type);
    await this._enterConfig();
    try {
      await this.exec(`interface ${ifc}`);
      let out = '', usedType = p.type;
      for (const t of candidates) {
        out = await this.exec(`onu ${onuId} type ${t} sn ${p.sn}`);
        const fatal = isErr(out) && !EXISTS.test(out);
        if (!fatal) { usedType = t; break; }
        if (!TYPE_UNSUPPORTED.test(out)) { usedType = t; break; }  // error lain → stop
        // type tidak didukung → coba kandidat berikutnya
      }
      await this._safeExec('exit');
      await this._exitConfig();
      if (isErr(out) && !EXISTS.test(out)) {
        if (TYPE_UNSUPPORTED.test(out)) {
          throw new Error(`Tidak ada Type ONU yang diterima OLT untuk SN ${p.sn}. Cek "show onu-type gpon" lalu isi Type ONU dengan salah satunya.`);
        }
        throw new Error('OLT menolak perintah authorize: ' + (this._firstError(out) || 'periksa SN / ONU-id'));
      }
      return { success: true, onuIf: `gpon-onu_${ifc.replace('gpon-olt_', '')}:${onuId}`, onuId, type: usedType };
    } catch (e) {
      await this._exitConfig().catch(() => {});
      throw e;
    }
  }

  // ── Baca profil yang sudah ada di OLT (tcont/traffic & onu-type) ────
  async getProfiles() {
    const tcont  = await this._safeExec('show gpon profile tcont');
    const traffic = await this._safeExec('show gpon profile traffic');
    const types  = await this._safeExec('show onu-type gpon') || await this._safeExec('show gpon onu-type-list');
    return {
      tcont:        this._parseProfileNames(tcont),
      traffic:      this._parseProfileNames(traffic),
      tcontDetail:  this._parseTcontProfiles(tcont),
      trafficDetail:this._parseTrafficProfiles(traffic),
      onuTypes:     this._parseOnuTypes(types),
    };
  }

  // Buat / ubah profil T-CONT.
  //   name, type(1..5), bandwidth (kbps). type 3/5 = "up-to" (hemat kapasitas PON).
  //   Mapping param per type (referensi C320):
  //     type 1: fixed F     | type 2: assured A | type 3: assured+max A,M
  //     type 4: maximum M    | type 5: fixed+assured+max F,A,M
  async createTcontProfile({ name, type = 3, fixed, assured, maximum } = {}) {
    name = this._sanName(name);
    if (!name || !/^[A-Za-z0-9]/.test(name)) throw new Error('Nama profil T-CONT tidak valid (huruf/angka/.-_)');
    const t = this._sanInt(type, { min: 1, max: 5, label: 'Type T-CONT' });
    let params = '';
    const BW = (v, d) => v ? this._sanInt(v, { min: 0, max: 10000000, label: 'bandwidth' }) : d;
    const F = BW(fixed, 0), A = BW(assured, 0), M = BW(maximum, 0);
    if (t === 1)      params = `fixed ${F || M || 1024000}`;
    else if (t === 2) params = `assured ${A || M || 1024000}`;
    else if (t === 3) params = `assured ${A || Math.floor((M||1024000)/2)} maximum ${M || 1024000}`;
    else if (t === 4) params = `maximum ${M || 1024000}`;
    else if (t === 5) params = `fixed ${F || 8000} assured ${A || 10000} maximum ${M || 1024000}`;

    await this._enterConfig();
    try {
      const out = await this.execSequence(['gpon', `profile tcont ${name} type ${t} ${params}`, 'exit']);
      await this._exitConfig();
      if (this._isCmdError(out)) throw new Error('Buat profil T-CONT gagal: ' + (this._firstError(out) || out.split('\n')[0]));
      return { success: true, name, type: t };
    } catch (e) { await this._exitConfig().catch(()=>{}); throw e; }
  }

  // Buat / ubah profil Traffic (limit bandwidth, kbps).
  async createTrafficProfile({ name, sir, pir, cbs, pbs } = {}) {
    name = this._sanName(name);
    if (!name || !/^[A-Za-z0-9]/.test(name)) throw new Error('Nama profil Traffic tidak valid (huruf/angka/.-_)');
    const SIR = sir ? this._sanInt(sir, { min: 1, max: 10000000, label: 'SIR' }) : 0;
    const PIR = pir ? this._sanInt(pir, { min: 1, max: 10000000, label: 'PIR' }) : SIR;
    if (!SIR) throw new Error('SIR (kbps) wajib diisi');
    let cmd = `profile traffic ${name} sir ${SIR} pir ${PIR}`;
    if (cbs) cmd += ` cbs ${this._sanInt(cbs, { min: 0, max: 1000000, label: 'CBS' })}`;
    if (pbs) cmd += ` pbs ${this._sanInt(pbs, { min: 0, max: 1000000, label: 'PBS' })}`;

    await this._enterConfig();
    try {
      const out = await this.execSequence(['gpon', cmd, 'exit']);
      await this._exitConfig();
      if (this._isCmdError(out)) throw new Error('Buat profil Traffic gagal: ' + (this._firstError(out) || out.split('\n')[0]));
      return { success: true, name, sir: SIR, pir: PIR };
    } catch (e) { await this._exitConfig().catch(()=>{}); throw e; }
  }

  // Hapus profil. kind: 'tcont' | 'traffic'.
  async deleteProfile(kind, name) {
    if (!['tcont', 'traffic'].includes(kind)) throw new Error('kind harus tcont/traffic');
    name = this._sanName(name);
    if (!name || /^default$/i.test(name)) throw new Error('Nama profil tidak valid / tidak boleh hapus default');
    await this._enterConfig();
    try {
      const out = await this.execSequence(['gpon', `no profile ${kind} ${name}`, 'exit']);
      await this._exitConfig();
      // "in use" → profil masih dipakai ONU, tidak bisa dihapus.
      if (/in\s+use|using|reference/i.test(out)) throw new Error(`Profil "${name}" masih dipakai ONU — lepas dulu dari ONU terkait.`);
      if (this._isCmdError(out)) throw new Error('Hapus profil gagal: ' + (this._firstError(out) || out.split('\n')[0]));
      return { success: true };
    } catch (e) { await this._exitConfig().catch(()=>{}); throw e; }
  }

  _parseProfileNames(out) {
    const names = [];
    String(out).split('\n').forEach(line => {
      // "Profile name :1G" / "Name :UP-50M" / "Name : default"
      const m = line.match(/(?:Profile\s+)?Name\s*:\s*(\S+)/i);
      if (!m) return;
      const name = m[1].trim();
      // hanya terima token nama profil yang valid (huruf/angka/.-_), buang sampah
      if (!/^[A-Za-z0-9][\w.\-]*$/.test(name)) return;
      if (!names.includes(name)) names.push(name);
    });
    return names;
  }

  _parseOnuTypes(out) {
    const types = [];
    String(out).split('\n').forEach(line => {
      const t = line.trim();
      // baris berisi nama type seperti ZTEG-F660, ZTE-F660, F663NV3a, 5506-04-F1
      const m = t.match(/\b((?:ZTEG?|ZXHN|HW|HG)[-_]?F?\d[\w.\-]*|\d{4}-\d{2}-[A-Z0-9]+|F\d{3}[\w.\-]*)\b/i);
      if (m && !types.includes(m[1]) && !/^(type|name|gpon|epon|total)$/i.test(m[1])) {
        types.push(m[1]);
      }
    });
    return types;
  }

  // Parse "show gpon profile tcont" → [{name, type, fbw, abw, mbw}]
  // Format C320:
  //   Name :UP-50M
  //   Type FBW(kbps) ABW(kbps) MBW(kbps)
  //    3    0         25000      50000
  _parseTcontProfiles(out) {
    const profs = [];
    let cur = null;
    String(out).split('\n').forEach(raw => {
      const line = raw.trim();
      const nm = line.match(/(?:Profile\s+)?Name\s*:\s*(\S+)/i);
      if (nm) { cur = { name: nm[1], type: null, fbw: null, abw: null, mbw: null }; profs.push(cur); return; }
      if (cur && /^\d/.test(line)) {
        // baris angka: "3 0 25000 50000" (Type FBW ABW MBW)
        const nums = line.split(/\s+/).map(Number).filter(n => !isNaN(n));
        if (nums.length >= 2) {
          cur.type = nums[0];
          if (nums.length >= 4) { cur.fbw = nums[1]; cur.abw = nums[2]; cur.mbw = nums[3]; }
          else if (nums.length === 3) { cur.fbw = nums[1]; cur.mbw = nums[2]; }
          else { cur.mbw = nums[1]; }
        }
      }
    });
    return profs;
  }

  // Parse "show gpon profile traffic" → [{name, sir, pir, cbs, pbs}]
  //   Name :100M
  //   SIR(kbps) PIR(kbps) CBS(kbytes) PBS(kbytes)
  //   100000    100000    default     default
  _parseTrafficProfiles(out) {
    const profs = [];
    let cur = null;
    String(out).split('\n').forEach(raw => {
      const line = raw.trim();
      const nm = line.match(/(?:Profile\s+)?Name\s*:\s*(\S+)/i);
      if (nm) { cur = { name: nm[1], sir: null, pir: null, cbs: null, pbs: null }; profs.push(cur); return; }
      if (cur && /^\d/.test(line)) {
        const toks = line.split(/\s+/);
        const num = (t) => /^\d+$/.test(t) ? parseInt(t) : t; // "default" tetap string
        if (toks[0] != null) cur.sir = num(toks[0]);
        if (toks[1] != null) cur.pir = num(toks[1]);
        if (toks[2] != null) cur.cbs = num(toks[2]);
        if (toks[3] != null) cur.pbs = num(toks[3]);
      }
    });
    return profs;
  }

  // Susun daftar kandidat Type ONU untuk authorize, berurutan prioritas:
  //   1) type yang diminta user (bila ada & bukan "ALL")
  //   2) type yang TERDAFTAR di OLT (show onu-type gpon)
  //   3) fallback type GPON umum pada C320
  //   4) "ALL" sebagai upaya terakhir (sebagian firmware menerimanya)
  async _buildTypeCandidates(requested) {
    const seen = new Set();
    const list = [];
    const add = (t) => {
      if (!t) return;
      const k = String(t).trim();
      if (!k || seen.has(k.toLowerCase())) return;
      seen.add(k.toLowerCase()); list.push(k);
    };

    // 1) requested (kecuali "ALL", yang ditaruh paling akhir)
    if (requested && !/^all$/i.test(String(requested))) add(requested);

    // 2) dari OLT (type yang benar-benar terdaftar di firmware ini)
    try {
      const out = await this._safeExec('show onu-type gpon')
              || await this._safeExec('show gpon onu-type-list')
              || await this._safeExec('show onu-type-list gpon');
      const types = this._parseOnuTypes(out);
      // Utamakan type rumahan umum (F660/F609/F620/F670) bila ada.
      types.filter(t => /F6\d|F670|F612|F601/i.test(t)).forEach(add);
      types.forEach(add);
    } catch (e) { /* abaikan */ }

    // 3) fallback umum C320 (urut dari yang paling sering diterima).
    //    Catatan: firmware V2.x kadang memakai "ZTE-F660" (tanpa G) seperti
    //    terlihat di "show gpon onu detail-info" → Type: ZTE-F660.
    ['ZTEG-F660', 'ZTE-F660', 'ZTEG-F609', 'ZTE-F609', 'ZTEG-F670L', 'ZTEG-F620',
     'ZTE-F620', 'ZTEG-F601', 'ZTEG-F612', 'ZXHN-F660', 'ZXHN-F663N', '5506-04-F1'].forEach(add);

    // 4) "ALL" sebagai upaya terakhir.
    add('ALL');

    return list;
  }


  async provisionOnu(p) {
    const ifc = this._normOltIf(p.gponOlt);
    if (!ifc || !p.type || !p.sn) throw new Error('gponOlt, type, sn wajib diisi');
    if (!p.vlan) throw new Error('VLAN wajib diisi');
    // Sanitasi semua nilai user sebelum disisipkan ke perintah CLI (anti-injeksi).
    p = {
      ...p,
      sn:            this._sanSn(p.sn),
      type:          this._sanType(p.type),
      name:          p.name ? this._sanName(p.name) : p.name,
      description:   p.description ? this._sanText(p.description) : p.description,
      serviceName:   p.serviceName ? this._sanName(p.serviceName) : p.serviceName,
      tcontProfile:  p.tcontProfile ? this._sanName(p.tcontProfile) : p.tcontProfile,
      trafficProfile:p.trafficProfile ? this._sanName(p.trafficProfile) : p.trafficProfile,
    };
    const userSpecifiedId = p.onuId != null && p.onuId !== '' && !isNaN(parseInt(p.onuId));
    let onuId = userSpecifiedId ? this._sanInt(p.onuId, { min: 1, max: 1024, label: 'ONU-id' }) : null;
    const tcont = this._sanInt(p.tcont || 1, { min: 1, max: 32, label: 'tcont' });
    const gem   = this._sanInt(p.gemport || 1, { min: 1, max: 32, label: 'gemport' });
    const sp    = this._sanInt(p.sp || 1, { min: 1, max: 64, label: 'service-port' });
    const vport = this._sanInt(p.vport || 1, { min: 1, max: 64, label: 'vport' });
    const vlan  = this._sanInt(p.vlan, { min: 1, max: 4094, label: 'VLAN' });
    const uvlan = p.userVlan ? this._sanInt(p.userVlan, { min: 1, max: 4094, label: 'User VLAN' }) : vlan;
    // Auto-assign ONU-id bila user tidak menentukan (memperhitungkan id yang
    // sudah terpakai walau ONU offline — lihat getNextFreeOnuId).
    if (!onuId) {
      onuId = await this.getNextFreeOnuId(ifc);
      if (!onuId) throw new Error('Tidak ada ONU-id kosong pada PON ini');
    }
    let onuIfRaw = `gpon-onu_${ifc.replace('gpon-olt_', '')}:${onuId}`;
    // Deteksi error OLT. PENTING: ZTE memakai format "%Code NNNNN-XXX : pesan".
    // Sebagian bersifat ERROR (mis. "63904 Not support this ONU"), sebagian
    // INFORMASI yang AMAN (mis. "32310 No related information to show").
    // Karena itu kita deteksi via kata-kata kegagalan + beberapa %Code error
    // yang dikenal, BUKAN semua %Code.
    const ERR = /invalid|fail(?!-safe)|error|incomplete|unknown command|denied|not\s+exist|no\s+such|bad parameter|%\s*error|not\s+support|cannot|can't|\breject/i;
    // %Code yang spesifik error (selain yang tertangkap kata di atas).
    const ERR_CODE = /%\s*code\s*(63904|20200|20202|20405|33865|40256|11010|13050)\b/i;
    const isErr = (out) => ERR.test(out) || ERR_CODE.test(out);
    // "Objek sudah ada" yang AMAN diabaikan (mis. konfigurasi identik diulang).
    const EXISTS = /already configured|already exist|profile.*exist|duplicate name|no related information/i;
    const svcName = this._sanName(p.serviceName || p.name || 'INTERNET') || 'INTERNET';

    // ── Pilih & VALIDASI profil TCONT terhadap daftar live di OLT ──────
    // Penyebab "%Error 20200 Invalid input at ^" pada langkah TCONT adalah
    // nama profil yang DITERUSKAN tapi TIDAK BENAR-BENAR ADA di OLT ini.
    // Karena itu profil selalu diverifikasi dulu; bila tak ada → fallback
    // "default" (C320 menerima "tcont N profile default"), lalu buat "1G".
    const liveProfiles = (await this._readTcontProfileNames()) || [];
    const hasProfile = (n) => n && liveProfiles.some(x => x.toLowerCase() === String(n).toLowerCase());
    let tcontProfile = (p.tcontProfile && String(p.tcontProfile).trim()) || '';
    if (!hasProfile(tcontProfile)) {
      // profil yang diminta tidak valid di OLT ini → cari pengganti
      const resolved = await this._resolveTcontProfile();
      tcontProfile = resolved || (liveProfiles.includes('default') ? 'default' : (liveProfiles[0] || 'default'));
    }

    // Helper: jalankan 1 perintah; bila gagal lempar error berisi perintah + output OLT
    const step = async (cmd, { soft = false } = {}) => {
      const out = await this.exec(cmd);
      if (isErr(out) && !EXISTS.test(out)) {
        if (soft) return out;
        throw new Error(`Perintah ditolak OLT: "${cmd}" — ${this._firstError(out)}`);
      }
      return out;
    };
    // Helper: coba beberapa varian sintaks; pakai yang pertama berhasil
    const stepTry = async (cmds, label) => {
      let lastOut = '';
      for (const cmd of cmds) {
        const out = await this.exec(cmd);
        lastOut = out;
        if (!isErr(out) || EXISTS.test(out)) return { cmd, out };
      }
      throw new Error(`${label} gagal pada "${cmds[cmds.length-1]}" — ${this._firstError(lastOut)}`);
    };

    let usedType = p.type;
    const trace = [];   // rekam setiap perintah + respons OLT untuk diagnosa
    const rec = (cmd, out) => { trace.push({ cmd, out: String(out || '').trim().slice(0, 300) }); return out; };

    // Daftar kandidat type ONU yang akan dicoba berurutan bila type diminta
    // ditolak. Diawali type dari user, lalu type yang TERDAFTAR di OLT
    // (show onu-type gpon), lalu fallback type GPON umum C320.
    //   CATATAN: "ALL" TIDAK selalu valid (firmware Anda menolaknya:
    //   %Code 63904-GPONRM Not support this ONU), jadi tidak diutamakan.
    const candidateTypes = await this._buildTypeCandidates(p.type);
    // Pesan firmware yang berarti "type tidak didukung" → coba type lain.
    const TYPE_UNSUPPORTED = /not\s+support\s+this\s+onu|63904|unsupport|unknown\s+onu\s*type|invalid.*type/i;

    await this._enterConfig();
    try {
      // 1) Authorize di interface gpon-olt, mencoba beberapa type sampai diterima.
      const doAuthorize = async () => {
        rec(`interface ${ifc}`, await this.exec(`interface ${ifc}`));
        let authOut = '';
        for (const t of candidateTypes) {
          authOut = rec(`onu ${onuId} type ${t} sn ${p.sn}`, await this.exec(`onu ${onuId} type ${t} sn ${p.sn}`));
          const fatal = isErr(authOut) && !EXISTS.test(authOut);
          if (!fatal) { usedType = t; break; }                 // diterima
          if (/id\s+(has\s+been|already)\s+used/i.test(authOut)) { usedType = t; break; } // id bentrok → ditangani di luar
          if (!TYPE_UNSUPPORTED.test(authOut)) { usedType = t; break; } // error LAIN (bukan soal type) → stop coba type
          // else: type tidak didukung → lanjut ke kandidat berikutnya
        }
        rec('exit', await this._safeExec('exit'));
        return authOut;
      };

      const authOut = await doAuthorize();
      // Bila OLT bilang ONU-id sudah dipakai → pilih id lain & ulang (jika id
      // tidak ditentukan manual oleh user).
      if (/id\s+(has\s+been|already)\s+used|onu.*already\s+exist|duplicate/i.test(authOut) && !userSpecifiedId) {
        const altId = await this.getNextFreeOnuId(ifc);
        if (altId && altId !== onuId) {
          onuId = altId;
          onuIfRaw = `gpon-onu_${ifc.replace('gpon-olt_', '')}:${onuId}`;
          await doAuthorize();
        }
      }
      // Ambil hasil authorize terakhir dari transkrip untuk evaluasi error fatal.
      const lastAuth = (trace.filter(t => /^onu\s+\d+\s+type/i.test(t.cmd)).pop() || {}).out || authOut;
      const lastFatal = isErr(lastAuth) && !EXISTS.test(lastAuth) && !/id\s+(has\s+been|already)\s+used/i.test(lastAuth);
      if (lastFatal) {
        // Bila SEMUA type ditolak "not support", beri pesan yang actionable.
        if (TYPE_UNSUPPORTED.test(lastAuth)) {
          throw new Error(`Tidak ada Type ONU yang diterima OLT untuk SN ${p.sn}. Firmware menolak semua type yang dicoba (${candidateTypes.join(', ')}). Jalankan "show onu-type gpon" di Diagnostik CLI untuk melihat type yang valid, lalu isi field Type ONU dengan salah satunya.${this._traceTail(trace)}`);
        }
        throw new Error(`Authorize ONU ditolak OLT: ${this._firstError(lastAuth) || 'tanpa pesan'}${this._traceTail(trace)}`);
      }

      // 2) Masuk interface ONU. INI verifikasi sebenarnya: bila ONU-id benar
      //    terbentuk, perintah ini berhasil. Bila gagal → ulang authorize sekali.
      let enterOut = rec(`interface ${onuIfRaw}`, await this.exec(`interface ${onuIfRaw}`));
      let enteredOk = !(isErr(enterOut) && !EXISTS.test(enterOut));
      if (!enteredOk) {
        await doAuthorize();
        enterOut = rec(`interface ${onuIfRaw}`, await this.exec(`interface ${onuIfRaw}`));
        enteredOk = !(isErr(enterOut) && !EXISTS.test(enterOut));
      }
      if (!enteredOk) {
        // Diagnosa: SN dipakai onu-id lain? Atau ONU memang belum terdeteksi OLT?
        const conflict = await this._snConflictInfo(ifc, p.sn, onuId);
        const seenUncfg = await this._snInUncfg(p.sn);
        let hint = '';
        if (conflict) hint = ' ' + conflict;
        else if (seenUncfg === false) hint = ` SN ${p.sn} tidak terdeteksi OLT (cek "show gpon onu uncfg") — pastikan ONU menyala & fiber tersambung, atau SN salah ketik.`;
        throw new Error(`ONU-id ${onuId} tidak bisa diaktifkan di ${ifc}.${hint}${this._traceTail(trace)}`);
      }

      // ZTE menolak name/description berisi spasi tanpa kutip → ganti underscore.
      const sanitize = (v) => String(v).trim().replace(/\s+/g, '_').slice(0, 32);
      if (p.name && String(p.name).trim())        await step(`name ${sanitize(p.name)}`, { soft: true });
      if (p.description && String(p.description).trim()) await step(`description ${sanitize(p.description)}`, { soft: true });

      // 3) T-CONT — format baku C320: "tcont N profile <PROFILE>".
      //    Profil sudah diverifikasi ada, jadi ini tidak akan kena '^' lagi.
      await stepTry([
        `tcont ${tcont} profile ${tcontProfile}`,
        `tcont ${tcont} name ${svcName} profile ${tcontProfile}`,
      ], 'Set TCONT');

      // 4) GEM port — format ringkas "gemport N tcont N" adalah yang paling
      //    diterima lintas firmware; format verbose sebagai cadangan.
      await stepTry([
        `gemport ${gem} tcont ${tcont}`,
        `gemport ${gem} name ${svcName} unicast tcont ${tcont} dir both`,
      ], 'Set GEM port');

      // 5) Traffic limit (opsional) — hanya bila profil traffic valid.
      if (p.trafficProfile && p.trafficProfile !== 'default') {
        await step(`gemport ${gem} traffic-limit downstream ${p.trafficProfile}`, { soft: true });
      }

      // 6) service-port + VLAN (di dalam interface ONU).
      //    Sebagian firmware butuh "switchport mode hybrid vport" dulu.
      let svcPortOk = false;
      try {
        await step(`service-port ${sp} vport ${vport} user-vlan ${uvlan} vlan ${vlan}`);
        svcPortOk = true;
      } catch (e1) {
        try {
          await step(`switchport mode hybrid vport ${vport}`, { soft: true });
          await step(`service-port ${sp} vport ${vport} user-vlan ${uvlan} vlan ${vlan}`);
          svcPortOk = true;
        } catch (e2) { /* coba bentuk global di bawah */ }
      }

      await step('exit', { soft: true });

      // 6b) Fallback service-port bentuk GLOBAL (referensi C320):
      //     "service-port N vlan V gpon-onu_x/x/x:y gemport G"
      //     Dipakai bila bentuk vport di dalam interface ditolak firmware.
      if (!svcPortOk) {
        await stepTry([
          `service-port ${sp} vlan ${vlan} ${onuIfRaw} gemport ${gem}`,
          `service-port ${sp} vlan ${vlan} ${onuIfRaw} gemport ${gem} multi-service user-vlan ${uvlan}`,
        ], 'Set service-port (global)');
      }

      // 7) pon-onu-mng: petakan service→gemport→vlan agar TRAFFIC benar-benar
      //    lewat. Tanpa langkah ini, ONU ter-authorize & punya service-port
      //    tapi sering tidak mem-bridge VLAN ke sisi user (mode service).
      //    Soft: sebagian deployment murni bridge tak memerlukannya.
      try {
        await step(`pon-onu-mng ${onuIfRaw}`, { soft: true });
        await step(`service ${svcName} gemport ${gem} vlan ${vlan}`, { soft: true });
        // Tag VLAN ke port ethernet pertama ONU (umumnya eth_0/1).
        await step(`vlan port eth_0/1 mode tag vlan ${vlan}`, { soft: true });
        await step('exit', { soft: true });
      } catch (e7) { /* abaikan — service-port di atas sudah utama */ }

      await this._exitConfig();
      return { success: true, onuIf: onuIfRaw, onuId, vlan, tcontProfile, type: usedType };
    } catch (e) {
      await this._exitConfig().catch(() => {});
      throw e;
    }
  }

  // Ringkas transkrip perintah→respons OLT untuk disisipkan ke pesan error.
  // Hanya tampilkan baris yang berisi respons (biar pesan tidak kepanjangan).
  _traceTail(trace) {
    if (!trace || !trace.length) return '';
    const lines = trace
      .filter(t => t.out)                    // hanya yang ada output
      .map(t => `  > ${t.cmd}\n    ${t.out.replace(/\n+/g, ' ').slice(0, 160)}`);
    if (!lines.length) return '';
    return `\n\n[Transkrip OLT]\n${lines.join('\n')}`;
  }

  // Apakah SN muncul di daftar "show gpon onu uncfg"? 
  //   true  = terdeteksi (ONU menyala, siap di-authorize)
  //   false = tidak terdeteksi (ONU mati / fiber putus / SN salah)
  //   null  = tak bisa dipastikan (perintah ditolak firmware)
  async _snInUncfg(sn) {
    if (!sn) return null;
    const out = await this._safeExec('show gpon onu uncfg');
    if (!out || /invalid input|unknown command|%\s*error/i.test(out)) return null;
    return new RegExp(sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(out);
  }

  // Diagnosa: apakah SN sudah terdaftar pada ONU-id LAIN di PON ini?
  // (penyebab umum authorize "diam-diam tidak terbentuk" pada onu-id baru.)
  async _snConflictInfo(oltIf, sn, wantOnuId) {
    try {
      const ifc = this._normOltIf(oltIf);
      const cfg = await this._safeExec(`show running-config interface ${ifc}`)
              || await this._safeExec(`show gpon onu state ${ifc}`);
      if (!cfg || !sn) return '';
      const re = new RegExp(`onu\\s+(\\d+)\\s+type\\s+\\S+\\s+sn\\s+${sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const m = String(cfg).match(re);
      if (m && parseInt(m[1]) !== parseInt(wantOnuId)) {
        return `SN ${sn} sudah terpakai di ONU-id ${m[1]} pada PON ini.`;
      }
    } catch (e) { /* abaikan */ }
    return '';
  }

  // Baca nama-nama profil TCONT yang BENAR-BENAR ada di OLT (termasuk "default").
  async _readTcontProfileNames() {
    const out = await this._safeExec('show gpon profile tcont');
    const names = this._parseProfileNames(out);
    // Pastikan "default" selalu dianggap tersedia di C320 walau parser meleset.
    if (!names.some(n => n.toLowerCase() === 'default')) names.push('default');
    return names;
  }

  // Pilih profil TCONT yang TERBUKTI ADA di OLT.
  // Prioritas: profil bernama (mis. 1G/UP-50M) → "default" → buat "1G".
  // Catatan C320: "tcont N profile default" VALID, jadi "default" adalah
  // fallback yang aman (bukan penyebab %Error 20202 seperti diasumsikan dulu).
  async _resolveTcontProfile() {
    const readAll = async () => {
      const out = await this._safeExec('show gpon profile tcont');
      return this._parseProfileNames(out);
    };
    const named = (list) => list.filter(n => n && n.toLowerCase() !== 'default');
    try {
      let all = await readAll();
      let names = named(all);
      if (names.length) {
        // utamakan profil yang terlihat seperti bandwidth (1G/100M/UP-50M)
        return names.find(n => /\d+\s*[gm]/i.test(n)) || names[0];
      }
      // Hanya ada "default" → pakai default (valid untuk di-assign).
      if (all.some(n => n.toLowerCase() === 'default')) return 'default';

      // Tak ada profil sama sekali → coba buat "1G" (beda sintaks per firmware).
      const createVariants = [
        ['gpon', 'profile tcont 1G type 4 maximum 1024000', 'exit'],
        ['gpon', 'profile tcont 1G type 3 assured 512 maximum 1024000', 'exit'],
        ['gpon', 'profile tcont 1G type 5 fixed 8000 assured 10000 maximum 1024000', 'exit'],
      ];
      for (const seq of createVariants) {
        const out = await this.execSequence(seq);
        if (!/invalid|fail|error|incomplete|unknown/i.test(out)) {
          all = await readAll();
          if (all.includes('1G')) return '1G';
        }
      }
      all = await readAll();
      return named(all)[0] || (all.includes('default') ? 'default' : 'default');
    } catch (e) {
      return 'default';
    }
  }

  // Cari ONU-id kosong berikutnya pada PON (untuk auto-assign saat provision)
  async getNextFreeOnuId(gponOlt, max = 128) {
    const ifc = this._normOltIf(gponOlt);
    const used = new Set();

    // 1) ONU yang sedang online/ranging (show gpon onu state).
    const st = await this._safeExec(`show gpon onu state ${ifc}`);
    String(st).split('\n').forEach(line => {
      const m = line.trim().match(/(?:gpon-onu_)?\d+\/\d+\/\d+:(\d+)/);
      if (m) used.add(parseInt(m[1]));
    });

    // 2) ONU yang TER-KONFIGURASI walau offline (running-config "onu N type..").
    //    Ini penting: id bisa terpakai walau ONU mati → kalau dilewati,
    //    authorize ke id yang sama akan ditolak OLT.
    const rc = await this._safeExec(`show running-config interface ${ifc}`);
    String(rc).split('\n').forEach(line => {
      const m = line.trim().match(/^onu\s+(\d+)\s+type\b/i);
      if (m) used.add(parseInt(m[1]));
    });

    for (let i = 1; i <= max; i++) if (!used.has(i)) return i;
    return null;
  }

  /** Set nama & deskripsi ONU (edit). */
  async editOnu(onuIf, { name, description } = {}) {
    const ifc = this._normOnuIf(onuIf);
    // Sanitasi: buang karakter kontrol (anti-injeksi), trim, spasi→underscore.
    // String kosong → null (jangan kirim perintah, cegah "Incomplete command").
    const nm = (name == null || !String(name).trim()) ? null : this._sanName(name);
    const ds = (description == null || !String(description).trim()) ? null : this._sanText(description);

    // Tidak ada yang diubah → tidak perlu kirim apa-apa.
    if (!nm && !ds) {
      return { success: true, skipped: true, message: 'Tidak ada perubahan' };
    }

    await this._enterConfig();
    try {
      const cmds = [`interface ${ifc}`];
      if (nm != null) cmds.push(`name ${nm}`);
      if (ds != null) cmds.push(`description ${ds}`);
      cmds.push('exit');
      const out = await this.execSequence(cmds);
      await this._exitConfig();
      const isErr = /invalid|fail|error|incomplete|denied|not\s+support|%\s*code\s*\d/i.test(out)
                && !/no related information|already/i.test(out);
      if (isErr) throw new Error('Edit ONU gagal: ' + (this._firstError(out) || 'OLT menolak perintah'));
      return { success: true, name: nm, description: ds };
    } catch (e) {
      await this._exitConfig().catch(() => {});
      throw e;
    }
  }

  /** Reboot satu ONU via pon-onu-mng. */
  async rebootOnu(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    await this._enterConfig();
    // Masuk mode manajemen ONU lalu reboot. Konfirmasi y/n ditangani exec layer.
    const cmds = [`pon-onu-mng ${ifc}`, 'reboot', 'exit'];
    const out = await this.execSequence(cmds);
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error('Reboot ONU gagal: ' + (this._firstError(out) || 'OLT menolak perintah'));
    return { success: true };
  }

  /** Restore factory (reset pabrik) satu ONU via pon-onu-mng.
   *  Referensi C320: pon-onu-mng gpon-onu_x/x/x:y → restore factory */
  async factoryResetOnu(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    await this._enterConfig();
    const cmds = [`pon-onu-mng ${ifc}`, 'restore factory', 'exit'];
    const out = await this.execSequence(cmds);
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error('Restore factory gagal: ' + (this._firstError(out) || 'OLT menolak perintah'));
    return { success: true };
  }

  /** Enable/disable (lock/unlock) port ethernet LAN pada ONU.
   *  port: nomor port LAN (1..4). enable=true→unlock, false→lock.
   *  Referensi C320: pon-onu-mng ... → interface eth eth_0/N state lock|unlock */
  async setOnuEthPort(onuIf, { port = 1, enable = true } = {}) {
    const ifc = this._normOnuIf(onuIf);
    const n = parseInt(port) || 1;
    const state = enable ? 'unlock' : 'lock';
    await this._enterConfig();
    const cmds = [`pon-onu-mng ${ifc}`, `interface eth eth_0/${n} state ${state}`, 'exit'];
    const out = await this.execSequence(cmds);
    await this._exitConfig();
    if (this._isCmdError(out)) throw new Error(`Set port LAN ${n} (${state}) gagal: ` + (this._firstError(out) || 'OLT menolak perintah'));
    return { success: true, port: n, state };
  }

  // Helper deteksi error baris perintah (termasuk format %Code/%Error ZTE),
  // tapi abaikan pesan informasi yang aman.
  _isCmdError(out) {
    const s = String(out || '');
    if (/no related information|already/i.test(s)) return false;
    return /invalid|fail|error|incomplete|denied|not\s+support|%\s*code\s*\d|%\s*error/i.test(s);
  }

  /** Hapus / unauthorize ONU dari PON port. */
  async deleteOnu(onuIf) {
    const ifc = this._normOnuIf(onuIf);
    const { gponOlt, onuId } = this._splitOnuIf(ifc);
    if (!gponOlt || !onuId) throw new Error('Format ONU interface tidak valid: ' + onuIf);
    await this._enterConfig();
    const cmds = [`interface ${gponOlt}`, `no onu ${onuId}`, 'exit'];
    const out = await this.execSequence(cmds);
    await this._exitConfig();
    // Deteksi error termasuk format "%Code NNNNN" ZTE; abaikan info "no related".
    const isErr = /invalid|fail|error|denied|not\s+support|%\s*code\s*(1\d{4}|2\d{4}|3\d{4}|4\d{4}|6\d{4})/i.test(out)
              && !/no related information|already/i.test(out);
    if (isErr) throw new Error('Hapus ONU gagal: ' + (this._firstError(out) || 'OLT menolak perintah'));
    return { success: true };
  }

  // ════════════════════════════════════════════════════════════════════
  // PARSERS
  // ════════════════════════════════════════════════════════════════════

  _normOltIf(s) {
    s = this._stripCtrl(s).trim();
    if (!s) return '';
    // Ambil HANYA pola frame/slot/port yang valid (mis. 1/2/1). Apa pun di luar
    // itu (newline, spasi, perintah sisipan) dibuang → cegah injeksi perintah.
    const core = s.replace(/^gpon-olt[_/]?/i, '');
    const m = core.match(/^(\d{1,3}\/\d{1,3}\/\d{1,3})/);
    if (!m) throw new Error('Format PON port tidak valid (harus frame/slot/port, mis. 1/2/1)');
    return `gpon-olt_${m[1]}`;
  }
  _normOnuIf(s) {
    s = this._stripCtrl(s).trim();
    if (!s) return '';
    // Ambil HANYA pola frame/slot/port:onu yang valid (mis. 1/2/1:30).
    const core = s.replace(/^gpon-onu[_/]?/i, '');
    const m = core.match(/^(\d{1,3}\/\d{1,3}\/\d{1,3}:\d{1,4})/);
    if (!m) throw new Error('Format ONU interface tidak valid (harus frame/slot/port:onu, mis. 1/2/1:30)');
    return `gpon-onu_${m[1]}`;
  }
  _splitOnuIf(onuIf) {
    const m = String(onuIf).match(/gpon-onu_(\d+\/\d+\/\d+):(\d+)/i);
    if (!m) return {};
    return { gponOlt: `gpon-olt_${m[1]}`, onuId: parseInt(m[2]) };
  }
  _firstError(out) {
    const line = String(out).split('\n').map(s => s.trim())
      .find(l => /error|invalid|fail|denied|incomplete|unknown command|%error|bad parameter|not exist/i.test(l));
    return (line || '').slice(0, 200);
  }

  // Parser tabel "show card" ZTE C300/C320.
  // Format kolom (variatif antar firmware): Rack Shelf Slot CfgType [RealType] [Port] [HardVer] [SoftVer] Status
  // Beberapa baris OFFLINE/NOPOWER tidak punya RealType/HW/SW — parser harus toleran.
  _parseCards(out) {
    const cards = [];
    const KNOWN_STATUS = /^(INSERVICE|OFFLINE|STANDBY|NOPOWER|ACTIVE|REGISTER|READY|UNINSERVICE|TYPE-MISMATCH|UNREGISTER|DUPLEX|MISMATCH)$/i;
    String(out).split(/\r?\n/).forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) return;
      if (/^-+$/.test(line)) return;                  // garis pemisah
      if (/^Rack\s+Shelf\s+Slot/i.test(line)) return; // baris header
      const t = line.split(/\s+/);
      if (t.length < 5) return;
      // Tiga kolom pertama wajib integer
      if (!/^\d+$/.test(t[0]) || !/^\d+$/.test(t[1]) || !/^\d+$/.test(t[2])) return;
      // Token terakhir = Status (kalau tidak dikenal, tetap simpan apa adanya)
      const last = t[t.length - 1];
      const status = (KNOWN_STATUS.test(last) ? last : last).toUpperCase();
      // Kolom CfgType
      const cfgType = t[3];
      // Middle = antara CfgType dan Status: bisa berisi RealType / Port / HardVer / SoftVer
      const mid = t.slice(4, -1);
      let realType = null, port = null, hwVer = null, swVer = null;
      for (const tok of mid) {
        if (/^\d+$/.test(tok)) {
          if (port == null) port = parseInt(tok);
        } else if (/^V[\d.]/i.test(tok)) {
          if (hwVer == null) hwVer = tok;
          else if (swVer == null) swVer = tok;
        } else {
          if (realType == null) realType = tok;
        }
      }
      // Tipe kartu: 'control' (SMXA/SCXM/NCSF) atau 'pon' (GTGO/GTGOG/GUSA/...)
      const type = /^(SMXA|SCXM|SCXN|NCSF|MMC|MCS)/i.test(cfgType || realType || '') ? 'control'
                 : /^(GT|GUS|GFGO|GP)/i.test(cfgType || realType || '') ? 'pon'
                 : 'other';
      cards.push({
        rack: +t[0], shelf: +t[1], slot: +t[2],
        cfgType, realType,
        port,
        hw_version: hwVer,
        sw_version: swVer,
        status,
        type,
        slot_label: `${+t[0]}/${+t[1]}/${+t[2]}`,
        temperature_c: null,   // diisi belakangan dari show temperature
      });
    });
    return cards;
  }

  // ── Environment / suhu OLT ──────────────────────────────────────────
  // Berdasarkan referensi ZTE C300/C320 (show temperature dan show processor),
  // ZTE memiliki perintah khusus yang lebih akurat dari "show environment":
  //
  //   show temperature
  //     Card Temperature:
  //     -------------------------------------------
  //     Slot  Temperature(Celsius scale)
  //     -------------------------------------------
  //        0           N/A.
  //        2           35
  //        3           32
  //
  //   show processor
  //     Rack Shelf Slot CPU(5s) CPU(1m) CPU(5m) PhyMem(MB) Memory
  //        1    1    2     14%     13%     13%        256    55%
  //
  // Kita coba "show temperature" dulu, lalu fallback ke "show environment"
  // untuk firmware yang menggunakan format lain.
  // Mengembalikan: { perSlot:{...}, perSlotCpu:{...}, perSlotMem:{...},
  //                  perSlotMemMb:{...}, chassis, fanStatus, raw }
  async _getEnvironment() {
    const perSlot = {};       // {<slot>: suhu(°C)}
    const perSlotCpu = {};    // {<slot>: cpu(%) — avg 5 menit}
    const perSlotMem = {};    // {<slot>: mem(%)}
    const perSlotMemMb = {};  // {<slot>: mem(MB)}
    let chassis = null;
    let fanStatus = null;
    let rawTemp = '', rawProc = '';

    // 1) Temperature per-slot. Perintah yang BENAR untuk C320 V2.x adalah
    //    "show card-temperature" (terbukti dari firmware Anda). Beberapa varian
    //    lain disertakan sebagai cadangan untuk firmware berbeda.
    //    Format C320 V2.x:
    //      All cards temperature(deg c):
    //      Rack Shelf Slot Temperature Temperature(5m) Temperature(1h) Optical-Temp
    //      1    1     2    30          29              29              N/A.
    const tempCmds = [
      'show card-temperature',   // ← C320 V2.x (utama)
      'show temperature',
      'show temperature card',
      'show card temperature',
      'show environment',
      'show environment temperature',
    ];
    for (const cmd of tempCmds) {
      const o = await this._safeExec(cmd);
      if (o && !/invalid input|incomplete command|unknown command|%\s*error|invalid command|not support/i.test(o)) {
        rawTemp = o;
        break;
      }
    }
    if (rawTemp) {
      String(rawTemp).split(/\r?\n/).forEach(line => {
        const l = line.trim();
        if (!l) return;
        // skip header/garis
        if (/rack\s+shelf\s+slot|temperature\(|all\s+cards|^-+$/i.test(l)) return;
        // Format tabel "show card-temperature":
        //   Rack Shelf Slot Temperature Temp(5m) Temp(1h) Optical-Temp
        //   1    1     2    30          29       29       N/A.
        let m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?|N\/A\.?)\b/i);
        if (m) {
          const slot = parseInt(m[3]);
          const temp = m[4];
          if (!/^N\/A/i.test(temp)) perSlot[slot] = parseFloat(temp);
          return;
        }
        // Format ringkas "<slot>  <temp>" (firmware lain)
        m = l.match(/^(\d+)\s+(\d+(?:\.\d+)?|N\/A\.?)\s*$/i);
        if (m) { if (!/^N\/A/i.test(m[2])) perSlot[parseInt(m[1])] = parseFloat(m[2]); return; }
        // Format "Slot N ... temperature is XX (C)"
        m = l.match(/Slot\s+(\d+)[^0-9-]*(-?\d+(?:\.\d+)?)\s*\(?\s*C/i);
        if (m) { perSlot[parseInt(m[1])] = parseFloat(m[2]); return; }
        // Chassis tunggal "Temperature : XX"
        m = l.match(/^Temperature[^:]*:\s*(-?\d+(?:\.\d+)?)/i);
        if (m && chassis == null) chassis = parseFloat(m[1]);
      });
    }

    // 2) show processor — per-slot CPU & Memory
    rawProc = await this._safeExec('show processor');
    if (rawProc && !/invalid input|incomplete command|unknown command|%\s*error/i.test(rawProc)) {
      String(rawProc).split(/\r?\n/).forEach(line => {
        const l = line.trim();
        if (!l) return;
        // Pola: "<rack> <shelf> <slot> <cpu5s>% <cpu1m>% <cpu5m>% <phyMem> <mem>%"
        const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s+(\d+)\s+(\d+(?:\.\d+)?)%/);
        if (!m) return;
        const slot = parseInt(m[3]);
        perSlotCpu[slot] = parseFloat(m[6]);      // CPU 5m
        perSlotMemMb[slot] = parseInt(m[7]);
        perSlotMem[slot] = parseFloat(m[8]);
      });
    }

    // 3) Fallback "show environment" untuk firmware yang tidak punya
    //    show temperature (mis. C220 atau ZXAN versi tertentu)
    if (Object.keys(perSlot).length === 0) {
      const envCandidates = ['show environment', 'show environment current', 'show env'];
      let envOut = '';
      for (const cmd of envCandidates) {
        const o = await this._safeExec(cmd);
        if (o && !/invalid input|incomplete command|unknown command|%\s*error/i.test(o)) { envOut = o; break; }
      }
      String(envOut).split(/\r?\n/).forEach(line => {
        const l = line.trim();
        let m = l.match(/Slot\s+(\d+)[^:]*:.*?temperature\s+is\s+(-?\d+(?:\.\d+)?)\s*\(?C\)?/i);
        if (m) { perSlot[parseInt(m[1])] = parseFloat(m[2]); return; }
        m = l.match(/(?:^|\b)(?:Current\s+)?Temperature\b[^:]*:\s*(-?\d+(?:\.\d+)?)/i);
        if (m && chassis == null) chassis = parseFloat(m[1]);
        m = l.match(/^Fan(?:\s+Status)?\s*:\s*(\S+)/i);
        if (m && !fanStatus) fanStatus = m[1];
      });
    }

    // Chassis temp = max suhu antar card (lebih indikatif untuk overheating)
    if (chassis == null) {
      const vals = Object.values(perSlot).filter(v => typeof v === 'number' && !isNaN(v));
      if (vals.length) chassis = Math.max(...vals);
    }
    return { perSlot, perSlotCpu, perSlotMem, perSlotMemMb, chassis, fanStatus,
             raw: (rawTemp + '\n' + rawProc).slice(0, 2000) };
  }

  // show gpon onu state gpon-olt_x/x/x
  _parseOnuState(out, gponOlt) {
    const onus = [];
    const seen = new Set();   // dedup per onu_id dalam satu PON
    String(out).split('\n').forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) return;
      // Lewati baris header / pemisah lebih awal.
      if (/onuindex|onu number|admin\s*state|omcc|phase\s*state|^-+$|^=+$/i.test(line)) return;
      // Dukung dua format firmware:
      //   gpon-onu_1/2/1:29  enable  enable  working  1
      //   1/2/1:29           enable  disable LOS      1(GPON)
      const m = line.match(/^(?:gpon-onu_)?(\d+\/\d+\/\d+):(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?/i);
      if (!m) return;

      const ifc   = m[1];
      const onuId = parseInt(m[2]);
      if (seen.has(onuId)) return;   // baris dobel → abaikan
      seen.add(onuId);

      const admin = (m[3] || '').toLowerCase();
      // Kolom setelah admin: bisa [omcc, phase, chan] atau [omcc, o7, phase, chan].
      const cols = [m[4], m[5], m[6], m[7]].filter(Boolean);
      const phaseTokens = ['working','los','offline','online','dyinggasp','loss','syncmib','ranging','logging','initial'];
      let phase = '', phaseIdx = -1;
      for (let i = cols.length - 1; i >= 0; i--) {
        const c = String(cols[i]).toLowerCase().replace(/\(.*\)$/, '');
        if (phaseTokens.includes(c)) { phase = c; phaseIdx = i; break; }
      }
      // OMCC = kolom pertama setelah admin (index 0 dari cols), bila bukan phase itu sendiri.
      const omcc = (phaseIdx === 0) ? '' : (cols[0] || '');
      // Fallback phase bila tak terdeteksi token.
      if (!phase) phase = String(cols[1] || cols[0] || '').toLowerCase().replace(/\(.*\)$/, '');

      let status = 'offline';
      if (phase === 'working' || phase === 'online') status = 'online';
      else if (admin === 'disable') status = 'disabled';

      onus.push({
        onu_if:      `gpon-onu_${ifc}:${onuId}`,
        gpon_olt:    `gpon-olt_${ifc}`,
        onu_id:      onuId,
        admin_state: m[3],
        omcc_state:  omcc,
        phase_state: phase || '',
        status,
      });
    });
    return onus;
  }

  // show gpon onu uncfg
  _parseUncfg(out) {
    const list = [];
    String(out).split('\n').forEach(line => {
      // gpon-onu_1/1/1:1   ZTEGC0B8305A   unknown
      const m = line.trim().match(/gpon-onu_(\d+\/\d+\/\d+):(\d+)\s+(\S+)\s*(\S+)?/i);
      if (!m) return;
      list.push({
        onu_if:   `gpon-onu_${m[1]}:${m[2]}`,
        gpon_olt: `gpon-olt_${m[1]}`,
        slot_hint: m[1],
        next_onu_id: parseInt(m[2]),
        sn:       m[3],
        state:    m[4] || 'unknown',
      });
    });
    return list;
  }

  // show gpon onu detail-info gpon-onu_x/x/x:y
  _parseOnuDetail(out, onuIf) {
    const get = (label) => {
      const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+)', 'i');
      const m = String(out).match(re);
      return m ? m[1].trim() : null;
    };
    const distStr = get('ONU Distance');
    const distance_m = distStr ? parseInt(String(distStr).replace(/[^\d]/g, '')) || null : null;
    const phase = (get('Phase state') || '').toLowerCase();
    const onlineDur = get('Online Duration') || '';
    const configState = get('Config state');
    // Diagnosa "tidak pernah online": config sukses TAPI belum pernah ranging.
    //   - Online Duration 0h 0m 0s + Distance N/A + Phase OffLine/LOS
    const neverRanged = /n\/a/i.test(String(distStr || '')) || distance_m == null;
    const neverOnline = /^0h\s*0m\s*0s$/i.test(onlineDur.trim());
    let diagnosis = null;
    if (phase && !/working|online/.test(phase)) {
      if (/los|loss/.test(phase)) {
        diagnosis = 'LOS — OLT tidak menerima sinyal optik dari ONU. Cek: ONU menyala? fiber tercolok & bersih? redaman tidak terlalu tinggi?';
      } else if (neverOnline && neverRanged) {
        diagnosis = 'ONU belum pernah online (Online Duration 0, Distance N/A). Konfigurasi OK, tapi ONU belum ranging. Penyebab umum: ONU mati/booting, fiber belum sampai ke ONU, atau SN ter-authorize di PON port yang berbeda dari letak fisik fiber-nya.';
      } else {
        diagnosis = 'ONU sedang offline. Tunggu proses ranging (1-2 menit) lalu refresh.';
      }
    }
    return {
      onu_if:       onuIf,
      name:         get('Name'),
      type:         get('Type'),
      state:        get('State'),
      admin_state:  get('Admin state'),
      phase_state:  get('Phase state'),
      config_state: configState,
      auth_mode:    get('Authentication mode'),
      serial_number:get('Serial number'),
      description:  get('Description'),
      onu_status:   get('ONU Status'),
      distance_m,
      online_duration: onlineDur || null,
      never_online: neverOnline && neverRanged,
      diagnosis,
      raw: String(out).trim().slice(0, 4000),
    };
  }

  // show pon power attenuation gpon-onu_x/x/x:y
  // Format:
  //   OLT       ONU            Attenuation
  //   up   Rx :-22.500(dbm) Tx:2.100(dbm)   24.6
  //   down Tx :3.200(dbm)   Rx:-18.300(dbm) 21.5
  _parsePower(out, onuIf) {
    const s = String(out);
    const num = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : null; };

    // OLT Rx = sinyal yang diterima OLT dari ONU (upstream Rx)
    const olt_rx = num(/up\s*Rx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(?dbm/i);
    // ONU Rx = sinyal yang diterima ONU dari OLT (downstream Rx) = REDAMAN pelanggan
    const onu_rx = num(/down\s*[^\n]*Rx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(?dbm/i)
               ?? num(/Rx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(?dbm[\s\S]*?down/i);
    const onu_tx = num(/up\s*[^\n]*Tx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(?dbm/i);
    const olt_tx = num(/down\s*Tx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(?dbm/i);

    const noSignal = /no\s*signal/i.test(s);

    // Klasifikasi kualitas redaman ONU (Rx ONU)
    let quality = 'unknown';
    if (noSignal) quality = 'los';
    else if (onu_rx !== null) {
      if (onu_rx >= -25) quality = 'good';
      else if (onu_rx >= -28) quality = 'warning';
      else quality = 'critical';
    }

    return {
      onu_if:    onuIf,
      onu_rx_dbm: onu_rx,   // redaman pelanggan (yang biasa dicek)
      onu_tx_dbm: onu_tx,
      olt_rx_dbm: olt_rx,
      olt_tx_dbm: olt_tx,
      no_signal: noSignal,
      quality,
      raw: s.trim().slice(0, 2000),
    };
  }

  // show running-config interface gpon-olt_x/x/x  → ambil onu N type T sn S
  _parseRunConfig(out) {
    const onus = [];
    String(out).split('\n').forEach(line => {
      const m = line.trim().match(/^onu\s+(\d+)\s+type\s+(\S+)\s+sn\s+(\S+)/i);
      if (m) onus.push({ onu_id: parseInt(m[1]), type: m[2], sn: m[3] });
    });
    return onus;
  }

  // Map {onu_id: {name, sn, type, desc}} dari running-config sebuah PON.
  // Sumber SN: baris "onu N type X sn YYYY" (di bawah interface gpon-olt).
  // Sumber name/desc: blok "interface gpon-onu_F/S/P:N" → "name ..." / "description ...".
  _parseRunConfigNames(out) {
    const map = {};
    const ensure = (id) => (map[id] = map[id] || {});
    const lines = String(out).split('\n');
    let curOnu = null;
    lines.forEach(raw => {
      const line = raw.trim();
      // SN & type: onu 24 type F663NV3a sn ELWGC44A1711
      const sn = line.match(/^onu\s+(\d+)\s+type\s+(\S+)\s+sn\s+(\S+)/i);
      if (sn) { const o = ensure(parseInt(sn[1])); o.type = sn[2]; o.sn = sn[3]; }
      // Masuk blok interface gpon-onu_X/Y/Z:N
      const ent = line.match(/^interface\s+gpon-onu_\d+\/\d+\/\d+:(\d+)/i);
      if (ent) { curOnu = parseInt(ent[1]); return; }
      if (curOnu != null) {
        const nm = line.match(/^name\s+(.+)/i);
        if (nm) { ensure(curOnu).name = nm[1].trim(); return; }
        const ds = line.match(/^description\s+(.+)/i);
        if (ds) { ensure(curOnu).desc = ds[1].trim(); return; }
        // akhir blok
        if (line === '!' || /^interface\s/i.test(line)) curOnu = null;
      }
    });
    return map;
  }
}

module.exports = ZteOltService;
