<?php
/*
 * API for the Print Connector on the shop computers.
 *
 * Coordination between several computers happens HERE, in the database:
 *   - a job is claimed atomically (only one computer can ever get it);
 *   - a printer has only ONE active job across all computers;
 *   - an active job older than STALE_LOCK_SEC (15 min) no longer locks its printer,
 *     so a crashed computer can't block a printer forever. That job is NOT printed
 *     again automatically: the owner sees it as "stuck" and can press Retry.
 */
declare(strict_types=1);

final class Connector
{
    public static function printers(): array
    {
        return array_map(fn($p) => ['label' => $p['label'], 'color_capable' => (int) $p['color_capable'], 'enabled' => (int) $p['enabled']],
            Db::q('SELECT label, color_capable, enabled FROM printers ORDER BY sort_order, id'));
    }

    public static function heartbeat(array $b): array
    {
        $computer = mb_substr(trim((string) ($b['computer'] ?? '')), 0, 120);
        if ($computer === '') throw new UserError(400, 'Missing computer name.');
        $printers = [];
        foreach (array_slice(is_array($b['printers'] ?? null) ? $b['printers'] : [], 0, 30) as $p) {
            $printers[] = [
                'local' => mb_substr((string) ($p['local'] ?? ''), 0, 120),
                'label' => !empty($p['label']) ? mb_substr((string) $p['label'], 0, 80) : null,
                'status' => mb_substr((string) ($p['status'] ?? ''), 0, 20),
            ];
        }
        Db::q('INSERT INTO connectors (computer_name, last_seen, first_seen, printers_json, version)
               VALUES (?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)
               ON DUPLICATE KEY UPDATE last_seen = UTC_TIMESTAMP(), printers_json = VALUES(printers_json), version = VALUES(version)',
            [$computer, json_encode($printers, JSON_UNESCAPED_UNICODE), mb_substr((string) ($b['version'] ?? ''), 0, 30)]);
        return ['printers' => self::printers(), 'shop_name' => Settings::get()['shop_name']];
    }

    /** Paid files waiting to print, oldest payment first. */
    public static function pending(): array
    {
        $rows = Db::q("SELECT j.id, j.ticket, j.file_name, j.file_kind, j.page_start, j.page_end, j.total_pages, j.copies, j.color_mode,
              (j.color_mode = 'color' AND (j.pages_partial + j.pages_full) > 0) AS needs_color
              FROM jobs j JOIN orders o ON o.id = j.order_id
              WHERE j.print_status = 'queued' ORDER BY o.paid_at, j.id LIMIT 50");
        return array_map(function ($r) {
            foreach (['id', 'page_start', 'page_end', 'total_pages', 'copies'] as $k) $r[$k] = (int) $r[$k];
            $r['needs_color'] = (bool) $r['needs_color'];
            return $r;
        }, $rows);
    }

    public static function claim(int $id, array $b): array
    {
        $label = (string) ($b['printer_label'] ?? '');
        $computer = mb_substr((string) ($b['computer'] ?? ''), 0, 120);
        if ($label === '' || $computer === '') throw new UserError(400, 'printer_label and computer are required.');
        return Db::tx(function () use ($id, $label, $computer) {
            // lock the printer row first: claims for the same printer queue up here
            $p = Db::one('SELECT * FROM printers WHERE label = ? FOR UPDATE', [$label]);
            if (!$p || !$p['enabled']) return ['claimed' => false, 'reason' => 'printer_unavailable'];
            $j = Db::one('SELECT * FROM jobs WHERE id = ? FOR UPDATE', [$id]);
            if (!$j || $j['print_status'] !== 'queued' || $j['payment_status'] !== 'paid') return ['claimed' => false, 'reason' => 'job_taken'];
            $needsColor = $j['color_mode'] === 'color' && ($j['pages_partial'] + $j['pages_full']) > 0;
            if ($needsColor && !$p['color_capable']) return ['claimed' => false, 'reason' => 'printer_not_color'];
            $busy = Db::one("SELECT id FROM jobs WHERE printer_label = ? AND print_status = 'printing'
                             AND claimed_at > UTC_TIMESTAMP() - INTERVAL ? SECOND LIMIT 1", [$label, Config::int('STALE_LOCK_SEC')]);
            if ($busy) return ['claimed' => false, 'reason' => 'printer_busy'];
            $u = Db::q("UPDATE jobs SET print_status = 'printing', printer_label = ?, computer_name = ?, claimed_at = UTC_TIMESTAMP(),
                          attempts = attempts + 1, error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND print_status = 'queued'",
                [$label, $computer, $id]);
            if (!$u['affected']) return ['claimed' => false, 'reason' => 'job_taken'];
            return ['claimed' => true, 'job' => [
                'id' => (int) $j['id'], 'ticket' => $j['ticket'], 'file_name' => $j['file_name'], 'file_kind' => $j['file_kind'],
                'page_start' => (int) $j['page_start'], 'page_end' => (int) $j['page_end'], 'total_pages' => (int) $j['total_pages'],
                'copies' => (int) $j['copies'], 'monochrome' => !$needsColor, 'color_mode' => $j['color_mode'],
            ]];
        });
    }

    public static function complete(int $id, array $b): array
    {
        $ok = !empty($b['ok']);
        $computer = mb_substr((string) ($b['computer'] ?? ''), 0, 120);
        $label = !empty($b['printer_label']) ? mb_substr((string) $b['printer_label'], 0, 80) : null;
        $err = $ok ? null : mb_substr((string) ($b['error'] ?? 'Printing failed'), 0, 500);
        $r = Db::q("UPDATE jobs SET print_status = ?, finished_at = UTC_TIMESTAMP(), error = ?, printer_label = COALESCE(?, printer_label),
                      updated_at = UTC_TIMESTAMP() WHERE id = ? AND print_status = 'printing' AND computer_name = ?",
            [$ok ? 'completed' : 'failed', $err, $label, $id, $computer]);
        if (!$r['affected']) throw new UserError(409, 'This job is not printing on this computer (it may have been retried or cancelled).', 'not_owner');
        return ['ok' => true];
    }
}
