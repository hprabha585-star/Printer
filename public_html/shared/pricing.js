/*
 * Shared pricing module — the ONE place where print prices are calculated.
 * Loaded by the browser (window.PrintPricing) for the live price, and by the
 * server (require) which recomputes every price from stored analysis and never
 * trusts a number sent by the browser.
 *
 * All money is handled in PAISE (integers) to avoid floating-point surprises.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrintPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Rupees (number or string) -> integer paise. */
  function toPaise(rupees) {
    var n = Number(rupees);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n * 100);
  }

  /** Integer paise -> "12.50" */
  function formatRupees(paise) {
    var p = Math.max(0, Math.round(Number(paise) || 0));
    return (Math.floor(p / 100)) + '.' + String(p % 100).padStart(2, '0');
  }

  /**
   * Classify one page by its colour coverage (0..1).
   * thresholdPct is the owner's "full colour" threshold in percent (default 25).
   */
  function classifyPage(coverage, thresholdPct) {
    var c = Number(coverage) || 0;
    var t = (Number(thresholdPct) > 0 ? Number(thresholdPct) : 25) / 100;
    if (c <= 0) return 'bw';
    if (c >= t) return 'full';
    return 'partial';
  }

  /**
   * Price one file.
   * opts: { coverage: [per-page coverage 0..1], start, end, copies, mode: 'bw'|'color' }
   * rates: { bw, partial, full } in paise per page, threshold in percent.
   * Returns { pages, bw, partial, full, copies, perCopy, amount } (paise).
   */
  function priceFile(opts, rates) {
    var cov = opts.coverage || [];
    var total = cov.length;
    var start = Math.max(1, Math.floor(Number(opts.start) || 1));
    var end = Math.min(total, Math.floor(Number(opts.end) || total));
    var copies = Math.max(1, Math.min(999, Math.floor(Number(opts.copies) || 1)));
    var mode = opts.mode === 'color' ? 'color' : 'bw';
    var out = { pages: 0, bw: 0, partial: 0, full: 0, copies: copies, perCopy: 0, amount: 0, start: start, end: end, mode: mode };
    if (total === 0 || end < start) return out;
    for (var i = start - 1; i < end; i++) {
      out.pages++;
      if (mode === 'bw') { out.bw++; continue; }
      out[classifyPage(cov[i], rates.threshold)]++;
    }
    out.perCopy = out.bw * rates.bw + out.partial * rates.partial + out.full * rates.full;
    out.amount = out.perCopy * copies;
    return out;
  }

  /** Human breakdown, e.g. "5 pages: 3 B&W, 1 partial colour, 1 full colour, x2" */
  function describe(p) {
    var parts = [];
    if (p.bw) parts.push(p.bw + ' B&W');
    if (p.partial) parts.push(p.partial + ' partial colour');
    if (p.full) parts.push(p.full + ' full colour');
    var s = p.pages + (p.pages === 1 ? ' page' : ' pages');
    if (parts.length) s += ': ' + parts.join(', ');
    if (p.copies > 1) s += ', x' + p.copies;
    return s;
  }

  /** Settings row (rupees) -> rates object (paise). */
  function ratesFromSettings(s) {
    return {
      bw: toPaise(s.rate_bw),
      partial: toPaise(s.rate_partial),
      full: toPaise(s.rate_full),
      threshold: Number(s.color_threshold) || 25
    };
  }

  return { toPaise: toPaise, formatRupees: formatRupees, classifyPage: classifyPage, priceFile: priceFile, describe: describe, ratesFromSettings: ratesFromSettings };
});
