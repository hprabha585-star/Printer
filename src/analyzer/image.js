/*
 * JPG / PNG analysis (pure JavaScript decoders) + shared pixel helpers
 * also used for images embedded inside PDFs.
 */
'use strict';
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { detectMicrotext } = require('./microtext');

const CHROMA_MIN = 40;          // max(r,g,b) - min(r,g,b) above this = visibly coloured (0..255)
const COLOR_NOISE_FLOOR = 0.003; // below 0.3% coloured pixels = scanner/JPEG noise, not colour
const MIN_COLOR = 0.01;          // any real colour counts as at least 1% coverage
const A4_IN = [8.27, 11.69];

class AnalysisError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Fraction (0..1) of visibly coloured pixels.
 * channels: 1 (gray), 3 (RGB) or 4 (RGBA; fully transparent pixels are skipped)
 */
function colorFraction(data, w, h, channels) {
  if (channels < 3) return 0;
  const total = w * h;
  const stride = Math.max(1, Math.floor(total / 1500000)); // sample at most ~1.5M pixels
  let colored = 0, counted = 0;
  for (let i = 0; i < total; i += stride) {
    const o = i * channels;
    if (channels === 4 && data[o + 3] < 16) continue;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    counted++;
    if (mx - mn > CHROMA_MIN) colored++;
  }
  if (!counted) return 0;
  const f = colored / counted;
  return f < COLOR_NOISE_FLOOR ? 0 : f;
}

/** Any real colour counts for at least a small minimum. */
function withMinimum(f) {
  return f > 0 ? Math.min(1, Math.max(MIN_COLOR, f)) : 0;
}

/** Convert to 8-bit grayscale (transparent = white). */
function toGray(data, w, h, channels) {
  const n = w * h;
  if (channels === 1) return data instanceof Uint8Array ? data : Uint8Array.from(data);
  const g = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    let v = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
    if (channels === 4) { const a = data[o + 3]; v = (v * a + 255 * (255 - a)) / 255; }
    g[i] = v;
  }
  return g;
}

/** Decode a JPG/PNG buffer into raw pixels. */
function decode(buf, kind, maxMegapixels) {
  // Check the size from the header before decoding, so huge images can't exhaust memory.
  const dims = kind === 'png' ? pngSize(buf) : jpegSize(buf);
  if (!dims) throw new AnalysisError('corrupt', 'This image looks damaged and cannot be opened.');
  if (dims.w * dims.h > maxMegapixels * 1e6) {
    throw new AnalysisError('oversized', `This image is too large (${dims.w}×${dims.h} pixels). Please resize it or save it as a PDF.`);
  }
  try {
    if (kind === 'png') {
      const png = PNG.sync.read(buf);
      return { data: png.data, w: png.width, h: png.height, channels: 4 };
    }
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 1024, maxResolutionInMP: maxMegapixels });
    return { data: j.data, w: j.width, h: j.height, channels: 3 };
  } catch (e) {
    throw new AnalysisError('corrupt', 'This image looks damaged and cannot be opened.');
  }
}

function pngSize(buf) {
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Physical print resolution of a stand-alone image fitted onto an A4 page. */
function fittedDpi(w, h) {
  const portrait = h >= w;
  const pw = portrait ? A4_IN[0] : A4_IN[1], ph = portrait ? A4_IN[1] : A4_IN[0];
  // fitted to the page (keeping proportions): the limiting side decides the scale
  return Math.max(w / pw, h / ph);
}

function analyseImage(buf, kind, opts) {
  const img = decode(buf, kind, opts.maxImageMegapixels);
  const coverage = withMinimum(colorFraction(img.data, img.w, img.h, img.channels));
  const gray = toGray(img.data, img.w, img.h, img.channels);
  const mt = detectMicrotext(gray, img.w, img.h, fittedDpi(img.w, img.h));
  return {
    pages: 1,
    coverage: [round(coverage)],
    micro: mt.suspect
      ? { verdict: 'suspect', reason: 'Possible micro-printing: ' + mt.reason }
      : { verdict: 'ok', reason: mt.checked ? '' : 'Image ' + mt.reason },
    info: { width: img.w, height: img.h },
  };
}

const round = (v) => Math.round(v * 10000) / 10000;

module.exports = { analyseImage, colorFraction, withMinimum, toGray, detectMicrotext, AnalysisError, round, CHROMA_MIN };
