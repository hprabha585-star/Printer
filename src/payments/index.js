/*
 * Payment-provider layer.
 *
 * Two modes, chosen by the owner in Settings:
 *   "utr"     (default, no fees)  – customer pays by UPI and types the 12-digit UTR.
 *   "gateway" (Razorpay/Cashfree/PhonePe PG/Paytm) – the gateway confirms payment
 *              through a signed webhook. No adapter is installed yet: the provider
 *              is to be chosen first. See src/payments/providers/README.md.
 * Cash at the counter works in both modes.
 *
 * If "gateway" is selected but no adapter is configured, the site keeps working in
 * UTR mode and the dashboard shows a warning.
 */
'use strict';
const config = require('../config');

// Registry of gateway adapters: name -> module implementing the interface below.
// Real providers are added here once chosen (e.g. razorpay: require('./providers/razorpay')).
const ADAPTERS = {};
if (config.isTest) ADAPTERS.mock = require('./providers/mock'); // sandbox adapter for automated tests only

/*
 * Adapter interface (every gateway must implement):
 *   name                                   string
 *   isConfigured()                         -> boolean (keys present in env)
 *   createCheckout({ token, amountPaise, description, returnUrl })
 *                                          -> { gatewayRef, checkout: { type: 'redirect'|'upi_intent'|'qr', url, qr?, ... } }
 *   verifyWebhook(rawBodyBuffer, headers)  -> boolean  (signature check, constant-time)
 *   parseWebhook(rawBodyBuffer)            -> { eventId, type: 'paid'|'failed'|'expired'|'refunded'|'ignore',
 *                                                gatewayRef, amountPaise }
 *   fetchStatus(gatewayRef)                -> same shape as parseWebhook (used to reconcile when the
 *                                             customer's status page polls)
 *   info                                   { label, feeNote, onboarding } shown on the dashboard
 */

function getAdapter() {
  const a = ADAPTERS[config.gateway.provider];
  return a && a.isConfigured() ? a : null;
}

/** The mode actually in force (gateway only if an adapter is configured). */
function effectiveMode(settings) {
  return settings.payment_mode === 'gateway' && getAdapter() ? 'gateway' : 'utr';
}

function gatewayInfo() {
  const a = getAdapter();
  return {
    configured: !!a,
    provider: a ? a.name : (config.gateway.provider || null),
    label: a ? a.info.label : null,
    note: a ? a.info.feeNote : 'No payment gateway is set up yet. UTR mode is used. (A developer adds the chosen gateway — see the README.)',
  };
}

module.exports = { getAdapter, effectiveMode, gatewayInfo, ADAPTERS };
