const { Customer, Package, Invoice, OntDevice } = require('../models');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const { generateUniqueCustomerId, paginateResponse } = require('../utils/helpers');
const { getCompanyName } = require('../utils/companyInfo');
const InfraSync = require('../services/CustomerInfraSyncService');

class CustomerController {
  async index(req, res) {
    try {
      const { page = 1, limit = 20, search, status, package_id, province, regency, district } = req.query;
      const where = {};
      
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { customer_id: { [Op.like]: `%${search}%` } },
          { phone: { [Op.like]: `%${search}%` } },
          { address: { [Op.like]: `%${search}%` } }
        ];
      }
      // overdue & due_soon adalah filter virtual — tidak set where.status
      if (status && status !== 'overdue' && status !== 'due_soon') {
        where.status = status
      }
      if (package_id) where.package_id = package_id;
      // ── Filter per-area (berjenjang) ──
      if (province) where.province = province;
      if (regency)  where.regency  = regency;
      if (district) where.district = district;

      const offset = (page - 1) * limit;
      const { Invoice } = require('../models');
      const { count, rows } = await Customer.findAndCountAll({
        where,
        include: [
          { model: Package, as: 'package' },
          {
            model: Invoice, as: 'invoices',
            attributes: ['id','due_date','status','paid_date','period_month','period_year','amount','total'],
            required: false,
            order: [['due_date', 'DESC']],
            separate: true,
            limit: 1
          }
        ],
        offset,
        limit: (status === 'overdue' || status === 'due_soon') ? 999 : parseInt(limit),
        order: [['created_at', 'DESC']]
      });

      // Logic PHP: due_date dari kolom customers.due_date
      // latest_invoice_status dari invoice AKTUAL (unpaid/paid/overdue)
      const todayDate = new Date(); todayDate.setHours(0,0,0,0);
      const data = rows.map(c => {
        const json     = c.toJSON();
        const invoices = json.invoices || [];

        // Cari invoice yang relevan
        const unpaidInv = invoices.find(i => ['unpaid','overdue'].includes(i.status));
        const latestInv = invoices[0] || null;

        // due_date: dari kolom customers.due_date (diset manual/otomatis)
        const dueDate = json.due_date || null;

        // latest_invoice_status: cerminkan status invoice aktual
        // Ini dipakai di frontend untuk menentukan badge overdue/due_soon/paid
        let dueStatus = null;
        if (unpaidInv) {
          // Ada invoice belum lunas → status berdasarkan due_date customer
          const dd = dueDate ? new Date(dueDate + 'T00:00:00') : null;
          if (dd && dd < todayDate)  dueStatus = 'overdue';
          else                        dueStatus = 'unpaid';
        } else if (latestInv && latestInv.status === 'paid') {
          dueStatus = 'paid';
        } else if (!latestInv && dueDate) {
          // Belum ada invoice — cek due_date langsung
          const dd = new Date(dueDate + 'T00:00:00');
          if (dd < todayDate) dueStatus = 'overdue';
          else                dueStatus = 'active';
        }

        json.latest_invoice        = unpaidInv || latestInv;
        json.latest_due_date       = dueDate;
        json.latest_invoice_status = dueStatus;
        return json;
      });

      // Post-process filter overdue / due_soon berdasarkan latest_due_date
      let filtered = data;
      const todayStr = new Date().toISOString().split('T')[0];
      const in3days  = new Date(Date.now() + 3*86400000).toISOString().split('T')[0];

      if (status === 'overdue') {
        // Sama dengan stats: due_date < today + status active + ada invoice unpaid/overdue
        filtered = data.filter(c =>
          c.latest_invoice_status === 'overdue' &&
          ['active','isolated'].includes(c.status)
        );
      } else if (status === 'due_soon') {
        filtered = data.filter(c =>
          c.latest_invoice_status === 'unpaid' &&
          c.status === 'active' &&
          c.latest_due_date &&
          c.latest_due_date >= todayStr &&
          c.latest_due_date <= in3days
        );
      }

      // Hitung total yang benar untuk pagination
      const filteredCount = (status === 'overdue' || status === 'due_soon') ? filtered.length : count;
      res.json({ success: true, ...paginateResponse(filtered, filteredCount, page, limit) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async create(req, res) {
    try {
      const data = req.body;
      // Pisahkan flag send_wa_welcome dari data customer (bukan kolom DB)
      const sendWA = !!data.send_wa_welcome;
      delete data.send_wa_welcome;
      // Pisahkan flag send_email_welcome (bukan kolom DB)
      const sendEmailWelcome = !!data.send_email_welcome;
      delete data.send_email_welcome;

      if (!data.name) return res.status(400).json({ success: false, message: 'Nama customer wajib diisi' });

      // Jika customer_id dikirim manual, validasi uniqueness
      if (data.customer_id) {
        data.customer_id = data.customer_id.trim().toUpperCase();
        const exists = await Customer.findOne({ where: { customer_id: data.customer_id } });
        if (exists) return res.status(400).json({ success: false, message: 'ID ' + data.customer_id + ' sudah digunakan' });
      } else {
        data.customer_id = await generateUniqueCustomerId(Customer);
      }

      // Validasi billing_date
      if (data.billing_date !== undefined) {
        const bd = parseInt(data.billing_date);
        if (isNaN(bd) || bd < 1 || bd > 28) {
          return res.status(400).json({ success: false, message: 'Tanggal tagihan harus antara 1-28' });
        }
      }

      // Jangan izinkan field internal di-set dari input bebas.
      delete data.public_link_token;

      // Auto-generate token link pembayaran permanen untuk pelanggan baru.
      try {
        const { generateCustomerLinkToken } = require('../utils/templateHelper');
        for (let i = 0; i < 5; i++) {
          const candidate = generateCustomerLinkToken();
          const dup = await Customer.findOne({ where: { public_link_token: candidate } });
          if (!dup) { data.public_link_token = candidate; break; }
        }
      } catch (e) { /* non-fatal: link bisa dibuat manual nanti */ }

      const customer = await Customer.create(data);
      const full = await Customer.findByPk(customer.id, {
        include: [{ model: Package, as: 'package' }]
      });

      // Auto-sync ke InfrastructurePoint type='customer' kalau ada lat/lng.
      // Best-effort — gagal sync di sini tidak membatalkan create customer.
      const infraResult = await InfraSync.syncCustomerToInfra(full);

      // Kirim WA welcome (best-effort, tidak block response)
      let waStatus = 'skipped';
      if (sendWA && full.phone) {
        try {
          const result = await sendWelcomeWA(full);
          waStatus = result?.sent ? 'sent' : (result?.reason || 'failed');
        } catch (e) {
          console.error('[Customer] sendWelcomeWA error:', e.message);
          waStatus = 'failed';
        }
      } else if (sendWA && !full.phone) {
        waStatus = 'no_phone';
      }

      // Kirim email selamat datang (best-effort, gated oleh checkbox + template "customer_welcome").
      let emailStatus = 'skipped';
      if (sendEmailWelcome && full.email) {
        try {
          const EmailService = require('../services/EmailService');
          const EmailTpl = require('../services/EmailTemplateService');
          const enabled = await EmailTpl.isEnabled('customer_welcome');
          if (!enabled) {
            emailStatus = 'disabled';
          } else {
            const ok = await EmailService.sendCustomerWelcome(full);
            emailStatus = ok ? 'sent' : 'no_smtp';
          }
        } catch (e) {
          console.error('[Customer] sendCustomerWelcome error:', e.message);
          emailStatus = 'failed';
        }
      } else if (sendEmailWelcome && !full.email) {
        emailStatus = 'no_email';
      }

      // Notifikasi Telegram (event bisnis) — fire-and-forget, tidak memblok response.
      try {
        const area = [full.village, full.district, full.regency, full.province]
          .filter(Boolean).join(', ') || null;
        let createdByName = null;
        if (req.user?.id) {
          try {
            const { User } = require('../models');
            const u = await User.findByPk(req.user.id, { attributes: ['name'] });
            createdByName = u?.name || null;
          } catch (_) {}
        }
        require('../services/TelegramEvents').newCustomer({
          name: full.name,
          customerCode: full.customer_id,
          customerId: full.id,
          packageName: full.package?.name || null,
          price: full.package?.price || null,
          phone: full.phone || null,
          email: full.email || null,
          address: full.address || null,
          area,
          connType: full.connection_type || null,
          staticIp: full.static_ip || null,
          pppoeUser: full.pppoe_username || null,
          createdBy: createdByName,
          createdAt: full.created_at || full.createdAt,
        }).catch(() => {});
      } catch (_) {}

      res.status(201).json({ success: true, data: full, wa_status: waStatus, email_status: emailStatus, infra_sync: infraResult });
    } catch (error) {
      const msg = error.name === 'SequelizeValidationError'
        ? error.errors.map(e => e.message).join(', ')
        : error.message;
      res.status(400).json({ success: false, message: msg });
    }
  }

  async update(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      if (req.body.billing_date !== undefined) {
        const bd = parseInt(req.body.billing_date);
        if (isNaN(bd) || bd < 1 || bd > 28) {
          return res.status(400).json({ success: false, message: 'Tanggal tagihan harus antara 1-28' });
        }
      }

      // SECURITY: Field portal credentials TIDAK BOLEH diupdate via endpoint umum
      // karena password akan ter-bypass bcrypt dan disimpan plaintext.
      // Gunakan POST /customers/:id/portal-credentials sebagai gantinya.
      const sanitized = { ...req.body };
      delete sanitized.portal_password;       // hanya boleh diset via updatePortalCredentials (di-bcrypt)
      delete sanitized.customer_id;           // hanya boleh diubah via updatePortalCredentials (validasi unique)
      delete sanitized.last_portal_login;     // diset otomatis oleh sistem saat login
      delete sanitized.public_link_token;     // hanya via endpoint payment-link (generate/revoke)

      await customer.update(sanitized);
      const full = await Customer.findByPk(customer.id, {
        include: [{ model: Package, as: 'package' }]
      });

      // Auto-sync ke InfrastructurePoint. Full sync mode:
      //   - lat/lng ada → create / update point
      //   - lat/lng null → hapus point yang ada
      // Best-effort: gagal sync tidak membatalkan update customer.
      const infraResult = await InfraSync.syncCustomerToInfra(full);

      res.json({ success: true, data: full, infra_sync: infraResult });
    } catch (error) {
      const msg = error.name === 'SequelizeValidationError'
        ? error.errors.map(e => e.message).join(', ')
        : error.message;
      res.status(400).json({ success: false, message: msg });
    }
  }

  // ── PORTAL CREDENTIALS (admin-only) ──────────────────────────────────
  //
  // Admin bisa:
  //   - Mengubah customer_id (login ID portal pelanggan)
  //   - Mengatur password baru (di-bcrypt sebelum simpan)
  //   - Mengaktifkan/menonaktifkan akses portal
  //
  // Endpoint terpisah dari update() umum supaya:
  //   1. Password DIPASTIKAN di-bcrypt (tidak bisa di-bypass via PUT generic)
  //   2. Perubahan customer_id punya validasi unique yang jelas
  //   3. Mudah di-permission/audit secara independen

  async getPortalCredentials(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id, {
        attributes: ['id', 'customer_id', 'name', 'phone', 'portal_enabled', 'last_portal_login']
      });
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      // Tidak pernah kirim hash password ke frontend.
      // Cuma kirim status: apakah password sudah diset, atau masih fallback ke nomor HP.
      const raw = await Customer.findByPk(req.params.id, { attributes: ['portal_password'] });
      const hasCustomPassword = !!(raw && raw.portal_password);

      res.json({
        success: true,
        data: {
          id:                 customer.id,
          customer_id:        customer.customer_id,
          name:               customer.name,
          phone:              customer.phone,
          portal_enabled:     customer.portal_enabled,
          last_portal_login:  customer.last_portal_login,
          has_custom_password: hasCustomPassword,
          // Hint: kalau belum punya password custom, pelanggan login pakai nomor HP.
          fallback_login_hint: hasCustomPassword
            ? null
            : (customer.phone || null)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async updatePortalCredentials(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      const { customer_id, new_password, portal_enabled } = req.body;
      const updates = {};

      // 1) Ubah customer_id (login ID portal)
      if (customer_id !== undefined && customer_id !== null) {
        const newCid = String(customer_id).trim();
        if (!newCid) {
          return res.status(400).json({ success: false, message: 'Customer ID tidak boleh kosong' });
        }
        if (newCid.length > 20) {
          return res.status(400).json({ success: false, message: 'Customer ID maksimal 20 karakter' });
        }
        // Hanya alphanumeric + dash/underscore — hindari karakter aneh untuk login ID
        if (!/^[a-zA-Z0-9_-]+$/.test(newCid)) {
          return res.status(400).json({ success: false, message: 'Customer ID hanya boleh huruf, angka, "-", dan "_"' });
        }
        if (newCid !== customer.customer_id) {
          // Cek uniqueness (kecuali dirinya sendiri)
          const existing = await Customer.findOne({
            where: { customer_id: newCid, id: { [Op.ne]: customer.id } }
          });
          if (existing) {
            return res.status(409).json({ success: false, message: `Customer ID "${newCid}" sudah dipakai pelanggan lain` });
          }
          updates.customer_id = newCid;
        }
      }

      // 2) Set password baru (di-bcrypt)
      let plainPasswordReturned = null; // hanya untuk response, supaya admin bisa share ke pelanggan
      if (new_password !== undefined && new_password !== null && new_password !== '') {
        const pw = String(new_password);
        if (pw.length < 6) {
          return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
        }
        if (pw.length > 100) {
          return res.status(400).json({ success: false, message: 'Password maksimal 100 karakter' });
        }
        updates.portal_password = await bcrypt.hash(pw, 10);
        plainPasswordReturned   = pw; // dikirim kembali sekali untuk ditampilkan admin
      }

      // 3) Toggle portal_enabled
      if (portal_enabled !== undefined) {
        updates.portal_enabled = !!portal_enabled;
      }

      if (!Object.keys(updates).length) {
        return res.status(400).json({ success: false, message: 'Tidak ada perubahan' });
      }

      await customer.update(updates);

      res.json({
        success: true,
        message: 'Kredensial portal berhasil diperbarui',
        data: {
          customer_id:    customer.customer_id,
          portal_enabled: customer.portal_enabled,
          // password plaintext HANYA dikirim balik sekali, di response ini saja, tidak disimpan log.
          // Frontend menampilkan ke admin supaya bisa share ke pelanggan (mis. via WA).
          new_password:   plainPasswordReturned
        }
      });
    } catch (error) {
      const msg = error.name === 'SequelizeValidationError'
        ? error.errors.map(e => e.message).join(', ')
        : error.message;
      res.status(400).json({ success: false, message: msg });
    }
  }

  // Reset password ke default = nomor HP pelanggan (atau kosongkan password custom)
  async resetPortalPassword(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      // Set portal_password = null → CustomerPortalController.login akan fallback ke phone match
      await customer.update({ portal_password: null });

      res.json({
        success: true,
        message: 'Password direset. Pelanggan dapat login menggunakan nomor HP-nya.',
        data: {
          fallback_login_hint: customer.phone || null
        }
      });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async show(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id, {
        include: [
          { model: Package, as: 'package' },
          { model: OntDevice, as: 'ont_device' }
        ]
      });
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      // Ambil invoice terpisah dengan order & limit yang valid
      const invoices = await Invoice.findAll({
        where: { customer_id: req.params.id },
        order: [['created_at', 'DESC']],
        limit: 12
      });

      const result = customer.toJSON();
      result.invoices = invoices;

      // Ambil info router MikroTik secara terpisah (tidak via include association)
      // supaya tidak butuh perubahan models/index.js. Hanya fetch kalau customer
      // punya mikrotik_id. Failsafe: kalau Device gagal di-fetch, set null.
      if (result.mikrotik_id) {
        try {
          const { Device } = require('../models');
          const router = await Device.findByPk(result.mikrotik_id, {
            attributes: ['id', 'name', 'host', 'type']
          });
          result.mikrotik = router ? router.toJSON() : null;
          if (!router) {
            console.warn(`[CustomerController.show] Device id=${result.mikrotik_id} not found for customer ${result.customer_id}. Stale FK?`);
          }
        } catch (e) {
          console.error(`[CustomerController.show] Failed to fetch Device id=${result.mikrotik_id}:`, e.message);
          result.mikrotik = null;
        }
      } else {
        result.mikrotik = null;
      }

      // Logic PHP: due_date dari kolom customers, status dari invoice aktual
      const unpaidInv2 = invoices.find(i => ['unpaid','overdue'].includes(i.status));
      const dueDate    = result.due_date || null;
      const todayNow   = new Date(); todayNow.setHours(0,0,0,0);
      let dueStatus2 = null;
      if (unpaidInv2) {
        const dd = dueDate ? new Date(dueDate + 'T00:00:00') : null;
        dueStatus2 = (dd && dd < todayNow) ? 'overdue' : 'unpaid';
      } else if (invoices.length > 0 && invoices[0].status === 'paid') {
        dueStatus2 = 'paid';
      } else if (!invoices.length && dueDate) {
        const dd = new Date(dueDate + 'T00:00:00');
        dueStatus2 = dd < todayNow ? 'overdue' : 'active';
      }
      result.latest_due_date         = dueDate;
      result.latest_invoice_status   = dueStatus2;

      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // DELETE /api/customers/:id
  // Hapus customer dari DB. Default: hanya hapus record DB (backward compat).
  //
  // Query/body param `delete_router_secret=true` → juga hapus secret PPPoE
  // di router MikroTik yang terkait (kalau customer punya pppoe_username
  // + mikrotik_id).
  //
  // Flow:
  //   1. Validasi customer ada
  //   2. Kalau delete_router_secret=true & customer punya pppoe & mikrotik:
  //      a. Cari secret di router by name
  //      b. Hapus secret via MikrotikService.deletePPPoESecret
  //      c. Kalau gagal → return error, DB TIDAK ikut dihapus (atomic)
  //      d. Kalau secret tidak ditemukan di router → lanjutkan (mungkin
  //         sudah dihapus manual atau memang tidak ada) dengan info
  //   3. Hapus record DB
  //   4. Return summary
  // ──────────────────────────────────────────────────────────────────
  async destroy(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      // Parse opsi delete_router_secret (terima dari query atau body)
      const flag = (req.body && req.body.delete_router_secret) ?? req.query?.delete_router_secret;
      const deleteRouterSecret = (flag === true || flag === 'true' || flag === '1');

      let routerStatus = 'skipped'; // 'skipped' | 'deleted' | 'not_found' | 'failed'
      let routerMessage = null;

      if (deleteRouterSecret) {
        const oldUsername = (customer.pppoe_username || '').trim();
        const routerId    = customer.mikrotik_id;

        if (!oldUsername) {
          routerStatus = 'skipped';
          routerMessage = 'Customer tidak punya pppoe_username — tidak ada secret untuk dihapus';
        } else if (!routerId) {
          routerStatus = 'skipped';
          routerMessage = 'Customer tidak punya mikrotik_id — tidak tahu router mana yang harus dicek';
        } else {
          // Coba hapus secret di router
          const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
          let mt;
          try {
            mt = await getMikrotikInstanceByDevice(routerId);
          } catch (err) {
            return res.status(502).json({
              success: false,
              message: `Tidak bisa konek ke router: ${err.message}. Customer TIDAK dihapus untuk konsistensi.`
            });
          }

          let secrets;
          try {
            secrets = await mt.getPPPoESecrets();
          } catch (err) {
            return res.status(502).json({
              success: false,
              message: `Gagal ambil daftar secret dari router: ${err.message}. Customer TIDAK dihapus untuk konsistensi.`
            });
          }

          const targetSecret = (secrets || []).find(s => s.name === oldUsername);
          if (!targetSecret) {
            // Secret tidak ada di router — mungkin sudah dihapus manual.
            // Lanjutkan delete DB dengan info ini.
            routerStatus = 'not_found';
            routerMessage = `Secret "${oldUsername}" tidak ada di router (mungkin sudah dihapus manual)`;
          } else {
            try {
              await mt.deletePPPoESecret(targetSecret.id);
              routerStatus = 'deleted';
              routerMessage = `Secret "${oldUsername}" berhasil dihapus dari router`;
            } catch (err) {
              return res.status(502).json({
                success: false,
                message: `Gagal hapus secret di router: ${err.message}. Customer TIDAK dihapus untuk konsistensi.`
              });
            }
          }
        }
      }

      // Hapus InfrastructurePoint type='customer' milik customer ini SEBELUM
      // customer.destroy(). Cascade delete agar titik di peta ikut hilang.
      // Best-effort: gagal sync tidak membatalkan delete customer.
      const infraResult = await InfraSync.removeInfraForCustomer(customer.id);

      // Hapus record DB (cascade ke invoice/payment akan otomatis sesuai FK)
      await customer.destroy();

      return res.json({
        success: true,
        message: 'Customer dihapus' + (routerStatus === 'deleted' ? ' + secret di router' : ''),
        router_status:  routerStatus,
        router_message: routerMessage,
        infra_sync:     infraResult,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Get stats
  async stats(req, res) {
    try {
      const { Invoice } = require('../models');
      const today = new Date().toISOString().slice(0, 10);
      const in3days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

      const total    = await Customer.count();
      const active   = await Customer.count({ where: { status: 'active' } });
      const isolated = await Customer.count({ where: { status: 'isolated' } });
      const inactive = await Customer.count({ where: { status: 'inactive' } });
      const suspended= await Customer.count({ where: { status: 'suspended' } });

      // Overdue & due_soon: gunakan logika IDENTIK dengan filter di index()
      // Fetch semua customer aktif beserta invoice terbaru → kalkulasi status → count
      const allForStats = await Customer.findAll({
        where: { status: { [Op.in]: ['active','isolated','suspended'] } },
        attributes: ['id','status','due_date'],
        include: [{
          model: Invoice, as: 'invoices',
          attributes: ['id','status','due_date'],
          required: false,
          separate: true,
          order: [['created_at','DESC']],
          limit: 3
        }]
      });

      const todayDt = new Date(today + 'T00:00:00');
      const in3Dt   = new Date(in3days + 'T00:00:00');
      let overdue = 0, due_soon = 0;

      for (const cust of allForStats) {
        const invs      = cust.invoices || [];
        const dueDate   = cust.due_date;
        if (!dueDate) continue;

        const dueDt     = new Date(dueDate + 'T00:00:00');
        const unpaidInv = invs.find(i => ['unpaid','overdue'].includes(i.status));

        // Kalkulasi latest_invoice_status — identik dengan index()
        let dueStatus = null;
        if (unpaidInv) {
          dueStatus = dueDt < todayDt ? 'overdue' : 'unpaid';
        } else if (invs.length > 0 && invs[0].status === 'paid') {
          dueStatus = 'paid';
        } else if (invs.length === 0) {
          dueStatus = dueDt < todayDt ? 'overdue' : 'active';
        }

        // Count — sama persis dengan filter di index()
        if (dueStatus === 'overdue' && ['active','isolated'].includes(cust.status)) overdue++;
        if (dueStatus === 'unpaid'  && cust.status === 'active' && dueDt >= todayDt && dueDt <= in3Dt) due_soon++;
      }

      // Revenue = ESTIMASI pendapatan bulanan dari customer aktif.
      // Dihitung: SUM(packages.price) untuk semua customer dengan status='active'
      // yang punya paket. Customer tanpa paket tidak ikut dihitung.
      // Catatan: ini bukan revenue real (belum tentu lunas) — hanya estimasi
      // recurring monthly income kalau semua customer aktif bayar tepat waktu.
      const { sequelize } = require('../models');

      let monthly_revenue = 0;
      try {
        const revRows = await sequelize.query(`
          SELECT COALESCE(SUM(p.price), 0) AS total
          FROM customers c
          INNER JOIN packages p ON p.id = c.package_id
          WHERE c.status = 'active'
            AND c.package_id IS NOT NULL
        `, {
          type: sequelize.QueryTypes.SELECT
        });
        monthly_revenue = parseFloat((revRows && revRows[0]?.total) || 0);
      } catch (e) {
        // Fallback ke 0 kalau query gagal (misal tabel belum ada)
        monthly_revenue = 0;
      }

      res.json({
        success: true,
        data: { total, active, isolated, inactive, suspended, overdue, due_soon, monthly_revenue }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Get all for map
  async mapData(req, res) {
    try {
      const where = {
        latitude: { [Op.not]: null },
        longitude: { [Op.not]: null }
      };

      // OPTIMASI skala besar (>5.000 pelanggan): viewport bounds query.
      // Frontend kirim ?bounds=south,west,north,east → hanya pelanggan di
      // area yang terlihat yang dikirim. Tanpa bounds = kirim semua (kompat lama).
      const b = (req.query.bounds || '').split(',').map(Number);
      if (b.length === 4 && b.every(n => Number.isFinite(n))) {
        const [south, west, north, east] = b;
        where.latitude  = { [Op.between]: [Math.min(south, north), Math.max(south, north)] };
        where.longitude = { [Op.between]: [Math.min(west, east),   Math.max(west, east)] };
      }

      // Batas aman jumlah baris agar payload tidak meledak (bisa dinaikkan).
      const limit = Math.min(parseInt(req.query.limit, 10) || 8000, 20000);

      const customers = await Customer.findAll({
        where,
        attributes: ['id', 'customer_id', 'name', 'address', 'phone', 'status', 'latitude', 'longitude', 'pppoe_username', 'static_ip'],
        include: [{ model: Package, as: 'package', attributes: ['id', 'name', 'price'] }],
        // raw+nest: lewati pembuatan instance Sequelize penuh — jauh lebih cepat
        // saat ribuan baris (payload peta tidak butuh method model).
        raw: true,
        nest: true,
        limit,
      });
      res.json({ success: true, data: customers, limited: customers.length >= limit });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Cek apakah customer_id sudah dipakai
  async checkCustomerId(req, res) {
    try {
      const { customer_id, exclude_id } = req.query;
      if (!customer_id) return res.status(400).json({ success: false, message: 'customer_id wajib' });
      const where = { customer_id };
      if (exclude_id) where.id = { [Op.ne]: exclude_id };
      const exists = await Customer.findOne({ where });
      res.json({ success: true, available: !exists });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Ambil next auto-generated customer_id
  async nextCustomerId(req, res) {
    try {
      const nextId = await generateUniqueCustomerId(Customer, 'CID');
      res.json({ success: true, customer_id: nextId });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // POST /api/customers/:id/rename-pppoe
  // Ubah PPPoE username customer existing, dengan opsi sync ke router MikroTik.
  //
  // Body:
  //   {
  //     new_username: string (required, sudah di-sanitize di frontend)
  //     sync_to_router: boolean (true = ikut rename secret di MikroTik)
  //   }
  //
  // Flow:
  //   1. Validasi customer ada & punya pppoe_username lama
  //   2. Cek uniqueness new_username di DB (tidak boleh bentrok customer lain)
  //   3. Kalau sync_to_router:
  //      a. Cari secret di router (by old username + customer.mikrotik_id)
  //      b. PATCH secret di router dengan name baru via MikrotikService
  //      c. Kalau gagal → return error, JANGAN update DB (atomic safety)
  //   4. Update kolom pppoe_username di DB
  //   5. Return summary
  //
  // Kalau sync_to_router=false: hanya update DB (mode "saya sudah rename manual di Winbox").
  // ──────────────────────────────────────────────────────────────────
  async renamePppoe(req, res) {
    try {
      const customerId = req.params.id;
      const { new_username, sync_to_router } = req.body || {};

      // new_username boleh KOSONG → berarti HAPUS/clear PPPoE username.
      // (Mis. admin mengosongkan field PPPoE di Edit Customer.)
      const trimmedNew = (new_username == null ? '' : String(new_username)).trim();
      const isClearing = trimmedNew === '';
      if (!isClearing && trimmedNew.length > 100) {
        return res.status(400).json({ success: false, message: 'new_username max 100 karakter' });
      }

      // Ambil customer
      const customer = await Customer.findByPk(customerId);
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });
      }

      const oldUsername = (customer.pppoe_username || '').trim();
      if (trimmedNew === oldUsername) {
        return res.json({
          success: true,
          message: 'Username tidak berubah',
          updated_db: false,
          synced_router: false
        });
      }

      // Cek bentrok dengan customer lain di DB (hanya kalau bukan clearing)
      if (!isClearing) {
        const conflict = await Customer.findOne({
          where: {
            pppoe_username: trimmedNew,
            id: { [Op.ne]: customer.id }
          },
          attributes: ['id', 'customer_id', 'name']
        });
        if (conflict) {
          return res.status(409).json({
            success: false,
            message: `Username "${trimmedNew}" sudah dipakai customer lain: ${conflict.customer_id} (${conflict.name})`
          });
        }
      }

      // ── Sync ke router kalau diminta ─────────────────────────────
      let syncedRouter = false;
      let routerWarning = null;

      if (sync_to_router) {
        // Butuh: oldUsername (untuk lookup) dan customer.mikrotik_id (router yang punya secret)
        if (!oldUsername) {
          // Tidak ada secret lama untuk disentuh. Kalau clearing, anggap sukses
          // (memang tidak ada yang dihapus). Kalau rename, tidak bisa sync.
          if (isClearing) {
            await customer.update({ pppoe_username: null });
            return res.json({
              success: true,
              message: 'PPPoE username dikosongkan di FLAYNET. Tidak ada secret lama di router untuk dihapus.',
              old_username: oldUsername,
              new_username: null,
              updated_db: true,
              synced_router: false
            });
          }
          return res.status(400).json({
            success: false,
            message: 'Customer tidak punya pppoe_username lama untuk dicari di router. Tidak bisa sync.'
          });
        }
        if (!customer.mikrotik_id) {
          return res.status(400).json({
            success: false,
            message: 'Customer tidak punya router MikroTik terhubung. Set kolom "Router MikroTik" di profil customer dulu, atau gunakan mode "DB only".'
          });
        }

        // Cari secret di router by name
        const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
        let mt;
        try {
          mt = await getMikrotikInstanceByDevice(customer.mikrotik_id);
        } catch (err) {
          return res.status(502).json({
            success: false,
            message: `Tidak bisa konek ke router: ${err.message}`
          });
        }

        let secrets;
        try {
          secrets = await mt.getPPPoESecrets();
        } catch (err) {
          return res.status(502).json({
            success: false,
            message: `Gagal ambil daftar secret dari router: ${err.message}`
          });
        }

        const targetSecret = (secrets || []).find(s => s.name === oldUsername);
        if (!targetSecret) {
          // Secret lama tidak ada di router.
          // - Kalau CLEARING: anggap sukses (memang mau dihapus, dan sudah tidak ada).
          // - Kalau RENAME: minta user pakai mode DB-only.
          if (isClearing) {
            await customer.update({ pppoe_username: null });
            return res.json({
              success: true,
              message: `Secret "${oldUsername}" tidak ada di router (mungkin sudah dihapus). PPPoE username dikosongkan di FLAYNET.`,
              old_username: oldUsername,
              new_username: null,
              updated_db: true,
              synced_router: false
            });
          }
          return res.status(404).json({
            success: false,
            message: `Secret PPPoE "${oldUsername}" tidak ditemukan di router. Mungkin sudah di-rename manual atau dihapus. Pilih mode "DB only" untuk update database saja.`
          });
        }

        if (isClearing) {
          // Hapus secret di router
          try {
            await mt.deletePPPoESecret(targetSecret.id);
            syncedRouter = true;
          } catch (err) {
            return res.status(502).json({
              success: false,
              message: `Gagal hapus secret di router: ${err.message}. Database tidak di-update untuk konsistensi.`
            });
          }
        } else {
          // Pastikan name baru tidak bentrok dengan secret lain di router
          const dupInRouter = (secrets || []).find(s => s.name === trimmedNew && s.id !== targetSecret.id);
          if (dupInRouter) {
            return res.status(409).json({
              success: false,
              message: `Username "${trimmedNew}" sudah dipakai oleh secret lain di router (id=${dupInRouter.id})`
            });
          }
          // Rename secret di router
          try {
            await mt.updatePPPoESecret(targetSecret.id, { name: trimmedNew });
            syncedRouter = true;
          } catch (err) {
            return res.status(502).json({
              success: false,
              message: `Gagal rename secret di router: ${err.message}. Database tidak di-update untuk konsistensi.`
            });
          }
        }
      }

      // ── Update DB ────────────────────────────────────────────────
      const dbValue = isClearing ? null : trimmedNew;
      await customer.update({ pppoe_username: dbValue });

      let okMessage;
      if (isClearing) {
        okMessage = sync_to_router
          ? `PPPoE username dihapus di FLAYNET & secret dihapus di router (sebelumnya: ${oldUsername})`
          : `PPPoE username dikosongkan di FLAYNET saja (sebelumnya: ${oldUsername}). Router tidak disentuh.`;
      } else {
        okMessage = sync_to_router
          ? `PPPoE username berhasil diubah di FLAYNET & router (${oldUsername} → ${trimmedNew})`
          : `PPPoE username diubah di FLAYNET saja (${oldUsername} → ${trimmedNew}). Router tidak disentuh.`;
      }

      return res.json({
        success: true,
        message: okMessage,
        old_username: oldUsername,
        new_username: dbValue,
        updated_db: true,
        synced_router: syncedRouter,
        warning: routerWarning
      });
    } catch (error) {
      const msg = error.name === 'SequelizeValidationError'
        ? error.errors.map(e => e.message).join(', ')
        : error.message;
      res.status(500).json({ success: false, message: msg });
    }
  }

  // ── Daftar area distinct (berjenjang) untuk dropdown filter ──────────────
  // GET /customers/areas?province=...&regency=...&district=...
  // Tanpa param → list provinsi. +province → list kab/kota. +regency → list
  // kecamatan. +district → list kelurahan/desa. Hanya area non-kosong.
  async areas(req, res) {
    try {
      const { province, regency, district } = req.query;
      const { Op } = require('sequelize');
      let column, where = {};
      if (district) {
        column = 'village';
        where.district = district;
        if (regency) where.regency = regency;
        if (province) where.province = province;
      } else if (regency) {
        column = 'district';
        where.regency = regency;
        if (province) where.province = province;
      } else if (province) {
        column = 'regency';
        where.province = province;
      } else {
        column = 'province';
      }
      where[column] = { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] };

      const rows = await Customer.findAll({
        attributes: [[require('sequelize').fn('DISTINCT', require('sequelize').col(column)), 'name']],
        where,
        order: [[column, 'ASC']],
        raw: true,
      });
      const list = rows.map(r => r.name).filter(Boolean);
      res.json({ success: true, level: column, data: list });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Backfill area dari teks alamat untuk customer lama ───────────────────
  // POST /customers/backfill-areas
  // Mengisi province/regency/district dengan mencocokkan teks `address` ke
  // pola umum hasil composeAddr ("..., Kec. X, KAB/KOTA Y, PROVINSI Z").
  // Hanya mengisi yang masih kosong; tidak menimpa area yang sudah ada.
  async backfillAreas(req, res) {
    try {
      const { Op } = require('sequelize');
      // Ambil customer yang punya address tapi belum punya area lengkap
      const customers = await Customer.findAll({
        where: {
          address: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
          [Op.or]: [
            { province: { [Op.or]: [null, ''] } },
            { regency:  { [Op.or]: [null, ''] } },
            { district: { [Op.or]: [null, ''] } },
          ],
        },
      });

      let updated = 0, skipped = 0;
      for (const c of customers) {
        const parsed = parseAreaFromAddress(c.address);
        const patch = {};
        if (!c.province && parsed.province) patch.province = parsed.province;
        if (!c.regency  && parsed.regency)  patch.regency  = parsed.regency;
        if (!c.district && parsed.district) patch.district = parsed.district;
        if (!c.village  && parsed.village)  patch.village  = parsed.village;
        if (Object.keys(patch).length) {
          await c.update(patch);
          updated++;
        } else {
          skipped++;
        }
      }
      res.json({
        success: true,
        message: `Backfill selesai: ${updated} customer diperbarui, ${skipped} dilewati`,
        updated, skipped, scanned: customers.length,
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Permanent payment link per-pelanggan ──────────────────────────
  // GET /customers/:id/payment-link → { token, url } (url null bila belum ada)
  async getPaymentLink(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
      const { buildCustomerLink } = require('../utils/templateHelper');
      const token = customer.public_link_token || null;
      res.json({
        success: true,
        data: { token, url: token ? buildCustomerLink(token) : null }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // POST /customers/:id/payment-link → generate / regenerate (revoke lama)
  async generatePaymentLink(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
      const { generateCustomerLinkToken, buildCustomerLink } = require('../utils/templateHelper');

      // Generate token unik (retry kalau bentrok — sangat jarang).
      let token = null;
      for (let i = 0; i < 5; i++) {
        const candidate = generateCustomerLinkToken();
        const exists = await Customer.findOne({ where: { public_link_token: candidate } });
        if (!exists) { token = candidate; break; }
      }
      if (!token) return res.status(500).json({ success: false, message: 'Gagal membuat token unik, coba lagi' });

      const wasExisting = !!customer.public_link_token;
      customer.public_link_token = token;
      await customer.save();
      res.json({
        success: true,
        message: wasExisting ? 'Link diperbarui. Link lama tidak berlaku lagi.' : 'Link permanen dibuat.',
        data: { token, url: buildCustomerLink(token), regenerated: wasExisting }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // DELETE /customers/:id/payment-link → cabut (revoke) link
  async revokePaymentLink(req, res) {
    try {
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
      customer.public_link_token = null;
      await customer.save();
      res.json({ success: true, message: 'Link permanen dicabut.' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // POST /customers/payment-link/generate-all → buat link untuk SEMUA pelanggan
  // yang belum punya token. Idempotent: pelanggan yang sudah punya link
  // DILEWATI (tidak di-regenerate), jadi link lama tetap valid.
  async generateAllPaymentLinks(req, res) {
    try {
      const { generateCustomerLinkToken } = require('../utils/templateHelper');
      const { Op } = require('sequelize');
      const targets = await Customer.findAll({
        where: { [Op.or]: [{ public_link_token: null }, { public_link_token: '' }] },
        attributes: ['id']
      });

      let created = 0, failed = 0;
      for (const c of targets) {
        try {
          let token = null;
          for (let i = 0; i < 5; i++) {
            const candidate = generateCustomerLinkToken();
            const dup = await Customer.findOne({ where: { public_link_token: candidate } });
            if (!dup) { token = candidate; break; }
          }
          if (!token) { failed++; continue; }
          await Customer.update({ public_link_token: token }, { where: { id: c.id } });
          created++;
        } catch (_) { failed++; }
      }
      res.json({
        success: true,
        message: 'Link dibuat untuk ' + created + ' pelanggan' + (failed ? (', gagal ' + failed) : '') + '.',
        data: { created, failed, skipped_existing: true }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

// ════════════════════════════════════════════════════════════════
// HELPER: Parse komponen wilayah dari teks alamat
// Mengenali pola hasil composeAddr maupun variasi umum:
//   "Jl. X No.Y, RT../RW.., Kel. DESA, Kec. KEC, KABUPATEN/KOTA, PROVINSI"
// Pencocokan toleran (case-insensitive, beberapa singkatan).
// ════════════════════════════════════════════════════════════════
function parseAreaFromAddress(address) {
  const out = { province: '', regency: '', district: '', village: '' };
  if (!address) return out;
  const segs = String(address).split(',').map(s => s.trim()).filter(Boolean);

  for (const seg of segs) {
    const low = seg.toLowerCase();
    // Desa/Kelurahan
    if (!out.village && /^(kel\.|kelurahan|desa)\s+/i.test(seg)) {
      out.village = seg.replace(/^(kel\.|kelurahan|desa)\s+/i, '').trim();
      continue;
    }
    // Kecamatan
    if (!out.district && /^(kec\.|kecamatan)\s+/i.test(seg)) {
      out.district = seg.replace(/^(kec\.|kecamatan)\s+/i, '').trim();
      continue;
    }
    // Kabupaten / Kota
    if (!out.regency && /^(kab\.|kabupaten|kota|kota adm\.|kotamadya)\s+/i.test(seg)) {
      out.regency = seg.trim();
      continue;
    }
    // Provinsi — biasanya segmen terakhir; tangkap kata kunci umum
    if (!out.province && /^(prov\.|provinsi)\s+/i.test(seg)) {
      out.province = seg.replace(/^(prov\.|provinsi)\s+/i, '').trim();
      continue;
    }
  }

  // Heuristik tambahan: kalau provinsi belum kebawa kata kunci, pakai segmen
  // terakhir jika terlihat seperti nama provinsi (huruf saja, bukan RT/RW/No).
  if (!out.province && segs.length) {
    const last = segs[segs.length - 1];
    if (last && !/\d/.test(last) && !/^(kel\.|kec\.|kab\.|kota|rt|rw)/i.test(last)) {
      out.province = last.trim();
    }
  }
  // Kalau regency masih kosong tapi ada segmen sebelum provinsi yang tampak nama kota
  if (!out.regency && segs.length >= 2) {
    const cand = segs[segs.length - 2];
    if (cand && !/\d/.test(cand) && !/^(kel\.|kec\.|rt|rw|jl)/i.test(cand)) {
      out.regency = cand.trim();
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// HELPER: Kirim WA welcome ke pelanggan baru
// Load template kategori 'welcome' yang aktif (latest), render placeholder,
// kirim via WAService. Best-effort — kegagalan tidak throw.
// ════════════════════════════════════════════════════════════════
function _renderWelcomeTemplate(content, ctx) {
  if (!content) return '';
  let out = String(content);
  Object.keys(ctx || {}).forEach(k => {
    const val = ctx[k] == null ? '' : String(ctx[k]);
    out = out.split(`{${k}}`).join(val);
  });
  return out;
}

const DEFAULT_WELCOME_TPL = `🎉 *Selamat Datang di {perusahaan}!*

Yth. *{nama}*,

Akun layanan internet Anda telah berhasil dibuat. Berikut detail akun Anda:

📋 ID Pelanggan: *{cid}*
📦 Paket: {paket}
📅 Tanggal Pemasangan: {tgl_install}
📞 Hubungi kami: {phone_cs}

Tim kami akan segera menghubungi Anda untuk konfirmasi pemasangan.

Terima kasih telah memilih layanan kami 🙏
_${`{perusahaan}`}_`;

async function sendWelcomeWA(customer) {
  const { sequelize, WaSession } = require('../models');

  // Cek toggle setting (default: ON)
  try {
    const sett = await sequelize.query(
      "SELECT value FROM app_settings WHERE `key`='welcome_wa_enable'",
      { type: sequelize.QueryTypes.SELECT }
    );
    if (sett[0] && sett[0].value === '0') return { sent: false, reason: 'disabled' };
  } catch(_) { /* abaikan, default-nya kirim */ }

  // Cek WA session aktif
  const GatewayService = require('../services/GatewayService');
  const session = await GatewayService.getDefaultSendingSession();
  if (!session) return { sent: false, reason: 'no_wa_session' };

  // Format helpers
  const fmtDate = (d) => {
    if (!d) return '-';
    try {
      const dt = new Date(d);
      const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
    } catch(_) { return String(d); }
  };
  const fmtIDR = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

  // Build context
  const pkg = customer.package || {};

  // Hitung jatuh tempo invoice pertama
  // Prioritas: customer.due_date → installation_date + 30 hari → today + 30 hari
  let jatuhTempoDate;
  if (customer.due_date) {
    jatuhTempoDate = new Date(customer.due_date);
  } else if (customer.installation_date) {
    jatuhTempoDate = new Date(customer.installation_date);
    jatuhTempoDate.setDate(jatuhTempoDate.getDate() + 30);
  } else {
    jatuhTempoDate = new Date();
    jatuhTempoDate.setDate(jatuhTempoDate.getDate() + 30);
  }

  const ctx = {
    nama:           customer.name || '',
    cid:            customer.customer_id || '',
    phone:          customer.phone || '',
    nohp:           customer.phone || '',
    email:          customer.email || '-',
    alamat:         customer.address || '-',
    paket:          pkg.name || '-',
    harga_paket:    fmtIDR(pkg.price),
    tgl_install:    fmtDate(customer.installation_date) === '-' ? fmtDate(new Date()) : fmtDate(customer.installation_date),
    jatuh_tempo:    fmtDate(jatuhTempoDate),
    tgl_jatuh_tempo:fmtDate(jatuhTempoDate),  // alias
    // Tetap dukung placeholder lama (kalau user pakai di template)
    pppoe_user:     customer.pppoe_username || '-',
    static_ip:      customer.static_ip || '-',
    phone_cs:       process.env.COMPANY_PHONE || process.env.SUPPORT_PHONE || '-',
    perusahaan:     await getCompanyName()
  };

  // Load template welcome aktif
  let tplContent = null;
  try {
    const rows = await sequelize.query(
      `SELECT content, message FROM wa_templates
        WHERE category = 'welcome' AND is_active = 1
        ORDER BY updated_at DESC LIMIT 1`,
      { type: sequelize.QueryTypes.SELECT }
    );
    tplContent = rows[0]?.content || rows[0]?.message || null;
  } catch(_) {}

  if (!tplContent) tplContent = DEFAULT_WELCOME_TPL;
  const msg = _renderWelcomeTemplate(tplContent, ctx);

  // Send via Gateway (provider-aware)
  try {
    const GatewayService = require('../services/GatewayService');
    await GatewayService.sendMessage(session.session_id, customer.phone, msg, null);

    // Update usage counter (best-effort)
    try {
      await sequelize.query(
        `UPDATE wa_templates SET usage_count = usage_count + 1
          WHERE category = 'welcome' AND is_active = 1
          ORDER BY updated_at DESC LIMIT 1`
      );
    } catch(_) {}

    return { sent: true };
  } catch (e) {
    console.error('[Customer] WAService.sendMessage error:', e.message);
    return { sent: false, reason: 'send_failed' };
  }
}

// ════════════════════════════════════════════════════════════════
// AUTO-MIGRATION: tambah 'welcome' ke ENUM wa_templates.category +
// auto-seed default template welcome. Idempotent.
// ════════════════════════════════════════════════════════════════
async function ensureWelcomeTemplate() {
  try {
    const { sequelize } = require('../models');

    // 1. Expand ENUM kalau belum ada 'welcome'
    try {
      const [enumRow] = await sequelize.query(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wa_templates' AND COLUMN_NAME = 'category'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (enumRow && !String(enumRow.COLUMN_TYPE || '').includes("'welcome'")) {
        await sequelize.query(
          `ALTER TABLE wa_templates MODIFY COLUMN category
           ENUM('reminder_before','reminder_due','reminder_overdue',
                'broadcast','custom','payment_confirm','isolir','restore','welcome')
           NOT NULL DEFAULT 'custom'`
        );
        console.log('[CustomerController] wa_templates.category ENUM expanded with welcome');
      }
    } catch(e) {
      console.error('[CustomerController] expand ENUM error:', e.message);
    }

    // 2. Auto-seed default template welcome kalau belum ada
    try {
      const existing = await sequelize.query(
        `SELECT id FROM wa_templates WHERE category='welcome' LIMIT 1`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (existing.length === 0) {
        const variables = ['nama','cid','phone','email','alamat','paket','harga_paket','tgl_install','pppoe_user','static_ip','perusahaan','phone_cs'];
        await sequelize.query(
          `INSERT INTO wa_templates (name, category, content, message, variables, is_active, created_at, updated_at)
           VALUES (?, 'welcome', ?, ?, ?, 1, NOW(), NOW())`,
          { replacements: ['Notifikasi Pelanggan Baru', DEFAULT_WELCOME_TPL, DEFAULT_WELCOME_TPL, JSON.stringify(variables)] }
        );
        console.log('[CustomerController] seeded default welcome template');
      }
    } catch(e) {
      console.error('[CustomerController] seed welcome template error:', e.message);
    }

    // 3. Auto-seed setting toggle welcome_wa_enable (default ON)
    try {
      const sett = await sequelize.query(
        `SELECT value FROM app_settings WHERE \`key\`='welcome_wa_enable'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (sett.length === 0) {
        await sequelize.query(
          `INSERT INTO app_settings (\`key\`, value, created_at, updated_at)
           VALUES ('welcome_wa_enable', '1', NOW(), NOW())`
        ).catch(() => {});
      }
    } catch(_) {}
  } catch(e) {
    console.error('[CustomerController] ensureWelcomeTemplate error:', e.message);
  }
}

// Jalankan migration di module load
ensureWelcomeTemplate();

module.exports = new CustomerController();