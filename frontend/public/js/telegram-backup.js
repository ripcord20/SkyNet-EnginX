/* telegram-backup.js — halaman /telegram/backup */
(function () {
  'use strict';

  let state = { config:{}, routers:[], selected:new Set(), dirty:false, telegram:{} };

  function $(id){return document.getElementById(id);}
  function nowClock(){const d=new Date();return String(d.getHours()).padStart(2,'0')+'.'+String(d.getMinutes()).padStart(2,'0');}
  function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  const PHS = ['{router}','{ip}','{file}','{ukuran}','{tanggal}','{perusahaan}'];

  async function init() {
    fillDom();
    $('bk-phs').innerHTML = PHS.map(p=>`<span class="tg-ph" onclick="BK.insertPh('${p}')">${p}</span>`).join('');
    await loadConfig();
  }
  function fillDom(){ let h=''; for(let i=1;i<=28;i++) h+=`<option value="${i}">Tanggal ${i}</option>`; $('bk-dom').innerHTML=h; }

  async function loadConfig() {
    try {
      const r = await App.api('/telegram/backup/config');
      if (!r || !r.success) throw new Error(r && r.message || 'Gagal memuat');
      state.config = r.config || {};
      state.routers = r.routers || [];
      state.telegram = r.telegram || {};

      const c = state.config;
      $('bk-enabled').checked = String(c.tgbackup_enabled)==='1';
      $('bk-frequency').value = c.tgbackup_frequency || 'daily';
      const hh=String(c.tgbackup_hour!=null&&c.tgbackup_hour!==''?c.tgbackup_hour:3).padStart(2,'0');
      const mm=String(c.tgbackup_minute!=null&&c.tgbackup_minute!==''?c.tgbackup_minute:0).padStart(2,'0');
      $('bk-time').value = hh+':'+mm;
      $('bk-dow').value = c.tgbackup_day_of_week!=null&&c.tgbackup_day_of_week!==''?c.tgbackup_day_of_week:'1';
      $('bk-dom').value = c.tgbackup_day_of_month!=null&&c.tgbackup_day_of_month!==''?c.tgbackup_day_of_month:'1';
      $('bk-binary').checked = String(c.tgbackup_include_binary)==='1';
      $('bk-chat').value = c.tgbackup_chat_id || '';
      $('bk-caption').value = c.tgbackup_caption || '';

      // Selected devices
      state.selected = new Set();
      if (c.tgbackup_devices) String(c.tgbackup_devices).split(',').map(s=>parseInt(s.trim(),10)).filter(Boolean).forEach(id=>state.selected.add(id));

      renderRouters();
      syncCheck($('bk-binary'));
      onFreqChange(); refreshStatus(); applyLast(r.last); checkTelegramReady(); renderPreview();
      state.dirty=false; setSaveDirty(false);
    } catch(e){ App.toast && App.toast('Gagal memuat: '+e.message,'error'); }
  }

  function renderRouters() {
    const wrap = $('bk-routers');
    if (!state.routers.length) {
      wrap.innerHTML = '<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">Belum ada router aktif. Tambahkan device bertipe router dulu.</div>';
      updateRouterStat(); return;
    }
    wrap.innerHTML = state.routers.map(rt => {
      const on = state.selected.has(rt.id);
      return `
        <label class="tg-check ${on?'on':''}" data-id="${rt.id}">
          <span class="tg-check-ic" style="background:rgba(34,158,217,.13)"><svg width="17" height="17" fill="none" stroke="#229ED9" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01"/></svg></span>
          <span class="tg-check-tx"><div class="tg-check-t">${escHtml(rt.name)}</div><div class="tg-check-d">${escHtml(rt.ip||'')}</div></span>
          <label class="et-switch"><input type="checkbox" ${on?'checked':''} onchange="BK.toggleRouter(${rt.id},this)"><span class="et-track"></span></label>
        </label>`;
    }).join('');
    updateRouterStat();
  }
  function toggleRouter(id, cb) {
    if (cb.checked) state.selected.add(id); else state.selected.delete(id);
    cb.closest('.tg-check').classList.toggle('on', cb.checked);
    updateRouterStat(); onAnyChange();
  }
  function selectAllRouters(all) {
    state.selected = new Set(all ? state.routers.map(r=>r.id) : []);
    renderRouters(); onAnyChange();
  }
  function updateRouterStat() {
    const n = state.selected.size;
    $('bk-router-cnt').textContent = n;
    $('scRouters').textContent = n || state.routers.length;
    $('scRoutersPill').textContent = n ? (n+' dipilih') : (state.routers.length+' (semua)');
  }

  function insertPh(ph){
    const ta=$('bk-caption'); const s=ta.selectionStart||0,e=ta.selectionEnd||0;
    ta.value=ta.value.slice(0,s)+ph+ta.value.slice(e);
    ta.focus(); ta.selectionStart=ta.selectionEnd=s+ph.length;
    onAnyChange(); renderPreview();
  }

  function onFreqChange(){
    const f=$('bk-frequency').value;
    $('bk-dow-wrap').style.display = f==='weekly'?'':'none';
    $('bk-dom-wrap').style.display = f==='monthly'?'':'none';
    $('scFreq').textContent = f==='daily'?'Harian':f==='weekly'?'Mingguan':'Bulanan';
  }
  function refreshStatus(){
    const on=$('bk-enabled').checked;
    $('scStatus').textContent = on?'Aktif':'Nonaktif';
    $('scStatusDot').style.background = on?'#22c55e':'#cbd5e1';
    $('scStatusSub').textContent = on?'berjalan otomatis':'jadwal mati';
    $('scFreqPill').textContent = $('bk-time').value || '03:00';
  }
  function applyLast(last){
    if(!last||!last.at){$('scLast').textContent='—';$('scLastPill').textContent='belum ada';$('scLastPill').className='rm-sc-pill pill-grey';return;}
    const d=new Date(last.at);
    $('scLast').textContent = isNaN(d)?'—':(d.getDate()+'/'+(d.getMonth()+1)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));
    const ok=last.status==='ok';
    $('scLastPill').textContent = ok?'sukses':(last.status||'—');
    $('scLastPill').className='rm-sc-pill '+(ok?'pill-green':'pill-red');
  }
  function checkTelegramReady(){
    const t=state.telegram||{};
    const ready=t.has_token && (t.global_chat || $('bk-chat').value.trim());
    const w=$('tgWarn');
    if(ready){w.style.display='none';return;}
    w.style.display='flex';
    $('tgWarnText').textContent = !t.has_token
      ? 'Bot Telegram belum dikonfigurasi. Atur Bot Token & Chat ID dulu.'
      : 'Chat ID tujuan belum ada. Isi di bawah atau set Chat ID utama.';
  }
  function syncCheck(cb){ const c=cb.closest('.tg-check'); if(c) c.classList.toggle('on',cb.checked); }

  // ── PREVIEW (caption render dgn data contoh) ───────────────────────
  function renderPreview() {
    const company = window.__COMPANY || 'ISP';
    const sample = { router:'Router-Utama', ip:'10.10.0.1', file:'Router-Utama_2026-06-16_030000.rsc', ukuran:'42.5 KB', tanggal:'16 Juni 2026 03:00', perusahaan:company };
    $('docName').textContent = sample.file;
    $('docSize').textContent = sample.ukuran + ' · RSC';
    let tpl = $('bk-caption').value.trim();
    if (!tpl) tpl = '💾 <b>Backup {router}</b>\nIP: <code>{ip}</code>\nFile: {file} ({ukuran})\n{tanggal}';
    let msg = tpl;
    Object.keys(sample).forEach(k=>{ msg = msg.split('{'+k+'}').join(sample[k]); });
    $('tgText').innerHTML = renderTgHtml(msg);
    $('tgTime').textContent = nowClock();
  }
  function renderTgHtml(s){
    let out=escHtml(s);
    return out.replace(/&lt;b&gt;/g,'<b>').replace(/&lt;\/b&gt;/g,'</b>')
      .replace(/&lt;i&gt;/g,'<i>').replace(/&lt;\/i&gt;/g,'</i>')
      .replace(/&lt;code&gt;/g,'<code>').replace(/&lt;\/code&gt;/g,'</code>');
  }

  // ── SAVE / RUN ─────────────────────────────────────────────────────
  function payload() {
    const [hh,mm]=($('bk-time').value||'03:00').split(':');
    return {
      tgbackup_enabled:       $('bk-enabled').checked?'1':'0',
      tgbackup_frequency:     $('bk-frequency').value,
      tgbackup_hour:          String(parseInt(hh,10)||0),
      tgbackup_minute:        String(parseInt(mm,10)||0),
      tgbackup_day_of_week:   $('bk-dow').value,
      tgbackup_day_of_month:  $('bk-dom').value,
      tgbackup_devices:       Array.from(state.selected).join(','),
      tgbackup_include_binary:$('bk-binary').checked?'1':'0',
      tgbackup_chat_id:       $('bk-chat').value.trim(),
      tgbackup_caption:       $('bk-caption').value,
    };
  }

  async function saveAll() {
    const btn=$('btnSave'),icon=$('btnSaveIcon'); btn.disabled=true;
    icon.outerHTML='<span class="et-spin-sm" id="btnSaveIcon"></span>';
    try {
      const r=await App.api('/telegram/backup/save',{method:'POST',body:JSON.stringify(payload())});
      if(r&&r.success){showResult(true,'Tersimpan',r.message||'Pengaturan disimpan.');state.dirty=false;setSaveDirty(false);await loadConfig();}
      else showResult(false,'Gagal',(r&&r.message)||'Tidak dapat menyimpan.');
    } catch(e){showResult(false,'Gagal',e.message);}
    finally{btn.disabled=false;const ic=$('btnSaveIcon');if(ic)ic.outerHTML='<svg id="btnSaveIcon" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';}
  }

  async function runNow() {
    const btn=$('btnRunNow'); btn.disabled=true; const orig=btn.innerHTML;
    btn.innerHTML='<span class="et-spin-sm"></span> Mem-backup…';
    try {
      const r=await App.api('/telegram/backup/run-now',{method:'POST',body:JSON.stringify({
        device_ids: Array.from(state.selected),
        include_binary: $('bk-binary').checked,
        chat_id: $('bk-chat').value.trim(),
        caption: $('bk-caption').value,
      })});
      if(r&&r.success){
        let detail='';
        (r.results||[]).forEach(rt=>{
          const okF=(rt.files||[]).filter(f=>f.sent).length, tot=(rt.files||[]).length;
          detail += `\n• ${rt.device_name}: ${rt.ok?okF+'/'+tot+' file':'gagal'}${rt.error?' ('+rt.error+')':''}`;
        });
        showResult(true,'Backup Terkirim',(r.message||'')+detail);
      } else showResult(false,'Backup Gagal',(r&&r.message)||'Cek koneksi router & Telegram.');
    } catch(e){showResult(false,'Gagal',e.message);}
    finally{btn.disabled=false;btn.innerHTML=orig;}
  }

  function onAnyChange(){state.dirty=true;setSaveDirty(true);checkTelegramReady();}
  function setSaveDirty(d){const l=$('btnSaveLabel');if(l)l.textContent=d?'Simpan Perubahan •':'Tersimpan';}

  function showResult(ok,title,msg){
    const m=$('resultModal'),ic=$('rmIcon');
    ic.className='rm-icon '+(ok?'ok':'err');
    ic.innerHTML=ok?'<svg viewBox="0 0 52 52" fill="none"><path class="rm-draw" d="M14 27l8 8 16-16" stroke="#16a34a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      :'<svg viewBox="0 0 52 52" fill="none"><path class="rm-draw" d="M18 18l16 16M34 18L18 34" stroke="#dc2626" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    $('rmTitle').textContent=title;$('rmMsg').textContent=msg||'';m.style.display='flex';
  }
  function closeResult(){$('resultModal').style.display='none';}
  function mtab(which){
    document.querySelectorAll('.et-mtab').forEach(b=>b.classList.toggle('active',b.dataset.mtab===which));
    const g=$('etGrid');g.classList.toggle('m-edit',which==='edit');g.classList.toggle('m-prev',which==='prev');
  }

  window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});

  window.BK={insertPh,toggleRouter};
  window.saveAll=saveAll;window.runNow=runNow;window.closeResult=closeResult;window.mtab=mtab;
  window.onAnyChange=onAnyChange;window.onFreqChange=onFreqChange;window.refreshStatus=refreshStatus;
  window.renderPreview=renderPreview;window.selectAllRouters=selectAllRouters;window.syncCheck=syncCheck;
  window.$=window.$||$;

  document.addEventListener('DOMContentLoaded', init);
})();
