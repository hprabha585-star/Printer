<?php
/* Owner dashboard data: printers, computers, money, attention list, file history. */
declare(strict_types=1);

final class Owner
{
    public static function printers(): array
    {
        return array_map(fn($p) => ['id' => (int) $p['id'], 'label' => $p['label'], 'color_capable' => (int) $p['color_capable'], 'enabled' => (int) $p['enabled']],
            Db::q('SELECT id, label, color_capable, enabled FROM printers ORDER BY sort_order, id'));
    }

    /** Replace the printer list. Body: [{id?, label, color_capable, enabled}] */
    public static function savePrinters($list): array
    {
        if (!is_array($list) || !$list || count($list) > 12 || !array_is_list($list)) throw new UserError(400, 'Add between 1 and 12 printers.');
        $labels = array_map(fn($p) => trim((string) ($p['label'] ?? '')), $list);
        foreach ($labels as $l) if ($l === '' || mb_strlen($l) > 80) throw new UserError(400, 'Every printer needs a name (up to 80 characters).');
        if (count(array_unique(array_map('mb_strtolower', $labels))) !== count($labels)) throw new UserError(400, 'Two printers have the same name.');
        Db::tx(function () use ($list, $labels) {
            $existing = [];
            foreach (Db::q('SELECT id, label FROM printers') as $e) $existing[(int) $e['id']] = $e['label'];
            $keep = [];
            foreach ($list as $i => $p) {
                $vals = [$labels[$i], !empty($p['color_capable']) ? 1 : 0, (isset($p['enabled']) && ($p['enabled'] === false || $p['enabled'] === 0 || $p['enabled'] === '0')) ? 0 : 1, $i + 1];
                $id = (int) ($p['id'] ?? 0);
                if ($id && isset($existing[$id])) {
                    Db::q('UPDATE printers SET label = ?, color_capable = ?, enabled = ?, sort_order = ? WHERE id = ?', [...$vals, $id]);
                    // a rename keeps history and active jobs pointing at the right printer
                    if ($existing[$id] !== $labels[$i]) Db::q('UPDATE jobs SET printer_label = ? WHERE printer_label = ?', [$labels[$i], $existing[$id]]);
                    $keep[] = $id;
                } else {
                    $keep[] = Db::q('INSERT INTO printers (label, color_capable, enabled, sort_order) VALUES (?,?,?,?)', $vals)['id'];
                }
            }
            $remove = array_diff(array_keys($existing), $keep);
            if ($remove) Db::q('DELETE FROM printers WHERE id IN (?)', [array_values($remove)]);
        });
        return self::printers();
    }

    public static function connectors(): array
    {
        $rows = Db::q('SELECT computer_name, last_seen, printers_json, version, TIMESTAMPDIFF(SECOND, last_seen, UTC_TIMESTAMP()) AS age
                       FROM connectors ORDER BY computer_name');
        return array_map(fn($r) => [
            'computer_name' => $r['computer_name'], 'last_seen' => Http::iso($r['last_seen']),
            'seconds_ago' => $r['age'] === null ? null : (int) $r['age'], 'online' => $r['age'] !== null && (int) $r['age'] <= 60,
            'printers' => json_decode((string) $r['printers_json'], true) ?: [], 'version' => $r['version'],
        ], $rows);
    }

    public static function stats(): array
    {
        $tz = Config::int('SHOP_TZ_OFFSET_MIN');
        $local = "DATE_ADD(o.paid_at, INTERVAL $tz MINUTE)";
        $now = "DATE_ADD(UTC_TIMESTAMP(), INTERVAL $tz MINUTE)";
        $revenue = function (string $where) {
            $out = ['total' => 0, 'upi' => 0, 'cash' => 0, 'gateway' => 0];
            $rows = Db::q("SELECT o.payment_method m, COALESCE(SUM(j.amount_paise), 0) total
                FROM orders o JOIN jobs j ON j.order_id = o.id
                WHERE o.payment_status = 'paid' AND j.print_status <> 'cancelled' AND $where GROUP BY o.payment_method");
            foreach ($rows as $r) {
                $k = $r['m'] === 'gateway' ? 'gateway' : ($r['m'] === 'cash' ? 'cash' : 'upi');
                $out[$k] += (int) $r['total'];
                $out['total'] += (int) $r['total'];
            }
            return $out;
        };
        $printed = Db::one("SELECT COUNT(*) n FROM jobs WHERE print_status = 'completed'
                            AND DATE(DATE_ADD(finished_at, INTERVAL $tz MINUTE)) = DATE($now)")['n'];
        $queue = Db::one("SELECT COUNT(*) n FROM jobs WHERE print_status IN ('queued','printing','held')")['n'];
        return [
            'today' => $revenue("DATE($local) = DATE($now)"),
            'month' => $revenue("DATE_FORMAT($local, '%Y-%m') = DATE_FORMAT($now, '%Y-%m')"),
            'printed_today' => (int) $printed,
            'queue' => (int) $queue,
        ];
    }

    public static function attention(): array
    {
        $payments = array_map(fn($o) => [
            'token' => $o['token'], 'total_paise' => (int) $o['total_paise'], 'payment_status' => $o['payment_status'],
            'payment_method' => $o['payment_method'], 'utr' => $o['utr'], 'created_at' => Http::iso($o['created_at']), 'files' => (int) $o['files'],
        ], Db::q("SELECT o.token, o.total_paise, o.payment_status, o.payment_method, o.utr, o.created_at, COUNT(j.id) files
                  FROM orders o JOIN jobs j ON j.order_id = o.id
                  WHERE o.payment_status IN ('pending_cash','pending_verify') GROUP BY o.id ORDER BY o.created_at"));
        $held = array_map(fn($j) => [
            'id' => (int) $j['id'], 'ticket' => $j['ticket'], 'file_name' => $j['file_name'], 'micro_reason' => $j['micro_reason'],
            'amount_paise' => (int) $j['amount_paise'], 'page_start' => (int) $j['page_start'], 'page_end' => (int) $j['page_end'], 'token' => $j['token'],
        ], Db::q("SELECT j.id, j.ticket, j.file_name, j.micro_reason, j.amount_paise, j.page_start, j.page_end, o.token
                  FROM jobs j JOIN orders o ON o.id = j.order_id WHERE j.print_status = 'held' ORDER BY j.id"));
        $s = Settings::get();
        $warnings = [];
        if (!$s['upi_id']) $warnings[] = 'Add your UPI ID in Settings so customers can pay by UPI.';
        if ($s['payment_mode'] === 'gateway' && Payments::effectiveMode($s) !== 'gateway') {
            $warnings[] = 'Gateway mode is selected but no gateway is set up, so UTR mode is being used.';
        }
        $online = Db::one('SELECT COUNT(*) n FROM connectors WHERE last_seen > UTC_TIMESTAMP() - INTERVAL 60 SECOND')['n'];
        if (!(int) $online) $warnings[] = 'No shop computer is connected. Start the Print Connector on the counter PC.';
        if (Config::maxUploadBytes() < 20 * 1048576) {
            $warnings[] = 'Customers can only upload files up to ' . (int) floor(Config::maxUploadBytes() / 1048576) . ' MB. Raise upload_max_filesize and post_max_size to 30M in your hosting PHP settings.';
        }
        return ['payments' => $payments, 'held' => $held, 'warnings' => $warnings];
    }

    public static function jobs(int $limit): array
    {
        $limit = min(500, max(1, $limit));
        $rows = Db::q("SELECT j.id, j.ticket, j.file_name, j.file_kind, j.total_pages, j.page_start, j.page_end, j.copies,
              j.color_mode, j.pages_bw, j.pages_partial, j.pages_full, j.amount_paise, j.micro_verdict, j.micro_reason,
              j.print_status, j.printer_label, j.computer_name, j.claimed_at, j.finished_at, j.error, j.note, j.refund_if_paid,
              j.created_at, (j.file_path = '' OR j.file_path IS NULL) AS file_gone,
              o.token, o.payment_status, o.payment_method, o.utr,
              TIMESTAMPDIFF(MINUTE, j.claimed_at, UTC_TIMESTAMP()) AS printing_minutes
              FROM jobs j JOIN orders o ON o.id = j.order_id ORDER BY j.id DESC LIMIT $limit");
        return array_map(function ($r) {
            foreach (['id', 'total_pages', 'page_start', 'page_end', 'copies', 'pages_bw', 'pages_partial', 'pages_full', 'amount_paise', 'refund_if_paid'] as $k) $r[$k] = (int) $r[$k];
            foreach (['claimed_at', 'finished_at', 'created_at'] as $k) $r[$k] = Http::iso($r[$k]);
            $r['printing_minutes'] = $r['printing_minutes'] === null ? null : (int) $r['printing_minutes'];
            $r['file_gone'] = (bool) $r['file_gone'];
            $r['stuck'] = $r['print_status'] === 'printing' && $r['printing_minutes'] !== null && $r['printing_minutes'] >= 10;
            return $r;
        }, $rows);
    }
}
