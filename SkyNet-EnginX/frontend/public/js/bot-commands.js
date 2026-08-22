/* bot-commands.js — UI tab "Perintah Bot" di Telegram Center.
 * Bergantung pada window.App.api (helper fetch) yang sudah ada di app.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let _commands = [];
  let _sources = [];
  let _editId = null;       // null = create
  let _editIsSystem = false;

  const TYPE_LABEL = { builtin: 'Bawaan', reply: 'Balasan Statis', data: 'Aksi Data' };
  const TYPE_COLOR = { builtin: '#1a6ef5', reply: '#0d9488', data: '#7c3aed' /* not used; avoid purple */ };

  async function load() {
    const box = $('botcmd-list');
    if (!box) return;
    try {
      const r = await App.api('/telegram/commands');
      if (!r || !r.success) { box.innerHTML = err('Gagal memuat perintah.'); return; }
      _commands = r.data || [];
      _sources = r.sources || [];
      render();
    } catch (e) {
      box.innerHTML = err('Gagal memuat: ' + (e.message || e));
    }
  }

  function err(m) { return `<div class="botcmd-err" style="display:block;margin:8px 0;">${esc(m)}</div>`; }

  function render() {
    const box = $('botcmd-list');
    box.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-width:780px;';
    if (!_commands.length) { box.innerHTML = '<div style="padding:14px;font-size:12px;color:#64748b;">Belum ada perintah.</div>'; return; }
    const ROW = 'display:flex;align-items:center;gap:12px;padding:12px 14px;border:1.5px solid #e8edf5;border-radius:11px;background:#fff;';
    const TAG = 'display:inline-block;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 7px;border-radius:5px;white-space:nowrap;';
    const BTN = 'display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1.5px solid #e8edf5;border-radius:8px;background:#fff;cursor:pointer;color:#64748b;flex-shrink:0;';
    box.innerHTML = _commands.map(c => {
      const tcolor = c.type === 'builtin' ? '#1a6ef5' : c.type === 'data' ? '#0d9488' : '#475569';
      const tbg = c.type === 'builtin' ? 'rgba(26,110,245,.10)' : c.type === 'data' ? 'rgba(13,148,136,.12)' : 'rgba(71,85,105,.10)';
      const aliases = (c.aliases || '').split(',').map(s => s.trim()).filter(Boolean);
      const aliasHtml = aliases.length ? ` <span style="font-size:10.5px;font-weight:600;color:#94a3b8;">alias: ${aliases.map(a => '/' + esc(a)).join(', ')}</span>` : '';
      const ctrl = c.require_control ? `<span style="${TAG}color:#dc2626;background:rgba(220,38,38,.10);">kontrol</span>` : '';
      const off = !c.enabled ? `<span style="${TAG}color:#94a3b8;background:rgba(148,163,184,.14);">nonaktif</span>` : '';
      const editBtn = `<button onclick="BotCmd.openEdit(${c.id})" title="Edit" style="${BTN}" onmouseover="this.style.borderColor='#1a6ef5';this.style.color='#1a6ef5';" onmouseout="this.style.borderColor='#e8edf5';this.style.color='#64748b';"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
      const delBtn = c.is_system ? '' : `<button onclick="BotCmd.remove(${c.id})" title="Hapus" style="${BTN}" onmouseover="this.style.borderColor='#dc2626';this.style.color='#dc2626';" onmouseout="this.style.borderColor='#e8edf5';this.style.color='#64748b';"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg></button>`;
      return `<div style="${ROW}${c.enabled ? '' : 'opacity:.62;'}">
        <div style="flex:1;min-width:0;">
          <div style="font-family:'DM Mono',monospace;font-size:13px;font-weight:700;color:#1e293b;">/${esc(c.keyword)}${aliasHtml}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;line-height:1.4;">${esc(c.description || '—')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;max-width:190px;">
          <span style="${TAG}color:${tcolor};background:${tbg};">${TYPE_LABEL[c.type] || c.type}</span>
          ${ctrl}${off}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${editBtn}${delBtn}${miniSwitch(c)}
        </div>
      </div>`;
    }).join('');
  }

  // Mini toggle switch dengan style inline (cache-proof).
  function miniSwitch(c) {
    const on = !!c.enabled;
    const track = `position:relative;display:inline-block;width:38px;height:21px;border-radius:21px;background:${on ? '#1a6ef5' : '#cbd5e1'};cursor:pointer;flex-shrink:0;transition:background .18s;`;
    const knob = `position:absolute;width:15px;height:15px;top:3px;left:${on ? '20px' : '3px'};background:#fff;border-radius:50%;transition:left .18s;`;
    return `<span title="${on ? 'Nonaktifkan' : 'Aktifkan'}" style="${track}" onclick="BotCmd.toggle(${c.id}, ${on ? 'false' : 'true'})"><span style="${knob}"></span></span>`;
  }

  function fillSources() {
    const sel = $('bc-source');
    sel.innerHTML = _sources.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
  }

  function onSourceChange() {
    const key = $('bc-source').value;
    const src = _sources.find(s => s.key === key);
    if (!src) { $('bc-source-hint').textContent = ''; $('bc-placeholders').innerHTML = ''; return; }
    $('bc-source-hint').textContent = src.needsArg ? `Butuh argumen: ${src.argHint}` : 'Tidak butuh argumen.';
    showPlaceholders(src.placeholders);
  }

  function showPlaceholders(list) {
    const ph = (list || []).concat(['{waktu}']);
    $('bc-placeholders').innerHTML = 'Placeholder: ' + ph.map(p =>
      `<code class="bc-ph" onclick="BotCmd.insertPh('${esc(p)}')">${esc(p)}</code>`).join(' ');
  }

  function onTypeChange() {
    const t = $('bc-type').value;
    $('bc-source-field').style.display = t === 'data' ? '' : 'none';
    if (t === 'data') { onSourceChange(); }
    else { showPlaceholders(['{arg}']); }
  }

  function insertPh(p) {
    const ta = $('bc-template');
    const s = ta.selectionStart || ta.value.length;
    ta.value = ta.value.slice(0, s) + p + ta.value.slice(ta.selectionEnd || s);
    ta.focus();
  }

  function openCreate() {
    _editId = null; _editIsSystem = false;
    $('botcmd-dlg-title').textContent = 'Tambah Perintah';
    $('botcmd-sys-note').style.display = 'none';
    $('bc-keyword').value = ''; $('bc-keyword').disabled = false;
    $('bc-aliases').value = '';
    $('bc-type-field').style.display = '';
    $('bc-type').value = 'reply'; $('bc-type').disabled = false;
    $('bc-desc').value = '';
    $('bc-template').value = '';
    $('bc-control').checked = false;
    $('bc-enabled').checked = true;
    fillSources();
    onTypeChange();
    showErr('');
    open();
  }

  function openEdit(id) {
    const c = _commands.find(x => x.id === id);
    if (!c) return;
    _editId = id; _editIsSystem = !!c.is_system;
    $('botcmd-dlg-title').textContent = 'Edit Perintah /' + c.keyword;
    $('botcmd-sys-note').style.display = c.is_system ? '' : 'none';
    $('bc-keyword').value = c.keyword; $('bc-keyword').disabled = !!c.is_system;
    $('bc-aliases').value = c.aliases || '';
    // Tipe: builtin tidak bisa diubah tipe-nya.
    fillSources();
    if (c.type === 'builtin') {
      $('bc-type-field').style.display = 'none';
      $('bc-source-field').style.display = 'none';
      showPlaceholders([]); // builtin: template umumnya kosong
    } else {
      $('bc-type-field').style.display = '';
      $('bc-type').value = c.type; $('bc-type').disabled = false;
      if (c.type === 'data') { $('bc-source').value = c.data_source || (_sources[0] && _sources[0].key); onSourceChange(); }
      else { onTypeChange(); }
    }
    $('bc-desc').value = c.description || '';
    $('bc-template').value = c.reply_template || '';
    $('bc-control').checked = !!c.require_control;
    $('bc-enabled').checked = !!c.enabled;
    showErr('');
    open();
  }

  function open() { $('botcmd-modal').style.display = 'flex'; }
  function close() { $('botcmd-modal').style.display = 'none'; }

  function showErr(m) {
    const e = $('bc-err');
    if (!m) { e.style.display = 'none'; e.textContent = ''; return; }
    e.style.display = 'block'; e.textContent = m;
  }

  async function save() {
    const btn = $('bc-save'); btn.disabled = true;
    try {
      const payload = {
        keyword: $('bc-keyword').value.trim(),
        aliases: $('bc-aliases').value.trim(),
        description: $('bc-desc').value.trim(),
        reply_template: $('bc-template').value,
        require_control: $('bc-control').checked,
        enabled: $('bc-enabled').checked,
      };
      if (!_editIsSystem) {
        payload.type = $('bc-type').value;
        if (payload.type === 'data') payload.data_source = $('bc-source').value;
      }
      let r;
      if (_editId == null) r = await App.api('/telegram/commands', { method: 'POST', body: JSON.stringify(payload) });
      else r = await App.api('/telegram/commands/' + _editId, { method: 'PUT', body: JSON.stringify(payload) });
      if (!r || !r.success) { showErr((r && r.message) || 'Gagal menyimpan.'); btn.disabled = false; return; }
      close(); await load();
    } catch (e) {
      showErr('Gagal: ' + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  }

  async function toggle(id, enabled) {
    try {
      await App.api('/telegram/commands/' + id, { method: 'PUT', body: JSON.stringify({ enabled }) });
      const c = _commands.find(x => x.id === id); if (c) c.enabled = enabled;
      render();
    } catch (_) { load(); }
  }

  async function remove(id) {
    const c = _commands.find(x => x.id === id);
    if (!c) return;
    if (!confirm(`Hapus perintah /${c.keyword}?`)) return;
    try {
      const r = await App.api('/telegram/commands/' + id, { method: 'DELETE' });
      if (!r || !r.success) { alert((r && r.message) || 'Gagal menghapus.'); return; }
      await load();
    } catch (e) { alert('Gagal: ' + (e.message || e)); }
  }

  window.BotCmd = { load, openCreate, openEdit, close, save, toggle, remove, onTypeChange, onSourceChange, insertPh };

  // Auto-load saat halaman siap.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
