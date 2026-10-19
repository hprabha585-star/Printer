<?php
/*
 * Command line helpers (optional; the site does all of this by itself):
 *   php app/cli.php migrate   – create/upgrade database tables now
 *   php app/cli.php cleanup   – delete old files now (can be a cron job)
 *   php app/cli.php check     – show configuration and PHP checks
 */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/bootstrap.php';

$cmd = $argv[1] ?? 'check';
switch ($cmd) {
    case 'migrate':
        Db::migrate();
        file_put_contents(Config::storage() . '/schema.version', Db::schemaVersion());
        echo "Database is up to date.\n";
        break;
    case 'cleanup':
        Db::ensureSchema();
        Cleanup::run();
        echo "Cleanup done.\n";
        break;
    default:
        echo 'PHP ' . PHP_VERSION . "\n";
        foreach (['pdo_mysql', 'gd', 'zlib', 'mbstring', 'openssl'] as $e) echo str_pad($e, 10) . (extension_loaded($e) ? 'ok' : 'MISSING') . "\n";
        echo 'config: ' . (Config::isConfigured() ? 'ok (' . Config::$loadedFrom . ')' : 'NOT SET UP') . "\n";
        echo 'upload limit: ' . round(Config::maxUploadBytes() / 1048576) . " MB\n";
}
