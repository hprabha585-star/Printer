/*
 * MySQL connection + automatic table creation and in-place upgrades.
 *
 * Every startup runs migrate(): tables are created if missing, and any column
 * or index added in a newer version is added to an older database without
 * touching existing data.
 */
'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.db,
      waitForConnections: true,
      connectionLimit: 8,
      dateStrings: false,
      timezone: 'Z',
      supportBigNumbers: true,
      decimalNumbers: true,
    });
  }
  return pool;
}

const q = async (sql, params) => (await getPool().query(sql, params))[0];

/** Run fn(conn) inside a transaction; commits or rolls back. */
async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

/* ---------- Schema ---------- */
// Base tables. Columns added later are listed in COLUMNS below so old databases upgrade.
const TABLES = {
  settings: `CREATE TABLE IF NOT EXISTS settings (
    id TINYINT PRIMARY KEY,
    shop_name VARCHAR(120) NOT NULL DEFAULT 'Print Shop'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  printers: `CREATE TABLE IF NOT EXISTS printers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(80) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  connectors: `CREATE TABLE IF NOT EXISTS connectors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    computer_name VARCHAR(120) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  uploads: `CREATE TABLE IF NOT EXISTS uploads (
    id CHAR(24) PRIMARY KEY
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  orders: `CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(16) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  jobs: `CREATE TABLE IF NOT EXISTS jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  payment_events: `CREATE TABLE IF NOT EXISTS payment_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(30) NOT NULL,
    event_id VARCHAR(120) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

// [table, column, definition]
const COLUMNS = [
  // settings
  ['settings', 'rate_bw', "DECIMAL(8,2) NOT NULL DEFAULT 2.00"],
  ['settings', 'rate_partial', "DECIMAL(8,2) NOT NULL DEFAULT 5.00"],
  ['settings', 'rate_full', "DECIMAL(8,2) NOT NULL DEFAULT 10.00"],
  ['settings', 'color_threshold', "DECIMAL(5,2) NOT NULL DEFAULT 25.00"],
  ['settings', 'upi_id', "VARCHAR(120) NOT NULL DEFAULT ''"],
  ['settings', 'payee_name', "VARCHAR(120) NOT NULL DEFAULT ''"],
  ['settings', 'payment_mode', "VARCHAR(16) NOT NULL DEFAULT 'utr'"],
  ['settings', 'verify_upi', "TINYINT(1) NOT NULL DEFAULT 1"],
  ['settings', 'allow_cash', "TINYINT(1) NOT NULL DEFAULT 1"],
  ['settings', 'accepting_orders', "TINYINT(1) NOT NULL DEFAULT 1"],
  ['settings', 'owner_username', "VARCHAR(80) NULL"],
  ['settings', 'owner_password_hash', "VARCHAR(255) NULL"],
  ['settings', 'session_version', "INT NOT NULL DEFAULT 1"],
  ['settings', 'updated_at', "DATETIME NULL"],

  // printers
  ['printers', 'color_capable', "TINYINT(1) NOT NULL DEFAULT 0"],
  ['printers', 'enabled', "TINYINT(1) NOT NULL DEFAULT 1"],
  ['printers', 'sort_order', "INT NOT NULL DEFAULT 0"],

  // connectors
  ['connectors', 'last_seen', "DATETIME NULL"],
  ['connectors', 'printers_json', "TEXT NULL"],
  ['connectors', 'version', "VARCHAR(30) NULL"],
  ['connectors', 'first_seen', "DATETIME NULL"],

  // uploads (analysed but not yet ordered)
  ['uploads', 'file_path', "VARCHAR(255) NOT NULL DEFAULT ''"],
  ['uploads', 'file_name', "VARCHAR(255) NOT NULL DEFAULT ''"],
  ['uploads', 'file_kind', "VARCHAR(8) NOT NULL DEFAULT ''"],
  ['uploads', 'file_size', "INT NOT NULL DEFAULT 0"],
  ['uploads', 'page_count', "INT NOT NULL DEFAULT 0"],
  ['uploads', 'coverage_json', "MEDIUMTEXT NULL"],
  ['uploads', 'micro_verdict', "VARCHAR(10) NOT NULL DEFAULT 'ok'"],
  ['uploads', 'micro_reason', "VARCHAR(255) NULL"],
  ['uploads', 'created_at', "DATETIME NULL"],

  // orders (one payment for many files)
  ['orders', 'access_key', "CHAR(20) NOT NULL DEFAULT ''"],
  ['orders', 'total_paise', "INT NOT NULL DEFAULT 0"],
  ['orders', 'payment_status', "VARCHAR(20) NOT NULL DEFAULT 'unpaid'"],
  ['orders', 'payment_method', "VARCHAR(10) NULL"],
  ['orders', 'utr', "CHAR(12) NULL"],
  ['orders', 'gateway_provider', "VARCHAR(30) NULL"],
  ['orders', 'gateway_ref', "VARCHAR(120) NULL"],
  ['orders', 'refund_if_paid', "TINYINT(1) NOT NULL DEFAULT 0"],
  ['orders', 'created_at', "DATETIME NULL"],
  ['orders', 'paid_at', "DATETIME NULL"],
  ['orders', 'updated_at', "DATETIME NULL"],

  // jobs (one per file)
  ['jobs', 'ticket', "VARCHAR(24) NOT NULL DEFAULT ''"],
  ['jobs', 'upload_id', "CHAR(24) NULL"],
  ['jobs', 'file_path', "VARCHAR(255) NOT NULL DEFAULT ''"],
  ['jobs', 'file_name', "VARCHAR(255) NOT NULL DEFAULT ''"],
  ['jobs', 'file_kind', "VARCHAR(8) NOT NULL DEFAULT ''"],
  ['jobs', 'total_pages', "INT NOT NULL DEFAULT 0"],
  ['jobs', 'page_start', "INT NOT NULL DEFAULT 1"],
  ['jobs', 'page_end', "INT NOT NULL DEFAULT 1"],
  ['jobs', 'copies', "INT NOT NULL DEFAULT 1"],
  ['jobs', 'color_mode', "VARCHAR(8) NOT NULL DEFAULT 'bw'"],
  ['jobs', 'note', "VARCHAR(300) NULL"],
  ['jobs', 'pages_bw', "INT NOT NULL DEFAULT 0"],
  ['jobs', 'pages_partial', "INT NOT NULL DEFAULT 0"],
  ['jobs', 'pages_full', "INT NOT NULL DEFAULT 0"],
  ['jobs', 'rate_bw', "DECIMAL(8,2) NOT NULL DEFAULT 0"],
  ['jobs', 'rate_partial', "DECIMAL(8,2) NOT NULL DEFAULT 0"],
  ['jobs', 'rate_full', "DECIMAL(8,2) NOT NULL DEFAULT 0"],
  ['jobs', 'color_threshold', "DECIMAL(5,2) NOT NULL DEFAULT 25"],
  ['jobs', 'amount_paise', "INT NOT NULL DEFAULT 0"],
  ['jobs', 'payment_status', "VARCHAR(20) NOT NULL DEFAULT 'unpaid'"],
  ['jobs', 'payment_method', "VARCHAR(10) NULL"],
  ['jobs', 'utr', "CHAR(12) NULL"],
  ['jobs', 'gateway_ref', "VARCHAR(120) NULL"],
  ['jobs', 'micro_verdict', "VARCHAR(10) NOT NULL DEFAULT 'ok'"],
  ['jobs', 'micro_reason', "VARCHAR(255) NULL"],
  ['jobs', 'print_status', "VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'"],
  ['jobs', 'printer_label', "VARCHAR(80) NULL"],
  ['jobs', 'computer_name', "VARCHAR(120) NULL"],
  ['jobs', 'claimed_at', "DATETIME NULL"],
  ['jobs', 'finished_at', "DATETIME NULL"],
  ['jobs', 'attempts', "INT NOT NULL DEFAULT 0"],
  ['jobs', 'error', "VARCHAR(500) NULL"],
  ['jobs', 'refund_if_paid', "TINYINT(1) NOT NULL DEFAULT 0"],
  ['jobs', 'reviewed', "TINYINT(1) NOT NULL DEFAULT 0"],
  ['jobs', 'created_at', "DATETIME NULL"],
  ['jobs', 'updated_at', "DATETIME NULL"],

  // payment events (webhook idempotency)
  ['payment_events', 'order_token', "VARCHAR(16) NULL"],
  ['payment_events', 'event_type', "VARCHAR(40) NULL"],
  ['payment_events', 'amount_paise', "INT NULL"],
  ['payment_events', 'outcome', "VARCHAR(60) NULL"],
  ['payment_events', 'received_at', "DATETIME NULL"],
];

// [table, index name, definition]
const INDEXES = [
  ['printers', 'uq_printer_label', 'UNIQUE (label)'],
  ['connectors', 'uq_connector_name', 'UNIQUE (computer_name)'],
  ['orders', 'uq_order_token', 'UNIQUE (token)'],
  ['orders', 'uq_order_utr', 'UNIQUE (utr)'], // a UTR can back only ONE order
  ['orders', 'uq_order_gateway_ref', 'UNIQUE (gateway_ref)'],
  ['orders', 'ix_order_paid', '(paid_at)'],
  ['jobs', 'ix_job_order', '(order_id)'],
  ['jobs', 'ix_job_status', '(print_status)'],
  ['jobs', 'ix_job_printer', '(printer_label, print_status)'],
  ['jobs', 'uq_job_ticket', 'UNIQUE (ticket)'],
  ['uploads', 'ix_upload_created', '(created_at)'],
  ['payment_events', 'uq_payment_event', 'UNIQUE (provider, event_id)'],
];

async function migrate() {
  for (const sql of Object.values(TABLES)) await q(sql);

  const cols = await q(
    'SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
  const have = new Set(cols.map((r) => `${r.t}.${r.c}`));
  for (const [t, c, def] of COLUMNS) {
    if (!have.has(`${t}.${c}`)) await q(`ALTER TABLE \`${t}\` ADD COLUMN \`${c}\` ${def}`);
  }

  const idx = await q(
    'SELECT DISTINCT TABLE_NAME t, INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()');
  const haveIdx = new Set(idx.map((r) => `${r.t}.${r.i}`));
  for (const [t, name, def] of INDEXES) {
    if (!haveIdx.has(`${t}.${name}`)) {
      const unique = def.startsWith('UNIQUE');
      const colsDef = unique ? def.slice(6).trim() : def;
      await q(`ALTER TABLE \`${t}\` ADD ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ${colsDef}`);
    }
  }

  // Exactly one settings row.
  await q('INSERT IGNORE INTO settings (id, shop_name, updated_at) VALUES (1, ?, UTC_TIMESTAMP())', ['Print Shop']);

  // Three printers by default (the owner can rename them).
  const [{ n }] = await q('SELECT COUNT(*) n FROM printers');
  if (n === 0) {
    await q(`INSERT INTO printers (label, color_capable, enabled, sort_order) VALUES
      ('Printer 1 - Colour', 1, 1, 1), ('Printer 2 - B&W', 0, 1, 2), ('Printer 3 - B&W', 0, 1, 3)`);
  }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, q, tx, migrate, close, COLUMNS, INDEXES, TABLES };
