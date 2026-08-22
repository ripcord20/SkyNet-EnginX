const { WaSession, WaMessage, WaAutoReply, WaTemplate, Customer, Invoice } = require('../models');
const { Op } = require('sequelize');
const WAService = require('../services/WAService');
const WahaService = require('../services/WahaService');
const GatewayService = require('../services/GatewayService');
const logger    = require('../utils/logger');
const moment    = require('moment');
const { getCompanyName } = require('../utils/companyInfo');

class WAController {

  // ── SESSIONS ──────────────────────────────────────────────
  async getSessions(req, res) {
    try {
      const sessions = await WaSession.findAll({ order: [['created_at', 'DESC']] });

      // Untuk WAHA: JANGAN percaya status DB begitu saja. Status DB bisa basi
      // (mis. sempat blip jaringan, atau app baru restart sebelum cron sempat
      // jalan) → UI menampilkan "Terputus" padahal WAHA sebenarnya WORKING,
      // dan admin merasa harus "hubungkan ulang" tiap buka halaman.
      // Di sini kita verifikasi live ke WAHA (quad-state):
      //   connected/connecting/disconnected → pakai hasil live + sinkronkan DB
      //   unknown (WAHA tak terjangkau)     → PERTAHANKAN status terakhir di DB
      const result = await Promise.all(sessions.map(async (s) => {
        const base = s.toJSON();

        if (s.provider === 'waha') {
          if (!s.waha_url) return { ...base, runtime_status: s.status };
          let live;
          try {
            // Batasi pengecekan live maksimal 5 dtk supaya halaman tidak pernah
            // menggantung kalau WAHA lambat/hang. Lewat itu → 'unknown' (aman:
            // pakai status terakhir di DB, bukan divonis putus).
            live = await Promise.race([
              WahaService.checkConnection(s),
              new Promise((resolve) => setTimeout(() => resolve('unknown'), 5000))
            ]);
          } catch (_) {
            live = 'unknown';
          }
          if (live === 'unknown') {
            // Transient — jangan vonis putus, pakai status terakhir yang diketahui.
            return { ...base, runtime_status: s.status, status_stale: true };
          }
          // Sinkronkan DB kalau berbeda (self-heal), supaya modul lain ikut benar.
          if (live !== s.status) {
            try {
              await WaSession.update(
                { status: live, last_seen: new Date() },
                { where: { session_id: s.session_id } }
              );
              GatewayService.invalidateSessionCache(s.session_id);
            } catch (_) { /* non-fatal */ }
          }

          // Kalau benar-benar putus (STOPPED/FAILED/hilang di WAHA), coba pulihkan
          // otomatis di background — auth biasanya masih tersimpan di volume WAHA,
          // sehingga session naik lagi tanpa scan QR. Tidak memblokir respons:
          // UI menampilkan status saat ini, lalu ter-update via socket 'wa:status'.
          if (live === 'disconnected') {
            setImmediate(() => {
              WahaService.ensureConnected(s)
                .then((r) => {
                  if (!r) return;
                  if (r.action === 'restarted' || r.action === 'created') {
                    WaSession.update(
                      { status: 'connecting', last_seen: new Date() },
                      { where: { session_id: s.session_id } }
                    ).catch(() => {});
                    GatewayService.invalidateSessionCache(s.session_id);
                    const io = req.app && req.app.get && req.app.get('io');
                    if (io) io.emit('wa:status:' + s.session_id, { status: 'connecting', provider: 'waha', auto: true });
                    logger.info(`[WA] ${s.session_id} putus → dipulihkan otomatis (${r.action})`);
                  }
                })
                .catch(() => {});
            });
          }

          return { ...base, status: live, runtime_status: live };
        }

        if (s.provider === 'fonnte') {
          return { ...base, runtime_status: s.status };     // segar via verify/webhook
        }

        // Baileys: cek socket real-time
        return { ...base, runtime_status: WAService.getSessionStatus(s.session_id) };
      }));

      res.json({ success: true, data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async createSession(req, res) {
    try {
      const { name, notes, provider, fonnte_token, waha_url, waha_api_key, waha_session } = req.body;
      if (!name) return res.status(400).json({ success: false, message: 'Nama sesi wajib diisi' });
      const prov = (provider === 'fonnte') ? 'fonnte' : (provider === 'waha') ? 'waha' : 'baileys';
      if (prov === 'fonnte' && !fonnte_token) {
        return res.status(400).json({ success: false, message: 'Token Fonnte wajib diisi untuk provider Fonnte' });
      }
      if (prov === 'waha') {
        const url = String(waha_url || '').trim();
        if (!url) return res.status(400).json({ success: false, message: 'URL WAHA wajib diisi untuk provider WAHA' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, message: 'URL WAHA harus diawali http:// atau https://' });
      }

      const sessionId = 'wa_' + Date.now();
      const session = await WaSession.create({
        session_id: sessionId, name, notes, status: 'disconnected',
        provider: prov,
        fonnte_token: prov === 'fonnte' ? fonnte_token : null,
        waha_url:     prov === 'waha' ? String(waha_url).trim().replace(/\/+$/, '') : null,
        waha_api_key: prov === 'waha' ? (waha_api_key || null) : null,
        waha_session: prov === 'waha' ? (String(waha_session || '').trim() || 'default') : null,
      });
      res.status(201).json({ success: true, data: session });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async connectSession(req, res) {
    try {
      const { session_id } = req.params;
      const session = await WaSession.findOne({ where: { session_id } });
      if (!session) return res.status(404).json({ success: false, message: 'Session tidak ditemukan' });

      // ── Provider Fonnte: tidak ada QR, cukup verifikasi token via API ──
      if (session.provider === 'fonnte') {
        if (!session.fonnte_token) {
          return res.status(400).json({ success: false, message: 'Token Fonnte belum diisi' });
        }
        GatewayService.invalidateSessionCache(session_id);
        const ok = await GatewayService.verifyFonnteConnection(session_id);
        return res.json({
          success: ok,
          message: ok ? 'Device Fonnte terhubung' : 'Device Fonnte tidak aktif / token salah. Cek dashboard Fonnte.'
        });
      }

      // ── Provider WAHA: start session di WAHA; QR diambil via endpoint /qr ──
      if (session.provider === 'waha') {
        if (!session.waha_url) {
          return res.status(400).json({ success: false, message: 'URL WAHA belum diisi' });
        }
        GatewayService.invalidateSessionCache(session_id);
        try {
          // Sudah WORKING? Langsung tandai connected tanpa QR.
          const already = await GatewayService.verifyWahaConnection(session_id);
          if (already) {
            return res.json({ success: true, message: 'Session WAHA sudah terhubung' });
          }
          await WahaService.startSession(session);
          logger.info('[WAHA] connect: session "' + session_id + '" di-start/create di WAHA — menunggu QR');
          await WaSession.update({ status: 'connecting', qr_code: null }, { where: { session_id } });
          GatewayService.invalidateSessionCache(session_id);
          return res.json({ success: true, message: 'Menghubungkan ke WAHA... scan QR yang muncul' });
        } catch (e) {
          logger.error('[WAHA] connect error for ' + session_id + ': ' + e.message);

          // Diagnostik yang bisa ditindaklanjuti — bedakan penyebabnya, supaya
          // admin tahu harus memperbaiki apa (bukan sekadar "gagal").
          const code   = e.code || '';
          const status = e.response && e.response.status;
          let hint;
          if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') {
            hint = 'Container WAHA tidak merespons di ' + session.waha_url +
                   '. Pastikan WAHA jalan (cek: docker ps) dan URL-nya benar.';
          } else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
            hint = 'Koneksi ke WAHA timeout. Container mungkin lambat/overload, atau URL tidak terjangkau dari server ini.';
          } else if (status === 401 || status === 403) {
            hint = 'API key WAHA ditolak. Periksa WHATSAPP_API_KEY di container WAHA dan isian API Key di device ini.';
          } else if (status === 422) {
            hint = 'WAHA menolak konfigurasi session. Periksa nama session (' + (session.waha_session || 'default') + ').';
          } else {
            hint = 'Pastikan container WAHA jalan serta URL/API key benar.';
          }

          return res.status(502).json({
            success: false,
            message: 'Gagal menghubungi WAHA: ' + e.message + '. ' + hint,
            data: { code: code || null, http_status: status || null, waha_url: session.waha_url }
          });
        }
      }

      // ── Provider Baileys: alur QR seperti biasa ──
      if (WAService.isConnected(session_id)) {
        return res.json({ success: true, message: 'Session sudah terhubung' });
      }
      const io = req.app.get('io');
      await WaSession.update({ status: 'connecting', qr_code: null }, { where: { session_id } });
      WAService.createSession(session_id, io, null).catch(async (err) => {
        logger.error('[WA] createSession error for ' + session_id + ':', err.message);
        await WaSession.update({ status: 'disconnected' }, { where: { session_id } }).catch(() => {});
        if (io) io.emit('wa:status:' + session_id, { status: 'disconnected', error: err.message });
      });
      res.json({ success: true, message: 'Menghubungkan... scan QR yang muncul' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async disconnectSession(req, res) {
    try {
      const { session_id } = req.params;
      const sess = await WaSession.findOne({ where: { session_id } });
      if (sess && sess.provider === 'waha') {
        await WahaService.logoutSession(sess).catch(e =>
          logger.warn('[WAHA] logout saat disconnect gagal: ' + e.message));
        await WaSession.update({ status: 'disconnected', qr_code: null, phone_number: null }, { where: { session_id } });
        GatewayService.invalidateSessionCache(session_id);
        return res.json({ success: true, message: 'Session WAHA di-logout dan diputus' });
      }
      await WAService.disconnectSession(session_id);
      await WaSession.update({ status: 'disconnected', qr_code: null, phone_number: null }, { where: { session_id } });
      res.json({ success: true, message: 'Session diputus dan data auth dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async deleteSession(req, res) {
    try {
      const { session_id } = req.params;

      // 1. Cek session ada atau tidak — cegah request delete berulang
      const exists = await WaSession.findOne({ where: { session_id } });
      if (!exists) {
        return res.status(404).json({ success: false, message: 'Session tidak ditemukan' });
      }

      // 2. Disconnect socket & hapus auth folder (Baileys) — best-effort
      await WAService.disconnectSession(session_id).catch(err => {
        logger.warn('[WA] disconnectSession failed during delete: ' + err.message);
      });

      // 2b. Provider WAHA: hentikan & hapus session di container WAHA juga.
      //     Kalau dilewati, session lama tetap hidup di WAHA — bisa bentrok saat
      //     nanti dibuat device baru dengan nama session yang sama.
      //     Best-effort: kegagalan di sini tidak boleh membatalkan penghapusan.
      if (exists.provider === 'waha' && exists.waha_url) {
        try {
          await WahaService.stopSession(exists);
          logger.info('[WA] WAHA session "' + (exists.waha_session || 'default') + '" dihentikan di container');
        } catch (err) {
          logger.warn('[WA] Gagal menghentikan session di WAHA (dilanjutkan): ' + err.message);
        }
      }

      // 3. Bersihkan data terkait supaya tidak jadi orphan di DB.
      //    Hanya tabel yang punya kolom `session_id` (WaMessage, WaAutoReply).
      //    Tabel lain (WaIncoming, WaBroadcast, WaLog) pakai device_id / tanpa binding,
      //    jadi tidak disentuh di sini.
      const cleanup = [
        { model: WaMessage,   label: 'WaMessage'   },
        { model: WaAutoReply, label: 'WaAutoReply' }
      ];

      const purged = {};
      for (const item of cleanup) {
        if (!item.model) continue;
        try {
          const n = await item.model.destroy({ where: { session_id } });
          purged[item.label] = n;
        } catch (err) {
          logger.warn('[WA] Cleanup ' + item.label + ' failed: ' + err.message);
          purged[item.label] = 'error';
        }
      }

      // 4. Hapus row session di database
      await WaSession.destroy({ where: { session_id } });

      // 5. Emit event via socket supaya dashboard admin lain ikut refresh
      try {
        const io = req.app.get('io');
        if (io) io.emit('wa:session:deleted', { session_id });
      } catch (_) {}

      logger.info('[WA] Session ' + session_id + ' dihapus. Cleanup: ' + JSON.stringify(purged));
      res.json({
        success: true,
        message: 'Session berhasil dihapus beserta seluruh data terkait',
        data: { session_id, purged }
      });
    } catch (e) {
      logger.error('[WA] deleteSession error: ' + e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async updateSession(req, res) {
    try {
      const { session_id } = req.params;
      const { name, notes, auto_reply_enabled, webhook_url, provider, fonnte_token, waha_url, waha_api_key, waha_session } = req.body;
      const patch = { name, notes, auto_reply_enabled, webhook_url };
      // Provider & config hanya di-update kalau dikirim (biar tidak menimpa jadi null)
      if (provider !== undefined) patch.provider = (provider === 'fonnte') ? 'fonnte' : (provider === 'waha') ? 'waha' : 'baileys';
      if (fonnte_token !== undefined) patch.fonnte_token = fonnte_token || null;
      if (waha_url !== undefined)     patch.waha_url = waha_url ? String(waha_url).trim().replace(/\/+$/, '') : null;
      if (waha_api_key !== undefined) patch.waha_api_key = waha_api_key || null;
      if (waha_session !== undefined) patch.waha_session = String(waha_session || '').trim() || 'default';
      await WaSession.update(patch, { where: { session_id } });
      GatewayService.invalidateSessionCache(session_id); // refresh cache provider/token
      const updated = await WaSession.findOne({ where: { session_id } });
      res.json({ success: true, data: updated });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async getQr(req, res) {
    try {
      const { session_id } = req.params;

      // No-cache — QR harus selalu fresh, jangan di-cache browser (fix HTTP 304)
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');

      // ── Provider WAHA: ambil QR / status langsung dari API WAHA ──
      const sessRow = await WaSession.findOne({ where: { session_id } });
      if (sessRow && sessRow.provider === 'waha') {
        try {
          const info = await WahaService.getSessionInfo(sessRow);
          const st = WahaService.mapStatus(info.status);
          if (st === 'connected') {
            // Sinkron status + nomor WA ke DB, lalu beri sinyal 'connected'
            // (frontend pollQr akan menutup panel QR & buka chat).
            const patch = { status: 'connected', qr_code: null, last_seen: new Date() };
            const meId = info.me && info.me.id ? String(info.me.id) : '';
            if (meId) patch.phone_number = WahaService.normalizeNumber(meId.split('@')[0].split(':')[0]);
            await WaSession.update(patch, { where: { session_id } });
            GatewayService.invalidateSessionCache(session_id);
            return res.json({ success: true, data: { qr_image: null, status: 'connected' } });
          }
          if (st === 'connecting') {
            const qrImage = await WahaService.getQrImage(sessRow); // null saat masih STARTING
            const raw = String(info.status || '').toUpperCase();
            return res.json({ success: true, data: {
              qr_image: qrImage, status: 'connecting', age: 0,
              // 'STARTING' = QR belum siap (WAHA sedang buka WhatsApp Web ~5-15s);
              // 'SCAN_QR_CODE' = QR sudah bisa ditampilkan.
              sub_status: raw,
              qr_pending: !qrImage && raw === 'STARTING',
            } });
          }
          return res.json({ success: true, data: { qr_image: null, status: 'disconnected' } });
        } catch (e) {
          return res.json({ success: true, data: { qr_image: null, status: sessRow.status || 'disconnected', error: e.message } });
        }
      }

      // Cek memory store dulu — paling fresh, langsung dari Baileys
      const memQr = WAService.qrStore.get(session_id);
      if (memQr?.image) {
        const age = Date.now() - memQr.ts;
        // Hanya kirim QR jika masih fresh (< 25 detik)
        if (age < 25000) {
          return res.json({ success: true, data: { qr_image: memQr.image, status: 'connecting', age } });
        }
        // QR sudah expired, tunggu Baileys generate yang baru
        return res.json({ success: true, data: { qr_image: null, status: 'connecting', age } });
      }

      // Fallback ke DB
      const session = await WaSession.findOne({ where: { session_id }, attributes: ['qr_code', 'status'] });
      if (!session) return res.status(404).json({ success: false, message: 'Session tidak ditemukan' });

      // Belum di-connect — tidak ada QR
      if (!session.qr_code) {
        return res.json({ success: true, data: { qr_image: null, status: session.status } });
      }

      let qrImage = null;
      try {
        const QRCodeLib = require('qrcode');
        qrImage = await QRCodeLib.toDataURL(session.qr_code, { width: 300, margin: 2, errorCorrectionLevel: 'M' });
      } catch (e) { /* ignore */ }

      res.json({ success: true, data: { qr_image: qrImage, status: session.status } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── MESSAGES ──────────────────────────────────────────────
  async getMessages(req, res) {
    try {
      const { session_id, direction, search, page = 1, limit = 30 } = req.query;
      const where = {};
      if (session_id) where.session_id = session_id;
      if (direction)  where.direction  = direction;
      if (search) {
        where[Op.or] = [
          { from_number: { [Op.like]: `%${search}%` } },
          { to_number:   { [Op.like]: `%${search}%` } },
          { message:     { [Op.like]: `%${search}%` } }
        ];
      }
      const offset = (page - 1) * limit;
      const { count, rows } = await WaMessage.findAndCountAll({
        where,
        include: [{
          model: Customer, as: 'customer',
          attributes: ['id', 'name', 'customer_id', 'phone', 'email', 'address', 'status', 'package_id'],
          required: false,
          include: [{ model: require('../models').Package, as: 'package', attributes: ['id', 'name', 'speed_down', 'speed_up', 'price'], required: false }]
        }],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset
      });
      res.json({ success: true, data: rows, total: count, page: parseInt(page) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async sendMessage(req, res) {
    try {
      const { session_id, to, message, reply_to, reply_to_text, reply_to_from_me } = req.body;
      if (!session_id || !to || !message) {
        return res.status(400).json({ success: false, message: 'session_id, to, message wajib diisi' });
      }
      await GatewayService.warmSession(session_id);
      if (!GatewayService.isConnected(session_id)) {
        return res.status(400).json({ success: false, message: 'Session tidak terhubung' });
      }
      const io = req.app.get('io');
      const opts = reply_to ? {
        replyToId: String(reply_to),
        replyToText: reply_to_text ? String(reply_to_text).slice(0, 490) : null,
        replyToFromMe: reply_to_from_me === true || reply_to_from_me === 'true',
      } : undefined;
      const result = await GatewayService.sendMessage(session_id, to, message, io, opts);
      res.json({ success: true, data: result, message: 'Pesan terkirim' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── HAPUS PESAN ──────────────────────────────────────────
  // scope 'me'       → hapus dari riwayat CRM saja (baris DB dihapus)
  // scope 'everyone' → tarik pesan di WhatsApp (hanya pesan KELUAR milik kita,
  //                    dlm jendela waktu WhatsApp ±2 hari) + tandai di DB
  async deleteMessage(req, res) {
    try {
      const { message_id, scope } = req.body; // message_id = ID baris DB
      if (!message_id) return res.status(400).json({ success: false, message: 'message_id wajib' });

      const row = await WaMessage.findOne({ where: { id: message_id } });
      if (!row) return res.status(404).json({ success: false, message: 'Pesan tidak ditemukan' });

      if (scope === 'everyone') {
        if (row.direction !== 'outbound') {
          return res.status(400).json({ success: false, message: 'Hanya pesan keluar yang bisa dihapus untuk semua' });
        }
        const rawId = String(row.wa_message_id || '').split('|')[0];
        if (!rawId) {
          return res.status(400).json({ success: false, message: 'Pesan ini tidak punya ID WhatsApp (tidak bisa ditarik)' });
        }
        // Penarikan di WhatsApp bersifat BEST-EFFORT. Engine WEBJS kerap melempar
        // 500 utk pesan lama / di luar jendela tarik ±2 hari / ID tak ter-resolve
        // di store WA Web (isu umum WAHA WEBJS). Kalau gagal, JANGAN gagalkan total:
        // tetap tandai terhapus di riwayat CRM dan beri tahu user dgn jelas bahwa
        // penarikan di sisi WhatsApp tidak berhasil.
        let recalled = true;
        let recallNote = '';
        try {
          await GatewayService.deleteMessage(row.session_id, row.to_number, rawId);
        } catch (delErr) {
          recalled = false;
          recallNote = delErr && delErr.message ? delErr.message : String(delErr);
          logger.warn('[WA] Tarik pesan di WhatsApp gagal (id=' + message_id + '): ' + recallNote);
        }
        // Tandai terhapus di riwayat CRM baik berhasil maupun tidak (user memang
        // ingin pesan ini hilang dari tampilan).
        await row.update({ message: '⊘ Pesan telah dihapus', media_url: null, message_type: 'text', reply_to_id: null, reply_to_text: null });
        if (recalled) {
          return res.json({ success: true, message: 'Pesan ditarik untuk semua' });
        }
        return res.json({
          success: true,
          partial: true,
          message: 'Pesan dihapus dari riwayat. Penarikan di WhatsApp penerima tidak berhasil ' +
            '(pesan mungkin sudah terlalu lama atau di luar batas waktu tarik WhatsApp).'
        });
      }

      // scope 'me' (default): hapus baris dari riwayat CRM
      await row.destroy();
      res.json({ success: true, message: 'Pesan dihapus dari riwayat' });
    } catch (e) {
      logger.error('[WA] deleteMessage error: ' + e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Send media (image/video/audio/document via multipart upload) ──
  async sendMedia(req, res) {
    try {
      const { session_id, to, caption } = req.body;
      if (!session_id || !to) {
        return res.status(400).json({ success: false, message: 'session_id dan to wajib diisi' });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'File tidak ada' });
      }
      await GatewayService.warmSession(session_id);
      if (!GatewayService.isConnected(session_id)) {
        return res.status(400).json({ success: false, message: 'Session tidak terhubung' });
      }
      const mime = req.file.mimetype || 'application/octet-stream';
      let mediaType = 'document';
      if (mime.startsWith('image/'))      mediaType = 'image';
      else if (mime.startsWith('video/')) mediaType = 'video';
      else if (mime.startsWith('audio/')) mediaType = 'audio';

      const io = req.app.get('io');
      const result = await GatewayService.sendMedia(session_id, {
        to,
        mediaPath: req.file.path,
        mediaType,
        caption: caption || '',
        mimeType: mime,
        fileName: req.file.originalname
      }, io);

      res.json({ success: true, data: result, message: 'Media terkirim' });
    } catch (e) {
      logger.error('[WA] sendMedia controller error: ' + e.message);
      // Cleanup file upload kalau gagal
      try { if (req.file?.path) require('fs').unlinkSync(req.file.path); } catch(_) {}
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async sendBroadcast(req, res) {
    try {
      const { session_id, numbers, message, template_id } = req.body;
      if (!session_id || !numbers?.length || (!message && !template_id)) {
        return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
      }
      await GatewayService.warmSession(session_id);
      if (!GatewayService.isConnected(session_id)) {
        return res.status(400).json({ success: false, message: 'Session tidak terhubung' });
      }
      let finalMessage = message;
      if (template_id && !message) {
        const tmpl = await WaTemplate.findByPk(template_id);
        if (!tmpl) return res.status(404).json({ success: false, message: 'Template tidak ditemukan' });
        finalMessage = tmpl.message;
        await tmpl.increment('usage_count');
      }
      const io = req.app.get('io');
      // Jalankan broadcast di background
      GatewayService.sendBroadcast(session_id, numbers, finalMessage, io)
        .then(result => {
          logger.info(`Broadcast selesai [${session_id}]: ${result.success} sukses, ${result.failed} gagal`);
          if (io) io.emit(`wa:broadcast_done:${session_id}`, result);
        })
        .catch(e => logger.error('Broadcast error:', e.message));
      res.json({ success: true, message: `Broadcast dimulai ke ${numbers.length} nomor` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── KIRIM REMINDER INVOICE (dipanggil dari cron / manual) ──
  async sendInvoiceReminders(req, res) {
    try {
      const { session_id, days_before = 3 } = req.body;
      if (!session_id) return res.status(400).json({ success: false, message: 'session_id wajib' });
      await GatewayService.warmSession(session_id);
      if (!GatewayService.isConnected(session_id)) {
        return res.status(400).json({ success: false, message: 'Session tidak terhubung' });
      }
      const io = req.app.get('io');
      // Jalankan di BACKGROUND — dengan throttle anti-ban (jeda acak antar
      // pesan), pengiriman puluhan reminder bisa makan beberapa menit dan
      // akan timeout kalau ditunggu di request HTTP.
      _sendInvoiceReminders(session_id, parseInt(days_before), io)
        .then(result => {
          logger.info('[WA] Reminder selesai [' + session_id + ']: ' + result.message);
          if (io) io.emit('wa:reminders:done:' + session_id, result);
        })
        .catch(e => logger.error('[WA] Reminder error: ' + e.message));
      res.json({ success: true, message: 'Reminder diproses di background dengan jeda anti-banned. Pantau hasil di log pesan.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── AUTO REPLY ─────────────────────────────────────────────
  async getAutoReplies(req, res) {
    try {
      const { session_id } = req.params;
      const rules = await WaAutoReply.findAll({ where: { session_id }, order: [['created_at', 'ASC']] });
      res.json({ success: true, data: rules });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async createAutoReply(req, res) {
    try {
      const { session_id } = req.params;
      const { keyword, match_type, reply_message, is_active } = req.body;
      if (!keyword || !reply_message) {
        return res.status(400).json({ success: false, message: 'keyword dan reply_message wajib' });
      }
      const rule = await WaAutoReply.create({ session_id, keyword, match_type, reply_message, is_active });
      res.status(201).json({ success: true, data: rule });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async updateAutoReply(req, res) {
    try {
      const { id } = req.params;
      await WaAutoReply.update(req.body, { where: { id } });
      const updated = await WaAutoReply.findByPk(id);
      res.json({ success: true, data: updated });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async deleteAutoReply(req, res) {
    try {
      await WaAutoReply.destroy({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Auto reply dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── TEMPLATES ─────────────────────────────────────────────
  async getTemplates(req, res) {
    try {
      const templates = await WaTemplate.findAll({ order: [['category', 'ASC'], ['name', 'ASC']] });
      res.json({ success: true, data: templates });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async createTemplate(req, res) {
    try {
      const { name, category, message, variables } = req.body;
      if (!name || !message) return res.status(400).json({ success: false, message: 'name dan message wajib' });
      const tmpl = await WaTemplate.create({ name, category, message, variables });
      res.status(201).json({ success: true, data: tmpl });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async updateTemplate(req, res) {
    try {
      await WaTemplate.update(req.body, { where: { id: req.params.id } });
      const updated = await WaTemplate.findByPk(req.params.id);
      res.json({ success: true, data: updated });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }

  async deleteTemplate(req, res) {
    try {
      await WaTemplate.destroy({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Template dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── GET CONVERSATIONS (1 pesan terakhir per kontak, untuk sidebar) ──
  async getConversations(req, res) {
    try {
      const { session_id } = req.query;
      if (!session_id) return res.status(400).json({ success: false, message: 'session_id required' });

      const { Package } = require('../models');

      // Ambil session untuk tahu nomor kita sendiri
      const session = await WaSession.findOne({ where: { session_id } });
      const myPhone = session?.phone_number ? session.phone_number.replace(/[^0-9]/g, '') : null;

      // Ambil semua pesan
      const { rows } = await WaMessage.findAndCountAll({
        where: { session_id },
        include: [{
          model: Customer, as: 'customer',
          attributes: ['id', 'name', 'customer_id', 'phone', 'email', 'address', 'status', 'package_id'],
          required: false,
          include: [{ model: Package, as: 'package', attributes: ['id','name','speed_down','speed_up','price'], required: false }]
        }],
        order: [['created_at', 'DESC']],
        limit: 2000
      });

      // ── Kumpulkan nomor milik kita dari from_number pesan outbound ──
      const myNumbers = new Set();
      if (myPhone) {
        myNumbers.add(myPhone);
        myNumbers.add(myPhone.slice(-9));
        if (myPhone.startsWith('62')) myNumbers.add('0' + myPhone.slice(2));
      }
      rows.forEach(m => {
        if (m.direction === 'outbound' && m.from_number) {
          const n = m.from_number.replace(/[^0-9]/g, '');
          myNumbers.add(n);
          myNumbers.add(n.slice(-9));
          if (n.startsWith('62')) myNumbers.add('0' + n.slice(2));
        }
      });

      // ── Fetch semua customer, buat phone index (last-9 -> customer) ──
      const allCustomers = await Customer.findAll({
        attributes: ['id', 'name', 'customer_id', 'phone', 'email', 'address', 'status', 'package_id'],
        include: [{ model: Package, as: 'package', attributes: ['id','name','speed_down','speed_up','price'], required: false }]
      });
      const phoneIndex = {};
      allCustomers.forEach(c => {
        if (!c.phone) return;
        const n = c.phone.replace(/[^0-9]/g, '');
        if (n.length >= 9) phoneIndex[n.slice(-9)] = c;
      });

      // ── Filter & enrich pesan ──
      const filtered = [];
      rows.forEach(m => {
        const contactRaw = (m.direction === 'inbound' ? m.from_number : m.to_number) || '';
        const contactNum = contactRaw.replace(/[^0-9]/g, '');
        const contactLast9 = contactNum.slice(-9);

        // Skip jika nomor kontak = nomor kita sendiri
        if (myNumbers.has(contactNum) || myNumbers.has(contactLast9)) return;

        // Enrich customer jika belum ada
        if (!m.customer_id && !m.dataValues.customer && contactLast9.length >= 7) {
          const found = phoneIndex[contactLast9];
          if (found) m.dataValues.customer = found;
        }

        filtered.push(m);
      });

      res.json({ success: true, data: filtered, total: filtered.length });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── LINK CONTACT ─────────────────────────────────────────
  // Hubungkan nomor LID ke customer dan update semua pesan dari nomor itu
  async linkContact(req, res) {
    try {
      const { from_number, real_phone, customer_id } = req.body;
      if (!from_number || !real_phone) {
        return res.status(400).json({ success: false, message: 'from_number dan real_phone wajib' });
      }
      const { WaMessage, Customer } = require('../models');
      const { Op } = require('sequelize');

      // Cari customer berdasarkan phone atau customer_id
      let customer = null;
      let phone62 = real_phone.replace(/[^0-9]/g, '');
      if (phone62.startsWith('0')) phone62 = '62' + phone62.slice(1);

      if (customer_id) {
        customer = await Customer.findOne({ where: { id: customer_id } });
        // Update phone customer jika berbeda
        if (customer && customer.phone !== phone62) {
          await customer.update({ phone: phone62 });
        }
      } else {
        // Cari customer berdasarkan berbagai format nomor
        const last9 = phone62.slice(-9);
        const last10 = phone62.slice(-10);
        customer = await Customer.findOne({
          where: {
            [Op.or]: [
              { phone: phone62 },
              { phone: '0' + last9 },
              { phone: { [Op.like]: '%' + last9 } },
              { phone: { [Op.like]: '%' + last10 } }
            ]
          }
        });
        if (customer) {
          // Update phone ke format 62xxx jika berbeda
          if (customer.phone !== phone62) {
            await customer.update({ phone: phone62 });
          }
        }
        logger.info('[WA LinkContact] Customer search result: ' + (customer ? customer.name + ' id=' + customer.id : 'not found') + ' for phone=' + phone62);
      }

      // Debug log
      logger.info('[WA LinkContact] from=' + from_number + ' phone62=' + phone62 + ' customer=' + (customer?.id || 'null'));

      // Update semua pesan dari nomor LID ini ke nomor asli
      // Juga update pesan yang mungkin sudah punya phone62 sebagai from_number
      const [updatedCount] = await WaMessage.update(
        {
          from_number: phone62,
          customer_id: customer?.id || null
        },
        {
          where: {
            from_number: [from_number, phone62],  // handle keduanya
            direction: 'inbound'
          }
        }
      );
      logger.info('[WA LinkContact] Updated ' + updatedCount + ' inbound messages');

      // Update juga pesan outbound yang to_number-nya pakai nomor lama
      const [updatedOutbound] = await WaMessage.update(
        {
          to_number: phone62,
          customer_id: customer?.id || null
        },
        {
          where: {
            to_number: [from_number, phone62],
            direction: 'outbound'
          }
        }
      );
      logger.info('[WA LinkContact] Updated ' + updatedOutbound + ' outbound messages');

      // Fetch customer lengkap dengan package
      let fullCustomer = null;
      if (customer) {
        const { Package } = require('../models');
        fullCustomer = await customer.reload({
          include: [{ model: Package, as: 'package', attributes: ['id','name','speed_down','speed_up','price'], required: false }]
        });
      }

      res.json({
        success: true,
        message: `${updatedCount} pesan diperbarui ke nomor ${phone62}`,
        customer: fullCustomer ? fullCustomer.toJSON() : null,
        updated: updatedCount
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // Search customer by name or phone
  async searchCustomer(req, res) {
    try {
      const { q } = req.query;
      if (!q || q.length < 2) return res.json({ success: true, data: [] });
      const { Customer, Package } = require('../models');
      const { Op } = require('sequelize');
      const results = await Customer.findAll({
        where: {
          [Op.or]: [
            { name: { [Op.like]: `%${q}%` } },
            { phone: { [Op.like]: `%${q}%` } },
            { customer_id: { [Op.like]: `%${q}%` } }
          ]
        },
        include: [{ model: Package, as: 'package', attributes: ['name'], required: false }],
        limit: 10,
        order: [['name', 'ASC']]
      });
      res.json({ success: true, data: results });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── SYNC STATUS ───────────────────────────────────────────
  async syncStatus(req, res) {
    try {
      const sessions = await WaSession.findAll();
      for (const s of sessions) {
        if (s.provider === 'fonnte') {
          // Fonnte: verifikasi nyata via API & update kolom status
          await GatewayService.verifyFonnteConnection(s.session_id).catch(() => {});
          continue;
        }
        if (s.provider === 'waha') {
          // WAHA: verifikasi nyata via API WAHA & update kolom status
          await GatewayService.verifyWahaConnection(s.session_id).catch(() => {});
          continue;
        }
        const runtime = WAService.getSessionStatus(s.session_id);
        if (s.status !== runtime) {
          await WaSession.update({ status: runtime }, { where: { session_id: s.session_id } });
        }
      }
      res.json({ success: true, message: 'Status session disinkronkan' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── STATS ─────────────────────────────────────────────────
  // ── GET PROFILE PICTURE ──────────────────────────────────
  async getProfilePicture(req, res) {
    try {
      const { session_id, number } = req.query;
      if (!session_id || !number) return res.status(400).json({ success: false, message: 'session_id dan number wajib' });
      const url = await GatewayService.getProfilePicture(session_id, number);
      res.json({ success: true, url: url || null });
    } catch(e) { res.json({ success: true, url: null }); }
  }

  // ── Proxy gambar foto profil (stream via backend) ──
  // Menghindari kegagalan <img> saat memuat URL CDN WhatsApp langsung
  // (kadaluarsa/CORS). Frontend cukup pakai src=/wa/profile-picture-img?...
  async getProfilePictureImg(req, res) {
    try {
      const { session_id, number } = req.query;
      if (!session_id || !number) return res.status(400).end();
      const img = await GatewayService.getProfilePictureImage(session_id, number);
      if (!img || !img.buffer) {
        logger.info('[WA] Foto profil img: tidak ada gambar utk ' + number + ' (session ' + session_id + ')');
        return res.status(404).end();
      }
      res.set('Content-Type', img.contentType || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=21600'); // 6 jam
      return res.end(img.buffer);
    } catch (e) {
      logger.warn('[WA] Foto profil img error: ' + (e.message || e));
      return res.status(404).end();
    }
  }

  // ── DEBUG: diagnosa foto profil (lihat apa yg WAHA kembalikan) ──
  // GET /wa/profile-picture-debug?session_id=..&number=628xxxx
  // Mengembalikan JSON: url yg didapat dari WAHA + hasil coba proxy fetch.
  async getProfilePictureDebug(req, res) {
    try {
      const { session_id, number } = req.query;
      if (!session_id || !number) return res.status(400).json({ success: false, message: 'session_id & number wajib' });
      const out = { session_id, number };
      try {
        out.url = await GatewayService.getProfilePicture(session_id, number);
      } catch (e) { out.url_error = e.message; }
      try {
        const img = await GatewayService.getProfilePictureImage(session_id, number);
        out.proxy_ok = !!(img && img.buffer);
        out.proxy_bytes = img && img.buffer ? img.buffer.length : 0;
        out.proxy_content_type = img ? img.contentType : null;
      } catch (e) { out.proxy_error = e.message; }
      return res.json({ success: true, data: out });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── DEBUG: lihat raw from_number/to_number semua pesan ──
  async debugMessages(req, res) {
    try {
      const { session_id } = req.query;
      const where = session_id ? { session_id } : {};
      const rows = await WaMessage.findAll({
        where,
        attributes: ['id','session_id','direction','from_number','to_number','message','customer_id','created_at'],
        order: [['created_at','DESC']],
        limit: 50
      });
      res.json({ success: true, data: rows });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── DELETE CONVERSATION (hapus semua pesan dari 1 kontak) ──
  async deleteConversation(req, res) {
    try {
      const { session_id, contact_number } = req.body;
      if (!session_id || !contact_number) {
        return res.status(400).json({ success: false, message: 'session_id dan contact_number wajib' });
      }
      const { Op } = require('sequelize');
      const clean = contact_number.replace(/[^0-9]/g, '');
      if (clean.length < 8) {
        return res.status(400).json({ success: false, message: 'Nomor kontak tidak valid (terlalu pendek)' });
      }
      // Cocokkan nomor SEUTUHNYA, bukan cuma 9 digit terakhir. Match by suffix
      // 9-digit lama BERISIKO: dua nomor berbeda yg 9 digit akhirnya sama (atau
      // nomor LID) bisa ikut terhapus. Untuk operasi destruktif, pakai varian
      // nomor yg spesifik: bentuk ternormalisasi (628xx) + variasi lokal (08xx).
      const norm = WahaService.normalizeNumber(clean);  // 628xxxxxxxxx
      const variants = new Set([clean, norm]);
      if (norm.startsWith('62')) variants.add('0' + norm.slice(2)); // 08xxxxxxxxx
      // Cocokkan nomor yg TERSIMPAN mungkin punya suffix @c.us / @lid, jadi pakai
      // pola exact-atau-diikuti-'@' untuk tiap varian.
      const numOr = [];
      for (const v of variants) {
        if (!v) continue;
        numOr.push({ [Op.eq]: v });
        numOr.push({ [Op.like]: v + '@%' });
      }
      // Hapus pesan inbound (from_number match) dan outbound (to_number match)
      const deleted = await WaMessage.destroy({
        where: {
          session_id,
          [Op.or]: [
            { from_number: { [Op.or]: numOr }, direction: 'inbound' },
            { to_number:   { [Op.or]: numOr }, direction: 'outbound' }
          ]
        }
      });
      logger.info('[WA] deleteConversation: ' + deleted + ' messages deleted for ' + clean + ' session=' + session_id);
      res.json({ success: true, message: deleted + ' pesan dihapus', deleted });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async getStats(req, res) {
    try {
      const totalSessions   = await WaSession.count();
      const connectedSessions = await WaSession.count({ where: { status: 'connected' } });
      const todayMessages   = await WaMessage.count({
        where: { created_at: { [Op.gte]: moment().startOf('day').toDate() } }
      });
      const totalSent       = await WaMessage.count({ where: { direction: 'outbound' } });
      const totalReceived   = await WaMessage.count({ where: { direction: 'inbound' } });
      res.json({ success: true, data: { totalSessions, connectedSessions, todayMessages, totalSent, totalReceived } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }
}

// ── Helper: kirim reminder invoice (dipakai controller + cron) ──
async function _sendInvoiceReminders(session_id, daysBefore, io) {
  const targetDate = moment().add(daysBefore, 'days').format('YYYY-MM-DD');
  const overdueDate = moment().format('YYYY-MM-DD');

  // Ambil invoice yang akan jatuh tempo + sudah overdue
  const invoices = await Invoice.findAll({
    where: {
      status: { [Op.in]: ['unpaid', 'overdue'] },
      [Op.or]: [
        { due_date: targetDate },
        { due_date: { [Op.lt]: overdueDate }, status: 'overdue' }
      ]
    },
    include: [{
      model: Customer,
      as: 'customer',
      where: { phone: { [Op.not]: null } },
      required: true
    }]
  });

  // Ambil template reminder per-invoice sesuai status (overdue vs due).
  // Placeholder yang didukung: {nama} {invoice} {paket} {periode} {jumlah} {jatuh_tempo} {status} {perusahaan}
  const tplOverdue = await WaTemplate.findOne({ where: { category: 'reminder_overdue', is_active: true }, order: [['updated_at','DESC']] });
  const tplDue     = await WaTemplate.findOne({ where: { category: 'reminder_due',     is_active: true }, order: [['updated_at','DESC']] });
  const companyName = await getCompanyName();
  const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  let sent = 0, skipped = 0;

  for (const inv of invoices) {
    const c   = inv.customer;
    const tpl = inv.status === 'overdue' ? tplOverdue : tplDue;
    const periodeStr = inv.period_month
      ? (MONTHS[inv.period_month] || inv.period_month) + ' ' + (inv.period_year || '')
      : '';
    const jumlahStr = `Rp ${Number(inv.total).toLocaleString('id-ID')}`;
    const jatuhTempoStr = moment(inv.due_date).format('DD MMMM YYYY');

    let msg;
    if (tpl && (tpl.content || tpl.message)) {
      const raw = tpl.content || tpl.message;
      const vars = {
        '{nama}':             c.name || '',
        '{invoice}':          inv.invoice_number || '',
        '{paket}':            c.package?.name || '–',
        '{periode}':          periodeStr,
        '{jumlah}':           jumlahStr,
        '{jatuh_tempo}':      jatuhTempoStr,
        '{tgl_jatuh_tempo}':  jatuhTempoStr,  // alias
        '{status}':           inv.status === 'overdue' ? '⚠️ JATUH TEMPO' : 'segera jatuh tempo',
        '{perusahaan}':       companyName,
        '{nohp}':             c.phone || '',
        '{phone}':            c.phone || ''   // alias backward-compat
      };
      msg = Object.keys(vars).reduce((acc, k) => acc.split(k).join(vars[k]), raw);
      tpl.update({ usage_count: (tpl.usage_count || 0) + 1 }).catch(()=>{});
    } else {
      msg = `Halo *${c.name}*, tagihan internet Anda *${inv.invoice_number}* senilai *${jumlahStr}* ${inv.status === 'overdue' ? 'sudah jatuh tempo' : `jatuh tempo ${jatuhTempoStr}`}. Mohon segera lakukan pembayaran. Terima kasih. — ${companyName}`;
    }

    try {
      // Jeda antar pesan diatur TERPUSAT oleh throttle GatewayService
      // (jeda acak 2.5-7 dtk + istirahat batch) — jangan tambah delay fix
      // di sini, pola fix justru terdeteksi robot oleh WhatsApp.
      await GatewayService.sendMessage(session_id, c.phone, msg, io);
      sent++;
    } catch (e) {
      logger.error(`WA reminder gagal ke ${c.phone}:`, e.message);
      skipped++;
    }
  }
  return { message: `Reminder terkirim: ${sent}, gagal: ${skipped}`, sent, skipped };
}

// Export helper untuk CronService
module.exports = { controller: new WAController(), sendInvoiceReminders: _sendInvoiceReminders };