/*
 * Orders, payments and job state changes.
 *
 * An ORDER is one payment covering one or more JOBS (one job per file).
 *
 * Order payment_status:
 *   unpaid          waiting for the customer to pay
 *   pending_cash    customer chose "pay cash at the counter"
 *   pending_verify  UTR entered, owner is checking their UPI app
 *   gateway_pending customer was sent to the payment gateway
 *   paid            money confirmed (or UTR accepted with verification off)
 *   rejected        owner said the money never arrived (fake UTR etc.)
 *   refunded        gateway reported a refund
 *   expired         never paid within 24 hours (closed automatically)
 *
 * Job print_status:
 *   awaiting_payment -> queued -> printing -> completed | failed
 *                    -> held (possible micro-printing, waits for owner) -> queued | cancelled
 *   cancelled (order rejected / file refused)
 */
'use strict';
const crypto = require('crypto');
const db = require('./db');
const pricing = require('../public/shared/pricing');
const { getSettings } = require('./settings');
const { UserError, randomId } = require('./util');
const payments = require('./payments');
const config = require('./config');

const MAX_FILES_PER_ORDER = 20;

/* ---------- order creation ---------- */

async function newToken(conn) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const digits = attempt < 25 ? 4 : attempt < 35 ? 5 : 6;
    const n = crypto.randomInt(10 ** (digits - 1), 10 ** digits);
    const token = `PX-${n}`;
    const [rows] = await conn.query('SELECT id FROM orders WHERE token = ?', [token]);
    if (!rows.length) return token;
  }
  throw new Error('could not allocate order token');
}

/**
 * items: [{ upload_id, mode: 'bw'|'color', start, end, copies, note }]
 * Prices are recomputed here from the stored analysis — browser numbers are ignored.
 */
async function createOrder(items) {
  if (!Array.isArray(items) || !items.length) throw new UserError(400, 'Your cart is empty.');
  if (items.length > MAX_FILES_PER_ORDER) throw new UserError(400, `At most ${MAX_FILES_PER_ORDER} files per order.`);

  return db.tx(async (conn) => {
    const s = await getSettings(conn);
    if (!s.accepting_orders) throw new UserError(503, 'Sorry, the shop is not accepting orders right now.', 'closed');
    const rates = pricing.ratesFromSettings(s);

    const ids = [...new Set(items.map((i) => String(i.upload_id || '')))];
    const [ups] = await conn.query('SELECT * FROM uploads WHERE id IN (?) FOR UPDATE', [ids]);
    const byId = new Map(ups.map((u) => [u.id, u]));

    const lines = items.map((it, idx) => {
      const u = byId.get(String(it.upload_id || ''));
      if (!u) throw new UserError(410, `File ${idx + 1} has expired or was already ordered. Please add it again.`, 'upload_missing');
      const coverage = JSON.parse(u.coverage_json || '[]');
      const start = toInt(it.start, 1), end = toInt(it.end, u.page_count), copies = toInt(it.copies, 1);
      if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(copies)) {
        throw new UserError(400, `File ${idx + 1}: pages and copies must be whole numbers.`);
      }
      if (start < 1 || end > u.page_count || start > end) throw new UserError(400, `File ${idx + 1}: pages must be between 1 and ${u.page_count}.`);
      if (copies < 1 || copies > 99) throw new UserError(400, `File ${idx + 1}: copies must be between 1 and 99.`);
      const mode = it.mode === 'color' ? 'color' : 'bw';
      const p = pricing.priceFile({ coverage, start, end, copies, mode }, rates);
      return { u, start, end, copies, mode, p, note: String(it.note || '').trim().slice(0, 300) || null };
    });
    const total = lines.reduce((a, l) => a + l.p.amount, 0);
    if (total <= 0) throw new UserError(400, 'The order total is zero. Please ask the shop to set its prices.');

    const token = await newToken(conn);
    const key = randomId(10);
    const [r] = await conn.query(
      `INSERT INTO orders (token, access_key, total_paise, payment_status, created_at, updated_at)
       VALUES (?, ?, ?, 'unpaid', UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [token, key, total]);
    const orderId = r.insertId;

    let n = 0;
    for (const l of lines) {
      n++;
      await conn.query(
        `INSERT INTO jobs (order_id, ticket, upload_id, file_path, file_name, file_kind, total_pages,
          page_start, page_end, copies, color_mode, note, pages_bw, pages_partial, pages_full,
          rate_bw, rate_partial, rate_full, color_threshold, amount_paise, payment_status,
          micro_verdict, micro_reason, print_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'unpaid', ?, ?, 'awaiting_payment', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [orderId, `${token}-${n}`, l.u.id, l.u.file_path, l.u.file_name, l.u.file_kind, l.u.page_count,
          l.start, l.end, l.copies, l.mode, l.note, l.p.bw, l.p.partial, l.p.full,
          s.rate_bw, s.rate_partial, s.rate_full, s.color_threshold, l.p.amount,
          l.u.micro_verdict, l.u.micro_reason]);
    }
    // The upload rows are kept until they expire, so a customer who goes back to
    // change the order before paying can re-use the files without uploading again.
    return { token, key, total_paise: total };
  });
}

function toInt(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/* ---------- lookups ---------- */

async function getOrderForCustomer(token, key, conn) {
  const run = conn ? (s, p) => conn.query(s, p).then((r) => r[0]) : db.q;
  const [o] = await run('SELECT * FROM orders WHERE token = ?' + (conn ? ' FOR UPDATE' : ''), [String(token || '').toUpperCase()]);
  if (!o || !key || !crypto.timingSafeEqual(Buffer.from(String(key).padEnd(20).slice(0, 20)), Buffer.from(o.access_key.padEnd(20)))) {
    throw new UserError(404, 'Order not found. Please check the link.', 'not_found');
  }
  return o;
}

async function getOrderByToken(token, conn) {
  const run = conn ? (s, p) => conn.query(s, p).then((r) => r[0]) : db.q;
  const [o] = await run('SELECT * FROM orders WHERE token = ?' + (conn ? ' FOR UPDATE' : ''), [String(token || '').toUpperCase()]);
  if (!o) throw new UserError(404, 'Order not found.', 'not_found');
  return o;
}

/** What the customer sees for each file. */
function customerState(order, job) {
  if (job.print_status === 'cancelled' || ['rejected', 'refunded', 'expired'].includes(order.payment_status)) return 'cancelled';
  switch (order.payment_status) {
    case 'unpaid': case 'gateway_pending': return 'waiting_payment';
    case 'pending_cash': return 'waiting_cash';
    case 'pending_verify': return 'verifying_upi';
    default: break;
  }
  if (job.print_status === 'held') return 'checking_file';
  return job.print_status; // queued | printing | completed | failed
}

const OVERALL_ORDER = ['failed', 'waiting_payment', 'waiting_cash', 'verifying_upi', 'checking_file', 'printing', 'queued', 'completed', 'cancelled'];

async function orderStatus(token, key) {
  let order = await getOrderForCustomer(token, key);
  // Gateway mode: reconcile with the gateway when the customer polls.
  if (order.payment_status === 'gateway_pending' && order.gateway_ref) {
    await reconcileGateway(order).catch(() => {});
    order = await getOrderForCustomer(token, key);
  }
  const jobs = await db.q('SELECT * FROM jobs WHERE order_id = ? ORDER BY id', [order.id]);
  const files = jobs.map((j) => ({
    ticket: j.ticket, file_name: j.file_name, pages: `${j.page_start}-${j.page_end}`, copies: j.copies,
    mode: j.color_mode, amount_paise: j.amount_paise, state: customerState(order, j),
    breakdown: pricing.describe({ pages: j.page_end - j.page_start + 1, bw: j.pages_bw, partial: j.pages_partial, full: j.pages_full, copies: j.copies }),
    error: j.print_status === 'failed' ? 'There was a problem at the printer. Please tell the shop.' : null,
  }));
  const active = files.filter((f) => f.state !== 'cancelled');
  let overall = 'cancelled';
  if (active.length) {
    overall = active.every((f) => f.state === 'completed') ? 'completed'
      : OVERALL_ORDER.find((st) => st !== 'completed' && active.some((f) => f.state === st)) || 'queued';
  }
  return {
    token: order.token, total_paise: order.total_paise, payment_status: order.payment_status,
    payment_method: order.payment_method, utr: order.utr, overall, files,
    refund_if_paid: !!order.refund_if_paid,
  };
}

/* ---------- payment state changes ---------- */

/** Mark the order paid and release its files (inside a transaction). */
async function markPaid(conn, order, method, extra = {}) {
  await conn.query(
    `UPDATE orders SET payment_status = 'paid', payment_method = ?, paid_at = COALESCE(paid_at, UTC_TIMESTAMP()),
      utr = COALESCE(?, utr), gateway_ref = COALESCE(?, gateway_ref), updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [method, extra.utr || null, extra.gatewayRef || null, order.id]);
  await conn.query(
    `UPDATE jobs SET payment_status = 'paid', payment_method = ?, utr = COALESCE(?, utr), gateway_ref = COALESCE(?, gateway_ref),
      print_status = CASE WHEN micro_verdict = 'suspect' AND reviewed = 0 THEN 'held' ELSE 'queued' END,
      updated_at = UTC_TIMESTAMP()
     WHERE order_id = ? AND print_status = 'awaiting_payment'`,
    [method, extra.utr || null, extra.gatewayRef || null, order.id]);
}

async function setJobsPayment(conn, orderId, status, method, utr) {
  await conn.query('UPDATE jobs SET payment_status = ?, payment_method = ?, utr = ?, updated_at = UTC_TIMESTAMP() WHERE order_id = ? AND print_status = \'awaiting_payment\'',
    [status, method, utr, orderId]);
}

const UTR_RE = /^\d{12}$/;

async function submitUtr(token, key, utrRaw) {
  const utr = String(utrRaw || '').trim();
  if (!UTR_RE.test(utr)) throw new UserError(400, 'The UTR must be exactly 12 digits (numbers only).', 'bad_utr');
  try {
    return await db.tx(async (conn) => {
      const order = await getOrderForCustomer(token, key, conn);
      if (!['unpaid', 'pending_cash'].includes(order.payment_status)) {
        throw new UserError(409, 'This order has already been paid or closed.', 'not_payable');
      }
      const s = await getSettings(conn);
      if (s.verify_upi) {
        await conn.query(`UPDATE orders SET payment_status = 'pending_verify', payment_method = 'upi', utr = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [utr, order.id]);
        await setJobsPayment(conn, order.id, 'pending_verify', 'upi', utr);
      } else {
        await conn.query('UPDATE orders SET utr = ? WHERE id = ?', [utr, order.id]); // unique check
        await markPaid(conn, order, 'upi', { utr });
      }
      return { ok: true, verify: !!s.verify_upi };
    });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') throw new UserError(409, 'This UTR number has already been used for another order. Please check the number in your UPI app.', 'utr_used');
    throw e;
  }
}

async function chooseCash(token, key) {
  return db.tx(async (conn) => {
    const order = await getOrderForCustomer(token, key, conn);
    const s = await getSettings(conn);
    if (!s.allow_cash) throw new UserError(400, 'Cash payment is not available right now. Please pay by UPI.', 'no_cash');
    if (order.payment_status !== 'unpaid') throw new UserError(409, 'This order has already been paid or closed.', 'not_payable');
    await conn.query(`UPDATE orders SET payment_status = 'pending_cash', payment_method = 'cash', updated_at = UTC_TIMESTAMP() WHERE id = ?`, [order.id]);
    await setJobsPayment(conn, order.id, 'pending_cash', 'cash', null);
    return { ok: true };
  });
}

/** Owner: "Payment received — print". */
async function ownerConfirm(token) {
  return db.tx(async (conn) => {
    const order = await getOrderByToken(token, conn);
    if (order.payment_status === 'paid') return { ok: true, already: true };
    if (!['pending_cash', 'pending_verify', 'unpaid'].includes(order.payment_status)) {
      throw new UserError(409, `This order is ${order.payment_status.replace('_', ' ')} and cannot be confirmed.`);
    }
    const method = order.payment_status === 'pending_verify' ? 'upi' : 'cash';
    await markPaid(conn, order, method);
    return { ok: true };
  });
}

/** Owner: "Not received — cancel". Cancels everything not yet printing. */
async function ownerReject(token) {
  return db.tx(async (conn) => {
    const order = await getOrderByToken(token, conn);
    if (order.payment_status === 'rejected') return { ok: true, already: true };
    const claimedPayment = order.payment_status === 'paid' || !!order.utr || order.payment_status === 'pending_cash';
    await conn.query(`UPDATE orders SET payment_status = 'rejected', refund_if_paid = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
      [claimedPayment ? 1 : 0, order.id]);
    await conn.query(
      `UPDATE jobs SET print_status = 'cancelled', payment_status = 'rejected', refund_if_paid = ?, updated_at = UTC_TIMESTAMP()
       WHERE order_id = ? AND print_status NOT IN ('printing', 'completed')`, [claimedPayment ? 1 : 0, order.id]);
    return { ok: true };
  });
}

/** Owner reviews a file held for possible micro-printing. */
async function reviewJob(jobId, approve) {
  return db.tx(async (conn) => {
    const [[job]] = await conn.query('SELECT * FROM jobs WHERE id = ? FOR UPDATE', [jobId]);
    if (!job) throw new UserError(404, 'File not found.');
    if (job.print_status !== 'held' && !(job.print_status === 'awaiting_payment' && job.micro_verdict === 'suspect')) {
      throw new UserError(409, 'This file is not waiting for review.');
    }
    if (approve) {
      const next = job.print_status === 'held' ? 'queued' : 'awaiting_payment';
      await conn.query(`UPDATE jobs SET reviewed = 1, print_status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [next, jobId]);
    } else {
      const paid = job.payment_status === 'paid' ? 1 : 0;
      await conn.query(`UPDATE jobs SET reviewed = 1, print_status = 'cancelled', refund_if_paid = ?, error = 'Refused by the shop (possible micro-printing)', updated_at = UTC_TIMESTAMP() WHERE id = ?`, [paid, jobId]);
      if (paid) await conn.query('UPDATE orders SET refund_if_paid = 1 WHERE id = ?', [job.order_id]);
    }
    return { ok: true };
  });
}

/** Owner: send a failed (or stuck) file back to the queue. */
async function retryJob(jobId) {
  const r = await db.q(
    `UPDATE jobs SET print_status = 'queued', printer_label = NULL, computer_name = NULL, claimed_at = NULL, error = NULL,
       updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND (print_status = 'failed' OR (print_status = 'printing' AND claimed_at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE))
       AND payment_status = 'paid'`, [jobId]);
  if (!r.affectedRows) throw new UserError(409, 'Only failed files, or files stuck "printing" for over 10 minutes, can be retried.');
  return { ok: true };
}

/* ---------- gateway ---------- */

async function startGatewayCheckout(token, key) {
  const adapter = payments.getAdapter();
  const s = await getSettings();
  if (!adapter || payments.effectiveMode(s) !== 'gateway') throw new UserError(400, 'Online payment is not available. Please pay by UPI.', 'no_gateway');
  const order = await getOrderForCustomer(token, key);
  if (!['unpaid', 'gateway_pending'].includes(order.payment_status)) throw new UserError(409, 'This order has already been paid or closed.', 'not_payable');
  const { gatewayRef, checkout } = await adapter.createCheckout({
    token: order.token, amountPaise: order.total_paise, description: `Print order ${order.token}`,
    returnUrl: `${config.publicUrl}/?order=${order.token}&k=${order.access_key}`,
  });
  await db.q(`UPDATE orders SET payment_status = 'gateway_pending', gateway_provider = ?, gateway_ref = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND payment_status IN ('unpaid','gateway_pending')`,
    [adapter.name, gatewayRef, order.id]);
  return { checkout };
}

/**
 * Apply a gateway event. Only signed webhooks (or a server-side status fetch) get here,
 * never the browser redirect. Idempotent: an event id is processed at most once.
 */
async function applyGatewayEvent(provider, evt, source) {
  if (!evt || !evt.gatewayRef || !evt.type || evt.type === 'ignore') return { outcome: 'ignored' };
  return db.tx(async (conn) => {
    if (evt.eventId) {
      try {
        await conn.query(`INSERT INTO payment_events (provider, event_id, order_token, event_type, amount_paise, outcome, received_at)
                          VALUES (?, ?, NULL, ?, ?, 'processing', UTC_TIMESTAMP())`, [provider, String(evt.eventId).slice(0, 120), evt.type, evt.amountPaise || null]);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return { outcome: 'duplicate' };
        throw e;
      }
    }
    const [[order]] = await conn.query('SELECT * FROM orders WHERE gateway_ref = ? FOR UPDATE', [evt.gatewayRef]);
    let outcome;
    if (!order) outcome = 'unknown_order';
    else if (order.gateway_provider && order.gateway_provider !== provider) outcome = 'provider_mismatch';
    else if (evt.type === 'paid') {
      if (Number(evt.amountPaise) !== Number(order.total_paise)) outcome = 'amount_mismatch';
      else if (order.payment_status === 'paid') outcome = 'already_paid';
      else if (['rejected', 'refunded'].includes(order.payment_status)) outcome = 'order_closed';
      else { await markPaid(conn, order, 'gateway', { gatewayRef: evt.gatewayRef }); outcome = 'paid'; }
    } else if (evt.type === 'failed' || evt.type === 'expired') {
      if (order.payment_status === 'gateway_pending') {
        await conn.query(`UPDATE orders SET payment_status = 'unpaid', updated_at = UTC_TIMESTAMP() WHERE id = ?`, [order.id]);
      }
      outcome = evt.type;
    } else if (evt.type === 'refunded') {
      await conn.query(`UPDATE orders SET payment_status = 'refunded', refund_if_paid = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [order.id]);
      await conn.query(`UPDATE jobs SET print_status = 'cancelled', payment_status = 'refunded', updated_at = UTC_TIMESTAMP()
                        WHERE order_id = ? AND print_status NOT IN ('printing','completed')`, [order.id]);
      outcome = 'refunded';
    } else outcome = 'ignored';
    if (evt.eventId) {
      await conn.query('UPDATE payment_events SET outcome = ?, order_token = ? WHERE provider = ? AND event_id = ?',
        [`${source}:${outcome}`, order ? order.token : null, provider, String(evt.eventId).slice(0, 120)]);
    }
    return { outcome };
  });
}

async function reconcileGateway(order) {
  const adapter = payments.getAdapter();
  if (!adapter || adapter.name !== order.gateway_provider) return;
  const st = await adapter.fetchStatus(order.gateway_ref);
  if (st && st.type && st.type !== 'ignore') {
    await applyGatewayEvent(adapter.name, { ...st, eventId: `reconcile:${order.gateway_ref}:${st.type}` }, 'poll');
  }
}

module.exports = {
  createOrder, orderStatus, submitUtr, chooseCash, ownerConfirm, ownerReject, reviewJob, retryJob,
  startGatewayCheckout, applyGatewayEvent, customerState, UTR_RE,
};
