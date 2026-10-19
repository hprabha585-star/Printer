<?php
/* Small HTTP helpers: errors, JSON in/out, client IP, rate limiting. */
declare(strict_types=1);

/** An error meant for the user: shown as-is with an HTTP status. */
final class UserError extends \Exception
{
    public function __construct(public int $status, string $message, public string $errCode = 'error')
    {
        parent::__construct($message);
    }
}

final class Http
{
    private static ?array $body = null;

    public static function json($data, int $status = 200): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
        }
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    public static function error(int $status, string $message, ?string $code = null): void
    {
        $out = ['error' => $message];
        if ($code !== null) $out['code'] = $code;
        self::json($out, $status);
    }

    /** Parsed JSON request body (empty array if none). */
    public static function body(): array
    {
        if (self::$body !== null) return self::$body;
        $raw = self::raw();
        if ($raw === '') return self::$body = [];
        $d = json_decode($raw, true);
        if (!is_array($d)) {
            // a valid JSON scalar/array is fine; anything unparseable is a bad request
            if (json_last_error() !== JSON_ERROR_NONE) throw new UserError(400, 'Bad request.');
            $d = [];
        }
        return self::$body = $d;
    }

    private static ?string $raw = null;
    public static function raw(): string
    {
        return self::$raw ??= (string) file_get_contents('php://input');
    }

    public static function header(string $name): string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        return (string) ($_SERVER[$key] ?? '');
    }

    public static function headers(): array
    {
        $out = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) $out[strtolower(str_replace('_', '-', substr($k, 5)))] = $v;
        }
        return $out;
    }

    /** Real client IP (the X-Forwarded-For header is used only when TRUST_PROXY is on). */
    public static function ip(): string
    {
        if (Config::bool('TRUST_PROXY')) {
            $xff = self::header('X-Forwarded-For');
            if ($xff !== '') return trim(explode(',', $xff)[0]);
        }
        return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    }

    /** Fixed-window rate limit stored in MySQL. Throws 429 when exceeded. */
    public static function rateLimit(string $bucket, int $max, int $windowSec, string $message): void
    {
        $key = substr($bucket . ':' . self::ip(), 0, 120);
        $now = time();
        $win = $now - ($now % $windowSec);
        Db::q('INSERT INTO rate_limits (k, window_start, hits) VALUES (?, ?, 1)
               ON DUPLICATE KEY UPDATE hits = IF(window_start = VALUES(window_start), hits + 1, 1), window_start = VALUES(window_start)',
            [$key, $win]);
        $row = Db::one('SELECT hits FROM rate_limits WHERE k = ?', [$key]);
        if ($row && (int) $row['hits'] > $max) {
            header('Retry-After: ' . ($win + $windowSec - $now));
            throw new UserError(429, $message, 'rate_limited');
        }
    }

    public static function randomId(int $bytes = 12): string
    {
        return bin2hex(random_bytes($bytes));
    }

    public static function cleanFileName(string $n): string
    {
        if (!mb_check_encoding($n, 'UTF-8')) $n = mb_convert_encoding($n, 'UTF-8', 'ISO-8859-1');
        $n = trim(preg_replace('/[\x00-\x1f<>:"\/\\\\|?*]+/u', '_', $n) ?? 'file');
        return mb_substr($n !== '' ? $n : 'file', 0, 200);
    }

    /** "2026-10-18 06:30:00" (UTC from MySQL) -> "2026-10-18T06:30:00Z" for browsers. */
    public static function iso($v): ?string
    {
        if (!$v) return null;
        return str_replace(' ', 'T', (string) $v) . 'Z';
    }

    public static function sendFile(string $path, string $kind, string $name): void
    {
        $types = ['pdf' => 'application/pdf', 'jpg' => 'image/jpeg', 'png' => 'image/png'];
        if (!is_file($path)) throw new UserError(404, 'This file has already been deleted from the server.');
        header('Content-Type: ' . ($types[$kind] ?? 'application/octet-stream'));
        header('X-Content-Type-Options: nosniff');
        header('Content-Disposition: inline; filename="' . rawurlencode($name) . '"');
        header('Content-Length: ' . filesize($path));
        header('Cache-Control: no-store');
        readfile($path);
    }
}
