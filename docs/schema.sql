-- Schema reference (generated from a real database after automatic migration).
-- You do NOT need to run this: server.js creates and upgrades these tables at every start.

CREATE TABLE `settings` (
  `id` tinyint(4) NOT NULL,
  `shop_name` varchar(120) NOT NULL DEFAULT 'Print Shop',
  `rate_bw` decimal(8,2) NOT NULL DEFAULT 2.00,
  `rate_partial` decimal(8,2) NOT NULL DEFAULT 5.00,
  `rate_full` decimal(8,2) NOT NULL DEFAULT 10.00,
  `color_threshold` decimal(5,2) NOT NULL DEFAULT 25.00,
  `upi_id` varchar(120) NOT NULL DEFAULT '',
  `payee_name` varchar(120) NOT NULL DEFAULT '',
  `payment_mode` varchar(16) NOT NULL DEFAULT 'utr',
  `verify_upi` tinyint(1) NOT NULL DEFAULT 1,
  `allow_cash` tinyint(1) NOT NULL DEFAULT 1,
  `accepting_orders` tinyint(1) NOT NULL DEFAULT 1,
  `owner_username` varchar(80) DEFAULT NULL,
  `owner_password_hash` varchar(255) DEFAULT NULL,
  `session_version` int(11) NOT NULL DEFAULT 1,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
;

CREATE TABLE `printers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `label` varchar(80) NOT NULL,
  `color_capable` tinyint(1) NOT NULL DEFAULT 0,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_printer_label` (`label`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
;

CREATE TABLE `connectors` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `computer_name` varchar(120) NOT NULL,
  `last_seen` datetime DEFAULT NULL,
  `printers_json` text DEFAULT NULL,
  `version` varchar(30) DEFAULT NULL,
  `first_seen` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_connector_name` (`computer_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
;

CREATE TABLE `uploads` (
  `id` char(24) NOT NULL,
  `file_path` varchar(255) NOT NULL DEFAULT '',
  `file_name` varchar(255) NOT NULL DEFAULT '',
  `file_kind` varchar(8) NOT NULL DEFAULT '',
  `file_size` int(11) NOT NULL DEFAULT 0,
  `page_count` int(11) NOT NULL DEFAULT 0,
  `coverage_json` mediumtext DEFAULT NULL,
  `micro_verdict` varchar(10) NOT NULL DEFAULT 'ok',
  `micro_reason` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_upload_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
;

CREATE TABLE `orders` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `token` varchar(16) NOT NULL,
  `access_key` char(20) NOT NULL DEFAULT '',
  `total_paise` int(11) NOT NULL DEFAULT 0,
  `payment_status` varchar(20) NOT NULL DEFAULT 'unpaid',
  `payment_method` varchar(10) DEFAULT NULL,
  `utr` char(12) DEFAULT NULL,
  `gateway_provider` varchar(30) DEFAULT NULL,
  `gateway_ref` varchar(120) DEFAULT NULL,
  `refund_if_paid` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT NULL,
  `paid_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order_token` (`token`),
  UNIQUE KEY `uq_order_utr` (`utr`),
  UNIQUE KEY `uq_order_gateway_ref` (`gateway_ref`),
  KEY `ix_order_paid` (`paid_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
;

CREATE TABLE `jobs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `ticket` varchar(24) NOT NULL DEFAULT '',
  `upload_id` char(24) DEFAULT NULL,
  `file_path` varchar(255) NOT NULL DEFAULT '',
  `file_name` varchar(255) NOT NULL DEFAULT '',
  `file_kind` varchar(8) NOT NULL DEFAULT '',
  `total_pages` int(11) NOT NULL DEFAULT 0,
  `page_start` int(11) NOT NULL DEFAULT 1,
  `page_end` int(11) NOT NULL DEFAULT 1,
  `copies` int(11) NOT NULL DEFAULT 1,
  `color_mode` varchar(8) NOT NULL DEFAULT 'bw',
  `note` varchar(300) DEFAULT NULL,
  `pages_bw` int(11) NOT NULL DEFAULT 0,
  `pages_partial` int(11) NOT NULL DEFAULT 0,
  `pages_full` int(11) NOT NULL DEFAULT 0,
  `rate_bw` decimal(8,2) NOT NULL DEFAULT 0.00,
  `rate_partial` decimal(8,2) NOT NULL DEFAULT 0.00,
  `rate_full` decimal(8,2) NOT NULL DEFAULT 0.00,
  `color_threshold` decimal(5,2) NOT NULL DEFAULT 25.00,
  `amount_paise` int(11) NOT NULL DEFAULT 0,
  `payment_status` varchar(20) NOT NULL DEFAULT 'unpaid',
  `payment_method` varchar(10) DEFAULT NULL,
  `utr` char(12) DEFAULT NULL,
  `gateway_ref` varchar(120) DEFAULT NULL,
  `micro_verdict` varchar(10) NOT NULL DEFAULT 'ok',
  `micro_reason` varchar(255) DEFAULT NULL,
  `print_status` varchar(20) NOT NULL DEFAULT 'awaiting_payment',
  `printer_label` varchar(80) DEFAULT NULL,
  `computer_name` varchar(120) DEFAULT NULL,
  `claimed_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  `attempts` int(11) NOT NULL DEFAULT 0,
  `error` varchar(500) DEFAULT NULL,
  `refund_if_paid` tinyint(1) NOT NULL DEFAULT 0,
  `reviewed` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_job_ticket` (`ticket`),
  KEY `ix_job_order` (`order_id`),
  KEY `ix_job_status` (`print_status`),
  KEY `ix_job_printer` (`printer_label`,`print_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
;

CREATE TABLE `payment_events` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `provider` varchar(30) NOT NULL,
  `event_id` varchar(120) NOT NULL,
  `order_token` varchar(16) DEFAULT NULL,
  `event_type` varchar(40) DEFAULT NULL,
  `amount_paise` int(11) DEFAULT NULL,
  `outcome` varchar(60) DEFAULT NULL,
  `received_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payment_event` (`provider`,`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
;

