// message-logs.js — redesigned (Email Analytics style)
// Endpoint tidak berubah:
//   GET /message-logs/stats      -> { data:{ outgoing:{total,sent,failed,today}, incoming:{total,unread,today} } }
//   GET /message-logs/chart?days -> { data:[ {date,sent,incoming,failed} ] }
//   GET /message-logs/breakdown  -> { data:[ {status,outbound,inbound,total} ] }
//   GET /message-logs/outgoing?  -> { data:[...], total }
//   GET /message-logs/incoming?  -> { data:[...], total }
//   GET /message-logs/outgoing/:id

let _tab = 'outgoing', _page = 1, _limit = 50, _total = 0;
let _chartDays = 7;
let _trendC = null, _statusC = null, _sparks = [];
let _STATS = null;

const TYPE_LABEL  = { text:'Teks', image:'Gambar', document:'Dokumen', audio:'Audio', template:'Template' };
const TYPE_CLASS  = { text:'tc-text', image:'tc-image', document:'tc-document', audio:'tc-audio', template:'tc-document' };
const STATUS_LABEL= { sent:'Terkirim', delivered:'Terkirim', read:'Dibaca', failed:'Gagal', pending:'Pending' };
const STATUS_CLASS= { sent:'st-sent', delivered:'st-sent', read:'st-sent', failed:'st-failed', pending:'st-pending' };

document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  loadStats();
  loadChart(_chartDays);
  loadBreakdown();
  renderTableHead();
  loadLogs();
});

function api(url, opt) {
  if (window.App && App.api) return App.api(url, opt);
  return fetch('/api' + url, Object.assign({ headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'}, credentials:'include' }, opt||{})).then(r=>r.json());
}

// ── Delivery cards ──────────────────────────────────────────────
const ARR_UP = '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 17L17 7M17 7H9M17 7v8"/></svg>';
const ARR_DN = '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 7l10 10M17 17H9M17 17V9"/></svg>';

function delivCard(opt) {
  const sel = opt.sel ? ' sel' : (opt.hl ? ' hl' : '');
  const cls = 'a-dc' + sel;
  const delta = opt.delta != null ? '<span class="a-dc-delta '+opt.deltaCls+'">'+(opt.deltaCls==='up'?ARR_UP:(opt.deltaCls==='down'?ARR_DN:''))+opt.delta+'</span>' : '';
  const click = opt.filter ? ' onclick="applyCardFilter(\''+opt.filter+'\',this)" data-filter="'+opt.filter+'"' : '';
  const flag = opt.filter ? '<span class="a-dc-flag">Filter aktif</span>' : '';
  return '<div class="'+cls+'"'+click+'>'
    + flag
    + '<div class="a-dc-top"><div class="a-dc-lbl">'+esc(opt.label)+'</div>'
      + '<svg class="a-dc-i" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="'+(opt.icon||'M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z')+'"/></svg></div>'
    + '<div class="a-dc-val"><div class="a-dc-num">'+esc(opt.value)+'</div>'+delta+'</div>'
    + '<div class="a-dc-sub">'+esc(opt.sub)+'</div>'
    + '<div class="a-dc-spark" id="'+opt.sparkId+'"></div>'
  + '</div>';
}

// Filter aktif yang berasal dari kartu (null = tidak ada / default semua keluar)
let _cardFilter = 'success';

// Klik kartu → highlight biru + filter tabel
window.applyCardFilter = function(key, el) {
  _cardFilter = key;
  // highlight kartu
  document.querySelectorAll('#deliv .a-dc').forEach(c => c.classList.remove('sel','hl'));
  if (el) el.classList.add('sel');

  // reset filter UI dulu
  ['filterSearch','filterStatus','filterType','filterDateFrom','filterDateTo'].forEach(id=>{ const e=document.getElementById(id); if(e)e.value=''; });
  _page = 1;

  if (key === 'incoming') {
    // pindah ke tab Pesan Masuk
    const btn = document.getElementById('tabIn');
    if (btn) switchTab('incoming', btn);
    return;
  }
  // sisanya = tab Pesan Keluar
  if (_tab !== 'outgoing') {
    const btn = document.getElementById('tabOut');
    if (btn) { switchTab('outgoing', btn); }
  } else {
    renderTableHead();
  }
  if (key === 'failed') {
    const sSel = document.getElementById('filterStatus'); if (sSel) sSel.value = 'failed';
  }
  // success & total = semua keluar (tanpa status)
  loadLogs();
};

async function loadStats() {
  const r = await api('/message-logs/stats');
  if (!r?.success) { document.getElementById('deliv').innerHTML = '<div class="a-dc" style="grid-column:1/-1;"><div class="a-empty">Gagal memuat statistik.</div></div>'; return; }
  _STATS = r.data;
  const out = r.data.outgoing, inc = r.data.incoming;
  const successRate = out.total > 0 ? Math.round(out.sent / out.total * 100) : 100;
  setText('tabOutCount', num(out.total));
  setText('tabInCount',  num(inc.total));

  const wrap = document.getElementById('deliv');
  wrap.innerHTML =
      delivCard({ label:'Tingkat Sukses', value:successRate+'%', delta:(successRate>=95?'Baik':null), deltaCls:'up', sub:num(out.sent)+' dari '+num(out.total)+' pesan', filter:'success', sel:(_cardFilter==='success'), sparkId:'sp0' })
    + delivCard({ label:'Total Keluar', value:num(out.total), delta:out.today+' hari ini', deltaCls:'up', sub:num(out.sent)+' sukses terkirim', filter:'total', sel:(_cardFilter==='total'), sparkId:'sp1', icon:'M5 12h14M12 5l7 7-7 7' })
    + delivCard({ label:'Gagal Kirim', value:num(out.failed), delta:out.failed>0?'perlu cek':null, deltaCls:'down', sub:(out.total>0?Math.round(out.failed/out.total*100):0)+'% dari total', filter:'failed', sel:(_cardFilter==='failed'), sparkId:'sp2', icon:'M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' })
    + delivCard({ label:'Pesan Masuk', value:num(inc.total), delta:inc.unread>0?(inc.unread+' baru'):null, deltaCls:'down', sub:inc.today+' hari ini', filter:'incoming', sel:(_cardFilter==='incoming'), sparkId:'sp3', icon:'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' });
  // sparkbars terisi setelah chart data tersedia (renderSparks dipanggil di loadChart)
  if (_lastChart) renderSparks(_lastChart);
}

let _lastChart = null;
function renderSparks(rows) {
  const sent = rows.map(r=>+(r.sent||0));
  const failed = rows.map(r=>+(r.failed||0));
  const incoming = rows.map(r=>+(r.incoming||0));
  const bars = [
    { id:'sp0', data:sent,     color:'#ffffff', opacity:.85 },
    { id:'sp1', data:sent,     color:'#2563eb' },
    { id:'sp2', data:failed,   color:'#ef4444' },
    { id:'sp3', data:incoming, color:'#0fb6a3' }
  ];
  _sparks.forEach(c=>{try{c.destroy();}catch(e){}}); _sparks=[];
  bars.forEach(b=>{
    const el = document.getElementById(b.id); if (!el) return;
    const c = new ApexCharts(el, {
      chart:{ type:'bar', height:42, sparkline:{enabled:true} },
      series:[{ data:b.data }], colors:[b.color],
      plotOptions:{ bar:{ borderRadius:2, columnWidth:'58%' } },
      fill:{ opacity:b.opacity||1 }, tooltip:{ enabled:false },
      states:{ hover:{ filter:{ type:'none' } } }
    });
    c.render(); _sparks.push(c);
  });
}

// ── Trend area chart ────────────────────────────────────────────
async function loadChart(days) {
  const r = await api('/message-logs/chart?days=' + days);
  if (!r?.success) return;
  const rows = r.data || [];
  _lastChart = rows;
  const labels = rows.map(x => { const dt = new Date(x.date); return dt.getDate() + '/' + (dt.getMonth()+1); });
  const sent = rows.map(x=>+(x.sent||0));
  const incoming = rows.map(x=>+(x.incoming||0));
  const failed = rows.map(x=>+(x.failed||0));

  const opts = {
    chart:{ type:'area', height:280, toolbar:{show:false}, fontFamily:'DM Sans,sans-serif', stacked:false },
    series:[
      { name:'Keluar', data:sent },
      { name:'Masuk',  data:incoming },
      { name:'Gagal',  data:failed }
    ],
    colors:['#2563eb','#0fb6a3','#ef4444'],
    stroke:{ curve:'smooth', width:[3,3,2] },
    fill:{ type:'gradient', gradient:{ shadeIntensity:1, opacityFrom:.28, opacityTo:.02, stops:[0,95] } },
    dataLabels:{ enabled:false },
    xaxis:{ categories:labels, labels:{ style:{ colors:'#aab2c4', fontSize:'11px', fontWeight:600 } }, axisBorder:{show:false}, axisTicks:{show:false} },
    yaxis:{ labels:{ style:{ colors:'#aab2c4', fontSize:'11px' } }, min:0, forceNiceScale:true },
    grid:{ borderColor:'#f1f4fa', strokeDashArray:5, padding:{ left:6, right:6 } },
    legend:{ show:false },
    markers:{ size:0, hover:{ size:5 } },
    tooltip:{ theme:'light', y:{ formatter:v=>v+' pesan' } }
  };
  if (_trendC) _trendC.destroy();
  _trendC = new ApexCharts(document.getElementById('trendChart'), opts);
  _trendC.render();
  renderSparks(rows);
}

window.setChartDays = function(days, btn) {
  _chartDays = days;
  document.querySelectorAll('#days7,#days14,#days30').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  loadChart(days);
};

// ── Status donut (from breakdown) ───────────────────────────────
async function loadBreakdown() {
  const r = await api('/message-logs/breakdown');
  if (!r?.success) return;
  const rows = r.data || [];
  // Kelompokkan status -> sukses / gagal / pending
  let sent=0, failed=0, pending=0;
  rows.forEach(x => {
    const s = x.status, t = +(x.total||0);
    if (s==='sent'||s==='delivered'||s==='read') sent += t;
    else if (s==='failed') failed += t;
    else pending += t;
  });
  const total = sent + failed + pending;
  document.querySelector('#statusCenter .big').textContent = total>=1000 ? (total/1000).toFixed(1).replace('.0','')+'K' : total;

  const series = [sent, failed, pending];
  const has = series.some(x=>x>0);
  const opts = {
    chart:{ type:'donut', height:250, fontFamily:'DM Sans,sans-serif' },
    series: has?series:[1,0,0],
    labels:['Terkirim','Gagal','Pending'], colors:['#2563eb','#ef4444','#f59e0b'],
    stroke:{ width:3, colors:['#fff'] },
    dataLabels:{ enabled:has, formatter:v=>Math.round(v)+'%', style:{ fontSize:'11px', fontWeight:'700' }, dropShadow:{enabled:false} },
    legend:{ show:false },
    plotOptions:{ pie:{ donut:{ size:'72%' } } },
    tooltip:{ enabled:has, y:{ formatter:v=>v+' pesan' } }
  };
  if (_statusC) _statusC.destroy();
  _statusC = new ApexCharts(document.getElementById('statusDonut'), opts);
  _statusC.render();
  document.getElementById('statusLegend').innerHTML =
      '<span><i style="background:#2563eb;"></i>Terkirim ('+num(sent)+')</span>'
    + '<span><i style="background:#ef4444;"></i>Gagal ('+num(failed)+')</span>'
    + '<span><i style="background:#f59e0b;"></i>Pending ('+num(pending)+')</span>';
}

// ── Tabs ────────────────────────────────────────────────────────
window.switchTab = function(tab, btn) {
  _tab = tab; _page = 1;
  document.querySelectorAll('.a-tabs button').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  const typeSel = document.getElementById('filterType');
  const statusSel = document.getElementById('filterStatus');
  if (typeSel)   typeSel.style.display   = tab==='outgoing' ? '' : 'none';
  if (statusSel) statusSel.style.display = tab==='outgoing' ? '' : 'none';
  // selaraskan highlight kartu dengan tab yang dipilih manual
  if (tab === 'incoming') _selectCard('incoming');
  else if (_cardFilter === 'incoming') _selectCard('success');
  renderTableHead();
  loadLogs();
};

// Sorot satu kartu sesuai key tanpa memicu reload (dipakai sinkronisasi tab)
function _selectCard(key) {
  _cardFilter = key;
  document.querySelectorAll('#deliv .a-dc').forEach(c => {
    c.classList.toggle('sel', c.dataset.filter === key);
    if (c.dataset.filter !== key) c.classList.remove('hl');
  });
}

function renderTableHead() {
  const thead = document.getElementById('logTableHead');
  if (!thead) return;
  thead.innerHTML = _tab==='outgoing'
    ? '<tr><th>#</th><th>Nomor Tujuan</th><th>Pesan</th><th>Tipe</th><th>Status</th><th>Session</th><th>Waktu</th></tr>'
    : '<tr><th>#</th><th>Dari</th><th>Nama</th><th>Pesan</th><th>Status</th><th>Waktu</th></tr>';
}

// ── Load logs ───────────────────────────────────────────────────
async function loadLogs() {
  const search = val('filterSearch'), status = val('filterStatus'), type = val('filterType');
  const dfrom = val('filterDateFrom'), dto = val('filterDateTo');
  const endpoint = _tab==='outgoing' ? '/message-logs/outgoing' : '/message-logs/incoming';
  const params = new URLSearchParams({ page:_page, limit:_limit, search });
  if (status) params.set('status', status);
  if (type)   params.set('type', type);
  if (dfrom)  params.set('date_from', dfrom);
  if (dto)    params.set('date_to', dto);

  const tbody = document.getElementById('logTableBody');
  if (!tbody) return;
  const colspan = _tab==='outgoing' ? 7 : 6;

  const d = await api(endpoint + '?' + params);
  if (!d?.success) { tbody.innerHTML = '<tr><td colspan="'+colspan+'"><div class="a-empty" style="color:#dc2626;">Gagal memuat data</div></td></tr>'; return; }

  _total = d.total || 0;
  if (!d.data?.length) {
    tbody.innerHTML = '<tr><td colspan="'+colspan+'"><div class="a-empty">'
      + '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>'
      + '<div>Tidak ada log ditemukan</div></div></td></tr>';
    renderPagination();
    return;
  }

  if (_tab==='outgoing') {
    tbody.innerHTML = d.data.map((r,i) => {
      const idx = (_page-1)*_limit + i + 1;
      const msg = (r.message||'').replace(/\n/g,' ').substring(0,90) + ((r.message||'').length>90?'…':'');
      const stCls = STATUS_CLASS[r.status]||'st-sent', stLbl = STATUS_LABEL[r.status]||r.status;
      const cust = r.customer_name ? '<div style="font-size:10px;color:#aab2c4;margin-top:1px;">'+esc(r.customer_name)+(r.cid?' · '+esc(r.cid):'')+'</div>' : '';
      return '<tr onclick="openDetail('+r.id+')">'
        + '<td style="color:#aab2c4;font-size:11px;">'+idx+'</td>'
        + '<td><span class="a-phone">'+esc(r.phone||'')+'</span>'+cust+'</td>'
        + '<td><div class="a-msg">'+esc(msg)+'</div></td>'
        + '<td><span class="a-tc '+(TYPE_CLASS[r.type]||'tc-text')+'">'+(TYPE_LABEL[r.type]||r.type||'Teks')+'</span></td>'
        + '<td><span class="a-st '+stCls+'">'+stLbl+'</span></td>'
        + '<td style="font-size:11px;color:#aab2c4;font-family:\'DM Mono\',monospace;">'+esc(r.session_id||'–')+'</td>'
        + '<td><span class="a-when">'+fmtDt(r.sent_at)+'</span></td>'
      + '</tr>';
    }).join('');
  } else {
    tbody.innerHTML = d.data.map((r,i) => {
      const idx = (_page-1)*_limit + i + 1;
      const msg = (r.message||'').replace(/\n/g,' ').substring(0,90) + ((r.message||'').length>90?'…':'');
      const phone = r.display_phone || r.from_number || '';
      const name  = r.display_name  || '–';
      const isLid = (r.from_number||'').length>13 && phone!==r.from_number;
      return '<tr onclick=\'openIncomingDetail('+JSON.stringify(r.message||'')+',"'+esc(phone)+'","'+esc(name)+'","'+esc(r.received_at||'')+'")\'>'
        + '<td style="color:#aab2c4;font-size:11px;">'+idx+'</td>'
        + '<td><span class="a-phone">'+esc(phone)+'</span>'+(isLid?'<div style="font-size:10px;color:#f59e0b;margin-top:1px;">ID: '+esc(r.from_number||'')+'</div>':'')+'</td>'
        + '<td><span style="font-size:12.5px;color:#374151;font-weight:'+(name!=='–'?'700':'400')+';">'+esc(name)+'</span>'+(r.cid?'<div style="font-size:10px;color:#aab2c4;">'+esc(r.cid)+'</div>':'')+'</td>'
        + '<td><div class="a-msg">'+esc(msg)+'</div></td>'
        + '<td><span class="a-st st-in">Masuk</span></td>'
        + '<td><span class="a-when">'+fmtDt(r.received_at)+'</span></td>'
      + '</tr>';
    }).join('');
  }
  renderPagination();
}

// ── Pagination ──────────────────────────────────────────────────
function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(_total/_limit));
  setText('pgInfo', 'Halaman '+_page+' dari '+totalPages+' ('+num(_total)+' total)');
  const pgBtns = document.getElementById('pgBtns'); if (!pgBtns) return;
  let btns = '<button class="a-pg-btn" onclick="goPage('+(_page-1)+')" '+(_page<=1?'disabled':'')+'>‹ Prev</button>';
  const start = Math.max(1,_page-2), end = Math.min(totalPages,_page+2);
  for (let p=start; p<=end; p++) btns += '<button class="a-pg-btn '+(p===_page?'on':'')+'" onclick="goPage('+p+')">'+p+'</button>';
  btns += '<button class="a-pg-btn" onclick="goPage('+(_page+1)+')" '+(_page>=totalPages?'disabled':'')+'>Next ›</button>';
  pgBtns.innerHTML = btns;
}
window.goPage = function(p) {
  const totalPages = Math.ceil(_total/_limit);
  if (p<1 || p>totalPages) return;
  _page = p; loadLogs();
  document.querySelector('.a-tcard')?.scrollIntoView({ behavior:'smooth', block:'nearest' });
};

// ── Filters ─────────────────────────────────────────────────────
const onFilterChange = debounce(() => { _page=1; loadLogs(); }, 400);
window.onFilterChange = onFilterChange;
window.resetFilters = function() {
  ['filterSearch','filterStatus','filterType','filterDateFrom','filterDateTo'].forEach(id=>{ const e=document.getElementById(id); if(e)e.value=''; });
  _page=1; loadLogs();
};

window.reloadAll = function() {
  loadStats(); loadChart(_chartDays); loadBreakdown(); loadLogs();
  toast('Data dimuat ulang');
};

// ── Detail modal ────────────────────────────────────────────────
window.openDetail = async function(id) {
  const d = await api('/message-logs/outgoing/' + id);
  if (!d?.success) return;
  const r = d.data;
  setText('modalMeta', r.phone + ' · ' + (TYPE_LABEL[r.type]||r.type) + ' · ' + fmtDt(r.sent_at));
  document.getElementById('modalMsg').textContent = r.message || '–';
  const apiEl = document.getElementById('modalApi'), apiWrap = document.getElementById('modalApiResp');
  if (r.api_response) {
    try { apiEl.textContent = JSON.stringify(JSON.parse(r.api_response), null, 2); } catch(e){ apiEl.textContent = r.api_response; }
    apiWrap.style.display = 'block';
  } else apiWrap.style.display = 'none';
  document.getElementById('msgModal').classList.add('show');
};
window.openIncomingDetail = function(msg, phone, name, dt) {
  setText('modalMeta', phone + ' (' + name + ') · ' + fmtDt(dt));
  document.getElementById('modalMsg').textContent = msg || '–';
  document.getElementById('modalApiResp').style.display = 'none';
  document.getElementById('msgModal').classList.add('show');
};
window.closeModal = function() { document.getElementById('msgModal').classList.remove('show'); };
document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

// ── Export CSV ──────────────────────────────────────────────────
window.exportLogs = async function() {
  const search = val('filterSearch'), status = val('filterStatus'), type = val('filterType');
  const dfrom = val('filterDateFrom'), dto = val('filterDateTo');
  const endpoint = _tab==='outgoing' ? '/message-logs/outgoing' : '/message-logs/incoming';
  const params = new URLSearchParams({ page:1, limit:5000, search });
  if (status) params.set('status', status);
  if (type)   params.set('type', type);
  if (dfrom)  params.set('date_from', dfrom);
  if (dto)    params.set('date_to', dto);
  const d = await api(endpoint + '?' + params);
  if (!d?.success || !d.data?.length) { toast('Tidak ada data untuk di-export', true); return; }
  const rows = d.data;
  let csv = _tab==='outgoing' ? 'ID,Phone,Tipe,Status,Durasi(ms),Waktu\n' : 'ID,Dari,Nama,Status,Waktu\n';
  rows.forEach(r => {
    if (_tab==='outgoing') csv += [r.id, r.phone, r.type, r.status, r.duration_ms||'', r.sent_at].join(',') + '\n';
    else csv += [r.id, r.display_phone||r.from_number||'', (r.display_name||'').replace(/,/g,' '), r.status==='pending'?'Baru':'Dibaca', r.received_at].join(',') + '\n';
  });
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'message_logs_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click(); URL.revokeObjectURL(url);
  toast(rows.length + ' log berhasil di-export');
};

// ── Utils ───────────────────────────────────────────────────────
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setText(id,v){ const e=document.getElementById(id); if(e)e.textContent=v; }
function val(id){ const e=document.getElementById(id); return e?e.value:''; }
function num(n){ return Number(n||0).toLocaleString('id-ID'); }
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
function fmtDt(d){ return d ? new Date(d).toLocaleString('id-ID',{ day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : '–'; }
function toast(msg,isErr){ const t=document.getElementById('toast'); if(!t)return; t.textContent=msg; t.className='a-toast show'+(isErr?' err':''); setTimeout(()=>t.className='a-toast'+(isErr?' err':''),3000); }
