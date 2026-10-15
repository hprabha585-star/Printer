# Self-service Print Shop

Customers scan the shop's QR code, upload PDF/JPG/PNG files, choose print options, pay by UPI
(or cash), and the files print by themselves — no staff and no customer login.

**Start here:**
- Putting it online → [`docs/HOSTINGER_DEPLOY.md`](docs/HOSTINGER_DEPLOY.md)
- Making the shop-PC program → [`docs/BUILD_EXE.md`](docs/BUILD_EXE.md)
- Daily use (one page for the owner) → [`docs/OWNER_GUIDE.md`](docs/OWNER_GUIDE.md)

## The three parts
| Part | Where | What it does |
|---|---|---|
| **Website + API** | Hostinger (Node.js + MySQL) | Checks files, prices them, takes payment, keeps the queue |
| **Customer page** `/` | Customer's phone (QR code) | Upload → options & live price → pay → live status |
| **Owner dashboard** `/owner` | Owner's phone / PC | Money today/month, confirm payments, review files, printers, settings, QR poster |
| **Print Connector** | 1–3 shop computers | Picks up paid files and prints them on the right printer |

## Folder layout
```
server.js                    start file (Hostinger "entry file")
package.json, .npmrc         dependencies (pure JavaScript only; optional extras disabled)
.env.example                 the environment variables to set in hPanel
src/
  config.js                  reads environment variables
  db.js                      MySQL pool + automatic table creation/upgrade at start-up
  auth.js                    owner login, master key, tokens
  settings.js                shop settings
  orders.js                  orders, payments, job states (the core rules)
  cleanup.js                 deletes old files, closes unpaid orders
  analyzer/                  file checking (runs in worker threads)
    core.js sniff.js         type check by content, not by name
    pdf.js                   PDF pages, colour per page (from drawing operations), font sizes
    image.js                 JPG/PNG colour per page
    microtext.js             micro-printing screening for images and scans
  payments/                  payment-provider layer (UTR mode now; gateway plug-in ready)
  routes/                    public, owner, connector and webhook APIs
public/
  index.html app.js          customer page
  owner.html owner.js        owner dashboard
  shared/pricing.js          the ONE pricing module (used by browser and server)
  style.css owner.css        receipt look: paper, ink navy, stamp red, monospace prices
connector/
  printshop_connector.py     the desktop program (window + headless mode)
  build_exe.bat              builds PrintShopConnector.exe with PyInstaller
docs/                        guides + schema.sql (reference only)
tests/                       automated tests (developer use)
```

## How the main pieces work

**Pricing.** Each page is classed from its measured colour coverage: none → B&W, below the owner's
threshold (default 25%) → partial colour, at/above → full colour. Choosing B&W bills every page at the
B&W rate. The server recomputes every price from the stored analysis (the browser's numbers are
ignored) and saves the rates and page counts on each file as an audit trail.

**File checking.** PDFs are read (not rendered): coloured fills, strokes, text, gradients and embedded
images give a coloured area per page; real font sizes are measured. Lots of text under ~2pt is
**blocked**; a little tiny text, lots of 2–3pt text, or text-like micro-lines in images/scans make the
file **suspect** — it is accepted but held after payment until the owner opens it and decides.
Password-protected, damaged, mislabelled, too many pages (200), oversized images and time-outs get
friendly messages.

**Payment.** UTR mode: a UPI link/QR with the exact amount and the order token; customer types the
12-digit UTR (one UTR = one order). With "I verify every UPI payment" ON, the order waits for the
owner; OFF, it prints at once. Cash waits for the owner. The owner can reject a payment, which
cancels everything not yet printing and marks it "refund if paid" (excluded from revenue).
Gateway mode is wired in and tested with a sandbox adapter — see `src/payments/providers/README.md`.

**Printing across several computers.** Each connector polls every 3 s. The server hands out a job
atomically and allows only one active job per printer across all computers; a lock older than 15
minutes (crashed computer) stops blocking that printer, but that file is never re-printed
automatically — it shows as "stuck" and the owner can press Retry. Colour files go only to colour
printers; B&W files go to B&W printers first, then colour printers; among equals the longest-idle
printer is used; up to three print at once. A file counts as printed only when that printer's own
queue is empty; after 10 minutes of a busy printer it is reported as failed with an explanation.

A colour order whose pages have no colour at all is treated as B&W for routing (it may go to a
B&W printer — the output is identical and the price is the B&W price anyway).

## Known limits (honest list)
- **Micro-printing detection is a screening aid.** Reliable for tiny text in PDFs; best-effort for
  images and scans (single isolated lines of microtext in images can be missed; images below ~80 dpi
  cannot be checked). The owner's eyes are the final check.
- **In UTR mode a typed UTR cannot prove payment.** Only the owner's own UPI app (or a gateway) can.
  Some UPI apps restrict amount-prefilled links to personal UPI IDs; a merchant UPI ID is more reliable.
- **Office files** (Word/Excel/PowerPoint) must be saved as PDF first.
- **Very large scanned PDFs** take longer to analyse (limit 60 s by default; `ANALYSIS_TIMEOUT_SEC`).
- **The Windows connector needs SumatraPDF.exe** next to it (it warns clearly if missing).
- **Gateway fees and rules change** — confirm live pricing before choosing a provider.
- Colour coverage is an estimate from drawing areas (overlapping shapes can count twice; capped at 100%).

## Running the tests (developer)
Needs a MySQL/MariaDB test database (tables in it are dropped!), Python 3 with Pillow, reportlab,
qrcode, and `qpdf` for fixtures; Playwright for the browser test.
```
python3 tests/fixtures/make_fixtures.py               # generate the test files
node tests/analyzer.test.js                           # analyser accuracy (46 fixtures)
DB_USER=… DB_PASSWORD=… DB_NAME=printshop_test node tests/api.test.js         # API flows
DB_USER=… DB_PASSWORD=… DB_NAME=printshop_test node tests/connectors.test.js  # several connectors
DB_USER=… DB_PASSWORD=… DB_NAME=printshop_test python3 tests/browser_e2e.py   # pages in a browser
```
