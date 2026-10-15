/*
 * Analyser accuracy test: runs every generated fixture through the analyser
 * (inside worker threads, exactly like the server) and compares with expectations.
 *   python3 tests/fixtures/make_fixtures.py && node tests/analyzer.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
process.env.ANALYSIS_TIMEOUT_SEC = process.env.ANALYSIS_TIMEOUT_SEC || '120';
const { analyse } = require('../src/analyzer');
const { classifyPage } = require('../public/shared/pricing');
const { kindFromName } = require('../src/analyzer/sniff');

const DIR = path.join(__dirname, 'fixtures', 'out');
const exp = JSON.parse(fs.readFileSync(path.join(DIR, 'expectations.json'), 'utf8'));
const only = process.argv[2];

(async () => {
  let pass = 0, fail = 0;
  for (const [name, e] of Object.entries(exp)) {
    if (only && !name.includes(only)) continue;
    const t0 = Date.now();
    const r = await analyse(path.join(DIR, name), kindFromName(name));
    const ms = Date.now() - t0;
    let ok, got;
    if (e.error) {
      ok = !r.ok && r.code === e.error;
      got = r.ok ? 'analysed OK' : `${r.code}: ${r.message}`;
    } else if (!r.ok) {
      ok = false; got = `${r.code}: ${r.message} ${r.detail || ''}`;
    } else {
      const res = r.result;
      const classes = res.coverage.map((c) => classifyPage(c, 25));
      ok = res.pages === e.pages && res.micro.verdict === e.micro &&
        (!e.classes || JSON.stringify(classes) === JSON.stringify(e.classes));
      got = `pages=${res.pages} cov=${JSON.stringify(res.coverage)} classes=${classes.join(',')} micro=${res.micro.verdict} ${res.micro.reason || ''}`;
    }
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(28)} ${String(ms).padStart(5)}ms  ${got}`);
  }
  console.log(`\nAnalyser: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
