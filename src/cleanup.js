/*
 * Housekeeping, runs every 15 minutes:
 *  - analysed files that were never ordered are deleted after UPLOAD_TTL_HOURS;
 *  - files of finished jobs (printed / cancelled / failed) are deleted from the
 *    server after FILE_RETENTION_DAYS (they stay openable from the dashboard until then);
 *  - orders never paid within 24 hours are closed;
 *  - stray temporary upload files are removed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');

const dir = () => path.join(config.storageDir, 'uploads');
const rm = (name) => fs.promises.unlink(path.join(dir(), path.basename(name))).catch(() => {});

async function runCleanup() {
  // 1. abandoned uploads
  const old = await db.q('SELECT id, file_path FROM uploads WHERE created_at < UTC_TIMESTAMP() - INTERVAL ? HOUR', [config.uploadTtlHours]);
  for (const u of old) {
    await db.q('DELETE FROM uploads WHERE id = ?', [u.id]);
    const [{ n }] = await db.q(`SELECT COUNT(*) n FROM jobs WHERE file_path = ?`, [u.file_path]);
    if (!n) await rm(u.file_path);
  }

  // 2. orders never paid within 24 hours are closed so their files can be removed
  const stale = await db.q(`SELECT id FROM orders WHERE payment_status IN ('unpaid','gateway_pending')
      AND created_at < UTC_TIMESTAMP() - INTERVAL 24 HOUR`);
  for (const o of stale) {
    await db.q(`UPDATE orders SET payment_status = 'expired', updated_at = UTC_TIMESTAMP() WHERE id = ? AND payment_status IN ('unpaid','gateway_pending')`, [o.id]);
    await db.q(`UPDATE jobs SET print_status = 'cancelled', payment_status = 'expired', finished_at = UTC_TIMESTAMP() - INTERVAL 30 DAY
                WHERE order_id = ? AND print_status = 'awaiting_payment'`, [o.id]);
  }

  // 3. finished jobs older than the retention period
  const done = await db.q(`SELECT id, file_path FROM jobs WHERE file_path <> ''
      AND print_status IN ('completed','cancelled','failed')
      AND COALESCE(finished_at, updated_at) < UTC_TIMESTAMP() - INTERVAL ? DAY`, [config.fileRetentionDays]);
  for (const j of done) {
    await db.q(`UPDATE jobs SET file_path = '' WHERE id = ?`, [j.id]);
    // the same file can back several jobs (same document ordered twice)
    const [{ n }] = await db.q(`SELECT (SELECT COUNT(*) FROM jobs WHERE file_path = ?) + (SELECT COUNT(*) FROM uploads WHERE file_path = ?) n`, [j.file_path, j.file_path]);
    if (!n) await rm(j.file_path);
  }

  // 4. stray temp files from interrupted uploads
  try {
    for (const f of await fs.promises.readdir(dir())) {
      if (!f.endsWith('.tmp')) continue;
      const st = await fs.promises.stat(path.join(dir(), f));
      if (Date.now() - st.mtimeMs > 3600e3) await rm(f);
    }
  } catch (_) {}

  // 5. very old connector heartbeats and webhook events
  await db.q('DELETE FROM payment_events WHERE received_at < UTC_TIMESTAMP() - INTERVAL 180 DAY');
}

function startCleanup() {
  const tick = () => runCleanup().catch((e) => console.error('cleanup failed:', e.message));
  setTimeout(tick, 20e3).unref();
  setInterval(tick, 15 * 60e3).unref();
}

module.exports = { runCleanup, startCleanup };
