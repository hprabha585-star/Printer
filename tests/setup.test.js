/*
 * First-time setup page and folder protection (PHP site).
 *   DB_USER=.. DB_PASSWORD=.. DB_NAME=.. node setup.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const php = require('./lib/php');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const cfg = path.join(tmp, 'config.php');
  const env = { PRINTSHOP_CONFIG: cfg, STORAGE_DIR: path.join(tmp, 'storage'), DB_NAME: '', DB_USER: '', DB_PASSWORD: '', OWNER_MASTER_KEY: '', APP_ENV: 'production' };
  const srv = await php.start(env);
  let ok = 0, bad = 0;
  const t = async (name, fn) => { try { await fn(); ok++; console.log('PASS', name); } catch (e) { bad++; console.log('FAIL', name, e.message); } };
  try {
    await t('before setup, the API says the site is not set up', async () => {
      const r = await fetch(srv.base + '/api/settings');
      assert.strictEqual(r.status, 503);
      assert.match((await r.json()).error, /not set up/);
    });
    await t('setup page shows the server check and the database form', async () => {
      const html = await (await fetch(srv.base + '/setup')).text();
      assert.match(html, /Server check/);
      assert.match(html, /PHP extension: gd/);
      assert.match(html, /name="db_name"/);
    });
    await t('wrong database password gives a plain-language error', async () => {
      const body = new URLSearchParams({ db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: 'nope', public_url: 'https://print.example.in' });
      const html = await (await fetch(srv.base + '/setup', { method: 'POST', body })).text();
      assert.match(html, /username or password is wrong/);
      assert.ok(!fs.existsSync(cfg));
    });
    let key;
    await t('correct details: saves config, creates tables, shows a master key once', async () => {
      const body = new URLSearchParams({ db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD, public_url: 'https://print.example.in' });
      const html = await (await fetch(srv.base + '/setup', { method: 'POST', body })).text();
      key = (html.match(/class="key">([A-Z0-9-]+)</) || [])[1];
      assert.match(key || '', /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);
      const text = fs.readFileSync(cfg, 'utf8');
      assert.ok(text.includes(key));
      assert.strictEqual((fs.statSync(cfg).mode & 0o777).toString(8), '600');
    });
    await t('after setup: site works, master key signs in, setup page is locked', async () => {
      const s = await fetch(srv.base + '/api/settings');
      assert.strictEqual(s.status, 200);
      const login = await fetch(srv.base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ master_key: key }) });
      assert.strictEqual(login.status, 200);
      const again = await (await fetch(srv.base + '/setup', { method: 'POST', body: new URLSearchParams({ db_name: 'x', db_user: 'y' }) })).text();
      assert.match(again, /Already set up/);
      assert.ok(fs.readFileSync(cfg, 'utf8').includes(key), 'config must not change');
    });
    await t('application code, config and customer files are not reachable from the web', async () => {
      for (const u of ['/app/config.php', '/app/bootstrap.php', '/app/Db.php', '/storage/schema.version', '/storage/uploads/x.pdf', '/.htaccess', '/.user.ini']) {
        const r = await fetch(srv.base + u);
        assert.ok(r.status === 403 || r.status === 404, `${u} -> ${r.status}`);
      }
    });
  } finally { srv.kill(); }
  console.log(`\nSetup: ${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
