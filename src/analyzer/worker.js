/*
 * Runs inside a worker thread so heavy analysis never blocks the website.
 */
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { analyseFile } = require('./core');

(async () => {
  try {
    const buf = fs.readFileSync(workerData.filePath);
    const result = await analyseFile(buf, workerData.claimedKind, workerData.opts);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, code: e.code || 'error', message: e.code ? e.message : 'This file could not be checked. Please try another file.', detail: String(e && e.stack || e) });
  }
})();
