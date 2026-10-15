/*
 * Analyse one file buffer (called inside a worker thread, or directly in tests).
 * Result: { kind, pages, coverage: [0..1 per page], micro: { verdict, reason } }
 */
'use strict';
const { sniff } = require('./sniff');
const { analyseImage, AnalysisError } = require('./image');
const { analysePdf } = require('./pdf');

const DEFAULTS = { maxPages: 200, maxImageMegapixels: 50 };

async function analyseFile(buf, claimedKind, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const actual = sniff(buf);
  if (actual !== claimedKind) {
    if (actual === 'zip' || actual === 'ole') {
      throw new AnalysisError('mismatch', 'This looks like a Word, Excel or PowerPoint file. Please open it and use "Save as PDF", then upload the PDF.');
    }
    if (actual === 'pdf' || actual === 'jpg' || actual === 'png') {
      throw new AnalysisError('mismatch', `This file's contents don't match its name (it is really a ${actual.toUpperCase()}). Please rename it correctly or re-save it.`);
    }
    throw new AnalysisError('mismatch', "This file's contents don't match its name, or it is not a PDF, JPG or PNG.");
  }
  const result = actual === 'pdf' ? await analysePdf(buf, opts) : analyseImage(buf, actual, opts);
  return { kind: actual, ...result };
}

module.exports = { analyseFile, AnalysisError };
