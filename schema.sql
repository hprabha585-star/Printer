-- schema.sql
-- Optional: db.js already creates/upgrades these tables automatically on
-- every server start. Use this file only if you'd rather set the schema up
-- by hand once via Hostinger's phpMyAdmin (hPanel > Databases > phpMyAdmin).

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

-- One row per uploaded FILE. A customer's checkout ("order") can contain
-- several files, grouped by orderId/orderToken, each billed and printed as
-- its own row (its own per-file token like "PX-4821-1", "PX-4821-2", ...).
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
