<?php
/*
 * Configuration.
 *
 * Shared PHP hosting has no "environment variables" screen, so secrets come from
 * a private config file that is never inside a web-readable place:
 *   1. ../printshop-config.php   (one folder ABOVE public_html — best)
 *   2. app/config.php            (inside the protected app folder; written by /setup)
 * Real environment variables (e.g. SetEnv in .htaccess, or the test runner) override both.
 */
declare(strict_types=1);

final class Config
{
    private static ?array $c = null;
    public static ?string $loadedFrom = null;

    public const DEFAULTS = [
        'DB_HOST' => 'localhost',
        'DB_PORT' => 3306,
        'DB_NAME' => '',
        'DB_USER' => '',
        'DB_PASSWORD' => '',
        'OWNER_MASTER_KEY' => '',
        'PUBLIC_URL' => '',
        'STORAGE_DIR' => '',
        'MAX_UPLOAD_MB' => 25,
        'MAX_PAGES' => 200,
        'MAX_IMAGE_MEGAPIXELS' => 50,
        'ANALYSIS_TIMEOUT_SEC' => 120,
        'ANALYSIS_CONCURRENCY' => 2,
        'UPLOAD_TTL_HOURS' => 6,
        'FILE_RETENTION_DAYS' => 3,
        'ANALYSE_RATE_LIMIT' => 30,
        'SHOP_TZ_OFFSET_MIN' => 330,
        'STALE_LOCK_SEC' => 900,
        'TRUST_PROXY' => false,
        'PAYMENT_GATEWAY' => '',
        'GATEWAY_KEY_ID' => '',
        'GATEWAY_KEY_SECRET' => '',
        'GATEWAY_WEBHOOK_SECRET' => '',
        'APP_ENV' => 'production',
    ];

    public static function candidates(): array
    {
        $list = [];
        if (getenv('PRINTSHOP_CONFIG')) $list[] = (string) getenv('PRINTSHOP_CONFIG');
        $list[] = dirname(__DIR__, 2) . '/printshop-config.php';
        $list[] = __DIR__ . '/config.php';
        return $list;
    }

    private static function load(): array
    {
        if (self::$c !== null) return self::$c;
        $c = self::DEFAULTS;
        foreach (self::candidates() as $file) {
            if (is_file($file)) {
                $data = include $file;
                if (is_array($data)) {
                    $c = array_merge($c, $data);
                    self::$loadedFrom = $file;
                    break;
                }
            }
        }
        foreach (array_keys(self::DEFAULTS) as $k) {
            $v = getenv($k);
            if ($v === false) $v = $_SERVER[$k] ?? ($_SERVER['REDIRECT_' . $k] ?? false); // SetEnv in .htaccess
            if ($v !== false && $v !== '') $c[$k] = $v;
        }
        if (!$c['STORAGE_DIR']) $c['STORAGE_DIR'] = dirname(__DIR__) . '/storage';
        return self::$c = $c;
    }

    public static function reset(): void
    {
        self::$c = null;
    }

    public static function get(string $k)
    {
        return self::load()[$k] ?? null;
    }

    public static function int(string $k): int
    {
        return (int) self::get($k);
    }

    public static function bool(string $k): bool
    {
        $v = self::get($k);
        return $v === true || $v === 1 || in_array(strtolower((string) $v), ['1', 'true', 'yes', 'on'], true);
    }

    public static function isConfigured(): bool
    {
        return self::get('DB_NAME') !== '' && self::get('DB_USER') !== '' && self::get('OWNER_MASTER_KEY') !== '';
    }

    public static function isTest(): bool
    {
        return self::get('APP_ENV') === 'test';
    }

    public static function storage(string $sub = ''): string
    {
        $root = rtrim((string) self::get('STORAGE_DIR'), '/');
        $dir = $root . ($sub ? '/' . $sub : '');
        if (!is_dir($dir)) @mkdir($dir, 0750, true);
        // the storage folder is never deployed (customer files live there), so it protects itself
        if (!is_file("$root/.htaccess") && is_dir($root)) {
            @file_put_contents("$root/.htaccess", "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
            @file_put_contents("$root/index.html", '');
        }
        return $dir;
    }

    /** Upload limit actually possible on this server (the smallest of ours and PHP's). */
    public static function maxUploadBytes(): int
    {
        $ours = self::int('MAX_UPLOAD_MB') * 1024 * 1024;
        return min($ours, self::iniBytes('upload_max_filesize'), self::iniBytes('post_max_size') - 64 * 1024);
    }

    public static function iniBytes(string $key): int
    {
        $v = trim((string) ini_get($key));
        if ($v === '' || $v === '0' || $v === '-1') return PHP_INT_MAX;
        $n = (float) $v;
        switch (strtolower(substr($v, -1))) {
            case 'g': $n *= 1024;
            // no break
            case 'm': $n *= 1024;
            // no break
            case 'k': $n *= 1024;
        }
        return (int) $n;
    }
}
