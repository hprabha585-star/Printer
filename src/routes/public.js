/*
 * Public API (customer page, no login).
 */
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const orders = require('../orders');
const analyzer = require('../analyzer');
const { kindFromName } = require('../analyzer/sniff');
const { getSettings, publicSettings } = require('../settings');
const { UserError, randomId, ah, rateLimit, cleanFileName } = require('../util');

const router = express.Router();
const uploadDir = path.join(config.storageDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${randomId(12)}.tmp`),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 5 },
});

router.get('/settings', ah(async (req, res) => {
  const s = await getSettings();
  res.json({ ...publicSettings(s), max_upload_mb: config.maxUploadMb, max_pages: config.maxPages });
}));

// Analyse one file (rate-limited per client IP)
router.post('/analyse',
  rateLimit({ windowMs: 10 * 60 * 1000, max: config.analyseRateLimit, message: 'You have uploaded a lot of files. Please wait a few minutes and try again.' }),
  upload.single('file'),
  ah(async (req, res) => {
    const f = req.file;
    if (!f) throw new UserError(400, 'Please choose a file.', 'no_file');
    const discard = () => fs.promises.unlink(f.path).catch(() => {});
    try {
      const s = await getSettings();
      if (!s.accepting_orders) throw new UserError(503, 'Sorry, the shop is not accepting orders right now.', 'closed');
      const name = cleanFileName(f.originalname);
      const claimed = kindFromName(name);
      if (claimed === 'office') throw new UserError(415, 'Word, Excel and PowerPoint files can\'t be printed directly. Open the file and choose "Save as PDF" (or Print → Save as PDF), then upload the PDF.', 'office');
      if (!['pdf', 'jpg', 'png'].includes(claimed)) throw new UserError(415, 'Only PDF, JPG and PNG files are accepted.', 'type');

      const r = await analyzer.analyse(f.path, claimed);
      if (!r.ok) throw new UserError(422, r.message, r.code);
      const a = r.result;
      if (a.micro.verdict === 'blocked') throw new UserError(422, a.micro.reason, 'microtext_blocked');

      const id = randomId(12);
      const finalPath = path.join(uploadDir, `${id}.${a.kind}`);
      await fs.promises.rename(f.path, finalPath);
      await db.q(`INSERT INTO uploads (id, file_path, file_name, file_kind, file_size, page_count, coverage_json, micro_verdict, micro_reason, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP())`,
        [id, path.basename(finalPath), name, a.kind, f.size, a.pages, JSON.stringify(a.coverage), a.micro.verdict, a.micro.reason ? a.micro.reason.slice(0, 255) : null]);
      res.json({
        upload_id: id, file_name: name, kind: a.kind, pages: a.pages, coverage: a.coverage,
        micro_verdict: a.micro.verdict,
        notice: a.micro.verdict === 'suspect' ? 'This file has some very small print. The shop will take a quick look before printing it.' : null,
      });
    } catch (e) {
      await discard();
      throw e;
    }
  }));

router.post('/orders', ah(async (req, res) => {
  res.json(await orders.createOrder(req.body && req.body.items));
}));

router.get('/orders/:token', ah(async (req, res) => {
  res.json(await orders.orderStatus(req.params.token, req.query.k));
}));

router.post('/orders/:token/utr', ah(async (req, res) => {
  res.json(await orders.submitUtr(req.params.token, req.body.k, req.body.utr));
}));

router.post('/orders/:token/cash', ah(async (req, res) => {
  res.json(await orders.chooseCash(req.params.token, req.body.k));
}));

router.post('/orders/:token/gateway', ah(async (req, res) => {
  res.json(await orders.startGatewayCheckout(req.params.token, req.body.k));
}));

module.exports = router;
