/*
 * Payment gateway webhook receiver: POST /api/payments/webhook/:provider
 * The raw body is needed for signature checks, so this router is mounted
 * BEFORE the JSON body parser.
 */
'use strict';
const express = require('express');
const payments = require('../payments');
const orders = require('../orders');
const { ah } = require('../util');

const router = express.Router();

router.post('/webhook/:provider', express.raw({ type: '*/*', limit: '1mb' }), ah(async (req, res) => {
  const adapter = payments.getAdapter();
  if (!adapter || adapter.name !== req.params.provider) return res.status(404).json({ error: 'Unknown payment provider' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!adapter.verifyWebhook(raw, req.headers)) return res.status(401).json({ error: 'Invalid signature' });
  let evt;
  try { evt = adapter.parseWebhook(raw); } catch (_) { return res.status(400).json({ error: 'Bad payload' }); }
  const r = await orders.applyGatewayEvent(adapter.name, evt, 'webhook');
  res.json({ received: true, outcome: r.outcome });
}));

module.exports = router;
