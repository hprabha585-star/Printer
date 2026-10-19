# Deploying from GitHub to MilesWeb (printer.work.gd)

Every time you push to the `main` branch, GitHub uploads the website to MilesWeb by FTP
(`.github/workflows/deploy.yml`). Your passwords file (`app/config.php`) and customer files
(`storage/`) are never uploaded or overwritten.

## 1. Add the domain in MilesWeb
Control panel → **Domains → Addon Domain** (or "Add Website") → `printer.work.gd`.
Note the folder it creates (e.g. `printer.work.gd/` or `public_html/printer.work.gd/`).
Also note the server's **IP address** (control panel home page / welcome email: "Shared IP").

## 2. Point the domain to MilesWeb (DNSExit)
dnsexit.com → DNS → `printer.work.gd` → **Host Records (A)** → Edit `printer.work.gd.`:
- IP Address: **the MilesWeb IP from step 1** (not 157.50.148.73 — that is a Jio home/phone address)
- Keep the CNAME `www.printer.work.gd → printer.work.gd`.
Check after 15–60 minutes with Verify DNS: all NS10/NS11/NS12 must show the MilesWeb IP.

## 3. SSL
When DNS shows the new IP, MilesWeb issues the free Let's Encrypt certificate (or run SSL / AutoSSL
for the domain in the control panel). Open https://printer.work.gd — you should see a padlock.

## 4. PHP settings and database
As in MILESWEB_DEPLOY.md steps 2 and 3: PHP 8.1+, extensions pdo_mysql, gd, mbstring, zlib, openssl;
upload_max_filesize 30M, post_max_size 32M, memory_limit 512M; create the database + user.

## 5. FTP account for GitHub
Control panel → **FTP Accounts** → create e.g. `deploy@printer.work.gd`, strong password,
**Directory = the site folder from step 1**. Note the FTP server name (welcome email, or the server IP).

## 6. Put the code on GitHub
1. github.com → **New repository** → name `printshop` → **Private** → Create.
2. Upload this project (drag-and-drop the folder contents in "uploading an existing file", or with git):
   ```
   git init && git add . && git commit -m "Print shop" && git branch -M main
   git remote add origin https://github.com/<you>/printshop.git && git push -u origin main
   ```
   The `.github` folder must be included (it is hidden on some computers).
3. Repository → **Settings → Secrets and variables → Actions → New repository secret**, add:
   | Name | Value |
   |---|---|
   | `FTP_SERVER` | FTP server name or the MilesWeb IP |
   | `FTP_USERNAME` | e.g. `deploy@printer.work.gd` |
   | `FTP_PASSWORD` | its password |
   | `FTP_SERVER_DIR` | `./` |
4. **Actions** tab → "Deploy to MilesWeb" → **Run workflow**. Green tick = uploaded.
   - TLS/SSL error → edit `deploy.yml`, change `protocol: ftps` to `protocol: ftp`, commit.
   - Login error → recheck the FTP secrets.

## 7. Finish
Open **https://printer.work.gd/setup** straight away (database details → write down the master key),
then **https://printer.work.gd/owner** — continue with MILESWEB_DEPLOY.md steps 6–8.

Later changes: edit files on GitHub (or push) → the site updates itself in about a minute.
Never put `app/config.php` in the repository; the workflow refuses to deploy if you do.
