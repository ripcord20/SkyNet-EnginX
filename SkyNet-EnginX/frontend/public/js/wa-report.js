// wa-report.js — Automation Report (redesigned, clean a-* UI)
// Endpoint backend tidak berubah:
//   GET  /wa/report/settings   ·  POST /wa/report/settings  { phones | schedules,sections,range }
//   GET  /wa/report/preview?range=&sections=
//   POST /wa/report/send-now   { range, sections, phones }
//   GET  /wa/report/template   ·  POST /wa/report/template  { template }

let _period   = 'this_month';
let _sections = { summary: true, rate: true, method: false, top: false, due: false };
let _phones   = [];
let _schedules= {};
let _sparks   = {};

const PERIOD_LABELS = { this_month:'Bulan Ini', last_month:'Bulan Lalu', this_week:'Minggu Ini', last_week:'Minggu Lalu' };
const FREQ_LABELS   = { daily:'Harian', weekly:'Mingguan', monthly:'Bulanan' };

// ── Modal konfirmasi kustom (ganti confirm() bawaan browser) ─────────
// Mengembalikan Promise<boolean>. Gaya bersih, palet biru/teal FLAYNET.
function waConfirm(opts) {
  opts = opts || {};
  const title   = opts.title   || 'Konfirmasi';
  const message = opts.message || 'Lanjutkan aksi ini?';
  const okText  = opts.okText  || 'Ya, Lanjutkan';
  const cancel  = opts.cancelText || 'Batal';
  const tone    = opts.tone || 'primary';   // primary | danger
  return new Promise((resolve) => {
    const prev = document.getElementById('_waConfirm');
    if (prev) prev.remove();
    const accent = tone === 'danger' ? '#dc2626' : '#2563eb';
    const accentBg = tone === 'danger' ? '#fef2f2' : '#eff6ff';
    const icon = tone === 'danger'
      ? '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>'
      : '<path stroke-linecap="round" stroke-linejoin="round" d="M8 12l3 3 5-6"/><circle cx="12" cy="12" r="9"/>';
    const wrap = document.createElement('div');
    wrap.id = '_waConfirm';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);backdrop-filter:blur(2px);animation:waCfFade .16s ease;padding:20px;';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:400px;width:100%;box-shadow:0 20px 50px -12px rgba(15,23,42,.35);overflow:hidden;animation:waCfPop .2s cubic-bezier(.16,1,.3,1);">'
      + '<div style="padding:26px 26px 20px;text-align:center;">'
      +   '<div style="width:56px;height:56px;border-radius:16px;background:' + accentBg + ';color:' + accent + ';display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">'
      +     '<svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">' + icon + '</svg>'
      +   '</div>'
      +   '<div style="font-size:17px;font-weight:800;color:#0f172a;margin-bottom:7px;letter-spacing:-.2px;">' + title + '</div>'
      +   '<div style="font-size:13.5px;color:#64748b;line-height:1.55;">' + message + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:10px;padding:0 22px 22px;">'
      +   '<button id="_waCfNo" style="flex:1;padding:12px;border-radius:11px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-size:13.5px;font-weight:700;cursor:pointer;transition:.15s;">' + cancel + '</button>'
      +   '<button id="_waCfYes" style="flex:1;padding:12px;border-radius:11px;border:none;background:' + accent + ';color:#fff;font-size:13.5px;font-weight:700;cursor:pointer;transition:.15s;">' + okText + '</button>'
      + '</div>'
      + '</div>';
    if (!document.getElementById('_waCfStyle')) {
      const st = document.createElement('style');
      st.id = '_waCfStyle';
      st.textContent = '@keyframes waCfFade{from{opacity:0}to{opacity:1}}@keyframes waCfPop{from{opacity:0;transform:scale(.94) translateY(8px)}to{opacity:1;transform:none}}#_waCfNo:hover{background:#f8fafc;border-color:#cbd5e1}#_waCfYes:hover{filter:brightness(.95)}';
      document.head.appendChild(st);
    }
    document.body.appendChild(wrap);
    const done = (val) => { wrap.style.animation = 'waCfFade .14s ease reverse'; setTimeout(() => wrap.remove(), 130); resolve(val); };
    wrap.querySelector('#_waCfYes').onclick = () => done(true);
    wrap.querySelector('#_waCfNo').onclick  = () => done(false);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    document.addEventListener('keydown', function esc(ev){ if(ev.key==='Escape'){ done(false); document.removeEventListener('keydown', esc); } });
  });
}

// ── Modal hasil (satu tombol) — hijau bila sukses, merah bila gagal ──
// Gaya senada waConfirm. tone: 'success' | 'danger'.
function waAlert(opts) {
  opts = opts || {};
  const tone    = opts.tone || 'success';           // success | danger
  const title   = opts.title   || (tone === 'success' ? 'Berhasil' : 'Gagal');
  const message = opts.message || '';
  const okText  = opts.okText  || 'Mengerti';
  return new Promise((resolve) => {
    const prev = document.getElementById('_waAlert');
    if (prev) prev.remove();
    const accent   = tone === 'success' ? '#16a34a' : '#dc2626';
    const accentBg = tone === 'success' ? '#dcfce7' : '#fee2e2';
    const iconColor = tone === 'success' ? '#15803d' : '#dc2626';
    const icon = tone === 'success'
      ? '<path stroke-linecap="round" stroke-linejoin="round" d="M20 6L9 17l-5-5"/>'
      : '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>';
    const wrap = document.createElement('div');
    wrap.id = '_waAlert';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);backdrop-filter:blur(2px);animation:waCfFade .16s ease;padding:20px;';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:400px;width:100%;box-shadow:0 20px 50px -12px rgba(15,23,42,.35);overflow:hidden;animation:waCfPop .2s cubic-bezier(.16,1,.3,1);">'
      + '<div style="padding:28px 26px 22px;text-align:center;">'
      +   '<div style="width:60px;height:60px;border-radius:17px;background:' + accentBg + ';color:' + iconColor + ';display:flex;align-items:center;justify-content:center;margin:0 auto 17px;">'
      +     '<svg width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24">' + icon + '</svg>'
      +   '</div>'
      +   '<div style="font-size:17px;font-weight:800;color:#0f172a;margin-bottom:7px;letter-spacing:-.2px;">' + title + '</div>'
      +   '<div style="font-size:13.5px;color:#64748b;line-height:1.55;">' + message + '</div>'
      + '</div>'
      + '<div style="padding:0 22px 22px;">'
      +   '<button id="_waAlOk" style="width:100%;padding:12px;border-radius:11px;border:none;background:' + accent + ';color:#fff;font-size:13.5px;font-weight:700;cursor:pointer;transition:.15s;">' + okText + '</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(wrap);
    const done = () => { wrap.style.animation = 'waCfFade .14s ease reverse'; setTimeout(() => wrap.remove(), 130); resolve(true); };
    wrap.querySelector('#_waAlOk').onclick = done;
    wrap.onclick = (e) => { if (e.target === wrap) done(); };
    document.addEventListener('keydown', function esc(ev){ if(ev.key==='Escape'){ done(); document.removeEventListener('keydown', esc); } });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  loadSettings().then(() => previewReport());
});

// ── Load settings ───────────────────────────────────────────────
async function loadSettings() {
  loadReportTemplate();
  const d = await App.api('/wa/report/settings');
  if (!d?.success) return;
  const cfg = d.data || {};

  _phones = safeJSON(cfg.admin_notify_phones, []);
  renderPhonePills();
  const ta = document.getElementById('phoneInput');
  if (ta) ta.value = _phones.join('\n');

  const savedSec = safeJSON(cfg.report_sections, {});
  if (Object.keys(savedSec).length) _sections = savedSec;
  Object.keys(_sections).forEach(k => {
    const tile = document.getElementById('sec-' + k);
    if (!tile) return;
    const on = _sections[k] !== false;
    tile.classList.toggle('on', on);
    const chk = tile.querySelector('input'); if (chk) chk.checked = on;
  });

  _period = cfg.report_range || 'this_month';
  document.querySelectorAll('#periodChips button').forEach(b => b.classList.toggle('on', b.dataset.period === _period));

  _schedules = safeJSON(cfg.report_schedules, {});
  renderSchedules();

  if (cfg.report_last_sent) {
    _setText('lastSentInfo', 'Terakhir dikirim: ' + new Date(cfg.report_last_sent).toLocaleString('id-ID'));
  }
}

// ── Phones ──────────────────────────────────────────────────────
function renderPhonePills() {
  const el = document.getElementById('phonePills');
  if (!el) return;
  el.innerHTML = _phones.length
    ? _phones.map(p => '<span class="ph-pill">'+_esc(p)+'</span>').join('')
    : '<span style="font-size:12px;color:#aab2c4;">Belum ada nomor admin</span>';
}

window.savePhones = async function() {
  const raw = document.getElementById('phoneInput')?.value || '';
  const lines = raw.split(/[\n,]+/).map(p => {
    p = p.replace(/[^0-9]/g, '');
    if (!p) return null;
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (!p.startsWith('62')) p = '62' + p;
    return p.length >= 10 ? p : null;
  }).filter(Boolean);
  _phones = [...new Set(lines)];
  const d = await App.api('/wa/report/settings', { method:'POST', body: JSON.stringify({ phones: _phones }) });
  if (d?.success) {
    renderPhonePills();
    waAlert({ tone:'success', title:'Nomor Disimpan', message: '<b>' + _phones.length + ' nomor</b> admin penerima laporan berhasil disimpan.', okText:'Selesai' });
  } else {
    waAlert({ tone:'danger', title:'Gagal Menyimpan', message: d?.message || 'Nomor gagal disimpan. Coba lagi.', okText:'Mengerti' });
  }
};

// ── Schedule cards ──────────────────────────────────────────────
function renderSchedules() {
  const el = document.getElementById('schedGrid');
  if (!el) return;
  const periods = ['this_month','last_month','this_week','last_week'];
  const DOW = [['1','Senin'],['2','Selasa'],['3','Rabu'],['4','Kamis'],['5','Jumat'],['6','Sabtu'],['7','Minggu']];
  el.innerHTML = periods.map(pk => {
    const s = _schedules[pk] || { enabled:false, freq:'daily', time:'08:00', day:1 };
    const on = !!s.enabled;
    const freq = s.freq || 'daily';
    const dayNum = parseInt(s.day || 1) || 1;
    // Field hari: hanya relevan utk weekly (pilih hari) & monthly (tanggal).
    let dayField = '';
    if (freq === 'weekly') {
      dayField = '<div><span class="sch-mini-lbl">Hari</span>'
        + '<select class="sch-mini" id="sday-'+pk+'" onchange="updateSchedDisplay(\''+pk+'\')">'
        + DOW.map(d=>'<option value="'+d[0]+'"'+(String(dayNum)===d[0]?' selected':'')+'>'+d[1]+'</option>').join('')
        + '</select></div>';
    } else if (freq === 'monthly') {
      const dm = Math.min(Math.max(dayNum,1),28);
      dayField = '<div><span class="sch-mini-lbl">Tanggal</span>'
        + '<input type="number" min="1" max="28" class="sch-mini" id="sday-'+pk+'" value="'+dm+'" onchange="updateSchedDisplay(\''+pk+'\')"></div>';
    }
    // Ringkasan status di header.
    let sub = 'Nonaktif';
    if (on) {
      if (freq === 'weekly') { const nm=(DOW.find(d=>d[0]===String(dayNum))||['','Senin'])[1]; sub='Otomatis: Mingguan · '+nm+' · '+s.time; }
      else if (freq === 'monthly') sub='Otomatis: Bulanan · tgl '+Math.min(Math.max(dayNum,1),28)+' · '+s.time;
      else sub='Otomatis: Harian · '+s.time;
    }
    return '<div class="sch-card '+(on?'on':'')+'" id="scard-'+pk+'">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;">'
        + '<div>'
          + '<div style="font-size:13px;font-weight:700;color:#16203a;">'+PERIOD_LABELS[pk]+'</div>'
          + '<div style="font-size:11px;color:#aab2c4;margin-top:1px;">'+sub+'</div>'
        + '</div>'
        + '<div class="a-tog '+(on?'on':'')+'" onclick="toggleSched(\''+pk+'\')"><div class="thumb"></div></div>'
      + '</div>'
      + (on ? '<div class="sch-grid2">'
          + '<div><span class="sch-mini-lbl">Frekuensi</span>'
            + '<select class="sch-mini" id="sfreq-'+pk+'" onchange="updateSchedDisplay(\''+pk+'\')">'
              + ['daily','weekly','monthly'].map(f=>'<option value="'+f+'"'+(freq===f?' selected':'')+'>'+FREQ_LABELS[f]+'</option>').join('')
            + '</select></div>'
          + dayField
          + '<div><span class="sch-mini-lbl">Jam Kirim</span>'
            + '<input type="time" class="sch-mini" id="stime-'+pk+'" value="'+(s.time||'08:00')+'"></div>'
        + '</div>' : '')
    + '</div>';
  }).join('');
}

window.toggleSched = function(pk) {
  if (!_schedules[pk]) _schedules[pk] = { enabled:false, freq:'daily', time:'08:00', day:1 };
  _schedules[pk].enabled = !_schedules[pk].enabled;
  renderSchedules();
};
window.updateSchedDisplay = function(pk) {
  const freq = document.getElementById('sfreq-'+pk)?.value;
  const time = document.getElementById('stime-'+pk)?.value;
  const day  = document.getElementById('sday-'+pk)?.value;
  if (!_schedules[pk]) _schedules[pk] = {};
  if (freq) _schedules[pk].freq = freq;
  if (time) _schedules[pk].time = time;
  if (day !== undefined && day !== '' && day != null) _schedules[pk].day = parseInt(day) || 1;
  // Frekuensi berubah → render ulang agar field Hari/Tanggal ikut menyesuaikan.
  renderSchedules();
};
window.saveSchedules = async function() {
  ['this_month','last_month','this_week','last_week'].forEach(pk => {
    if (!_schedules[pk]) return;
    const freq = document.getElementById('sfreq-'+pk)?.value;
    const time = document.getElementById('stime-'+pk)?.value;
    const day  = document.getElementById('sday-'+pk)?.value;
    if (freq) _schedules[pk].freq = freq;
    if (time) _schedules[pk].time = time;
    if (day !== undefined && day !== '' && day != null) _schedules[pk].day = parseInt(day) || 1;
  });
  const d = await App.api('/wa/report/settings', { method:'POST', body: JSON.stringify({ schedules:_schedules, sections:_sections, range:_period }) });
  if (d?.success) {
    waAlert({ tone:'success', title:'Jadwal Disimpan', message:'Jadwal pengiriman laporan otomatis berhasil disimpan.', okText:'Selesai' });
  } else {
    waAlert({ tone:'danger', title:'Gagal Menyimpan', message: d?.message || 'Jadwal gagal disimpan. Coba lagi.', okText:'Mengerti' });
  }
};

// ── Period & sections ───────────────────────────────────────────
window.setPeriod = function(period, btn) {
  _period = period;
  document.querySelectorAll('#periodChips button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  previewReport();
};

window.toggleSecTile = function(key, tile, ev) {
  // Label berisi <input checkbox>, jadi klik label otomatis men-toggle checkbox
  // bawaan DAN memanggil onclick ini → dua-duanya jalan & saling bertabrakan
  // sehingga status tidak berubah. Cegah perilaku bawaan; biarkan fungsi ini
  // yang menjadi satu-satunya sumber kebenaran status.
  if (ev) ev.preventDefault();
  const chk = tile.querySelector('input');
  const next = !(_sections[key] !== false);
  _sections[key] = next;
  if (chk) chk.checked = next;
  tile.classList.toggle('on', next);
  previewReport();
};

// ── Preview ─────────────────────────────────────────────────────
window.previewReport = async function() {
  const btn = document.getElementById('btnPreview');
  if (btn) { btn.disabled = true; }
  const params = new URLSearchParams({ range:_period, sections: JSON.stringify(_sections) });
  const d = await App.api('/wa/report/preview?' + params);
  if (d?.success) {
    const data = d.data || {};
    const aktif = data.aktif || {};
    const bayar = data.bayar || {};
    const rate = +(data.rate || 0);

    _setText('scTotal',   'Rp ' + _fmtNum(aktif.total_harga || 0));
    _setText('scTotalSub', (aktif.cnt || 0) + ' pelanggan aktif');
    _setText('scBayar',   'Rp ' + _fmtNum(bayar.total || 0));
    _setText('scBayarSub', (bayar.cnt || 0) + ' pembayaran · ' + (d.label || ''));
    _setText('scBelum',   'Rp ' + _fmtNum(data.unpaidTotal || 0));
    _setText('scBelumSub', (data.unpaidCnt || 0) + ' invoice belum bayar');
    _setText('scRate',    rate + '%');

    const dl = document.getElementById('scRateDelta');
    if (dl) {
      dl.textContent = rate >= 80 ? 'sehat' : rate >= 50 ? 'sedang' : 'rendah';
      dl.className = 'rm-sc-pill ' + (rate >= 80 ? 'pill-green' : rate >= 50 ? 'pill-amber' : 'pill-red');
    }

    // sparkline halus & kalem (clean), proporsional terhadap nilai
    drawSparkSvg('sp-total-line', 'sp-total-dot', sampleFrom(aktif.total_harga||0));
    drawSparkSvg('sp-bayar-line', 'sp-bayar-dot', sampleFrom(bayar.total||0));
    drawSparkSvg('sp-belum-line', 'sp-belum-dot', sampleFrom(data.unpaidTotal||0));
    drawSparkSvg('sp-rate-line',  'sp-rate-dot',  ratioBars(rate));

    // WA preview (render bold/italic)
    const txt = document.getElementById('waPreviewText');
    if (txt) txt.innerHTML = _waFormat(d.message || '');
    _setText('waPreviewTime', new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' }));
    _setText('previewLabel', d.label || '');
    _setText('waContactStatus', 'Auto Report · ' + (d.label || ''));
    _setText('rpHeaderSub', 'Laporan ' + (d.label||'') + ' · ' + (bayar.cnt || 0) + ' transaksi');
  }
  if (btn) btn.disabled = false;
};

// ── Send now ────────────────────────────────────────────────────
window.sendReportNow = async function() {
  if (!_phones.length) { toast('Tambahkan nomor admin penerima dahulu', true); return; }
  const ok = await waConfirm({
    title: 'Kirim Laporan Sekarang?',
    message: 'Laporan <b>' + PERIOD_LABELS[_period] + '</b> akan dikirim ke <b>' + _phones.length + ' nomor</b> admin via WhatsApp.',
    okText: 'Kirim Sekarang',
    tone: 'primary'
  });
  if (!ok) return;
  const btn = document.getElementById('btnSendNow');
  btn.disabled = true; const _t = btn.innerHTML;
  btn.innerHTML = 'Mengirim…';
  const d = await App.api('/wa/report/send-now', { method:'POST', body: JSON.stringify({ range:_period, sections:_sections, phones:_phones }) });
  btn.disabled = false; btn.innerHTML = _t;
  if (d?.success) {
    _setText('lastSentInfo', '✅ ' + d.message + ' · ' + new Date().toLocaleString('id-ID'));
    waAlert({
      tone: 'success',
      title: 'Laporan Terkirim',
      message: (d.message || 'Laporan berhasil dikirim') + ' ke <b>' + _phones.length + ' nomor</b> admin.',
      okText: 'Selesai'
    });
  } else {
    waAlert({
      tone: 'danger',
      title: 'Gagal Mengirim',
      message: d?.message || 'Laporan gagal dikirim. Periksa koneksi sesi WhatsApp lalu coba lagi.',
      okText: 'Mengerti'
    });
  }
};

// ── Template editor ─────────────────────────────────────────────
const DEFAULT_REPORT_TEMPLATE = `📊 *{label}*
*{app_name}*
Periode : *{period}*
{sep}

📋 *RINGKASAN TAGIHAN*
Total Pelanggan Aktif : *{aktif_cnt} pelanggan*
Total Tagihan Periode : *{aktif_total}*

💵 *Pembayaran Diterima*
Transaksi  : *{bayar_cnt} pembayaran*
Diterima   : *{bayar_total}*

❌ *Belum Dibayar*
Invoice    : *{unpaid_cnt} invoice*
Estimasi   : *{unpaid_total}*

{sep}
📈 *Collection Rate*
{rate}% tagihan sudah dibayar

{sep}
✅ *Sudah Bayar*
{paid_list}

{sep}
🔴 *Belum Bayar*
{unpaid_list}

{sep}
⏰ *Jatuh Tempo Hari Ini*
{due_today_list}

{sep}
🔔 *Jatuh Tempo 3 Hari ke Depan*
{due_list}

{sep}
_Dikirim otomatis oleh {app_name}_
_{now}_`;

async function loadReportTemplate() {
  const el = document.getElementById('reportTemplate');
  if (!el) return;
  const d = await App.api('/wa/report/template');
  const saved = d?.template || '';
  el.value = (!saved || (!saved.includes('{paid_list}') && !saved.includes('{due_today_list}'))) ? DEFAULT_REPORT_TEMPLATE : saved;
}

window.saveReportTemplate = async function() {
  const el = document.getElementById('reportTemplate');
  if (!el) return;
  const d = await App.api('/wa/report/template', { method:'POST', body: JSON.stringify({ template: el.value }) });
  if (d?.success) {
    previewReport();
    waAlert({ tone:'success', title:'Template Disimpan', message:'Format laporan berhasil disimpan dan preview telah diperbarui.', okText:'Selesai' });
  } else {
    waAlert({ tone:'danger', title:'Gagal Menyimpan', message: d?.message || 'Template gagal disimpan. Coba lagi.', okText:'Mengerti' });
  }
};

window.resetReportTemplate = async function() {
  const el = document.getElementById('reportTemplate');
  if (!el) return;
  const ok = await waConfirm({
    title: 'Reset Template?',
    message: 'Template pesan akan dikembalikan ke <b>bawaan</b>. Perubahan yang belum disimpan akan hilang.',
    okText: 'Reset Template',
    tone: 'danger'
  });
  if (!ok) return;
  el.value = DEFAULT_REPORT_TEMPLATE;
  toast('Template direset. Klik Simpan untuk menyimpan.');
};

window.insertVar = function(varStr) {
  const el = document.getElementById('reportTemplate');
  if (!el) return;
  const pos = el.selectionStart;
  el.value = el.value.slice(0, pos) + varStr + el.value.slice(el.selectionEnd);
  el.selectionStart = el.selectionEnd = pos + varStr.length;
  el.focus();
};

window.livePreviewTemplate = function() {
  clearTimeout(window._tplDebounce);
  window._tplDebounce = setTimeout(() => previewReport(), 800);
};

// ── WA format (bold *x*, italic _x_) ────────────────────────────
function _waFormat(text) {
  let s = _esc(text || '');
  s = s.replace(/(?:^|\s)\*([^\s*][^*\n]*[^\s*]|[^\s*])\*(?=\s|[.,;:!?)\]]|$)/g,
    (m,t) => m.replace('*'+t+'*', '<span class="wa-bold">'+t+'</span>'));
  s = s.replace(/(?:^|\s)_([^\s_][^_\n]*[^\s_]|[^\s_])_(?=\s|[.,;:!?)\]]|$)/g,
    (m,t) => m.replace('_'+t+'_', '<span class="wa-italic">'+t+'</span>'));
  return s;
}

// ── Sparkline halus (ApexCharts) — clean & minimalis ────────────
// Sparkline SVG inline (pola /wa/reminder) — ganti drawSpark ApexCharts.
function drawSparkSvg(lineId, dotId, vals) {
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
// buat deret kecil bervariasi dari satu nilai agar garis tidak datar
function sampleFrom(v) {
  v = parseFloat(v) || 0;
  const base = v || 1;
  return [.55,.7,.5,.85,.65,.9,1].map(f => Math.round(base * f));
}
function ratioBars(rate) {
  rate = Math.max(0, Math.min(100, +rate || 0));
  return [rate*.4, rate*.6, rate*.5, rate*.8, rate*.7, rate*.9, rate].map(x=>Math.round(x));
}

// ── Utils ───────────────────────────────────────────────────────
function _setText(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; }
function _fmtNum(n){ n = parseFloat(n)||0; return n>=1000000 ? (n/1000000).toFixed(1).replace('.0','')+'jt' : n>=1000 ? Math.round(n/1000)+'rb' : n; }
function _esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeJSON(s, def){ try { return JSON.parse(s || ''); } catch(e){ return def; } }
function toast(msg, isErr){
  if (window.App && App.showToast) return App.showToast(msg, isErr?'error':'success');
  const t = document.getElementById('toast'); if (!t) return;
  const icon = isErr
    ? '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>'
    : '<path stroke-linecap="round" stroke-linejoin="round" d="M20 6L9 17l-5-5"/>';
  t.innerHTML = '<span class="a-toast-ic"><svg fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">' + icon + '</svg></span><span class="a-toast-msg">' + msg + '</span>';
  t.className = 'a-toast show' + (isErr?' err':'');
  clearTimeout(t._tmr);
  t._tmr = setTimeout(()=>t.className='a-toast'+(isErr?' err':''), 3400);
}
