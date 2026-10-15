/*
 * MOCK gateway adapter — used ONLY by the automated tests (NODE_ENV=test).
 * It behaves like a real gateway sandbox: orders get a reference, webhooks are
 * signed with HMAC-SHA256 over the raw body, and status can be "fetched".
 * It is the template for writing a real adapter (Razorpay, Cashfree, ...).
 */
'use strict';
const crypto = require('crypto');
const config = require('../../config');

const store = new Map(); // gatewayRef -> { type, amountPaise }

module.exports = {
  name: 'mock',
  info: { label: 'Test gateway', feeNote: 'Test only', onboarding: [] },
  isConfigured: () => !!config.gateway.webhookSecret,

  async createCheckout({ token, amountPaise }) {
    const gatewayRef = 'mock_' + token + '_' + crypto.randomBytes(4).toString('hex');
    store.set(gatewayRef, { type: 'created', amountPaise });
    return { gatewayRef, checkout: { type: 'redirect', url: `/mock-pay?ref=${gatewayRef}` } };
  },

  verifyWebhook(raw, headers) {
    const sig = String(headers['x-mock-signature'] || '');
    const expect = crypto.createHmac('sha256', config.gateway.webhookSecret).update(raw).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  parseWebhook(raw) {
    const e = JSON.parse(raw.toString('utf8'));
    if (e.type === 'paid' || e.type === 'refunded' || e.type === 'failed') store.set(e.ref, { type: e.type, amountPaise: e.amount });
    return { eventId: e.id, type: e.type, gatewayRef: e.ref, amountPaise: e.amount };
  },

  async fetchStatus(gatewayRef) {
    const s = store.get(gatewayRef);
    return s ? { type: s.type === 'created' ? 'ignore' : s.type, gatewayRef, amountPaise: s.amountPaise } : null;
  },

  // test helper: simulate the gateway marking an order paid without a webhook
  _set(gatewayRef, type, amountPaise) { store.set(gatewayRef, { type, amountPaise }); },
};
