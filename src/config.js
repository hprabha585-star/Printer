/*
 * All configuration comes from environment variables (set in hPanel).
 * Nothing secret is ever written in code or files.
 */
'use strict';
const path = require('path');

// Optional: load a local ".env" file (handy on your own PC). On Hostinger,
// set the variables in hPanel instead. Existing variables are never overwritten.
try {
  const fs = require('fs');
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch (_) { /* ignore */ }

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  port: num(process.env.PORT, 3000),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
  },
  masterKey: process.env.OWNER_MASTER_KEY || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  storageDir: process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage'),
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 25),
  maxPages: num(process.env.MAX_PAGES, 200),
  maxImageMegapixels: num(process.env.MAX_IMAGE_MEGAPIXELS, 50),
  analysisTimeoutSec: num(process.env.ANALYSIS_TIMEOUT_SEC, 60),
  analysisConcurrency: num(process.env.ANALYSIS_CONCURRENCY, 2),
  uploadTtlHours: num(process.env.UPLOAD_TTL_HOURS, 6),
  fileRetentionDays: num(process.env.FILE_RETENTION_DAYS, 3),
  analyseRateLimit: num(process.env.ANALYSE_RATE_LIMIT, 30), // per IP per 10 minutes
  // Payment gateway (only used when the owner selects gateway mode)
  gateway: {
    provider: (process.env.PAYMENT_GATEWAY || '').toLowerCase(), // e.g. "razorpay" once an adapter is added
    keyId: process.env.GATEWAY_KEY_ID || '',
    keySecret: process.env.GATEWAY_KEY_SECRET || '',
    webhookSecret: process.env.GATEWAY_WEBHOOK_SECRET || '',
  },
  isTest: process.env.NODE_ENV === 'test',
};
