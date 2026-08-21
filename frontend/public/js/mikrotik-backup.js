// FLAYNET.Com mikrotik-backup.js — Backup Konfigurasi MikroTik → Email
// Halaman: pengaturan jadwal, daftar router target, run-now (semua / per
// device), daftar file backup dengan download/hapus.

function _setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _toast(msg, type) { if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type || 'info'); else alert(msg); }
function _fmtSize(b) { b = b || 0; return b >= 1048576 ? (b/1048576).toFixed(2) + ' MB' : (b/1024).toFixed(1) + ' KB'; }

// ── Modal konfirmasi custom (pengganti confirm() native) ──────
// Promise-based: dipakai `if (!(await mbConfirm({...}))) return;`
let _mbConfirmResolver = null;
function mbConfirm({ title, message, okText = 'Ya, Lanjutkan', cancelText = 'Batal', tone = 'blue', okIcon } = {}) {
  const bg = document.getElementById('confirmModal');
  if (!bg) return Promise.resolve(window.confirm(message || title || ''));
  document.getElementById('cfmTitle').textContent = title || 'Konfirmasi';
  document.getElementById('cfmMsg').textContent = message || '';
  const ok = document.getElementById('cfmOk');
  const cancel = document.getElementById('cfmCancel');
  ok.textContent = okText;
  cancel.textContent = cancelText;
  ok.className = 'mb-modal-btn primary' + (tone === 'danger' ? ' danger' : '');
  const ic = document.getElementById('cfmIcon');
  ic.className = 'mb-modal-ic' + (tone === 'danger' ? ' danger' : tone === 'warn' ? ' warn' : '');
  if (okIcon) ic.innerHTML = okIcon;
  bg.classList.add('open');
  document.addEventListener('keydown', _mbConfirmKey);
  return new Promise(res => { _mbConfirmResolver = res; });
}
function mbConfirmResolve(val) {
  const bg = document.getElementById('confirmModal');
  if (bg) bg.classList.remove('open');
  document.removeEventListener('keydown', _mbConfirmKey);
  if (_mbConfirmResolver) { _mbConfirmResolver(val); _mbConfirmResolver = null; }
}
function _mbConfirmKey(e) {
  if (e.key === 'Escape') mbConfirmResolve(false);
  else if (e.key === 'Enter') mbConfirmResolve(true);
}

const FREQ_LABEL = { daily: 'Harian', weekly: 'Mingguan', monthly: 'Bulanan' };
const DOW_LABEL  = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];

let _running = false;

document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  loadInfo();
  loadDevices();
  loadFiles();
});

// ── Stat card → fokus panel terkait ───────────────────────────
// Kartu aktif berlatar biru (pola konsisten antar halaman). Klik
// menggulirkan ke panel terkait + memberi highlight singkat.
function mbCardClick(el) {
  document.querySelectorAll('.mb-card[data-target]').forEach(c => c.classList.remove('xc-active'));
  el.classList.add('xc-active');
  const panel = document.getElementById(el.dataset.target);
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.classList.remove('panel-flash');
    void panel.offsetWidth; // reflow agar animasi bisa diputar ulang
    panel.classList.add('panel-flash');
    setTimeout(() => panel.classList.remove('panel-flash'), 1000);
  }
}

// ── Info + isi form setting ───────────────────────────────────
async function loadInfo() {
  const d = await App.api('/mikrotik-backup/info');
  if (!d?.success) return;
  const i = d.data, s = i.settings || {};

  _setText('stRouters', i.router_count || 0);
  _setText('stFiles', i.file_count || 0);
  _setText('stSize', _fmtSize(i.total_size));

  // Backup terakhir
  if (i.last_at) {
    _setText('stLastAt', new Date(i.last_at).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }));
    _setText('stLastSummary', i.last_summary || '-');
    const pill = document.getElementById('stLastStatus');
    if (pill) {
      pill.textContent = i.last_status === 'ok' ? 'OK' : (i.last_status === 'partial' ? 'Sebagian' : (i.last_status || '-'));
      pill.className = 'mb-pill ' + (i.last_status === 'ok' ? 'green' : (i.last_status === 'partial' ? 'amber' : 'gray'));
    }
  }

  // Jadwal
  const hh = String(s.hour ?? 2).padStart(2,'0'), mm = String(s.minute ?? 0).padStart(2,'0');
  let schedTxt = (FREQ_LABEL[s.frequency] || 'Harian') + ' ' + hh + ':' + mm;
  if (s.frequency === 'weekly')  schedTxt = (DOW_LABEL[s.day_of_week] || 'Senin') + ' ' + hh + ':' + mm;
  if (s.frequency === 'monthly') schedTxt = 'Tgl ' + (s.day_of_month || 1) + ' ' + hh + ':' + mm;
  _setText('stSchedule', schedTxt);
  const enPill = document.getElementById('stEnabledPill');
  if (enPill) {
    enPill.textContent = s.enabled ? 'Aktif' : 'Nonaktif';
    enPill.className = 'mb-pill ' + (s.enabled ? 'green' : 'gray');
  }
  _setText('stEmailSub', s.send_email ? ('Email: ' + (s.recipients || 'belum diisi')) : 'Email nonaktif');

  // Isi form
  setVal('setEnabled', !!s.enabled, true);
  setVal('setFrequency', s.frequency || 'daily');
  setVal('setHour', s.hour ?? 2);
  setVal('setMinute', s.minute ?? 0);
  setVal('setDayOfWeek', s.day_of_week ?? 1);
  setVal('setDayOfMonth', s.day_of_month ?? 1);
  setVal('setSendEmail', !!s.send_email, true);
  setVal('setRecipients', s.recipients || '');
  setVal('setIncludeBinary', !!s.include_binary, true);
  setVal('setRetention', s.retention ?? 14);
  setVal('setSshPort', s.ssh_port ?? 22);
  onFreqChange();
}

function setVal(id, v, isCheck) {
  const e = document.getElementById(id);
  if (!e) return;
  if (isCheck) e.checked = !!v; else e.value = v;
}

function onFreqChange() {
  const f = document.getElementById('setFrequency')?.value || 'daily';
  document.getElementById('dowField').style.display = f === 'weekly' ? 'block' : 'none';
  document.getElementById('domField').style.display = f === 'monthly' ? 'block' : 'none';
}

// ── Simpan setting ────────────────────────────────────────────
async function saveSettings() {
  const body = {
    enabled:        document.getElementById('setEnabled')?.checked,
    frequency:      document.getElementById('setFrequency')?.value,
    hour:           parseInt(document.getElementById('setHour')?.value),
    minute:         parseInt(document.getElementById('setMinute')?.value),
    day_of_week:    parseInt(document.getElementById('setDayOfWeek')?.value),
    day_of_month:   parseInt(document.getElementById('setDayOfMonth')?.value),
    send_email:     document.getElementById('setSendEmail')?.checked,
    recipients:     document.getElementById('setRecipients')?.value || '',
    include_binary: document.getElementById('setIncludeBinary')?.checked,
    retention:      parseInt(document.getElementById('setRetention')?.value),
    ssh_port:       parseInt(document.getElementById('setSshPort')?.value),
  };
  const btn = document.getElementById('btnSave');
  if (btn) btn.disabled = true;
  try {
    const d = await App.api('/mikrotik-backup/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (d?.success) {
      _toast(d.message || 'Pengaturan tersimpan', 'success');
      if (d.warning) _toast(d.warning, 'warning');
      loadInfo();
    } else {
      _toast(d?.message || 'Gagal menyimpan', 'error');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Test email ────────────────────────────────────────────────
async function testEmail() {
  const btn = document.getElementById('btnTestEmail');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengirim...'; }
  try {
    const d = await App.api('/mikrotik-backup/test-email', { method: 'POST' });
    _toast(d?.message || (d?.success ? 'Terkirim' : 'Gagal'), d?.success ? 'success' : 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test Email Penerima'; }
  }
}

// ── Devices ───────────────────────────────────────────────────
async function loadDevices() {
  const d = await App.api('/mikrotik-backup/devices');
  const wrap = document.getElementById('devList');
  if (!d?.success) { if (wrap) wrap.innerHTML = '<div class="tbl-empty" style="color:#dc2626;">Gagal memuat</div>'; return; }
  const list = d.data || [];
  _setText('devSub', list.length + ' router aktif');
  if (!list.length) {
    if (wrap) wrap.innerHTML = '<div class="tbl-empty">Belum ada router aktif.<br>Tambahkan device tipe Router di menu Devices.</div>';
    return;
  }
  if (wrap) wrap.innerHTML = list.map(dev =>
    '<div class="dev-row">' +
      '<div class="dev-ic"><svg width="15" height="15" fill="none" stroke="#1d4ed8" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8"/></svg></div>' +
      '<div style="min-width:0;flex:1;"><div class="dev-name">' + _esc(dev.name) + '</div>' +
      '<div class="dev-ip">' + _esc(dev.ip_address) + ' · ' + _esc(dev.username) + '</div></div>' +
      '<button class="act-btn" title="Backup router ini" onclick="runBackup(' + dev.id + ')">' +
        '<svg width="12" height="12" fill="none" stroke="#16a34a" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>' +
      '</button>' +
    '</div>'
  ).join('');
}

// ── Run backup ────────────────────────────────────────────────
async function runBackup(deviceId) {
  if (_running) { _toast('Backup sedang berjalan — tunggu sampai selesai', 'warning'); return; }
  const isAll = !deviceId;
  const ok = await mbConfirm({
    title: isAll ? 'Backup Semua Router?' : 'Backup Router Ini?',
    message: 'Sistem akan SSH ke ' + (isAll ? 'seluruh router target' : 'router ini') + ', mengekspor konfigurasi, lalu mengirim hasilnya ke email. Proses bisa memakan waktu beberapa menit tergantung jumlah router.',
    okText: 'Ya, Jalankan',
    cancelText: 'Batal',
    tone: 'blue',
    okIcon: '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>'
  });
  if (!ok) return;

  _running = true;
  const btn = document.getElementById('btnRunAll');
  const icon = document.getElementById('runAllIcon');
  if (btn) btn.disabled = true;
  if (icon) icon.classList.add('spin');
  showResult('warn', 'Backup sedang berjalan... SSH ke router, export konfigurasi, dan kirim email. Mohon tunggu.');

  try {
    const d = await App.api('/mikrotik-backup/run', {
      method: 'POST',
      body: JSON.stringify(deviceId ? { device_id: deviceId } : {})
    });
    if (d?.success) {
      const det = (d.data?.results || []).map(r =>
        r.device_name + ': ' + (r.ok ? 'OK (' + r.files.map(f => f.filename).join(', ') + ')' : 'GAGAL — ' + (r.error || ''))
      ).join('\n');
      const allOk = (d.data?.results || []).every(r => r.ok);
      showResult(allOk ? 'ok' : 'warn', d.message + (det ? '\n' + det : ''));
      _toast(d.message, allOk ? 'success' : 'warning');
    } else {
      showResult('err', d?.message || 'Backup gagal');
      _toast(d?.message || 'Backup gagal', 'error');
    }
  } finally {
    _running = false;
    if (btn) btn.disabled = false;
    if (icon) icon.classList.remove('spin');
    loadFiles(); loadInfo();
  }
}

function showResult(type, text) {
  const box = document.getElementById('runResult');
  if (!box) return;
  box.className = 'run-result ' + type;
  box.style.display = 'block';
  box.style.whiteSpace = 'pre-wrap';
  box.style.margin = '12px 18px 0';
  box.textContent = text;
}

// ── Files ─────────────────────────────────────────────────────
async function loadFiles() {
  const d = await App.api('/mikrotik-backup/files');
  const tbody = document.getElementById('fileTable');
  const cards = document.getElementById('fileCards');
  if (!d?.success) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5"><div class="tbl-empty" style="color:#dc2626;">Gagal memuat</div></td></tr>';
    return;
  }
  const list = d.data || [];
  _setText('fileSub', list.length + ' file');
  if (!list.length) {
    const empty = '<div class="tbl-empty">Belum ada file backup.<br>Klik "Backup Semua Sekarang" untuk memulai.</div>';
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">' + empty + '</td></tr>';
    if (cards) cards.innerHTML = empty;
    return;
  }
  if (tbody) tbody.innerHTML = list.map(f => {
    const ext = f.filename.endsWith('.rsc') ? 'rsc' : 'backup';
    return '<tr>' +
      '<td style="font-family:\'DM Mono\',monospace;font-size:11.5px;word-break:break-all;">' + _esc(f.filename) + '</td>' +
      '<td><span class="ext-badge ext-' + ext + '">.' + ext + '</span></td>' +
      '<td style="font-size:12px;">' + _fmtSize(f.size) + '</td>' +
      '<td style="font-size:12px;color:#6b7fa8;">' + new Date(f.created_at).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) + '</td>' +
      '<td style="text-align:right;white-space:nowrap;">' +
        '<button class="act-btn" title="Download" onclick="downloadFile(\'' + encodeURIComponent(f.filename) + '\')"><svg width="12" height="12" fill="none" stroke="#1a6ef5" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg></button>' +
        '<button class="act-btn danger" title="Hapus" onclick="deleteFile(\'' + encodeURIComponent(f.filename) + '\')"><svg width="12" height="12" fill="none" stroke="#dc2626" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>' +
      '</td></tr>';
  }).join('');

  if (cards) cards.innerHTML = list.map(f => {
    const ext = f.filename.endsWith('.rsc') ? 'rsc' : 'backup';
    return '<div class="mbc-item">' +
      '<div style="min-width:0;"><div style="font-family:\'DM Mono\',monospace;font-size:11px;word-break:break-all;font-weight:600;">' + _esc(f.filename) + '</div>' +
      '<div style="font-size:10.5px;color:#94a3b8;margin-top:2px;"><span class="ext-badge ext-' + ext + '">.' + ext + '</span> ' + _fmtSize(f.size) + ' · ' + new Date(f.created_at).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) + '</div></div>' +
      '<div style="flex-shrink:0;">' +
        '<button class="act-btn" onclick="downloadFile(\'' + encodeURIComponent(f.filename) + '\')"><svg width="12" height="12" fill="none" stroke="#1a6ef5" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg></button>' +
        '<button class="act-btn danger" onclick="deleteFile(\'' + encodeURIComponent(f.filename) + '\')"><svg width="12" height="12" fill="none" stroke="#dc2626" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>' +
      '</div></div>';
  }).join('');
}

// Download dengan Authorization header (endpoint butuh token) — fetch blob.
async function downloadFile(encName) {
  const name = decodeURIComponent(encName);
  try {
    const headers = {};
    if (App.token && App.token !== 'null') headers['Authorization'] = 'Bearer ' + App.token;
    const res = await fetch('/api/mikrotik-backup/download/' + encName, { headers, credentials: 'include' });
    if (!res.ok) {
      let msg = 'Gagal download';
      try { msg = (await res.json()).message || msg; } catch (_) {}
      _toast(msg, 'error'); return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    _toast('Gagal download: ' + e.message, 'error');
  }
}

async function deleteFile(encName) {
  const name = decodeURIComponent(encName);
  const ok = await mbConfirm({
    title: 'Hapus File Backup?',
    message: 'File "' + name + '" akan dihapus permanen dari server dan tidak bisa dikembalikan.',
    okText: 'Ya, Hapus',
    cancelText: 'Batal',
    tone: 'danger',
    okIcon: '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>'
  });
  if (!ok) return;
  const d = await App.api('/mikrotik-backup/files/' + encName, { method: 'DELETE' });
  _toast(d?.message || (d?.success ? 'Dihapus' : 'Gagal'), d?.success ? 'success' : 'error');
  loadFiles(); loadInfo();
}
