// server.js
// -----------------------------------------------------------------------------
// Backend for the self-service print shop.
// - Customer scans the shop's QR code (just the site's URL -- see the "Your
//   shop QR code" card in the owner dashboard) and lands on index.html.
// - Customer adds one or more files to their order, each with its own print
//   type / page range / copies, can edit or remove any of them, then checks
//   out once for the whole order.
// - Customer pays by UPI (deep link or QR, then types in the UTR) or chooses
//   to pay cash at the counter.
// - Owner confirms cash payments from the dashboard; UPI payments are
//   released automatically once the UTR is submitted.
// - The local print agent (print_agent_gui.py, a double-click desktop app
//   for the shop PC) polls /api/jobs/pending, downloads each file, prints
//   it, and calls /api/jobs/complete.
//
// Uses MySQL (via mysql2), not MongoDB -- a good fit for shared hosting
// plans like Hostinger that provide MySQL databases. Tables are created
// automatically on first start (see db.js). Deploys as-is on Hostinger's
// Node.js hosting (hPanel > Advanced > Node.js): it only needs
// process.env.PORT (which Hostinger sets automatically) and DB_* /
// OWNER_KEY / PUBLIC_BASE_URL environment variables. See HOSTINGER_DEPLOY.md.
// -----------------------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initSchema } = require('./db');
const Job = require('./models/Job');
const Settings = require('./models/Settings');

const app = express();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
// Shared secret the owner dashboard + print agent must send to do privileged
// actions. Set this in your hosting panel's environment variables -- it's
// the one-time "master key" used to sign in the very first time; the owner
// sets an easier everyday username/password from inside the dashboard after
// that (Settings > "Change login details").
const OWNER_KEY = process.env.OWNER_KEY || 'change-me-owner-key';
// Public base URL of this server, used to build absolute file download links
// for the print agent (e.g. https://yourdomain.com)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const MAX_FILES_PER_ORDER = 20;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the customer/owner frontend
app.use(express.static(path.join(__dirname, 'public')));

// The customer page (index.html) is served automatically at "/" by the static
// middleware above -- that's the URL the shop's QR code should point at.
// The owner dashboard also lives in /public, but give it a clean, memorable
// URL too, so shop staff have somewhere obvious to go.
app.get(['/owner', '/admin', '/dashboard'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Make sure the uploads folder exists, then serve uploaded files statically
// so the print agent can download them by URL.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer: store uploads to local disk with a collision-proof filename.
// Hostinger's Node.js hosting disk is persistent, so uploaded files survive
// restarts as-is. For heavier scale, swap this for an S3-style multer
// storage adapter -- every route below only ever deals with `fileUrl`.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap per file
  fileFilter: (req, file, cb) => {
    const allowed = /pdf|doc|docx|jpg|jpeg|png|ppt|pptx|xls|xlsx|txt/i;
    const ok = allowed.test(path.extname(file.originalname));
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

// Owner-only guard for privileged routes (pricing changes, marking jobs
// paid/complete). The owner dashboard sends this as an "x-owner-key" header,
// set once at login and cached in the browser.
//
// Two keys are ever valid:
//   1. OWNER_KEY  - the "master key" set as a hosting environment variable.
//      Always works; used the very first time the dashboard is opened.
//   2. settings.ownerPassword - an easier password the owner sets from
//      inside the dashboard (Settings > "Change login details"), so
//      day-to-day sign-in never needs hosting access again.
async function requireOwner(req, res, next) {
  const key = req.headers['x-owner-key'];
  if (!key) {
    return res.status(401).json({ error: 'Unauthorized: owner key required' });
  }
  try {
    if (key === OWNER_KEY) return next();
    const settings = await Settings.getOrCreate();
    if (settings.ownerPassword && key === settings.ownerPassword) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid owner key' });
  } catch (err) {
    res.status(500).json({ error: 'Owner authentication check failed', details: err.message });
  }
}

// ---------------------------------------------------------------------------
// Routes: Settings (pricing, UPI id, shop name)
// ---------------------------------------------------------------------------

// GET /api/settings -> public, the customer page needs this to compute price
// (ownerPassword is deliberately stripped before sending to the public).
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await Settings.getOrCreate();
    const { ownerPassword, ...publicSettings } = settings;
    res.json(publicSettings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings', details: err.message });
  }
});

// POST /api/settings -> owner only, updates pricing / UPI id / shop name
app.post('/api/settings', requireOwner, async (req, res) => {
  try {
    const {
      bw_price_per_page,
      color_price_per_page,
      owner_upi_id,
      owner_display_name,
      shopName,
      acceptingOrders,
    } = req.body;

    const fields = {};
    if (bw_price_per_page !== undefined) fields.bw_price_per_page = Number(bw_price_per_page);
    if (color_price_per_page !== undefined) fields.color_price_per_page = Number(color_price_per_page);
    if (owner_upi_id !== undefined) fields.owner_upi_id = owner_upi_id;
    if (owner_display_name !== undefined) fields.owner_display_name = owner_display_name;
    if (shopName !== undefined) fields.shopName = shopName;
    if (acceptingOrders !== undefined) fields.acceptingOrders = Boolean(acceptingOrders);

    const settings = await Settings.update(fields);
    const { ownerPassword, ...publicSettings } = settings;
    res.json(publicSettings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes: Owner login
// ---------------------------------------------------------------------------

// POST /api/owner/login -> checks username + password, used by the
// dashboard's sign-in screen. On success, the dashboard remembers the
// password and sends it as x-owner-key on every later request.
app.post('/api/owner/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const settings = await Settings.getOrCreate();

    const usernameOk = username.trim() === (settings.ownerUsername || 'owner');
    const passwordOk = password === OWNER_KEY || (settings.ownerPassword && password === settings.ownerPassword);

    if (usernameOk && passwordOk) {
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'Incorrect username or password' });
  } catch (err) {
    res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

// POST /api/owner/change-credentials -> owner sets/changes their dashboard
// username and/or password. Requires an already-valid key to call.
app.post('/api/owner/change-credentials', requireOwner, async (req, res) => {
  try {
    const { newUsername, newPassword } = req.body;
    const fields = {};
    if (newUsername !== undefined && newUsername.trim()) fields.ownerUsername = newUsername.trim();
    if (newPassword !== undefined) {
      if (newPassword.trim().length < 4) {
        return res.status(400).json({ error: 'New password must be at least 4 characters' });
      }
      fields.ownerPassword = newPassword.trim();
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await Settings.update(fields);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update credentials', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes: Orders (a checkout = one or more files, paid for together)
// ---------------------------------------------------------------------------

// POST /api/orders/create -> customer's whole cart in one request.
// multipart/form-data: a "files" field repeated once per file, plus an
// "items" field holding a JSON array (same order as the files) of:
//   { printType: 'bw'|'color', copies, startPage, endPage, customerNote }
app.post('/api/orders/create', upload.array('files', MAX_FILES_PER_ORDER), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const settings = await Settings.getOrCreate();
    if (!settings.acceptingOrders) {
      req.files.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(403).json({ error: 'Shop is currently not accepting new orders' });
    }

    let items;
    try {
      items = JSON.parse(req.body.items || '[]');
    } catch (e) {
      req.files.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'Malformed order items' });
    }

    if (!Array.isArray(items) || items.length !== req.files.length) {
      req.files.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'Each file needs matching print settings' });
    }

    const orderItems = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const meta = items[i] || {};

      if (!['bw', 'color'].includes(meta.printType)) {
        req.files.forEach((f) => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: `printType must be "bw" or "color" for ${file.originalname}` });
      }

      const startPage = Math.max(1, parseInt(meta.startPage, 10) || 1);
      const endPage = Math.max(startPage, parseInt(meta.endPage, 10) || startPage);
      const copies = Math.max(1, parseInt(meta.copies, 10) || 1);
      const totalPages = endPage - startPage + 1;
      const pricePerPage = meta.printType === 'color' ? settings.color_price_per_page : settings.bw_price_per_page;
      const totalAmount = Math.round(pricePerPage * totalPages * copies * 100) / 100;

      orderItems.push({
        fileUrl: `${PUBLIC_BASE_URL}/uploads/${file.filename}`,
        fileName: file.originalname,
        fileType: file.mimetype,
        printType: meta.printType,
        copies,
        startPage,
        endPage,
        totalPages,
        pricePerPage,
        totalAmount,
        customerNote: (meta.customerNote || '').toString().slice(0, 500),
      });
    }

    const jobs = await Job.createOrder(orderItems);
    const totalAmount = Math.round(jobs.reduce((sum, j) => sum + j.totalAmount, 0) * 100) / 100;

    res.status(201).json({
      orderId: jobs[0].orderId,
      orderToken: jobs[0].orderToken,
      totalAmount,
      jobs,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create order', details: err.message });
  }
});

// GET /api/orders/:orderId -> public, customer polls this for live status
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const jobs = await Job.findByOrderId(req.params.orderId);
    if (jobs.length === 0) return res.status(404).json({ error: 'Order not found' });

    const totalAmount = Math.round(jobs.reduce((sum, j) => sum + j.totalAmount, 0) * 100) / 100;
    res.json({
      orderId: req.params.orderId,
      orderToken: jobs[0].orderToken,
      paymentStatus: jobs[0].paymentStatus,
      paymentMethod: jobs[0].paymentMethod,
      totalAmount,
      jobs,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order', details: err.message });
  }
});

// POST /api/orders/:orderId/pay -> public, customer paid by UPI and is
// submitting the transaction reference. Releases every file in the order to
// the print queue at once.
app.post('/api/orders/:orderId/pay', async (req, res) => {
  try {
    const { utr } = req.body;
    if (!utr || utr.trim().length < 4) {
      return res.status(400).json({ error: 'A valid UPI transaction reference (UTR) is required' });
    }
    const existing = await Job.findByOrderId(req.params.orderId);
    if (existing.length === 0) return res.status(404).json({ error: 'Order not found' });

    const jobs = await Job.markOrderPaidUpi(req.params.orderId, utr.trim());
    res.json({ orderId: req.params.orderId, jobs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment', details: err.message });
  }
});

// POST /api/orders/:orderId/cash -> public, customer chose to pay cash at
// the counter. Nothing prints yet -- it waits for the owner to confirm.
app.post('/api/orders/:orderId/cash', async (req, res) => {
  try {
    const existing = await Job.findByOrderId(req.params.orderId);
    if (existing.length === 0) return res.status(404).json({ error: 'Order not found' });

    const jobs = await Job.setOrderCashPending(req.params.orderId);
    res.json({ orderId: req.params.orderId, jobs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set payment method', details: err.message });
  }
});

// POST /api/orders/:orderId/confirm-cash -> owner only, confirms a cash
// order was actually paid at the counter and releases it to print.
app.post('/api/orders/:orderId/confirm-cash', requireOwner, async (req, res) => {
  try {
    const existing = await Job.findByOrderId(req.params.orderId);
    if (existing.length === 0) return res.status(404).json({ error: 'Order not found' });

    const jobs = await Job.markOrderPaidCash(req.params.orderId);
    res.json({ orderId: req.params.orderId, jobs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to confirm payment', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes: Jobs (per file -- used by the print agent and dashboard table)
// ---------------------------------------------------------------------------

// GET /api/jobs/pending -> used by the print agent (owner-key protected so
// random people can't scrape the queue or trigger print traffic)
app.get('/api/jobs/pending', requireOwner, async (req, res) => {
  try {
    const jobs = await Job.findPending();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending jobs', details: err.message });
  }
});

// POST /api/jobs/complete -> the print agent calls this after it finishes
// (or fails) printing one file. body: { jobId, status: 'completed'|'failed', error? }
app.post('/api/jobs/complete', requireOwner, async (req, res) => {
  try {
    const { jobId, status, error } = req.body;
    if (!jobId || !['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'jobId and a valid status are required' });
    }
    const existing = await Job.findById(jobId);
    if (!existing) return res.status(404).json({ error: 'Job not found' });

    const job = await Job.setPrintResult(jobId, status, error);
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update job', details: err.message });
  }
});

// Owner manual override on a single file (e.g. retry a failed print).
app.post('/api/jobs/:id/status', requireOwner, async (req, res) => {
  try {
    const { printStatus, paymentStatus } = req.body;
    const existing = await Job.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Job not found' });

    const job = await Job.setStatus(req.params.id, { printStatus, paymentStatus });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update job', details: err.message });
  }
});

// GET /api/jobs/history -> owner dashboard table. One row per file; files
// from the same order share an orderToken and sit next to each other.
app.get('/api/jobs/history', requireOwner, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 150, 500);
    const jobs = await Job.findHistory(limit);
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch job history', details: err.message });
  }
});

// GET /api/jobs/stats -> today's/month's revenue (split by cash vs UPI),
// queue counts. Powers the summary cards on the owner dashboard.
app.get('/api/jobs/stats', requireOwner, async (req, res) => {
  try {
    const stats = await Job.computeStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute stats', details: err.message });
  }
});

// Health check for Hostinger
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Error handler -- must be defined last. Catches multer errors (unsupported
// file type, file too large, too many files) and anything else thrown
// synchronously in a route, and returns JSON instead of Express's default
// HTML error page, which the frontend's `await res.json()` calls expect.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const knownClientError =
    err.message && (err.message.includes('Unsupported file type') || err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT');
  const status = err.status || (knownClientError ? 400 : 500);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
initSchema()
  .then(() => {
    console.log('Connected to MySQL and verified tables');
    app.listen(PORT, () => console.log(`Print shop server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MySQL connection/setup error:', err.message);
    process.exit(1);
  });
