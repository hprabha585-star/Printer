# Putting the print shop online — MilesWeb (PHP hosting)

You need:
- your MilesWeb hosting login (Premium plan or similar, with PHP and MySQL)
- a domain or sub-domain for the shop, e.g. `print.myshop.in`
- the file **`website.zip`** from this package

Time: about 20 minutes. Menu names below are the usual ones; on MilesWeb's
control panel (mPanel) they may be worded slightly differently. The setup page in
Step 5 double-checks everything and tells you exactly what to fix.

---

## Step 1 — Choose where the shop lives

The shop must be at the **top** of a domain or sub-domain (for example
`https://print.myshop.in/`), not inside a folder like `myshop.in/print/`.

- **Easiest:** create a sub-domain. Control panel → **Domains / Subdomains** →
  add `print` for your domain. Note the folder it creates (for example
  `public_html/print` or `print.myshop.in`). That folder is the **site folder**.
- Or use a separate domain as an add-on domain; its folder is the site folder.

Wait until **SSL** shows as active for it (free certificate, usually automatic within minutes).

## Step 2 — Set PHP

Control panel → **Select PHP Version** (or "PHP Settings"):
1. Version: **8.1 or newer** (8.2 / 8.3 are fine). Click **Set as current** / Save.
2. **Extensions:** make sure these are ticked: `pdo_mysql`, `gd`, `mbstring`, `zlib`, `openssl`.
3. **Options:** set
   - `upload_max_filesize` = **30M**
   - `post_max_size` = **32M**
   - `memory_limit` = **512M**
   - `max_execution_time` = **180**

   (The package also contains a `.user.ini` file with these values, which many servers read by themselves.)

## Step 3 — Create the database

Control panel → **Databases → MySQL Databases** (or **Database Manager**):
1. Create a database, e.g. `printshop`.
2. Create a database user, e.g. `printshop`, with a strong password (use the generator).
3. **Add the user to the database** with **All privileges**.
4. Write down the **full** database name and user name exactly as shown — the panel
   usually adds a prefix, for example `abcd_printshop`.

You do not create any tables. The website does that by itself.

## Step 4 — Upload the website

Control panel → **File Manager** → open the **site folder** from Step 1.
1. If the folder contains a default page (`index.html`, `default.php`, `cgi-bin` …) you may delete the default page.
2. Click **Upload** and choose **`website.zip`**.
3. Right-click `website.zip` → **Extract** (into this same folder).
4. Check that you now see `api.php`, `setup.php`, `index.html`, and the folders `app` and `storage` directly in the site folder
   (not inside an extra `website` folder). Delete `website.zip` afterwards.
5. Hidden files: make sure `.htaccess` was extracted too (turn on "Show hidden files" in the File Manager settings to see it).
6. The folder `storage` must be writable: right-click → **Permissions** → `755` (this is normally already the case).

## Step 5 — Run the setup page (do this straight away)

Open **`https://print.myshop.in/setup`** in your browser.
1. **Server check:** every line should show ✓. A red ✗ says exactly what to change (go back to Step 2).
2. Fill in the **database name**, **user name** and **password** from Step 3. Leave "Advanced" as it is.
3. Check the **website address** and press **Connect and finish setup**.
4. You get a **master key** like `K7QF-2MXP-9TRA-H4WZ-6CNE`. **Write it on paper** and keep it safe.
   It is shown only once. It is your first login and your recovery key if you forget your password.

(The settings are saved in `app/config.php`, which visitors can never open. The setup page locks
itself after this — to start again you would delete `app/config.php` in the File Manager.)

## Step 6 — Set up the shop

1. Open `https://print.myshop.in/owner`.
2. Click **"First time / forgot password? Use the master key"**, type the master key, **Sign in**.
3. Choose your own **username** and **password** (8+ characters).
4. **Settings:** shop name, the three prices per page, your **UPI ID** (a merchant/business UPI ID works best)
   and the name payers should see. Keep **"I verify every UPI payment myself"** ON at first. **Save settings**.
5. **Printers & PCs:** name the three printers (e.g. "Printer 1 - Colour"), tick **Colour** for the colour
   printer, **Save printers**.

## Step 7 — Test it

1. On your phone, open `https://print.myshop.in/`, upload a PDF, continue to payment, choose
   **Pay cash at the counter**.
2. Dashboard → **Today** → **Needs your attention** → **Payment received — print**.
3. The phone page changes to "In queue".

## Step 8 — QR poster and shop computers

- Dashboard → **Shop QR** → **Print this QR poster**. Stick it at the counter.
- Make the Print Connector once (`BUILD_EXE.md`), then on the counter PC follow
  **"Starting the shop computer"** in `OWNER_GUIDE.md`. Use your website address and your dashboard password.

---

### Good to know
- **No cron job is needed.** Old files are cleaned up automatically while a shop computer is connected
  (unordered uploads after 6 hours, printed files after 3 days).
- **Backups:** MilesWeb's own backups of files are short-lived. Once a week, export the database
  (phpMyAdmin → Export) and keep a copy. Customer files do not need backing up.
- **Updating the website later:** upload the new `website.zip` and extract it over the old files.
  Your `app/config.php` and the database are kept (the new zip does not contain a config file).
- If the dashboard warns that uploads are limited to less than 20 MB, redo the PHP options in Step 2.
- If something goes wrong, the control panel's **Error log** shows lines starting with `[printshop]`.
