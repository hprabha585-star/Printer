/* Owner dashboard. Plain JavaScript. The session token lives in localStorage. */
(function () {
  'use strict';
  var P = window.PrintPricing;
  var $ = function (id) { return document.getElementById(id); };
  var token = null, me = null, refreshTimer = null, printers = [], currentTab = 'today', forceSetup = false;
  try { token = localStorage.getItem('px_owner'); } catch (e) {}

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rs(p) { return '₹' + P.formatRupees(p); }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function note(id, text, kind) { var el = $(id); el.textContent = text || ''; el.className = 'notice ' + (kind || 'err') + (text ? '' : ' hidden'); }
  function saveToken(t) { token = t; try { if (t) localStorage.setItem('px_owner', t); else localStorage.removeItem('px_owner'); } catch (e) {} }
  function when(d) {
    if (!d) return '';
    var t = new Date(d);
    return t.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function api(method, url, body) {
    var h = { 'X-Owner-Key': token || '' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }).then(function (r) {
      if (r.status === 401 && url.indexOf('/login') < 0) { saveToken(null); showLogin(); throw new Error('Please sign in again.'); }
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; });
    });
  }

  /* ---------- login / setup ---------- */
  function showLogin() { clearInterval(refreshTimer); show('dash', false); show('setup', false); show('login', true); }
  var useMaster = false;
  $('toggleMaster').addEventListener('click', function (e) {
    e.preventDefault(); useMaster = !useMaster;
    show('userFields', !useMaster); show('masterFields', useMaster);
    this.textContent = useMaster ? 'Sign in with username and password instead' : 'First time / forgot password? Use the master key';
  });
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); note('loginErr', '');
    var body = useMaster ? { master_key: $('lMaster').value } : { username: $('lUser').value, password: $('lPass').value };
    api('POST', '/api/owner/login', body).then(function (r) {
      saveToken(r.token); $('lPass').value = $('lMaster').value = '';
      if (r.needs_setup) { forceSetup = true; openSetup(); } else start();
    }).catch(function (err) { note('loginErr', err.message); });
  });
  function openSetup() {
    show('login', false); show('dash', false); show('setup', true);
    $('setupTitle').textContent = forceSetup ? 'Create your login' : 'Change login';
    show('setupCancel', !forceSetup);
    $('sUser').value = (me && me.username) || '';
  }
  $('setupCancel').addEventListener('click', function () { show('setup', false); show('dash', true); });
  $('setupForm').addEventListener('submit', function (e) {
    e.preventDefault(); note('setupErr', '');
    if ($('sPass').value !== $('sPass2').value) return note('setupErr', 'The two passwords are different.');
    api('POST', '/api/owner/credentials', { username: $('sUser').value, password: $('sPass').value }).then(function (r) {
      saveToken(r.token); $('sPass').value = $('sPass2').value = ''; forceSetup = false; start();
    }).catch(function (err) { note('setupErr', err.message); });
  });
  $('changeLogin').addEventListener('click', function () { forceSetup = false; openSetup(); });
  $('logout').addEventListener('click', function () { saveToken(null); showLogin(); });

  function start() {
    api('GET', '/api/owner/me').then(function (m) {
      me = m;
      if (m.needs_setup) { forceSetup = true; return openSetup(); }
      show('login', false); show('setup', false); show('dash', true);
      $('meUser').textContent = m.username;
      loadSettings(); loadPrinters(); refresh();
      clearInterval(refreshTimer); refreshTimer = setInterval(refresh, 8000);
    }).catch(function () { showLogin(); });
  }

  /* ---------- tabs ---------- */
  function setTab(t) {
    currentTab = t;
    Array.prototype.forEach.call($('tabs').children, function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); });
    ['today', 'files', 'printers', 'settings', 'qr'].forEach(function (x) { show('tab-' + x, x === t); });
    if (t === 'qr') drawShopQr();
    refresh();
  }
  $('tabs').addEventListener('click', function (e) { var t = e.target.getAttribute('data-tab'); if (t) setTab(t); });
  document.addEventListener('click', function (e) { var t = e.target.getAttribute && e.target.getAttribute('data-tab-link'); if (t) setTab(t); });

  /* ---------- periodic refresh ---------- */
  function refresh() {
    if (!token || $('dash').classList.contains('hidden')) return;
    if (currentTab === 'today') { loadStats(); loadAttention(); loadJobs(8, 'recentShort'); }
    if (currentTab === 'files') loadJobs(150, 'jobsTable');
    if (currentTab === 'printers') loadComputers();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });

  function loadStats() {
    api('GET', '/api/owner/stats').then(function (s) {
      $('cToday').textContent = rs(s.today.total);
      $('cTodaySplit').textContent = 'UPI ' + rs(s.today.upi + s.today.gateway) + ' · Cash ' + rs(s.today.cash);
      $('cMonth').textContent = rs(s.month.total);
      $('cMonthSplit').textContent = 'UPI ' + rs(s.month.upi + s.month.gateway) + ' · Cash ' + rs(s.month.cash);
      $('cPrinted').textContent = s.printed_today;
      $('cQueue').textContent = s.queue;
    }).catch(function () {});
  }

  function loadAttention() {
    api('GET', '/api/owner/attention').then(function (a) {
      $('warnings').innerHTML = a.warnings.map(function (w) { return '<div class="notice warn">' + esc(w) + '</div>'; }).join('');
      var html = '';
      a.payments.forEach(function (o) {
        var cash = o.payment_status === 'pending_cash';
        html += '<div class="att"><div class="top"><b class="mono">' + esc(o.token) + '</b><span class="price" style="font-size:1.3rem;font-weight:700">' + rs(o.total_paise) + '</span></div>' +
          '<div class="hint">' + (cash ? 'Customer will pay <b>CASH</b> at the counter' : 'Check your UPI app for this payment · UTR <b class="mono">' + esc(o.utr) + '</b>') +
          ' · ' + o.files + (o.files > 1 ? ' files' : ' file') + ' · ' + when(o.created_at) + '</div>' +
          '<div class="acts"><button class="btn-green" data-confirm="' + esc(o.token) + '">✓ Payment received — print</button>' +
          '<button class="btn-red" data-reject="' + esc(o.token) + '">✗ Not received — cancel</button></div></div>';
      });
      a.held.forEach(function (j) {
        html += '<div class="att held"><div class="top"><b>' + esc(j.file_name) + '</b><span class="mono small">' + esc(j.ticket) + '</span></div>' +
          '<div class="hint">Possible micro-printing (currency, cheques, certificates and IDs must not be copied). ' + esc(j.micro_reason || '') + '</div>' +
          '<div class="acts"><button class="btn-ghost" data-open="' + j.id + '">Open file</button>' +
          '<button class="btn-green" data-approve="' + j.id + '">Looks fine — print</button>' +
          '<button class="btn-red" data-refuse="' + j.id + '">Refuse to print</button></div></div>';
      });
      $('attention').innerHTML = html || '<p class="hint">Nothing right now ✓</p>';
    }).catch(function () {});
  }

  var STATUS = {
    awaiting_payment: ['Awaiting payment', 'st-wait'], queued: ['Queued', 'st-go'], held: ['Held for review', 'st-bad'],
    printing: ['Printing', 'st-go'], completed: ['Printed', 'st-ok'], failed: ['Failed', 'st-bad'], cancelled: ['Cancelled', 'st-off'],
  };
  var PAY = { unpaid: 'Unpaid', pending_cash: 'Cash pending', pending_verify: 'UPI to verify', gateway_pending: 'At gateway', paid: 'Paid', rejected: 'Rejected', refunded: 'Refunded', expired: 'Expired' };

  function loadJobs(limit, target) {
    api('GET', '/api/owner/jobs?limit=' + limit).then(function (rows) {
      if (target === 'recentShort') {
        $('recentShort').innerHTML = rows.length ? rows.map(function (j) {
          var st = STATUS[j.print_status] || [j.print_status, 'st-go'];
          return '<div class="line"><div class="top"><span class="name">' + esc(j.file_name) + '</span><span class="st ' + st[1] + '">' + st[0] + (j.stuck ? ' (stuck)' : '') + '</span></div>' +
            '<div class="meta mono">' + esc(j.ticket) + ' · ' + rs(j.amount_paise) + ' · ' + esc(PAY[j.payment_status] || j.payment_status) +
            (j.printer_label ? ' · ' + esc(j.printer_label) + ' / ' + esc(j.computer_name) : '') + '</div></div>';
        }).join('') : '<p class="hint">No files yet.</p>';
        return;
      }
      var head = '<thead><tr><th>Ticket</th><th>File</th><th>Pages</th><th>Amount</th><th>Payment</th><th>Print</th><th>Printer / PC</th><th></th></tr></thead>';
      $('jobsTable').innerHTML = head + '<tbody>' + rows.map(function (j) {
        var st = STATUS[j.print_status] || [j.print_status, 'st-go'];
        var b = P.describe({ pages: j.page_end - j.page_start + 1, bw: j.pages_bw, partial: j.pages_partial, full: j.pages_full, copies: j.copies });
        var acts = '';
        if (!j.file_gone) acts += '<button class="btn-ghost btn-small" data-open="' + j.id + '">Open</button>';
        if (j.print_status === 'failed' || j.stuck) acts += '<button class="btn-small" data-retry="' + j.id + '">Retry</button>';
        if (j.print_status === 'held') acts += '<button class="btn-green btn-small" data-approve="' + j.id + '">Print</button><button class="btn-red btn-small" data-refuse="' + j.id + '">Refuse</button>';
        return '<tr>' +
          '<td data-l="Ticket" class="mono">' + esc(j.ticket) + '<div class="sub">' + when(j.created_at) + '</div></td>' +
          '<td data-l="File">' + esc(j.file_name) + '<div class="sub">' + esc(j.file_kind.toUpperCase()) + (j.note ? ' · Note: ' + esc(j.note) : '') + '</div></td>' +
          '<td data-l="Pages"><span class="mono">' + j.page_start + '–' + j.page_end + '</span> ' + (j.color_mode === 'color' ? 'Colour' : 'B&amp;W') + '<div class="sub mono">' + esc(b) + '</div></td>' +
          '<td data-l="Amount" class="price">' + rs(j.amount_paise) + '</td>' +
          '<td data-l="Payment">' + esc(PAY[j.payment_status] || j.payment_status) + '<div class="sub mono">' + esc(j.payment_method ? j.payment_method.toUpperCase() : '') + (j.utr ? ' · ' + esc(j.utr) : '') + '</div>' +
            (j.refund_if_paid ? '<div class="refund">REFUND IF PAID</div>' : '') + '</td>' +
          '<td data-l="Print"><span class="st ' + st[1] + '">' + st[0] + '</span>' + (j.stuck ? '<div class="refund">Stuck ' + j.printing_minutes + ' min</div>' : '') +
            (j.error ? '<div class="sub" style="color:var(--stamp)">' + esc(j.error) + '</div>' : '') + '</td>' +
          '<td data-l="Printer">' + esc(j.printer_label || '—') + '<div class="sub">' + esc(j.computer_name || '') + '</div></td>' +
          '<td data-l=""><div class="acts">' + acts + '</div></td></tr>';
      }).join('') + '</tbody>';
    }).catch(function () {});
  }

  /* ---------- actions (event delegation) ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button'); if (!b) return;
    var a;
    if ((a = b.getAttribute('data-confirm'))) act(b, 'POST', '/api/owner/orders/' + encodeURIComponent(a) + '/confirm', null);
    else if ((a = b.getAttribute('data-reject'))) { if (confirm('Cancel order ' + a + '? Files not yet printing will be cancelled.')) act(b, 'POST', '/api/owner/orders/' + encodeURIComponent(a) + '/reject', null); }
    else if ((a = b.getAttribute('data-approve'))) act(b, 'POST', '/api/owner/jobs/' + a + '/review', { approve: true });
    else if ((a = b.getAttribute('data-refuse'))) { if (confirm('Refuse to print this file? The customer will see it as cancelled.')) act(b, 'POST', '/api/owner/jobs/' + a + '/review', { approve: false }); }
    else if ((a = b.getAttribute('data-retry'))) { if (confirm('Print this file again? If it is still printing somewhere, it could print twice.')) act(b, 'POST', '/api/owner/jobs/' + a + '/retry', null); }
    else if ((a = b.getAttribute('data-open'))) openFile(a);
  });
  function act(btn, method, url, body) {
    btn.disabled = true;
    api(method, url, body === null ? {} : body).then(refresh).catch(function (err) { alert(err.message); }).then(function () { btn.disabled = false; });
  }
  function openFile(id) {
    var w = window.open('', '_blank'); // opened now so pop-up blockers allow it
    fetch('/api/owner/jobs/' + id + '/file', { headers: { 'X-Owner-Key': token } }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'Could not open the file'); });
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      if (w) w.location = url; else location.href = url;
    }).catch(function (err) { if (w) w.close(); alert(err.message); });
  }

  /* ---------- printers & computers ---------- */
  function loadPrinters() { api('GET', '/api/owner/printers').then(function (p) { printers = p; renderPrinters(); }); }
  function renderPrinters() {
    $('printerList').innerHTML = printers.map(function (p, i) {
      return '<div class="prow" data-i="' + i + '"><input type="text" value="' + esc(p.label) + '" data-f="label" maxlength="80" placeholder="e.g. Printer 1 - Colour">' +
        '<label class="check"><input type="checkbox" data-f="color_capable"' + (p.color_capable ? ' checked' : '') + '> Colour</label>' +
        '<label class="check"><input type="checkbox" data-f="enabled"' + (p.enabled ? ' checked' : '') + '> On</label>' +
        '<button class="btn-ghost btn-small" data-del="' + i + '" title="Remove">✕</button></div>';
    }).join('');
  }
  $('printerList').addEventListener('input', function (e) {
    var row = e.target.closest('.prow'); if (!row) return;
    var p = printers[+row.getAttribute('data-i')], f = e.target.getAttribute('data-f');
    p[f] = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value;
  });
  $('printerList').addEventListener('click', function (e) {
    var d = e.target.getAttribute('data-del');
    if (d !== null && confirm('Remove this printer?')) { printers.splice(+d, 1); renderPrinters(); }
  });
  $('addPrinter').addEventListener('click', function () { printers.push({ label: 'Printer ' + (printers.length + 1), color_capable: 0, enabled: 1 }); renderPrinters(); });
  $('savePrinters').addEventListener('click', function () {
    api('PUT', '/api/owner/printers', printers).then(function (p) { printers = p; renderPrinters(); note('printerMsg', 'Saved ✓ The shop computers pick this up within a minute.', 'ok'); })
      .catch(function (err) { note('printerMsg', err.message); });
  });
  function loadComputers() {
    api('GET', '/api/owner/connectors').then(function (list) {
      $('computers').innerHTML = list.length ? list.map(function (c) {
        var ago = c.seconds_ago == null ? 'never' : c.seconds_ago < 90 ? c.seconds_ago + ' s ago' : Math.round(c.seconds_ago / 60) + ' min ago';
        return '<div class="pc"><div><span class="dot ' + (c.online ? 'on' : 'off') + '"></span><b>' + esc(c.computer_name) + '</b> · ' +
          (c.online ? 'online' : 'offline') + ' <span class="hint">(last seen ' + ago + ')</span></div>' +
          '<div class="hint">' + (c.printers.length ? c.printers.map(function (p) {
            return esc(p.local) + (p.label ? ' → <b>' + esc(p.label) + '</b>' : ' (not used)') + ' [' + esc(p.status || '?') + ']';
          }).join('<br>') : 'No printers reported') + '</div></div>';
      }).join('') : '<p class="hint">No computer has connected yet. Install and start the Print Connector on the counter PC.</p>';
    }).catch(function () {});
  }

  /* ---------- settings ---------- */
  function loadSettings() {
    api('GET', '/api/owner/settings').then(function (s) {
      $('shopName').textContent = s.shop_name; $('qrShop').textContent = s.shop_name;
      $('fShop').value = s.shop_name; $('fAccepting').checked = s.accepting_orders;
      $('fBw').value = s.rate_bw; $('fPartial').value = s.rate_partial; $('fFull').value = s.rate_full;
      $('fThreshold').value = s.color_threshold; $('fUpi').value = s.upi_id; $('fPayee').value = s.payee_name;
      $('fMode').value = s.payment_mode_selected; $('fVerify').checked = s.verify_upi; $('fCash').checked = s.allow_cash;
      $('gatewayNote').textContent = s.gateway.configured ? 'Gateway: ' + s.gateway.label + '. ' + (s.gateway.note || '') : s.gateway.note;
    });
  }
  $('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('PUT', '/api/owner/settings', {
      shop_name: $('fShop').value, accepting_orders: $('fAccepting').checked, rate_bw: $('fBw').value, rate_partial: $('fPartial').value,
      rate_full: $('fFull').value, color_threshold: $('fThreshold').value, upi_id: $('fUpi').value, payee_name: $('fPayee').value,
      payment_mode: $('fMode').value, verify_upi: $('fVerify').checked, allow_cash: $('fCash').checked,
    }).then(function () { note('settingsMsg', 'Saved ✓', 'ok'); loadSettings(); }).catch(function (err) { note('settingsMsg', err.message); });
  });

  /* ---------- QR poster ---------- */
  function drawShopQr() {
    var url = location.origin + '/';
    $('qrUrl').textContent = url;
    var qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    $('shopQr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }
  $('printQr').addEventListener('click', function () { window.print(); });

  if (token) start(); else showLogin();
})();
