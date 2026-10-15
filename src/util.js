'use strict';
const crypto = require('crypto');

/** Error that is shown to the user as-is, with an HTTP status. */
class UserError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; }
}

const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('hex');

/** Wrap async route handlers so errors reach the JSON error handler. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Very small in-memory rate limiter (per client IP). */
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Please wait a few minutes and try again.', code: 'rate_limited' });
    }
    next();
  };
}

/** Safe display name for an uploaded file. */
function cleanFileName(name) {
  let n = String(name || 'file');
  try { n = Buffer.from(n, 'latin1').toString('utf8'); } catch (_) {}
  n = n.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
  return (n || 'file').slice(0, 200);
}

module.exports = { UserError, randomId, ah, rateLimit, cleanFileName };
