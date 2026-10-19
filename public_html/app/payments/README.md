# Payment gateway adapters (PHP)

The site runs in **UTR mode** (no fees) until a gateway adapter is added here and selected.
**No real adapter is included yet — the provider (Razorpay, Cashfree, PhonePe PG or Paytm) must be
chosen first.** Everything around it is already built and tested with `MockGateway.php`:

- checkout for the exact order total (`POST /api/orders/{token}/gateway`)
- webhook receiver `POST /api/payments/webhook/{provider}` (raw body kept for signature checks)
- signature check → idempotent processing (`payment_events`, unique per event id)
- amount + order match before marking paid; paid ONLY from the webhook or a server-side status
  fetch, never from the browser redirect
- failed / expired (order returns to unpaid), refunded (unprinted files cancelled), duplicates and replays
- reconciliation when the customer's status page polls (`fetchStatus`)

## Adding a provider (developer)
1. Copy `MockGateway.php` to e.g. `RazorpayGateway.php` and implement the `GatewayAdapter`
   interface from `app/Payments.php` using the provider's REST API (PHP `curl`). Amounts are in paise.
2. Register it in `Payments::adapters()`.
3. In `app/config.php` add `PAYMENT_GATEWAY`, `GATEWAY_KEY_ID`, `GATEWAY_KEY_SECRET`, `GATEWAY_WEBHOOK_SECRET`.
4. In the provider dashboard add the webhook URL `https://<site>/api/payments/webhook/<provider>`.
5. Test in the provider's sandbox/test mode (forged signature, replay, wrong amount, failed, refunded —
   see the gateway test in `tests/api.test.js`).
6. Dashboard → Settings → "How customers pay" → Payment gateway.

## What Indian gateways ask for (onboarding)
- Business KYC: PAN, owner's Aadhaar, GST certificate if registered, shop/Udyam registration,
  bank account (cancelled cheque or statement).
- A live website with policy pages: **Terms & Conditions, Privacy Policy, Refund & Cancellation
  Policy, Contact Us** (address/phone), and prices shown.
- Activation usually takes a few working days.

## Fees — check before choosing, they change
- **Cashfree** (October 2026 pricing page): no setup fee; standard platform fee 1.95% + GST for UPI and most
  domestic cards; a new-merchant offer of 0% on up to ₹20 lakh was listed.
- **Razorpay, PhonePe PG, Paytm PG:** check their pricing pages (standard plans are typically around 2% + GST).
