# Self-service printing — owner's one-page guide

**Website for customers:** your address (on the QR poster). **Your dashboard:** your address + `/owner`

## How it works
Customer scans the QR → uploads PDF / photo → chooses B&W or Colour, pages, copies → pays by UPI
(types the 12-digit UTR) or chooses "cash at counter" → files print by themselves.

## Starting the shop computer (first time on each PC)
1. Open the `PrintShop` folder → double-click **PrintShopConnector**.
2. **Website address:** your shop address. **Shop password:** your dashboard password. Press **Connect**.
3. Next to each printer, choose which shop printer it is (e.g. "Printer 1 - Colour").
   Printers you don't use: leave "— not used —".
4. Tick **Start with Windows**. Press **▶ Start printing**. The top line turns green: *Printing is ON*.

Run it on the counter PC. You may also run it on a second or third PC — they share the work, and
printing continues if one PC is switched off. No file is ever printed twice.

## Every day
- Keep the counter PC on with the Print Connector open (green "Printing is ON").
- Look at **Today** in the dashboard on your phone now and then.

## "Needs your attention" — what to press
| You see | Do this |
|---|---|
| **Customer will pay CASH** | Take the money → **Payment received — print** |
| **Check your UPI app · UTR 41234…** | Open your UPI/bank app. Is that amount there with that UTR? Yes → **Payment received — print**. No → **Not received — cancel** |
| **Possible micro-printing** | Press **Open file**. Currency notes, cheques, certificates, ID cards, stamp papers → **Refuse to print**. A normal document → **Looks fine — print** |

**Important:** a UTR typed by a customer does **not** prove the money arrived. Only your own UPI app
proves it. Keep **"I verify every UPI payment myself"** ON unless you trust your customers.
Orders marked **REFUND IF PAID** were cancelled after the customer may have paid — refund them.

## When something goes wrong
- **"Failed"** or **"Stuck"** in Files: fix the printer (paper jam, no paper, toner, switched off),
  check the paper did not already come out, then press **Retry**.
- **Warning "No shop computer is connected"**: start the Print Connector on the counter PC.
- **Print Connector shows a red warning about SumatraPDF**: put `SumatraPDF.exe` back in the
  `PrintShop` folder.
- **Shop closed / lunch**: Settings → untick **Accepting orders**.
- **Forgot password**: on the sign-in page use the **master key**, then **Settings → Change username / password**.

## Things to tell customers
- Word, PowerPoint, Excel: open the file → **Save as PDF** → upload the PDF.
- Colour price depends on how much colour is on each page (shown before paying).
- Files are deleted after printing.

*The micro-printing check is a helper, not a guarantee. Your own eyes are the final check.*
