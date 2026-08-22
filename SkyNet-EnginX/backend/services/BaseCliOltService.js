'use strict';

/**
 * BaseCliOltService.js
 * ─────────────────────────────────────────────────────────────────────
 * Base class koneksi CLI (Telnet / SSH) untuk semua service OLT berbasis
 * command-line (ZTE, CDATA, HIOSO, ZIMMLINK, dll).
 *
 * Menangani:
 *   - connect() / disconnect()         (Telnet via node-telnet-client, SSH via ssh2)
 *   - exec(cmd)                        (kirim 1 perintah, kembalikan output)
 *   - execSequence([cmds])             (beberapa perintah berurutan)
 *   - _safeExec(cmd)                   (exec yang menelan error)
 *   - _firstError(out)                 (ambil baris error pertama)
 *
 * Subclass cukup mengimplementasikan command + parser spesifik vendor.
 *
 * CATATAN: node-telnet-client & ssh2 sudah ada di package.json.
 * ─────────────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');

// PENTING: paket yang benar adalah "telnet-client" (bukan "node-telnet-client").
// "node-telnet-client" TERNYATA sebuah Express server salah-nama yang menjalankan
// app.listen(80) SAAT DI-REQUIRE — sehingga TIDAK BOLEH di-require sama sekali
// (akan membajak port & menyebabkan EADDRINUSE / crash). Jadi TIDAK ada fallback
// ke nama lama itu. package.json memakai telnet-client@^2.2.13.
let Telnet;
try { ({ Telnet } = require('telnet-client')); }
catch (e) {
  logger.warn('[OltCli] telnet-client belum terinstall — fitur OLT via Telnet nonaktif. ' +
    'Jalankan: npm install telnet-client@^2.2.13 (JANGAN install node-telnet-client).');
}

let SSHClient;
try { SSHClient = require('ssh2').Client; }
catch (e) { logger.warn('[OltCli] ssh2 belum terinstall — jalankan: npm install ssh2'); }

class BaseCliOltService {
  constructor(config = {}) {
    this.host     = config.host;
    this.protocol = (config.protocol || 'telnet').toLowerCase();
    this.port     = config.port || (this.protocol === 'ssh' ? 22 : 23);
    this.username = config.username || '';
    this.password = config.password || '';
    this.enablePassword = config.enablePassword || '';
    this.timeout  = config.timeout || 15000;
    this.name     = config.name || config.host;
    // Prompt CLI biasanya berakhir '#' (privileged) atau '>' (user).
    this.prompt   = config.prompt || /[#>]\s*$/;
    // Perintah untuk mematikan paging "--More--" (override per vendor bila perlu)
    this.pagingOffCmd = config.pagingOffCmd || 'terminal length 0';

    this._conn = null;
    this._ssh = null;
    this._sshStream = null;
  }

  // ── Koneksi ────────────────────────────────────────────────────────
  async connect() {
    if (this.protocol === 'ssh') return this._connectSSH();
    return this._connectTelnet();
  }

  async _connectTelnet() {
    if (!Telnet) throw new Error('telnet-client tidak terinstall (npm install telnet-client)');
    this._conn = new Telnet();
    // Tangani error stream agar tidak meng-crash proses (ECONNRESET dari OLT).
    this._conn.on && this._conn.on('error', (e) => logger.warn('[OltCli] telnet error: ' + (e && e.message)));
    await this._conn.connect({
      host: this.host,
      port: this.port,
      timeout: this.timeout,
      negotiationMandatory: false,
      // Prompt mencakup mode privileged "#", user ">", dan mode config ZTE
      // seperti ZXAN(config)#, ZXAN(config-if)#, (gpon-onu-mng 1/2/1:2)#.
      shellPrompt: this.prompt,
      loginPrompt: /(login|user\s*name|user)[: ]*\s*$/i,
      passwordPrompt: /password[: ]*\s*$/i,
      username: this.username,
      password: this.password,
      pageSeparator: /--\s*more\s*--|----more----/i,
      execTimeout: this.timeout,
      sendTimeout: this.timeout,
      stripShellPrompt: true,
      irs: '\r\n',
      ors: '\n',
    });
    if (this.pagingOffCmd) await this._safeExec(this.pagingOffCmd);
    return true;
  }

  _connectSSH() {
    if (!SSHClient) throw new Error('ssh2 tidak terinstall');
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      this._ssh = conn;
      const timer = setTimeout(() => { try { conn.end(); } catch (e) {} reject(new Error('SSH timeout')); }, this.timeout);

      conn.on('ready', () => {
        conn.shell({ term: 'vt100' }, (err, stream) => {
          if (err) { clearTimeout(timer); return reject(err); }
          this._sshStream = stream;
          let buf = '';
          let pagingSent = false;
          let settleTimer = null;
          const self = this;

          const settleResolve = () => {
            clearTimeout(timer);
            if (settleTimer) clearTimeout(settleTimer);
            stream.removeListener('data', onData);
            resolve(true);
          };
          const onData = (d) => {
            buf += d.toString();
            const clean = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
            const tail = clean.split('\n').pop().trim();
            const atPrompt = /[#>]\s*$/.test(tail) || self.prompt.test(tail + ' ');
            if (atPrompt && !pagingSent) {
              // Prompt awal muncul → matikan paging, lalu tunggu sebentar agar
              // echo perintah paging-off ikut terbaca & tidak mengotori exec pertama.
              pagingSent = true;
              if (self.pagingOffCmd) stream.write(self.pagingOffCmd + '\n');
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(settleResolve, 600);
              return;
            }
            if (pagingSent) {
              // Setelah paging-off terkirim, reset jeda diam tiap ada data baru.
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(settleResolve, 600);
            }
          };
          stream.on('data', onData);
          // Pancing prompt bila banner tidak otomatis menampilkannya.
          setTimeout(() => { try { stream.write('\n'); } catch (e) {} }, 300);
        });
      });
      conn.on('error', (e) => { clearTimeout(timer); reject(e); });
      conn.connect({
        host: this.host,
        port: this.port,
        username: this.username,
        password: this.password,
        readyTimeout: this.timeout,
        // OLT lama sering pakai algoritma legacy
        algorithms: {
          kex: ['diffie-hellman-group1-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha256'],
          cipher: ['aes128-cbc', '3des-cbc', 'aes128-ctr', 'aes256-ctr'],
          serverHostKey: ['ssh-rsa', 'ssh-dss'],
        },
      });
    });
  }

  async disconnect() {
    try { if (this._conn) await this._conn.end(); } catch (e) {}
    try { if (this._sshStream) this._sshStream.end(); } catch (e) {}
    try { if (this._ssh) this._ssh.end(); } catch (e) {}
    this._conn = null; this._ssh = null; this._sshStream = null;
  }

  // ── Eksekusi perintah ──────────────────────────────────────────────
  async exec(cmd) {
    if (this.protocol === 'ssh') return this._execSSH(cmd);
    return this._execTelnet(cmd);
  }

  async _execTelnet(cmd) {
    if (!this._conn) throw new Error('Koneksi telnet tidak aktif');
    try {
      const out = await this._conn.exec(cmd, {
        timeout: this.timeout,
        execTimeout: this.timeout,
        // Anggap selesai saat prompt (termasuk mode config) muncul.
        shellPrompt: this.prompt,
        // Jangan gantung bila ada paging.
        ors: '\n',
        stripControls: true,
      });
      return this._cleanTelnet(out, cmd);
    } catch (e) {
      // Beberapa firmware memunculkan konfirmasi y/n (reboot/restore/delete)
      // yang membuat exec() timeout. Coba jalur send() + tunggu prompt.
      try {
        const out = await this._conn.send(cmd, {
          timeout: this.timeout,
          waitFor: this.prompt,
          ors: '\n',
        });
        // Bila masih menunggu konfirmasi, jawab "y".
        if (/\b(confirm|are you sure|continue)\b/i.test(String(out)) && /y(es)?\s*\/\s*n/i.test(String(out))) {
          const out2 = await this._conn.send('y', { timeout: this.timeout, waitFor: this.prompt, ors: '\n' });
          return this._cleanTelnet(String(out) + '\n' + String(out2), cmd);
        }
        return this._cleanTelnet(out, cmd);
      } catch (e2) {
        // Kembalikan apa pun yang ada agar caller bisa mendeteksi error,
        // bukan melempar (sebagian perintah memang tak mengembalikan apa-apa).
        return '';
      }
    }
  }

  _cleanTelnet(out, cmd) {
    let s = String(out || '');
    const lines = s.split('\n');
    if (lines.length && lines[0].includes(cmd)) lines.shift();
    while (lines.length && this._looksLikePrompt(lines[lines.length - 1])) lines.pop();
    return lines.join('\n');
  }

  async _safeExec(cmd) {
    try { return await this.exec(cmd); } catch (e) { return ''; }
  }

  // Prompt CLI ZTE termasuk mode config: ZXAN#, ZXAN(config)#,
  // ZXAN(config-if)#, (gpon-onu-mng 1/2/1:2)#, dll. Deteksi prompt di AKHIR
  // baris terakhir agar exec selesai segera tanpa menunggu idle penuh.
  _looksLikePrompt(text) {
    const tail = String(text).split('\n').pop().trim();
    if (!tail) return false;
    // prompt config ZTE atau privileged/user umum
    return /[\w.\-]+(\([\w\-./: ]+\))?\s*[#>]\s*$/.test(tail) || this.prompt.test(tail + ' ');
  }

  _execSSH(cmd, settleMs = 350) {
    return new Promise((resolve, reject) => {
      if (!this._sshStream) return reject(new Error('SSH stream tidak aktif'));
      const stream = this._sshStream;
      let buf = '';
      let idleTimer = null;
      let done = false;
      const self = this;
      const hardTimer = setTimeout(() => finish('timeout'), this.timeout);

      function schedule(ms) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish('idle'), ms == null ? settleMs : ms);
      }
      function stripAnsi(s) {
        return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
                .replace(/\x1b[()][AB0]/g, '')
                .replace(/\x08/g, '')
                .replace(/\r/g, '');
      }
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
        stream.removeListener('data', onData);
        let out = stripAnsi(buf);
        const lines = out.split('\n');
        // Buang baris echo perintah (baris pertama yang memuat cmd)
        if (lines.length && lines[0].includes(cmd)) lines.shift();
        // Buang baris-baris prompt di akhir
        while (lines.length && self._looksLikePrompt(lines[lines.length - 1])) lines.pop();
        resolve(lines.join('\n'));
      }
      const onData = (d) => {
        buf += d.toString();
        const clean = stripAnsi(buf);
        const tail = clean.slice(-80);

        // 1) Paging "--More--" / "Press any key" → kirim spasi, lanjut.
        if (/--\s*more\s*--|press any key|----more----/i.test(tail)) {
          buf = buf.replace(/--\s*more\s*--/gi, '');
          stream.write(' ');
          schedule(800);
          return;
        }
        // 2) Konfirmasi y/n (reboot, restore factory, delete) → jawab "y".
        //    Contoh: "Confirm to reboot? [yes/no]:" / "Are you sure? (y/n)"
        if (/\b(confirm|are you sure|continue)\b.*\??\s*[\[(]?\s*(y(es)?\s*\/\s*n(o)?|yes\s*\/\s*no)\s*[\])]?\s*[:?]?\s*$/i.test(tail)) {
          stream.write('y\n');
          schedule(800);
          return;
        }
        // 3) Prompt CLI muncul di akhir → selesai cepat (idle pendek).
        if (self._looksLikePrompt(clean)) { schedule(settleMs); return; }

        // 4) Belum ada prompt → tunggu lebih lama (output sedang mengalir).
        schedule(1000);
      };
      stream.on('data', onData);
      stream.write(cmd + '\n');
    });
  }

  async execSequence(cmds = []) {
    const out = [];
    for (const c of cmds) out.push(await this.exec(c));
    return out.join('\n');
  }

  _firstError(out) {
    const line = String(out).split('\n').map(s => s.trim())
      .find(l => /error|invalid|fail|denied|incomplete|unknown command/i.test(l));
    return (line || '').slice(0, 160);
  }
}

module.exports = BaseCliOltService;
