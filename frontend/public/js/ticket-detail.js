'use strict';
// TICKET_ID injected from EJS: const TICKET_ID = '...';

let ticketData   = null;
let leafletMap   = null;
let selectedFiles = [];

const $ = id => document.getElementById(id);
const setText = (id, html, isHTML=false) => {
  const el = $(id);
  if (!el) return;
  if (isHTML) el.innerHTML = html;
  else el.textContent = html;
};

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadTicket();
});

// ── Load ticket ───────────────────────────────────────────────
async function loadTicket() {
  try {
    const r = await fetch(`/api/tickets/${TICKET_ID}`);
    const j = await r.json();
    if (!j.success) {
      showError('Ticket tidak ditemukan');
      return;
    }
    ticketData = j.data;
    renderTicket(ticketData);
    $('tdLoading').style.display = 'none';
    $('tdMain').style.display = 'block';
  } catch(e) {
    showError('Gagal memuat ticket: ' + e.message);
  }
}

function showError(msg) {
  $('tdLoading').innerHTML = `<div style="text-align:center;color:#ef4444;padding:40px;"><div style="font-size:18px;margin-bottom:8px;">⚠</div><div>${msg}</div><a href="/tickets" style="color:#6366f1;font-weight:700;">← Kembali ke daftar</a></div>`;
}

// ── Render ticket ─────────────────────────────────────────────
function renderTicket(t) {
  // Header
  setText('tdNum',   t.ticket_number);
  setText('tdTitle', t.title);
  $('tdStatusSelect').value = t.status;

  // Meta badges
  $('tdMeta').innerHTML = `
    <span class="badge badge-type-${t.type}">${typeLabel(t.type)}</span>
    <span class="badge badge-prio-${t.priority}">${prioLabel(t.priority)}</span>
    <span style="font-size:11px;color:#94a3b8;">${formatDate(t.created_at)}</span>
    ${t.creator ? `<span style="font-size:11px;color:#94a3b8;">oleh ${escHtml(t.creator.name)}</span>` : ''}
  `;

  // Customer card
  if (t.customer) {
    const c = t.customer;
    $('tdCustomerCard').style.display = 'block';
    $('tdCustomerBody').innerHTML = `
      <div class="td-cust-card">
        <div class="td-cust-avatar">${c.name.charAt(0).toUpperCase()}</div>
        <div>
          <div class="td-cust-name">${escHtml(c.name)}</div>
          <div class="td-cust-phone">${c.phone || '—'}</div>
        </div>
        ${c.phone ? `<a href="https://wa.me/62${c.phone.replace(/^0/,'')}" target="_blank" title="WhatsApp" style="margin-left:auto;padding:6px;border-radius:8px;background:#f0fdf4;color:#16a34a;display:flex;align-items:center;justify-content:center;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        </a>` : ''}
      </div>
      ${c.address ? `<div style="font-size:12px;color:#64748b;margin-top:6px;"><b>📍</b> ${escHtml(c.address)}</div>` : ''}
    `;
  }

  // Info grid
  const assigneeHtml = t.assignee
    ? `<div style="display:flex;align-items:center;gap:6px;"><span style="width:22px;height:22px;border-radius:50%;background:#eef2ff;color:#6366f1;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;">${t.assignee.name.charAt(0).toUpperCase()}</span>${escHtml(t.assignee.name)}</div>`
    : '<span style="color:#94a3b8;">Belum ditugaskan</span>';

  $('tdInfoGrid').innerHTML = `
    <div class="td-info-item"><label>Tipe</label><span class="badge badge-type-${t.type}">${typeLabel(t.type)}</span></div>
    <div class="td-info-item"><label>Prioritas</label><span class="badge badge-prio-${t.priority}">${prioLabel(t.priority)}</span></div>
    <div class="td-info-item"><label>Status</label><span class="badge badge-status-${t.status}">${statusLabel(t.status)}</span></div>
    <div class="td-info-item"><label>Teknisi</label><span>${assigneeHtml}</span></div>
    <div class="td-info-item"><label>Dibuat</label><span>${formatDateTime(t.created_at)}</span></div>
    <div class="td-info-item"><label>Due Date</label><span>${t.due_at ? formatDateTime(t.due_at) : '—'}</span></div>
    ${t.resolved_at ? `<div class="td-info-item"><label>Diselesaikan</label><span>${formatDateTime(t.resolved_at)}</span></div>` : ''}
    ${t.location_note ? `<div class="td-info-item" style="grid-column:1/-1;"><label>Catatan Lokasi</label><span>${escHtml(t.location_note)}</span></div>` : ''}
  `;

  // SLA
  renderSLA(t);

  // Map
  const lat = parseFloat(t.latitude || t.customer?.latitude || t.infraPoint?.latitude);
  const lng = parseFloat(t.longitude || t.customer?.longitude || t.infraPoint?.longitude);
  if (!isNaN(lat) && !isNaN(lng)) {
    $('tdMapCard').style.display = 'block';
    setTimeout(() => initMap(lat, lng, t), 200);
  }

  // Timeline
  renderTimeline(t.timelines || []);
}

// ── SLA ───────────────────────────────────────────────────────
function renderSLA(t) {
  if (!t.due_at || ['resolved','closed'].includes(t.status)) {
    $('tdSlaLabel').textContent = t.status === 'resolved' ? '✓ Selesai' : t.status === 'closed' ? 'Ditutup' : '—';
    $('tdSlaDesc').textContent  = t.resolved_at ? `Diselesaikan ${formatRelative(t.resolved_at)}` : '—';
    $('tdSlaBar').style.width   = '100%';
    $('tdSlaBar').style.background = '#22c55e';
    return;
  }

  const created = new Date(t.created_at).getTime();
  const due     = new Date(t.due_at).getTime();
  const now     = Date.now();
  const total   = due - created;
  const elapsed = now - created;
  const pct     = Math.min(100, Math.max(0, (elapsed / total) * 100));
  const remaining = due - now;
  const isOverdue = remaining < 0;

  $('tdSlaLabel').textContent = isOverdue ? '⚠ Overdue' : formatDuration(remaining);
  $('tdSlaLabel').style.color = isOverdue ? '#ef4444' : pct > 80 ? '#f59e0b' : '#22c55e';
  $('tdSlaDesc').textContent  = isOverdue
    ? `Terlambat ${formatDuration(Math.abs(remaining))}`
    : `SLA ${t.sla_hours}j — sisa ${formatDuration(remaining)}`;

  const barColor = isOverdue ? '#ef4444' : pct > 80 ? '#f59e0b' : '#22c55e';
  $('tdSlaBar').style.width      = pct + '%';
  $('tdSlaBar').style.background = barColor;
}

function formatDuration(ms) {
  const abs = Math.abs(ms);
  const h   = Math.floor(abs / 3600000);
  const m   = Math.floor((abs % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h/24)}h ${h%24}j`;
  if (h > 0)  return `${h}j ${m}m`;
  return `${m} menit`;
}

// ── Map ───────────────────────────────────────────────────────
function initMap(lat, lng, t) {
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  const el = $('tdMap');
  if (!el) return;

  leafletMap = L.map('tdMap', { zoomControl: true }).setView([lat, lng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(leafletMap);

  // Ticket marker
  const ticketIcon = L.divIcon({
    html: `<div style="width:32px;height:32px;border-radius:50% 50% 50% 0;background:#6366f1;border:3px solid #fff;box-shadow:0 2px 8px rgba(99,102,241,.5);transform:rotate(-45deg);"></div>`,
    className: '', iconSize: [32,32], iconAnchor: [16,32]
  });
  const marker = L.marker([lat, lng], { icon: ticketIcon }).addTo(leafletMap);
  marker.bindPopup(`<b>${escHtml(t.title)}</b><br>${t.location_note || t.customer?.address || ''}`, { maxWidth: 220 }).openPopup();

  // Customer location if different
  if (t.customer?.latitude && t.customer?.longitude) {
    const cLat = parseFloat(t.customer.latitude);
    const cLng = parseFloat(t.customer.longitude);
    if (Math.abs(cLat - lat) > 0.0001 || Math.abs(cLng - lng) > 0.0001) {
      const custIcon = L.divIcon({
        html: `<div style="width:26px;height:26px;border-radius:50%;background:#22c55e;border:3px solid #fff;box-shadow:0 2px 6px rgba(34,197,94,.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;">P</div>`,
        className: '', iconSize: [26,26], iconAnchor: [13,13]
      });
      L.marker([cLat, cLng], { icon: custIcon }).addTo(leafletMap)
        .bindPopup(`<b>${escHtml(t.customer.name)}</b><br>${t.customer.address || ''}`);
    }
  }

  // InfraPoint marker
  if (t.infraPoint?.latitude && t.infraPoint?.longitude) {
    const infraIcon = L.divIcon({
      html: `<div style="width:24px;height:24px;border-radius:4px;background:#f59e0b;border:2px solid #fff;box-shadow:0 2px 6px rgba(245,158,11,.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:700;">ODP</div>`,
      className: '', iconSize: [24,24], iconAnchor: [12,12]
    });
    L.marker([parseFloat(t.infraPoint.latitude), parseFloat(t.infraPoint.longitude)], { icon: infraIcon })
      .addTo(leafletMap)
      .bindPopup(`<b>${escHtml(t.infraPoint.name)}</b><br>${t.infraPoint.address || ''}`);
  }
}

// ── Timeline ──────────────────────────────────────────────────
function renderTimeline(timelines) {
  const list = $('tlList');
  setText('tdTlCount', `${timelines.length} aktivitas`);

  if (!timelines.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:#94a3b8;font-size:13px;">Belum ada aktivitas</div>`;
    return;
  }

  list.innerHTML = timelines.map(tl => renderTimelineItem(tl)).join('');
}

function renderTimelineItem(tl) {
  const userName = tl.user?.name || 'Sistem';
  const initial  = userName.charAt(0).toUpperCase();
  const time     = formatDateTime(tl.created_at);
  const type     = tl.type || 'comment';

  let contentHtml = '';

  if (type === 'status_change') {
    contentHtml = `<div class="tl-status-change">
      <span class="badge badge-status-${tl.old_value}">${statusLabel(tl.old_value)}</span>
      <span class="tl-arrow">→</span>
      <span class="badge badge-status-${tl.new_value}">${statusLabel(tl.new_value)}</span>
    </div>`;
  } else if (type === 'system') {
    contentHtml = `<div style="font-size:12px;color:#94a3b8;font-style:italic;">${escHtml(tl.content||'')}</div>`;
  } else {
    if (tl.content) {
      contentHtml = `<div class="tl-content">${escHtml(tl.content)}</div>`;
    }
    if (tl.attachments?.length) {
      const attHtml = tl.attachments.map(a => {
        const isImg = /\.(jpg|jpeg|png|gif|webp)$/i.test(a.url);
        if (isImg) return `<img src="${a.url}" class="tl-photo" onclick="openLightbox('${a.url}')" alt="${escHtml(a.filename||'')}">`;
        return `<a href="${a.url}" class="tl-doc-link" target="_blank">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          ${escHtml(a.filename||'File')}
        </a>`;
      }).join('');
      contentHtml += `<div class="tl-attachments">${attHtml}</div>`;
    }
  }

  return `<div class="tl-item">
    <div class="tl-avatar ${type}">${type==='system'?'⚙':type==='status_change'?'↕':type==='assignment'?'→':initial}</div>
    <div class="tl-body">
      <div class="tl-meta">
        <span class="tl-name">${escHtml(userName)}</span>
        <span>·</span>
        <span>${time}</span>
        ${type!=='comment'&&type!=='photo' ? `<span>·</span><span style="font-size:10px;background:#f1f5f9;padding:2px 6px;border-radius:10px;color:#64748b;">${typeIconLabel(type)}</span>` : ''}
      </div>
      ${contentHtml}
    </div>
  </div>`;
}

function typeIconLabel(t) {
  return {comment:'💬 Komentar',status_change:'🔄 Status',assignment:'👤 Tugaskan',photo:'📷 Foto',system:'⚙ Sistem'}[t]||t;
}

// ── Submit comment ────────────────────────────────────────────
async function submitComment() {
  const content = $('commentInput').value.trim();
  if (!content && selectedFiles.length === 0) {
    $('commentInput').focus();
    return;
  }

  const btn = $('submitCommentBtn');
  btn.disabled = true; btn.innerHTML = '⏳ Mengirim...';

  try {
    const fd = new FormData();
    fd.append('content', content);
    fd.append('type', 'comment');
    selectedFiles.forEach(f => fd.append('attachments', f));

    const r = await fetch(`/api/tickets/${TICKET_ID}/timeline`, {
      method: 'POST', body: fd
    });
    const j = await r.json();

    if (j.success) {
      $('commentInput').value = '';
      selectedFiles = [];
      renderFilePreview();
      // Append new timeline item
      const list = $('tlList');
      const div = document.createElement('div');
      div.innerHTML = renderTimelineItem(j.data);
      list.appendChild(div.firstChild);
      list.lastChild.scrollIntoView({ behavior: 'smooth' });
      // Update status if changed
      await loadTicket();
    } else {
      alert('Error: ' + j.message);
    }
  } catch(e) { alert('Error: ' + e.message); }

  btn.disabled = false;
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Kirim Update';
}

// ── File handling ─────────────────────────────────────────────
function previewFiles(files) {
  selectedFiles = [...selectedFiles, ...Array.from(files)];
  renderFilePreview();
}

function renderFilePreview() {
  const preview = $('filePreview');
  if (!selectedFiles.length) { preview.innerHTML = ''; return; }
  preview.innerHTML = selectedFiles.map((f, i) =>
    `<span class="td-file-chip">
      ${f.type.startsWith('image/') ? '🖼' : '📄'} ${f.name.substring(0,20)}
      <button onclick="removeFile(${i})">✕</button>
    </span>`
  ).join('');
}

function removeFile(i) {
  selectedFiles.splice(i, 1);
  renderFilePreview();
}

// ── Status change ─────────────────────────────────────────────
async function changeStatus(newStatus) {
  if (!ticketData || newStatus === ticketData.status) return;
  try {
    const r = await fetch(`/api/tickets/${TICKET_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const j = await r.json();
    if (j.success) {
      ticketData.status = newStatus;
      // Reload for timeline update
      await loadTicket();
    } else { alert('Error: ' + j.message); }
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Delete ticket ─────────────────────────────────────────────
async function deleteTicket() {
  if (!confirm(`Hapus ticket "${ticketData?.title}"?\n\nSemua timeline dan data terkait akan dihapus.`)) return;
  try {
    const r = await fetch(`/api/tickets/${TICKET_ID}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.success) window.location.href = '/tickets';
    else alert('Error: ' + j.message);
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Lightbox ──────────────────────────────────────────────────
function openLightbox(src) {
  $('tkLightboxImg').src = src;
  $('tkLightbox').classList.add('show');
}
function closeLightbox() { $('tkLightbox').classList.remove('show'); }

// ── Helpers ───────────────────────────────────────────────────
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function typeLabel(t)   { return {gangguan:'Gangguan',request:'Request',installation:'Instalasi',maintenance:'Maintenance'}[t]||t; }
function prioLabel(p)   { return {critical:'⚡ Critical',high:'🔴 High',medium:'🟡 Medium',low:'🟢 Low'}[p]||p; }
function statusLabel(s) { return {open:'Open',in_progress:'In Progress',pending:'Pending',resolved:'Resolved',closed:'Closed'}[s]||s; }

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
}
function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function formatRelative(d) {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  const abs  = Math.abs(diff);
  if (abs < 60000)    return 'Baru saja';
  if (abs < 3600000)  return `${Math.floor(abs/60000)} mnt lalu`;
  if (abs < 86400000) return `${Math.floor(abs/3600000)} jam lalu`;
  return `${Math.floor(abs/86400000)} hari lalu`;
}

// Close lightbox on ESC
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

// Ctrl+Enter to submit comment
$('commentInput')?.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') submitComment();
});
