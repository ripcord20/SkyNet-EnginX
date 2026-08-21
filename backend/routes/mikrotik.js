const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');

const QueueController          = require('../controllers/QueueController');
const PPPoEController          = require('../controllers/PPPoEController');
const IPPoolController         = require('../controllers/IPPoolController');
const FirewallController       = require('../controllers/FirewallController');
const { controller: IfaceCtrl }= require('../controllers/InterfaceTrafficController');
const MikrotikConfigController = require('../controllers/MikrotikConfigController');
const HotspotController = require('../controllers/HotspotController');

// ── CONFIG ──────────────────────────────────────────────────
router.get('/config',  authenticate, MikrotikConfigController.getConfig);
router.post('/config', authenticate, authorize('superadmin', 'admin'), MikrotikConfigController.saveConfig);
router.post('/test',   authenticate, MikrotikConfigController.testConnection);
router.get('/system',  authenticate, MikrotikConfigController.systemInfo);

// ── QUEUE ───────────────────────────────────────────────────
router.get('/queues',                authenticate, QueueController.index.bind(QueueController));
router.get('/queues/stats',          authenticate, QueueController.stats.bind(QueueController));
router.get('/queues/active-device',  authenticate, QueueController.activeDevice.bind(QueueController));
router.post('/queues',               authenticate, authorize('superadmin', 'admin'), logActivity('create', 'queue'), QueueController.create.bind(QueueController));
router.put('/queues/:id',            authenticate, authorize('superadmin', 'admin'), logActivity('update', 'queue'), QueueController.update.bind(QueueController));
router.delete('/queues/:id',         authenticate, authorize('superadmin', 'admin'), logActivity('delete', 'queue'), QueueController.destroy.bind(QueueController));
router.post('/queues/:id/enable',    authenticate, authorize('superadmin', 'admin'), logActivity('enable',  'queue'), QueueController.enable.bind(QueueController));
router.post('/queues/:id/disable',   authenticate, authorize('superadmin', 'admin'), logActivity('disable', 'queue'), QueueController.disable.bind(QueueController));

// Queue History
const { getQueueHistory, getHistorySummary } = require('../controllers/QueueHistoryController');
router.get('/queues/history/summary',         authenticate, getHistorySummary);
router.get('/queues/:queue_name/history',     authenticate, getQueueHistory);

// ── PPPOE ────────────────────────────────────────────────────
router.get('/pppoe/active',                authenticate, PPPoEController.activeSessions.bind(PPPoEController));
router.get('/pppoe/secrets',               authenticate, PPPoEController.secrets.bind(PPPoEController));
router.get('/pppoe/stats',                 authenticate, PPPoEController.stats.bind(PPPoEController));
router.get('/pppoe/profiles',              authenticate, PPPoEController.getProfiles.bind(PPPoEController));
router.post('/pppoe/disconnect/:id',       authenticate, authorize('superadmin','admin'), logActivity('disconnect','pppoe'), PPPoEController.disconnect.bind(PPPoEController));
router.post('/pppoe/secrets',              authenticate, authorize('superadmin','admin'), logActivity('create','pppoe_secret'), PPPoEController.createSecret.bind(PPPoEController));
router.put('/pppoe/secrets/:id',           authenticate, authorize('superadmin','admin'), logActivity('update','pppoe_secret'), PPPoEController.updateSecret.bind(PPPoEController));
router.delete('/pppoe/secrets/:id',        authenticate, authorize('superadmin','admin'), logActivity('delete','pppoe_secret'), PPPoEController.deleteSecret.bind(PPPoEController));
router.post('/pppoe/secrets/:id/enable',   authenticate, authorize('superadmin','admin'), PPPoEController.enableSecret.bind(PPPoEController));
router.post('/pppoe/secrets/:id/disable',  authenticate, authorize('superadmin','admin'), PPPoEController.disableSecret.bind(PPPoEController));

// ── IP POOL ──────────────────────────────────────────────────
router.get('/ippool',      authenticate, IPPoolController.index.bind(IPPoolController));
router.get('/ippool/used', authenticate, IPPoolController.used.bind(IPPoolController));
router.get('/ippool/addresses', authenticate, IPPoolController.addresses.bind(IPPoolController));
router.get('/ippool/suggest',   authenticate, IPPoolController.suggest.bind(IPPoolController));
router.post('/ippool',     authenticate, authorize('superadmin','admin'), logActivity('create','ip_pool'), IPPoolController.create.bind(IPPoolController));
router.delete('/ippool/:id', authenticate, authorize('superadmin','admin'), logActivity('delete','ip_pool'), IPPoolController.destroy.bind(IPPoolController));

// ── FIREWALL ─────────────────────────────────────────────────
router.get('/firewall/filter',  authenticate, FirewallController.filter.bind(FirewallController));
router.get('/firewall/nat',     authenticate, FirewallController.nat.bind(FirewallController));
router.get('/firewall/stats',   authenticate, FirewallController.stats.bind(FirewallController));
router.post('/firewall/toggle', authenticate, authorize('superadmin', 'admin'), logActivity('toggle', 'firewall'), FirewallController.toggle.bind(FirewallController));

// ── INTERFACES ───────────────────────────────────────────────
// PENTING: route spesifik harus SEBELUM route dengan :name param
router.get('/interfaces',                  authenticate, IfaceCtrl.index.bind(IfaceCtrl));
router.get('/interfaces/monitor',          authenticate, IfaceCtrl.monitorAll.bind(IfaceCtrl));
router.get('/interfaces/monitor-selected', authenticate, IfaceCtrl.monitorSelected.bind(IfaceCtrl));
router.get('/interfaces/:name/stats',      authenticate, IfaceCtrl.stats.bind(IfaceCtrl));

// ── HOTSPOT SUMMARY ─────────────────────────────────────────────
router.get('/hotspot/summary',         authenticate, HotspotController.summary);
 
// ── HOTSPOT SERVERS ─────────────────────────────────────────────
router.get('/hotspot/servers',         authenticate, HotspotController.getServers);
router.post('/hotspot/servers',        authenticate, authorize('superadmin','admin'), logActivity('create','hotspot_server'), HotspotController.createServer);
router.post('/hotspot/servers/setup',  authenticate, authorize('superadmin','admin'), logActivity('setup','hotspot_server'), HotspotController.setupServer);
router.put('/hotspot/servers/:id',     authenticate, authorize('superadmin','admin'), logActivity('update','hotspot_server'), HotspotController.updateServer);
router.delete('/hotspot/servers/:id',  authenticate, authorize('superadmin','admin'), logActivity('delete','hotspot_server'), HotspotController.deleteServer);
router.post('/hotspot/servers/:id/toggle', authenticate, authorize('superadmin','admin'), HotspotController.toggleServer);

// ── INTERFACES (untuk dropdown setup) ───────────────────────────
router.get('/hotspot/interfaces',      authenticate, HotspotController.getInterfaces);
router.get('/hotspot/hotspot-interfaces', authenticate, HotspotController.hotspotInterfaces);
router.get('/hotspot/conn-status',     authenticate, HotspotController.connStatus);
router.get('/hotspot/traffic-history', authenticate, HotspotController.trafficHistory);
router.get('/hotspot/traffic-history-interfaces', authenticate, HotspotController.trafficHistoryInterfaces);
router.post('/hotspot/ping',           authenticate, HotspotController.pingHost);
 
// ── HOTSPOT SERVER PROFILES ─────────────────────────────────────
router.get('/hotspot/profiles',        authenticate, HotspotController.getProfiles);
router.post('/hotspot/profiles',       authenticate, authorize('superadmin','admin'), logActivity('create','hotspot_profile'), HotspotController.createProfile);
router.patch('/hotspot/profiles/:id',  authenticate, authorize('superadmin','admin'), logActivity('update','hotspot_profile'), HotspotController.updateProfile);
router.delete('/hotspot/profiles/:id', authenticate, authorize('superadmin','admin'), logActivity('delete','hotspot_profile'), HotspotController.deleteProfile);

// ── WALLED GARDEN ───────────────────────────────────────────────
router.get('/hotspot/walled-garden',                  authenticate, HotspotController.getWalledGarden);
router.post('/hotspot/walled-garden',                 authenticate, authorize('superadmin','admin'), logActivity('create','walled_garden'), HotspotController.createWalledGarden);
router.put('/hotspot/walled-garden/host/:id',         authenticate, authorize('superadmin','admin'), logActivity('update','walled_garden'), HotspotController.updateWalledGarden);
router.delete('/hotspot/walled-garden/host/:id',      authenticate, authorize('superadmin','admin'), logActivity('delete','walled_garden'), HotspotController.deleteWalledGarden);
router.post('/hotspot/walled-garden/ip',              authenticate, authorize('superadmin','admin'), logActivity('create','walled_garden_ip'), HotspotController.createWalledGardenIp);
router.put('/hotspot/walled-garden/ip/:id',           authenticate, authorize('superadmin','admin'), logActivity('update','walled_garden_ip'), HotspotController.updateWalledGardenIp);
router.delete('/hotspot/walled-garden/ip/:id',        authenticate, authorize('superadmin','admin'), logActivity('delete','walled_garden_ip'), HotspotController.deleteWalledGardenIp);
 
// ── USER PROFILES (paket) ───────────────────────────────────────
router.get('/hotspot/user-profiles',                  authenticate, HotspotController.getUserProfiles);
router.post('/hotspot/user-profiles',                 authenticate, authorize('superadmin','admin'), logActivity('create','hotspot_profile'), HotspotController.createUserProfile);
router.put('/hotspot/user-profiles/:id',              authenticate, authorize('superadmin','admin'), logActivity('update','hotspot_profile'), HotspotController.updateUserProfile);
router.delete('/hotspot/user-profiles/:id',           authenticate, authorize('superadmin','admin'), logActivity('delete','hotspot_profile'), HotspotController.deleteUserProfile);
 
// ── HOTSPOT USERS ───────────────────────────────────────────────
router.get('/hotspot/users',                          authenticate, HotspotController.getUsers);
router.post('/hotspot/users',                         authenticate, authorize('superadmin','admin'), logActivity('create','hotspot_user'), HotspotController.createUser);
router.put('/hotspot/users/:id',                      authenticate, authorize('superadmin','admin'), logActivity('update','hotspot_user'), HotspotController.updateUser);
router.delete('/hotspot/users/:id',                   authenticate, authorize('superadmin','admin'), logActivity('delete','hotspot_user'), HotspotController.deleteUser);
router.post('/hotspot/users/delete-batch',            authenticate, authorize('superadmin','admin'), logActivity('delete_batch','hotspot_user'), HotspotController.deleteBatch);
router.post('/hotspot/users/:id/enable',              authenticate, authorize('superadmin','admin'), HotspotController.enableUser);
router.post('/hotspot/users/:id/disable',             authenticate, authorize('superadmin','admin'), HotspotController.disableUser);
 
// ── GENERATE VOUCHERS ───────────────────────────────────────────
router.post('/hotspot/generate',                      authenticate, authorize('superadmin','admin'), logActivity('generate','voucher'), HotspotController.generateVouchers);
 
// ── ACTIVE SESSIONS ─────────────────────────────────────────────
router.get('/hotspot/active',                         authenticate, HotspotController.getActiveSessions);
router.post('/hotspot/active/:id/disconnect',         authenticate, authorize('superadmin','admin'), logActivity('disconnect','hotspot_session'), HotspotController.disconnectSession);
router.post('/hotspot/active/disconnect-batch',       authenticate, authorize('superadmin','admin'), HotspotController.disconnectSessionBatch);
 
// ── HOSTS ────────────────────────────────────────────────────────
router.get('/hotspot/hosts',                          authenticate, HotspotController.getHosts);
router.post('/hotspot/hosts/:id/make-binding',        authenticate, authorize('superadmin','admin'), logActivity('create','hotspot_binding'), HotspotController.makeHostBinding);
router.delete('/hotspot/hosts/:id',                   authenticate, authorize('superadmin','admin'), logActivity('delete','hotspot_host'), HotspotController.deleteHost);
 
// ── COOKIES ──────────────────────────────────────────────────────
router.get('/hotspot/cookies',                        authenticate, HotspotController.getCookies);
router.delete('/hotspot/cookies/:id',                 authenticate, authorize('superadmin','admin'), HotspotController.deleteCookie);
 
// ── IP BINDING ────────────────────────────────────────────────────
router.get('/hotspot/ip-binding',                     authenticate, HotspotController.getIpBindings);
router.post('/hotspot/ip-binding',                    authenticate, authorize('superadmin','admin'), logActivity('create','ip_binding'), HotspotController.createIpBinding);
router.post('/hotspot/ip-binding/dedupe',             authenticate, authorize('superadmin','admin'), logActivity('cleanup','ip_binding'), HotspotController.dedupeIpBindings);
router.delete('/hotspot/ip-binding/:id',              authenticate, authorize('superadmin','admin'), logActivity('delete','ip_binding'), HotspotController.deleteIpBinding);
router.patch('/hotspot/ip-binding/:id',               authenticate, authorize('superadmin','admin'), logActivity('update','ip_binding'), HotspotController.updateIpBinding);
router.get('/hotspot/isolir-history/:id',             authenticate, HotspotController.isolirHistory);

// ── PRICING (profile → harga) & LAPORAN ───────────────────────────
router.get('/hotspot/pricing',         authenticate, HotspotController.getPricing);
router.post('/hotspot/pricing',        authenticate, authorize('superadmin','admin'), logActivity('update','hotspot_pricing'), HotspotController.savePricing);
router.get('/hotspot/sales-report',    authenticate, HotspotController.salesReport);
router.get('/hotspot/usage-history',   authenticate, HotspotController.usageHistory);
router.get('/hotspot/cleanup-preview', authenticate, HotspotController.cleanupPreview.bind(HotspotController));
router.post('/hotspot/cleanup-expired', authenticate, authorize('superadmin','admin'), logActivity('cleanup','hotspot_vouchers'), HotspotController.cleanupExpired.bind(HotspotController));


// ── Customer Traffic History ─────────────────────────────────
// GET /api/mikrotik/customer-history?queueName=xxx&range=1m|3h|24h|3d
// Atau ?pppoeUser=xxx untuk match dynamic queue PPPoE (<pppoe-xxx>, pppoe-xxx-N).
// Salah satu dari queueName atau pppoeUser harus diisi.
router.get('/customer-history', authenticate, async (req, res) => {
  try {
    const { queueName, pppoeUser, range } = req.query;
    if (!queueName && !pppoeUser) {
      return res.status(400).json({ success: false, message: 'queueName atau pppoeUser required' });
    }

    // Lazy require — hindari circular dependency di top-level
    const db          = require('../models');
    const QueueHistory = db.QueueHistory;
    const Sequelize   = require('sequelize');
    const Op          = Sequelize.Op;
    const fn          = Sequelize.fn;
    const col         = Sequelize.col;
    const literal     = Sequelize.literal;
    const moment      = require('moment');

    if (!QueueHistory) {
      return res.status(500).json({ success: false, message: 'QueueHistory model not loaded' });
    }

    // Data direcord setiap 1 menit oleh CronService
    // interval = bucket size dalam detik (1 record per menit = 60 detik minimum)
    const rangeMap = {
      '1m':  { minutes: 30,   interval: 60,   label: '30 Menit' },   // 30 titik
      '3h':  { minutes: 180,  interval: 300,  label: '3 Jam' },      // 36 titik
      '24h': { minutes: 1440, interval: 900,  label: '24 Jam' },     // 96 titik
      '3d':  { minutes: 4320, interval: 3600, label: '3 Hari' },     // 72 titik
    };
    const cfg = rangeMap[range] || rangeMap['1m'];
    const startTime = moment().subtract(cfg.minutes, 'minutes').toDate();
    const bucketSec = cfg.interval; // dalam detik

    // Build queue_name filter:
    //   - Jika queueName diberikan: exact match
    //   - Jika pppoeUser diberikan: LIKE match untuk handle dynamic queue dengan
    //     varian "<pppoe-USER>", "<pppoe-USER-1>", "pppoe-USER", dst.
    //     User PPPoE bisa reconnect dgn queue.id baru, tapi pola nama-nya konsisten.
    const queueFilter = queueName
      ? { queue_name: queueName }
      : {
          [Op.or]: [
            { queue_name: `<pppoe-${pppoeUser}>` },                    // exact bracketed
            { queue_name: { [Op.like]: `<pppoe-${pppoeUser}-%>` } },   // multi-session bracketed
            { queue_name: `pppoe-${pppoeUser}` },                       // exact plain
            { queue_name: { [Op.like]: `pppoe-${pppoeUser}-%` } }       // multi-session plain
          ]
        };

    const rows = await QueueHistory.findAll({
      where: {
        ...queueFilter,
        recorded_at: { [Op.gte]: startTime }
      },
      attributes: [
        [literal(`FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / ${bucketSec}) * ${bucketSec})`), 'bucket'],
        [fn('AVG', col('rx_rate')), 'avg_rx'],
        [fn('AVG', col('tx_rate')), 'avg_tx'],
        [fn('MAX', col('rx_rate')), 'max_rx'],
        [fn('MAX', col('tx_rate')), 'max_tx'],
        [fn('COUNT', col('id')), 'cnt']
      ],
      group: [literal(`FLOOR(UNIX_TIMESTAMP(recorded_at) / ${bucketSec})`)],
      order: [[literal('bucket'), 'ASC']],
      raw: true
    });

    const data = rows.map(r => ({
      time:        r.bucket,
      rx_mbps:     parseFloat((r.avg_rx / 1e6).toFixed(3)),
      tx_mbps:     parseFloat((r.avg_tx / 1e6).toFixed(3)),
      max_rx_mbps: parseFloat((r.max_rx / 1e6).toFixed(3)),
      max_tx_mbps: parseFloat((r.max_tx / 1e6).toFixed(3)),
    }));

    res.json({
      success: true,
      data,
      meta: { range, label: cfg.label, points: data.length, queueName: queueName || null, pppoeUser: pppoeUser || null }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;