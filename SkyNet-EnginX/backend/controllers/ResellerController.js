/**
 * ResellerController.js — API untuk Dashboard Reseller Voucher Hotspot.
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint yang dipakai oleh halaman /reseller (akun reseller, bukan admin):
 *   - login / logout / restore-cookie  (auth)
 *   - dashboard      → saldo + ringkasan statistik
 *   - packages       → daftar paket voucher yang boleh dijual
 *   - generate       → buat voucher (potong saldo, transaksi atomik)
 *   - history        → riwayat transaksi (topup & pembelian voucher)
 *   - report         → laporan penjualan (range tanggal)
 *
 * KRITIS — Atomicity saldo:
 * generate voucher membungkus pemotongan saldo + pencatatan ledger dalam satu
 * transaksi DB dengan row-lock (SELECT ... FOR UPDATE). Voucher baru dibuat di
 * MikroTik HANYA setelah saldo berhasil dikunci & dipotong. Kalau MikroTik
 * gagal sebagian, sisa yang gagal di-refund otomatis.
 */
const jwt = require('jsonwebtoken');
const { Op, fn, col, literal } = require('sequelize');
const {
  sequelize, Reseller, ResellerVoucherPackage, ResellerTransaction, ResellerTopup, Device,
  ResellerPackagePrice, ResellerVoucherLog, ResellerPromo, ResellerPromoRedemption
} = require('../models');
const HotspotService = require('../services/HotspotService');
const ResellerTopupService = require('../services/ResellerTopupService');
const ResellerPricingService = require('../services/ResellerPricingService');
const ResellerPromoService = require('../services/ResellerPromoService');
const path = require('path');
const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const { resellerSecret } = require('../middleware/resellerAuth');
const logger = require('../utils/logger');

// Deteksi HTTPS yang sadar reverse-proxy (aaPanel/nginx). Di belakang
// proxy, req.secure sering false walau HTTPS, kecuali 'trust proxy' diset.
// Cek juga header x-forwarded-proto agar cookie tetap dapat flag Secure.
function isSecure(req) {
  if (req.secure) return true;
  const xfp = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return xfp === 'https';
}

const COOKIE_OPTS = (req) => ({
  httpOnly: true,
  secure: isSecure(req),
  sameSite: 'lax',
  path: '/reseller',
  maxAge: 86400000 // 24 jam
});

function signToken(reseller) {
  return jwt.sign(
    { id: reseller.id, code: reseller.code, type: 'reseller' },
    resellerSecret(),
    { expiresIn: '24h' }
  );
}

// Resolve HotspotService untuk router milik reseller (atau default).
async function resellerHotspotService(reseller) {
  const mt = await getMikrotikInstanceByDevice(reseller.device_id || null);
  return new HotspotService(mt);
}

// Tandai voucher milik reseller di comment MikroTik (lihat generate()).
// Format comment: "... | Reseller: <code>". Dipakai untuk memfilter user
// hotspot yang benar-benar dibuat reseller ini.
function _isResellerUser(u, code) {
  if (!code) return false;
  const c = (u.comment || '');
  return c.indexOf('Reseller: ' + code) !== -1;
}

// Sebuah voucher dianggap "terpakai" kalau sudah pernah login (uptime > 0)
// atau sudah memakai kuota (bytesIn/Out > 0). Selain itu "belum terpakai".
function _voucherUsed(u) {
  const up = String(u.uptime || '0s');
  const hasUptime = up && up !== '0s' && up !== '00:00:00' && up !== '0';
  const bytes = (Number(u.bytesIn) || 0) + (Number(u.bytesOut) || 0);
  return hasUptime || bytes > 0;
}

// Ubah durasi MikroTik (mis. "1h30m", "2d", "00:45:10") → detik.
function _parseMtDuration(str) {
  if (!str) return 0;
  str = String(str).trim();
  if (!str || str === '0s' || str === '0') return 0;
  // Format jam:menit:detik
  if (/^\d{1,3}:\d{2}:\d{2}$/.test(str)) {
    const [h, m, s] = str.split(':').map(Number);
    return h * 3600 + m * 60 + s;
  }
  // Format token: 1w2d3h4m5s
  let total = 0;
  const re = /(\d+)([wdhms])/g; let m;
  const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  while ((m = re.exec(str)) !== null) total += parseInt(m[1]) * (mult[m[2]] || 0);
  return total;
}

// Klasifikasi status voucher:
//   active   → sedang online (ada sesi aktif)
//   expired  → sudah habis masa pakainya (uptime ≥ limit-uptime) atau
//              di-nonaktifkan otomatis setelah terpakai
//   used     → pernah dipakai, tapi belum habis & tidak online
//   unused   → belum pernah dipakai
function _voucherStatus(u, isActive) {
  if (isActive) return 'active';
  const used = _voucherUsed(u);
  if (!used) return 'unused';
  const limit = _parseMtDuration(u.limitUptime);
  const consumed = _parseMtDuration(u.uptime);
  // limit-uptime habis → expired (beri toleransi 2 detik)
  if (limit > 0 && consumed > 0 && consumed >= (limit - 2)) return 'expired';
  // user dinonaktifkan setelah terpakai → anggap expired/habis
  if (u.disabled) return 'expired';
  return 'used';
}

// Ambil daftar voucher (hotspot user) milik reseller + status pakai + sesi aktif.
// Mengembalikan { users: [...], active: Set<username>, mt, svc } supaya bisa
// dipakai ulang oleh beberapa endpoint tanpa query MikroTik berkali-kali.
async function _fetchResellerVouchers(reseller) {
  const svc = await resellerHotspotService(reseller);
  const [users, sessions] = await Promise.all([
    svc.getUsers({}).catch(() => []),
    svc.getActiveSessions().catch(() => [])
  ]);
  const mine = (users || []).filter(u => _isResellerUser(u, reseller.code));
  const activeSet = new Set((sessions || []).map(s => s.user));
  return { svc, users: mine, activeSet };
}

// Tandai top-up gateway yang menggantung di 'pending' melewati batas waktu
// (expires_at) sebagai 'expired'. Dipanggil saat reseller membuka riwayat /
// polling status — ringan, idempotent, dan tidak menyentuh saldo.
// Hanya berlaku untuk metode gateway (manual/qris menunggu verifikasi admin).
async function _expireStalePendingTopups(resellerId) {
  try {
    const now = new Date();
    const [n] = await ResellerTopup.update(
      { status: 'expired' },
      {
        where: {
          reseller_id: resellerId,
          method: 'gateway',
          status: 'pending',
          credited: { [Op.not]: true },
          expires_at: { [Op.ne]: null, [Op.lt]: now }
        }
      }
    );
    if (n) logger.info(`[ResellerTopup] auto-expired ${n} pending gateway top-up reseller#${resellerId}`);
  } catch (e) {
    logger.warn('Auto-expire pending top-up skip: ' + e.message);
  }
}

const ResellerController = {

  // ─── LOGIN ──────────────────────────────────────────────────
  async login(req, res) {
    try {
      const { code, password } = req.body;
      if (!code || !password) {
        return res.status(400).json({ success: false, message: 'Kode & password wajib diisi' });
      }
      const reseller = await Reseller.findOne({ where: { code: String(code).trim() } });
      if (!reseller) {
        // Pesan generik (anti-enumerasi): jangan bocorkan apakah kode ada.
        return res.status(401).json({ success: false, message: 'Kode reseller atau password salah' });
      }
      const valid = await reseller.validatePassword(password);
      if (!valid) {
        return res.status(401).json({ success: false, message: 'Kode reseller atau password salah' });
      }
      if (!reseller.is_active) {
        return res.status(403).json({ success: false, message: 'Akun dinonaktifkan. Hubungi admin.' });
      }

      await reseller.update({ last_login: new Date() });
      const token = signToken(reseller);
      res.cookie('reseller_token', token, COOKIE_OPTS(req));

      res.json({
        success: true,
        token,
        reseller: {
          id: reseller.id, code: reseller.code, name: reseller.name,
          balance: Number(reseller.balance)
        }
      });
    } catch (e) {
      logger.error('Reseller login error:', e.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async logout(req, res) {
    res.clearCookie('reseller_token', {
      httpOnly: true, secure: isSecure(req), sameSite: 'lax', path: '/reseller'
    });
    res.json({ success: true, message: 'Logged out' });
  },

  // Restore HttpOnly cookie dari Bearer token (auto-login halaman /reseller/login)
  async restoreCookie(req, res) {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Bearer token required' });
      }
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, resellerSecret());
      if (decoded.type !== 'reseller') {
        return res.status(401).json({ success: false, message: 'Invalid token type' });
      }
      const reseller = await Reseller.findByPk(decoded.id);
      if (!reseller || !reseller.is_active) {
        return res.status(401).json({ success: false, message: 'Akun dinonaktifkan' });
      }
      res.cookie('reseller_token', token, COOKIE_OPTS(req));
      res.json({ success: true, redirect: '/reseller/dashboard' });
    } catch (e) {
      res.status(401).json({ success: false, message: 'Token invalid atau expired' });
    }
  },

  // ─── DASHBOARD (ringkasan) ──────────────────────────────────
  async dashboard(req, res) {
    try {
      const r = req.reseller;
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

      // Agregat penjualan voucher (type=purchase, amount negatif).
      const [todayAgg, monthAgg, totalAgg] = await Promise.all([
        ResellerTransaction.findOne({
          where: { reseller_id: r.id, type: 'purchase', createdAt: { [Op.gte]: startOfToday } },
          attributes: [
            [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
            [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'total']
          ], raw: true
        }),
        ResellerTransaction.findOne({
          where: { reseller_id: r.id, type: 'purchase', createdAt: { [Op.gte]: startOfMonth } },
          attributes: [
            [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
            [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'total']
          ], raw: true
        }),
        ResellerTransaction.findOne({
          where: { reseller_id: r.id, type: 'purchase' },
          attributes: [
            [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
            [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'total']
          ], raw: true
        })
      ]);

      // Nama brand untuk tampilan reseller: company_name → app_name → fallback
      let brandName = 'FLAYNET Reseller';
      try {
        const { AppSetting } = require('../models');
        const brandRows = await AppSetting.findAll({ where: { key: ['company_name', 'app_name'] } });
        const bm = {};
        brandRows.forEach(s => { bm[s.key] = (s.value || '').trim(); });
        brandName = bm.company_name || bm.app_name || brandName;
      } catch (_) {}

      // Peringatan saldo menipis: ambang dinamis = harga modal voucher
      // TERMURAH untuk reseller ini. Kalau saldo < (cheapest × 3) → warning.
      // Artinya: tidak cukup beli ~3 voucher termurah lagi.
      let cheapest = 0, lowBalance = false, canBuyCheapest = 0;
      try {
        const pkgs = await ResellerVoucherPackage.findAll({ where: { is_active: true } });
        if (pkgs.length) {
          const costMap = await ResellerPricingService.effectiveCostMap(r, pkgs);
          const prices = pkgs.map(p => Number(costMap[p.id] && costMap[p.id].effective) || 0).filter(v => v > 0);
          if (prices.length) {
            cheapest = Math.min(...prices);
            canBuyCheapest = cheapest > 0 ? Math.floor(Number(r.balance) / cheapest) : 0;
            lowBalance = Number(r.balance) < cheapest * 3;
          }
        }
      } catch (_) { /* non-fatal: tanpa warning */ }

      res.json({
        success: true,
        data: {
          reseller: {
            id: r.id, code: r.code, name: r.name, phone: r.phone,
            balance: Number(r.balance), max_per_batch: r.max_per_batch,
            device_name: r.device ? r.device.name : 'Default Router',
            brand_name: brandName
          },
          low_balance: {
            warn: lowBalance,
            cheapest_price: cheapest,
            can_buy: canBuyCheapest
          },
          stats: {
            today:  { vouchers: Number(todayAgg.vcount), spent: Number(todayAgg.total) },
            month:  { vouchers: Number(monthAgg.vcount), spent: Number(monthAgg.total) },
            total:  { vouchers: Number(totalAgg.vcount), spent: Number(totalAgg.total) }
          }
        }
      });
    } catch (e) {
      logger.error('Reseller dashboard error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── PAKET VOUCHER ──────────────────────────────────────────
  async packages(req, res) {
    try {
      const r = req.reseller;
      // Paket aktif yang cocok device reseller (atau paket global device_id null).
      const where = {
        is_active: true,
        [Op.or]: [{ device_id: null }, { device_id: r.device_id || null }]
      };
      const list = await ResellerVoucherPackage.findAll({
        where, order: [['sort_order', 'ASC'], ['cost_price', 'ASC']]
      });
      // Harga modal efektif per paket untuk reseller ini (#2).
      const costMap = await ResellerPricingService.effectiveCostMap(r, list);
      res.json({
        success: true,
        data: list.map(p => {
          const eff = costMap[p.id] || { effective: Number(p.cost_price), base: Number(p.cost_price), source: 'default' };
          return {
            id: p.id, name: p.name, profile: p.mikrotik_profile,
            duration_label: p.duration_label,
            cost_price: eff.effective,                 // harga yang dipotong dari saldo
            base_cost_price: eff.base,                 // harga modal default paket
            price_source: eff.source,                  // override|discount|default
            sell_price: Number(p.sell_price), prefix: p.prefix, code_length: p.code_length
          };
        })
      });
    } catch (e) {
      logger.error('Reseller packages error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── GENERATE VOUCHER (potong saldo, atomik) ────────────────
  async generate(req, res) {
    const r = req.reseller;
    let { package_id, count } = req.body;
    count = parseInt(count);

    if (!package_id) return res.status(400).json({ success: false, message: 'Paket wajib dipilih' });
    if (!count || count < 1) return res.status(400).json({ success: false, message: 'Jumlah voucher minimal 1' });
    if (count > (r.max_per_batch || 100)) {
      return res.status(400).json({ success: false, message: `Maksimal ${r.max_per_batch} voucher per generate` });
    }

    // Validasi paket
    const pkg = await ResellerVoucherPackage.findByPk(package_id);
    if (!pkg || !pkg.is_active) {
      return res.status(404).json({ success: false, message: 'Paket tidak ditemukan / nonaktif' });
    }

    // Harga modal efektif untuk reseller ini (#2: markup/diskon fleksibel).
    const priced = await ResellerPricingService.effectiveCost(r, pkg);
    const unitPrice = priced.effective;
    const totalCost = unitPrice * count;

    // ── Fase 1: kunci & potong saldo dalam transaksi DB ──────────
    // SELECT ... FOR UPDATE menghindari race kalau reseller generate dari 2 tab.
    let txnId, balanceBefore, balanceAfter;
    try {
      await sequelize.transaction(async (t) => {
        const locked = await Reseller.findByPk(r.id, {
          lock: t.LOCK.UPDATE, transaction: t
        });
        balanceBefore = Number(locked.balance);
        if (balanceBefore < totalCost) {
          const err = new Error(
            `Saldo tidak cukup. Butuh Rp ${totalCost.toLocaleString('id-ID')}, ` +
            `saldo Rp ${balanceBefore.toLocaleString('id-ID')}.`
          );
          err.code = 'INSUFFICIENT_BALANCE';
          throw err;
        }
        balanceAfter = balanceBefore - totalCost;
        await locked.update({ balance: balanceAfter }, { transaction: t });

        const txn = await ResellerTransaction.create({
          reseller_id: r.id, type: 'purchase',
          amount: -totalCost, balance_before: balanceBefore, balance_after: balanceAfter,
          description: `Generate ${count} voucher — ${pkg.name}`,
          package_id: pkg.id, package_name: pkg.name,
          voucher_count: count, unit_price: unitPrice,
          vouchers: null // diisi setelah generate MikroTik sukses
        }, { transaction: t });
        txnId = txn.id;
      });
    } catch (e) {
      if (e.code === 'INSUFFICIENT_BALANCE') {
        return res.status(400).json({ success: false, message: e.message, code: 'INSUFFICIENT_BALANCE' });
      }
      logger.error('Reseller generate (saldo) error:', e.message);
      return res.status(500).json({ success: false, message: 'Gagal memproses saldo: ' + e.message });
    }

    // ── Fase 2: generate voucher di MikroTik ─────────────────────
    let result;
    try {
      const svc = await resellerHotspotService(r);
      const comment =
        `Generated ${new Date().toLocaleDateString('id-ID')} | Profile: ${pkg.mikrotik_profile}` +
        ` | Rp ${Number(pkg.sell_price || pkg.cost_price).toLocaleString('id-ID')}` +
        ` | Reseller: ${r.code}`;

      result = await svc.generateVouchers({
        count,
        profile: pkg.mikrotik_profile,
        server: r.hotspot_server || 'all',
        prefix: pkg.prefix || 'v',
        passwordLength: pkg.code_length || 5,
        comment,
        limitUptime: pkg.limit_uptime || '',
        limitBytesTotal: Number(pkg.limit_bytes_total) || 0,
        price: Number(pkg.sell_price || pkg.cost_price),
        soldTo: ''
      });
    } catch (e) {
      // MikroTik total gagal → refund penuh & batalkan transaksi.
      logger.error('Reseller generate (mikrotik) error, refunding:', e.message);
      await ResellerController._refund(r.id, txnId, totalCost, balanceAfter,
        `Refund — generate voucher gagal (${pkg.name})`);
      return res.status(502).json({
        success: false,
        message: 'Gagal membuat voucher di router. Saldo telah dikembalikan. ' + e.message
      });
    }

    const made = result.vouchers || [];
    const failedCount = count - made.length;

    // Refund sebagian kalau ada voucher yang gagal dibuat.
    if (failedCount > 0) {
      const refundAmount = unitPrice * failedCount;
      await ResellerController._refund(r.id, null, refundAmount, null,
        `Refund ${failedCount} voucher gagal — ${pkg.name}`);
    }

    // Simpan daftar voucher ke transaksi pembelian (untuk cetak ulang).
    try {
      await ResellerTransaction.update(
        {
          vouchers: JSON.stringify(made),
          voucher_count: made.length,
          amount: -(unitPrice * made.length),
          description: `Generate ${made.length} voucher — ${pkg.name}` +
            (failedCount > 0 ? ` (${failedCount} gagal, di-refund)` : '')
        },
        { where: { id: txnId } }
      );
    } catch (_) { /* non-fatal */ }

    // ── Audit voucher (#7): catat tiap voucher yang dibuat ───────
    try {
      if (made.length) {
        const rows = made.map(v => ({
          reseller_id: r.id,
          transaction_id: txnId,
          package_id: pkg.id,
          package_name: pkg.name,
          username: v.username,
          password: v.password || null,
          profile: v.profile || pkg.mikrotik_profile,
          server: r.hotspot_server || 'all',
          device_id: r.device_id || null,
          sell_price: Number(pkg.sell_price || pkg.cost_price),
          cost_price: unitPrice,
          status: 'created'
        }));
        await ResellerVoucherLog.bulkCreate(rows);
      }
    } catch (e) { logger.warn('Voucher audit log skip:', e.message); }

    // Saldo terbaru
    const fresh = await Reseller.findByPk(r.id);

    res.json({
      success: true,
      message: `${made.length} voucher berhasil dibuat` +
        (failedCount > 0 ? `, ${failedCount} gagal (saldo dikembalikan)` : ''),
      data: {
        vouchers: made,
        package: { id: pkg.id, name: pkg.name, sell_price: Number(pkg.sell_price) },
        created: made.length,
        failed: failedCount,
        balance: Number(fresh.balance),
        transaction_id: txnId
      }
    });
  },

  // Helper internal — refund saldo (dipakai saat generate gagal).
  async _refund(resellerId, originalTxnId, amount, _unusedBalanceAfter, desc) {
    try {
      await sequelize.transaction(async (t) => {
        const locked = await Reseller.findByPk(resellerId, { lock: t.LOCK.UPDATE, transaction: t });
        const before = Number(locked.balance);
        const after = before + Number(amount);
        await locked.update({ balance: after }, { transaction: t });
        await ResellerTransaction.create({
          reseller_id: resellerId, type: 'refund',
          amount: Number(amount), balance_before: before, balance_after: after,
          description: desc
        }, { transaction: t });
      });
    } catch (e) {
      logger.error('Reseller refund FAILED (manual fix needed):', e.message);
    }
  },

  // ─── RIWAYAT TRANSAKSI ──────────────────────────────────────
  async history(req, res) {
    try {
      const r = req.reseller;
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, parseInt(req.query.limit) || 20);
      const type = req.query.type; // optional filter

      const where = { reseller_id: r.id };
      if (type && ['topup', 'purchase', 'adjust', 'refund'].includes(type)) where.type = type;

      const { count, rows } = await ResellerTransaction.findAndCountAll({
        where, order: [['createdAt', 'DESC']],
        limit, offset: (page - 1) * limit
      });

      res.json({
        success: true,
        data: rows.map(tx => ({
          id: tx.id, type: tx.type, amount: Number(tx.amount),
          balance_after: Number(tx.balance_after),
          description: tx.description, package_name: tx.package_name,
          voucher_count: tx.voucher_count,
          unit_price: tx.unit_price != null ? Number(tx.unit_price) : null,
          created_at: tx.createdAt
        })),
        pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
      });
    } catch (e) {
      logger.error('Reseller history error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Detail satu transaksi pembelian (untuk lihat / cetak ulang voucher).
  async transactionDetail(req, res) {
    try {
      const r = req.reseller;
      const tx = await ResellerTransaction.findOne({
        where: { id: req.params.id, reseller_id: r.id }
      });
      if (!tx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
      let vouchers = [];
      try { vouchers = tx.vouchers ? JSON.parse(tx.vouchers) : []; } catch (_) {}
      // Ambil harga jual paket (untuk dicetak di voucher). Paket bisa sudah
      // dihapus → fallback ke unit_price (harga modal) kalau perlu.
      let sellPrice = null;
      if (tx.package_id) {
        const pkg = await ResellerVoucherPackage.findByPk(tx.package_id);
        if (pkg) sellPrice = Number(pkg.sell_price);
      }
      res.json({
        success: true,
        data: {
          id: tx.id, type: tx.type, amount: Number(tx.amount),
          description: tx.description, package_name: tx.package_name,
          voucher_count: tx.voucher_count,
          unit_price: tx.unit_price != null ? Number(tx.unit_price) : null,
          sell_price: sellPrice,
          created_at: tx.createdAt, vouchers
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── LAPORAN PENJUALAN (range tanggal) ──────────────────────
  async report(req, res) {
    try {
      const r = req.reseller;
      const from = req.query.from ? new Date(req.query.from + 'T00:00:00') : null;
      const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59') : null;

      const where = { reseller_id: r.id, type: 'purchase' };
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = from;
        if (to)   where.createdAt[Op.lte] = to;
      }

      // Ringkasan per paket (modal terpakai = ABS(amount) yang dipotong saldo)
      const perPackage = await ResellerTransaction.findAll({
        where,
        attributes: [
          'package_id',
          'package_name',
          [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
          [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'total'],
          [fn('COUNT', col('id')), 'batches']
        ],
        group: ['package_id', 'package_name'],
        order: [[literal('total'), 'DESC']],
        raw: true
      });

      // Ambil harga jual paket untuk hitung keuntungan (sell - cost) * qty.
      const pkgIds = perPackage.map(p => p.package_id).filter(Boolean);
      let sellMap = {};
      if (pkgIds.length) {
        const pkgs = await ResellerVoucherPackage.findAll({
          where: { id: { [Op.in]: pkgIds } },
          attributes: ['id', 'sell_price', 'cost_price'], raw: true
        });
        pkgs.forEach(p => { sellMap[p.id] = { sell: Number(p.sell_price), cost: Number(p.cost_price) }; });
      }

      const perPackageOut = perPackage.map(p => {
        const vcount = Number(p.vcount);
        const modal = Number(p.total);
        // Estimasi omzet & untung dari harga jual paket saat ini.
        const sp = sellMap[p.package_id];
        const revenue = sp ? sp.sell * vcount : modal; // fallback: tanpa untung
        const profit = Math.max(0, revenue - modal);
        return {
          package_id: p.package_id,
          package_name: p.package_name || '(tanpa nama)',
          vouchers: vcount,
          modal,
          revenue,
          profit,
          batches: Number(p.batches)
        };
      });

      const totalVouchers = perPackageOut.reduce((s, p) => s + p.vouchers, 0);
      const totalSpent    = perPackageOut.reduce((s, p) => s + p.modal, 0);
      const totalRevenue  = perPackageOut.reduce((s, p) => s + p.revenue, 0);
      const totalProfit   = perPackageOut.reduce((s, p) => s + p.profit, 0);

      // Total topup pada range (untuk gambaran cashflow)
      const topupWhere = { reseller_id: r.id, type: 'topup' };
      if (where.createdAt) topupWhere.createdAt = where.createdAt;
      const topupAgg = await ResellerTransaction.findOne({
        where: topupWhere,
        attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
        raw: true
      });

      // Voucher terpakai / belum (dari MikroTik). Best-effort: kalau router
      // tidak terjangkau, kembalikan null supaya UI tahu data tak tersedia.
      let usage = null;
      try {
        const { users, activeSet } = await _fetchResellerVouchers(r);
        let used = 0, unused = 0, active = 0, expired = 0;
        for (const u of users) {
          const st = _voucherStatus(u, activeSet.has(u.name));
          if (st === 'active') active++;
          else if (st === 'expired') expired++;
          else if (st === 'used') used++;
          else unused++;
        }
        usage = { total: users.length, used, unused, active, expired };
      } catch (e) {
        logger.warn('Reseller report usage (mikrotik) unavailable:', e.message);
      }

      res.json({
        success: true,
        data: {
          summary: {
            total_vouchers: totalVouchers,
            total_modal: totalSpent,
            total_revenue: totalRevenue,
            total_profit: totalProfit,
            total_topup: Number(topupAgg.total),
            current_balance: Number(r.balance)
          },
          usage, // {total, used, unused, active} | null
          per_package: perPackageOut
        }
      });
    } catch (e) {
      logger.error('Reseller report error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── DATA CHART (penjualan harian + komposisi paket) ────────
  // Dipakai untuk grafik ApexCharts di dashboard reseller.
  async chartData(req, res) {
    try {
      const r = req.reseller;
      const days = Math.min(90, Math.max(7, parseInt(req.query.days) || 14));
      const start = new Date(); start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (days - 1));

      const rows = await ResellerTransaction.findAll({
        where: {
          reseller_id: r.id, type: 'purchase',
          createdAt: { [Op.gte]: start }
        },
        attributes: [
          [fn('DATE', col('created_at')), 'd'],
          [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount'],
          [fn('COALESCE', fn('SUM', literal('ABS(amount)')), 0), 'modal']
        ],
        group: [literal('DATE(created_at)')],
        order: [[literal('DATE(created_at)'), 'ASC']],
        raw: true
      });

      // Petakan ke deret lengkap (isi 0 untuk hari tanpa transaksi).
      const map = {};
      rows.forEach(x => { map[String(x.d)] = { v: Number(x.vcount), m: Number(x.modal) }; });
      const labels = [], vouchers = [], modal = [];
      for (let i = 0; i < days; i++) {
        const dt = new Date(start); dt.setDate(start.getDate() + i);
        const key = dt.toISOString().slice(0, 10);
        labels.push(key);
        vouchers.push(map[key] ? map[key].v : 0);
        modal.push(map[key] ? map[key].m : 0);
      }

      // Komposisi paket (untuk donut).
      const perPackage = await ResellerTransaction.findAll({
        where: { reseller_id: r.id, type: 'purchase', createdAt: { [Op.gte]: start } },
        attributes: [
          'package_name',
          [fn('COALESCE', fn('SUM', col('voucher_count')), 0), 'vcount']
        ],
        group: ['package_name'],
        order: [[literal('vcount'), 'DESC']],
        raw: true
      });

      res.json({
        success: true,
        data: {
          days,
          labels,
          vouchers,
          modal,
          packages: perPackage.map(p => ({
            name: p.package_name || '(tanpa nama)',
            vouchers: Number(p.vcount)
          }))
        }
      });
    } catch (e) {
      logger.error('Reseller chartData error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ─── KELOLA VOUCHER / USER HOTSPOT ──────────────────────────
  // Daftar voucher (hotspot user) milik reseller + status pakai & sesi aktif.
  async vouchers(req, res) {
    try {
      const r = req.reseller;
      const filter = (req.query.status || '').toLowerCase(); // '', active, expired, used, unused
      const q = (req.query.q || '').trim().toLowerCase();

      const { users, activeSet } = await _fetchResellerVouchers(r);

      let out = users.map(u => {
        const isActive = activeSet.has(u.name);
        const status = _voucherStatus(u, isActive);

        // Sisa waktu = limit-uptime − uptime terpakai (detik). null jika tanpa limit.
        const limitSec = _parseMtDuration(u.limitUptime);
        const usedSec = _parseMtDuration(u.uptime);
        let timeLeftSec = null;
        if (limitSec > 0) timeLeftSec = Math.max(0, limitSec - usedSec);

        // Sisa kuota = limit-bytes-total − (bytesIn+bytesOut). null jika tanpa limit.
        const limitBytes = Number(u.limitBytesTotal) || 0;
        const usedBytes = (Number(u.bytesIn) || 0) + (Number(u.bytesOut) || 0);
        let quotaLeftBytes = null;
        if (limitBytes > 0) quotaLeftBytes = Math.max(0, limitBytes - usedBytes);

        return {
          id: u.id,
          username: u.name,
          password: u.password,
          profile: u.profile,
          server: u.server,
          uptime: u.uptime,
          bytes_in: u.bytesIn,
          bytes_out: u.bytesOut,
          bytes_total: usedBytes,
          limit_uptime: u.limitUptime,
          limit_bytes_total: limitBytes,
          time_left_sec: timeLeftSec,
          quota_left_bytes: quotaLeftBytes,
          disabled: u.disabled,
          comment: u.comment,
          status
        };
      });

      if (['active', 'expired', 'used', 'unused'].includes(filter)) {
        out = out.filter(v => v.status === filter);
      }
      if (q) out = out.filter(v => v.username.toLowerCase().includes(q) || (v.profile || '').toLowerCase().includes(q));

      const counts = { total: users.length, active: 0, expired: 0, used: 0, unused: 0 };
      users.forEach(u => {
        const st = _voucherStatus(u, activeSet.has(u.name));
        counts[st] = (counts[st] || 0) + 1;
      });
      // "Terpakai" total = semua yang sudah pernah dipakai:
      // sedang online (active) + selesai/habis (expired) + pernah dipakai (used).
      counts.used_total = counts.active + counts.expired + counts.used;

      res.json({ success: true, data: out, counts });
    } catch (e) {
      logger.error('Reseller vouchers error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal memuat voucher dari router: ' + e.message });
    }
  },

  // Aksi terhadap satu voucher: hapus / putus sesi / nonaktifkan / aktifkan.
  // Aman: hanya boleh terhadap user yang ber-comment "Reseller: <code>".
  async voucherAction(req, res) {
    try {
      const r = req.reseller;
      const { action } = req.body;
      const username = (req.body.username || '').trim();
      if (!username) return res.status(400).json({ success: false, message: 'Username voucher wajib diisi' });
      if (!['delete', 'disconnect', 'disable', 'enable'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Aksi tidak dikenal' });
      }

      const svc = await resellerHotspotService(r);
      const users = await svc.getUsers({});
      const target = (users || []).find(u => u.name === username && _isResellerUser(u, r.code));
      if (!target) {
        return res.status(404).json({ success: false, message: 'Voucher tidak ditemukan / bukan milik Anda' });
      }

      if (action === 'delete') {
        // Putus sesi aktif dulu (kalau ada) lalu hapus user.
        try {
          const sessions = await svc.getActiveSessions();
          const sess = (sessions || []).find(s => s.user === username);
          if (sess) await svc.disconnectSession(sess.id);
        } catch (_) {}
        await svc.deleteUser(target.id);
        return res.json({ success: true, message: 'Voucher dihapus' });
      }

      if (action === 'disconnect') {
        const sessions = await svc.getActiveSessions();
        const sess = (sessions || []).find(s => s.user === username);
        if (!sess) return res.json({ success: true, message: 'Tidak ada sesi aktif' });
        await svc.disconnectSession(sess.id);
        return res.json({ success: true, message: 'Sesi diputus' });
      }

      if (action === 'disable') { await svc.disableUser(target.id); return res.json({ success: true, message: 'Voucher dinonaktifkan' }); }
      if (action === 'enable')  { await svc.enableUser(target.id);  return res.json({ success: true, message: 'Voucher diaktifkan' }); }
    } catch (e) {
      logger.error('Reseller voucherAction error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal: ' + e.message });
    }
  },

  // Aksi massal: hapus banyak voucher sekaligus.
  //  body: { usernames: [..] }  ATAU  { scope: 'expired'|'unused' }
  // Aman: hanya menyentuh voucher milik reseller (comment "Reseller: <code>").
  async voucherBulkAction(req, res) {
    try {
      const r = req.reseller;
      const action = (req.body.action || 'delete');
      if (action !== 'delete') {
        return res.status(400).json({ success: false, message: 'Hanya aksi hapus massal yang didukung' });
      }

      const svc = await resellerHotspotService(r);
      const { users, activeSet } = await _fetchResellerVouchers(r);

      // Tentukan target: daftar username eksplisit, atau berdasarkan scope status.
      let targetNames = [];
      if (Array.isArray(req.body.usernames) && req.body.usernames.length) {
        const want = new Set(req.body.usernames.map(s => String(s).trim()).filter(Boolean));
        targetNames = users.filter(u => want.has(u.name)).map(u => u.name);
      } else if (['expired', 'unused'].includes(req.body.scope)) {
        targetNames = users
          .filter(u => _voucherStatus(u, activeSet.has(u.name)) === req.body.scope)
          .map(u => u.name);
      } else {
        return res.status(400).json({ success: false, message: 'Pilih voucher atau scope (expired/unused) yang valid' });
      }

      if (!targetNames.length) {
        return res.json({ success: true, message: 'Tidak ada voucher yang cocok untuk dihapus', deleted: 0, failed: 0 });
      }
      // Batas aman agar tidak membebani router (maks 300 per panggilan).
      if (targetNames.length > 300) {
        return res.status(400).json({ success: false, message: `Terlalu banyak (${targetNames.length}). Maksimal 300 per aksi, ulangi beberapa kali.` });
      }

      // Map nama → id & set aktif untuk putus sesi sebelum hapus.
      const byName = new Map(users.map(u => [u.name, u]));
      let activeSessions = [];
      try { activeSessions = await svc.getActiveSessions(); } catch (_) {}
      const sessByUser = new Map((activeSessions || []).map(s => [s.user, s]));

      let deleted = 0, failed = 0;
      for (const name of targetNames) {
        const u = byName.get(name);
        if (!u) { failed++; continue; }
        try {
          const sess = sessByUser.get(name);
          if (sess) { try { await svc.disconnectSession(sess.id); } catch (_) {} }
          await svc.deleteUser(u.id);
          deleted++;
        } catch (_) { failed++; }
      }

      res.json({
        success: true,
        message: `${deleted} voucher dihapus` + (failed ? `, ${failed} gagal` : ''),
        deleted, failed
      });
    } catch (e) {
      logger.error('Reseller voucherBulkAction error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal: ' + e.message });
    }
  },

  // Data voucher untuk CETAK (mis. cetak ulang stok "belum dipakai").
  //  body: { usernames:[...] } ATAU { scope:'unused'|'active'|... }
  // Aman: hanya voucher milik reseller. Output mirip transactionDetail.
  async voucherPrintData(req, res) {
    try {
      const r = req.reseller;
      const { users, activeSet } = await _fetchResellerVouchers(r);

      let picked = [];
      if (Array.isArray(req.body.usernames) && req.body.usernames.length) {
        const want = new Set(req.body.usernames.map(s => String(s).trim()).filter(Boolean));
        picked = users.filter(u => want.has(u.name));
      } else if (['unused', 'active', 'used', 'expired'].includes(req.body.scope)) {
        picked = users.filter(u => _voucherStatus(u, activeSet.has(u.name)) === req.body.scope);
      } else {
        return res.status(400).json({ success: false, message: 'Pilih voucher atau scope yang valid' });
      }

      if (!picked.length) {
        return res.json({ success: true, data: { package_name: '', vouchers: [] } });
      }
      // Batas aman cetak (maks 500 kartu).
      if (picked.length > 500) picked = picked.slice(0, 500);

      // Ambil harga jual dari paket reseller (best-effort, untuk dicetak).
      let sellPrice = null;
      try {
        const pkgs = await ResellerVoucherPackage.findAll({ where: { is_active: true } });
        // Map profile → sell_price (untuk menebak harga dari profil voucher).
        const byProfile = {};
        pkgs.forEach(p => { if (p.mikrotik_profile) byProfile[p.mikrotik_profile] = Number(p.sell_price); });
        picked.forEach(u => { u._sell = byProfile[u.profile] != null ? byProfile[u.profile] : null; });
      } catch (_) {}

      const vouchers = picked.map(u => ({
        username: u.name,
        password: u.password || '',
        profile: u.profile || '',
        price: (u._sell != null ? u._sell : undefined)
      }));

      res.json({
        success: true,
        data: {
          package_name: req.body.label || 'Voucher Belum Dipakai',
          voucher_count: vouchers.length,
          vouchers
        }
      });
    } catch (e) {
      logger.error('Reseller voucherPrintData error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal: ' + e.message });
    }
  },
  // Daftar user hotspot reseller yang SEDANG online, lengkap dengan
  // uptime, sisa waktu sesi (session-time-left atau hitung dari limit-uptime),
  // serta byte upload/download (untuk dihitung kecepatan real-time di klien).
  async activeMonitor(req, res) {
    try {
      const r = req.reseller;
      const svc = await resellerHotspotService(r);
      const [users, sessions] = await Promise.all([
        svc.getUsers({}).catch(() => []),
        svc.getActiveSessions().catch(() => [])
      ]);

      // Map username → data user (untuk ambil limit & profile) hanya milik reseller ini.
      const mine = (users || []).filter(u => _isResellerUser(u, r.code));
      const byName = {};
      mine.forEach(u => { byName[u.name] = u; });

      const now = Date.now();
      const list = (sessions || [])
        .filter(s => byName[s.user]) // hanya sesi milik reseller ini
        .map(s => {
          const u = byName[s.user];
          const limitSec = _parseMtDuration(u.limitUptime);
          const upSec = _parseMtDuration(s.uptime);
          // Sisa waktu: pakai session-time-left dari MikroTik bila ada,
          // kalau tidak hitung dari limit-uptime − uptime.
          let leftSec = null;
          if (s.sessionTimeLeft) {
            leftSec = _parseMtDuration(s.sessionTimeLeft);
          } else if (limitSec > 0) {
            leftSec = Math.max(0, limitSec - upSec);
          }
          return {
            id: s.id,
            username: s.user,
            profile: u.profile || '',
            address: s.address || '',
            mac: s.macAddress || '',
            login_by: s.loginBy || '',
            server: s.server || '',
            uptime: s.uptime || '0s',
            uptime_sec: upSec,
            idle_time: s.idleTime || '0s',
            session_time_left: s.sessionTimeLeft || '',
            left_sec: leftSec,             // null = unlimited / tak diketahui
            limit_uptime: u.limitUptime || '',
            limit_sec: limitSec,
            // Arah data dari sudut pandang USER (sesuai Simple Queue):
            //   MikroTik hotspot active: bytes-in = data DARI user (upload user),
            //   bytes-out = data KE user (download user). Jadi:
            //   download user = bytes-out, upload user = bytes-in.
            bytes_download: Number(s.bytesOut) || 0,  // KE user  = download user
            bytes_upload:   Number(s.bytesIn)  || 0,  // DARI user = upload user
            // Field mentah tetap disertakan bila diperlukan
            bytes_in: Number(s.bytesIn) || 0,
            bytes_out: Number(s.bytesOut) || 0,
            ts: now
          };
        });

      // Ringkasan total traffic semua user aktif (perspektif user).
      const summary = {
        active_users: list.length,
        total_download: list.reduce((a, x) => a + x.bytes_download, 0),
        total_upload: list.reduce((a, x) => a + x.bytes_upload, 0),
        ts: now
      };

      res.json({ success: true, data: list, summary });
    } catch (e) {
      logger.error('Reseller activeMonitor error:', e.message);
      res.status(500).json({ success: false, message: 'Gagal memuat data monitor: ' + e.message });
    }
  },

  // ─── GANTI PASSWORD ─────────────────────────────────────────
  async changePassword(req, res) {
    try {
      const { old_password, new_password } = req.body;
      if (!new_password || new_password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter' });
      }
      const reseller = await Reseller.findByPk(req.reseller.id);
      const valid = await reseller.validatePassword(old_password || '');
      if (!valid) return res.status(401).json({ success: false, message: 'Password lama salah' });
      reseller.password = new_password;
      await reseller.save();
      res.json({ success: true, message: 'Password berhasil diubah' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // ════════════════════════════════════════════════════════════
  //  TOP-UP SALDO (reseller isi saldo sendiri)
  // ════════════════════════════════════════════════════════════

  // Metode top-up yang tersedia + rekening manual/QRIS + Tripay channels.
  async topupConfig(req, res) {
    try {
      const cfg = await ResellerTopupService.getTopupConfig();
      let tripayChannels = [];
      // Kalau gateway aktif & provider tripay, sertakan daftar channel.
      if (cfg.gateway_enabled && cfg.gateway_provider === 'tripay') {
        try {
          const PublicPaymentService = require('../services/PublicPaymentService');
          const ch = await PublicPaymentService.getTripayChannels();
          if (ch.success) tripayChannels = ch.channels;
        } catch (_) {}
      }
      res.json({ success: true, data: { ...cfg, tripay_channels: tripayChannels } });
    } catch (e) {
      logger.error('Reseller topupConfig error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Buat permintaan top-up.
  //  body: { method:'manual'|'qris'|'gateway', amount, target_account?, tripay_method? }
  // Cek kode promo (preview bonus) sebelum reseller submit top-up (#10).
  async checkPromo(req, res) {
    try {
      const r = req.reseller;
      const code = (req.query.code || req.body.code || '').trim();
      const amount = Math.round(Number(req.query.amount || req.body.amount) || 0);
      if (!amount) return res.status(400).json({ success: false, message: 'Nominal top-up wajib diisi' });
      if (code) {
        const v = await ResellerPromoService.validate(code, r, amount);
        return res.json({ success: v.ok, message: v.message, bonus: v.ok ? v.bonus : 0, code });
      }
      const auto = await ResellerPromoService.bestAutoPromo(r, amount);
      if (auto) return res.json({ success: true, message: `Bonus otomatis Rp ${auto.bonus.toLocaleString('id-ID')}`, bonus: auto.bonus, auto: true, name: auto.promo.name });
      return res.json({ success: false, message: 'Tidak ada promo aktif', bonus: 0 });
    } catch (e) {
      logger.error('checkPromo error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  async topupCreate(req, res) {
    try {
      const r = req.reseller;
      const method = ['manual', 'qris', 'gateway'].includes(req.body.method) ? req.body.method : null;
      const amount = Math.round(Number(req.body.amount));
      if (!method) return res.status(400).json({ success: false, message: 'Metode tidak valid' });

      const cfg = await ResellerTopupService.getTopupConfig();
      if (!amount || amount < cfg.min_topup) {
        return res.status(400).json({ success: false, message: `Minimal top-up Rp ${cfg.min_topup.toLocaleString('id-ID')}` });
      }
      if (method === 'gateway' && !cfg.gateway_enabled) {
        return res.status(400).json({ success: false, message: 'Pembayaran otomatis belum aktif.' });
      }
      if ((method === 'manual' || method === 'qris') && !cfg.manual_enabled) {
        return res.status(400).json({ success: false, message: 'Top-up manual belum aktif.' });
      }

      // Buat record dulu untuk dapat id → ref RTOP-{id}-{ts}
      // ── Promo top-up (#10): kode manual atau auto-apply ─────────
      let promoInfo = null;
      try {
        const code = (req.body.promo_code || '').trim();
        if (code) {
          const v = await ResellerPromoService.validate(code, r, amount);
          if (v.ok) promoInfo = { id: v.promo.id, code: v.promo.code, bonus: v.bonus };
          else if (req.body.promo_code) {
            // kode diisi tapi tidak valid → tolak supaya reseller tahu
            return res.status(400).json({ success: false, message: v.message, code: 'PROMO_INVALID' });
          }
        } else {
          const auto = await ResellerPromoService.bestAutoPromo(r, amount);
          if (auto) promoInfo = { id: auto.promo.id, code: auto.promo.code || '(auto)', bonus: auto.bonus };
        }
      } catch (e) { logger.warn('Promo eval skip:', e.message); }

      const topup = await ResellerTopup.create({
        ref: 'TMP-' + Date.now(), reseller_id: r.id, method, amount,
        status: 'pending',
        target_account: (req.body.target_account || '').toString().slice(0, 255) || null,
        promo_id: promoInfo ? promoInfo.id : null,
        promo_code: promoInfo ? promoInfo.code : null,
        bonus_amount: promoInfo ? promoInfo.bonus : 0
      });
      const ref = `RTOP-${topup.id}-${Date.now()}`;
      await topup.update({ ref });

      if (method === 'gateway') {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const result = await ResellerTopupService.createGatewayTopup({
          topup, reseller: r, baseUrl, tripayMethod: req.body.tripay_method
        });
        if (!result.success) {
          await topup.update({ status: 'expired' }); // batalkan record gagal
          return res.status(result.http || 400).json({ success: false, message: result.message, code: result.code });
        }
        // Untuk Midtrans, sertakan snap_token + client_key + env supaya
        // dashboard reseller bisa menampilkan Snap popup IN-PAGE (tanpa
        // pindah halaman). Tripay/Duitku/Xendit tetap redirect/buka URL.
        let clientKey = '', env = 'sandbox';
        if (result.mode === 'midtrans') {
          try {
            const { AppSetting } = require('../models');
            const ck = await AppSetting.findOne({ where: { key: 'payment_gateway_client_key' } });
            clientKey = ck ? ck.value : '';
            const ev = await AppSetting.findOne({ where: { key: 'payment_gateway_env' } });
            env = (ev && ev.value === 'production') ? 'production' : 'sandbox';
          } catch (_) {}
        }
        return res.json({
          success: true, method: 'gateway',
          data: {
            id: topup.id, ref, amount,
            mode: result.mode,
            payment_url: result.payment_url,
            snap_token: result.snap_token || null,
            client_key: clientKey,
            env,
            provider: result.mode
          }
        });
      }

      // Manual / QRIS — kembalikan instruksi; reseller upload bukti nanti.
      return res.json({
        success: true, method,
        data: {
          id: topup.id, ref, amount,
          target_account: topup.target_account,
          accounts: cfg.accounts
        }
      });
    } catch (e) {
      logger.error('Reseller topupCreate error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Upload bukti transfer (manual/qris). multipart: field 'proof'.
  async topupUploadProof(req, res) {
    try {
      const r = req.reseller;
      const topup = await ResellerTopup.findOne({ where: { id: req.params.id, reseller_id: r.id } });
      if (!topup) return res.status(404).json({ success: false, message: 'Top-up tidak ditemukan' });
      if (topup.method === 'gateway') {
        return res.status(400).json({ success: false, message: 'Top-up gateway tidak perlu upload bukti.' });
      }
      if (topup.status === 'paid') {
        return res.status(400).json({ success: false, message: 'Top-up ini sudah lunas.' });
      }
      if (!req.file) return res.status(400).json({ success: false, message: 'File bukti wajib diunggah.' });

      await topup.update({
        proof_path: req.file.filename,
        note: (req.body.note || '').toString().slice(0, 255) || null,
        status: 'waiting_verification'
      });

      // Notifikasi admin (best-effort, tidak fatal kalau gagal).
      try {
        const { Notification } = require('../models');
        if (Notification) {
          await Notification.create({
            type: 'reseller_topup',
            title: 'Konfirmasi Top-up Reseller',
            message: `${r.name} (${r.code}) konfirmasi top-up Rp ${Number(topup.amount).toLocaleString('id-ID')}`,
            is_read: false
          });
        }
      } catch (_) {}

      res.json({ success: true, message: 'Bukti terkirim. Menunggu verifikasi admin.', data: { id: topup.id, status: 'waiting_verification' } });
    } catch (e) {
      logger.error('Reseller topupUploadProof error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Status satu top-up (polling setelah bayar gateway).
  async topupStatus(req, res) {
    try {
      const r = req.reseller;
      await _expireStalePendingTopups(r.id);
      const topup = await ResellerTopup.findOne({ where: { id: req.params.id, reseller_id: r.id } });
      if (!topup) return res.status(404).json({ success: false, message: 'Top-up tidak ditemukan' });
      const fresh = await Reseller.findByPk(r.id);
      res.json({
        success: true,
        data: {
          id: topup.id, ref: topup.ref, method: topup.method, amount: Number(topup.amount),
          status: topup.status, payment_url: topup.payment_url,
          balance: Number(fresh.balance)
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Batalkan top-up yang belum selesai (manual/qris/gateway yang masih pending).
  // Tidak menyentuh saldo; hanya untuk merapikan riwayat saat reseller batal bayar.
  async topupCancel(req, res) {
    try {
      const r = req.reseller;
      const topup = await ResellerTopup.findOne({ where: { id: req.params.id, reseller_id: r.id } });
      if (!topup) return res.status(404).json({ success: false, message: 'Top-up tidak ditemukan' });
      // Hanya boleh batal kalau belum dibayar / belum di-credit.
      if (topup.credited || topup.status === 'paid') {
        return res.status(400).json({ success: false, message: 'Top-up ini sudah lunas dan tidak bisa dibatalkan.' });
      }
      if (['expired', 'rejected'].includes(topup.status)) {
        return res.json({ success: true, message: 'Top-up sudah tidak aktif.', status: topup.status });
      }
      await topup.update({ status: 'expired' });
      logger.info(`[ResellerTopup] dibatalkan manual oleh reseller#${r.id}: ${topup.ref}`);
      return res.json({ success: true, message: 'Top-up dibatalkan.', status: 'expired' });
    } catch (e) {
      logger.error('Reseller topupCancel error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Riwayat top-up reseller.
  async topupHistory(req, res) {
    try {
      const r = req.reseller;
      // Bersihkan top-up gateway yang menggantung melewati batas waktu.
      await _expireStalePendingTopups(r.id);
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, parseInt(req.query.limit) || 15);
      const { count, rows } = await ResellerTopup.findAndCountAll({
        where: { reseller_id: r.id },
        order: [['createdAt', 'DESC']],
        limit, offset: (page - 1) * limit
      });
      res.json({
        success: true,
        data: rows.map(t => ({
          id: t.id, ref: t.ref, method: t.method, amount: Number(t.amount),
          status: t.status, target_account: t.target_account,
          gateway_provider: t.gateway_provider, payment_url: t.payment_url,
          reject_reason: t.reject_reason, created_at: t.createdAt, paid_at: t.paid_at
        })),
        pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
};

module.exports = ResellerController;
