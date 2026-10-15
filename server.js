/*
 * Self-service print shop — server entry point (Hostinger "startup file").
 * Creates/upgrades the database tables, then starts the website.
 */
'use strict';
const config = require('./src/config');
const db = require('./src/db');
const { createApp } = require('./src/app');
const { startCleanup } = require('./src/cleanup');

async function main() {
  const missing = ['DB_USER', 'DB_NAME', 'OWNER_MASTER_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}. Set them in hPanel → your website Dashboard → Environment variables.`);
  }
  if (config.masterKey && config.masterKey.length < 12) console.warn('OWNER_MASTER_KEY is short. Use at least 12 random characters.');

  await db.migrate();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`Print shop running on port ${config.port}`));
  server.requestTimeout = 5 * 60 * 1000; // allow slow mobile uploads
  startCleanup();

  const stop = () => server.close(() => db.close().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error('Startup failed:', e && e.message ? e.message : e);
  if (e && /ER_ACCESS_DENIED|ECONNREFUSED|ER_BAD_DB/.test(String(e.code))) {
    console.error('Check DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in hPanel.');
  }
  process.exit(1);
});
