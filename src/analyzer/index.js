/*
 * Analysis runner: each file is analysed in its own worker thread, with a time
 * limit and a memory limit. A small queue keeps at most N analyses running at once.
 */
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');

let running = 0;
const waiting = [];

function runInWorker(filePath, claimedKind) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { filePath, claimedKind, opts: { maxPages: config.maxPages, maxImageMegapixels: config.maxImageMegapixels } },
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    });
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(msg);
    };
    const timer = setTimeout(() => finish({
      ok: false, code: 'timeout',
      message: `Checking this file took too long (over ${config.analysisTimeoutSec} seconds). Try a smaller file, or split a large scanned PDF.`,
    }), config.analysisTimeoutSec * 1000);
    worker.on('message', finish);
    worker.on('error', (e) => finish({
      ok: false, code: /memory/i.test(String(e)) ? 'oversized' : 'error',
      message: /memory/i.test(String(e)) ? 'This file is too large to check. Please use a smaller file.' : 'This file could not be checked. Please try another file.',
      detail: String(e && e.stack || e),
    }));
    worker.on('exit', () => finish({ ok: false, code: 'error', message: 'This file could not be checked. Please try another file.' }));
  });
}

/** Queue an analysis. Resolves to { ok:true, result } or { ok:false, code, message }. */
function analyse(filePath, claimedKind) {
  return new Promise((resolve) => {
    const start = () => {
      running++;
      runInWorker(filePath, claimedKind).then((r) => {
        running--;
        if (waiting.length) waiting.shift()();
        resolve(r);
      });
    };
    if (running < config.analysisConcurrency) start(); else waiting.push(start);
  });
}

module.exports = { analyse };
