/*
 * PDF analysis WITHOUT rendering pages.
 *
 * We read each page's list of drawing operations (via pdf.js, pure JavaScript)
 * and keep track of where things are drawn and in what colour:
 *   - coloured fills / strokes  -> area of the shape's bounding box
 *   - coloured text             -> approx. area of the glyphs
 *   - gradients                 -> area of the clipping box if any stop is coloured
 *   - embedded images           -> coloured-pixel fraction × the area it covers
 * Grey/black/white counts as zero colour.
 *
 * Micro-printing: every visible glyph's real printed size is computed from the
 * font size and the text/page transforms. Embedded images (scans) are checked
 * with the raster microtext detector.
 */
'use strict';
const { colorFraction, withMinimum, toGray, detectMicrotext, AnalysisError, round, CHROMA_MIN } = require('./image');

let pdfjs;
function loadPdfjs() {
  if (pdfjs) return pdfjs;
  // pdf.js prints harmless warnings about the optional "canvas" module; silence them.
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.log = log; console.warn = warn; }
  return pdfjs;
}

// Micro-printing thresholds (characters counted across the whole document)
const TINY_PT = 2.0, SMALL_PT = 3.0;
const BLOCK_TINY_CHARS = 150;  // a lot of text under 2pt  -> BLOCKED
const SUSPECT_TINY_CHARS = 15; // a little text under 2pt  -> SUSPECT
const SUSPECT_SMALL_CHARS = 200; // a lot of 2–3pt text    -> SUSPECT

function mul(m, n) { // m then n  (pdf.js/Canvas matrix order [a,b,c,d,e,f])
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
function boxThrough(m, x0, y0, x1, y1) {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function intersect(a, b) {
  if (!a) return b; if (!b) return a;
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
function area(b) { return b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0; }
function scaleOf(m) { return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); }

/** Is an [r,g,b] (0..255) colour visibly non-neutral? */
function isColoured(c) {
  if (!c) return false;
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
  return mx - mn > CHROMA_MIN;
}
function parseColor(args) {
  if (!args) return null;
  if (typeof args[0] === 'string' && args[0][0] === '#') return hexToRgb(args[0]);
  if (args.length >= 3 && typeof args[0] === 'number') return [args[0], args[1], args[2]];
  if (args[0] !== undefined && typeof args[0] === 'object' && typeof args[0][0] === 'number') return Array.from(args[0]).slice(0, 3);
  return null;
}
function hexToRgb(h) {
  const v = parseInt(h.slice(1, 7), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
/** Does a pattern/shading description contain any coloured stop? */
function shadingIsColoured(ir) {
  let found = false;
  const visit = (x, depth) => {
    if (found || depth > 4 || x == null) return;
    if (typeof x === 'string' && x[0] === '#' && x.length >= 7) { if (isColoured(hexToRgb(x))) found = true; return; }
    if (ArrayBuffer.isView(x)) {
      for (let i = 0; i + 2 < x.length && i < 3000; i += 3) if (isColoured([x[i], x[i + 1], x[i + 2]])) { found = true; return; }
      return;
    }
    if (Array.isArray(x)) for (const y of x) visit(y, depth + 1);
    else if (typeof x === 'object') for (const k of Object.keys(x)) visit(x[k], depth + 1);
  };
  visit(ir, 0);
  return found;
}

function imagePixels(img) {
  if (!img || !img.data || !img.width) return null;
  const { width: w, height: h, data, kind } = img;
  if (kind === 3) return { data, w, h, channels: 4 };
  if (kind === 2) return { data, w, h, channels: 3 };
  // kind 1: 1 bit per pixel, rows padded to whole bytes
  return { data: unpackBits(data, w, h, false), w, h, channels: 1 };
}
function unpackBits(data, w, h, invert) {
  const out = new Uint8Array(w * h);
  const rowBytes = (w + 7) >> 3;
  let ones = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      out[y * w + x] = bit ? 255 : 0;
      ones += bit;
    }
  }
  // For stencil masks we don't know which value is "ink": ink is the minority.
  if (invert === null && ones < (w * h) / 2) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
  return out;
}

async function analysePdf(buf, opts) {
  const lib = loadPdfjs();
  let doc;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(buf), isOffscreenCanvasSupported: false, verbosity: 0,
      disableFontFace: true, useSystemFonts: false, stopAtErrors: false, isEvalSupported: false,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new AnalysisError('encrypted', 'This PDF is password-protected. Please remove the password (or "Print to PDF" a copy) and upload again.');
    throw new AnalysisError('corrupt', 'This PDF looks damaged and cannot be opened. Try re-saving it as PDF.');
  }
  const pages = doc.numPages;
  if (!pages) throw new AnalysisError('corrupt', 'This PDF has no pages.');
  if (pages > opts.maxPages) throw new AnalysisError('too_many_pages', `This PDF has ${pages} pages. The limit is ${opts.maxPages} pages per file — please split it.`);

  const OPS = lib.OPS;
  const coverage = [];
  const micro = { tiny: 0, small: 0, imageSuspect: null, imagesChecked: 0, imagesSkipped: 0 };

  for (let p = 1; p <= pages; p++) {
    let page;
    try { page = await doc.getPage(p); } catch (e) {
      throw new AnalysisError('corrupt', `Page ${p} of this PDF is damaged and cannot be read.`);
    }
    const [vx0, vy0, vx1, vy1] = page.view;
    const pageBox = [Math.min(vx0, vx1), Math.min(vy0, vy1), Math.max(vx0, vx1), Math.max(vy0, vy1)];
    const pageArea = area(pageBox) || 1;
    let ol;
    try { ol = await page.getOperatorList(); } catch (e) {
      throw new AnalysisError('corrupt', `Page ${p} of this PDF is damaged and cannot be read.`);
    }

    // graphics state
    let st = { ctm: [1, 0, 0, 1, 0, 0], fill: [0, 0, 0], stroke: [0, 0, 0], fillPattern: null, lineWidth: 1, clip: null };
    const stack = [];
    let path = null, pendingClip = false;
    let text = { tm: [1, 0, 0, 1, 0, 0], font: null, size: 0, mode: 0 };
    let colored = 0;

    const fontScale = (ref) => {
      try {
        const f = page.commonObjs.has(ref) ? page.commonObjs.get(ref) : null;
        if (f && f.fontMatrix && f.isType3Font) return Math.abs(f.fontMatrix[3]) * 1000 || 1;
      } catch (_) {}
      return 1;
    };
    const addArea = (box, frac = 1) => {
      const b = intersect(intersect(box, st.clip), pageBox);
      colored += area(b) * frac;
    };
    const getImg = (id) => {
      try {
        if (typeof id === 'object') return id;
        if (String(id).startsWith('g_') && page.commonObjs.has(id)) return page.commonObjs.get(id);
        if (page.objs.has(id)) return page.objs.get(id);
      } catch (_) {}
      return null;
    };
    const handleImage = (img, isMask) => {
      const box = boxThrough(st.ctm, 0, 0, 1, 1);
      const shown = area(intersect(intersect(box, st.clip), pageBox));
      if (shown <= 0 || !img) return;
      let px = null;
      if (isMask) {
        if (img.data && img.width) px = { data: unpackBits(img.data, img.width, img.height, null), w: img.width, h: img.height, channels: 1 };
        if (isColoured(st.fill)) addArea(box, 0.3);
      } else {
        px = imagePixels(img);
        if (px) addArea(box, colorFraction(px.data, px.w, px.h, px.channels));
      }
      // microtext check on images large enough to matter (scans, photos of documents)
      if (px && micro.imageSuspect === null && px.w * px.h >= 40000 && shown >= pageArea * 0.02) {
        const widthIn = (box[2] - box[0]) / 72, heightIn = (box[3] - box[1]) / 72;
        const dpi = Math.max(px.w / Math.max(widthIn, 0.01), px.h / Math.max(heightIn, 0.01));
        const g = toGray(px.data, px.w, px.h, px.channels);
        const r = detectMicrotext(g, px.w, px.h, dpi);
        if (r.checked) micro.imagesChecked++; else micro.imagesSkipped++;
        if (r.suspect) micro.imageSuspect = `page ${p}: ${r.reason}`;
      }
    };

    const { fnArray, argsArray } = ol;
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i], a = argsArray[i];
      switch (fn) {
        case OPS.save: stack.push({ ...st, ctm: st.ctm.slice() }); break;
        case OPS.restore: if (stack.length) st = stack.pop(); break;
        case OPS.transform: st.ctm = mul(a, st.ctm); break;
        case OPS.setLineWidth: st.lineWidth = a[0]; break;
        case OPS.setFillRGBColor: st.fill = parseColor(a); st.fillPattern = null; break;
        case OPS.setStrokeRGBColor: st.stroke = parseColor(a); break;
        case OPS.setFillColorN: // patterns may be stored by id; look them up
          st.fillPattern = (a || []).map((x) => (typeof x === 'string' && x[0] !== '#' ? getImg(x) || x : x)); break;
        case OPS.constructPath: {
          const mm = a[2];
          // pdf.js gives the path extent as [minX, maxX, minY, maxY]
          path = mm && isFinite(mm[0]) ? boxThrough(st.ctm, mm[0], mm[2], mm[1], mm[3]) : null;
          break;
        }
        case OPS.clip: case OPS.eoClip: pendingClip = true; break;
        case OPS.endPath:
          if (pendingClip && path) st.clip = intersect(st.clip, path);
          pendingClip = false; path = null; break;
        case OPS.fill: case OPS.eoFill: case OPS.fillStroke: case OPS.eoFillStroke:
        case OPS.closeFillStroke: case OPS.closeEOFillStroke: {
          const patternColoured = st.fillPattern && shadingIsColoured(st.fillPattern);
          if (path && (patternColoured || (!st.fillPattern && isColoured(st.fill)))) addArea(path);
          if (pendingClip && path) st.clip = intersect(st.clip, path);
          pendingClip = false; path = null; break;
        }
        case OPS.stroke: case OPS.closeStroke: {
          if (path && isColoured(st.stroke)) {
            const lw = Math.max(0.5, st.lineWidth * scaleOf(st.ctm));
            const per = 2 * ((path[2] - path[0]) + (path[3] - path[1]));
            colored += Math.min(area(path), per * lw);
          }
          if (pendingClip && path) st.clip = intersect(st.clip, path);
          pendingClip = false; path = null; break;
        }
        case OPS.shadingFill:
          if (shadingIsColoured(typeof a[0] === 'string' ? getImg(a[0]) : a)) addArea(st.clip || pageBox);
          break;
        case OPS.beginText: text.tm = [1, 0, 0, 1, 0, 0]; break;
        case OPS.setFont: text.font = a[0]; text.size = Math.abs(a[1]) * fontScale(a[0]); break;
        case OPS.setTextMatrix: text.tm = Array.from(a); break;
        case OPS.setTextRenderingMode: text.mode = a[0]; break;
        case OPS.showText: case OPS.showSpacedText: {
          const glyphs = a[0] || [];
          let n = 0;
          for (const g of glyphs) if (g && typeof g === 'object' && !g.isSpace && g.unicode !== ' ') n++;
          if (!n) break;
          const invisible = (text.mode & 3) === 3; // modes 3 and 7 draw nothing (e.g. OCR layers)
          if (invisible) break;
          const m = mul(text.tm, st.ctm);
          const eff = text.size * Math.hypot(m[2], m[3]); // printed glyph height in points
          if (eff > 0 && eff < TINY_PT) micro.tiny += n;
          else if (eff >= TINY_PT && eff < SMALL_PT) micro.small += n;
          const col = (text.mode % 4 === 1) ? st.stroke : st.fill;
          if (isColoured(col)) colored += Math.min(pageArea, n * eff * eff * 0.5);
          break;
        }
        case OPS.paintImageXObject: case OPS.paintImageXObjectRepeat:
          handleImage(getImg(a[0]), false); break;
        case OPS.paintInlineImageXObject:
          handleImage(a[0], false); break;
        case OPS.paintImageMaskXObject:
          handleImage(a[0], true); break;
        case OPS.paintImageMaskXObjectGroup: case OPS.paintSolidColorImageMask:
          if (isColoured(st.fill)) addArea(boxThrough(st.ctm, 0, 0, 1, 1), 0.3); break;
        default: break;
      }
    }
    coverage.push(round(withMinimum(Math.min(1, colored / pageArea))));
    try { page.cleanup(); } catch (_) {}
  }
  try { await doc.destroy(); } catch (_) {}

  // Verdict
  let verdict = 'ok', reason = '';
  if (micro.tiny >= BLOCK_TINY_CHARS) {
    verdict = 'blocked';
    reason = `This file contains a large amount of extremely small text (${micro.tiny} characters under ${TINY_PT}pt). Micro-printing like this is used on currency, cheques, certificates and IDs, so it cannot be printed here.`;
  } else if (micro.tiny >= SUSPECT_TINY_CHARS) {
    verdict = 'suspect'; reason = `Contains some extremely small text (${micro.tiny} characters under ${TINY_PT}pt).`;
  } else if (micro.small >= SUSPECT_SMALL_CHARS) {
    verdict = 'suspect'; reason = `Contains a lot of very small text (${micro.small} characters of ${TINY_PT}–${SMALL_PT}pt).`;
  } else if (micro.imageSuspect) {
    verdict = 'suspect'; reason = `Possible micro-printing in an image (${micro.imageSuspect}).`;
  }
  return { pages, coverage, micro: { verdict, reason }, info: { tinyChars: micro.tiny, smallChars: micro.small, imagesChecked: micro.imagesChecked } };
}

module.exports = { analysePdf };
