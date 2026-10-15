# Test report

Tested against a real **MariaDB 10.11** database, Node.js 22, Python 3.12 (Tk) and Chromium.

| Suite | What it covers | Result |
|---|---|---|
| `tests/analyzer.test.js` | 46 generated files: text, partial/full colour, gradients, photos, greyscale scans (JPEG noise), microtext in PDFs (blocked/suspect, rotated, light ink), microtext in images (thin band, rotated, light ink, skewed, inside a scanned PDF), low-resolution image, QR / barcode / halftone / hatching / noise traps, normal documents (5pt footers, 4–24pt sizes, tables, dense 6–8pt text, two columns, number grids, 100–300 dpi), encrypted, corrupt, mislabelled, Word-renamed-to-PDF, 201 pages, 81-megapixel image | 46 / 46 pass |
| `tests/api.test.js` | in-place upgrade of an old database, credentials never public, master key → own login → old sessions revoked, settings validation, all analyse rejections, price maths incl. same file twice and tampered prices, page/copies validation, threshold change, UTR rules, verify ON/OFF, duplicate UTR, cash, cash disabled, reject + refund flag + revenue exclusion, held-for-review approve/refuse, revenue UPI/cash split, connector login/heartbeat, claim race (3 computers, 1 winner), colour routing, one job per printer, 15-min stale lock, wrong-computer completion, failed → retry, stuck → retry, printer rename, gateway webhook (forged signature, wrong amount, replay, duplicate, unknown order, failed, refund, reconcile on poll), JSON errors, route order, shop closed, cleanup, rate limit per client IP behind proxy, upload size cap | 26 / 26 pass |
| `tests/connectors.test.js` | 3 connector processes against one server: 18 files → each printed exactly once, never two jobs on one printer, colour only on the colour printer, B&W printed monochrome, temp files deleted; a computer killed mid-print → printers unlock after the stale timeout, its files not re-printed, owner retry prints once; offline printer skipped; paper jam → failure with printer + computer named, jammed printer not reused; "done" only after the queue drains; colour waits for a colour printer; printers switched off in the dashboard not used | 4 / 4 pass |
| `tests/browser_e2e.py` | phone-size customer flow (upload, live price & breakdown, page clamp, add same file again, edit, remove, Word and micro-printing messages, UPI link/apps/QR, UTR input, live status auto-refresh) and owner dashboard (first sign-in, settings, confirm payment, files table, printers, QR poster, phone card layout), no JavaScript errors | all pass |
| Desktop window | opened under a virtual display with simulated printers; connected, showed printer status, started printing | works |

## Real bugs found and fixed
1. **Colour under-measured in PDFs** — shape sizes were read in the wrong order, so coloured areas
   counted about 4× too small (a half-page colour block was billed as "partial").
2. **Gradients billed as B&W** — gradient fills stored by reference inside the PDF were not looked up.
3. **Normal scanned pages flagged as micro-printing** — letter strokes and ordinary text lines looked
   "periodic". Added checks for evenly spaced separate lines, ink spread along the lines, the true
   (longer) line spacing, and a calibrated minimum flagged area. All normal documents now pass while
   every microtext variant is still caught.
4. **"Shop closed" returned a server error (500)** instead of the friendly message.
5. **Typing letters as page numbers** caused a server error instead of a clear message.
6. **Payment QR library didn't load** (wrong file path) — QR codes were blank.
7. **Pasting a UTR with text around it lost digits** — the input cut the text to 12 characters
   before removing non-digits.
8. **"Change files" after starting payment** made the files "expired" — uploads are now kept until
   they time out, so customers can go back and change their order.
9. **Dashboard file cards on phones** broke text into columns — fixed layout.
10. **Jam message always said "10 minutes"** even when a different wait was configured.

## Not tested here
- Real Windows printers + SumatraPDF and a real Hostinger account (no access from the test
  machine). The Windows code paths (pywin32 / PowerShell status, SumatraPDF command line, Start with
  Windows) follow the documented interfaces; please do one supervised test print per printer after
  installing.
- A real payment gateway (not chosen yet) — the gateway layer is tested with a sandbox adapter.
