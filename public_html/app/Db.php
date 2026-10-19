<?php
/*
 * MySQL/MariaDB access + automatic table creation and in-place upgrades.
 *
 * Whenever the code's schema version differs from the one recorded in
 * storage/schema.version, migrate() runs: missing tables, columns and indexes
 * are added to an older database without touching existing data.
 */
declare(strict_types=1);

final class Db
{
    private static ?\PDO $pdo = null;

    public static function pdo(): \PDO
    {
        if (self::$pdo) return self::$pdo;
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', Config::get('DB_HOST'), Config::int('DB_PORT'), Config::get('DB_NAME'));
        self::$pdo = new \PDO($dsn, (string) Config::get('DB_USER'), (string) Config::get('DB_PASSWORD'), [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES => false,   // native types (ints come back as ints)
            \PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        self::$pdo->exec("SET time_zone = '+00:00'");
        return self::$pdo;
    }

    /**
     * Run a query. Array parameters expand into "?, ?, ?" for IN (...) lists.
     * Returns rows for SELECT/SHOW, otherwise ['affected' => n, 'id' => lastInsertId].
     */
    public static function q(string $sql, array $params = [])
    {
        if ($params) {
            $flat = [];
            $i = 0;
            $sql = preg_replace_callback('/\?/', function () use (&$i, $params, &$flat) {
                $p = $params[$i++] ?? null;
                if (is_array($p)) {
                    if (!$p) $p = [null];
                    foreach ($p as $x) $flat[] = $x;
                    return implode(',', array_fill(0, count($p), '?'));
                }
                $flat[] = $p;
                return '?';
            }, $sql);
            $params = $flat;
        }
        $st = self::pdo()->prepare($sql);
        foreach (array_values($params) as $k => $v) {
            $st->bindValue($k + 1, is_bool($v) ? (int) $v : $v, is_int($v) || is_bool($v) ? \PDO::PARAM_INT : ($v === null ? \PDO::PARAM_NULL : \PDO::PARAM_STR));
        }
        $st->execute();
        if ($st->columnCount() > 0) return $st->fetchAll();
        return ['affected' => $st->rowCount(), 'id' => (int) self::pdo()->lastInsertId()];
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $r = self::q($sql, $params);
        return $r[0] ?? null;
    }

    /** Run $fn inside a transaction; retries on deadlock. */
    public static function tx(callable $fn)
    {
        for ($attempt = 0; ; $attempt++) {
            $pdo = self::pdo();
            $pdo->beginTransaction();
            try {
                $out = $fn();
                $pdo->commit();
                return $out;
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                $deadlock = $e instanceof \PDOException && in_array((int) ($e->errorInfo[1] ?? 0), [1213, 1205], true);
                if ($deadlock && $attempt < 3) {
                    usleep(50000 * ($attempt + 1));
                    continue;
                }
                throw $e;
            }
        }
    }

    public static function isDuplicate(\Throwable $e): bool
    {
        return $e instanceof \PDOException && (int) ($e->errorInfo[1] ?? 0) === 1062;
    }

    /* ---------------- schema ---------------- */

    private const TABLES = [
        'settings' => "CREATE TABLE IF NOT EXISTS settings (id TINYINT PRIMARY KEY, shop_name VARCHAR(120) NOT NULL DEFAULT 'Print Shop') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        'printers' => "CREATE TABLE IF NOT EXISTS printers (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(80) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        'connectors' => "CREATE TABLE IF NOT EXISTS connectors (id INT AUTO_INCREMENT PRIMARY KEY, computer_name VARCHAR(120) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        'uploads' => "CREATE TABLE IF NOT EXISTS uploads (id CHAR(24) PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        'orders' => "CREATE TABLE IF NOT EXISTS orders (id INT AUTO_INCREMENT PRIMARY KEY, token VARCHAR(16) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        'jobs' => "CREATE TABLE IF NOT EXISTS jobs (id INT AUTO_INCREMENT PRIMARY KEY, order_id INT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        'payment_events' => "CREATE TABLE IF NOT EXISTS payment_events (id INT AUTO_INCREMENT PRIMARY KEY, provider VARCHAR(30) NOT NULL, event_id VARCHAR(120) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        'rate_limits' => "CREATE TABLE IF NOT EXISTS rate_limits (k VARCHAR(120) PRIMARY KEY, window_start INT NOT NULL, hits INT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    ];

    /** [table, column, definition] — added to older databases automatically */
    private const COLUMNS = [
        ['settings', 'rate_bw', 'DECIMAL(8,2) NOT NULL DEFAULT 2.00'],
        ['settings', 'rate_partial', 'DECIMAL(8,2) NOT NULL DEFAULT 5.00'],
        ['settings', 'rate_full', 'DECIMAL(8,2) NOT NULL DEFAULT 10.00'],
        ['settings', 'color_threshold', 'DECIMAL(5,2) NOT NULL DEFAULT 25.00'],
        ['settings', 'upi_id', "VARCHAR(120) NOT NULL DEFAULT ''"],
        ['settings', 'payee_name', "VARCHAR(120) NOT NULL DEFAULT ''"],
        ['settings', 'payment_mode', "VARCHAR(16) NOT NULL DEFAULT 'utr'"],
        ['settings', 'verify_upi', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['settings', 'allow_cash', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['settings', 'accepting_orders', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['settings', 'owner_username', 'VARCHAR(80) NULL'],
        ['settings', 'owner_password_hash', 'VARCHAR(255) NULL'],
        ['settings', 'session_version', 'INT NOT NULL DEFAULT 1'],
        ['settings', 'last_cleanup', 'DATETIME NULL'],
        ['settings', 'updated_at', 'DATETIME NULL'],

        ['printers', 'color_capable', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['printers', 'enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['printers', 'sort_order', 'INT NOT NULL DEFAULT 0'],

        ['connectors', 'last_seen', 'DATETIME NULL'],
        ['connectors', 'printers_json', 'TEXT NULL'],
        ['connectors', 'version', 'VARCHAR(30) NULL'],
        ['connectors', 'first_seen', 'DATETIME NULL'],

        ['uploads', 'file_path', "VARCHAR(255) NOT NULL DEFAULT ''"],
        ['uploads', 'file_name', "VARCHAR(255) NOT NULL DEFAULT ''"],
        ['uploads', 'file_kind', "VARCHAR(8) NOT NULL DEFAULT ''"],
        ['uploads', 'file_size', 'INT NOT NULL DEFAULT 0'],
        ['uploads', 'page_count', 'INT NOT NULL DEFAULT 0'],
        ['uploads', 'coverage_json', 'MEDIUMTEXT NULL'],
        ['uploads', 'micro_verdict', "VARCHAR(10) NOT NULL DEFAULT 'ok'"],
        ['uploads', 'micro_reason', 'VARCHAR(255) NULL'],
        ['uploads', 'created_at', 'DATETIME NULL'],

        ['orders', 'access_key', "CHAR(20) NOT NULL DEFAULT ''"],
        ['orders', 'total_paise', 'INT NOT NULL DEFAULT 0'],
        ['orders', 'payment_status', "VARCHAR(20) NOT NULL DEFAULT 'unpaid'"],
        ['orders', 'payment_method', 'VARCHAR(10) NULL'],
        ['orders', 'utr', 'CHAR(12) NULL'],
        ['orders', 'gateway_provider', 'VARCHAR(30) NULL'],
        ['orders', 'gateway_ref', 'VARCHAR(120) NULL'],
        ['orders', 'refund_if_paid', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['orders', 'created_at', 'DATETIME NULL'],
        ['orders', 'paid_at', 'DATETIME NULL'],
        ['orders', 'updated_at', 'DATETIME NULL'],

        ['jobs', 'ticket', "VARCHAR(24) NOT NULL DEFAULT ''"],
        ['jobs', 'upload_id', 'CHAR(24) NULL'],
        ['jobs', 'file_path', "VARCHAR(255) NOT NULL DEFAULT ''"],
        ['jobs', 'file_name', "VARCHAR(255) NOT NULL DEFAULT ''"],
        ['jobs', 'file_kind', "VARCHAR(8) NOT NULL DEFAULT ''"],
        ['jobs', 'total_pages', 'INT NOT NULL DEFAULT 0'],
        ['jobs', 'page_start', 'INT NOT NULL DEFAULT 1'],
        ['jobs', 'page_end', 'INT NOT NULL DEFAULT 1'],
        ['jobs', 'copies', 'INT NOT NULL DEFAULT 1'],
        ['jobs', 'color_mode', "VARCHAR(8) NOT NULL DEFAULT 'bw'"],
        ['jobs', 'note', 'VARCHAR(300) NULL'],
        ['jobs', 'pages_bw', 'INT NOT NULL DEFAULT 0'],
        ['jobs', 'pages_partial', 'INT NOT NULL DEFAULT 0'],
        ['jobs', 'pages_full', 'INT NOT NULL DEFAULT 0'],
        ['jobs', 'rate_bw', 'DECIMAL(8,2) NOT NULL DEFAULT 0'],
        ['jobs', 'rate_partial', 'DECIMAL(8,2) NOT NULL DEFAULT 0'],
        ['jobs', 'rate_full', 'DECIMAL(8,2) NOT NULL DEFAULT 0'],
        ['jobs', 'color_threshold', 'DECIMAL(5,2) NOT NULL DEFAULT 25'],
        ['jobs', 'amount_paise', 'INT NOT NULL DEFAULT 0'],
        ['jobs', 'payment_status', "VARCHAR(20) NOT NULL DEFAULT 'unpaid'"],
        ['jobs', 'payment_method', 'VARCHAR(10) NULL'],
        ['jobs', 'utr', 'CHAR(12) NULL'],
        ['jobs', 'gateway_ref', 'VARCHAR(120) NULL'],
        ['jobs', 'micro_verdict', "VARCHAR(10) NOT NULL DEFAULT 'ok'"],
        ['jobs', 'micro_reason', 'VARCHAR(255) NULL'],
        ['jobs', 'print_status', "VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'"],
        ['jobs', 'printer_label', 'VARCHAR(80) NULL'],
        ['jobs', 'computer_name', 'VARCHAR(120) NULL'],
        ['jobs', 'claimed_at', 'DATETIME NULL'],
        ['jobs', 'finished_at', 'DATETIME NULL'],
        ['jobs', 'attempts', 'INT NOT NULL DEFAULT 0'],
        ['jobs', 'error', 'VARCHAR(500) NULL'],
        ['jobs', 'refund_if_paid', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['jobs', 'reviewed', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['jobs', 'created_at', 'DATETIME NULL'],
        ['jobs', 'updated_at', 'DATETIME NULL'],

        ['payment_events', 'order_token', 'VARCHAR(16) NULL'],
        ['payment_events', 'event_type', 'VARCHAR(40) NULL'],
        ['payment_events', 'amount_paise', 'INT NULL'],
        ['payment_events', 'outcome', 'VARCHAR(60) NULL'],
        ['payment_events', 'received_at', 'DATETIME NULL'],
    ];

    private const INDEXES = [
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

    public static function schemaVersion(): string
    {
        return substr(md5(serialize([self::TABLES, self::COLUMNS, self::INDEXES])), 0, 12);
    }

    /** Migrate if the recorded schema version differs (cheap check on every request). */
    public static function ensureSchema(): void
    {
        $file = Config::storage() . '/schema.version';
        $v = self::schemaVersion();
        if (@file_get_contents($file) === $v) return;
        $lock = fopen(Config::storage() . '/schema.lock', 'c');
        flock($lock, LOCK_EX);
        try {
            if (@file_get_contents($file) !== $v) {
                self::migrate();
                file_put_contents($file, $v);
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    public static function migrate(): void
    {
        foreach (self::TABLES as $sql) self::q($sql);
        $have = [];
        foreach (self::q('SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()') as $r) {
            $have[strtolower($r['t'] . '.' . $r['c'])] = true;
        }
        foreach (self::COLUMNS as [$t, $c, $def]) {
            if (!isset($have["$t.$c"])) self::q("ALTER TABLE `$t` ADD COLUMN `$c` $def");
        }
        $haveIdx = [];
        foreach (self::q('SELECT DISTINCT TABLE_NAME t, INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()') as $r) {
            $haveIdx[strtolower($r['t'] . '.' . $r['i'])] = true;
        }
        foreach (self::INDEXES as [$t, $name, $def]) {
            if (isset($haveIdx["$t.$name"])) continue;
            $unique = str_starts_with($def, 'UNIQUE');
            $cols = $unique ? trim(substr($def, 6)) : $def;
            self::q("ALTER TABLE `$t` ADD " . ($unique ? 'UNIQUE ' : '') . "INDEX `$name` $cols");
        }
        self::q("INSERT IGNORE INTO settings (id, shop_name, updated_at) VALUES (1, 'Print Shop', UTC_TIMESTAMP())");
        $n = self::one('SELECT COUNT(*) n FROM printers')['n'];
        if ((int) $n === 0) {
            self::q("INSERT INTO printers (label, color_capable, enabled, sort_order) VALUES
                ('Printer 1 - Colour', 1, 1, 1), ('Printer 2 - B&W', 0, 1, 2), ('Printer 3 - B&W', 0, 1, 3)");
        }
    }
}
