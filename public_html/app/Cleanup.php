<?php
/*
 * Housekeeping (no cron job needed): runs at most every 15 minutes, triggered by
 * the shop computer's heartbeat or the owner dashboard.
 *  - analysed files never ordered are deleted after UPLOAD_TTL_HOURS
 *  - orders not paid within 24 hours are closed
 *  - files of finished jobs are deleted after FILE_RETENTION_DAYS
 *  - stray temporary files and old rate-limit / webhook records are removed
 * Can also be run from a cron job:  php app/cli.php cleanup
 */
declare(strict_types=1);

final class Cleanup
{
    public static function maybeRun(): void
    {
        // claim the 15-minute slot atomically so only one request does the work
        $r = Db::q("UPDATE settings SET last_cleanup = UTC_TIMESTAMP()
                    WHERE id = 1 AND (last_cleanup IS NULL OR last_cleanup < UTC_TIMESTAMP() - INTERVAL 15 MINUTE)");
        if ($r['affected']) {
            try { self::run(); } catch (\Throwable $e) { error_log('cleanup failed: ' . $e->getMessage()); }
        }
    }

    private static function rm(string $name): void
    {
        if ($name !== '') @unlink(Config::storage('uploads') . '/' . basename($name));
    }

    public static function run(): void
    {
        foreach (Db::q('SELECT id, file_path FROM uploads WHERE created_at < UTC_TIMESTAMP() - INTERVAL ? HOUR', [Config::int('UPLOAD_TTL_HOURS')]) as $u) {
            Db::q('DELETE FROM uploads WHERE id = ?', [$u['id']]);
            if (!(int) Db::one('SELECT COUNT(*) n FROM jobs WHERE file_path = ?', [$u['file_path']])['n']) self::rm($u['file_path']);
        }

        foreach (Db::q("SELECT id FROM orders WHERE payment_status IN ('unpaid','gateway_pending') AND created_at < UTC_TIMESTAMP() - INTERVAL 24 HOUR") as $o) {
            Db::q("UPDATE orders SET payment_status = 'expired', updated_at = UTC_TIMESTAMP() WHERE id = ? AND payment_status IN ('unpaid','gateway_pending')", [$o['id']]);
            Db::q("UPDATE jobs SET print_status = 'cancelled', payment_status = 'expired', finished_at = UTC_TIMESTAMP() - INTERVAL 30 DAY
                   WHERE order_id = ? AND print_status = 'awaiting_payment'", [$o['id']]);
        }

        $done = Db::q("SELECT id, file_path FROM jobs WHERE file_path <> '' AND print_status IN ('completed','cancelled','failed')
                       AND COALESCE(finished_at, updated_at) < UTC_TIMESTAMP() - INTERVAL ? DAY", [Config::int('FILE_RETENTION_DAYS')]);
        foreach ($done as $j) {
            Db::q("UPDATE jobs SET file_path = '' WHERE id = ?", [$j['id']]);
            $n = Db::one('SELECT (SELECT COUNT(*) FROM jobs WHERE file_path = ?) + (SELECT COUNT(*) FROM uploads WHERE file_path = ?) n', [$j['file_path'], $j['file_path']])['n'];
            if (!(int) $n) self::rm($j['file_path']);
        }

        foreach (glob(Config::storage('uploads') . '/*.tmp') ?: [] as $f) {
            if (time() - (int) @filemtime($f) > 3600) @unlink($f);
        }
        Db::q('DELETE FROM rate_limits WHERE window_start < ?', [time() - 86400]);
        Db::q('DELETE FROM payment_events WHERE received_at < UTC_TIMESTAMP() - INTERVAL 180 DAY');
    }
}
