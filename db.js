// db.js
// -----------------------------------------------------------------------------
// MySQL connection pool + table setup.
//
// Works with any standard MySQL/MariaDB database, including Hostinger's
// shared MySQL hosting (hPanel > Databases > MySQL Databases).
//
// Tables are created automatically the first time the server starts. For an
// existing database created by an earlier version of this project,
// ensureColumn() adds any new columns it's missing without touching your
// existing rows. schema.sql has the same statements for a manual import via
// phpMyAdmin if you'd rather do that once instead.
// -----------------------------------------------------------------------------

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'print_shop',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true, // return DECIMAL columns as JS numbers, not strings
});

// Adds a column to an existing table if it isn't already there. Safe to
// call every time the server starts -- a no-op once the column exists.
async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (rows[0].cnt === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      settings_key VARCHAR(50) NOT NULL UNIQUE DEFAULT 'shop',
      shopName VARCHAR(255) NOT NULL DEFAULT 'Quick Print Xerox',
      bw_price_per_page DECIMAL(10,2) NOT NULL DEFAULT 2.00,
      color_price_per_page DECIMAL(10,2) NOT NULL DEFAULT 10.00,
      owner_upi_id VARCHAR(255) NOT NULL DEFAULT 'shopowner@upi',
      owner_display_name VARCHAR(255) NOT NULL DEFAULT 'Quick Print Xerox',
      acceptingOrders TINYINT(1) NOT NULL DEFAULT 1,
      ownerUsername VARCHAR(100) NOT NULL DEFAULT 'owner',
      ownerPassword VARCHAR(255) DEFAULT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Upgrading an older database that doesn't have ownerUsername yet
  await ensureColumn('settings', 'ownerUsername', "ownerUsername VARCHAR(100) NOT NULL DEFAULT 'owner'");

  // One row per uploaded FILE (an "order" placed at checkout can contain
  // several files/jobs, grouped by orderId/orderToken, each billed and
  // printed as its own row).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id CHAR(36) PRIMARY KEY,
      orderId CHAR(36) NOT NULL,
      orderToken VARCHAR(20) NOT NULL,
      tokenId VARCHAR(20) NOT NULL UNIQUE,
      fileUrl VARCHAR(500) NOT NULL,
      fileName VARCHAR(255) NOT NULL,
      fileType VARCHAR(100) DEFAULT NULL,
      printType ENUM('bw','color') NOT NULL,
      copies INT NOT NULL DEFAULT 1,
      startPage INT NOT NULL DEFAULT 1,
      endPage INT NOT NULL DEFAULT 1,
      totalPages INT NOT NULL,
      pricePerPage DECIMAL(10,2) NOT NULL,
      totalAmount DECIMAL(10,2) NOT NULL,
      paymentStatus ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
      paymentMethod ENUM('upi','cash') NOT NULL DEFAULT 'upi',
      utr VARCHAR(100) DEFAULT NULL,
      customerNote VARCHAR(500) NOT NULL DEFAULT '',
      printStatus ENUM('awaiting_payment','queued','printing','completed','failed') NOT NULL DEFAULT 'awaiting_payment',
      printError VARCHAR(500) DEFAULT NULL,
      printedAt DATETIME DEFAULT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_order (orderId),
      INDEX idx_payment_print (paymentStatus, printStatus),
      INDEX idx_created (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Upgrading an older single-file-per-job database: add the new columns
  // if they're missing, without disturbing any existing rows.
  await ensureColumn('jobs', 'orderId', 'orderId CHAR(36) NULL');
  await ensureColumn('jobs', 'orderToken', 'orderToken VARCHAR(20) NULL');
  await ensureColumn('jobs', 'paymentMethod', "paymentMethod ENUM('upi','cash') NOT NULL DEFAULT 'upi'");
  await ensureColumn('jobs', 'startPage', 'startPage INT NOT NULL DEFAULT 1');
  await ensureColumn('jobs', 'endPage', 'endPage INT NOT NULL DEFAULT 1');
}

module.exports = { pool, initSchema };
