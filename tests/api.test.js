/*
 * End-to-end API tests against a REAL MySQL/MariaDB database.
 *   DB_USER=.. DB_PASSWORD=.. DB_NAME=printshop_test node tests/api.test.js
 * WARNING: drops and recreates all tables in DB_NAME.
 */
'use strict';
process.env.NODE_ENV = 'test';
process.env.OWNER_MASTER_KEY = process.env.OWNER_MASTER_KEY || 'test-master-key-123';
process.env.PAYMENT_GATEWAY = 'mock';
process.env.GATEWAY_WEBHOOK_SECRET = 'whsec_test';
process.env.ANALYSE_RATE_LIMIT = '1000';
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require('path').join(require('os').tmpdir(), 'printshop-test-' + process.pid);

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { runCleanup } = require('../src/cleanup');
const mockGateway = require('../src/payments/providers/mock');

const FIX = path.join(__dirname, 'fixtures', 'out');
let BASE, server, ownerKey;
const results = [];

async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log('PASS', name); }
  catch (e) { results.push([false, name]); console.log('FAIL', name, '\n   ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e); }
}

async function call(method, url, body, headers = {}) {
  const h = { ...headers };
  if (body !== undefined && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  return { status: r.status, body: json, headers: r.headers };
}
const owner = (m, u, b) => call(m, '/api/owner' + u, b, { 'X-Owner-Key': ownerKey });
const conn = (m, u, b) => call(m, '/api/connector' + u, b, { 'X-Owner-Key': ownerKey });
async function analyse(file, asName) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(FIX, file))]), asName || file);
  return call('POST', '/api/analyse', fd);
}
async function order(items) { return call('POST', '/api/orders', { items }); }
async function status(o) { return (await call('GET', `/api/orders/${o.token}?k=${o.key}`)).body; }
let utrCounter = 100000000000 + Math.floor(Math.random() * 1e9);
const newUtr = () => String(++utrCounter);

(async () => {
  /* ---------- migration of an OLD database ---------- */
  await test('migrate: an older database is upgraded in place without losing data', async () => {
    const tables = await db.q('SHOW TABLES');
    for (const t of tables) await db.q(`DROP TABLE \`${Object.values(t)[0]}\``);
    // simulate "version 0": a few tables with only some columns + data
    await db.q("CREATE TABLE settings (id TINYINT PRIMARY KEY, shop_name VARCHAR(120) NOT NULL DEFAULT 'x', rate_bw DECIMAL(8,2) NOT NULL DEFAULT 1.00)");
    await db.q("INSERT INTO settings (id, shop_name, rate_bw) VALUES (1, 'Old Shop', 3.00)");
    await db.q("CREATE TABLE printers (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(80) NOT NULL)");
    await db.q("INSERT INTO printers (label) VALUES ('Old Printer')");
    await db.migrate();
    await db.migrate(); // idempotent
    const [s] = await db.q('SELECT * FROM settings WHERE id = 1');
    assert.strictEqual(s.shop_name, 'Old Shop');
    assert.strictEqual(Number(s.rate_bw), 3);
    assert.strictEqual(s.payment_mode, 'utr');
    assert.strictEqual(s.verify_upi, 1);
    const p = await db.q('SELECT * FROM printers');
    assert.deepStrictEqual(p.map((x) => x.label), ['Old Printer']); // not replaced by defaults
    assert.strictEqual(p[0].enabled, 1);
    // fresh install path: defaults
    await db.q('DELETE FROM printers');
    await db.q("UPDATE settings SET shop_name = 'Test Xerox', rate_bw = 2 WHERE id = 1");
    await db.migrate();
    assert.strictEqual((await db.q('SELECT COUNT(*) n FROM printers'))[0].n, 3);
  });

  const app = createApp();
  server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;

  /* ---------- public settings & login ---------- */
  await test('public settings never expose owner credentials', async () => {
    const r = await call('GET', '/api/settings');
    assert.strictEqual(r.status, 200);
    const keys = JSON.stringify(r.body);
    assert.ok(!/password|hash|owner_username|session/.test(keys), keys);
  });

  await test('owner login: master key first, then own credentials; old sessions revoked', async () => {
    let r = await call('POST', '/api/owner/login', { master_key: 'wrong' });
    assert.strictEqual(r.status, 401);
    r = await call('POST', '/api/owner/login', { username: 'x', password: 'y' });
    assert.strictEqual(r.status, 401);
    assert.match(r.body.error, /master key/);
    r = await call('POST', '/api/owner/login', { master_key: process.env.OWNER_MASTER_KEY });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.needs_setup, true);
    const first = r.body.token;
    r = await call('GET', '/api/owner/stats', undefined, { 'X-Owner-Key': first });
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/api/owner/credentials', { username: 'ravi', password: 'short' }, { 'X-Owner-Key': first });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/owner/credentials', { username: 'ravi', password: 'xerox-2024!' }, { 'X-Owner-Key': first });
    assert.strictEqual(r.status, 200);
    r = await call('GET', '/api/owner/stats', undefined, { 'X-Owner-Key': first });
    assert.strictEqual(r.status, 401, 'old session must stop working after credential change');
    r = await call('POST', '/api/owner/login', { username: 'ravi', password: 'wrong-pass' });
    assert.strictEqual(r.status, 401);
    r = await call('POST', '/api/owner/login', { username: 'RAVI', password: 'xerox-2024!' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.needs_setup, false);
    ownerKey = r.body.token;
    // master key keeps working as recovery
    r = await call('POST', '/api/owner/login', { master_key: process.env.OWNER_MASTER_KEY });
    assert.strictEqual(r.status, 200);
    // no key at all
    r = await call('GET', '/api/owner/stats');
    assert.strictEqual(r.status, 401);
  });

  await test('owner settings: validation and update', async () => {
    let r = await owner('PUT', '/settings', { upi_id: 'not a upi' });
    assert.strictEqual(r.status, 400);
    r = await owner('PUT', '/settings', { color_threshold: 0 });
    assert.strictEqual(r.status, 400);
    r = await owner('PUT', '/settings', { rate_bw: 2, rate_partial: 5, rate_full: 10, color_threshold: 25, upi_id: 'testxerox@okaxis', payee_name: 'Test Xerox', verify_upi: true, allow_cash: true, payment_mode: 'utr' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.upi_id, 'testxerox@okaxis');
    assert.ok(!('owner_password_hash' in r.body));
  });

  /* ---------- analysis via the API ---------- */
  const up = {};
  await test('analyse: PDF / JPG / PNG accepted with page count and colour', async () => {
    let r = await analyse('mixed.pdf');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.pages, 4);
    up.mixed = r.body;
    r = await analyse('photo.jpg'); assert.strictEqual(r.status, 200); up.photo = r.body;
    r = await analyse('text.pdf'); assert.strictEqual(r.status, 200); up.text = r.body;
    r = await analyse('micro_pdf_few.pdf'); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.micro_verdict, 'suspect'); assert.ok(r.body.notice); up.suspect = r.body;
    r = await analyse('micro_img_band.png'); assert.strictEqual(r.body.micro_verdict, 'suspect'); up.suspect2 = r.body;
  });

  await test('analyse: rejections give friendly JSON errors', async () => {
    const cases = [
      ['micro_pdf_blocked.pdf', null, 422, 'microtext_blocked'],
      ['encrypted.pdf', null, 422, 'encrypted'],
      ['corrupt.pdf', null, 422, 'corrupt'],
      ['really_png.pdf', null, 422, 'mismatch'],
      ['text.pdf', 'letter.docx', 415, 'office'],
      ['text.pdf', 'notes.txt', 415, 'office'],
      ['text.pdf', 'archive.zip', 415, 'type'],
      ['photo.jpg', 'photo.png', 422, 'mismatch'],
      ['too_many_pages.pdf', null, 422, 'too_many_pages'],
      ['oversized.png', null, 422, 'oversized'],
    ];
    for (const [f, as, st, code] of cases) {
      const r = await analyse(f, as);
      assert.strictEqual(r.status, st, `${f} as ${as}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, code, `${f}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.error && r.body.error.length > 10);
    }
    const r = await call('POST', '/api/analyse', new FormData());
    assert.strictEqual(r.status, 400);
    // rejected files are not left on disk
    const leftovers = fs.readdirSync(path.join(process.env.STORAGE_DIR, 'uploads')).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });

  /* ---------- pricing ---------- */
  await test('pricing: server recomputes from analysis, ignores browser numbers, stores audit trail', async () => {
    const r = await order([
      { upload_id: up.mixed.upload_id, mode: 'color', start: 1, end: 4, copies: 2, amount_paise: 1, price: 1 },
      { upload_id: up.mixed.upload_id, mode: 'bw', start: 2, end: 3, copies: 1 }, // same document twice
    ]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // colour: bw 2 + partial 5 + full 10 + bw 2 = 19 × 2 copies = 38; B&W pages 2-3 = 2 × 2 = 4  → 42
    assert.strictEqual(r.body.total_paise, 4200);
    const jobs = await db.q('SELECT * FROM jobs j JOIN orders o ON o.id = j.order_id WHERE o.token = ? ORDER BY j.id', [r.body.token]);
    assert.deepStrictEqual(jobs.map((j) => [j.ticket, j.pages_bw, j.pages_partial, j.pages_full, j.amount_paise]),
      [[`${r.body.token}-1`, 2, 1, 1, 3800], [`${r.body.token}-2`, 2, 0, 0, 400]]);
    assert.strictEqual(Number(jobs[0].rate_full), 10); assert.strictEqual(Number(jobs[0].color_threshold), 25);
    assert.match(r.body.token, /^PX-\d{4,6}$/);
    up.priceOrder = r.body;
  });

  await test('pricing: page range / copies validated against the real file', async () => {
    for (const bad of [{ start: 0 }, { end: 5 }, { start: 3, end: 2 }, { copies: 0 }, { copies: 100 }, { start: 'abc' }]) {
      const r = await order([{ upload_id: up.mixed.upload_id, mode: 'bw', start: 1, end: 4, copies: 1, ...bad }]);
      assert.strictEqual(r.status, 400, JSON.stringify(bad) + JSON.stringify(r.body));
    }
    let r = await order([{ upload_id: 'nope', mode: 'bw' }]);
    assert.strictEqual(r.status, 410);
    r = await order([]);
    assert.strictEqual(r.status, 400);
  });

  await test('pricing: threshold change re-classifies pages', async () => {
    await owner('PUT', '/settings', { color_threshold: 60 });
    const r = await order([{ upload_id: up.mixed.upload_id, mode: 'color', start: 3, end: 3, copies: 1 }]);
    assert.strictEqual(r.body.total_paise, 500); // 51% colour < 60% threshold → partial
    await owner('PUT', '/settings', { color_threshold: 25 });
  });

  /* ---------- UTR ---------- */
  await test('UTR: format rules (exactly 12 digits)', async () => {
    const o = up.priceOrder;
    for (const bad of ['12345678901', '1234567890123', 'T2401011234', '12345678901a', '', '1234 5678 9012']) {
      const r = await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr: bad });
      assert.strictEqual(r.status, 400, bad);
    }
    const r = await call('POST', `/api/orders/${o.token}/utr`, { k: 'wrongkey', utr: newUtr() });
    assert.strictEqual(r.status, 404);
  });

  let verifyOrder;
  await test('UTR with "I verify every payment" ON: waits for owner, then prints', async () => {
    await owner('PUT', '/settings', { verify_upi: true });
    const o = (await order([{ upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 3, copies: 1 }])).body;
    let s = await status(o);
    assert.strictEqual(s.overall, 'waiting_payment');
    const utr = newUtr();
    const r = await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.verify, true);
    s = await status(o);
    assert.strictEqual(s.overall, 'verifying_upi');
    const att = (await owner('GET', '/attention')).body;
    const item = att.payments.find((p) => p.token === o.token);
    assert.ok(item && item.utr === utr && item.total_paise === 600);
    // the same UTR can't be submitted twice for this order
    assert.strictEqual((await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr: newUtr() })).status, 409);
    assert.strictEqual((await owner('POST', `/orders/${o.token}/confirm`)).status, 200);
    s = await status(o);
    assert.strictEqual(s.overall, 'queued');
    verifyOrder = { ...o, utr };
  });

  await test('UTR: a UTR can back only ONE order', async () => {
    const o = (await order([{ upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 1 }])).body;
    const r = await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr: verifyOrder.utr });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'utr_used');
    assert.strictEqual((await status(o)).overall, 'waiting_payment');
  });

  let instantOrder;
  await test('UTR with verification OFF: valid UTR releases the order immediately', async () => {
    await owner('PUT', '/settings', { verify_upi: false });
    const o = (await order([{ upload_id: up.photo.upload_id, mode: 'color', copies: 1 }])).body;
    assert.strictEqual(o.total_paise, 1000);
    const r = await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr: newUtr() });
    assert.strictEqual(r.body.verify, false);
    assert.strictEqual((await status(o)).overall, 'queued');
    instantOrder = o;
    await owner('PUT', '/settings', { verify_upi: true });
  });

  /* ---------- cash / reject ---------- */
  let cashOrder;
  await test('cash: holds until owner confirms; counted as cash revenue', async () => {
    const o = (await order([{ upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 2, copies: 3 }])).body; // 2×2×3 = 12
    assert.strictEqual((await call('POST', `/api/orders/${o.token}/cash`, { k: o.key })).status, 200);
    let s = await status(o);
    assert.strictEqual(s.overall, 'waiting_cash');
    assert.strictEqual((await call('POST', `/api/orders/${o.token}/cash`, { k: o.key })).status, 409);
    await owner('POST', `/orders/${o.token}/confirm`);
    s = await status(o);
    assert.strictEqual(s.overall, 'queued'); assert.strictEqual(s.payment_method, 'cash');
    cashOrder = o;
  });

  await test('cash can be switched off by the owner', async () => {
    await owner('PUT', '/settings', { allow_cash: false });
    const o = (await order([{ upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 1 }])).body;
    assert.strictEqual((await call('POST', `/api/orders/${o.token}/cash`, { k: o.key })).status, 400);
    await owner('PUT', '/settings', { allow_cash: true });
  });

  await test('reject payment: cancels everything not yet printing, flags refund, excluded from revenue', async () => {
    const before = (await owner('GET', '/stats')).body;
    // the instant (verify-off) order is paid+queued: owner finds the UTR was fake
    assert.strictEqual((await owner('POST', `/orders/${instantOrder.token}/reject`)).status, 200);
    const s = await status(instantOrder);
    assert.strictEqual(s.overall, 'cancelled'); assert.strictEqual(s.refund_if_paid, true);
    const after = (await owner('GET', '/stats')).body;
    assert.strictEqual(before.today.total - after.today.total, 1000);
    const jobs = (await owner('GET', '/jobs?limit=50')).body.filter((j) => j.token === instantOrder.token);
    assert.ok(jobs.every((j) => j.print_status === 'cancelled' && j.refund_if_paid === 1));
    // a pending-UTR order rejected
    const o = (await order([{ upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 1 }])).body;
    await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr: newUtr() });
    await owner('POST', `/orders/${o.token}/reject`);
    assert.strictEqual((await status(o)).overall, 'cancelled');
    // cannot pay a rejected order afterwards
    assert.strictEqual((await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr: newUtr() })).status, 409);
    assert.strictEqual((await owner('POST', `/orders/${o.token}/confirm`)).status, 409);
  });

  /* ---------- held for review ---------- */
  let heldJobId;
  await test('suspect files are held after payment until the owner approves or refuses', async () => {
    const o = (await order([
      { upload_id: up.suspect.upload_id, mode: 'bw' },
      { upload_id: up.suspect2.upload_id, mode: 'bw' },
      { upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 1 },
    ])).body;
    await call('POST', `/api/orders/${o.token}/cash`, { k: o.key });
    await owner('POST', `/orders/${o.token}/confirm`);
    let s = await status(o);
    assert.deepStrictEqual(s.files.map((f) => f.state), ['checking_file', 'checking_file', 'queued']);
    assert.strictEqual(s.overall, 'checking_file');
    const att = (await owner('GET', '/attention')).body;
    const held = att.held.filter((h) => h.token === o.token);
    assert.strictEqual(held.length, 2);
    // the owner can open the file (served with nosniff)
    const f = await fetch(`${BASE}/api/owner/jobs/${held[0].id}/file`, { headers: { 'X-Owner-Key': ownerKey } });
    assert.strictEqual(f.status, 200);
    assert.strictEqual(f.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(f.headers.get('content-type'), 'application/pdf');
    assert.strictEqual((await owner('POST', `/jobs/${held[0].id}/review`, { approve: true })).status, 200);
    assert.strictEqual((await owner('POST', `/jobs/${held[1].id}/review`, { approve: false })).status, 200);
    assert.strictEqual((await owner('POST', `/jobs/${held[1].id}/review`, { approve: true })).status, 409);
    s = await status(o);
    assert.deepStrictEqual(s.files.map((f) => f.state), ['queued', 'cancelled', 'queued']);
    assert.strictEqual(s.refund_if_paid, true);
    heldJobId = held[0].id;
  });

  /* ---------- stats ---------- */
  await test('stats: revenue today/month split by UPI and cash, excluding cancelled', async () => {
    const st = (await owner('GET', '/stats')).body;
    // paid & not cancelled: verify order 6 (upi), cash 12, held order: suspect(1 page)2 + text 2 (cash) = 4
    assert.strictEqual(st.today.upi, 600);
    assert.strictEqual(st.today.cash, 1200 + 400);
    assert.strictEqual(st.today.total, 2200);
    assert.strictEqual(st.month.total, 2200);
    assert.ok(st.queue >= 4);
  });

  /* ---------- connector API ---------- */
  await test('connector: login with owner password, heartbeat, pending list', async () => {
    let r = await call('POST', '/api/connector/login', { password: 'nope' });
    assert.strictEqual(r.status, 401);
    r = await call('POST', '/api/connector/login', { password: 'xerox-2024!' });
    assert.strictEqual(r.status, 200);
    const ct = r.body.token;
    r = await call('POST', '/api/connector/heartbeat', { computer: 'COUNTER-PC', printers: [{ local: 'HP LaserJet', label: 'Printer 2 - B&W', status: 'ready' }] }, { 'X-Owner-Key': ct });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.printers.length, 3);
    r = await call('GET', '/api/connector/jobs', undefined, { 'X-Owner-Key': ct });
    assert.ok(r.body.length >= 4);
    const pcs = (await owner('GET', '/connectors')).body;
    assert.strictEqual(pcs[0].computer_name, 'COUNTER-PC'); assert.strictEqual(pcs[0].online, true);
    r = await call('GET', '/api/connector/jobs', undefined, { 'X-Owner-Key': 'garbage.token' });
    assert.strictEqual(r.status, 401);
  });

  await test('connector: colour routing, one job per printer, atomic claim, stale lock, complete', async () => {
    await db.q(`UPDATE jobs SET print_status = 'cancelled' WHERE print_status IN ('queued','printing')`);
    // fresh paid jobs: one colour (needs colour printer), two B&W
    await owner('PUT', '/settings', { verify_upi: false });
    const oc = (await order([{ upload_id: up.photo.upload_id, mode: 'color' }])).body;
    await call('POST', `/api/orders/${oc.token}/utr`, { k: oc.key, utr: newUtr() });
    const ob = (await order([{ upload_id: up.text.upload_id, mode: 'bw' }, { upload_id: up.text.upload_id, mode: 'bw', start: 2, end: 2 }])).body;
    await call('POST', `/api/orders/${ob.token}/utr`, { k: ob.key, utr: newUtr() });
    const pend = (await conn('GET', '/jobs')).body;
    const colourJob = pend.find((j) => j.needs_color);
    const [bw1, bw2] = pend.filter((j) => !j.needs_color);
    assert.ok(colourJob && bw1 && bw2);
    // a colour job can't go to a B&W printer
    let r = await conn('POST', `/jobs/${colourJob.id}/claim`, { printer_label: 'Printer 2 - B&W', computer: 'PC-A' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.reason, 'printer_not_color');
    // unknown/disabled printer
    r = await conn('POST', `/jobs/${colourJob.id}/claim`, { printer_label: 'Nope', computer: 'PC-A' });
    assert.strictEqual(r.body.reason, 'printer_unavailable');
    // two computers race for the same job: exactly one wins
    const race = await Promise.all([
      conn('POST', `/jobs/${bw1.id}/claim`, { printer_label: 'Printer 2 - B&W', computer: 'PC-A' }),
      conn('POST', `/jobs/${bw1.id}/claim`, { printer_label: 'Printer 3 - B&W', computer: 'PC-B' }),
      conn('POST', `/jobs/${bw1.id}/claim`, { printer_label: 'Printer 1 - Colour', computer: 'PC-C' }),
    ]);
    assert.strictEqual(race.filter((x) => x.body.claimed).length, 1, JSON.stringify(race.map((x) => x.body)));
    const winner = race.find((x) => x.body.claimed);
    const wLabel = (await db.q('SELECT printer_label, computer_name FROM jobs WHERE id = ?', [bw1.id]))[0];
    // the same printer can't take a second job (from any computer)
    r = await conn('POST', `/jobs/${bw2.id}/claim`, { printer_label: wLabel.printer_label, computer: 'PC-Z' });
    assert.strictEqual(r.body.reason, 'printer_busy');
    // stale lock: a job "printing" for > 15 min no longer blocks the printer, and is NOT re-queued
    await db.q('UPDATE jobs SET claimed_at = UTC_TIMESTAMP() - INTERVAL 16 MINUTE WHERE id = ?', [bw1.id]);
    r = await conn('POST', `/jobs/${bw2.id}/claim`, { printer_label: wLabel.printer_label, computer: 'PC-Z' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.job.monochrome, true);
    assert.strictEqual((await db.q('SELECT print_status FROM jobs WHERE id = ?', [bw1.id]))[0].print_status, 'printing');
    // download the file while printing
    const f = await fetch(`${BASE}/api/connector/jobs/${bw2.id}/file`, { headers: { 'X-Owner-Key': ownerKey } });
    assert.strictEqual(f.status, 200); assert.ok((await f.arrayBuffer()).byteLength > 500);
    // only the computer that claimed it may complete it
    r = await conn('POST', `/jobs/${bw2.id}/complete`, { ok: true, computer: 'PC-A' });
    assert.strictEqual(r.status, 409);
    r = await conn('POST', `/jobs/${bw2.id}/complete`, { ok: true, computer: 'PC-Z', printer_label: wLabel.printer_label });
    assert.strictEqual(r.status, 200);
    // the colour job goes to the colour printer, as colour
    r = await conn('POST', `/jobs/${colourJob.id}/claim`, { printer_label: 'Printer 1 - Colour', computer: 'PC-A' });
    assert.strictEqual(r.body.claimed, true); assert.strictEqual(r.body.job.monochrome, false);
    r = await conn('POST', `/jobs/${colourJob.id}/complete`, { ok: false, computer: 'PC-A', error: 'Paper jam' });
    // failed → owner retries → queued again
    let jobs = (await owner('GET', '/jobs?limit=20')).body;
    assert.strictEqual(jobs.find((j) => j.id === colourJob.id).print_status, 'failed');
    assert.strictEqual((await owner('POST', `/jobs/${colourJob.id}/retry`)).status, 200);
    // stuck job (printing > 10 min) shows as stuck and can be retried
    jobs = (await owner('GET', '/jobs?limit=20')).body;
    assert.strictEqual(jobs.find((j) => j.id === bw1.id).stuck, true);
    assert.strictEqual((await owner('POST', `/jobs/${bw1.id}/retry`)).status, 200);
    // a completed job can't be retried
    assert.strictEqual((await owner('POST', `/jobs/${bw2.id}/retry`)).status, 409);
    // printed today counter
    assert.ok((await owner('GET', '/stats')).body.printed_today >= 1);
    await owner('PUT', '/settings', { verify_upi: true });
  });

  await test('printers: rename keeps job history, duplicates rejected', async () => {
    let r = await owner('GET', '/printers');
    const list = r.body;
    r = await owner('PUT', '/printers', [...list, { label: list[0].label }]);
    assert.strictEqual(r.status, 400);
    list[0].label = 'Colour Printer (front)';
    r = await owner('PUT', '/printers', list);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body[0].label, 'Colour Printer (front)');
    const n = await db.q(`SELECT COUNT(*) n FROM jobs WHERE printer_label = 'Printer 1 - Colour'`);
    assert.strictEqual(n[0].n, 0);
    list[0].label = 'Printer 1 - Colour';
    await owner('PUT', '/printers', list);
  });

  /* ---------- gateway (mock sandbox adapter) ---------- */
  await test('gateway: webhook signature, amount check, idempotency, reconcile, refund', async () => {
    await owner('PUT', '/settings', { payment_mode: 'gateway' });
    assert.strictEqual((await call('GET', '/api/settings')).body.payment_mode, 'gateway');
    const o = (await order([{ upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 3 }])).body; // ₹6
    let r = await call('POST', `/api/orders/${o.token}/gateway`, { k: o.key });
    assert.strictEqual(r.status, 200); assert.ok(r.body.checkout.url);
    const [row] = await db.q('SELECT gateway_ref FROM orders WHERE token = ?', [o.token]);
    const ref = row.gateway_ref;
    const send = (evt, sig) => {
      const raw = JSON.stringify(evt);
      const s = sig || crypto.createHmac('sha256', 'whsec_test').update(raw).digest('hex');
      return fetch(`${BASE}/api/payments/webhook/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Signature': s }, body: raw })
        .then(async (x) => ({ status: x.status, body: await x.json() }));
    };
    // forged signature
    r = await send({ id: 'ev1', type: 'paid', ref, amount: 600 }, 'deadbeef');
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await status(o)).payment_status, 'gateway_pending');
    // browser "redirect" must not mark paid: there's no such route; status stays pending
    // wrong amount
    r = await send({ id: 'ev2', type: 'paid', ref, amount: 100 });
    assert.strictEqual(r.body.outcome, 'amount_mismatch');
    assert.strictEqual((await status(o)).payment_status, 'gateway_pending');
    // correct
    r = await send({ id: 'ev3', type: 'paid', ref, amount: 600 });
    assert.strictEqual(r.body.outcome, 'paid');
    let s = await status(o);
    assert.strictEqual(s.payment_status, 'paid'); assert.strictEqual(s.overall, 'queued');
    // replay of the same event, and a second distinct "paid" event
    r = await send({ id: 'ev3', type: 'paid', ref, amount: 600 });
    assert.strictEqual(r.body.outcome, 'duplicate');
    r = await send({ id: 'ev4', type: 'paid', ref, amount: 600 });
    assert.strictEqual(r.body.outcome, 'already_paid');
    // unknown order
    r = await send({ id: 'ev5', type: 'paid', ref: 'nope', amount: 600 });
    assert.strictEqual(r.body.outcome, 'unknown_order');
    // refund cancels what hasn't printed
    r = await send({ id: 'ev6', type: 'refunded', ref, amount: 600 });
    s = await status(o);
    assert.strictEqual(s.overall, 'cancelled');

    // failed then reconcile on poll (no webhook arrives)
    const o2 = (await order([{ upload_id: up.text.upload_id, mode: 'bw', start: 1, end: 1 }])).body;
    await call('POST', `/api/orders/${o2.token}/gateway`, { k: o2.key });
    const ref2 = (await db.q('SELECT gateway_ref FROM orders WHERE token = ?', [o2.token]))[0].gateway_ref;
    r = await send({ id: 'ev7', type: 'failed', ref: ref2, amount: 200 });
    assert.strictEqual((await status(o2)).payment_status, 'unpaid');
    await call('POST', `/api/orders/${o2.token}/gateway`, { k: o2.key });
    const ref3 = (await db.q('SELECT gateway_ref FROM orders WHERE token = ?', [o2.token]))[0].gateway_ref;
    mockGateway._set(ref3, 'paid', 200);
    s = await status(o2); // the poll reconciles with the gateway
    assert.strictEqual(s.payment_status, 'paid');
    // gateway revenue appears
    const st = (await owner('GET', '/stats')).body;
    assert.ok(st.today.gateway >= 200);
    await owner('PUT', '/settings', { payment_mode: 'utr' });
  });

  /* ---------- misc ---------- */
  await test('JSON errors everywhere and literal routes are not shadowed', async () => {
    let r = await call('GET', '/api/nope');
    assert.strictEqual(r.status, 404); assert.ok(r.body.error);
    r = await call('GET', '/api/orders/PX-0000?k=x');
    assert.strictEqual(r.status, 404); assert.ok(r.body.error);
    r = await call('POST', '/api/orders', '{bad json');
    assert.ok(r.status === 400 && r.body.error);
    r = await owner('GET', '/jobs/999999/file');
    assert.strictEqual(r.status, 404); assert.ok(r.body.error);
    r = await call('GET', '/owner');
    assert.strictEqual(r.status, 200); assert.ok(r.body._raw.includes('Owner dashboard'));
    r = await call('GET', '/vendor/qrcode.js');
    assert.strictEqual(r.status, 200);
    r = await call('GET', '/shared/pricing.js');
    assert.ok(r.body._raw.includes('priceFile'));
  });

  await test('not accepting orders blocks uploads and orders', async () => {
    await owner('PUT', '/settings', { accepting_orders: false });
    let r = await analyse('text.pdf');
    assert.strictEqual(r.status, 503);
    r = await order([{ upload_id: up.text.upload_id, mode: 'bw' }]);
    assert.strictEqual(r.status, 503);
    await owner('PUT', '/settings', { accepting_orders: true });
  });

  await test('cleanup: abandoned uploads and old unpaid orders are removed', async () => {
    const r = await analyse('text.pdf');
    const id = r.body.upload_id;
    const [u] = await db.q('SELECT file_path FROM uploads WHERE id = ?', [id]);
    const fp = path.join(process.env.STORAGE_DIR, 'uploads', u.file_path);
    assert.ok(fs.existsSync(fp));
    await db.q('UPDATE uploads SET created_at = UTC_TIMESTAMP() - INTERVAL 7 HOUR WHERE id = ?', [id]);
    const o = (await order([{ upload_id: up.photo.upload_id, mode: 'bw' }])).body;
    await db.q('UPDATE orders SET created_at = UTC_TIMESTAMP() - INTERVAL 25 HOUR WHERE token = ?', [o.token]);
    await runCleanup();
    assert.strictEqual((await db.q('SELECT COUNT(*) n FROM uploads WHERE id = ?', [id]))[0].n, 0);
    assert.ok(!fs.existsSync(fp));
    assert.strictEqual((await status(o)).overall, 'cancelled');
  });

  /* ---------- rate limit & size limit (separate server process with low limits) ---------- */
  await test('rate limit on analyse (per client IP behind proxy) and upload size cap', async () => {
    const port = 39000 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port), ANALYSE_RATE_LIMIT: '3', MAX_UPLOAD_MB: '1' }, stdio: 'ignore',
    });
    try {
      const B = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 40; i++) { try { await fetch(B + '/api/settings'); break; } catch (_) { await new Promise((z) => setTimeout(z, 250)); } }
      const up1 = (ip) => {
        const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(path.join(FIX, 'text.pdf'))]), 'text.pdf');
        return fetch(B + '/api/analyse', { method: 'POST', body: fd, headers: { 'X-Forwarded-For': ip } });
      };
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await up1('10.0.0.1')).status);
      assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
      assert.strictEqual((await up1('10.0.0.2')).status, 200, 'another customer is not affected');
      const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(path.join(FIX, 'photo_page.pdf')), Buffer.alloc(1100000)]), 'big.pdf');
      const big = await fetch(B + '/api/analyse', { method: 'POST', body: fd, headers: { 'X-Forwarded-For': '10.0.0.9' } });
      assert.strictEqual(big.status, 413);
      assert.match((await big.json()).error, /too big/);
    } finally { child.kill(); }
  });

  server.close();
  await db.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\nAPI: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
