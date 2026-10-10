# Deploying to Hostinger (Node.js hosting)

This assumes a Hostinger plan that includes **Node.js app hosting** (visible
in hPanel under "Advanced → Node.js" or "Website → Node.js"). It runs your
app under Passenger, which handles HTTPS and the reverse proxy for you.

This project uses **MySQL**, which Hostinger's hosting plans include
directly — no external database service needed.

## 1. Create a MySQL database

In hPanel, go to **Databases → MySQL Databases**:

1. Create a new database (e.g. `u123456789_print_shop`) — Hostinger prefixes
   database and username with your account ID automatically.
2. Create a database user with a strong password, and attach it to that
   database with **All Privileges**.
3. Note the **hostname** shown on that page — on most Hostinger shared plans
   this is `localhost`, but some plans show a specific host; use whatever is
   shown there, not always `localhost`.

You now have four values you'll need in step 4: host, database name, user,
password.

## 2. Upload the project files

In hPanel, go to **Files → File Manager**, open `public_html` (or a
subfolder if you're using a subdomain like `print.yourdomain.com`), and
upload `print-shop-app.zip`, then right-click it → **Extract**.

(Alternatively: hPanel's Git integration lets you deploy straight from a
GitHub repo if you push this project there — look under **Advanced → Git**.)

## 3. Create the Node.js application

Go to **Advanced → Node.js → Create Application** and fill in:

| Field                     | Value                                              |
|---------------------------|-----------------------------------------------------|
| Node.js version            | 18.x or newer                                       |
| Application mode           | Production                                          |
| Application root           | the folder you extracted into (e.g. `print-shop-app`) |
| Application URL            | your domain or subdomain                            |
| Application startup file   | `server.js`                                         |

Click **Create**.

## 4. Install dependencies

On the application's page, click **NPM Install** (this reads `package.json`
and installs express/mysql2/cors/multer for you — no SSH needed).

## 5. Set environment variables

Still on the application's page, find **Environment variables** and add:

| Key               | Value                                                        |
|-------------------|---------------------------------------------------------------|
| `DB_HOST`         | the database host from step 1 (often `localhost`)             |
| `DB_PORT`         | `3306` (MySQL's default port, unless hPanel says otherwise)   |
| `DB_USER`         | the database username from step 1                             |
| `DB_PASSWORD`     | the database password from step 1                              |
| `DB_NAME`         | the database name from step 1                                  |
| `OWNER_KEY`       | a long random password — this is your one-time master key      |
| `PUBLIC_BASE_URL` | your site's full address, e.g. `https://yourdomain.com`        |

`PUBLIC_BASE_URL` matters: it's how the print connector (running on the shop
PC, a different machine) builds a working download link for each file.

Note: you do **not** need to set `PORT` — Hostinger/Passenger sets this
automatically and `server.js` already reads `process.env.PORT`.

## 6. Restart the app

Click **Restart** on the application page. The very first start creates the
two database tables (`settings` and `jobs`) automatically — there's no
migration step to run by hand. (If you'd rather set the schema up yourself
first, `schema.sql` in this project has the same statements to import via
**Databases → phpMyAdmin**.)

Then visit:

- `https://yourdomain.com/` — the customer upload/pay page
- `https://yourdomain.com/owner` — the owner dashboard (sign in with
  username `owner` and the `OWNER_KEY` you set in step 5 the first time,
  then set your own username/password from inside the dashboard)

Once signed in, open the dashboard's "Your shop QR code" card and print it —
that's what customers scan to reach `https://yourdomain.com/` and place an
order, with no login or app of their own required.

## 7. Point the shop PC at the live site

On the shop computer, open `PrintShopConnector.exe` (see `BUILD_EXE.md` and
`INSTALL_FOR_OWNER.txt`), enter `https://yourdomain.com` as the website
address and the dashboard password as the connector password, and click
Connect.

## File storage note

Hostinger's Node.js hosting disk is persistent — uploaded files in
`/uploads` survive restarts, so there's nothing extra you need to do here.
If you outgrow local disk (heavy volume, multiple servers), swap the
`multer.diskStorage` in `server.js` for an S3-compatible storage adapter —
every other route keeps working unchanged since they only deal with `fileUrl`.

## Updating the app later

After editing files, re-upload the changed files (or `git pull` if you used
Git), then click **Restart** on the Node.js application page in hPanel.
