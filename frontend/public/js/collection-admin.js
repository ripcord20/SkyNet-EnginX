/* ============================================================================
 * collection-admin.js — Dashboard admin modul Field Collection (/collect)
 * Mengandalkan App.api / App.showToast / App.formatCurrency dari app.js.
 * ==========================================================================*/
(function () {
  'use strict';

  var state = { page: 1, totalPages: 1, selected: new Set(), collectors: [], rowMap: {}, report: null };
  var depState = { list: {} };
  var MONTH_NAMES = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  var COMM_LABEL = { flat: 'Flat / invoice', percent: 'Persen', none: 'Tanpa komisi' };

  // ── Styled confirm dialog (pengganti window.confirm/prompt) ───────
  var _ccResolve = null;
  function collConfirm(opts) {
    opts = opts || {};
    var ov = document.getElementById('collConfirm');
    var icn = document.getElementById('ccIcn');
    var ok = document.getElementById('ccOk');
    var field = document.getElementById('ccField');
    var variant = opts.variant === 'warn' ? 'warn' : 'ok';
    icn.className = 'pc-icn ' + variant;
    icn.innerHTML = variant === 'warn'
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
    setText('ccTitle', opts.title || 'Konfirmasi');
    setText('ccMsg', opts.message || '');
    setText('ccOk', opts.okText || 'OK');
    ok.className = 'pc-btn pc-ok ' + (variant === 'warn' ? 'is-warn' : 'is-ok');
    if (opts.input) {
      field.style.display = 'block';
      setText('ccFieldLbl', opts.inputLabel || 'Catatan');
      var inp = document.getElementById('ccInput');
      inp.value = '';
      inp.placeholder = opts.inputPlaceholder || 'Opsional…';
    } else {
      field.style.display = 'none';
    }
    ov.classList.add('open');
    return new Promise(function (resolve) { _ccResolve = resolve; });
  }
  function collConfirmOk() {
    var v = document.getElementById('ccField').style.display !== 'none'
      ? document.getElementById('ccInput').value : '';
    document.getElementById('collConfirm').classList.remove('open');
    if (_ccResolve) { _ccResolve(v === '' ? true : v); _ccResolve = null; }
  }
  function collConfirmCancel() {
    document.getElementById('collConfirm').classList.remove('open');
    if (_ccResolve) { _ccResolve(null); _ccResolve = null; }
  }

  function rp(n) {
    try { return App.formatCurrency(Number(n) || 0); }
    catch (e) { return 'Rp' + (Number(n) || 0).toLocaleString('id-ID'); }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var STATUS_LABEL = {
    pending: 'Pending', assigned: 'Assigned', in_progress: 'In Progress', paid: 'Paid',
    partial_paid: 'Partial Paid', promise_to_pay: 'Promise To Pay', not_home: 'Not Home',
    refused: 'Refused', request_termination: 'Request Termination', cancelled: 'Cancelled'
  };
  var STATUS_CLASS = {
    pending: 'b-pending', assigned: 'b-assigned', in_progress: 'b-inprogress', paid: 'b-paid',
    partial_paid: 'b-partial', promise_to_pay: 'b-promise', not_home: 'b-nothome',
    refused: 'b-refused', request_termination: 'b-termination', cancelled: 'b-cancelled'
  };

  // ── Stats ─────────────────────────────────────────────────────────
  async function loadStats() {
    var d = await App.api('/collection/stats');
    if (!d || !d.success) return;
    var t = d.data.totals || {};
    setText('stTask', t.task != null ? t.task : 0);
    setText('stTaskSub', (t.pending_count || 0) + ' pending · ' + (t.paid_count || 0) + ' lunas');
    setText('stCollected', rp(t.collected));
    setText('stCollectedSub', (t.paid_count || 0) + ' invoice tertagih');
    setText('stOutstanding', rp(t.outstanding));
    setText('stOutstandingSub', (t.promise_count || 0) + ' janji bayar');
    setText('stCashHand', rp(t.cash_on_hand));
  }

  // ── Collectors (dropdowns) ────────────────────────────────────────
  async function loadCollectors() {
    var d = await App.api('/collection/collectors');
    state.collectors = (d && d.success) ? d.data : [];
    var optsFilter = '<option value="">Semua Kolektor</option>';
    var optsAssign = '';
    state.collectors.forEach(function (c) {
      optsFilter += '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      optsAssign += '<option value="' + c.id + '">' + esc(c.name) +
        (c.region ? ' — ' + esc(c.region) : '') + '</option>';
    });
    var f = document.getElementById('fCollector'); if (f) f.innerHTML = optsFilter;
    var a = document.getElementById('assignCollector');
    if (a) a.innerHTML = optsAssign || '<option value="">(Belum ada kolektor)</option>';
  }

  // ── Assignments table ─────────────────────────────────────────────
  async function loadAssignments(page) {
    if (page) state.page = page;
    state.selected.clear(); updateSelCount();
    var chkAll = document.getElementById('chkAll'); if (chkAll) chkAll.checked = false;

    var qs = new URLSearchParams();
    qs.set('page', state.page); qs.set('limit', 20);
    var s = val('fStatus'); if (s) qs.set('status', s);
    var c = val('fCollector'); if (c) qs.set('collector_id', c);
    var ar = val('fArea'); if (ar) qs.set('area', ar);
    var se = val('fSearch'); if (se) qs.set('search', se);

    var body = document.getElementById('assignBody');
    body.innerHTML = '<tr><td colspan="9" class="no-label"><div class="empty">Memuat…</div></td></tr>';

    var d = await App.api('/collection/assignments?' + qs.toString());
    if (!d || !d.success) { body.innerHTML = '<tr><td colspan="9" class="no-label"><div class="empty">Gagal memuat data.</div></td></tr>'; return; }

    var rows = d.data || [];
    state.totalPages = (d.pagination && d.pagination.totalPages) || 1;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="no-label"><div class="empty">Tidak ada penugasan. Klik <b>Generate Task</b> untuk membuat dari invoice belum lunas.</div></td></tr>';
    } else {
      body.innerHTML = rows.map(renderRow).join('');
    }
    setText('pageInfo', 'Halaman ' + state.page + ' / ' + state.totalPages);
    document.getElementById('prevBtn').disabled = state.page <= 1;
    document.getElementById('nextBtn').disabled = state.page >= state.totalPages;
  }

  function renderRow(a) {
    var cust = a.customer || {};
    var inv = a.invoice || {};
    var area = [a.area_village, a.area_district, a.area_regency].filter(Boolean).join(', ') || '—';
    var due = inv.due_date ? new Date(inv.due_date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    var stClass = STATUS_CLASS[a.status] || 'b-pending';
    var stLabel = STATUS_LABEL[a.status] || a.status;
    var canSelect = a.status === 'pending';
    var collector = a.collector ? esc(a.collector.name) : '<span style="color:#cbd5e1;">—</span>';
    var canMove = a.status !== 'paid';
    var moveBtn = canMove
      ? '<button class="link-proof" style="margin-top:5px;color:#1d4ed8;" onclick="event.stopPropagation();CollAdmin.openReassign(' + a.id + ')">Pindah</button>'
      : '';
    var collectorCell = '<div>' + collector + '</div>' + moveBtn;

    // Simpan data untuk modal bukti.
    state.rowMap[a.id] = a;
    var isPaid = (a.status === 'paid' || a.status === 'partial_paid');
    var hasProof = !!a.payment_proof;
    var proofCell = (isPaid && hasProof)
      ? '<button class="link-proof" onclick="event.stopPropagation();CollAdmin.openProof(' + a.id + ')">Lihat</button>'
      : (isPaid ? '<span style="color:#cbd5e1;font-size:11.5px;">tanpa foto</span>' : '<span style="color:#e2e8f0;">—</span>');

    return '' +
      '<tr class="coll-row" style="cursor:pointer;" onclick="CollAdmin.openProof(' + a.id + ')">' +
        '<td class="no-label" onclick="event.stopPropagation();">' + (canSelect
          ? '<input type="checkbox" class="chk rowChk" value="' + a.id + '" onclick="event.stopPropagation();CollAdmin.toggleRow(' + a.id + ',this)">'
          : '') + '</td>' +
        '<td data-label="Pelanggan"><div style="font-weight:700;">' + esc(cust.name || '-') + '</div>' +
          '<div style="font-size:11.5px;color:#94a3b8;">' + esc(cust.customer_id || '') + '</div></td>' +
        '<td data-label="Area">' + esc(area) + '</td>' +
        '<td data-label="Invoice"><span class="money">' + esc(inv.invoice_number || '-') + '</span></td>' +
        '<td data-label="Tagihan"><span class="money">' + rp(a.amount_due) + '</span></td>' +
        '<td data-label="Jatuh Tempo">' + due + '</td>' +
        '<td data-label="Kolektor">' + collectorCell + '</td>' +
        '<td data-label="Status"><span class="badge ' + stClass + '">' + esc(stLabel) + '</span></td>' +
        '<td data-label="Bukti">' + proofCell + '</td>' +
      '</tr>';
  }

  // ── Selection ─────────────────────────────────────────────────────
  function toggleRow(id, el) {
    if (el.checked) state.selected.add(id); else state.selected.delete(id);
    updateSelCount();
  }
  function toggleAll(el) {
    document.querySelectorAll('.rowChk').forEach(function (chk) {
      chk.checked = el.checked;
      var id = Number(chk.value);
      if (el.checked) state.selected.add(id); else state.selected.delete(id);
    });
    updateSelCount();
  }
  function updateSelCount() {
    setText('selCount', state.selected.size);
    var btn = document.getElementById('btnAssign');
    if (btn) btn.disabled = state.selected.size === 0;
  }

  // ── Assign ────────────────────────────────────────────────────────
  function openAssign() {
    if (state.selected.size === 0) return;
    if (!state.collectors.length) { App.showToast('Belum ada kolektor terdaftar.', 'warning'); return; }
    show('assignModal');
  }
  async function submitAssign() {
    var collectorId = val('assignCollector');
    if (!collectorId) { App.showToast('Pilih kolektor dulu.', 'warning'); return; }
    var ids = Array.from(state.selected);
    var d = await App.api('/collection/assign', {
      method: 'POST', body: JSON.stringify({ assignment_ids: ids, collector_id: collectorId })
    });
    closeModal('assignModal');
    if (d && d.success) { App.showToast(d.message || 'Berhasil ditugaskan.', 'success'); loadAssignments(state.page); loadStats(); }
    else App.showToast((d && d.message) || 'Gagal menugaskan.', 'error');
  }

  // ── Generate ──────────────────────────────────────────────────────
  function openGenerate() {
    var now = new Date();
    var ms = document.getElementById('genMonth');
    if (ms && !ms.options.length) {
      var names = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      ms.innerHTML = names.map(function (n, i) { return '<option value="' + (i + 1) + '">' + n + '</option>'; }).join('');
    }
    if (ms) ms.value = now.getMonth() + 1;
    var ys = document.getElementById('genYear'); if (ys) ys.value = now.getFullYear();
    show('genModal');
  }
  async function submitGenerate() {
    var month = val('genMonth'), year = val('genYear');
    var onlyOverdue = document.getElementById('genOverdue').checked;
    var d = await App.api('/collection/generate', {
      method: 'POST', body: JSON.stringify({ month: month, year: year, only_overdue: onlyOverdue })
    });
    closeModal('genModal');
    if (d && d.success) { App.showToast(d.message || 'Task dibuat.', 'success'); loadAssignments(1); loadStats(); }
    else App.showToast((d && d.message) || 'Gagal generate.', 'error');
  }

  async function autoAssign() {
    var ok = await collConfirm({
      title: 'Auto-Assign Area',
      message: 'Bagikan otomatis semua task pending ke kolektor berdasarkan kecocokan area?',
      okText: 'Ya, Bagikan'
    });
    if (!ok) return;
    var d = await App.api('/collection/auto-assign', { method: 'POST', body: '{}' });
    if (d && d.success) { App.showToast(d.message || 'Selesai.', 'success'); loadAssignments(state.page); loadStats(); }
    else App.showToast((d && d.message) || 'Gagal auto-assign.', 'error');
  }

  function changePage(delta) {
    var np = state.page + delta;
    if (np < 1 || np > state.totalPages) return;
    loadAssignments(np);
  }

  // ── Kelola Kolektor ───────────────────────────────────────────────
  async function openCollectors() {
    show('collectorsModal');
    var box = document.getElementById('collectorsList');
    box.innerHTML = '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:13px;">Memuat…</div>';
    await loadCollectors();
    if (!state.collectors.length) {
      box.innerHTML = '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:13px;">Belum ada user ber-role <b>collector</b>.<br>Buat dulu di menu Manajemen User.</div>';
      return;
    }
    box.innerHTML = state.collectors.map(function (c) {
      var comm = c.commission_type === 'none' ? 'Tanpa komisi'
        : c.commission_type === 'percent' ? (c.commission_value + '% per tagihan')
        : ('Rp' + (c.commission_value || 0).toLocaleString('id-ID') + ' / invoice');
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px;border:1px solid #eef2f9;border-radius:12px;margin-bottom:8px;">' +
        '<div style="min-width:0;"><div style="font-weight:700;">' + esc(c.name) + '</div>' +
        '<div style="font-size:11.5px;color:#94a3b8;margin-top:2px;">' +
          (c.region ? esc(c.region) : '<span style="color:#cbd5e1;">area belum diset</span>') + ' · ' + comm + '</div>' +
        '<div style="font-size:11.5px;color:#0d9488;margin-top:2px;">Cash di tangan: Rp' + (c.cash_held || 0).toLocaleString('id-ID') + '</div></div>' +
        '<button class="btn-c btn-ghost" style="flex-shrink:0;padding:7px 12px;" onclick="CollAdmin.editCollector(' + c.id + ')">Atur</button>' +
        '</div>';
    }).join('');
  }

  function editCollector(userId) {
    var c = state.collectors.find(function (x) { return x.id === userId; });
    if (!c) return;
    document.getElementById('editCollectorName').textContent = 'Atur: ' + c.name;
    document.getElementById('ecUserId').value = c.id;
    document.getElementById('ecRegion').value = c.region || '';
    document.getElementById('ecPhone').value = c.phone || '';
    document.getElementById('ecCommType').value = c.commission_type || 'flat';
    document.getElementById('ecCommValue').value = c.commission_value || 0;
    onCommTypeChange();
    closeModal('collectorsModal');
    show('editCollectorModal');
  }

  function onCommTypeChange() {
    var t = val('ecCommType');
    var lbl = document.getElementById('ecValLabel');
    var inp = document.getElementById('ecCommValue');
    if (t === 'percent') { lbl.textContent = 'Nilai Komisi (%)'; inp.placeholder = '3'; }
    else if (t === 'none') { lbl.textContent = 'Nilai Komisi (nonaktif)'; inp.placeholder = '0'; }
    else { lbl.textContent = 'Nilai Komisi (Rp)'; inp.placeholder = '5000'; }
    inp.disabled = (t === 'none');
  }

  async function submitCollector() {
    var body = {
      user_id: val('ecUserId'),
      region: val('ecRegion'),
      phone: val('ecPhone'),
      commission_type: val('ecCommType'),
      commission_value: val('ecCommValue') || 0
    };
    var d = await App.api('/collection/collectors', { method: 'POST', body: JSON.stringify(body) });
    if (d && d.success) {
      App.showToast(d.message || 'Tersimpan.', 'success');
      closeModal('editCollectorModal');
      await loadCollectors();
      openCollectors();
    } else App.showToast((d && d.message) || 'Gagal menyimpan.', 'error');
  }

  // ── Tab switching (Penagihan / Laporan / Setoran) ─────────────────
  var _reportInited = false;
  var _filterTimer = null;
  function debouncedFilter() {
    clearTimeout(_filterTimer);
    _filterTimer = setTimeout(function () { loadAssignments(1); }, 350);
  }

  function statFilter(status) {
    switchTab('tasks');
    var sel = document.getElementById('fStatus');
    if (sel) {
      // 'open' tidak ada sebagai satu nilai; tampilkan semua agar admin bisa pilih.
      sel.value = (status === 'open') ? '' : (status || '');
    }
    loadAssignments(1);
    var grid = document.getElementById('statGrid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function switchTab(tab) {
    var map = {
      tasks:    ['tabBtnTasks', 'tabPanelTasks'],
      report:   ['tabBtnReport', 'tabPanelReport'],
      map:      ['tabBtnMap', 'tabPanelMap'],
      deposits: ['tabBtnDeposits', 'tabPanelDeposits']
    };
    Object.keys(map).forEach(function (k) {
      var btn = document.getElementById(map[k][0]);
      var pan = document.getElementById(map[k][1]);
      var on = (k === tab);
      if (btn) btn.classList.toggle('coll-tab-active', on);
      if (pan) pan.style.display = on ? '' : 'none';
    });
    if (tab === 'report') {
      if (!_reportInited) { _reportInited = true; initReportControls(); }
      loadReport();
    } else if (tab === 'deposits') {
      loadDeposits();
    } else if (tab === 'map') {
      if (!_mapInited) { _mapInited = true; initMapControls(); }
      setTimeout(loadMap, 60); // beri waktu panel tampil sebelum Leaflet hitung ukuran
    }
  }

  function initReportControls() {
    var now = new Date();
    var ms = document.getElementById('repMonth');
    if (ms && !ms.options.length) {
      ms.innerHTML = MONTH_NAMES.map(function (n, i) { return '<option value="' + (i + 1) + '">' + n + '</option>'; }).join('');
    }
    if (ms) ms.value = now.getMonth() + 1;
    var ys = document.getElementById('repYear'); if (ys) ys.value = now.getFullYear();
    // Isi dropdown filter kolektor dari daftar yang sudah dimuat.
    var cs = document.getElementById('repCollector');
    if (cs) {
      var opts = '<option value="">Semua Kolektor</option>';
      (state.collectors || []).forEach(function (c) {
        opts += '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      });
      cs.innerHTML = opts;
    }
  }

  // ── Detail bukti pembayaran (modal mirror Payments) ───────────────
  function openProof(assignmentId) {
    var a = state.rowMap[assignmentId];
    if (!a) return;
    var cust = a.customer || {};
    var inv = a.invoice || {};
    var paid = (a.status === 'paid' || a.status === 'partial_paid');
    setText('pmInvNo', inv.invoice_number || '—');
    setText('pmAmount', rp(paid && a.amount_collected != null ? a.amount_collected : a.amount_due));
    setText('pmCustName', cust.name || '—');
    setText('pmCustId', cust.customer_id || '—');
    setText('pmCustPhone', cust.phone || '—');
    setText('pmInvoice', inv.invoice_number || '—');
    setText('pmPeriode', (a.period_month && a.period_year)
      ? (MONTH_NAMES[a.period_month - 1] + ' ' + a.period_year)
      : '—');
    setText('pmCollector', a.collector ? a.collector.name : '—');
    setText('pmCollectedAt', a.collected_at
      ? new Date(a.collected_at).toLocaleString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—');

    // Label nominal: tagihan vs diterima.
    var amtLbl = document.getElementById('pmAmountLbl');
    if (amtLbl) amtLbl.textContent = paid ? 'Nominal Diterima' : 'Nominal Tagihan';

    var STLBL = {
      pending: 'Pending', assigned: 'Assigned', in_progress: 'Dikerjakan',
      paid: 'Lunas', partial_paid: 'Pembayaran Sebagian', promise_to_pay: 'Janji Bayar',
      not_home: 'Tidak di Rumah', refused: 'Menolak', request_termination: 'Minta Berhenti'
    };
    var stWrap = document.getElementById('pmStatusWrap');
    if (stWrap) stWrap.innerHTML = '<span class="pm-st">' + (STLBL[a.status] || a.status) + '</span>';

    var frame = document.getElementById('pmImgFrame');
    var openLink = document.getElementById('pmImgOpen');
    var hasProof = paid && !!a.payment_proof;
    if (hasProof) {
      var url = '/api/collection/assignments/' + assignmentId + '/proof';
      if (openLink) openLink.href = url;
      loadProofImage(frame, openLink, url);
    } else {
      if (frame) {
        if (frame._objUrl) { URL.revokeObjectURL(frame._objUrl); frame._objUrl = null; }
        frame.classList.add('is-empty');
        frame.innerHTML = _proofEmptyState(paid ? 'Pembayaran ini tidak menyertakan foto bukti.' : 'Tugas ini belum dibayar, belum ada bukti.');
      }
      if (openLink) openLink.style.display = 'none';
    }

    var modal = document.getElementById('proofModal');
    if (modal) modal.classList.add('open');

    // Mini-map lokasi penagihan (bila ada koordinat).
    renderProofGps(a);
  }

  var _pmMap = null, _pmMarker = null;
  function renderProofGps(a) {
    var wrap = document.getElementById('pmGpsWrap');
    if (!wrap) return;
    var lat = parseFloat(a.pay_lat), lng = parseFloat(a.pay_lng);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0) || typeof L === 'undefined') {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    var link = document.getElementById('pmGpsLink');
    if (link) link.href = 'https://www.google.com/maps?q=' + lat + ',' + lng;
    // Beri waktu modal tampil agar Leaflet menghitung ukuran dengan benar.
    setTimeout(function () {
      if (!_pmMap) {
        _pmMap = L.map('pmMap', { zoomControl: true, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(_pmMap);
      }
      _pmMap.setView([lat, lng], 16);
      if (_pmMarker) { _pmMarker.setLatLng([lat, lng]); }
      else { _pmMarker = L.marker([lat, lng]).addTo(_pmMap); }
      _pmMap.invalidateSize();
    }, 120);
  }

  function closeProofModal() {
    var modal = document.getElementById('proofModal');
    if (modal) modal.classList.remove('open');
    var frame = document.getElementById('pmImgFrame');
    if (frame) {
      if (frame._objUrl) { URL.revokeObjectURL(frame._objUrl); frame._objUrl = null; }
      frame.classList.remove('is-empty');
      frame.innerHTML = '<div class="pm-img-loading">Memuat gambar…</div>';
    }
    var openLink = document.getElementById('pmImgOpen');
    if (openLink) openLink.style.display = '';
  }

  function _proofEmptyState(msg) {
    return '<div class="pm-img-empty">' +
      '<div class="pm-img-empty-icn">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6">' +
        '<path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M4 6h16M4 6v12a2 2 0 002 2h12a2 2 0 002-2V6"/>' +
        '<line x1="3" y1="3" x2="21" y2="21" stroke-linecap="round"/></svg>' +
      '</div>' +
      '<div class="pm-img-empty-ttl">Bukti tidak tersedia</div>' +
      '<div class="pm-img-empty-sub">' + esc(msg || 'File bukti tidak ditemukan di server.') + '</div>' +
    '</div>';
  }

  async function loadProofImage(frame, openLink, url) {
    if (!frame) return;
    if (frame._objUrl) { URL.revokeObjectURL(frame._objUrl); frame._objUrl = null; }
    frame.innerHTML = '<div class="pm-img-loading">Memuat gambar…</div>';
    frame.classList.remove('is-empty');
    try {
      var token = (function () {
        try { var ls = localStorage.getItem('token'); if (ls) return ls; } catch (_) {}
        var m = document.cookie.match(/(?:^|;\s*)token=([^;]+)/); return m ? decodeURIComponent(m[1]) : null;
      })();
      var headers = { 'Accept': 'image/*,application/pdf' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var res = await fetch(url, { credentials: 'include', headers: headers });
      var ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || ct.indexOf('application/json') >= 0 || ct.indexOf('text/') >= 0) {
        var msg = 'File bukti tidak ditemukan di server.';
        try { var j = await res.json(); if (j && j.message) msg = j.message; } catch (_) {}
        frame.classList.add('is-empty');
        frame.innerHTML = _proofEmptyState(msg);
        if (openLink) openLink.style.display = 'none';
        return;
      }
      var blob = await res.blob();
      var obj = URL.createObjectURL(blob);
      frame._objUrl = obj;
      if (openLink) { openLink.style.display = 'inline-flex'; openLink.href = obj; }
      if (ct.indexOf('pdf') >= 0) frame.innerHTML = '<iframe src="' + obj + '"></iframe>';
      else frame.innerHTML = '<img src="' + obj + '" alt="Bukti pembayaran">';
    } catch (e) {
      frame.classList.add('is-empty');
      frame.innerHTML = _proofEmptyState('Gagal memuat bukti. Periksa koneksi atau coba lagi.');
      if (openLink) openLink.style.display = 'none';
    }
  }

  // ── Laporan Kolektor & Komisi ─────────────────────────────────────
  async function loadReport() {
    var body = document.getElementById('reportBody');
    body.innerHTML = '<tr><td colspan="7" class="no-label"><div class="empty">Memuat…</div></td></tr>';
    var m = val('repMonth'), y = val('repYear');
    var cid = val('repCollector');
    var qs = new URLSearchParams();
    if (m) qs.set('month', m); if (y) qs.set('year', y);
    var d = await App.api('/collection/report?' + qs.toString());
    if (!d || !d.success) { body.innerHTML = '<tr><td colspan="7" class="no-label"><div class="empty">Gagal memuat laporan.</div></td></tr>'; return; }

    var allRows = d.data.rows || [];
    // Filter per kolektor (client-side).
    var rows = cid ? allRows.filter(function (r) { return String(r.collector_id) === String(cid); }) : allRows;

    // Hitung ulang total mengikuti hasil filter.
    var t = { collectors: rows.length, task_count: 0, paid_count: 0, collected: 0, commission: 0 };
    rows.forEach(function (r) {
      t.task_count  += r.task_count || 0;
      t.paid_count  += r.paid_count || 0;
      t.collected   += r.collected || 0;
      t.commission  += r.commission || 0;
    });

    setText('repTotCollected', rp(t.collected));
    setText('repTotPaid', (t.paid_count || 0) + ' invoice tertagih');
    setText('repTotComm', rp(t.commission));
    setText('repTotCollectors', t.collectors != null ? t.collectors : 0);
    setText('repTotTask', (t.task_count || 0) + ' total task');

    // Simpan untuk fitur cetak.
    state.report = {
      period: d.data.period || { month: m ? parseInt(m, 10) : null, year: y ? parseInt(y, 10) : null },
      rows: rows,
      totals: t,
      collectorName: cid ? ((state.collectors.find(function (c) { return String(c.id) === String(cid); }) || {}).name || '') : ''
    };

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="no-label"><div class="empty">Belum ada tagihan tertagih pada periode ini.</div></td></tr>';
      return;
    }
    var per = state.report.period || {};
    body.innerHTML = rows.map(function (r) {
      var scheme = r.commission_type === 'percent' ? (r.commission_value + '%')
        : r.commission_type === 'none' ? '—'
        : ('Rp' + (r.commission_value || 0).toLocaleString('id-ID'));
      var commAct;
      if (r.commission_paid) {
        commAct = '<span class="dep-st dep-st-ok" style="font-size:11px;">Sudah Dibayar</span>';
      } else if (r.commission > 0 && per.month && per.year) {
        commAct = '<button class="link-proof" style="color:#0d9488;border-color:#a9e6dc;" onclick="CollAdmin.payCommission(' + r.collector_id + ',' + per.month + ',' + per.year + ')">Tandai Dibayar</button>';
      } else {
        commAct = '<span style="color:#cbd5e1;font-size:11.5px;">—</span>';
      }
      return '<tr>' +
        '<td data-label="Kolektor"><div style="font-weight:700;">' + esc(r.name) + '</div></td>' +
        '<td data-label="Tertagih" style="text-align:center;">' + (r.paid_count || 0) + '</td>' +
        '<td data-label="Terkumpul" style="text-align:right;" class="money">' + rp(r.collected) + '</td>' +
        '<td data-label="Skema">' + esc(COMM_LABEL[r.commission_type] || r.commission_type) + ' · ' + scheme + '</td>' +
        '<td data-label="Komisi" style="text-align:right;font-weight:800;color:#1a6ef5;" class="money">' + rp(r.commission) + '</td>' +
        '<td data-label="Cash Pegang" style="text-align:right;color:#0d9488;" class="money">' + rp(r.cash_held) + '</td>' +
        '<td data-label="Status Komisi" style="text-align:center;">' + commAct + '</td>' +
      '</tr>';
    }).join('');
  }

  // ── Tandai komisi dibayar ─────────────────────────────────────────
  async function payCommission(collectorId, month, year) {
    var row = (state.report && state.report.rows || []).find(function (r) { return String(r.collector_id) === String(collectorId); });
    var nm = row ? row.name : 'kolektor';
    var amt = row ? rp(row.commission) : '';
    var ok = await collConfirm({
      title: 'Bayar Komisi',
      message: 'Tandai komisi ' + nm + ' sebesar ' + amt + ' untuk periode ini sebagai DIBAYAR? Tercatat sebagai pengeluaran di Keuangan dan tidak bisa dobel.',
      okText: 'Tandai Dibayar'
    });
    if (!ok) return;
    var d = await App.api('/collection/commission/pay', {
      method: 'POST',
      body: JSON.stringify({ collector_id: collectorId, month: month, year: year })
    });
    if (d && d.success) { App.showToast(d.message || 'Komisi ditandai dibayar.', 'success'); loadReport(); }
    else App.showToast((d && d.message) || 'Gagal menandai komisi.', 'error');
  }

  // ── Export rekap (Excel/PDF) ──────────────────────────────────────
  function exportReport(fmt) {
    var m = val('repMonth'), y = val('repYear'), cid = val('repCollector');
    var qs = new URLSearchParams();
    if (m) qs.set('month', m);
    if (y) qs.set('year', y);
    if (cid) qs.set('collector_id', cid);
    var url = '/api/collection/report/' + (fmt === 'pdf' ? 'pdf' : 'excel') + '?' + qs.toString();
    window.open(url, '_blank');
  }

  // ── Cetak laporan komisi per periode ──────────────────────────────
  function printReport() {
    var R = state.report;
    if (!R || !R.rows || !R.rows.length) { App.showToast('Tidak ada data untuk dicetak.', 'warning'); return; }
    var period = R.period || {};
    var periodLabel = (period.month ? (MONTH_NAMES[period.month - 1] + ' ') : '') + (period.year || '');
    var scopeLabel = R.collectorName ? ('Kolektor: ' + R.collectorName) : 'Semua Kolektor';
    var now = new Date();
    var printed = now.toLocaleString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    function money(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }
    function schemeTxt(r) {
      return r.commission_type === 'percent' ? (r.commission_value + '%')
        : r.commission_type === 'none' ? '-'
        : ('Rp ' + (r.commission_value || 0).toLocaleString('id-ID') + ' / invoice');
    }

    var rowsHtml = R.rows.map(function (r, i) {
      return '<tr>' +
        '<td style="text-align:center;">' + (i + 1) + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td style="text-align:center;">' + (r.paid_count || 0) + '</td>' +
        '<td style="text-align:right;">' + money(r.collected) + '</td>' +
        '<td>' + esc(COMM_LABEL[r.commission_type] || r.commission_type) + ' (' + schemeTxt(r) + ')</td>' +
        '<td style="text-align:right;font-weight:700;">' + money(r.commission) + '</td>' +
        '<td style="text-align:right;">' + money(r.cash_held) + '</td>' +
      '</tr>';
    }).join('');

    var T = R.totals || {};
    var totalRow = '<tr class="total-row">' +
      '<td colspan="2">TOTAL</td>' +
      '<td style="text-align:center;">' + (T.paid_count || 0) + '</td>' +
      '<td style="text-align:right;">' + money(T.collected) + '</td>' +
      '<td></td>' +
      '<td style="text-align:right;">' + money(T.commission) + '</td>' +
      '<td></td>' +
    '</tr>';

    var companyName = (document.querySelector('.brand-name') || {}).textContent
      || (document.title || 'FLAYNET').split('-')[0].trim() || 'FLAYNET';

    var html = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">' +
      '<title>Laporan Komisi Kolektor - ' + esc(periodLabel) + '</title>' +
      '<style>' +
      '*{box-sizing:border-box;} body{font-family:"DM Sans",Arial,sans-serif;color:#0d1b3e;margin:32px;}' +
      '.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1d4ed8;padding-bottom:14px;margin-bottom:18px;}' +
      '.hdr h1{font-size:20px;margin:0 0 4px;} .hdr .sub{font-size:12px;color:#64748b;}' +
      '.hdr .co{font-size:16px;font-weight:800;color:#1d4ed8;}' +
      '.meta{font-size:12px;color:#475569;margin-bottom:14px;line-height:1.7;}' +
      '.meta b{color:#0d1b3e;}' +
      '.cards{display:flex;gap:12px;margin-bottom:18px;}' +
      '.card{flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;}' +
      '.card .l{font-size:11px;color:#64748b;font-weight:600;} .card .v{font-size:18px;font-weight:800;margin-top:3px;}' +
      'table{width:100%;border-collapse:collapse;font-size:12px;}' +
      'th,td{border:1px solid #cbd5e1;padding:8px 10px;}' +
      'th{background:#1d4ed8;color:#fff;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;}' +
      'tr:nth-child(even) td{background:#f8fafc;}' +
      '.total-row td{background:#eef4ff !important;font-weight:800;}' +
      '.sign{margin-top:46px;display:flex;justify-content:flex-end;} .sign .box{width:230px;text-align:center;font-size:12px;}' +
      '.sign .line{margin-top:64px;border-top:1px solid #0d1b3e;padding-top:5px;}' +
      '.foot{margin-top:24px;font-size:10.5px;color:#94a3b8;text-align:center;}' +
      '@media print{body{margin:14mm;} .noprint{display:none;}}' +
      '</style></head><body>' +
      '<div class="hdr"><div><h1>Laporan Komisi Kolektor</h1>' +
        '<div class="sub">Penagihan Lapangan (Field Collection)</div></div>' +
        '<div style="text-align:right;"><div class="co">' + esc(companyName) + '</div></div></div>' +
      '<div class="meta"><b>Periode:</b> ' + esc(periodLabel || '-') + '<br>' +
        '<b>Cakupan:</b> ' + esc(scopeLabel) + '<br>' +
        '<b>Dicetak:</b> ' + esc(printed) + '</div>' +
      '<div class="cards">' +
        '<div class="card"><div class="l">Total Terkumpul</div><div class="v" style="color:#0d9488;">' + money(T.collected) + '</div></div>' +
        '<div class="card"><div class="l">Total Komisi</div><div class="v" style="color:#1d4ed8;">' + money(T.commission) + '</div></div>' +
        '<div class="card"><div class="l">Kolektor / Invoice Tertagih</div><div class="v">' + (T.collectors || 0) + ' / ' + (T.paid_count || 0) + '</div></div>' +
      '</div>' +
      '<table><thead><tr>' +
        '<th style="width:34px;text-align:center;">No</th><th>Kolektor</th>' +
        '<th style="text-align:center;">Tertagih</th><th style="text-align:right;">Terkumpul</th>' +
        '<th>Skema Komisi</th><th style="text-align:right;">Komisi</th><th style="text-align:right;">Cash Pegang</th>' +
      '</tr></thead><tbody>' + rowsHtml + totalRow + '</tbody></table>' +
      '<div class="sign"><div class="box">Disetujui oleh,<div class="line">( ____________________ )</div></div></div>' +
      '<div class="foot">Dokumen dibuat otomatis oleh sistem FLAYNET-CRM</div>' +
      '<script>window.onload=function(){window.print();}<\/script>' +
      '</body></html>';

    var w = window.open('', '_blank');
    if (!w) { App.showToast('Popup diblokir browser. Izinkan popup untuk mencetak.', 'error'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  // ── Peta Sebaran Tugas ────────────────────────────────────────────
  var _mapInited = false, _map = null, _mapLayer = null;
  var ST_COLOR = {
    pending: '#94a3b8', assigned: '#1d4ed8', in_progress: '#0891b2',
    paid: '#16a34a', partial_paid: '#0d9488', promise_to_pay: '#b45309',
    not_home: '#d97706', refused: '#dc2626', request_termination: '#7a1f1f'
  };
  var ST_LABEL = {
    pending: 'Pending', assigned: 'Assigned', in_progress: 'Dikerjakan',
    paid: 'Lunas', partial_paid: 'Bayar Sebagian', promise_to_pay: 'Janji Bayar',
    not_home: 'Tidak di Rumah', refused: 'Menolak', request_termination: 'Minta Berhenti'
  };

  function initMapControls() {
    var cs = document.getElementById('mapCollector');
    if (cs) {
      var opts = '<option value="">Semua Kolektor</option>';
      (state.collectors || []).forEach(function (c) {
        opts += '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      });
      cs.innerHTML = opts;
    }
    // Legend
    var lg = document.getElementById('mapLegend');
    if (lg) {
      lg.innerHTML = Object.keys(ST_LABEL).map(function (k) {
        return '<span class="lg"><span class="sw" style="background:' + ST_COLOR[k] + ';"></span>' + ST_LABEL[k] + '</span>';
      }).join('');
    }
  }

  function ensureMap() {
    if (_map) return _map;
    _map = L.map('collMap', { scrollWheelZoom: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap'
    }).addTo(_map);
    _map.setView([-2.5, 118], 5); // default Indonesia
    _mapLayer = L.layerGroup().addTo(_map);
    return _map;
  }

  function pinIcon(color) {
    return L.divIcon({
      className: '',
      html: '<div class="coll-pin" style="background:' + color + ';"></div>',
      iconSize: [24, 24], iconAnchor: [12, 24], popupAnchor: [0, -22]
    });
  }

  async function loadMap() {
    ensureMap();
    var info = document.getElementById('mapInfo');
    if (info) info.textContent = 'Memuat…';
    var qs = new URLSearchParams();
    var st = val('mapStatus'), cid = val('mapCollector');
    if (st) qs.set('status', st);
    if (cid) qs.set('collector_id', cid);
    var d = await App.api('/collection/map?' + qs.toString());
    _mapLayer.clearLayers();
    if (!d || !d.success) { if (info) info.textContent = 'Gagal memuat data peta.'; return; }
    var pts = d.data.points || [];
    if (info) info.textContent = pts.length + ' titik tugas (dari customer berkoordinat)';
    if (!pts.length) {
      _map.setView([-2.5, 118], 5);
      setTimeout(function () { _map.invalidateSize(); }, 50);
      return;
    }
    var bounds = [];
    pts.forEach(function (p) {
      var color = ST_COLOR[p.status] || '#64748b';
      var m = L.marker([p.lat, p.lng], { icon: pinIcon(color) });
      m.bindPopup(buildMapPopup(p));
      m.addTo(_mapLayer);
      bounds.push([p.lat, p.lng]);
    });
    try { _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 }); } catch (_) {}
    setTimeout(function () { _map.invalidateSize(); }, 50);
  }

  function buildMapPopup(p) {
    var canMove = p.status !== 'paid';
    return '<div class="coll-pop">' +
      '<h4>' + esc(p.customer_name || '-') + '</h4>' +
      '<div class="cid">' + esc(p.customer_code || '') + (p.invoice_number ? ' · ' + esc(p.invoice_number) : '') + '</div>' +
      '<div class="r"><span>Status</span><b style="color:' + (ST_COLOR[p.status] || '#0d1b3e') + ';">' + (ST_LABEL[p.status] || p.status) + '</b></div>' +
      '<div class="r"><span>Tagihan</span><b>' + rp(p.amount_due) + '</b></div>' +
      '<div class="r"><span>Kolektor</span><b>' + (p.collector_name ? esc(p.collector_name) : '—') + '</b></div>' +
      (p.address ? '<div class="addr">' + esc(p.address) + '</div>' : '') +
      '<div class="act">' +
        (canMove ? '<button class="b-move" onclick="CollAdmin.openReassign(' + p.id + ')">Pindahkan Kolektor</button>' : '') +
      '</div>' +
    '</div>';
  }

  // ── Reassign Tugas ─────────────────────────────────────────────────
  var _raId = null, _raSel = null;
  async function openReassign(assignmentId) {
    _raId = assignmentId; _raSel = null;
    var a = state.rowMap[assignmentId];
    var sub = a && a.customer ? (a.customer.name + (a.invoice ? ' · ' + a.invoice.invoice_number : '')) : ('Tugas #' + assignmentId);
    setText('raSub', sub);
    document.getElementById('raReason').value = '';
    // Daftar kolektor (opsi). Sertakan opsi "Lepas (pending)".
    var cur = a ? a.collector_id : null;
    var list = document.getElementById('raList');
    var html = '';
    (state.collectors || []).forEach(function (c) {
      var isCur = String(c.id) === String(cur);
      html += '<div class="ra-opt" data-id="' + c.id + '" onclick="CollAdmin.raPick(' + c.id + ',this)">' +
        '<div class="av">' + esc(initials(c.name)) + '</div>' +
        '<div><div class="nm">' + esc(c.name) + (isCur ? ' <span style="color:#94a3b8;font-weight:600;">(saat ini)</span>' : '') + '</div>' +
        '<div class="meta">Cash dipegang: ' + rp(c.cash_held || 0) + '</div></div>' +
        '<div class="rd"></div></div>';
    });
    html += '<div class="ra-opt" data-id="0" onclick="CollAdmin.raPick(0,this)">' +
      '<div class="av" style="background:#fef2f2;color:#dc2626;">—</div>' +
      '<div><div class="nm">Lepas penugasan</div><div class="meta">Kembalikan ke status pending</div></div>' +
      '<div class="rd"></div></div>';
    list.innerHTML = html;
    document.getElementById('reassignModal').classList.add('open');
    loadReassignHistory(assignmentId);
  }
  function raPick(id, el) {
    _raSel = id;
    document.querySelectorAll('#raList .ra-opt').forEach(function (o) { o.classList.remove('sel'); });
    if (el) el.classList.add('sel');
  }
  function closeReassign() {
    document.getElementById('reassignModal').classList.remove('open');
    _raId = null; _raSel = null;
  }
  async function loadReassignHistory(id) {
    var wrap = document.getElementById('raHistWrap');
    var box = document.getElementById('raHist');
    var d = await App.api('/collection/assignments/' + id + '/history');
    if (!d || !d.success || !d.data.logs.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    var ACT = { assign: 'Ditugaskan', reassign: 'Dipindahkan', unassign: 'Dilepas' };
    box.innerHTML = d.data.logs.map(function (l) {
      var when = l.at ? new Date(l.at).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      var flow = (l.from ? esc(l.from) : 'Pending') + ' → ' + (l.to ? esc(l.to) : 'Pending');
      return '<div class="ra-hist-row"><div class="ra-hist-dot"></div>' +
        '<div style="flex:1;"><div><b>' + (ACT[l.action] || l.action) + '</b>: ' + flow + '</div>' +
        (l.reason ? '<div style="color:#64748b;">' + esc(l.reason) + '</div>' : '') +
        '<div class="t">' + when + (l.by ? ' · oleh ' + esc(l.by) : '') + '</div></div></div>';
    }).join('');
  }
  async function submitReassign() {
    if (_raSel === null) { App.showToast('Pilih kolektor tujuan dulu.', 'warning'); return; }
    var btn = document.getElementById('raSubmit');
    var old = btn.textContent; btn.textContent = 'Memproses…'; btn.disabled = true;
    var body = { collector_id: _raSel === 0 ? null : _raSel, reason: document.getElementById('raReason').value.trim() };
    var d = await App.api('/collection/assignments/' + _raId + '/reassign', { method: 'POST', body: JSON.stringify(body) });
    btn.textContent = old; btn.disabled = false;
    if (d && d.success) {
      App.showToast(d.message || 'Tugas dipindahkan.', 'success');
      closeReassign();
      loadAssignments(state.page); loadStats();
      if (_map && document.getElementById('tabPanelMap').style.display !== 'none') loadMap();
    } else {
      App.showToast((d && d.message) || 'Gagal memindahkan tugas.', 'error');
    }
  }

  // ── Setoran Kas (admin) ───────────────────────────────────────────
  async function refreshDepBadge() {
    var d = await App.api('/collection/deposits?status=pending&limit=1');
    if (d && d.success && d.summary) {
      var n = d.summary.pending_count || 0;
      var b = document.getElementById('depBadge');
      if (b) { b.textContent = n; b.style.display = n > 0 ? 'inline-block' : 'none'; }
    }
  }
  async function loadDeposits() {
    var box = document.getElementById('depositsList');
    box.innerHTML = '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:13px;">Memuat…</div>';
    var st = val('depFilterStatus');
    var d = await App.api('/collection/deposits?limit=50' + (st ? '&status=' + st : ''));
    if (!d || !d.success) { box.innerHTML = '<div style="padding:24px;text-align:center;color:#94a3b8;">Gagal memuat.</div>'; return; }
    var rows = d.data || [];
    depState.list = {};
    if (!rows.length) {
      box.innerHTML = '<div class="dep-empty"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg><div>Tidak ada setoran pada filter ini.</div></div>';
      return;
    }
    var STLABEL = { pending: ['Menunggu', 'dep-st-wait'], verified: ['Terverifikasi', 'dep-st-ok'], rejected: ['Ditolak', 'dep-st-no'] };
    box.innerHTML = '<div class="dep-list">' + rows.map(function (x) {
      depState.list[x.id] = x;
      var st = STLABEL[x.status] || ['?', 'dep-st-wait'];
      var variance = parseFloat(x.variance) || 0;
      var varTxt = variance === 0 ? '<b style="color:#16a34a;">cocok</b>'
        : '<b style="color:' + (variance < 0 ? '#dc2626' : '#16a34a') + ';">' + (variance < 0 ? '-' : '+') + 'Rp' + Math.abs(variance).toLocaleString('id-ID') + '</b>';
      var dateTxt = new Date(x.deposit_date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
      return '<div class="dep-card" onclick="CollAdmin.openDepositDetail(' + x.id + ')">' +
        '<div class="dep-ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg></div>' +
        '<div class="dep-main">' +
          '<div class="dep-amt money">' + rp(x.deposited_amount) + '</div>' +
          '<div class="dep-meta">' + esc(x.collector ? x.collector.name : '-') + ' · ' + dateTxt + '</div>' +
          '<div class="dep-meta2">Ekspektasi ' + rp(x.expected_amount) + ' · Selisih ' + varTxt + (x.proof_path ? ' · <span style="color:#1d4ed8;">ada bukti</span>' : '') + '</div>' +
        '</div>' +
        '<div class="dep-right"><span class="dep-st ' + st[1] + '">' + st[0] + '</span>' +
          '<svg class="dep-chev" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#c2cbdc" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></div>' +
      '</div>';
    }).join('') + '</div>';
  }

  // ── Detail setoran (modal, mirror bukti pembayaran) ───────────────
  function openDepositDetail(id) {
    var x = depState.list[id];
    if (!x) return;
    var STLBL = { pending: 'Menunggu Verifikasi', verified: 'Terverifikasi', rejected: 'Ditolak' };
    var variance = parseFloat(x.variance) || 0;
    setText('ddTitle', 'Detail Setoran');
    setText('ddSub', (x.collector ? x.collector.name : '-'));
    setText('ddAmount', rp(x.deposited_amount));
    var stWrap = document.getElementById('ddStatusWrap');
    if (stWrap) stWrap.innerHTML = '<span class="pm-st">' + (STLBL[x.status] || x.status) + '</span>';
    setText('ddExpected', rp(x.expected_amount));
    var vEl = document.getElementById('ddVariance');
    if (vEl) {
      if (variance === 0) { vEl.textContent = 'Cocok'; vEl.style.color = '#16a34a'; }
      else { vEl.textContent = (variance < 0 ? '-' : '+') + 'Rp' + Math.abs(variance).toLocaleString('id-ID'); vEl.style.color = variance < 0 ? '#dc2626' : '#16a34a'; }
    }
    setText('ddDate', new Date(x.deposit_date).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }));
    setText('ddCollector', x.collector ? x.collector.name : '-');
    setText('ddVerifier', x.verifier ? x.verifier.name : '—');
    var noteRow = document.getElementById('ddNoteRow');
    if (x.note) { noteRow.style.display = ''; setText('ddNote', x.note); } else noteRow.style.display = 'none';
    var rejRow = document.getElementById('ddRejectRow');
    if (x.reject_reason) { rejRow.style.display = ''; setText('ddReject', x.reject_reason); } else rejRow.style.display = 'none';

    // Tombol aksi (hanya untuk pending)
    var actWrap = document.getElementById('ddActions');
    if (x.status === 'pending') {
      actWrap.style.display = 'flex';
      actWrap.innerHTML =
        '<button class="pc-btn pc-cancel" style="flex:1;color:#dc2626;" onclick="CollAdmin.rejectDeposit(' + x.id + ',true)">Tolak</button>' +
        '<button class="pc-btn pc-ok is-ok" style="flex:1;" onclick="CollAdmin.verifyDeposit(' + x.id + ',true)">Verifikasi</button>';
    } else {
      actWrap.style.display = 'none';
      actWrap.innerHTML = '';
    }

    // Bukti
    var frame = document.getElementById('ddImgFrame');
    var openLink = document.getElementById('ddImgOpen');
    if (x.proof_path) {
      loadProofImage(frame, openLink, '/api/collection/deposits/' + x.id + '/proof');
    } else {
      if (frame._objUrl) { URL.revokeObjectURL(frame._objUrl); frame._objUrl = null; }
      frame.classList.add('is-empty');
      frame.innerHTML = _proofEmptyState('Setoran ini tidak menyertakan foto bukti.');
      if (openLink) openLink.style.display = 'none';
    }
    document.getElementById('depDetailModal').classList.add('open');
  }
  function closeDepositDetail() {
    document.getElementById('depDetailModal').classList.remove('open');
    var frame = document.getElementById('ddImgFrame');
    if (frame && frame._objUrl) { URL.revokeObjectURL(frame._objUrl); frame._objUrl = null; }
  }
  async function verifyDeposit(id, fromDetail) {
    var ok = await collConfirm({
      title: 'Verifikasi Setoran',
      message: 'Verifikasi setoran ini? Cash di tangan kolektor akan berkurang otomatis.',
      okText: 'Verifikasi'
    });
    if (!ok) return;
    var d = await App.api('/collection/deposits/' + id + '/verify', { method: 'POST', body: '{}' });
    if (d && d.success) {
      App.showToast(d.message || 'Terverifikasi.', 'success');
      if (fromDetail) closeDepositDetail();
      loadDeposits(); refreshDepBadge(); loadStats();
    } else App.showToast((d && d.message) || 'Gagal verifikasi.', 'error');
  }
  async function rejectDeposit(id, fromDetail) {
    var res = await collConfirm({
      variant: 'warn',
      title: 'Tolak Setoran',
      message: 'Setoran akan ditandai ditolak. Tambahkan alasan bila perlu.',
      okText: 'Tolak Setoran',
      input: true,
      inputLabel: 'Alasan penolakan',
      inputPlaceholder: 'mis. nominal tidak sesuai…'
    });
    if (res === null) return;
    var reason = (res === true) ? '' : res;
    var d = await App.api('/collection/deposits/' + id + '/reject', { method: 'POST', body: JSON.stringify({ reason: reason }) });
    if (d && d.success) {
      App.showToast(d.message || 'Ditolak.', 'success');
      if (fromDetail) closeDepositDetail();
      loadDeposits(); refreshDepBadge();
    } else App.showToast((d && d.message) || 'Gagal menolak.', 'error');
  }

  // ── helpers ───────────────────────────────────────────────────────
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    if (!p[0]) return '?';
    return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function show(id) { var e = document.getElementById(id); if (e) e.classList.add('show'); }
  function closeModal(id) { var e = document.getElementById(id); if (e) e.classList.remove('show'); }

  // expose for inline handlers
  window.CollAdmin = { toggleRow: toggleRow, editCollector: editCollector, verifyDeposit: verifyDeposit, rejectDeposit: rejectDeposit, openProof: openProof, openReassign: openReassign, raPick: raPick, openDepositDetail: openDepositDetail, payCommission: payCommission };
  window.toggleAll = toggleAll;
  window.openAssign = openAssign;
  window.submitAssign = submitAssign;
  window.openGenerate = openGenerate;
  window.submitGenerate = submitGenerate;
  window.autoAssign = autoAssign;
  window.loadAssignments = loadAssignments;
  window.debouncedFilter = debouncedFilter;
  window.changePage = changePage;
  window.closeModal = closeModal;
  window.openCollectors = openCollectors;
  window.onCommTypeChange = onCommTypeChange;
  window.submitCollector = submitCollector;
  window.loadDeposits = loadDeposits;
  window.loadReport = loadReport;
  window.printReport = printReport;
  window.exportReport = exportReport;
  window.switchTab = switchTab;
  window.statFilter = statFilter;
  window.closeProofModal = closeProofModal;
  window.collConfirmOk = collConfirmOk;
  window.collConfirmCancel = collConfirmCancel;
  window.loadMap = loadMap;
  window.closeReassign = closeReassign;
  window.submitReassign = submitReassign;
  window.closeDepositDetail = closeDepositDetail;

  // init
  document.addEventListener('DOMContentLoaded', function () {
    loadStats();
    loadCollectors();
    loadAssignments(1);
    refreshDepBadge();
    var se = document.getElementById('fSearch');
    if (se) se.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadAssignments(1); });
  });
})();
