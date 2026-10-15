/*
 * Owner authentication.
 *  - Very first sign-in uses OWNER_MASTER_KEY (from hPanel). The owner then sets a
 *    username + password. The master key keeps working as a recovery path.
 *  - A successful login returns a signed token sent back in the "X-Owner-Key" header.
 *  - Changing the login details invalidates all old dashboard sessions.
 *  - Print-shop computers get their own long-lived "connector" token.
 */
'use strict';
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const SESSION_DAYS = 30;
const CONNECTOR_DAYS = 3650;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
  return safeEqual(hash.toString('hex'), hashHex);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isMasterKey(key) {
  return !!config.masterKey && !!key && safeEqual(key, config.masterKey);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', 'owner-token:' + config.masterKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.') || !config.masterKey) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', 'owner-token:' + config.masterKey).update(body).digest('base64url');
  if (!safeEqual(sig, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (_) { return null; }
}

async function getSessionVersion() {
  const [s] = await db.q('SELECT session_version FROM settings WHERE id = 1');
  return s ? s.session_version : 1;
}

async function issueOwnerToken() {
  return sign({ s: 'owner', v: await getSessionVersion(), exp: Date.now() + SESSION_DAYS * 864e5 });
}

function issueConnectorToken() {
  return sign({ s: 'connector', exp: Date.now() + CONNECTOR_DAYS * 864e5 });
}

/** Express middleware: owner dashboard routes. */
function requireOwner(req, res, next) {
  const key = req.get('X-Owner-Key') || '';
  if (isMasterKey(key)) { req.viaMaster = true; return next(); }
  const p = verifyToken(key);
  if (!p || p.s !== 'owner') return res.status(401).json({ error: 'Please sign in again.' });
  getSessionVersion().then((v) => {
    if (p.v !== v) return res.status(401).json({ error: 'Your login details were changed. Please sign in again.' });
    next();
  }).catch(next);
}

/** Express middleware: print-shop computer routes (connector token or owner key). */
function requireConnector(req, res, next) {
  const key = req.get('X-Owner-Key') || '';
  if (isMasterKey(key)) return next();
  const p = verifyToken(key);
  if (p && (p.s === 'connector' || p.s === 'owner')) return next();
  return res.status(401).json({ error: 'This computer is not connected. Enter the shop password again.' });
}

module.exports = {
  hashPassword, verifyPassword, isMasterKey, issueOwnerToken, issueConnectorToken,
  requireOwner, requireConnector, verifyToken, safeEqual,
};
