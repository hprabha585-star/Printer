/*
 * API for the Print Connector desktop app running on the shop computers.
 *
 * Coordination between several computers happens HERE, on the server:
 *   - a job is claimed atomically (only one computer can ever get it);
 *   - a printer can have only ONE active job across all computers;
 *   - an active job older than 15 minutes no longer locks its printer
 *     (so a crashed computer can't block a printer forever). Such a job is
 *     NOT printed again automatically — the owner sees it as "stuck" and can retry.
 */
'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { getSettings } = require('../settings');
const { sendStoredFile } = require('./owner');
const { UserError, ah, rateLimit } = require('../util');

const router = express.Router();
const STALE_LOCK_SEC = Number(process.env.STALE_LOCK_SEC || 15 * 60); // 15 minutes

router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Please wait 15 minutes.' }), ah(async (req, res) => {
  const password = String((req.body || {}).password || '');
  const s = await getSettings();
  const ok = auth.isMasterKey(password) || (s.owner_password_hash && auth.verifyPassword(password, s.owner_password_hash));
  if (!ok) throw new UserError(401, 'That password is not correct. Use the owner password (or the master key).', 'bad_login');
  res.json({ token: auth.issueConnectorToken(), shop_name: s.shop_name });
}));

router.use(auth.requireConnector);

const printerList = () => db.q('SELECT label, color_capable, enabled FROM printers ORDER BY sort_order, id');

router.post('/heartbeat', ah(async (req, res) => {
  const b = req.body || {};
  const computer = String(b.computer || '').trim().slice(0, 120);
  if (!computer) throw new UserError(400, 'Missing computer name.');
  const printers = Array.isArray(b.printers) ? b.printers.slice(0, 30).map((p) => ({
    local: String(p.local || '').slice(0, 120), label: p.label ? String(p.label).slice(0, 80) : null, status: String(p.status || '').slice(0, 20),
  })) : [];
  await db.q(`INSERT INTO connectors (computer_name, last_seen, first_seen, printers_json, version)
              VALUES (?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)
              ON DUPLICATE KEY UPDATE last_seen = UTC_TIMESTAMP(), printers_json = VALUES(printers_json), version = VALUES(version)`,
  [computer, JSON.stringify(printers), String(b.version || '').slice(0, 30)]);
  const s = await getSettings();
  res.json({ printers: await printerList(), shop_name: s.shop_name });
}));

router.get('/printers', ah(async (req, res) => res.json(await printerList())));

// Pending jobs, oldest paid first
router.get('/jobs', ah(async (req, res) => {
  const rows = await db.q(`SELECT j.id, j.ticket, j.file_name, j.file_kind, j.page_start, j.page_end, j.total_pages, j.copies, j.color_mode,
      (j.color_mode = 'color' AND (j.pages_partial + j.pages_full) > 0) AS needs_color
      FROM jobs j JOIN orders o ON o.id = j.order_id
      WHERE j.print_status = 'queued' ORDER BY o.paid_at, j.id LIMIT 50`);
  res.json(rows.map((r) => ({ ...r, needs_color: !!r.needs_color })));
}));

router.post('/jobs/:id/claim', ah(async (req, res) => {
  const id = Number(req.params.id);
  const label = String((req.body || {}).printer_label || '');
  const computer = String((req.body || {}).computer || '').slice(0, 120);
  if (!label || !computer) throw new UserError(400, 'printer_label and computer are required.');
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await db.tx(async (conn) => {
        const [[p]] = await conn.query('SELECT * FROM printers WHERE label = ? FOR UPDATE', [label]);
        if (!p || !p.enabled) return { claimed: false, reason: 'printer_unavailable' };
        const [[j]] = await conn.query('SELECT * FROM jobs WHERE id = ? FOR UPDATE', [id]);
        if (!j || j.print_status !== 'queued' || j.payment_status !== 'paid') return { claimed: false, reason: 'job_taken' };
        const needsColor = j.color_mode === 'color' && (j.pages_partial + j.pages_full) > 0;
        if (needsColor && !p.color_capable) return { claimed: false, reason: 'printer_not_color' };
        const [busy] = await conn.query(
          `SELECT id FROM jobs WHERE printer_label = ? AND print_status = 'printing'
             AND claimed_at > UTC_TIMESTAMP() - INTERVAL ? SECOND LIMIT 1`, [label, STALE_LOCK_SEC]);
        if (busy.length) return { claimed: false, reason: 'printer_busy' };
        const [u] = await conn.query(
          `UPDATE jobs SET print_status = 'printing', printer_label = ?, computer_name = ?, claimed_at = UTC_TIMESTAMP(),
             attempts = attempts + 1, error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND print_status = 'queued'`,
          [label, computer, id]);
        if (!u.affectedRows) return { claimed: false, reason: 'job_taken' };
        return {
          claimed: true,
          job: {
            id: j.id, ticket: j.ticket, file_name: j.file_name, file_kind: j.file_kind, page_start: j.page_start,
            page_end: j.page_end, total_pages: j.total_pages, copies: j.copies,
            monochrome: !needsColor, color_mode: j.color_mode,
          },
        };
      });
      return res.status(out.claimed ? 200 : 409).json(out);
    } catch (e) {
      if ((e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < 3) continue;
      throw e;
    }
  }
}));

router.get('/jobs/:id/file', ah(async (req, res) => {
  const [j] = await db.q(`SELECT file_path, file_name, file_kind FROM jobs WHERE id = ? AND print_status = 'printing'`, [req.params.id]);
  if (!j || !j.file_path) throw new UserError(404, 'File not available.');
  sendStoredFile(res, j);
}));

router.post('/jobs/:id/complete', ah(async (req, res) => {
  const b = req.body || {};
  const ok = !!b.ok;
  const computer = String(b.computer || '').slice(0, 120);
  const label = b.printer_label ? String(b.printer_label).slice(0, 80) : null;
  const err = ok ? null : String(b.error || 'Printing failed').slice(0, 500);
  const r = await db.q(
    `UPDATE jobs SET print_status = ?, finished_at = UTC_TIMESTAMP(), error = ?, printer_label = COALESCE(?, printer_label),
       updated_at = UTC_TIMESTAMP() WHERE id = ? AND print_status = 'printing' AND computer_name = ?`,
    [ok ? 'completed' : 'failed', err, label, req.params.id, computer]);
  if (!r.affectedRows) throw new UserError(409, 'This job is not printing on this computer (it may have been retried or cancelled).', 'not_owner');
  res.json({ ok: true });
}));

module.exports = router;
