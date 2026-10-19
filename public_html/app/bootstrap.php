<?php
/*
 * Loads the application and handles every /api/... request.
 * Plain PHP 8.1+, extensions: pdo_mysql, gd, zlib, mbstring, openssl (standard on shared hosting).
 */
declare(strict_types=1);

if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'This website needs PHP 8.1 or newer. Change the PHP version in your hosting control panel.']);
    exit;
}

foreach ([
    'Config', 'Db', 'Http', 'Auth', 'Pricing', 'Settings', 'Payments', 'Orders', 'Owner', 'Connector', 'Cleanup', 'Upload', 'Routes',
    'analyzer/Raster', 'analyzer/Microtext', 'analyzer/PdfCrypt', 'analyzer/PdfFile', 'analyzer/PdfPage', 'analyzer/Analyzer',
] as $f) {
    require_once __DIR__ . "/$f.php";
}

final class App
{
    public static function handleApi(): void
    {
        ini_set('display_errors', '0');
        ob_start();
        register_shutdown_function([self::class, 'onShutdown']);
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: same-origin');
        header('X-Frame-Options: SAMEORIGIN');
        try {
            foreach (['pdo_mysql', 'gd', 'zlib', 'mbstring'] as $ext) {
                if (!extension_loaded($ext)) throw new UserError(500, "The PHP extension \"$ext\" is not enabled. Turn it on in your hosting control panel (Select PHP Version → Extensions).");
            }
            if (!Config::isConfigured()) throw new UserError(503, 'This website is not set up yet. The owner should open /setup to finish installing it.', 'not_configured');
            Db::ensureSchema();
            $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
            (new Routes())->dispatch($method, self::path());
        } catch (UserError $e) {
            self::discardOutput();
            Http::error($e->status, $e->getMessage(), $e->errCode !== 'error' ? $e->errCode : null);
        } catch (\PDOException $e) {
            self::discardOutput();
            error_log('[printshop] database: ' . $e->getMessage());
            $connect = in_array((int) ($e->errorInfo[1] ?? $e->getCode()), [1045, 1044, 1049, 2002, 2005, 2006], true);
            Http::error($connect ? 503 : 500, $connect
                ? 'The website cannot reach its database. (Owner: check the database details in the config file.)'
                : 'Something went wrong on the server. Please try again.');
        } catch (\Throwable $e) {
            self::discardOutput();
            error_log('[printshop] ' . $e);
            Http::error(500, 'Something went wrong on the server. Please try again.');
        }
        if (ob_get_level()) ob_end_flush();
    }

    private static function discardOutput(): void
    {
        while (ob_get_level()) ob_end_clean();
        if (!headers_sent()) header_remove('Content-Disposition');
    }

    /** The request path, without the folder the site lives in (works in a sub-folder too). */
    public static function path(): string
    {
        $uri = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
        $base = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
        if ($base !== '' && str_starts_with($uri, $base . '/')) $uri = substr($uri, strlen($base));
        return '/' . ltrim($uri, '/');
    }

    /** Fatal errors (out of memory, time limit) still get a polite JSON answer. */
    public static function onShutdown(): void
    {
        $e = error_get_last();
        if (!$e || !in_array($e['type'], [E_ERROR, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) return;
        error_log('[printshop] fatal: ' . $e['message']);
        if (!empty($GLOBALS['__analysing'])) @unlink($GLOBALS['__analysing']);
        self::discardOutput();
        if (headers_sent()) return;
        $analysing = !empty($GLOBALS['__analysing']);
        $memory = stripos($e['message'], 'memory') !== false;
        if ($analysing) {
            Http::error(422, $memory ? 'This file is too large to check. Please use a smaller file.' : 'Checking this file took too long. Try a smaller file, or split a large scanned PDF.', $memory ? 'oversized' : 'timeout');
        } else {
            Http::error(500, 'Something went wrong on the server. Please try again.');
        }
    }
}
