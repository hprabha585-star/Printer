/*
 * Several Print Connectors at once against one server + real MySQL.
 * Uses the connector's simulated printers (--fake-printers), which log every
 * "print" so we can check: no file printed twice, no printer used by two jobs at
 * once, colour routing, failover, stale-lock timeout, offline printer, paper jam.
 *   DB_USER=.. DB_PASSWORD=.. DB_NAME=printshop_test node tests/connectors.test.js
 * WARNING: drops and recreates all tables in DB_NAME.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const php = require('./lib/php');
const FIX = path.join(__dirname, 'fixtures', 'out');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-'));
let BASE;
const MASTER = 'test-master-key-123';
const env = { OWNER_MASTER_KEY: MASTER, STALE_LOCK_SEC: '8', ANALYSE_RATE_LIMIT: '1000', STORAGE_DIR: path.join(TMP, 'storage') };
const db = require('./lib/db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let key;
const procs = [];

async function test(name, fn) {
  try { await fn(); results.push(true); console.log('PASS', name); }
  catch (e) { results.push(false); console.log('FAIL', name, '\n   ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e); }
  finally { for (const p of procs.slice(1)) { try { p.kill(); } catch (_) {} } await sleep(500); }
}
async function call(method, url, body) {
  const h = { 'X-Owner-Key': key || '' };
  if (body && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers: h, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function analyse(file) {
  const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(path.join(FIX, file))]), file);
  return call('POST', '/api/analyse', fd);
}
let utr = 300000000000 + Math.floor(Math.random() * 1e9);
async function paidOrders(n, uploadId, mode) {
  for (let i = 0; i < n; i++) {
    const o = await call('POST', '/api/orders', { items: [{ upload_id: uploadId, mode }] });
    const r = await call('POST', `/api/orders/${o.token}/utr`, { k: o.key, utr: String(++utr) });
    assert.ok(r.ok, JSON.stringify(r));
  }
}
function connector(name, printers, maps, extra = []) {
  const log = path.join(TMP, `${name}.jsonl`);
  const args = [path.join(ROOT, 'connector', 'printshop_connector.py'), '--headless', '--config', path.join(TMP, `${name}.json`),
    '--server', BASE, '--password', MASTER, '--name', name, '--fake-printers', printers, '--fake-log', log, '--poll', '0.5',
    ...maps.flatMap((m) => ['--map', m]), ...extra];
  const p = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.output = '';
  p.stdout.on('data', (d) => { p.output += d; });
  p.stderr.on('data', (d) => { p.output += d; });
  procs.push(p);
  return { p, log, name };
}
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(400); }
  throw new Error('timed out waiting for ' + what);
}
const MAPS = (pfx) => [`${pfx}-Colour=Printer 1 - Colour`, `${pfx}-Mono1=Printer 2 - B&W`, `${pfx}-Mono2=Printer 3 - B&W`];
const LABEL = (pc, local) => ({ Colour: 'Printer 1 - Colour', Mono1: 'Printer 2 - B&W', Mono2: 'Printer 3 - B&W' })[local.split('-').pop()];

(async () => {
  // fresh database + server
  for (const t of await db.q('SHOW TABLES')) await db.q(`DROP TABLE \`${Object.values(t)[0]}\``);
  try { fs.unlinkSync(path.join(env.STORAGE_DIR, 'schema.version')); } catch (_) {}
  const server = await php.start(env);
  BASE = server.base;
  procs.push(server);
  let serverOut = '';
  key = (await call('POST', '/api/owner/login', { master_key: MASTER })).token;
  await call('PUT', '/api/owner/settings', { verify_upi: false, upi_id: 'shop@okaxis' });
  const text = await analyse('text.pdf');
  const photo = await analyse('photo.jpg');

  /* ---------- A: three computers sharing three printers ---------- */
  await test('3 connectors: every file printed exactly once, never two jobs on one printer, colour routing', async () => {
    await paidOrders(6, photo.upload_id, 'color');
    await paidOrders(12, text.upload_id, 'bw');
    const pcs = ['PC-A', 'PC-B', 'PC-C'].map((n) => connector(n, `${n}-Colour:color:slow=1,${n}-Mono1:slow=1,${n}-Mono2:slow=1`, MAPS(n)));
    await waitFor(async () => (await db.q(`SELECT COUNT(*) n FROM jobs WHERE print_status <> 'completed'`))[0].n === 0, 90000, 'all printed');
    await sleep(1500);
    for (const c of pcs) c.p.kill();
    const prints = pcs.flatMap((c) => readLog(c.log).map((e) => ({ ...e, pc: c.name, label: LABEL(c.name, e.local) })));
    const jobs = await db.q('SELECT * FROM jobs ORDER BY id');
    assert.strictEqual(prints.length, 18, `printed ${prints.length} times for 18 files`);
    const perJob = {};
    for (const p of prints) perJob[p.job] = (perJob[p.job] || 0) + 1;
    assert.ok(Object.values(perJob).every((n) => n === 1), 'a file was printed twice');
    // no overlap on any shop printer, across all computers
    const byLabel = {};
    for (const p of prints) (byLabel[p.label] = byLabel[p.label] || []).push(p);
    for (const [label, list] of Object.entries(byLabel)) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) assert.ok(list[i].start >= list[i - 1].end - 0.05, `two jobs at once on ${label}`);
    }
    // colour jobs only on the colour printer, printed in colour; B&W printed monochrome
    for (const j of jobs) {
      const p = prints.find((x) => x.job === j.id);
      assert.strictEqual(j.printer_label, p.label);
      assert.strictEqual(j.computer_name, p.pc);
      if (j.color_mode === 'color') { assert.strictEqual(p.label, 'Printer 1 - Colour'); assert.strictEqual(p.monochrome, false); }
      else assert.strictEqual(p.monochrome, true);
    }
    const bwOnColour = prints.filter((p) => p.monochrome && p.label === 'Printer 1 - Colour').length;
    const pcsUsed = new Set(prints.map((p) => p.pc)).size;
    console.log(`     (B&W files on the colour printer: ${bwOnColour}/12; computers used: ${pcsUsed}; all 3 printers used: ${Object.keys(byLabel).length === 3})`);
    // downloaded files were deleted from the "shop computer"
    const left = fs.readdirSync(path.join(os.tmpdir(), 'PrintShopConnector')).filter((f) => f.startsWith('job'));
    assert.deepStrictEqual(left, []);
  });

  /* ---------- B: a computer dies mid-print ---------- */
  await test('failover: a computer crashes mid-print → its printers unlock after the stale timeout, nothing re-printed', async () => {
    await paidOrders(6, text.upload_id, 'bw');
    const a = connector('PC-DIES', 'PC-DIES-Colour:color:slow=30,PC-DIES-Mono1:slow=30,PC-DIES-Mono2:slow=30', MAPS('PC-DIES'));
    await waitFor(async () => (await db.q(`SELECT COUNT(*) n FROM jobs WHERE print_status = 'printing' AND computer_name = 'PC-DIES'`))[0].n === 3, 20000, 'PC-DIES printing 3');
    a.p.kill('SIGKILL');
    const killedAt = Date.now();
    const stuck = (await db.q(`SELECT id FROM jobs WHERE print_status = 'printing' AND computer_name = 'PC-DIES'`)).map((r) => r.id);
    const b = connector('PC-B2', 'PC-B2-Colour:color:slow=0.5,PC-B2-Mono1:slow=0.5,PC-B2-Mono2:slow=0.5', MAPS('PC-B2'));
    await waitFor(async () => (await db.q(`SELECT COUNT(*) n FROM jobs WHERE print_status = 'queued'`))[0].n === 0, 40000, 'queue drained');
    const firstPrint = Math.min(...readLog(b.log).map((e) => e.start * 1000));
    assert.ok(firstPrint - killedAt >= 5000, `printers were reused only ${(firstPrint - killedAt) / 1000}s after the crash (lock is 8s from claim)`);
    // the crashed computer's jobs were NOT printed again automatically
    const st = await db.q(`SELECT print_status FROM jobs WHERE id IN (?)`, [stuck]);
    assert.ok(st.every((r) => r.print_status === 'printing'));
    assert.ok(!readLog(b.log).some((e) => stuck.includes(e.job)));
    // owner presses Retry on one stuck file (shown as stuck after 10 minutes)
    await db.q(`UPDATE jobs SET claimed_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE WHERE id IN (?)`, [stuck]);
    const r = await call('POST', `/api/owner/jobs/${stuck[0]}/retry`, {});
    assert.ok(r.ok, JSON.stringify(r));
    await waitFor(async () => (await db.q(`SELECT print_status FROM jobs WHERE id = ?`, [stuck[0]]))[0].print_status === 'completed', 20000, 'retried job printed');
    assert.strictEqual(readLog(b.log).filter((e) => e.job === stuck[0]).length, 1);
    b.p.kill();
    await db.q(`UPDATE jobs SET print_status = 'cancelled' WHERE id IN (?)`, [stuck.slice(1)]);
  });

  /* ---------- C: offline colour printer, paper jam, queue-drain waiting ---------- */
  await test('offline printer skipped, jam reported as failure, colour waits for a colour printer, done only after queue drains', async () => {
    await paidOrders(1, photo.upload_id, 'color');
    await paidOrders(3, text.upload_id, 'bw');
    const c = connector('PC-C2', 'PC-C2-Colour:color:offline,PC-C2-Mono1:jam,PC-C2-Mono2:slow=2.5', MAPS('PC-C2'), ['--drain-timeout', '7']);
    await waitFor(async () => (await db.q(`SELECT COUNT(*) n FROM jobs WHERE print_status = 'queued' AND color_mode = 'bw'`))[0].n === 0 &&
      (await db.q(`SELECT COUNT(*) n FROM jobs WHERE print_status = 'printing'`))[0].n === 0, 40000, 'B&W done');
    const prints = readLog(c.log);
    assert.ok(!prints.some((p) => p.local === 'PC-C2-Colour'), 'printed on an offline printer');
    assert.strictEqual(prints.filter((p) => p.local === 'PC-C2-Mono1').length, 1, 'jammed printer must not get more jobs');
    const failed = await db.q(`SELECT * FROM jobs WHERE print_status = 'failed'`);
    assert.strictEqual(failed.length, 1);
    assert.match(failed[0].error, /still busy after/);
    assert.match(failed[0].error, /PC-C2/);
    assert.strictEqual(failed[0].printer_label, 'Printer 2 - B&W');
    const ok = await db.q(`SELECT TIMESTAMPDIFF(SECOND, claimed_at, finished_at) d FROM jobs WHERE print_status = 'completed' AND computer_name = 'PC-C2'`);
    assert.strictEqual(ok.length, 2);
    assert.ok(ok.every((r) => r.d >= 2), 'reported done before the printer finished');
    // the colour job is still waiting (only colour printer here is offline)
    assert.strictEqual((await db.q(`SELECT print_status FROM jobs WHERE color_mode = 'color' ORDER BY id DESC LIMIT 1`))[0].print_status, 'queued');
    // a second computer with a working colour printer picks it up
    const b = connector('PC-B3', 'PC-B3-Colour:color:slow=0.5', ['PC-B3-Colour=Printer 1 - Colour']);
    await waitFor(async () => (await db.q(`SELECT print_status FROM jobs WHERE color_mode = 'color' ORDER BY id DESC LIMIT 1`))[0].print_status === 'completed', 20000, 'colour printed');
    c.p.kill(); b.p.kill();
    const pcs = await call('GET', '/api/owner/connectors');
    const c2 = pcs.find((x) => x.computer_name === 'PC-C2');
    assert.ok(c2 && c2.printers.some((p) => p.status === 'offline'), 'dashboard shows the offline printer');
  });

  /* ---------- D: disabled printer is not used ---------- */
  await test('printer switched off in the dashboard is not used by any computer', async () => {
    const list = await call('GET', '/api/owner/printers');
    list[1].enabled = 0; list[2].enabled = 0; // only the colour printer stays on
    await call('PUT', '/api/owner/printers', list);
    await paidOrders(2, text.upload_id, 'bw');
    const d = connector('PC-D', 'PC-D-Colour:color:slow=0.3,PC-D-Mono1:slow=0.3,PC-D-Mono2:slow=0.3', MAPS('PC-D'));
    await waitFor(async () => (await db.q(`SELECT COUNT(*) n FROM jobs WHERE print_status IN ('queued','printing')`))[0].n === 0, 30000, 'printed');
    d.p.kill();
    const prints = readLog(d.log);
    assert.strictEqual(prints.length, 2);
    assert.ok(prints.every((p) => p.local === 'PC-D-Colour'), 'B&W jobs fall back to the colour printer when B&W printers are off');
  });

  for (const p of procs) { try { p.kill(); } catch (_) {} }
  await db.close();
  const failed = results.filter((r) => !r).length;
  if (failed) console.log('\n--- server output ---\n' + (serverOut || procs[0].log || '').slice(-3000));
  console.log(`\nConnectors: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); for (const p of procs) { try { p.kill(); } catch (_) {} } process.exit(1); });
