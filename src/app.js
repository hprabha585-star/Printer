/*
 * Express application: API + static pages.
 */
'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const config = require('./config');
const { UserError } = require('./util');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Hostinger/Passenger sits behind a proxy: use the real client IP
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Webhooks need the raw body for signature checks → mounted before the JSON parser
  app.use('/api/payments', require('./routes/webhook'));
  app.use(express.json({ limit: '200kb' }));

  app.use('/api/connector', require('./routes/connector'));
  app.use('/api/owner', require('./routes/owner'));
  app.use('/api', require('./routes/public'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Pages
  const pub = path.join(__dirname, '..', 'public');
  app.get('/owner', (req, res) => res.sendFile(path.join(pub, 'owner.html')));
  app.get('/vendor/qrcode.js', (req, res) => res.sendFile(require.resolve('qrcode-generator')));
  app.use(express.static(pub, { index: 'index.html', maxAge: config.isTest ? 0 : '10m' }));

  // JSON errors everywhere
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `This file is too big. The limit is ${config.maxUploadMb} MB.` : 'Upload failed. Please try again.';
      return res.status(413).json({ error: msg, code: err.code === 'LIMIT_FILE_SIZE' ? 'too_big' : 'upload' });
    }
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
    // errors meant for the user (UserError) keep their status, including 503 "shop closed"
    if (err instanceof UserError || (err && err.status >= 400 && err.status < 500)) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(new Date().toISOString(), req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });
  return app;
}

module.exports = { createApp };
