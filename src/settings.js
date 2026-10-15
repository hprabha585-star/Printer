/*
 * Shop settings (single row). Owner credentials are never included in public output.
 */
'use strict';
const db = require('./db');
const payments = require('./payments');

async function getSettings(conn) {
  const rows = conn ? (await conn.query('SELECT * FROM settings WHERE id = 1'))[0] : await db.q('SELECT * FROM settings WHERE id = 1');
  return rows[0];
}

function publicSettings(s) {
  return {
    shop_name: s.shop_name,
    rate_bw: Number(s.rate_bw),
    rate_partial: Number(s.rate_partial),
    rate_full: Number(s.rate_full),
    color_threshold: Number(s.color_threshold),
    upi_id: s.upi_id,
    payee_name: s.payee_name || s.shop_name,
    payment_mode: payments.effectiveMode(s),
    allow_cash: !!s.allow_cash,
    accepting_orders: !!s.accepting_orders,
  };
}

/** Everything the owner can see/edit (still no password hash). */
function ownerSettings(s) {
  return {
    ...publicSettings(s),
    payment_mode_selected: s.payment_mode,
    verify_upi: !!s.verify_upi,
    owner_username: s.owner_username || '',
    gateway: payments.gatewayInfo(),
  };
}

const EDITABLE = {
  shop_name: (v) => String(v || '').trim().slice(0, 120) || 'Print Shop',
  rate_bw: money, rate_partial: money, rate_full: money,
  color_threshold: (v) => { const n = Number(v); if (!(n > 0 && n <= 100)) throw new Error('Threshold must be between 1 and 100%'); return Math.round(n * 100) / 100; },
  upi_id: (v) => {
    const s = String(v || '').trim();
    if (s && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/.test(s)) throw new Error('That UPI ID does not look right (example: shopname@okaxis)');
    return s;
  },
  payee_name: (v) => String(v || '').trim().slice(0, 120),
  payment_mode: (v) => { if (!['utr', 'gateway'].includes(v)) throw new Error('Unknown payment mode'); return v; },
  verify_upi: bool, allow_cash: bool, accepting_orders: bool,
};
function money(v) {
  const n = Number(v);
  if (!(n >= 0 && n <= 10000)) throw new Error('Rates must be between ₹0 and ₹10,000');
  return Math.round(n * 100) / 100;
}
function bool(v) { return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0; }

async function updateSettings(input) {
  const sets = [], vals = [];
  for (const [k, fn] of Object.entries(EDITABLE)) {
    if (input[k] === undefined) continue;
    sets.push(`\`${k}\` = ?`);
    vals.push(fn(input[k]));
  }
  if (sets.length) await db.q(`UPDATE settings SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = 1`, vals);
  return getSettings();
}

module.exports = { getSettings, publicSettings, ownerSettings, updateSettings };
