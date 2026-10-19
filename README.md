# Self-service Print Shop (PHP + MySQL edition)

Customers scan the shop's QR code, upload PDF/JPG/PNG files, choose print options, pay by UPI
(or cash), and the files print by themselves — no staff and no customer login.

This edition runs on ordinary **PHP shared hosting** (MilesWeb, or any host with PHP 8.1+ and MySQL/MariaDB).
No Node.js, no Composer, no command line needed.

**Start here**
- Putting it online → [`docs/MILESWEB_DEPLOY.md`](docs/MILESWEB_DEPLOY.md)
- Making the shop-PC program → [`docs/BUILD_EXE.md`](docs/BUILD_EXE.md)
- Daily use (one page for the owner) → [`docs/OWNER_GUIDE.md`](docs/OWNER_GUIDE.md)

## What's in this package
```
website.zip           ← upload this to the hosting and extract it. Inside it:
  .htaccess             web server rules: /api → api.php, protects app/ and storage/, forces https
  .user.ini             PHP upload/memory limits
  api.php               entry point for every /api/... request
  setup.php             one-time setup page (/setup): database details + master key
  index.html, app.js    customer page          owner.html, owner.js   owner dashboard
  shared/pricing.js     browser pricing (mirrored exactly by app/Pricing.php)
  style.css, owner.css  receipt look: paper, ink navy, stamp red, monospace prices
  app/                  PHP code (never web-readable)
    Config.php  Db.php (tables created/upgraded automatically)  Http.php  Auth.php
    Settings.php  Pricing.php  Orders.php (core rules)  Upload.php  Owner.php  Connector.php
    Cleanup.php (no cron needed)  Payments.php + payments/ (gateway plug-in layer)
    analyzer/             file checking: PdfFile (PDF reader + decryption), PdfPage (colour, font
                          sizes), Raster + Microtext (images/scans), Analyzer (entry point)
  storage/              customer files while waiting to print (never web-readable)
connector/              the desktop Print Connector (unchanged; works with this edition)
docs/                   guides, schema.sql (reference only), TEST_REPORT.md
tests/                  automated tests (developer use, not uploaded)
```

## How the main pieces work

**Pricing.** Each page is classed from its measured colour coverage: none → B&W, below the owner's
threshold (default 25%) → partial colour, at/above → full colour. Choosing B&W bills every page at the
B&W rate. The server recomputes every price from stored analysis (browser numbers are ignored) and
saves the rates and page counts on each file as an audit trail.

**File checking (pure PHP + GD).** PDFs are read, not rendered: coloured fills, strokes, text,
gradients, patterns, forms and embedded images give a coloured area per page; real font sizes are
measured (invisible OCR text is ignored). PDFs that are only protected against editing (common for
bank statements and e-tickets) are decrypted and accepted; PDFs that need a password to open are
refused with a friendly message. Lots of text under ~2pt is **blocked**; a little tiny text, lots of
2–3pt text, or microtext-like line patterns in images/scans make the file **suspect** — accepted, but
held after payment until the owner opens it and decides.

**Payment.** UTR mode: UPI link/QR with the exact amount and order token; the customer types the
12-digit UTR (one UTR = one order). "I verify every UPI payment" ON → waits for the owner; OFF →
prints at once. Cash waits for the owner. Rejecting a payment cancels everything not yet printing and
marks it "refund if paid" (excluded from revenue). Gateway mode is wired in and tested with a sandbox
adapter — see `public_html/app/payments/README.md`.

**Printing across several computers.** The database hands out each file atomically and allows one
active file per printer across all computers; a lock older than 15 minutes (crashed computer) stops
blocking the printer, but that file is never re-printed automatically — it shows as "stuck" and the
owner can press Retry. Colour files only go to colour printers; B&W files to B&W printers first.

## Differences from the Node.js edition
- **Secrets** live in `app/config.php` (written by the setup page, never web-readable) because shared
  PHP hosting has no environment-variable screen. Real environment variables still override it.
- **Pricing** is mirrored in `app/Pricing.php`; a test checks it gives identical results to
  `shared/pricing.js` on 5,000 random orders.
- **File checks** run inside the upload request (at most 2 at a time, 120-second limit) instead of a
  worker thread.
- **Housekeeping** piggybacks on the shop computer's heartbeat — no cron job.

## Known limits (honest list)
- **Micro-printing detection is a screening aid.** Reliable for tiny text in PDFs; best-effort for
  images and scans (an isolated single line of microtext in an image can be missed; images below
  ~80 dpi cannot be checked; at most 12 images per PDF are checked). The owner's eyes are the final check.
- Images inside PDFs stored as **JPEG 2000, JBIG2 or CCITT fax**, or as **CMYK JPEG**, cannot be decoded
  by PHP's image library: their colour is not counted and they are not checked for microtext.
- **In UTR mode a typed UTR cannot prove payment.** Only the owner's own UPI app (or a gateway) can.
  Some UPI apps restrict amount-filled links to personal UPI IDs; a merchant UPI ID is more reliable.
- **Office files** must be saved as PDF first.
- **Very large scanned PDFs** take longer (about 2–4 seconds per scanned page on a typical server).
- The site must be at the top of a domain or sub-domain (not in a sub-folder).
- The Windows Print Connector needs SumatraPDF.exe next to it.
- Gateway fees and rules change — confirm live pricing before choosing a provider.

## Running the tests (developer)
First extract the website for the tests: `unzip website.zip -d public_html`.
Needs PHP 8.1+ (gd, pdo_mysql, mbstring), Node 18+, Python 3 with Pillow, reportlab, qrcode,
qpdf and LibreOffice for fixtures, Playwright for the browser test, and a MySQL/MariaDB test
database (its tables are dropped!).
```
python3 tests/fixtures/make_fixtures.py && python3 tests/fixtures/make_extra_fixtures.py
php tests/analyzer_test.php                       # 64 files
cd tests && npm install
DB_USER=… DB_PASSWORD=… DB_NAME=printshop_test node api.test.js
DB_USER=… DB_PASSWORD=… DB_NAME=printshop_test node connectors.test.js
DB_USER=… DB_PASSWORD=… DB_NAME=printshop_test node setup.test.js
node pricing_parity.test.js
DB_USER=… DB_PASSWORD=… DB_NAME=printshop_test python3 browser_e2e.py
```
