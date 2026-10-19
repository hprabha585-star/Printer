/* Customer page: build order → pay → live status. Plain JavaScript, no frameworks. */
(function () {
  'use strict';
  var P = window.PrintPricing;
  var $ = function (id) { return document.getElementById(id); };
  var S = null;            // public settings
  var rates = null;        // paise rates
  var cart = [];           // [{ uid, up: {upload_id,file_name,pages,coverage,micro_verdict,notice}, mode, start, end, copies, note }]
  var editing = null;      // item being edited (copy) + index
  var order = null;        // { token, key }
  var pollTimer = null;
  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rs(paise) { return '₹' + P.formatRupees(paise); }
  function show(el, on) { (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on); }
  function msg(id, text) { var el = $(id); el.textContent = text || ''; show(el, !!text); }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Please try again.'); e.code = j.code; throw e; }
          return j;
        });
      }, function () { throw new Error('No internet connection. Please check and try again.'); });
  }
  function step(n) {
    for (var i = 1; i <= 3; i++) {
      show('step' + i, i === n);
      $('st' + i).className = i === n ? 'on' : (i < n ? 'done' : '');
    }
    window.scrollTo(0, 0);
  }

  /* ---------- start ---------- */
  api('GET', '/api/settings').then(function (s) {
    S = s; rates = P.ratesFromSettings(s);
    $('shopName').textContent = s.shop_name; document.title = 'Print at ' + s.shop_name;
    $('rateLine').innerHTML = 'Per page: B&amp;W <span class="mono">' + rs(rates.bw) + '</span> · part colour <span class="mono">' + rs(rates.partial) +
      '</span> · full colour <span class="mono">' + rs(rates.full) + '</span>';
    var q = new URLSearchParams(location.search);
    if (q.get('order') && q.get('k')) { order = { token: q.get('order'), key: q.get('k') }; refreshOrder(true); return; }
    if (!s.accepting_orders) { show('closed', true); $('pickLabel').classList.add('hidden'); }
    cart = load('px_cart') || [];
    renderCart();
  }).catch(function (e) { msg('fileErr', e.message); });

  /* ---------- step 1: files ---------- */
  $('fileInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    msg('fileErr', '');
    var ext = (f.name.split('.').pop() || '').toLowerCase();
    if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'txt', 'rtf'].indexOf(ext) >= 0) {
      return msg('fileErr', 'Word, PowerPoint and Excel files must be saved as PDF first: open the file → File → Save as (or Print) → PDF. Then add the PDF here.');
    }
    if (['pdf', 'jpg', 'jpeg', 'png'].indexOf(ext) < 0) return msg('fileErr', 'Only PDF, JPG and PNG files are accepted.');
    if (f.size > S.max_upload_mb * 1048576) return msg('fileErr', 'This file is too big. The limit is ' + S.max_upload_mb + ' MB.');
    upload(f);
  });

  function upload(f) {
    var fd = new FormData(); fd.append('file', f);
    var xhr = new XMLHttpRequest();
    show('uploading', true); show('pickLabel', false);
    $('upMsg').textContent = 'Uploading ' + f.name + '…'; $('upBar').style.width = '0';
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        $('upBar').style.width = Math.round(100 * e.loaded / e.total) + '%';
        if (e.loaded >= e.total) $('upMsg').textContent = 'Checking pages and colours…';
      }
    };
    xhr.onload = function () {
      show('uploading', false); show('pickLabel', true);
      var j = {}; try { j = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status !== 200) return msg('fileErr', j.error || 'Upload failed. Please try again.');
      openEditor({ uid: Date.now() + Math.random(), up: j, mode: 'bw', start: 1, end: j.pages, copies: 1, note: '' }, -1);
    };
    xhr.onerror = function () { show('uploading', false); show('pickLabel', true); msg('fileErr', 'Upload failed. Check your internet connection.'); };
    xhr.open('POST', '/api/analyse'); xhr.send(fd);
  }

  function openEditor(item, index) {
    editing = { item: JSON.parse(JSON.stringify(item)), index: index };
    var it = editing.item;
    $('edTitle').textContent = index >= 0 ? 'Edit options' : 'Print options';
    $('edName').textContent = it.up.file_name;
    $('edPages').textContent = it.up.pages + (it.up.pages === 1 ? ' page' : ' pages') + ' · ' + it.up.kind.toUpperCase();
    msg('edNotice', it.up.notice);
    $('edStart').max = $('edEnd').max = it.up.pages;
    $('edStart').value = it.start; $('edEnd').value = it.end; $('edCopies').value = it.copies; $('edNote').value = it.note || '';
    $('edSave').textContent = index >= 0 ? 'Save changes' : 'Add to order';
    setMode(it.mode);
    show('editor', true);
    $('editor').scrollIntoView({ block: 'start' });
  }

  function setMode(m) {
    editing.item.mode = m;
    Array.prototype.forEach.call($('edMode').children, function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === m); });
    updateEditorPrice();
  }
  $('edMode').addEventListener('click', function (e) { var m = e.target.getAttribute('data-mode'); if (m) setMode(m); });

  function clampInt(el, min, max, fallback) {
    var v = parseInt(el.value, 10);
    if (isNaN(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }
  function readEditor() {
    var it = editing.item, n = it.up.pages;
    it.start = clampInt($('edStart'), 1, n, 1);
    it.end = clampInt($('edEnd'), 1, n, n);
    if (it.end < it.start) it.end = it.start;
    it.copies = clampInt($('edCopies'), 1, 99, 1);
    it.note = $('edNote').value.trim().slice(0, 300);
    return it;
  }
  function priceOf(it) { return P.priceFile({ coverage: it.up.coverage, start: it.start, end: it.end, copies: it.copies, mode: it.mode }, rates); }
  function updateEditorPrice() {
    var it = readEditor(); var p = priceOf(it);
    $('edPrice').textContent = rs(p.amount);
    $('edBreak').textContent = P.describe(p);
    ['edStart', 'edEnd', 'edCopies'].forEach(function (id) {
      var el = $(id), v = parseInt(el.value, 10), max = id === 'edCopies' ? 99 : it.up.pages;
      el.classList.toggle('bad', el.value !== '' && (isNaN(v) || v < 1 || v > max));
    });
  }
  ['edStart', 'edEnd', 'edCopies'].forEach(function (id) {
    $(id).addEventListener('input', updateEditorPrice);
    $(id).addEventListener('blur', function () { var it = readEditor(); $('edStart').value = it.start; $('edEnd').value = it.end; $('edCopies').value = it.copies; updateEditorPrice(); });
  });
  $('edCancel').addEventListener('click', function () { editing = null; show('editor', false); });
  $('edSave').addEventListener('click', function () {
    var it = readEditor();
    if (editing.index >= 0) cart[editing.index] = it; else cart.push(it);
    editing = null; show('editor', false); renderCart();
  });

  function renderCart() {
    store('px_cart', cart);
    var box = $('cart'), total = 0;
    if (!cart.length) { box.innerHTML = '<p class="hint">No files yet. Add a PDF, JPG or PNG.</p>'; }
    else {
      box.innerHTML = cart.map(function (it, i) {
        var p = priceOf(it); total += p.amount;
        return '<div class="line"><div class="top"><span class="name">' + esc(it.up.file_name) + '</span><span class="price">' + rs(p.amount) + '</span></div>' +
          '<div class="meta">' + (it.mode === 'color' ? 'Colour' : 'B&amp;W') + ' · pages ' + it.start + '–' + it.end + ' · ' + it.copies + (it.copies > 1 ? ' copies' : ' copy') + '</div>' +
          '<div class="meta mono">' + esc(P.describe(p)) + '</div>' +
          (it.note ? '<div class="meta">Note: ' + esc(it.note) + '</div>' : '') +
          (it.up.micro_verdict === 'suspect' ? '<div class="meta" style="color:var(--warn)">The shop will check this file before printing.</div>' : '') +
          '<div class="acts"><button class="btn-ghost btn-small" data-act="edit" data-i="' + i + '">Edit</button>' +
          '<button class="btn-ghost btn-small" data-act="again" data-i="' + i + '">Add again</button>' +
          '<button class="btn-ghost btn-small" data-act="remove" data-i="' + i + '" style="color:var(--stamp);border-color:var(--stamp)">Remove</button></div></div>';
      }).join('');
    }
    $('cartTotal').textContent = rs(total);
    $('toPay').disabled = !cart.length || total <= 0;
  }
  $('cart').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var i = +b.getAttribute('data-i'), act = b.getAttribute('data-act');
    if (act === 'edit') openEditor(cart[i], i);
    if (act === 'again') openEditor(Object.assign({}, cart[i], { uid: Date.now() + Math.random() }), -1);
    if (act === 'remove' && confirm('Remove ' + cart[i].up.file_name + '?')) { cart.splice(i, 1); renderCart(); }
  });

  $('toPay').addEventListener('click', function () {
    msg('orderErr', '');
    var btn = this; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Creating order…';
    api('POST', '/api/orders', { items: cart.map(function (it) { return { upload_id: it.up.upload_id, mode: it.mode, start: it.start, end: it.end, copies: it.copies, note: it.note }; }) })
      .then(function (r) {
        order = { token: r.token, key: r.key };
        history.replaceState(null, '', '/?order=' + encodeURIComponent(r.token) + '&k=' + encodeURIComponent(r.key));
        refreshOrder(true);
      })
      .catch(function (e) { msg('orderErr', e.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Continue to payment →'; });
  });

  /* ---------- step 2: payment ---------- */
  function showPayment(o) {
    step(2);
    $('payToken').textContent = o.token;
    $('payAmount').textContent = $('payAmount2').textContent = rs(o.total_paise);
    $('payNote').textContent = o.token;
    var gateway = S.payment_mode === 'gateway';
    show('payUtr', !gateway); show('payGateway', gateway); show('cashBox', S.allow_cash);
    if (!gateway) {
      var amt = P.formatRupees(o.total_paise);
      var qs = 'pa=' + encodeURIComponent(S.upi_id) + '&pn=' + encodeURIComponent(S.payee_name || S.shop_name) +
        '&am=' + amt + '&cu=INR&tn=' + encodeURIComponent(o.token);
      var link = 'upi://pay?' + qs;
      $('upiAny').href = link;
      $('upiGpay').href = 'tez://upi/pay?' + qs;
      $('upiPhonepe').href = 'phonepe://pay?' + qs;
      $('upiPaytm').href = 'paytmmp://pay?' + qs;
      show('mobileApps', isMobile); show('desktopHint', !isMobile);
      $('upiId').textContent = S.upi_id || '(the shop has not set a UPI ID yet)';
      try { var qr = qrcode(0, 'M'); qr.addData(link); qr.make(); $('payQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { $('payQr').innerHTML = ''; }
    }
  }
  $('copyUpi').addEventListener('click', function () {
    var t = S.upi_id, b = this;
    var done = function () { b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = 'Copy'; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, function () { prompt('Copy the UPI ID:', t); });
    else prompt('Copy the UPI ID:', t);
  });
  $('utr').addEventListener('input', function () {
    var v = this.value.replace(/\D/g, '').slice(0, 12);
    if (v !== this.value) this.value = v;
    var ok = /^\d{12}$/.test(v);
    this.classList.toggle('good', ok); this.classList.toggle('bad', v.length > 0 && !ok);
    $('utrHint').textContent = ok ? 'Looks right ✓' : (v.length ? v.length + ' of 12 digits' : 'Numbers only — exactly 12 digits.');
    $('sendUtr').disabled = !ok;
  });
  $('sendUtr').addEventListener('click', function () {
    var b = this; b.disabled = true; msg('payErr', '');
    api('POST', '/api/orders/' + encodeURIComponent(order.token) + '/utr', { k: order.key, utr: $('utr').value })
      .then(function () { store('px_cart', null); cart = []; refreshOrder(true); })
      .catch(function (e) { msg('payErr', e.message); b.disabled = false; });
  });
  $('payCash').addEventListener('click', function () {
    var b = this; b.disabled = true; msg('payErr', '');
    api('POST', '/api/orders/' + encodeURIComponent(order.token) + '/cash', { k: order.key })
      .then(function () { store('px_cart', null); cart = []; refreshOrder(true); })
      .catch(function (e) { msg('payErr', e.message); })
      .then(function () { b.disabled = false; });
  });
  $('gatewayBtn').addEventListener('click', function () {
    var b = this; b.disabled = true; msg('payErr', '');
    api('POST', '/api/orders/' + encodeURIComponent(order.token) + '/gateway', { k: order.key })
      .then(function (r) { if (r.checkout && r.checkout.url) location.href = r.checkout.url; })
      .catch(function (e) { msg('payErr', e.message); b.disabled = false; });
  });
  $('backToCart').addEventListener('click', function (e) {
    e.preventDefault();
    history.replaceState(null, '', '/'); order = null; clearTimeout(pollTimer);
    cart = load('px_cart') || []; renderCart(); step(1);
  });

  /* ---------- step 3: status ---------- */
  var STATE = {
    waiting_payment: ['Waiting for payment', 'st-wait'], waiting_cash: ['Pay cash at counter', 'st-wait'],
    verifying_upi: ['Shop checking UPI', 'st-wait'], checking_file: ['File being checked', 'st-wait'],
    queued: ['In queue', 'st-go'], printing: ['Printing', 'st-go'], completed: ['Printed', 'st-ok'],
    failed: ['Problem — ask shop', 'st-bad'], cancelled: ['Cancelled', 'st-off'],
  };
  var HELP = {
    waiting_payment: 'Waiting for your payment.',
    waiting_cash: 'Please pay at the counter. Printing starts once the shop confirms.',
    verifying_upi: 'The shop is checking that your UPI payment arrived. This usually takes a minute.',
    checking_file: 'A file has very small print, so the shop is taking a quick look before printing.',
    queued: 'Paid ✓ Your files are in the print queue.', printing: 'Printing now — collect at the printer.',
    completed: 'All done! Please collect your prints.', failed: 'Something went wrong at the printer. Please tell the shop — show this page.',
    cancelled: 'This order was cancelled.',
  };
  function refreshOrder(first) {
    clearTimeout(pollTimer);
    api('GET', '/api/orders/' + encodeURIComponent(order.token) + '?k=' + encodeURIComponent(order.key)).then(function (o) {
      if (o.payment_status === 'unpaid' || o.payment_status === 'gateway_pending') {
        if (first || $('step2').classList.contains('hidden')) showPayment(o);
        if (o.payment_status === 'gateway_pending') pollTimer = setTimeout(refreshOrder, 4000);
        return;
      }
      renderStatus(o);
      if (o.overall !== 'completed' && o.overall !== 'cancelled') pollTimer = setTimeout(refreshOrder, 4000);
    }).catch(function (e) {
      if (first) { step(3); $('stOverall').textContent = 'Not found'; $('stHelp').textContent = e.message; }
      else pollTimer = setTimeout(refreshOrder, 8000);
    });
  }
  function renderStatus(o) {
    step(3);
    $('stToken').textContent = o.token;
    var s = STATE[o.overall] || [o.overall, 'st-go'];
    $('stOverall').textContent = s[0];
    $('stOverall').className = 'stamp big ' + (o.overall === 'completed' ? 'ok' : (o.overall.indexOf('wait') === 0 || o.overall === 'verifying_upi' || o.overall === 'checking_file' ? 'warn' : ''));
    $('stHelp').textContent = HELP[o.overall] || '';
    if (o.refund_if_paid) $('stHelp').textContent += ' If you already paid, the shop will refund you.';
    $('stFiles').innerHTML = o.files.map(function (f) {
      var st = STATE[f.state] || [f.state, 'st-go'];
      return '<div class="line"><div class="top"><span class="name">' + esc(f.file_name) + '</span><span class="st ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
        '<div class="meta mono">' + esc(f.ticket) + ' · ' + esc(f.breakdown) + ' · ' + rs(f.amount_paise) + '</div></div>';
    }).join('');
    $('stTotal').textContent = rs(o.total_paise);
    $('stPay').textContent = o.payment_method === 'cash' ? 'Cash' : (o.utr ? 'UPI · UTR ' + o.utr : (o.payment_method === 'gateway' ? 'Paid online' : ''));
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && order && !$('step3').classList.contains('hidden')) refreshOrder(); });
})();
