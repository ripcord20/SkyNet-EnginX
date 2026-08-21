const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');
const { demoGuard } = require('../middleware/demoGuard');
const { controller: WA } = require('../controllers/WAController');

// ── Multer upload untuk send-media ─────────────────────────
const mediaUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Simpan di uploads/media (dir yang sama dengan inbound), supaya URL konsisten
    const dir = path.join(__dirname, '../../uploads/media');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    // Prefix 'wa_out' supaya gampang dibedakan dari inbound (prefix 'wa_')
    cb(null, 'wa_out_' + Date.now() + '_' + Math.random().toString(36).slice(2,7) + ext);
  }
});
const mediaUpload = multer({
  storage: mediaUploadStorage,
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB — sesuai batas WA Web
  fileFilter: (req, file, cb) => {
    // Blacklist ekstensi eksekusi
    const blacklist = ['.exe','.bat','.cmd','.sh','.ps1','.msi','.app','.scr','.com','.vbs','.js','.jar'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blacklist.includes(ext)) return cb(new Error('Tipe file tidak diizinkan: ' + ext));
    cb(null, true);
  }
});

// ── SESSIONS ────────────────────────────────────────────────
router.get('/sessions',                      authenticate, WA.getSessions.bind(WA));
router.post('/sessions',                     authenticate, authorize('superadmin','admin'), logActivity('create','wa_session'), WA.createSession.bind(WA));
router.put('/sessions/:session_id',          authenticate, authorize('superadmin','admin'), WA.updateSession.bind(WA));
router.delete('/sessions/:session_id',       authenticate, authorize('superadmin','admin'), logActivity('delete','wa_session'), WA.deleteSession.bind(WA));
router.post('/sessions/:session_id/connect', authenticate, authorize('superadmin','admin'), WA.connectSession.bind(WA));
router.post('/sessions/:session_id/disconnect', authenticate, authorize('superadmin','admin'), WA.disconnectSession.bind(WA));
router.get('/sessions/:session_id/qr',       authenticate, WA.getQr.bind(WA));

// ── MESSAGES ────────────────────────────────────────────────
router.get('/messages',       authenticate, WA.getMessages.bind(WA));
router.get('/conversations',  authenticate, WA.getConversations.bind(WA));
router.post('/send',     authenticate, logActivity('send','wa_message'), WA.sendMessage.bind(WA));
router.post('/message/delete', authenticate, demoGuard, logActivity('delete','wa_message'), WA.deleteMessage.bind(WA));
router.post('/send-media', authenticate, mediaUpload.single('file'), logActivity('send','wa_media'), WA.sendMedia.bind(WA));
router.post('/broadcast',authenticate, authorize('superadmin','admin'), logActivity('broadcast','wa_message'), WA.sendBroadcast.bind(WA));
router.post('/reminders',authenticate, authorize('superadmin','admin'), logActivity('send','wa_reminder'), WA.sendInvoiceReminders.bind(WA));

// ── AUTO REPLY ───────────────────────────────────────────────
router.get('/sessions/:session_id/auto-reply',        authenticate, WA.getAutoReplies.bind(WA));
router.post('/sessions/:session_id/auto-reply',       authenticate, authorize('superadmin','admin'), WA.createAutoReply.bind(WA));
router.put('/auto-reply/:id',                         authenticate, authorize('superadmin','admin'), WA.updateAutoReply.bind(WA));
router.delete('/auto-reply/:id',                      authenticate, authorize('superadmin','admin'), WA.deleteAutoReply.bind(WA));

// ── TEMPLATES ───────────────────────────────────────────────
router.get('/templates',     authenticate, WA.getTemplates.bind(WA));
router.post('/templates',    authenticate, authorize('superadmin','admin'), WA.createTemplate.bind(WA));
router.put('/templates/:id', authenticate, authorize('superadmin','admin'), WA.updateTemplate.bind(WA));
router.delete('/templates/:id', authenticate, authorize('superadmin','admin'), WA.deleteTemplate.bind(WA));

// ── LINK CONTACT ─────────────────────────────────────────────
router.post('/link-contact', authenticate, authorize('superadmin','admin'), WA.linkContact.bind(WA));
router.get('/search-customer', authenticate, WA.searchCustomer.bind(WA));
router.delete('/conversations', authenticate, logActivity('delete','wa_conversation'), WA.deleteConversation.bind(WA));

// ── REPORT TEMPLATE ──────────────────────────────────────────
router.get('/report/template', authenticate, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'report_template' } });
    res.json({ success: true, template: row?.value || '' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/report/template', authenticate, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const { template } = req.body;
    await AppSetting.upsert({ key: 'report_template', value: template, type: 'text' });
    res.json({ success: true, message: 'Template disimpan' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── STATS ────────────────────────────────────────────────────
router.get('/stats',       authenticate, WA.getStats.bind(WA));
router.post('/sync-status', authenticate, WA.syncStatus.bind(WA));
router.get('/profile-picture', authenticate, WA.getProfilePicture.bind(WA));
router.get('/profile-picture-img', authenticate, WA.getProfilePictureImg.bind(WA));
router.get('/profile-picture-debug', authenticate, WA.getProfilePictureDebug.bind(WA));
router.get('/debug-messages', authenticate, WA.debugMessages.bind(WA));

module.exports = router;