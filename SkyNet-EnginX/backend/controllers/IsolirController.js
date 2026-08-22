const IsolirService = require('../services/IsolirService');
const { sequelize } = require('../models');

// Tentukan metode isolir dari data customer (selaras dengan IsolirService).
// Prioritas: connection_type eksplisit → fallback static_ip → pppoe.
function detectMethod(r) {
  const ct = (r.connection_type || '').toLowerCase();
  if (ct === 'hotspot' && (r.mac_address || r.static_ip)) return 'hotspot_binding';
  if (ct === 'pppoe'  && r.pppoe_username) return 'pppoe';
  if (ct === 'static' && r.static_ip)      return 'static';
  if (r.static_ip)      return 'static';
  if (r.pppoe_username) return 'pppoe';
  return 'unknown';
}

class IsolirController {

  async stats(req, res) {
    try {
      const [[isolated]]   = await sequelize.query("SELECT COUNT(*) AS cnt FROM customers WHERE isolir_status='isolated'");
      // "Eligible" = pelanggan yang bisa diisolir = punya static_ip ATAU pppoe_username + mikrotik_id
      const [[withIP]]     = await sequelize.query(
        `SELECT COUNT(*) AS cnt FROM customers
         WHERE status='active' AND mikrotik_id IS NOT NULL
           AND ( (static_ip IS NOT NULL AND static_ip!='')
              OR (pppoe_username IS NOT NULL AND pppoe_username!='')
              OR (connection_type='hotspot' AND mac_address IS NOT NULL AND mac_address!='') )`
      );
      // Devices: count dari devices (master), filter MikroTik router aktif yang punya extension isolir
      const [[devices]]    = await sequelize.query(
        `SELECT COUNT(*) AS total, SUM(md.status='online') AS online
         FROM mikrotik_devices md
         INNER JOIN devices d ON d.id = md.device_id
         WHERE d.is_active=1 AND d.type='router'`
      );
      const [[recentLog]]  = await sequelize.query("SELECT COUNT(*) AS cnt FROM isolir_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)");
      const [[autoEnabled]]= await sequelize.query("SELECT value FROM app_settings WHERE `key`='isolir_auto_enable'").catch(()=>[[{value:'0'}]]);
      res.json({ success: true, data: {
        isolated:    parseInt(isolated?.cnt||0),
        with_ip:     parseInt(withIP?.cnt||0),
        devices:     { total: parseInt(devices?.total||0), online: parseInt(devices?.online||0) },
        log_24h:     parseInt(recentLog?.cnt||0),
        auto_enabled: autoEnabled?.value === '1'
      }});
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  async listDevices(req, res) {
    try {
      // JOIN dengan devices (master) untuk dapatkan host/port/name/auth dari sana.
      // Field 'host', 'port', 'name' di-alias supaya tetap kompatibel dengan
      // frontend yang sudah ada (UI dev card pakai dev.host, dev.port, dev.name).
      const rows = await sequelize.query(
        `SELECT
            md.id            AS id,
            md.device_id     AS device_id,
            md.binary_port,
            md.wan_interface,
            md.isolir_page_url,
            md.notes,
            md.status,
            md.last_ping,
            d.name           AS name,
            d.ip_address     AS host,
            d.api_port       AS api_port,
            d.api_protocol   AS api_protocol,
            d.api_username   AS username,
            d.is_active      AS is_active,
            d.brand          AS brand,
            d.model          AS model,
            d.status         AS master_status
         FROM mikrotik_devices md
         INNER JOIN devices d ON d.id = md.device_id
         WHERE d.type='router'
         ORDER BY d.name`,
        { type: sequelize.QueryTypes.SELECT }
      );

      // Tambahkan derived 'port' untuk kompatibilitas UI: port yang ditampilkan
      // = port koneksi efektif (rest_port kalau REST, binary_port kalau native).
      rows.forEach(r => {
        const isRest = (r.api_protocol === 'rest-http' || r.api_protocol === 'rest-https');
        r.port = isRest ? r.api_port : r.binary_port;
        r.use_ssl = (r.api_protocol === 'rest-https' || r.api_protocol === 'api-ssl') ? 1 : 0;
        r.connection_type = isRest ? 'REST' : 'API Binary';
      });

      res.json({ success:true, data: rows });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // ── Daftar devices (router MikroTik) dari tabel devices yang bisa dipakai isolir
  // Filter:
  //   - type='router'
  //   - is_active=1
  //   - brand LIKE 'mikrotik%' OR name LIKE '%mikrotik%' (case-insensitive, handle NULL brand)
  // Default: hanya yang belum punya extension isolir (untuk dropdown tambah baru).
  // Query ?include=<id>: sertakan device yang sedang di-edit (untuk dropdown edit).
  async listAvailableDevices(req, res) {
    try {
      const includeId = parseInt(req.query.include) || null;
      // Filter MikroTik dilonggarkan:
      //   - LOWER(TRIM(brand)) LIKE 'mikrotik%' (handle whitespace/case)
      //   - OR LOWER(name) LIKE '%mikrotik%' (handle brand=NULL kalau nama mengandung "mikrotik")
      // Sequelize/MySQL `LIKE` di collation default case-insensitive,
      // tapi LOWER() + TRIM() jadi safety net untuk encoding/whitespace anomalies.
      const rows = await sequelize.query(
        `SELECT d.id, d.name, d.ip_address, d.api_port, d.api_protocol, d.api_username, d.brand, d.model,
                md.id AS existing_ext_id
         FROM devices d
         LEFT JOIN mikrotik_devices md ON md.device_id = d.id
         WHERE d.type='router'
           AND d.is_active=1
           AND (
                LOWER(TRIM(COALESCE(d.brand,''))) LIKE 'mikrotik%'
             OR LOWER(COALESCE(d.name,'')) LIKE '%mikrotik%'
           )
           AND (md.id IS NULL ${includeId ? "OR d.id = (SELECT device_id FROM mikrotik_devices WHERE id = ?)" : ""})
         ORDER BY d.name`,
        {
          replacements: includeId ? [includeId] : [],
          type: sequelize.QueryTypes.SELECT
        }
      );
      res.json({ success:true, data: rows });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // Save extension isolir (hanya field isolir-specific).
  // Auth (host/port/user/pass) di-manage di halaman /devices, bukan di sini.
  // Modal isolir hanya save: device_id (target), binary_port, wan_interface,
  // isolir_page_url, notes.
  async saveDevice(req, res) {
    try {
      const {
        id, device_id,
        binary_port = 8728,
        wan_interface = 'ether1',
        notes = '',
        isolir_page_url = null
      } = req.body;

      // Validasi: device_id wajib (referensi ke devices.id)
      const devId = parseInt(device_id);
      if (!devId) {
        return res.status(400).json({ success:false, message:'Pilih device dari halaman Device Management terlebih dahulu' });
      }

      // Pastikan devId valid: ada di devices, type=router, brand/name MikroTik, aktif
      const devCheck = await sequelize.query(
        `SELECT id, name, ip_address, is_active, type, brand
         FROM devices WHERE id=? LIMIT 1`,
        { replacements: [devId], type: sequelize.QueryTypes.SELECT }
      );
      const dev = devCheck[0];
      if (!dev) {
        return res.status(400).json({ success:false, message:'Device tidak ditemukan' });
      }
      if (dev.type !== 'router') {
        return res.status(400).json({ success:false, message:'Device terpilih bukan tipe router' });
      }
      // Filter MikroTik dilonggarkan: brand starts with 'mikrotik' (case-insensitive,
      // trimmed) OR name mengandung 'mikrotik'. Reject hanya kalau keduanya negatif.
      // Ini supaya device dengan brand=NULL tapi name "MIKROTIK GTA" tetap diizinkan.
      const brandNorm = String(dev.brand || '').trim().toLowerCase();
      const nameNorm  = String(dev.name  || '').trim().toLowerCase();
      const isMikroTik = brandNorm.startsWith('mikrotik') || nameNorm.includes('mikrotik');
      if (!isMikroTik) {
        return res.status(400).json({
          success: false,
          message: 'Device terpilih bukan MikroTik (brand="' + (dev.brand || 'NULL') + '", name="' + dev.name + '"). Set brand di /devices ke "MikroTik" atau ubah nama-nya.'
        });
      }
      if (dev.is_active != 1) {
        return res.status(400).json({ success:false, message:'Device terpilih tidak aktif (nonaktif di /devices)' });
      }

      const binPort = parseInt(binary_port) || 8728;
      const wan     = String(wan_interface || 'ether1').trim();
      const url     = isolir_page_url ? String(isolir_page_url).trim() : null;
      const ntext   = notes ? String(notes).trim() : null;

      // ── Validasi URL halaman isolir (kalau di-set per-device) ──
      // HTTPS tidak akan jalan di dst-nat. Tolak di server-side.
      if (url) {
        if (/^https:\/\//i.test(url)) {
          return res.status(400).json({
            success: false,
            message: 'URL halaman isolir per-device tidak boleh HTTPS. MikroTik dst-nat tidak bisa redirect ke HTTPS. Wajib pakai http:// dengan IP LAN. Contoh: http://192.168.1.100:3000/p/isolir'
          });
        }
        if (!/^https?:\/\//i.test(url)) {
          return res.status(400).json({
            success: false,
            message: 'URL halaman isolir harus diawali "http://". Contoh: http://192.168.1.100:3000/p/isolir'
          });
        }
      }

      if (id) {
        // UPDATE: pastikan extension ada, dan device_id tidak konflik dengan extension lain
        const conflict = await sequelize.query(
          'SELECT id FROM mikrotik_devices WHERE device_id=? AND id != ? LIMIT 1',
          { replacements: [devId, id], type: sequelize.QueryTypes.SELECT }
        );
        if (conflict.length > 0) {
          return res.status(400).json({ success:false, message:'Device ini sudah dipakai extension isolir lain (id=' + conflict[0].id + ')' });
        }
        await sequelize.query(
          `UPDATE mikrotik_devices
           SET device_id=?, binary_port=?, wan_interface=?, isolir_page_url=?, notes=?
           WHERE id=?`,
          { replacements: [devId, binPort, wan, url, ntext, id] }
        );
        return res.json({ success:true, message:'Extension isolir diperbarui' });
      } else {
        // INSERT baru — pastikan device_id belum dipakai (UNIQUE constraint).
        const existing = await sequelize.query(
          'SELECT id FROM mikrotik_devices WHERE device_id=? LIMIT 1',
          { replacements: [devId], type: sequelize.QueryTypes.SELECT }
        );
        if (existing.length > 0) {
          return res.status(400).json({
            success:false,
            message:'Device "' + dev.name + '" sudah punya extension isolir (id=' + existing[0].id + '). Edit extension yang sudah ada saja.'
          });
        }
        await sequelize.query(
          `INSERT INTO mikrotik_devices
           (device_id, binary_port, wan_interface, isolir_page_url, notes, status)
           VALUES (?, ?, ?, ?, ?, 'unknown')`,
          { replacements: [devId, binPort, wan, url, ntext] }
        );
        return res.json({ success:true, message:'Extension isolir ditambahkan untuk "' + dev.name + '"' });
      }
    } catch(e) {
      if (/Duplicate entry|uk_device_id/i.test(e.message || '')) {
        return res.status(400).json({ success:false, message:'Device ini sudah dipakai extension isolir lain' });
      }
      // Schema belum termigrasi — kolom legacy NOT NULL masih ada.
      // Coba auto-recover: jalankan ulang ensureSchema (membuat kolom legacy
      // NULLABLE) lalu retry INSERT sekali. Kalau masih gagal, baru kasih
      // pesan ke user.
      if (/cannot be null|doesn't have a default value/i.test(e.message || '')) {
        try {
          await IsolirService.ensureSchema();
          // Re-derive nilai dari req.body (variabel const di blok try tidak
          // terlihat di blok catch). Sudah lewat validasi di atas.
          const rDevId   = parseInt(req.body.device_id);
          const rBinPort = parseInt(req.body.binary_port) || 8728;
          const rWan     = String(req.body.wan_interface || 'ether1').trim();
          const rUrl     = req.body.isolir_page_url ? String(req.body.isolir_page_url).trim() : null;
          const rNotes   = req.body.notes ? String(req.body.notes).trim() : null;
          // Retry INSERT extension baru
          await sequelize.query(
            `INSERT INTO mikrotik_devices
             (device_id, binary_port, wan_interface, isolir_page_url, notes, status)
             VALUES (?, ?, ?, ?, ?, 'unknown')`,
            { replacements: [rDevId, rBinPort, rWan, rUrl, rNotes] }
          );
          return res.json({ success:true, message:'Extension isolir ditambahkan' });
        } catch (e2) {
          if (/Duplicate entry|uk_device_id/i.test(e2.message || '')) {
            return res.status(400).json({ success:false, message:'Device ini sudah dipakai extension isolir lain' });
          }
          return res.status(500).json({
            success: false,
            message: 'Migrasi skema isolir belum selesai. Tunggu 5-10 detik dan coba lagi. Kalau persisten, restart PM2 dan cek log untuk pesan [IsolirService] migrate...'
          });
        }
      }
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // Hapus extension isolir (devices tetap di /devices).
  // Customer mapping di-clear, bypass-router cleanup.
  async deleteDevice(req, res) {
    try {
      // Clear FK customer (isolir_logs tetap, hanya soft-decouple)
      await sequelize.query("UPDATE customers SET mikrotik_id=NULL WHERE mikrotik_id=?", { replacements: [req.params.id] });
      // Cleanup bypass per-router (cascade manual karena tidak ada FK constraint)
      await sequelize.query("DELETE FROM isolir_bypass_router WHERE device_id=?", { replacements: [req.params.id] }).catch(()=>{});
      // Hapus extension row
      await sequelize.query("DELETE FROM mikrotik_devices WHERE id=?", { replacements: [req.params.id] });
      res.json({ success:true, message:'Extension isolir dihapus. Device di /devices tetap ada.' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  async testConnection(req, res) {
    try {
      const result = await IsolirService.testConnection(req.params.id);
      res.json({ success:true, ...result });
    } catch(e) { res.json({ success:false, message:e.message }); }
  }

  async setupFirewall(req, res) {
    try {
      const result = await IsolirService.setupFirewall(req.params.id);
      res.json(result);
    } catch(e) { res.json({ success:false, message:e.message }); }
  }

  async listIsolated(req, res) {
    try {
      const rows = await sequelize.query(
        `SELECT c.id, c.customer_id, c.name, c.static_ip, c.pppoe_username,
                c.connection_type, c.mac_address,
                c.isolir_status, c.isolir_at,
                c.phone, c.mikrotik_id, c.billing_date, c.installation_date,
                d.name AS router_name, d.ip_address AS router_host,
                pkg.name AS package_name,
                -- ambil due_date terbaru dari semua invoice (apapun status)
                (SELECT MAX(due_date) FROM invoices WHERE customer_id=c.id) AS last_due
         FROM customers c
         LEFT JOIN mikrotik_devices md ON md.id=c.mikrotik_id
         LEFT JOIN devices d           ON d.id = md.device_id
         LEFT JOIN packages pkg        ON pkg.id=c.package_id
         WHERE c.isolir_status IN ('isolated','restoring')
         ORDER BY c.isolir_at DESC`,
        { type: sequelize.QueryTypes.SELECT }
      );
      // Tag method per row (hotspot_binding / static / pppoe) — untuk badge di UI
      rows.forEach(r => { r.isolir_method = detectMethod(r); });
      res.json({ success:true, data: rows });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  async listEligible(req, res) {
    try {
      // Include customer dengan static_ip ATAU pppoe_username ATAU hotspot(mac)
      const rows = await sequelize.query(
        `SELECT c.id, c.customer_id, c.name, c.static_ip, c.pppoe_username,
                c.connection_type, c.mac_address,
                c.isolir_status, c.mikrotik_id,
                c.billing_date, c.installation_date, pkg.name AS package_name,
                (SELECT MAX(due_date) FROM invoices WHERE customer_id=c.id) AS last_due,
                (SELECT status FROM invoices WHERE customer_id=c.id ORDER BY due_date DESC LIMIT 1) AS last_inv_status
         FROM customers c
         LEFT JOIN packages pkg ON pkg.id=c.package_id
         WHERE (c.static_ip IS NOT NULL AND c.static_ip != '')
            OR (c.pppoe_username IS NOT NULL AND c.pppoe_username != '')
            OR (c.connection_type='hotspot' AND c.mac_address IS NOT NULL AND c.mac_address != '')
         ORDER BY c.name ASC`,
        { type: sequelize.QueryTypes.SELECT }
      );
      rows.forEach(r => { r.isolir_method = detectMethod(r); });
      res.json({ success:true, data: rows });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // ── Daftar pelanggan akan & sudah jatuh tempo ────────────────
  // Untuk panel "Aksi Manual" — bantu admin isolir/restore tanpa harus tahu siapa yang overdue
  async dueAlerts(req, res) {
    try {
      // Ambil grace days untuk highlight "sudah lewat grace period"
      const graceRow = await sequelize.query(
        "SELECT value FROM app_settings WHERE `key`='isolir_grace_days'",
        { type: sequelize.QueryTypes.SELECT }
      ).catch(() => []);
      const graceDays = parseInt(graceRow[0]?.value || '0');

      // Customer yang punya invoice unpaid/overdue dengan due_date dalam 7 hari ke depan
      // ATAU due_date sudah lewat (overdue). Eligible untuk isolir = punya (static_ip ATAU pppoe_username) + mikrotik_id
      const customers = await sequelize.query(
        `SELECT
            c.id, c.customer_id, c.name, c.phone, c.static_ip, c.pppoe_username,
            c.connection_type, c.mac_address,
            c.isolir_status, c.status, c.mikrotik_id,
            c.billing_date, c.installation_date,
            pkg.name AS package_name, pkg.price AS package_price,
            d.name AS router_name,
            i.id AS invoice_id, i.invoice_number, i.due_date, i.status AS invoice_status,
            i.amount AS invoice_amount,
            DATEDIFF(CURDATE(), i.due_date) AS days_overdue
         FROM customers c
         LEFT JOIN packages pkg          ON pkg.id = c.package_id
         LEFT JOIN mikrotik_devices md   ON md.id  = c.mikrotik_id
         LEFT JOIN devices d             ON d.id   = md.device_id
         INNER JOIN invoices i           ON i.customer_id = c.id
         WHERE i.status IN ('unpaid','overdue')
           AND DATE(i.due_date) <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
           AND c.status != 'inactive'
         ORDER BY i.due_date ASC, c.name ASC`,
        { type: sequelize.QueryTypes.SELECT }
      );

      // Klasifikasi: upcoming (akan jatuh tempo, due_date masih di masa depan/hari ini)
      //              overdue (sudah lewat, belum lewat grace)
      //              eligible (sudah lewat grace, siap di-isolir otomatis)
      //              isolated (sudah ter-isolir)
      const upcoming = [];
      const overdue  = [];
      const eligible = [];
      const isolated = [];

      for (const r of customers) {
        // Eligible untuk isolir: punya MIKROTIK + method valid
        const isolirMethod = detectMethod(r);
        const hasMethod = isolirMethod !== 'unknown';
        const isEligibleForIsolir = !!(hasMethod && r.mikrotik_id);
        const overdueDays = parseInt(r.days_overdue) || 0;
        const item = {
          id:              r.id,
          customer_id:     r.customer_id,
          name:            r.name,
          phone:           r.phone,
          static_ip:       r.static_ip,
          pppoe_username:  r.pppoe_username,
          mac_address:     r.mac_address,
          connection_type: r.connection_type,
          isolir_method:   isolirMethod === 'unknown' ? null : isolirMethod,
          isolir_status:   r.isolir_status,
          status:          r.status,
          mikrotik_id:     r.mikrotik_id,
          package_name:    r.package_name,
          package_price:   parseFloat(r.package_price) || 0,
          router_name:     r.router_name,
          invoice_id:      r.invoice_id,
          invoice_number:  r.invoice_number,
          invoice_amount:  parseFloat(r.invoice_amount) || 0,
          invoice_status:  r.invoice_status,
          due_date:        r.due_date,
          days_overdue:    overdueDays,
          can_isolir:      isEligibleForIsolir,
          missing_ip:      !hasMethod,     // dipertahankan: arti = "tidak ada method isolir sama sekali"
          missing_router:  !r.mikrotik_id
        };

        if (r.isolir_status === 'isolated') {
          isolated.push(item);
        } else if (overdueDays > graceDays) {
          eligible.push(item);
        } else if (overdueDays > 0) {
          overdue.push(item);
        } else {
          upcoming.push(item);
        }
      }

      res.json({
        success: true,
        grace_days: graceDays,
        data: {
          upcoming,    // akan jatuh tempo (≤7 hari ke depan, belum lewat)
          overdue,     // sudah lewat tapi masih dalam grace period
          eligible,    // sudah lewat grace — siap diisolir
          isolated     // sudah ter-isolir
        },
        counts: {
          upcoming: upcoming.length,
          overdue:  overdue.length,
          eligible: eligible.length,
          isolated: isolated.length
        }
      });
    } catch(e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  async isolir(req, res) {
    try {
      const result = await IsolirService.isolirCustomer(req.params.id, 'admin', req.user?.id);
      res.json(result);
    } catch(e) { res.json({ success:false, message:e.message }); }
  }

  async restore(req, res) {
    try {
      const result = await IsolirService.restoreCustomer(req.params.id, 'admin', req.user?.id);
      res.json(result);
    } catch(e) { res.json({ success:false, message:e.message }); }
  }

  async runAutoIsolir(req, res) {
    try {
      // Tombol manual: jalankan sekali sekarang meski master switch mati.
      // (Master switch hanya mengatur AUTO/cron; admin tetap bisa trigger manual.)
      const result = await IsolirService.runAutoIsolir({ force: true });
      res.json({ success:true, ...result });
    } catch(e) { res.json({ success:false, message:e.message }); }
  }

  async getLogs(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const rows = await sequelize.query(
        `SELECT il.*, c.name AS cust_name, c.customer_id AS cid,
                u.name AS admin_name, d.name AS device_name
         FROM isolir_logs il
         LEFT JOIN customers c       ON c.id=il.customer_id
         LEFT JOIN users u           ON u.id=il.triggered_by_user
         LEFT JOIN mikrotik_devices md ON md.id=il.device_id
         LEFT JOIN devices d         ON d.id = md.device_id
         ORDER BY il.created_at DESC LIMIT ?`,
        { replacements: [limit], type: sequelize.QueryTypes.SELECT }
      );
      res.json({ success:true, data: rows });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  async getSettings(req, res) {
    try {
      const rows = await sequelize.query(
        `SELECT \`key\`, value FROM app_settings WHERE \`key\` IN (
           'isolir_grace_days','isolir_notify_wa','isolir_page_url','isolir_auto_enable',
           'isolir_auto_hour','isolir_wa_message',
           'isolir_page_title','isolir_page_subtitle','isolir_page_color',
           'isolir_page_footer','isolir_page_help_text','isolir_page_show_invoices'
         )`,
        { type: sequelize.QueryTypes.SELECT }
      ).catch(() => []);
      const cfg = {};
      rows.forEach(r => { cfg[r.key] = r.value; });
      res.json({ success:true, data: cfg });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  async saveSettings(req, res) {
    try {
      // ── Server-side validator URL halaman isolir ──
      // Jangan trust client. HTTPS dst-nat tidak akan jalan, jadi tolak di sini.
      const rawUrl = String(req.body.isolir_page_url || '').trim();
      if (rawUrl) {
        if (/^https:\/\//i.test(rawUrl)) {
          return res.status(400).json({
            success: false,
            message: 'URL halaman isolir tidak boleh HTTPS. MikroTik dst-nat tidak bisa redirect ke HTTPS karena TLS handshake akan gagal. Wajib pakai http:// dengan IP LAN. Contoh: http://192.168.1.100:3000/p/isolir'
          });
        }
        // Kalau ada nilai tapi tidak ada protocol, anggap dia ketik tanpa "http://"
        // → reject supaya error message clear (bukan auto-prepend yang silent).
        if (!/^https?:\/\//i.test(rawUrl)) {
          return res.status(400).json({
            success: false,
            message: 'URL halaman isolir harus diawali "http://". Contoh: http://192.168.1.100:3000/p/isolir'
          });
        }
      }

      const allowed = [
        'isolir_grace_days','isolir_notify_wa','isolir_page_url','isolir_auto_enable',
        // Jam auto-isolir (0-23). Kosong/'-1' = setiap jam (perilaku lama).
        'isolir_auto_hour',
        // Template pesan WA saat pelanggan diisolir (placeholder: {nama},{cid},{tagihan},{url})
        'isolir_wa_message',
        // Customisasi tampilan halaman isolir publik (/p/isolir):
        'isolir_page_title',        // judul utama (default: "Layanan Anda Sedang Diisolir")
        'isolir_page_subtitle',     // sub-deskripsi di hero
        'isolir_page_color',        // warna utama hex (default: #1a6ef5)
        'isolir_page_footer',       // teks footer tambahan
        'isolir_page_help_text',    // teks bantuan setelah daftar tagihan
        'isolir_page_show_invoices' // '1'/'0' tampilkan rincian tagihan atau tidak
      ];
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          const { AppSetting } = require('../models');
          await AppSetting.upsert({ key, value: String(req.body[key]), type: 'string' });
        }
      }
      res.json({ success:true, message:'Settings disimpan' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // ════════════════════════════════════════════════════════════════
  // BYPASS LIST — daftar IP/CIDR yang masih boleh diakses pelanggan diisolir
  // ════════════════════════════════════════════════════════════════

  // ── Global bypass (berlaku untuk semua router) ──
  async listGlobalBypass(req, res) {
    try {
      const FW = require('../services/IsolirFirewallV2');
      const rows = await FW.listGlobalBypass();
      res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success:false, message:e.message }); }
  }

  async addGlobalBypass(req, res) {
    try {
      const FW = require('../services/IsolirFirewallV2');
      await FW.addGlobalBypass({
        address: req.body.address,
        label:   req.body.label,
        category: req.body.category
      });
      res.json({ success: true, message: 'Bypass global ditambahkan' });
    } catch (e) { res.status(400).json({ success:false, message:e.message }); }
  }

  async deleteGlobalBypass(req, res) {
    try {
      const FW = require('../services/IsolirFirewallV2');
      await FW.deleteGlobalBypass(req.params.id);
      res.json({ success: true, message: 'Bypass global dihapus' });
    } catch (e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // ── Per-router bypass ──
  async listRouterBypass(req, res) {
    try {
      const FW = require('../services/IsolirFirewallV2');
      const rows = await FW.listRouterBypass(req.params.id);
      res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success:false, message:e.message }); }
  }

  async addRouterBypass(req, res) {
    try {
      const FW = require('../services/IsolirFirewallV2');
      await FW.addRouterBypass(req.params.id, {
        address: req.body.address,
        label:   req.body.label
      });
      res.json({ success: true, message: 'Bypass per-router ditambahkan' });
    } catch (e) { res.status(400).json({ success:false, message:e.message }); }
  }

  async deleteRouterBypass(req, res) {
    try {
      const FW = require('../services/IsolirFirewallV2');
      await FW.deleteRouterBypass(req.params.id, req.params.entryId);
      res.json({ success: true, message: 'Bypass per-router dihapus' });
    } catch (e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // ── Sync bypass list ke MikroTik (tanpa rebuild rules) ──
  async syncBypass(req, res) {
    try {
      const IsolirService = require('../services/IsolirService');
      const FW = require('../services/IsolirFirewallV2');
      // Pakai loadDeviceWithMaster supaya dapet auth dari devices (master)
      const device = await IsolirService.loadDeviceWithMaster(req.params.id, true);
      if (!device) return res.status(404).json({ success:false, message:'Device tidak ditemukan atau tidak aktif' });

      const api = await IsolirService.connectDevice(device);
      try {
        const result = await FW.syncBypassOnly(api, req.params.id);
        res.json({
          success: true,
          message: `Bypass synced: ${result.total} entry (added ${result.added}, removed ${result.removed})`,
          ...result
        });
      } finally { try { api.close(); } catch(_){} }
    } catch (e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // ── Merged bypass preview (apa yang akan di-sync ke router ini) ──
  async previewMergedBypass(req, res) {
    try {
      const FW = require('../services/IsolirFirewallV2');
      const merged = await FW.getMergedBypassList(req.params.id);
      res.json({ success: true, data: merged, count: merged.length });
    } catch (e) { res.status(500).json({ success:false, message:e.message }); }
  }

  // ════════════════════════════════════════════════════════════════
  // ROUTER MATCHER — auto-detect mikrotik_id untuk customer NULL
  // ════════════════════════════════════════════════════════════════

  // Preview hasil scan tanpa save — tampilkan di modal admin
  async previewRouterDetection(req, res) {
    try {
      const Matcher = require('../services/MikrotikRouterMatcher');
      const preview = await Matcher.previewBatchDetect();
      res.json({ success: true, data: preview });
    } catch (e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // Apply hasil detection — simpan mikrotik_id ke customer terpilih
  async applyRouterDetection(req, res) {
    try {
      const Matcher = require('../services/MikrotikRouterMatcher');
      const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
      if (decisions.length === 0) {
        return res.status(400).json({ success:false, message:'Tidak ada customer terpilih' });
      }
      const result = await Matcher.applyBatchDetect(decisions);
      res.json({
        success: true,
        message: `${result.applied} customer di-assign router, ${result.failed} gagal`,
        ...result
      });
    } catch (e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // Detect 1 customer on-demand (tombol per-card di Pelanggan Jatuh Tempo)
  async detectSingleCustomer(req, res) {
    try {
      const Matcher = require('../services/MikrotikRouterMatcher');
      const result = await Matcher.detectSingle(req.params.customerId);
      res.json({ success: result.success, ...result });
    } catch (e) {
      res.status(500).json({ success:false, message:e.message });
    }
  }

  // ── WEB PROXY REDIRECT — handler endpoint baru ───────────────────
  //
  // Web Proxy adalah strategi untuk redirect HTTP customer isolir tanpa
  // butuh setup hotspot/bridge. Lebih sederhana dari hotspot, tapi:
  //   - HANYA handle HTTP (port 80), HTTPS tidak bisa
  //   - Compatible RouterOS v6 & v7
  //   - Tidak butuh interface bind, tidak ubah bridge port
  //
  // Mode aktif: setup web proxy dilakukan sebagai bagian dari setupFirewallV2.
  // Mode disabled: hanya DST-NAT V2 yang aktif (lama).

  // Get current web proxy config + status di MikroTik
  async getWebProxyConfig(req, res) {
    try {
      const IsolirWebProxy = require('../services/IsolirWebProxy');
      const cfg = await IsolirWebProxy.getWebProxySettings();
      // Coba ambil status di MikroTik device pertama (best-effort)
      let mikrotikStatus = null;
      try {
        const [devices] = await sequelize.query(
          `SELECT md.id, md.device_id FROM mikrotik_devices md
           INNER JOIN devices d ON d.id = md.device_id
           WHERE d.is_active=1 AND d.type='router'
           ORDER BY md.id ASC LIMIT 1`
        );
        if (devices && devices.length) {
          const IsolirService = require('../services/IsolirService');
          const device = await IsolirService.loadDeviceWithMaster(devices[0].id, true);
          if (device) {
            const api = await IsolirService.connectDevice(device);
            try {
              mikrotikStatus = await IsolirWebProxy.getWebProxyStatus(api);
              mikrotikStatus.device_id = devices[0].id;
              mikrotikStatus.device_name = device.name;
            } finally { try { api.close(); } catch(_){} }
          }
        }
      } catch (e) {
        mikrotikStatus = { error: e.message };
      }
      res.json({ success: true, config: cfg, mikrotik: mikrotikStatus });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // Save web proxy config (enabled)
  async saveWebProxyConfig(req, res) {
    try {
      const { enabled } = req.body || {};
      await sequelize.query(
        `INSERT INTO app_settings (\`key\`, value)
         VALUES ('isolir_webproxy_enabled', ?)
         ON DUPLICATE KEY UPDATE value=VALUES(value)`,
        { replacements: [enabled ? '1' : '0'] }
      );
      res.json({ success: true, message: 'Konfigurasi Web Proxy disimpan. Klik "Setup Firewall" pada device agar perubahan terapply ke MikroTik.' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new IsolirController();