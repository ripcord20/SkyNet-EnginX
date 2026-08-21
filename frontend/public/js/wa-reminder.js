// wa-reminder.js — Automation Reminder (redesigned 3-column UI)
// Endpoint backend tidak berubah:
//   GET  /wa/reminders            -> { data:[reminder], templates:[{id,name,category,body}] }
//   POST /wa/reminders/save       -> { reminders:[{id,template_id,send_time,is_active}] }
//   POST /wa/reminders/run-now
//   POST /wa/reminders/test-send  -> { phone, reminder_id }
//   GET  /wa/reminders/history?limit=
//   POST /wa/reminders/seed

let _reminders = [];   // daftar reminder (ReminderSetting)
let _templates = [];   // template aktif {id,name,category,body}
let _cur       = null; // id reminder yang sedang diedit
let _dirty     = {};   // id -> { template_id, send_time, is_active }

const GRP = {
  before:  { label: 'Sebelum Jatuh Tempo', color: '#d97706', bg: '#fff8e6', dot: '#f59e0b' },
  due:     { label: 'Tepat Jatuh Tempo',   color: '#1565e0', bg: '#eef5ff', dot: '#1f8bff' },
  overdue: { label: 'Setelah Jatuh Tempo', color: '#dc2626', bg: '#fff0f2', dot: '#ef4444' }
};
const GRP_ORDER = ['before', 'due', 'overdue'];

document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  loadReminders();
  loadReminderHistory();
});

// ── Load ────────────────────────────────────────────────────────
async function loadReminders() {
  const d = await App.api('/wa/reminders');
  if (!d?.success) {
    renderEmptyState(d?.message);
    return;
  }
  _reminders = d.data || [];
  _templates = d.templates || [];
  _dirty = {};
  if (!_reminders.length) { renderEmptyState(); renderStats(); return; }
  if (!_cur || !_reminders.find(r => r.id === _cur)) _cur = _reminders[0].id;
  renderStats();
  renderList();
  loadEditor();
}

function renderEmptyState(errMsg) {
  const el = document.getElementById('rmList');
  if (el) el.innerHTML =
    '<div style="text-align:center;padding:36px 16px;">' +
      '<div style="font-size:13px;font-weight:700;color:#0d1b3e;margin-bottom:6px;">Belum ada konfigurasi reminder</div>' +
      '<div style="font-size:12px;color:#6b7fa8;margin-bottom:16px;line-height:1.5;">Buat 5 setting default<br>(H-3, H-1, Hari H, H+1, H+3)</div>' +
      '<button class="et-btn et-btn-primary" style="justify-content:center;margin:0 auto;" onclick="seedReminders()">Buat Data Default</button>' +
      (errMsg ? '<div style="font-size:11px;color:#dc2626;margin-top:10px;">Error: ' + _esc(errMsg) + '</div>' : '') +
    '</div>';
  const ed = document.getElementById('etEditor');
  if (ed) ed.innerHTML = '<div style="text-align:center;padding:40px 10px;color:#94a3b8;font-size:13px;">Belum ada reminder.</div>';
}

// ── Stats strip ─────────────────────────────────────────────────
function renderStats() {
  const total   = _reminders.length;
  const active  = _reminders.filter(r => r.is_active).length;
  const withTpl = _reminders.filter(r => r.template_id).length;
  _setText('fcTotal', total);
  _setText('fcTotalSub', active + ' aktif · ' + (total - active) + ' nonaktif');
  _setText('fcWithTpl', withTpl);
  _setText('fcActive', active);
  _setText('xp-total', total);
  _setText('xp-withtpl', withTpl);
  _setText('xp-active', total ? Math.round(active / total * 100) + '%' : '—');
  // sparkline statis ringan biar tidak kosong
  _spark('sp-total-line', 'sp-total-dot', [total ? total - 1 : 0, total, withTpl, active, total]);
  _spark('sp-withtpl-line', 'sp-withtpl-dot', [0, withTpl, withTpl, total, withTpl]);
  _spark('sp-active-line', 'sp-active-dot', [0, active, total, active, active]);
}

// ── List (kiri) ────────────────────────────────────────────────
function renderList() {
  const el = document.getElementById('rmList');
  if (!el) return;
  _setText('rmCount', _reminders.length);

  const groups = { before: [], due: [], overdue: [] };
  _reminders.forEach(r => { (groups[r.type] = groups[r.type] || []).push(r); });

  let html = '';
  GRP_ORDER.forEach(gk => {
    const items = groups[gk] || [];
    if (!items.length) return;
    const meta = GRP[gk];
    html += '<div class="rm-grp-lbl" style="color:' + meta.color + '">' +
              '<span class="dot" style="background:' + meta.dot + '"></span>' + meta.label +
            '</div>';
    items.forEach(r => {
      const d = draftOf(r.id);
      const dayLabel = _dayLabel(r);
      const tpl = _templates.find(t => t.id === d.template_id);
      const desc = tpl ? tpl.name : 'Belum ada template';
      const on = !!d.is_active;
      html += '<button class="et-item' + (r.id === _cur ? ' active' : '') + '" onclick="selectReminder(' + r.id + ')">' +
        '<div class="et-item-ic" style="background:' + meta.bg + ';color:' + meta.color + '">' + dayLabel + '</div>' +
        '<div class="et-item-b">' +
          '<span class="et-item-t">' + _grpShort(gk) + '</span>' +
          '<span class="et-item-d">' + _esc(desc) + '</span>' +
          '<span class="et-pill ' + (on ? 'on' : 'off') + '">' + (on ? '● AKTIF' : '○ NONAKTIF') + '</span>' +
        '</div>' +
      '</button>';
    });
  });
  el.innerHTML = html;
}

function _grpShort(gk) {
  return gk === 'before' ? 'Sebelum JT' : gk === 'due' ? 'Tepat JT' : 'Setelah JT';
}
function _dayLabel(r) {
  if (r.type === 'due') return 'H';
  return r.type === 'before' ? 'H-' + Math.abs(r.days_offset) : 'H+' + Math.abs(r.days_offset);
}

window.selectReminder = function(id) {
  _cur = id;
  renderList();
  loadEditor();
  // di mobile, tetap di tab edit
};

// ── Editor (tengah) ─────────────────────────────────────────────
function draftOf(id) {
  if (_dirty[id]) return _dirty[id];
  const r = _reminders.find(x => x.id === id) || {};
  return { template_id: r.template_id || null, send_time: (r.send_time || '08:00:00'), is_active: !!r.is_active };
}

function loadEditor() {
  const r = _reminders.find(x => x.id === _cur);
  const ed = document.getElementById('etEditor');
  if (!r || !ed) return;
  const meta = GRP[r.type] || GRP.due;
  const d = draftOf(r.id);
  const timeVal = (d.send_time || '08:00:00').substring(0, 5);

  _setText('etEditorTitle', 'Edit: ' + _grpShort(r.type) + ' (' + _dayLabel(r) + ')');

  const tplOpts = '<option value="">— Tanpa template (tidak dikirim) —</option>' +
    _templates.map(t => '<option value="' + t.id + '"' + (t.id === d.template_id ? ' selected' : '') + '>' + _esc(t.name) + '</option>').join('');

  ed.innerHTML =
    '<div class="et-field">' +
      '<div class="et-day-badge" style="background:' + meta.bg + ';color:' + meta.color + '">' +
        '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>' +
        _dayLabel(r) +
      '</div>' +
      '<div class="et-day-meta">' + _grpDesc(r) + '</div>' +
    '</div>' +

    '<div class="et-field">' +
      '<div class="et-label">Template Pesan</div>' +
      '<select class="et-sel" id="edTpl" onchange="onEditTpl(this.value)">' + tplOpts + '</select>' +
      '<div class="et-hint">Pesan yang dikirim saat reminder ini berjalan. Atur isi template di menu <b>Template Pesan WhatsApp</b>.</div>' +
    '</div>' +

    '<div class="et-field">' +
      '<div class="et-label">Jam Kirim</div>' +
      '<input type="time" class="et-inp" id="edTime" value="' + timeVal + '" onchange="onEditTime(this.value)">' +
      '<div class="et-hint">Reminder dikirim pada jam ini (zona waktu server). Scheduler memeriksa tiap menit.</div>' +
    '</div>' +

    '<div class="et-field">' +
      '<label class="et-switch">' +
        '<input type="checkbox" id="edActive" ' + (d.is_active ? 'checked' : '') + ' onchange="onEditActive(this.checked)">' +
        '<span class="et-track"></span>' +
        '<span class="et-switch-l">Aktifkan reminder ini</span>' +
      '</label>' +
      '<div class="et-hint" id="edActiveHint">' + (d.is_active ? 'Reminder berjalan otomatis sesuai jadwal.' : 'Reminder dimatikan — tidak akan dikirim.') + '</div>' +
    '</div>' +

    (!d.template_id ? '<div class="et-warn">Reminder ini belum punya template, jadi <b>tidak akan dikirim</b>. Pilih template di atas agar aktif.</div>' : '');

  updatePreview();
}

function _grpDesc(r) {
  if (r.type === 'before') return 'Dikirim ' + _dayLabel(r) + ' (' + Math.abs(r.days_offset) + ' hari sebelum jatuh tempo).';
  if (r.type === 'due')    return 'Dikirim tepat pada hari jatuh tempo.';
  return 'Dikirim ' + _dayLabel(r) + ' (' + Math.abs(r.days_offset) + ' hari setelah lewat jatuh tempo).';
}

function _ensureDirty(id) {
  if (!_dirty[id]) { const d = draftOf(id); _dirty[id] = { ...d }; }
  return _dirty[id];
}

window.onEditTpl = function(val) {
  const d = _ensureDirty(_cur);
  d.template_id = val ? parseInt(val) : null;
  renderList();
  // refresh warning + preview
  const ed = document.getElementById('etEditor');
  const warn = ed.querySelector('.et-warn');
  if (!d.template_id && !warn) loadEditor();
  else if (d.template_id && warn) warn.remove();
  updatePreview();
  markDirty();
};
window.onEditTime = function(val) {
  const d = _ensureDirty(_cur);
  d.send_time = (val || '08:00') + ':00';
  markDirty();
};
window.onEditActive = function(checked) {
  const d = _ensureDirty(_cur);
  d.is_active = !!checked;
  const hint = document.getElementById('edActiveHint');
  if (hint) hint.textContent = checked ? 'Reminder berjalan otomatis sesuai jadwal.' : 'Reminder dimatikan — tidak akan dikirim.';
  renderList();
  markDirty();
};

function markDirty() {
  const lbl = document.getElementById('btnSaveLabel');
  if (lbl && Object.keys(_dirty).length) lbl.textContent = 'Simpan Perubahan •';
}

// ── Preview WhatsApp bubble (kanan) ─────────────────────────────
function updatePreview() {
  const d = draftOf(_cur);
  const tpl = _templates.find(t => t.id === d.template_id);
  const bubble = document.getElementById('waBubble');
  const empty  = document.getElementById('waEmpty');
  const r = _reminders.find(x => x.id === _cur);

  // label kategori
  const catLabel = r ? (_grpShort(r.type) + ' (' + _dayLabel(r) + ')') : 'Reminder';
  _setText('waCatLabel', catLabel);
  _setText('waContactStatus', r ? _grpStatus(r.type) : 'reminder otomatis');

  if (!tpl || !(tpl.body || '').trim()) {
    if (bubble) bubble.style.display = 'none';
    if (empty)  empty.style.display = '';
    return;
  }
  // render contoh dengan data dummy realistis
  const sample = _fillSample(tpl.body);
  if (empty)  empty.style.display = 'none';
  if (bubble) bubble.style.display = '';
  const txt = document.getElementById('waText');
  if (txt) txt.innerHTML = _waFormat(sample);
  _setText('waTime', _nowJam());
}

function _grpStatus(type) {
  return type === 'before' ? 'reminder sebelum jatuh tempo'
       : type === 'due'    ? 'reminder jatuh tempo'
       : 'reminder overdue';
}

// Ganti variabel {xxx} dengan contoh data agar preview terlihat nyata.
function _fillSample(body) {
  const map = {
    nama: 'Budi Santoso', nohp: '628123456789', invoice: 'INV-2026-0042',
    paket: 'Paket 20 Mbps Home', periode: 'Juni 2026', jumlah: 'Rp 150.000',
    jatuh_tempo: '19 Juni 2026', tgl_jatuh_tempo: '19 Juni 2026', status: 'Belum Dibayar',
    cid: 'CID0042', link_bayar_permanen: 'http://localhost:3000/pub/cust/contohtokenpermanen',
    perusahaan: (window.__COMPANY || 'FLAYNET Internet Service')
  };
  return String(body || '').replace(/\{(\w+)\}/g, (m, k) => (map[k] != null ? map[k] : m));
}

// WhatsApp markup *bold* _italic_ ~strike~ ```mono```
function _waFormat(text) {
  let s = _esc(text || '');
  s = s.replace(/```([\s\S]+?)```/g, (_, t) => '<span class="wa-mono">' + t + '</span>');
  s = s.replace(/(?:^|\s)\*([^\s*][^*\n]*[^\s*]|[^\s*])\*(?=\s|[.,;:!?)\]]|$)/g,
    (m, t) => m.replace('*' + t + '*', '<span class="wa-bold">' + t + '</span>'));
  s = s.replace(/(?:^|\s)_([^\s_][^_\n]*[^\s_]|[^\s_])_(?=\s|[.,;:!?)\]]|$)/g,
    (m, t) => m.replace('_' + t + '_', '<span class="wa-italic">' + t + '</span>'));
  s = s.replace(/(?:^|\s)~([^\s~][^~\n]*[^\s~]|[^\s~])~(?=\s|[.,;:!?)\]]|$)/g,
    (m, t) => m.replace('~' + t + '~', '<span class="wa-strike">' + t + '</span>'));
  return s;
}
function _nowJam() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + '.' + d.getMinutes().toString().padStart(2, '0');
}

// ── Save ────────────────────────────────────────────────────────
window.saveReminders = async function() {
  // Kirim seluruh reminder (gabung draft + nilai asli) agar konsisten.
  const reminders = _reminders.map(r => {
    const d = draftOf(r.id);
    return {
      id: r.id,
      template_id: d.template_id || null,
      send_time: (d.send_time || '08:00:00'),
      is_active: d.is_active ? 1 : 0
    };
  });
  const btn = document.getElementById('btnSave');
  const ic = document.getElementById('btnSaveIcon');
  const lbl = document.getElementById('btnSaveLabel');
  const _ico = ic ? ic.outerHTML : '';
  btn.disabled = true;
  if (ic) ic.outerHTML = '<span class="et-spin-sm" id="btnSaveIcon"></span>';
  if (lbl) lbl.textContent = 'Menyimpan…';

  const d = await App.api('/wa/reminders/save', { method: 'POST', body: JSON.stringify({ reminders }) });

  const sp = document.getElementById('btnSaveIcon'); if (sp) sp.outerHTML = _ico;
  btn.disabled = false;
  if (lbl) lbl.textContent = 'Simpan Perubahan';

  if (d?.success) {
    _dirty = {};
    // refresh nilai asli dari server
    await loadReminders();
    showResult(true, 'Tersimpan!', d.message || 'Pengaturan reminder berhasil disimpan dan langsung berlaku.');
  } else {
    showResult(false, 'Gagal Menyimpan', d?.message || 'Perubahan tidak dapat disimpan. Coba lagi.');
  }
};

// ── Run now ─────────────────────────────────────────────────────
window.runReminderNow = async function() {
  const btn = document.getElementById('btnRunNow');
  btn.disabled = true; const _t = btn.innerHTML;
  btn.innerHTML = '<span class="et-spin-sm"></span> Memproses…';
  const d = await App.api('/wa/reminders/run-now', { method: 'POST', body: '{}' });
  btn.disabled = false; btn.innerHTML = _t;
  if (d?.success) {
    const matched = (d.matched !== undefined) ? d.matched : null;
    if (matched === 0) showResult(true, 'Tidak Ada Target', d.message || 'Tidak ada pelanggan yang cocok dengan kondisi jatuh tempo saat ini.');
    else showResult(true, 'Reminder Dijalankan', d.message || ((matched != null ? matched + ' pelanggan' : 'Pelanggan terkait') + ' diproses.'));
    loadReminderHistory();
  } else {
    showResult(false, 'Gagal', d?.message || 'Tidak dapat menjalankan reminder.');
  }
};

// ── Seed default ────────────────────────────────────────────────
window.seedReminders = async function() {
  const d = await App.api('/wa/reminders/seed', { method: 'POST', body: '{}' });
  if (d?.success) { App.showToast(d.message || '5 reminder default dibuat', 'success'); await loadReminders(); }
  else App.showToast(d?.message || 'Gagal membuat data default', 'error');
};

// ── Test send modal ─────────────────────────────────────────────
window.openTestModal = function() {
  const sel = document.getElementById('testReminder');
  if (!sel) return;
  const labelMap = { before: 'Sebelum JT', due: 'Tepat JT', overdue: 'Setelah JT' };
  const options = ['<option value="">— Pilih reminder dengan template —</option>'];
  _reminders.forEach(r => {
    const d = draftOf(r.id);
    if (!d.template_id) return;
    const tpl = _templates.find(t => t.id === d.template_id);
    const tplName = (tpl && tpl.name) || ('Template #' + d.template_id);
    options.push('<option value="' + r.id + '">' + _dayLabel(r) + ' (' + labelMap[r.type] + ') — ' + _esc(tplName) + '</option>');
  });
  sel.innerHTML = options.join('');
  if (options.length === 1) { App.showToast('Belum ada reminder dengan template. Pilih template dulu.', 'error', 5000); return; }
  if (_cur) { const cd = draftOf(_cur); if (cd.template_id) sel.value = String(_cur); }
  document.getElementById('testPhone').value = '';
  document.getElementById('testResult').style.display = 'none';
  document.getElementById('testModal').style.display = 'flex';
  setTimeout(() => document.getElementById('testPhone').focus(), 100);
};
window.closeTestModal = function() { document.getElementById('testModal').style.display = 'none'; };

window.submitTestSend = async function() {
  const phone = (document.getElementById('testPhone').value || '').trim();
  const reminderId = document.getElementById('testReminder').value;
  const resultBox = document.getElementById('testResult');
  const btn = document.getElementById('btnTestSubmit');
  if (!phone) { App.showToast('Nomor HP wajib diisi', 'error'); return; }
  if (!reminderId) { App.showToast('Pilih reminder terlebih dulu', 'error'); return; }

  btn.disabled = true;
  const _t = btn.innerHTML;
  btn.innerHTML = '<span class="et-spin-sm"></span> Mengirim…';
  resultBox.style.display = 'none';
  try {
    const d = await App.api('/wa/reminders/test-send', { method: 'POST', body: JSON.stringify({ phone, reminder_id: parseInt(reminderId) }) });
    if (d?.success) {
      resultBox.style.display = 'block';
      resultBox.style.background = '#ecfdf5'; resultBox.style.border = '1px solid #a7f3d0'; resultBox.style.color = '#065f46';
      resultBox.innerHTML =
        '<div style="font-weight:700;margin-bottom:4px;">✅ ' + _esc(d.message) + '</div>' +
        '<div style="font-size:11px;opacity:.85;">Template: <b>' + _esc(d.template_used || '-') + '</b></div>' +
        '<div style="font-size:11px;opacity:.85;">Sumber data: ' + _esc(d.data_source || '-') + '</div>' +
        (d.preview ? '<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:11px;font-weight:600;">Lihat preview pesan</summary><pre style="margin:6px 0 0;padding:8px;background:#fff;border-radius:6px;font-size:11px;font-family:\'DM Mono\',monospace;white-space:pre-wrap;line-height:1.5;border:1px solid #d1fae5;">' + _esc(d.preview) + '</pre></details>' : '');
      App.showToast('Test pesan terkirim', 'success');
    } else {
      resultBox.style.display = 'block';
      resultBox.style.background = '#fef2f2'; resultBox.style.border = '1px solid #fecaca'; resultBox.style.color = '#991b1b';
      resultBox.innerHTML = '<div style="font-weight:700;">⚠ Gagal: ' + _esc(d?.message || 'Unknown error') + '</div>';
    }
  } catch (e) {
    resultBox.style.display = 'block';
    resultBox.style.background = '#fef2f2'; resultBox.style.border = '1px solid #fecaca'; resultBox.style.color = '#991b1b';
    resultBox.innerHTML = '<div style="font-weight:700;">⚠ Error: ' + _esc(e.message) + '</div>';
  } finally {
    btn.disabled = false; btn.innerHTML = _t;
  }
};

// ── Riwayat pengiriman ──────────────────────────────────────────
async function loadReminderHistory() {
  const list = document.getElementById('remHistList');
  if (!list) return;
  try {
    const d = await App.api('/wa/reminders/history?limit=80');
    if (!d || !d.success) { list.innerHTML = '<div style="color:#dc2626;padding:14px;">Gagal memuat riwayat.</div>'; return; }
    _setText('remSent', (d.summary && d.summary.sent_today) || 0);
    _setText('remFailed', (d.summary && d.summary.failed_today) || 0);
    _setText('fcSentToday', (d.summary && d.summary.sent_today) || 0);
    _setText('fcSentSub', ((d.summary && d.summary.failed_today) || 0) + ' gagal');
    _setText('xp-sent', 'hari ini');
    _spark('sp-sent-line', 'sp-sent-dot', [0, 1, 0, 2, ((d.summary && d.summary.sent_today) || 0)]);

    if (!d.data || !d.data.length) {
      list.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:18px;">Belum ada pengiriman.</div>';
      return;
    }
    const typeLabel = { before: 'Sebelum JT', due: 'Jatuh Tempo', overdue: 'Overdue' };
    list.innerHTML = d.data.map(function (r) {
      const cust = r.customer || {};
      const ok = r.status === 'sent';
      const dot = ok ? '#16a34a' : '#dc2626';
      const when = r.created_at ? new Date(r.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      const errLine = (!ok && r.error_message) ? '<div style="font-size:10.5px;color:#dc2626;margin-top:2px;">' + _esc(r.error_message) + '</div>' : '';
      return '<div class="rm-hist-item">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + ';margin-top:5px;flex-shrink:0;"></span>' +
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-weight:600;color:#0d1b3e;">' + _esc(cust.name || r.phone || '-') +
            (cust.customer_id ? ' <span style="font-weight:400;color:#94a3b8;">(' + _esc(cust.customer_id) + ')</span>' : '') + '</div>' +
          '<div style="font-size:11px;color:#6b7fa8;margin-top:1px;">' +
            (typeLabel[r.reminder_type] || r.reminder_type || '-') + ' · ' + _esc(r.phone || '') + ' · ' + when + '</div>' +
          errLine +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<div style="color:#dc2626;padding:14px;">Error: ' + _esc(e.message || e) + '</div>';
  }
}

// ── Modal hasil sukses/gagal ────────────────────────────────────
const ICON_OK = '<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg"><path class="rm-draw" d="M14 27l8 8 16-18" stroke="#16a34a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ERR = '<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg"><path class="rm-draw" d="M18 18l16 16M34 18L18 34" stroke="#dc2626" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function showResult(ok, title, msg) {
  const overlay = document.getElementById('resultModal');
  const icon = document.getElementById('rmIcon');
  const card = document.getElementById('rmCard');
  overlay.style.display = 'flex';
  icon.className = 'rm-icon ' + (ok ? 'ok' : 'err');
  icon.innerHTML = ok ? ICON_OK : ICON_ERR;
  _setText('rmTitle', title || (ok ? 'Berhasil' : 'Gagal'));
  _setText('rmMsg', msg || '');
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
  overlay.style.animation = 'none'; void overlay.offsetWidth; overlay.style.animation = '';
}
window.closeResult = function() { document.getElementById('resultModal').style.display = 'none'; };
document.addEventListener('DOMContentLoaded', () => {
  const rm = document.getElementById('resultModal');
  if (rm) rm.addEventListener('click', function (e) { if (e.target === this) closeResult(); });
});

// ── Mobile tab switch ───────────────────────────────────────────
window.mtab = function(which) {
  document.querySelectorAll('.et-mtab').forEach(b => b.classList.toggle('active', b.dataset.mtab === which));
  const g = document.getElementById('etGrid');
  g.classList.toggle('m-edit', which === 'edit');
  g.classList.toggle('m-prev', which === 'prev');
};

// ── Sparkline helper ────────────────────────────────────────────
function _spark(lineId, dotId, vals) {
  const W = 66, H = 34;
  if (!vals || vals.length < 2) return;
  const mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
  const p = vals.map((n, i) => [(i / (vals.length - 1)) * W, H - ((n - mn) / r) * (H - 6) - 3]);
  let d = '';
  p.forEach(([x, y], i) => {
    if (!i) { d = 'M' + x.toFixed(1) + ',' + y.toFixed(1); return; }
    const [px, py] = p[i - 1], cx = (px + x) / 2;
    d += ' C' + cx.toFixed(1) + ',' + py.toFixed(1) + ' ' + cx.toFixed(1) + ',' + y.toFixed(1) + ' ' + x.toFixed(1) + ',' + y.toFixed(1);
  });
  const line = document.getElementById(lineId), dot = document.getElementById(dotId);
  if (line) line.setAttribute('d', d);
  if (dot) { const lp = p[p.length - 1]; dot.setAttribute('cx', lp[0].toFixed(1)); dot.setAttribute('cy', lp[1].toFixed(1)); }
}

// ── Utils ───────────────────────────────────────────────────────
function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
