// models/Job.js
// Data access for print jobs. One row per uploaded FILE. A customer's
// checkout ("order") can contain several files, each with its own print
// settings -- they share an orderId/orderToken but are billed, printed, and
// tracked individually. Every job is still returned with an `_id` field
// (even though the MySQL primary key column is `id`) so the frontend and
// print agent logic stays simple.

const crypto = require('crypto');
const { pool } = require('../db');

function normalize(row) {
  if (!row) return null;
  return {
    _id: row.id,
    orderId: row.orderId,
    orderToken: row.orderToken,
    tokenId: row.tokenId,
    fileUrl: row.fileUrl,
    fileName: row.fileName,
    fileType: row.fileType,
    printType: row.printType,
    copies: row.copies,
    startPage: row.startPage,
    endPage: row.endPage,
    totalPages: row.totalPages,
    pricePerPage: Number(row.pricePerPage),
    totalAmount: Number(row.totalAmount),
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    utr: row.utr,
    customerNote: row.customerNote,
    printStatus: row.printStatus,
    printError: row.printError,
    printedAt: row.printedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Creates every file in one checkout as its own job row, all sharing a
// freshly generated orderId + a short customer-facing orderToken (e.g.
// "PX-4821"). Each file's own ticket is "PX-4821-1", "PX-4821-2", etc.
// `items` is an array of:
//   { fileUrl, fileName, fileType, printType, copies, startPage, endPage,
//     pricePerPage, totalAmount, customerNote }
async function createOrder(items) {
  const orderId = crypto.randomUUID();
  const orderToken = await generateUniqueOrderToken();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const ids = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const id = crypto.randomUUID();
      const tokenId = `${orderToken}-${i + 1}`;
      ids.push(id);
      await conn.query(
        `INSERT INTO jobs
          (id, orderId, orderToken, tokenId, fileUrl, fileName, fileType, printType,
           copies, startPage, endPage, totalPages, pricePerPage, totalAmount, customerNote,
           paymentStatus, printStatus)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'awaiting_payment')`,
        [
          id,
          orderId,
          orderToken,
          tokenId,
          item.fileUrl,
          item.fileName,
          item.fileType || null,
          item.printType,
          item.copies,
          item.startPage,
          item.endPage,
          item.totalPages,
          item.pricePerPage,
          item.totalAmount,
          item.customerNote || '',
        ]
      );
    }
    await conn.commit();
    return findByOrderId(orderId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function generateUniqueOrderToken() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const n = Math.floor(1000 + Math.random() * 9000);
    const token = `PX-${n}`;
    const [rows] = await pool.query('SELECT 1 FROM jobs WHERE orderToken = ? LIMIT 1', [token]);
    if (rows.length === 0) return token;
  }
  // astronomically unlikely, but fall back to something still-unique
  return `PX-${Date.now()}`;
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ? LIMIT 1', [id]);
  return normalize(rows[0]);
}

async function findByOrderId(orderId) {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE orderId = ? ORDER BY createdAt ASC', [orderId]);
  return rows.map(normalize);
}

// Jobs that are paid and waiting to be printed, oldest first -- what the
// print agent asks for every poll. (Per file, regardless of which order
// each file belongs to -- the agent just prints one file at a time.)
async function findPending() {
  const [rows] = await pool.query(
    `SELECT * FROM jobs WHERE paymentStatus = 'paid' AND printStatus = 'queued' ORDER BY createdAt ASC`
  );
  return rows.map(normalize);
}

// Recent jobs for the owner dashboard table (one row per file; files from
// the same order share an orderToken and sit next to each other since
// they're created at the same moment).
async function findHistory(limit = 150) {
  const [rows] = await pool.query('SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?', [limit]);
  return rows.map(normalize);
}

// Customer paid the whole order via UPI and entered a UTR -> every file in
// the order moves into the print queue together.
async function markOrderPaidUpi(orderId, utr) {
  await pool.query(
    `UPDATE jobs SET utr = ?, paymentMethod = 'upi', paymentStatus = 'paid', printStatus = 'queued' WHERE orderId = ?`,
    [utr, orderId]
  );
  return findByOrderId(orderId);
}

// Customer chose to pay cash at the counter -- flags the order so the owner
// dashboard can show it as "awaiting cash payment"; nothing prints yet.
async function setOrderCashPending(orderId) {
  await pool.query(`UPDATE jobs SET paymentMethod = 'cash' WHERE orderId = ?`, [orderId]);
  return findByOrderId(orderId);
}

// Owner dashboard: confirm a cash order was actually paid at the counter ->
// moves every file in the order into the print queue.
async function markOrderPaidCash(orderId) {
  await pool.query(
    `UPDATE jobs SET paymentMethod = 'cash', paymentStatus = 'paid', printStatus = 'queued' WHERE orderId = ?`,
    [orderId]
  );
  return findByOrderId(orderId);
}

// Print agent reports success/failure after attempting to print one file.
async function setPrintResult(id, status, error) {
  if (status === 'completed') {
    await pool.query(
      `UPDATE jobs SET printStatus = ?, printError = NULL, printedAt = NOW() WHERE id = ?`,
      [status, id]
    );
  } else {
    await pool.query(`UPDATE jobs SET printStatus = ?, printError = ? WHERE id = ?`, [
      status,
      error || 'Unknown printer error',
      id,
    ]);
  }
  return findById(id);
}

// Owner dashboard manual override on a single file (e.g. retry a failed print).
async function setStatus(id, { printStatus, paymentStatus }) {
  const sets = [];
  const values = [];
  if (printStatus) {
    sets.push('printStatus = ?');
    values.push(printStatus);
  }
  if (paymentStatus) {
    sets.push('paymentStatus = ?');
    values.push(paymentStatus);
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  await pool.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, values);
  return findById(id);
}

// Revenue + queue counts for the owner dashboard's stat cards, broken down
// by payment method (cash vs UPI) as well as totals.
async function computeStats() {
  const [todayByMethod] = await pool.query(
    `SELECT paymentMethod, COALESCE(SUM(totalAmount),0) AS revenue, COUNT(*) AS cnt
     FROM jobs WHERE paymentStatus = 'paid' AND createdAt >= CURDATE() GROUP BY paymentMethod`
  );
  const [monthByMethod] = await pool.query(
    `SELECT paymentMethod, COALESCE(SUM(totalAmount),0) AS revenue, COUNT(*) AS cnt
     FROM jobs WHERE paymentStatus = 'paid' AND createdAt >= DATE_FORMAT(NOW(), '%Y-%m-01') GROUP BY paymentMethod`
  );
  const [[pendingRow]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM jobs WHERE printStatus IN ('queued', 'printing')`
  );
  const [[completedRow]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM jobs WHERE printStatus = 'completed' AND printedAt >= CURDATE()`
  );
  const [[pendingCashRow]] = await pool.query(
    `SELECT COUNT(DISTINCT orderId) AS cnt FROM jobs WHERE paymentMethod = 'cash' AND paymentStatus = 'pending'`
  );

  const sumMethod = (rows, method) => {
    const r = rows.find((x) => x.paymentMethod === method);
    return r ? Number(r.revenue) : 0;
  };
  const sumAll = (rows) => rows.reduce((acc, r) => acc + Number(r.revenue), 0);
  const cntAll = (rows) => rows.reduce((acc, r) => acc + Number(r.cnt), 0);

  return {
    todayRevenue: sumAll(todayByMethod),
    todayRevenueUpi: sumMethod(todayByMethod, 'upi'),
    todayRevenueCash: sumMethod(todayByMethod, 'cash'),
    todayJobCount: cntAll(todayByMethod),

    monthRevenue: sumAll(monthByMethod),
    monthRevenueUpi: sumMethod(monthByMethod, 'upi'),
    monthRevenueCash: sumMethod(monthByMethod, 'cash'),
    monthJobCount: cntAll(monthByMethod),

    pendingQueueCount: pendingRow.cnt,
    completedTodayCount: completedRow.cnt,
    pendingCashOrderCount: pendingCashRow.cnt,
  };
}

module.exports = {
  createOrder,
  findById,
  findByOrderId,
  findPending,
  findHistory,
  markOrderPaidUpi,
  setOrderCashPending,
  markOrderPaidCash,
  setPrintResult,
  setStatus,
  computeStats,
};
