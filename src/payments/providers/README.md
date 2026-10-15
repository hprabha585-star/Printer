# Payment gateway adapters

The site runs in **UTR mode** (no fees) until a gateway adapter is added here and selected.
**No real adapter is included yet — the provider (Razorpay, Cashfree, PhonePe PG or Paytm) must be
chosen first.** Everything around it is already built and tested with the `mock.js` sandbox adapter:

- checkout creation for the exact order total (`POST /api/orders/:token/gateway`)
- the webhook receiver `POST /api/payments/webhook/<provider>` (raw body kept for signatures)
- signature check → idempotent processing (`payment_events` table, unique per event id)
- amount + order match before marking paid; paid ONLY from webhook or server-side status fetch,
  never from the browser redirect
- failed / expired (order returns to unpaid, customer can try again), refunded (unprinted files
  cancelled), duplicates and replays ignored
- reconciliation when the customer's status page polls (`fetchStatus`)
- revenue shown as UPI in the dashboard; the owner can switch back to UTR mode at any time

## Adding a provider (developer)
1. Copy `mock.js` to e.g. `razorpay.js` and implement the same functions using the provider's API
   (create order / payment link, verify webhook signature, map webhook events to
   `paid | failed | expired | refunded | ignore`, fetch status). Amounts are in paise.
2. Register it in `src/payments/index.js`: `ADAPTERS.razorpay = require('./providers/razorpay');`
3. Set env vars: `PAYMENT_GATEWAY=razorpay`, `GATEWAY_KEY_ID`, `GATEWAY_KEY_SECRET`, `GATEWAY_WEBHOOK_SECRET`.
4. In the provider dashboard, add the webhook URL `https://<site>/api/payments/webhook/razorpay`.
5. Test in the provider's **sandbox / test mode** first (forged signature, replay, wrong amount,
   failed and refunded payments — see the gateway test in `tests/api.test.js`).
6. Dashboard → Settings → "How customers pay" → Payment gateway.

## What every Indian gateway asks for (onboarding)
- Business KYC: PAN (personal or business), Aadhaar of the owner, GST certificate if registered,
  shop/Udyam registration, bank account in the business or owner's name (cancelled cheque/statement).
- A live website with policy pages: **Terms & Conditions, Privacy Policy, Refund & Cancellation
  Policy, Contact Us** (with address/phone), and prices shown. (Add these pages before applying.)
- Website review and activation usually take a few working days.

## Fees (check before choosing — they change)
- **Cashfree**: no setup fee; standard platform fee listed as 1.95% (+18% GST) for UPI and most
  domestic cards; a new-merchant offer of 0% on up to ₹20 lakh was listed in October 2026.
  Source: cashfree.com/payment-gateway-charges
- **Razorpay, PhonePe PG, Paytm PG**: check their pricing pages; standard plans are typically around
  2% per transaction plus GST, with UPI sometimes cheaper or free on promotional plans.
Small orders (₹5–₹50) mean the fee per order is only a few paise to ₹1, but always confirm the live
pricing and any minimum/annual charges before signing up.
