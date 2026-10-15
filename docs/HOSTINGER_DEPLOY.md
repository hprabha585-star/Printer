# Putting the website on Hostinger — step by step

You need: a Hostinger plan with **Node.js web apps** (Business or Cloud), your domain
(for example `print.myshop.in`), and the file **`printshop.zip`**.

Time needed: about 20 minutes.

---

## Step 1 — Create the database

1. Log in to **hPanel** (hpanel.hostinger.com).
2. Click **Websites** → pick any website on the plan → **Dashboard**.
3. In the left menu open **Databases → Management**.
4. Fill in:
   - **Database name**: `printshop`
   - **Database username**: `printshop`
   - **Password**: click the dice icon to make a strong one.
5. Click **Create**.
6. Write down exactly what hPanel shows — it adds a prefix, for example:
   - Database name: `u123456789_printshop`
   - Username: `u123456789_printshop`
   - Password: (the one you made)

You don't create any tables. The program does it by itself on first start.

## Step 2 — Make your master key

Make up a long secret of 20+ letters and numbers, e.g. `Lakshmi-Xerox-7731-Gunt-2026`.
Write it on paper and keep it safe. You use it the first time you open the dashboard,
and if you ever forget your password.

## Step 3 — Upload the website

1. In hPanel click **Websites** → **Add Website**.
2. Choose **Node.js web app** → **Upload your files**.
3. Upload **`printshop.zip`**.
   (If your domain is already used by another website on the plan, remove that website first.)
4. Check the settings hPanel shows:
   - **Framework preset**: Other
   - **Node.js version**: 22 (20 or 24 also work)
   - **Entry file**: `server.js`
   - **Build command**: leave empty
   - **Package manager**: npm
   Hostinger installs the packages (the "NPM install" step) automatically when you deploy.
   The included `.npmrc` file tells it to skip optional extras, which is what we want.
5. Open **Environment variables** and add these (one per line, name = value):

   | Name | Value |
   |---|---|
   | `DB_HOST` | `localhost` |
   | `DB_PORT` | `3306` |
   | `DB_NAME` | your database name from Step 1 |
   | `DB_USER` | your database username from Step 1 |
   | `DB_PASSWORD` | your database password from Step 1 |
   | `OWNER_MASTER_KEY` | your master key from Step 2 |
   | `PUBLIC_URL` | your website address, e.g. `https://print.myshop.in` |

6. Click **Deploy**. Wait until it says **Running**.

**Changing a variable later:** Website **Dashboard** → **Environment variables** → change it →
**Apply changes**. If anything looks stale, click the **Running** badge → **Restart**.

If it does not start: open the website's logs. A line like *"Missing environment variables"*
or *"Check DB_HOST, DB_USER…"* tells you which value to fix.

## Step 4 — Set up the shop

1. Open `https://your-address/owner`.
2. Click **"First time / forgot password? Use the master key"**, type the master key, **Sign in**.
3. Choose your own **username** and **password** (8+ characters). From now on you sign in with these.
4. Open **Settings** and fill in:
   - Shop name
   - Prices per page: Black & White, Partial colour, Full colour
   - Your **UPI ID** and the name payers should see. A merchant/business UPI ID works best.
   - Keep **"I verify every UPI payment myself"** ON at first.
   - Click **Save settings**.
5. Open **Printers & PCs**: name your three printers (e.g. "Printer 1 - Colour"), tick **Colour**
   for the colour printer, click **Save printers**.

## Step 5 — Test it yourself

1. On your phone, open `https://your-address/`.
2. Upload a PDF, choose options, continue to payment, choose **Pay cash at the counter**.
3. In the dashboard (**Today**), the order appears under **Needs your attention**.
   Press **Payment received — print**.

## Step 6 — Print the QR poster

Dashboard → **Shop QR** → **Print this QR poster**. Stick it at the counter.

## Step 7 — Connect the shop computers

Follow `BUILD_EXE.md` (once) to make `PrintShopConnector.exe`, then on each shop computer
follow the **Owner guide** (`OWNER_GUIDE.md`, section "Starting the shop computer").

---

### Good to know
- Customer files are stored on the server only until printed (kept 3 days so you can re-open
  them, then deleted). Unordered uploads are deleted after 6 hours.
- Redeploying a new zip can clear files waiting on the server; do updates when the queue is empty.
- Your data (orders, settings) lives in the MySQL database and is not affected by redeploys.
