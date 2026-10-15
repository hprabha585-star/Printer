/*
 * Owner dashboard API. Everything except /login needs the X-Owner-Key header.
 * (Literal routes are declared before ":id" routes so they are never shadowed.)
 */
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const orders = require('../orders');
const { getSettings, ownerSettings, updateSettings } = require('../settings');
const { UserError, ah, rateLimit } = require('../util');

const router = express.Router();
const TZ_MIN = Number(process.env.SHOP_TZ_OFFSET_MIN || 330); // India = UTC+5:30
const STUCK_MIN = 10;

/* ---------- login ---------- */

router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many sign-in attempts. Please wait 15 minutes.' }), ah(async (req, res) => {
  const { username, password, master_key: masterKey } = req.body || {};
  const s = await getSettings();
  let ok = false;
  if (masterKey) ok = auth.isMasterKey(masterKey);
  else if (username && password && s.owner_username) {
    ok = String(username).trim().toLowerCase() === s.owner_username.toLowerCase() && auth.verifyPassword(password, s.owner_password_hash);
  }
  if (!ok) {
    const msg = masterKey ? 'That master key is not correct.'
      : !s.owner_username ? 'No login has been set up yet. Sign in with the master key first.'
        : 'Wrong username or password.';
    throw new UserError(401, msg, 'bad_login');
  }
  res.json({ token: await auth.issueOwnerToken(), needs_setup: !s.owner_username, username: s.owner_username || null });
}));

router.use(auth.requireOwner);

router.get('/me', ah(async (req, res) => {
  const s = await getSettings();
  res.json({ username: s.owner_username || null, needs_setup: !s.owner_username });
}));

router.post('/credentials', ah(async (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(username)) throw new UserError(400, 'Username: 3–60 letters or numbers (no spaces).');
  if (password.length < 8) throw new UserError(400, 'Password must be at least 8 characters.');
  await db.q('UPDATE settings SET owner_username = ?, owner_password_hash = ?, session_version = session_version + 1, updated_at = UTC_TIMESTAMP() WHERE id = 1',
    [username, auth.hashPassword(password)]);
  res.json({ ok: true, token: await auth.issueOwnerToken(), username });
}));

/* ---------- settings & printers ---------- */

router.get('/settings', ah(async (req, res) => res.json(ownerSettings(await getSettings()))));

router.put('/settings', ah(async (req, res) => {
  try { res.json(ownerSettings(await updateSettings(req.body || {}))); } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(400, e.message);
  }
}));

router.get('/printers', ah(async (req, res) => {
  res.json(await db.q('SELECT id, label, color_capable, enabled FROM printers ORDER BY sort_order, id'));
}));

/** Replace the printer list. Body: [{ id?, label, color_capable, enabled }] */
router.put('/printers', ah(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  if (!list.length || list.length > 12) throw new UserError(400, 'Add between 1 and 12 printers.');
  const labels = list.map((p) => String(p.label || '').trim());
  if (labels.some((l) => !l || l.length > 80)) throw new UserError(400, 'Every printer needs a name (up to 80 characters).');
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new UserError(400, 'Two printers have the same name.');
  await db.tx(async (conn) => {
    const [existing] = await conn.query('SELECT id, label FROM printers');
    const keep = new Set();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const vals = [labels[i], p.color_capable ? 1 : 0, p.enabled === false || p.enabled === 0 ? 0 : 1, i + 1];
      const ex = existing.find((e) => e.id === Number(p.id));
      if (ex) {
        await conn.query('UPDATE printers SET label = ?, color_capable = ?, enabled = ?, sort_order = ? WHERE id = ?', [...vals, ex.id]);
        // a rename keeps history and active jobs pointing at the right printer
        if (ex.label !== labels[i]) await conn.query('UPDATE jobs SET printer_label = ? WHERE printer_label = ?', [labels[i], ex.label]);
        keep.add(ex.id);
      } else {
        const [r] = await conn.query('INSERT INTO printers (label, color_capable, enabled, sort_order) VALUES (?,?,?,?)', vals);
        keep.add(r.insertId);
      }
    }
    const remove = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (remove.length) await conn.query('DELETE FROM printers WHERE id IN (?)', [remove]);
  });
  res.json(await db.q('SELECT id, label, color_capable, enabled FROM printers ORDER BY sort_order, id'));
}));

router.get('/connectors', ah(async (req, res) => {
  const rows = await db.q(`SELECT computer_name, last_seen, printers_json, version,
      TIMESTAMPDIFF(SECOND, last_seen, UTC_TIMESTAMP()) AS age FROM connectors ORDER BY computer_name`);
  res.json(rows.map((r) => ({
    computer_name: r.computer_name, last_seen: r.last_seen, seconds_ago: r.age, online: r.age !== null && r.age <= 60,
    printers: safeJson(r.printers_json, []), version: r.version,
  })));
}));

router.delete('/connectors/:name', ah(async (req, res) => {
  await db.q('DELETE FROM connectors WHERE computer_name = ?', [req.params.name]);
  res.json({ ok: true });
}));

/* ---------- dashboard data ---------- */

router.get('/stats', ah(async (req, res) => {
  const local = `DATE_ADD(o.paid_at, INTERVAL ${TZ_MIN} MINUTE)`;
  const nowLocal = `DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${TZ_MIN} MINUTE)`;
  const revenue = async (where) => {
    const rows = await db.q(`SELECT o.payment_method m, COALESCE(SUM(j.amount_paise), 0) total
      FROM orders o JOIN jobs j ON j.order_id = o.id
      WHERE o.payment_status = 'paid' AND j.print_status <> 'cancelled' AND ${where}
      GROUP BY o.payment_method`);
    const out = { total: 0, upi: 0, cash: 0, gateway: 0 };
    for (const r of rows) { out[r.m === 'gateway' ? 'gateway' : r.m === 'cash' ? 'cash' : 'upi'] += Number(r.total); out.total += Number(r.total); }
    return out;
  };
  const today = await revenue(`DATE(${local}) = DATE(${nowLocal})`);
  const month = await revenue(`DATE_FORMAT(${local}, '%Y-%m') = DATE_FORMAT(${nowLocal}, '%Y-%m')`);
  const [{ printed }] = await db.q(`SELECT COUNT(*) printed FROM jobs WHERE print_status = 'completed'
      AND DATE(DATE_ADD(finished_at, INTERVAL ${TZ_MIN} MINUTE)) = DATE(${nowLocal})`);
  const [{ queue }] = await db.q(`SELECT COUNT(*) queue FROM jobs WHERE print_status IN ('queued','printing','held')`);
  res.json({ today, month, printed_today: printed, queue });
}));

router.get('/attention', ah(async (req, res) => {
  const payments = await db.q(`SELECT o.token, o.total_paise, o.payment_status, o.payment_method, o.utr, o.created_at,
      COUNT(j.id) files FROM orders o JOIN jobs j ON j.order_id = o.id
      WHERE o.payment_status IN ('pending_cash','pending_verify') GROUP BY o.id ORDER BY o.created_at`);
  const held = await db.q(`SELECT j.id, j.ticket, j.file_name, j.micro_reason, j.amount_paise, j.page_start, j.page_end, o.token
      FROM jobs j JOIN orders o ON o.id = j.order_id WHERE j.print_status = 'held' ORDER BY j.id`);
  const s = await getSettings();
  const s2 = ownerSettings(s);
  const warnings = [];
  if (!s.upi_id) warnings.push('Add your UPI ID in Settings so customers can pay by UPI.');
  if (s.payment_mode === 'gateway' && s2.payment_mode !== 'gateway') warnings.push('Gateway mode is selected but no gateway is set up, so UTR mode is being used.');
  const [{ online }] = await db.q('SELECT COUNT(*) online FROM connectors WHERE last_seen > UTC_TIMESTAMP() - INTERVAL 60 SECOND');
  if (!online) warnings.push('No shop computer is connected. Start the Print Connector on the counter PC.');
  res.json({ payments, held, warnings });
}));

router.get('/jobs', ah(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = await db.q(`SELECT j.id, j.ticket, j.file_name, j.file_kind, j.total_pages, j.page_start, j.page_end, j.copies,
      j.color_mode, j.pages_bw, j.pages_partial, j.pages_full, j.amount_paise, j.micro_verdict, j.micro_reason,
      j.print_status, j.printer_label, j.computer_name, j.claimed_at, j.finished_at, j.error, j.note, j.refund_if_paid,
      j.created_at, (j.file_path = '' OR j.file_path IS NULL) AS file_gone,
      o.token, o.payment_status, o.payment_method, o.utr,
      TIMESTAMPDIFF(MINUTE, j.claimed_at, UTC_TIMESTAMP()) AS printing_minutes
      FROM jobs j JOIN orders o ON o.id = j.order_id ORDER BY j.id DESC LIMIT ?`, [limit]);
  res.json(rows.map((r) => ({ ...r, stuck: r.print_status === 'printing' && r.printing_minutes >= STUCK_MIN, file_gone: !!r.file_gone })));
}));

router.get('/jobs/:id/file', ah(async (req, res) => {
  const [j] = await db.q('SELECT file_path, file_name, file_kind FROM jobs WHERE id = ?', [req.params.id]);
  if (!j || !j.file_path) throw new UserError(404, 'This file has already been deleted from the server.');
  sendStoredFile(res, j);
}));

router.post('/jobs/:id/review', ah(async (req, res) => {
  res.json(await orders.reviewJob(Number(req.params.id), !!(req.body || {}).approve));
}));

router.post('/jobs/:id/retry', ah(async (req, res) => {
  res.json(await orders.retryJob(Number(req.params.id)));
}));

router.post('/orders/:token/confirm', ah(async (req, res) => res.json(await orders.ownerConfirm(req.params.token))));
router.post('/orders/:token/reject', ah(async (req, res) => res.json(await orders.ownerReject(req.params.token))));

/* ---------- helpers ---------- */

const TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };
function sendStoredFile(res, j) {
  const full = path.join(config.storageDir, 'uploads', path.basename(j.file_path));
  if (!fs.existsSync(full)) throw new UserError(404, 'This file has already been deleted from the server.');
  res.set('Content-Type', TYPES[j.file_kind] || 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(j.file_name).replace(/"/g, '')}"`);
  res.set('Cache-Control', 'no-store');
  fs.createReadStream(full).pipe(res);
}
function safeJson(s, d) { try { return JSON.parse(s); } catch (_) { return d; } }

module.exports = router;
module.exports.sendStoredFile = sendStoredFile;
