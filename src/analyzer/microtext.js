/*
 * Micro-printing screening for raster images (photos, scans, images inside PDFs).
 *
 * Idea: microtext looks like many very tightly spaced text lines. Within a small
 * square tile, the row-by-row amount of ink rises and falls with a short, regular
 * period (one period = one text line), while along each line the ink is broken
 * into short strokes (letters).
 *
 * Things that are deliberately ignored:
 *   - QR codes, halftone dots, crosshatching: regular in BOTH directions (isotropic)
 *   - barcodes, ruled/hatched lines: ink runs are long and unbroken
 *   - noise and photos: no regular period
 *   - images too low-resolution to physically contain readable microtext
 *
 * Image findings are only ever "suspect" — the owner looks at the file and decides.
 * This is a screening aid, not proof.
 */
'use strict';

const MAX_PITCH_PT = 4.2;   // a text-line pitch at or below this (≈3pt text) is "micro"
const MIN_PITCH_PX = 3;     // a line pitch below 3 pixels cannot be resolved
const TARGET_PITCH_PX = 12; // we downscale so the largest pitch of interest is ~12 px
const MIN_FLAGGED_TILES = 4; // calibrated: microtext fixtures flag 12+ tiles, normal documents at most 2

/**
 * gray: Uint8Array (0=black..255=white), width, height, dpi (pixels per inch as printed)
 * returns { checked: bool, suspect: bool, reason, tiles, pitchPt }
 */
function detectMicrotext(gray, width, height, dpi) {
  const maxPitchPx = (MAX_PITCH_PT / 72) * dpi;
  if (!(dpi > 0) || maxPitchPx < MIN_PITCH_PX + 1) {
    return { checked: false, suspect: false, reason: 'resolution too low to contain readable microtext' };
  }
  // Downscale (box average) so the work stays small and fast.
  const s = Math.min(1, TARGET_PITCH_PX / maxPitchPx);
  const img = s < 1 ? downscale(gray, width, height, s) : { data: gray, w: width, h: height };
  const maxLag = Math.max(MIN_PITCH_PX + 1, Math.floor(maxPitchPx * s));
  const ink = inkMask(img.data, img.w, img.h, Math.max(6, maxLag * 2));
  const T = Math.max(24, Math.round(maxLag * 6)); // square tile ≈ 6 line pitches
  const step = Math.max(8, Math.round(T / 2));

  let flagged = 0, tiles = 0, bestPitch = 0;
  for (let y0 = 0; y0 + T <= img.h; y0 += step) {
    for (let x0 = 0; x0 + T <= img.w; x0 += step) {
      tiles++;
      const r = analyseTile(ink, img.w, x0, y0, T, maxLag);
      if (r) { flagged++; bestPitch = r.pitch; }
    }
  }
  const pitchPt = bestPitch ? (bestPitch / s / dpi) * 72 : 0;
  const suspect = flagged >= MIN_FLAGGED_TILES;
  return {
    checked: true, suspect, tiles, flagged,
    pitchPt: Math.round(pitchPt * 10) / 10,
    reason: suspect ? `tightly spaced text-like lines (about ${pitchPt.toFixed(1)}pt line spacing)` : '',
  };
}

function downscale(src, w, h, s) {
  const nw = Math.max(1, Math.floor(w * s)), nh = Math.max(1, Math.floor(h * s));
  const out = new Uint8Array(nw * nh);
  const fx = w / nw, fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * fy), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * fx), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * fx));
      let sum = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        const row = yy * w;
        for (let xx = sx0; xx < sx1; xx++) { sum += src[row + xx]; n++; }
      }
      out[y * nw + x] = sum / n;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Adaptive threshold: a pixel is "ink" if clearly darker than its neighbourhood. Handles light ink. */
function inkMask(g, w, h, radius) {
  const W = w + 1;
  const integ = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += g[y * w + x];
      integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + rowSum;
    }
  }
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const sum = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
      const mean = sum / ((y1 - y0) * (x1 - x0));
      const v = g[y * w + x];
      m[y * w + x] = (v < mean - Math.max(10, mean * 0.08) && v < 235) ? 1 : 0;
    }
  }
  return m;
}

/** Strength (0..1) and lag of the strongest short repeat in a 1-D profile. */
function periodicity(p, minLag, maxLag) {
  const n = p.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += p[i];
  mean /= n;
  const z = new Float64Array(n);
  let var0 = 0;
  for (let i = 0; i < n; i++) { z[i] = p[i] - mean; var0 += z[i] * z[i]; }
  if (var0 <= 1e-9) return { strength: 0, lag: 0, ac: null };
  const ac = new Float64Array(maxLag + 3);
  for (let lag = 1; lag <= Math.min(maxLag + 2, n - 1); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += z[i] * z[i + lag];
    ac[lag] = (s / (n - lag)) / (var0 / n);
  }
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag && lag + 1 < n; lag++) {
    // must be a genuine local peak, not the shoulder of a longer period
    if (ac[lag] > best && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) { best = ac[lag]; bestLag = lag; }
  }
  return { strength: best, lag: bestLag, ac };
}

/** Mean length of continuous ink runs (along x if horiz, along y otherwise) inside the tile. */
function meanRun(ink, w, x0, y0, T, horiz) {
  let runs = 0, total = 0;
  for (let a = 0; a < T; a++) {
    let run = 0;
    for (let b = 0; b < T; b++) {
      const x = horiz ? x0 + b : x0 + a, y = horiz ? y0 + a : y0 + b;
      if (ink[y * w + x]) run++;
      else if (run) { runs++; total += run; run = 0; }
    }
    if (run) { runs++; total += run; }
  }
  return runs ? total / runs : 0;
}

/**
 * True if the profile is a regular run of separate "line bands" spaced `lag` apart:
 * enough bands to fill the tile, clear gaps between them, and even spacing.
 * (A single large text line has inner structure, but not this.)
 */
function regularBands(p, lag) {
  let max = 0;
  for (const v of p) if (v > max) max = v;
  if (max <= 0) return false;
  const starts = [];
  let inBand = false;
  for (let i = 0; i < p.length; i++) {
    if (!inBand && p[i] > max * 0.55) { starts.push(i); inBand = true; }
    else if (inBand && p[i] < max * 0.3) inBand = false;
  }
  if (starts.length < 3) return false;
  const span = starts[starts.length - 1] - starts[0];
  // the bands must cover most of the tile, not just one part of it
  if ((starts.length - 1) * lag < Math.min(p.length * 0.5, span * 0.8)) return false;
  let good = 0;
  for (let i = 1; i < starts.length; i++) {
    const d = starts[i] - starts[i - 1];
    if (d >= lag * 0.7 && d <= lag * 1.3) good++;
  }
  return good >= (starts.length - 1) * 0.75 && good >= 2;
}

function analyseTile(ink, w, x0, y0, T, maxLag) {
  const rows = new Float64Array(T), cols = new Float64Array(T);
  let inkCount = 0;
  for (let y = 0; y < T; y++) {
    const row = (y0 + y) * w + x0;
    for (let x = 0; x < T; x++) {
      if (ink[row + x]) { rows[y]++; cols[x]++; inkCount++; }
    }
  }
  const frac = inkCount / (T * T);
  if (frac < 0.04 || frac > 0.6) return null;

  const pr = periodicity(rows, MIN_PITCH_PX, maxLag);
  const pc = periodicity(cols, MIN_PITCH_PX, maxLag);
  for (const [main, other, horiz] of [[pr, pc, true], [pc, pr, false]]) {
    if (main.strength < 0.45 || !main.lag) continue;
    // a true repeating pattern also correlates at twice the period
    const second = autocorrAt(horiz ? rows : cols, 2 * main.lag);
    if (second < 0.2) continue;
    // if the pattern repeats much more strongly at twice the period, the real line
    // spacing is the longer one (e.g. table rows with a ruled line + a text line)
    if (second > main.strength + 0.15) continue;
    // isotropic patterns (halftone, QR, crosshatch) repeat in both directions
    if (other.strength > 0.35) continue;
    if (!regularBands(horiz ? rows : cols, main.lag)) continue;
    // microtext lines run right across the tile, so ink is spread evenly along
    // them; letters of ordinary text leave whole empty gaps between text lines
    if (!evenlySpread(horiz ? cols : rows, main.lag)) continue;
    // letters = short strokes along the line; ruled lines/barcodes = long runs
    const run = meanRun(ink, w, x0, y0, T, horiz);
    if (run <= 0 || run > main.lag * 1.2) continue;
    return { pitch: main.lag, horiz };
  }
  return null;
}

function evenlySpread(p, lag) {
  let mean = 0;
  for (const v of p) mean += v;
  mean /= p.length;
  if (mean <= 0) return false;
  // narrow gaps (between letters that line up) are fine; wide empty stretches
  // (the space between ordinary text lines) are not
  let sparse = 0, run = 0, longest = 0;
  for (const v of p) {
    if (v < mean * 0.35) { sparse++; run++; if (run > longest) longest = run; } else run = 0;
  }
  return sparse <= p.length * 0.35 && longest <= Math.max(2, lag * 0.6);
}

function autocorrAt(p, lag) {
  const n = p.length;
  if (lag >= n - 1) return 0;
  let mean = 0;
  for (const v of p) mean += v;
  mean /= n;
  let s = 0, v0 = 0;
  for (let i = 0; i < n; i++) v0 += (p[i] - mean) ** 2;
  for (let i = 0; i + lag < n; i++) s += (p[i] - mean) * (p[i + lag] - mean);
  return v0 > 0 ? (s / (n - lag)) / (v0 / n) : 0;
}

module.exports = { detectMicrotext, MAX_PITCH_PT };
