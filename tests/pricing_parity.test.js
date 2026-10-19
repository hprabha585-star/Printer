/*
 * The browser (shared/pricing.js) and the server (app/Pricing.php) must price
 * every order identically. Runs 5,000 random cases through both and compares.
 *   node pricing_parity.test.js
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const P = require('../public_html/shared/pricing.js');

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const cases = [];
for (let i = 0; i < 5000; i++) {
  const n = 1 + Math.floor(rnd() * 30);
  const coverage = Array.from({ length: n }, () => pick([0, 0, 0, 0.01, 0.0187, 0.1, 0.2499, 0.25, 0.2501, 0.5, 1, rnd()]));
  const settings = {
    rate_bw: pick(['2.00', '1.50', '0.75', '3', '2.25', '0']), rate_partial: pick(['5.00', '4.5', '3.33', '6']),
    rate_full: pick(['10.00', '12.5', '9.99', '15']), color_threshold: pick(['25.00', '10', '33.33', '50', '1', '100']),
  };
  const opts = {
    coverage, mode: pick(['bw', 'color', 'color']),
    start: pick([1, 1, 2, 0, -1, n, n + 2, 1.7, '3', '']), end: pick([n, n, 1, 0, n - 1, n + 5, 2.4, '']),
    copies: pick([1, 1, 2, 5, 0, 99, 1000, 2.5, '']),
  };
  cases.push({ settings, opts });
}
const js = cases.map(({ settings, opts }) => P.priceFile(opts, P.ratesFromSettings(settings)));
const jsDesc = js.map((p) => P.describe(p));
const phpCode = `
require ${JSON.stringify(path.join(__dirname, '..', 'public_html', 'app', 'Pricing.php'))};
$cases = json_decode(stream_get_contents(STDIN), true);
$out = [];
foreach ($cases as $c) { $p = Pricing::priceFile($c['opts'], Pricing::ratesFromSettings($c['settings'])); $out[] = [$p, Pricing::describe($p)]; }
echo json_encode($out);`;
const php = JSON.parse(execFileSync('php', ['-r', phpCode], { input: JSON.stringify(cases), maxBuffer: 64e6 }).toString());
let diffs = 0;
php.forEach(([p, d], i) => {
  const a = js[i];
  for (const k of ['pages', 'bw', 'partial', 'full', 'copies', 'perCopy', 'amount', 'start', 'end', 'mode']) {
    if (a[k] !== p[k]) { if (diffs++ < 5) console.log('DIFF', k, JSON.stringify(cases[i]), a[k], p[k]); }
  }
  if (jsDesc[i] !== d) { if (diffs++ < 5) console.log('DIFF describe', jsDesc[i], d); }
});
assert.strictEqual(diffs, 0);
console.log(`Pricing parity: ${cases.length} cases identical in JavaScript and PHP`);
