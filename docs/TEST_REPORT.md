# Test report — PHP edition

Tested with PHP 8.3 (code kept to PHP 8.1 features), MariaDB 10.11, **Apache 2.4 with the real
`.htaccess`** (LiteSpeed follows the same rules) and PHP's built-in server, Python 3.12 (Tk) and Chromium.

| Suite | What it covers | Result |
|---|---|---|
| `analyzer_test.php` | 64 files. Everything from the Node edition: text, partial and full colour, gradients, photos, grey scans, microtext in PDFs and images, low resolution, QR/barcode/halftone/hatching/noise traps, normal documents at 100–300 dpi, encrypted, corrupt, mislabelled, 201 pages, oversized image. **New PDF-reader cases:** compressed object streams, form XObjects with matrices, inline images, CMYK and Indexed colour, Separation (spot) inks, Type0 2-byte fonts, invisible OCR text, LibreOffice-exported documents, edit-protected PDFs (AES-256, AES-128, RC4-128, RC4-40) accepted, and a PDF needing a password refused | 64 / 64 pass |
| `api.test.js` | the same 26 flows as the Node edition, now against PHP: in-place upgrade of an old database, credentials, settings, all rejections, price maths, UTR rules, verify ON/OFF, duplicate UTR, cash, reject + refund + revenue exclusion, held for review, revenue split, connector claim race, colour routing, one job per printer, stale lock, retry, printer rename, gateway webhook (forged signature, wrong amount, replay, refund, reconcile), JSON errors, shop closed, cleanup, rate limit per client, upload size cap | 26 / 26 pass |
| `connectors.test.js` | 3 Print Connectors against the PHP site: each file printed exactly once, never two at once on a printer, colour routing, crash failover with stale-lock timeout, offline printer, paper jam, queue-drain wait, printers switched off | 4 / 4 pass |
| `setup.test.js` | first-time setup page: server check, wrong DB password message, config saved with private permissions, master key works, page locks itself; app/, storage/, config and hidden files not reachable | 6 / 6 pass |
| `pricing_parity.test.js` | browser JavaScript vs server PHP pricing on 5,000 random orders | identical |
| `browser_e2e.py` | phone-size customer flow and owner dashboard in Chromium | all pass |
| Real Apache | setup page, `/owner`, `/api` routing, 403 on app/storage/hidden files/uploaded customer files, 25 MB limit message, full order → cash → Print Connector printed it | works |

## Problems found and fixed while porting
1. PHP's bundled image library has no raw-pixel export, so pixels are read through its BMP export.
2. Two normal pictures were wrongly flagged as micro-printing with the new PHP image maths (a hatched
   pattern with ruled lines, and a 7pt number grid). Added a "ruled lines" check and an
   edge-of-range check; all microtext samples are still caught (25+ flagged areas vs 0 for documents).
3. Edit-protected PDFs (bank statements, e-tickets) would have been refused as "password-protected";
   added decryption for PDFs that open without a password.
4. An empty upload was reported as "too big" instead of "Please choose a file".

## Not tested here
- The real MilesWeb account and its LiteSpeed server (tested on Apache with the same `.htaccess`).
  The `/setup` page checks the PHP version, extensions, upload limit and folder permissions on the
  real server and says exactly what to fix.
- Real Windows printers + SumatraPDF — do one supervised test print per printer.
- A real payment gateway (not chosen yet).
