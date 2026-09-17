// server.js
// -----------------------------------------------------------------------------
// Backend for the self-service print shop.
// - Customers upload a file + pick print options -> a Job is created (unpaid).
// - Customer pays via UPI deep link, then types in the UTR (transaction ref).
// - Owner marks payment verified (or you can trust the UTR automatically).
// - The local Python agent (print_agent.py) polls /api/jobs/pending, downloads
//   the file, prints it on the shop's printer, and calls /api/jobs/complete.
// -----------------------------------------------------------------------------

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Job = require('./models/Job');
const Settings = require('./models/Settings');

const app = express();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/print_shop';
// Shared secret the owner dashboard + print agent must send to do privileged
// actions (change pricing, mark jobs complete/paid). Set this in your Render
// environment variables. Falls back to a default for local dev only.
const OWNER_KEY = process.env.OWNER_KEY || 'change-me-owner-key';
// Public base URL of this server, used to build absolute file download links
// for the print agent (e.g. https://your-app.onrender.com)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the customer/owner frontend
app.use(express.static(path.join(__dirname, 'public')));

// Make sure the uploads folder exists, then serve uploaded files statically
// so the print agent can download them by URL.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer: store uploads to local disk with a collision-proof filename.
// NOTE: On Render's free tier, local disk is ephemeral (wiped on redeploy /
// restart). For a production shop that's fine because jobs are meant to be
// printed and cleared quickly. If you need durability, swap this storage
// engine for an S3/Cloudinary multer storage adapter and keep the rest of
// the API the same (fileUrl just becomes a cloud URL).
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

// Simple owner-only guard for privileged routes (pricing changes, marking
// jobs paid/complete). The owner dashboard sends this as an "x-owner-key"
// header, entered once and cached in the browser.
function requireOwner(req, res, next) {
  const key = req.headers['x-owner-key'];
  if (!key || key !== OWNER_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid owner key' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Generates a short customer-facing token like "PX-4821"
function generateTokenId() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `PX-${n}`;
}

// Ensures a Settings document always exists, returns it.
async function getOrCreateSettings() {
  let settings = await Settings.findOne({ key: 'shop' });
  if (!settings) {
    settings = await Settings.create({ key: 'shop' });
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Routes: Settings (pricing, UPI id, shop name)
// ---------------------------------------------------------------------------

// GET /api/settings -> public, the customer page needs this to compute price
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
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

    const settings = await getOrCreateSettings();

    if (bw_price_per_page !== undefined) settings.bw_price_per_page = Number(bw_price_per_page);
    if (color_price_per_page !== undefined) settings.color_price_per_page = Number(color_price_per_page);
    if (owner_upi_id !== undefined) settings.owner_upi_id = owner_upi_id;
    if (owner_display_name !== undefined) settings.owner_display_name = owner_display_name;
    if (shopName !== undefined) settings.shopName = shopName;
    if (acceptingOrders !== undefined) settings.acceptingOrders = Boolean(acceptingOrders);

    await settings.save();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes: Jobs
// ---------------------------------------------------------------------------

// POST /api/jobs/create -> customer uploads a file + print options.
// multipart/form-data fields: file, printType, copies, pageRange, totalPages
app.post('/api/jobs/create', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const settings = await getOrCreateSettings();
    if (!settings.acceptingOrders) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Shop is currently not accepting new orders' });
    }

    const { printType, copies, pageRange, totalPages, customerNote } = req.body;

    if (!['bw', 'color'].includes(printType)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'printType must be "bw" or "color"' });
    }

    const pages = Math.max(1, parseInt(totalPages, 10) || 1);
    const numCopies = Math.max(1, parseInt(copies, 10) || 1);
    const pricePerPage =
      printType === 'color' ? settings.color_price_per_page : settings.bw_price_per_page;
    const totalAmount = pricePerPage * pages * numCopies;

    // Build an absolute URL so the local print agent (running on a different
    // machine than this server) can download the file over HTTP(S).
    const fileUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;

    let tokenId = generateTokenId();
    // Extremely unlikely collision, but guard anyway
    while (await Job.findOne({ tokenId })) tokenId = generateTokenId();

    const job = await Job.create({
      tokenId,
      fileUrl,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      printType,
      copies: numCopies,
      pageRange: pageRange || 'all',
      totalPages: pages,
      pricePerPage,
      totalAmount,
      customerNote: customerNote || '',
      paymentStatus: 'pending',
      printStatus: 'awaiting_payment',
    });

    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create job', details: err.message });
  }
});

// POST /api/jobs/:id/pay -> customer submits their UPI UTR after paying.
// This does NOT require the owner key, since it's the customer's own step,
// but it only ever moves paymentStatus to "paid" (pending owner/agent trust),
// and the actual physical print only starts once printStatus is "queued".
app.post('/api/jobs/:id/pay', async (req, res) => {
  try {
    const { utr } = req.body;
    if (!utr || utr.trim().length < 4) {
      return res.status(400).json({ error: 'A valid UPI transaction reference (UTR) is required' });
    }

    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    job.utr = utr.trim();
    job.paymentStatus = 'paid';
    job.printStatus = 'queued'; // now visible to the print agent
    await job.save();

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment', details: err.message });
  }
});

// GET /api/jobs/:id -> customer polls this to see their own job status
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch job', details: err.message });
  }
});

// GET /api/jobs/pending -> used by print_agent.py (owner-key protected so
// random people can't scrape the queue or trigger print traffic)
app.get('/api/jobs/pending', requireOwner, async (req, res) => {
  try {
    const jobs = await Job.find({
      paymentStatus: 'paid',
      printStatus: 'queued',
    }).sort({ createdAt: 1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending jobs', details: err.message });
  }
});

// POST /api/jobs/complete -> print_agent.py calls this after it finishes (or
// fails) printing a job. body: { jobId, status: 'completed' | 'failed', error? }
app.post('/api/jobs/complete', requireOwner, async (req, res) => {
  try {
    const { jobId, status, error } = req.body;
    if (!jobId || !['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'jobId and a valid status are required' });
    }

    const job = await Job.findById(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    job.printStatus = status;
    job.printError = status === 'failed' ? error || 'Unknown printer error' : null;
    if (status === 'completed') job.printedAt = new Date();
    await job.save();

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update job', details: err.message });
  }
});

// Owner can also mark printing-in-progress, or manually override any job
// (e.g. re-queue a failed job, or force-verify a payment the agent missed).
app.post('/api/jobs/:id/status', requireOwner, async (req, res) => {
  try {
    const { printStatus, paymentStatus } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (printStatus) job.printStatus = printStatus;
    if (paymentStatus) job.paymentStatus = paymentStatus;
    await job.save();

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update job', details: err.message });
  }
});

// GET /api/jobs/history -> owner dashboard table + revenue stats source.
// Optional query params: ?limit=50
app.get('/api/jobs/history', requireOwner, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const jobs = await Job.find().sort({ createdAt: -1 }).limit(limit);
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch job history', details: err.message });
  }
});

// GET /api/jobs/stats -> today's revenue, this month's revenue, job counts.
// Powers the summary cards on the owner dashboard.
app.get('/api/jobs/stats', requireOwner, async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const paidFilter = { paymentStatus: 'paid' };

    const [todayJobs, monthJobs, pendingCount, completedTodayCount] = await Promise.all([
      Job.find({ ...paidFilter, createdAt: { $gte: startOfToday } }),
      Job.find({ ...paidFilter, createdAt: { $gte: startOfMonth } }),
      Job.countDocuments({ printStatus: { $in: ['queued', 'printing'] } }),
      Job.countDocuments({ printStatus: 'completed', printedAt: { $gte: startOfToday } }),
    ]);

    const sum = (jobs) => jobs.reduce((acc, j) => acc + (j.totalAmount || 0), 0);

    res.json({
      todayRevenue: sum(todayJobs),
      monthRevenue: sum(monthJobs),
      todayJobCount: todayJobs.length,
      monthJobCount: monthJobs.length,
      pendingQueueCount: pendingCount,
      completedTodayCount,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute stats', details: err.message });
  }
});

// Health check for Render
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Print shop server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
