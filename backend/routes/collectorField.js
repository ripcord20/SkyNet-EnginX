/**
 * routes/collectorField.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sub-router sisi LAPANGAN (role 'collector'). Mount di routes/api.js:
 *
 *     const fieldRoutes = require('./collectorField');
 *     router.use('/field', authenticate, demoGuard, fieldRoutes);
 *
 * Foto check-in disimpan di uploads/payment_proofs (folder yang sama dengan
 * bukti transfer — sudah diblokir dari static serving, hanya via endpoint
 * ber-auth). Reuse konvensi penamaan acak.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authorize } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');
const CollectorFieldController = require('../controllers/CollectorFieldController');
const CashDepositController = require('../controllers/CashDepositController');

// ── Storage foto lapangan (reuse folder payment_proofs) ──────────────
const PROOF_DIR = path.join(__dirname, '..', '..', 'uploads', 'payment_proofs');
function ensureDir() { try { if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true }); } catch (_) {} }
const storage = multer.diskStorage({
  destination: (req, file, cb) => { ensureDir(); cb(null, PROOF_DIR); },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const rand = require('crypto').randomBytes(12).toString('hex');
    cb(null, 'field_' + Date.now() + '_' + rand + (ext || '.jpg'));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype || '')
            || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.originalname || '');
    if (ok) return cb(null, true);
    cb(new Error('Format foto tidak didukung (hanya gambar)'));
  }
});
const checkinUpload = upload.fields([
  { name: 'photo_location', maxCount: 1 },
  { name: 'photo_house', maxCount: 1 }
]);
// Bungkus agar error multer (mis. file kebesaran) dibalas JSON rapi.
function checkinUploadSafe(req, res, next) {
  checkinUpload(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'Upload foto gagal' });
    next();
  });
}
// Upload bukti setor (single file).
const depositUpload = upload.single('proof');
function depositUploadSafe(req, res, next) {
  depositUpload(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'Upload bukti gagal' });
    next();
  });
}
// Upload bukti pembayaran lapangan (single, opsional). Field name 'proof'.
const payUpload = upload.single('proof');
function payUploadSafe(req, res, next) {
  payUpload(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'Upload foto gagal' });
    next();
  });
}

const onlyCollector = authorize('collector', 'superadmin', 'admin');

// ── Read ──────────────────────────────────────────────────────────
router.get('/me',    onlyCollector, (r, s) => CollectorFieldController.me(r, s));
router.get('/tasks', onlyCollector, (r, s) => CollectorFieldController.tasks(r, s));
router.get('/profile',     onlyCollector, (r, s) => CollectorFieldController.profile(r, s));
router.get('/performance', onlyCollector, (r, s) => CollectorFieldController.performance(r, s));

// ── Profil (kolektor) ─────────────────────────────────────────────
router.post('/profile/phone',    onlyCollector, (r, s) => CollectorFieldController.updatePhone(r, s));
router.post('/profile/password', onlyCollector, (r, s) => CollectorFieldController.changePassword(r, s));

// ── Write ─────────────────────────────────────────────────────────
router.post('/checkin',      onlyCollector, checkinUploadSafe, (r, s) => CollectorFieldController.checkin(r, s));
router.post('/visit-result', onlyCollector, logActivity('visit', 'collection'), (r, s) => CollectorFieldController.visitResult(r, s));
router.post('/pay',          onlyCollector, payUploadSafe, logActivity('payment', 'field_collection'), (r, s) => CollectorFieldController.pay(r, s));
router.post('/send-link',    onlyCollector, logActivity('send_link', 'collection'), (r, s) => CollectorFieldController.sendLink(r, s));

// ── Setoran kas (kolektor) ────────────────────────────────────────
router.get('/deposits',  onlyCollector, (r, s) => CashDepositController.myDeposits(r, s));
router.get('/deposits/:id/proof', onlyCollector, (r, s) => CashDepositController.myDepositProof(r, s));
router.get('/assignments/:id/proof', onlyCollector, (r, s) => CollectorFieldController.paymentProof(r, s));
router.post('/deposit',  onlyCollector, depositUploadSafe, logActivity('deposit', 'cash'), (r, s) => CashDepositController.create(r, s));

module.exports = router;
