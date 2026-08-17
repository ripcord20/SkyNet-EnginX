/* telegram-report.js — halaman /telegram/report */
(function () {
  'use strict';

  let state = { config: {}, blocks: [], defaultBlocks: [], dirty: false, telegram: {} };
  let previewTimer = null;

  function $(id) { return document.getElementById(id); }
  function nowClock() { const d = new Date(); return String(d.getHours()).padStart(2,'0')+'.'+String(d.getMinutes()).padStart(2,'0'); }
  function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  // Placeholder yang tersedia untuk template.
  const PHS = ['{perusahaan}','{tanggal}','{periode}','{pelanggan_baru}','{pelanggan_aktif}','{uang_masuk}',
    '{jml_pembayaran}','{penunggak}','{nilai_tunggakan}','{tiket_terbuka}','{tiket_baru}',
    '{perangkat_offline}','{perangkat_total}','{churn}','{voucher_terjual}','{voucher_omzet}',
    '{setoran_jml}','{setoran_total}','{arpu}','{income_delta}'];

  const BLOCK_META = {
    newcust:  { icon:'#1565e0', d:'Pelanggan baru & total aktif' },
    income:   { icon:'#16a34a', d:'Uang masuk periode' },
    overdue:  { icon:'#dc2626', d:'Invoice menunggak' },
    topdebt:  { icon:'#b45309', d:'3 penunggak nilai terbesar' },
    tickets:  { icon:'#e08a00', d:'Tiket terbuka & baru' },
    devices:  { icon:'#dc2626', d:'Perangkat offline' },
    churn:    { icon:'#e11d48', d:'Pelanggan berhenti/suspend' },
    vouchers: { icon:'#06b6d4', d:'Voucher hotspot terjual' },
    deposits: { icon:'#f59e0b', d:'Setoran kolektor terverifikasi' },
    arpu:     { icon:'#0ea5e9', d:'Rata-rata pendapatan/pelanggan' },
    compare:  { icon:'#1d4ed8', d:'Delta vs periode sebelumnya' },
  };

  async function init() {
    fillDom();
    renderPhs();
    await loadConfig();
  }

  function fillDom() {
    const dom = $('rp-dom');
    let h = '';
    for (let i = 1; i <= 28; i++) h += `<option value="${i}">Tanggal ${i}</option>`;
    dom.innerHTML = h;
  }
  function renderPhs() {
    $('rp-phs').innerHTML = PHS.map(p => `<span class="tg-ph" onclick="RP.insertPh('${p}')">${p}</span>`).join('');
  }

  async function loadConfig() {
    try {
      const r = await App.api('/telegram/report/config');
      if (!r || !r.success) throw new Error(r && r.message || 'Gagal memuat');
      state.config = r.config || {};
      state.blocks = r.blocks || [];
      state.defaultBlocks = r.default_blocks || [];
      state.telegram = r.telegram || {};

      const c = state.config;
      $('rp-enabled').checked = String(c.tgreport_enabled) === '1';
      $('rp-frequency').value = c.tgreport_frequency || 'daily';
      const hh = String(c.tgreport_hour != null && c.tgreport_hour !== '' ? c.tgreport_hour : 7).padStart(2,'0');
      const mm = String(c.tgreport_minute != null && c.tgreport_minute !== '' ? c.tgreport_minute : 0).padStart(2,'0');
      $('rp-time').value = hh + ':' + mm;
      $('rp-dow').value = c.tgreport_day_of_week != null && c.tgreport_day_of_week !== '' ? c.tgreport_day_of_week : '1';
      $('rp-dom').value = c.tgreport_day_of_month != null && c.tgreport_day_of_month !== '' ? c.tgreport_day_of_month : '1';
      $('rp-chat').value = c.tgreport_chat_id || '';
      $('rp-template').value = c.tgreport_template || '';
      if ($('rp-compare'))     $('rp-compare').checked     = String(c.tgreport_compare) === '1';
      if ($('rp-show-button')) $('rp-show-button').checked = String(c.tgreport_show_button) === '1';
      if ($('rp-notify-fail')) $('rp-notify-fail').checked = String(c.tgreport_notify_fail) === '1';
      state.tgLimit = r.tg_limit || 4096;

      renderBlocks();
      onFreqChange();
      refreshStatus();
      applyLast(r.last);
      renderHistory(r.history || []);
      checkTelegramReady();
      schedulePreview(true);
      state.dirty = false; setSaveDirty(false);
    } catch (e) {
      App.toast && App.toast('Gagal memuat: ' + e.message, 'error');
    }
  }

  function activeBlocks() {
    const raw = state.config.tgreport_blocks;
    if (raw != null && raw !== '') return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    return state.defaultBlocks.slice();
  }

  function renderBlocks() {
    const sel = activeBlocks();
    $('rp-blocks').innerHTML = state.blocks.map(b => {
      const m = BLOCK_META[b.key] || { icon:'#1f8bff', d:'' };
      const on = sel.includes(b.key);
      return `
        <label class="tg-check ${on?'on':''}" data-block="${b.key}">
          <span class="tg-check-ic" style="background:${hexA(m.icon,.13)}">
            <svg width="17" height="17" fill="none" stroke="${m.icon}" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          </span>
          <span class="tg-check-tx"><div class="tg-check-t">${escHtml(b.label)}</div><div class="tg-check-d">${escHtml(m.d)}</div></span>
          <label class="et-switch"><input type="checkbox" ${on?'checked':''} onchange="RP.toggleBlock('${b.key}',this)"><span class="et-track"></span></label>
        </label>`;
    }).join('');
    updateBlockStat(sel.length);
  }
  function hexA(hex,a){const h=hex.replace('#','');const n=parseInt(h,16);return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;}

  function toggleBlock(key, cb) {
    let sel = activeBlocks();
    if (cb.checked) { if (!sel.includes(key)) sel.push(key); }
    else sel = sel.filter(k => k !== key);
    state.config.tgreport_blocks = sel.join(',');
    cb.closest('.tg-check').classList.toggle('on', cb.checked);
    updateBlockStat(sel.length);
    onAnyChange(); schedulePreview();
  }
  function updateBlockStat(n) {
    $('scBlocks').textContent = n;
    $('scBlocksPill').textContent = n + '/' + state.blocks.length;
  }

  function insertPh(ph) {
    const ta = $('rp-template');
    const s = ta.selectionStart||0, e = ta.selectionEnd||0;
    ta.value = ta.value.slice(0,s) + ph + ta.value.slice(e);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + ph.length;
    onAnyChange(); schedulePreview();
  }
  function clearTemplate() { $('rp-template').value=''; onAnyChange(); schedulePreview(); }

  function onFreqChange() {
    const f = $('rp-frequency').value;
    $('rp-dow-wrap').style.display = f === 'weekly' ? '' : 'none';
    $('rp-dom-wrap').style.display = f === 'monthly' ? '' : 'none';
    $('scFreq').textContent = f === 'daily' ? 'Harian' : f === 'weekly' ? 'Mingguan' : 'Bulanan';
  }

  function refreshStatus() {
    const on = $('rp-enabled').checked;
    $('scStatus').textContent = on ? 'Aktif' : 'Nonaktif';
    $('scStatusDot').style.background = on ? '#22c55e' : '#cbd5e1';
    $('scStatusSub').textContent = on ? 'berjalan otomatis' : 'jadwal mati';
    $('scFreqPill').textContent = $('rp-time').value || '07:00';
  }

  function applyLast(last) {
    if (!last || !last.at) { $('scLast').textContent='—'; $('scLastPill').textContent='belum ada'; $('scLastPill').className='rm-sc-pill pill-grey'; return; }
    const d = new Date(last.at);
    $('scLast').textContent = isNaN(d) ? '—' : (d.getDate()+'/'+(d.getMonth()+1)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));
    const ok = last.status === 'ok';
    $('scLastPill').textContent = ok ? 'sukses' : (last.status || '—');
    $('scLastPill').className = 'rm-sc-pill ' + (ok ? 'pill-green' : 'pill-red');
  }

  function checkTelegramReady() {
    const t = state.telegram || {};
    const ready = t.has_token && (t.global_chat || $('rp-chat').value.trim());
    const w = $('tgWarn');
    if (ready) { w.style.display='none'; return; }
    w.style.display='flex';
    $('tgWarnText').textContent = !t.has_token
      ? 'Bot Telegram belum dikonfigurasi. Atur Bot Token & Chat ID dulu.'
      : 'Chat ID tujuan belum ada. Isi di bawah atau set Chat ID utama.';
  }

  // ── PREVIEW (debounced — fetch data real) ──────────────────────────
  function schedulePreview(now) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(doPreview, now ? 0 : 450);
  }
  async function doPreview() {
    try {
      const r = await App.api('/telegram/report/preview', { method:'POST', body: JSON.stringify({
        blocks: activeBlocks(), template: $('rp-template').value,
        frequency: $('rp-frequency').value,
        compare: $('rp-compare') ? $('rp-compare').checked : undefined,
      })});
      if (r && r.success) {
        $('tgText').innerHTML = renderTgHtml(r.text);
        $('tgTime').textContent = nowClock();
        $('tgEmpty').style.display='none'; $('tgBubble').style.display='block';
        updateCharCount(r.char_len, r.over_limit);
      } else {
        $('tgEmpty').textContent = (r && r.message) || 'Gagal memuat preview'; $('tgEmpty').style.display='flex'; $('tgBubble').style.display='none';
      }
    } catch (e) {
      $('tgEmpty').textContent = 'Gagal memuat preview'; $('tgEmpty').style.display='flex'; $('tgBubble').style.display='none';
    }
  }
  function updateCharCount(len, over) {
    const el = $('rp-charcount'); if (!el) return;
    const limit = state.tgLimit || 4096;
    el.textContent = (len != null ? len : '—') + ' / ' + limit + ' karakter';
    el.classList.toggle('over', !!over);
  }
  function renderTgHtml(s) {
    let out = escHtml(s);
    return out.replace(/&lt;b&gt;/g,'<b>').replace(/&lt;\/b&gt;/g,'</b>')
      .replace(/&lt;i&gt;/g,'<i>').replace(/&lt;\/i&gt;/g,'</i>')
      .replace(/&lt;code&gt;/g,'<code>').replace(/&lt;\/code&gt;/g,'</code>');
  }

  // ── SAVE / SEND ────────────────────────────────────────────────────
  function payload() {
    const [hh, mm] = ($('rp-time').value || '07:00').split(':');
    return {
      tgreport_enabled:      $('rp-enabled').checked ? '1' : '0',
      tgreport_frequency:    $('rp-frequency').value,
      tgreport_hour:         String(parseInt(hh,10)||0),
      tgreport_minute:       String(parseInt(mm,10)||0),
      tgreport_day_of_week:  $('rp-dow').value,
      tgreport_day_of_month: $('rp-dom').value,
      tgreport_chat_id:      $('rp-chat').value.trim(),
      tgreport_blocks:       activeBlocks().join(','),
      tgreport_template:     $('rp-template').value,
      tgreport_compare:      ($('rp-compare') && $('rp-compare').checked) ? '1' : '0',
      tgreport_show_button:  ($('rp-show-button') && $('rp-show-button').checked) ? '1' : '0',
      tgreport_notify_fail:  ($('rp-notify-fail') && $('rp-notify-fail').checked) ? '1' : '0',
    };
  }

  async function saveAll() {
    const btn=$('btnSave'), icon=$('btnSaveIcon'); btn.disabled=true;
    icon.outerHTML='<span class="et-spin-sm" id="btnSaveIcon"></span>';
    try {
      const r = await App.api('/telegram/report/save', { method:'POST', body: JSON.stringify(payload()) });
      if (r && r.success) { showResult(true,'Tersimpan', r.message||'Pengaturan disimpan.'); state.dirty=false; setSaveDirty(false); await loadConfig(); }
      else showResult(false,'Gagal', (r&&r.message)||'Tidak dapat menyimpan.');
    } catch(e){ showResult(false,'Gagal', e.message); }
    finally { btn.disabled=false; const ic=$('btnSaveIcon'); if(ic) ic.outerHTML='<svg id="btnSaveIcon" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'; }
  }

  async function sendNow() {
    const btn=$('btnSendNow'); btn.disabled=true; const orig=btn.innerHTML;
    btn.innerHTML='<span class="et-spin-sm"></span> Mengirim…';
    try {
      const r = await App.api('/telegram/report/send-now', { method:'POST', body: JSON.stringify({
        blocks: activeBlocks(), template: $('rp-template').value, chat_id: $('rp-chat').value.trim(),
        frequency: $('rp-frequency').value,
        compare:     $('rp-compare') ? $('rp-compare').checked : undefined,
        show_button: $('rp-show-button') ? $('rp-show-button').checked : undefined,
        notify_fail: $('rp-notify-fail') ? $('rp-notify-fail').checked : undefined,
      })});
      if (r && r.success) showResult(true,'Report Terkirim', r.message||'Ringkasan terkirim ke Telegram.');
      else showResult(false,'Gagal Mengirim', (r&&r.message)||'Cek konfigurasi Telegram.');
      refreshHistory();
    } catch(e){ showResult(false,'Gagal', e.message); }
    finally { btn.disabled=false; btn.innerHTML=orig; }
  }

  function onAnyChange(){ state.dirty=true; setSaveDirty(true); checkTelegramReady(); }
  function setSaveDirty(d){ const l=$('btnSaveLabel'); if(l) l.textContent=d?'Simpan Perubahan •':'Tersimpan'; }

  function showResult(ok,title,msg){
    const m=$('resultModal'), ic=$('rmIcon');
    ic.className='rm-icon '+(ok?'ok':'err');
    ic.innerHTML=ok?'<svg viewBox="0 0 52 52" fill="none"><path class="rm-draw" d="M14 27l8 8 16-16" stroke="#16a34a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      :'<svg viewBox="0 0 52 52" fill="none"><path class="rm-draw" d="M18 18l16 16M34 18L18 34" stroke="#dc2626" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    $('rmTitle').textContent=title; $('rmMsg').textContent=msg||''; m.style.display='flex';
  }
  function closeResult(){ $('resultModal').style.display='none'; }

  function mtab(which){
    document.querySelectorAll('.et-mtab').forEach(b=>b.classList.toggle('active', b.dataset.mtab===which));
    const g=$('etGrid'); g.classList.toggle('m-edit', which==='edit'); g.classList.toggle('m-prev', which==='prev');
  }

  window.addEventListener('beforeunload', e=>{ if(state.dirty){e.preventDefault();e.returnValue='';} });

  // ── HISTORY (tab Riwayat) ──────────────────────────────────────────
  function renderHistory(list) {
    const el = $('rp-history'); if (!el) return;
    if (!list || !list.length) { el.innerHTML = '<div class="rp-hist-empty">Belum ada riwayat pengiriman.</div>'; return; }
    el.innerHTML = list.map(h => {
      const d = new Date(h.created_at);
      const when = isNaN(d) ? '—' : (d.getDate()+'/'+(d.getMonth()+1)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));
      const stMap = { sent:['pill-green','Sukses'], partial:['pill-amber','Sebagian'], failed:['pill-red','Gagal'] };
      const st = stMap[h.status] || ['pill-grey', h.status||'—'];
      const src = h.source === 'schedule' ? 'Terjadwal' : 'Manual';
      const detail = h.status === 'failed'
        ? escHtml(h.error_message || 'Gagal mengirim')
        : `${h.ok_count}/${h.chat_count} chat · ${h.char_len||0} char`;
      return `<div class="rp-hist-row">
        <div class="rp-hist-main">
          <span class="rm-sc-pill ${st[0]}">${st[1]}</span>
          <span class="rp-hist-src">${src}${h.frequency?(' · '+escHtml(h.frequency)):''}</span>
        </div>
        <div class="rp-hist-detail">${detail}</div>
        <div class="rp-hist-when">${when}</div>
      </div>`;
    }).join('');
  }
  async function refreshHistory() {
    try {
      const r = await App.api('/telegram/report/history?limit=15');
      if (r && r.success) renderHistory(r.history || []);
    } catch (_) {}
  }

  window.RP = { insertPh, toggleBlock, refreshHistory };
  window.saveAll=saveAll; window.sendNow=sendNow; window.closeResult=closeResult; window.mtab=mtab;
  window.onAnyChange=onAnyChange; window.onFreqChange=onFreqChange; window.refreshStatus=refreshStatus;
  window.schedulePreview=schedulePreview; window.clearTemplate=clearTemplate;

  document.addEventListener('DOMContentLoaded', init);
})();
