<?php
/*
 * Orders, payments and job state changes — the core rules.
 *
 * An ORDER is one payment covering one or more JOBS (one job per file).
 *
 * Order payment_status:
 *   unpaid, pending_cash, pending_verify (UTR typed, owner checking), gateway_pending,
 *   paid, rejected (owner: money never arrived), refunded (gateway), expired (unpaid 24 h)
 * Job print_status:
 *   awaiting_payment -> queued -> printing -> completed | failed
 *   held (possible micro-printing, waits for the owner) -> queued | cancelled
 */
declare(strict_types=1);

final class Orders
{
    private const MAX_FILES_PER_ORDER = 20;

    private static function newToken(): string
    {
        for ($attempt = 0; $attempt < 40; $attempt++) {
            $digits = $attempt < 25 ? 4 : ($attempt < 35 ? 5 : 6);
            $token = 'PX-' . random_int(10 ** ($digits - 1), 10 ** $digits - 1);
            if (!Db::one('SELECT id FROM orders WHERE token = ?', [$token])) return $token;
        }
        throw new \RuntimeException('could not allocate order token');
    }

    private static function toInt($v, int $default)
    {
        if ($v === null || $v === '') return $default;
        if (is_int($v)) return $v;
        if (is_float($v) && floor($v) === $v) return (int) $v;
        if (is_string($v) && preg_match('/^-?\d+$/', trim($v))) return (int) $v;
        return null; // not a whole number
    }

    /**
     * items: [{upload_id, mode, start, end, copies, note}]
     * Prices are recomputed here from the stored analysis — browser numbers are ignored.
     */
    public static function create($items): array
    {
        if (!is_array($items) || !$items) throw new UserError(400, 'Your cart is empty.');
        if (count($items) > self::MAX_FILES_PER_ORDER) throw new UserError(400, 'At most ' . self::MAX_FILES_PER_ORDER . ' files per order.');

        return Db::tx(function () use ($items) {
            $s = Settings::get();
            if (!$s['accepting_orders']) throw new UserError(503, 'Sorry, the shop is not accepting orders right now.', 'closed');
            $rates = Pricing::ratesFromSettings($s);
            $ids = array_values(array_unique(array_map(fn($i) => (string) ($i['upload_id'] ?? ''), $items)));
            $byId = [];
            foreach (Db::q('SELECT * FROM uploads WHERE id IN (?) FOR UPDATE', [$ids]) as $u) $byId[$u['id']] = $u;

            $lines = [];
            foreach (array_values($items) as $idx => $it) {
                $n = $idx + 1;
                $u = $byId[(string) ($it['upload_id'] ?? '')] ?? null;
                if (!$u) throw new UserError(410, "File $n has expired or was already ordered. Please add it again.", 'upload_missing');
                $coverage = json_decode((string) $u['coverage_json'], true) ?: [];
                $start = self::toInt($it['start'] ?? null, 1);
                $end = self::toInt($it['end'] ?? null, (int) $u['page_count']);
                $copies = self::toInt($it['copies'] ?? null, 1);
                if ($start === null || $end === null || $copies === null) throw new UserError(400, "File $n: pages and copies must be whole numbers.");
                if ($start < 1 || $end > $u['page_count'] || $start > $end) throw new UserError(400, "File $n: pages must be between 1 and {$u['page_count']}.");
                if ($copies < 1 || $copies > 99) throw new UserError(400, "File $n: copies must be between 1 and 99.");
                $mode = ($it['mode'] ?? '') === 'color' ? 'color' : 'bw';
                $p = Pricing::priceFile(['coverage' => $coverage, 'start' => $start, 'end' => $end, 'copies' => $copies, 'mode' => $mode], $rates);
                $note = mb_substr(trim((string) ($it['note'] ?? '')), 0, 300);
                $lines[] = compact('u', 'start', 'end', 'copies', 'mode', 'p') + ['note' => $note !== '' ? $note : null];
            }
            $total = array_sum(array_map(fn($l) => $l['p']['amount'], $lines));
            if ($total <= 0) throw new UserError(400, 'The order total is zero. Please ask the shop to set its prices.');

            $token = self::newToken();
            $key = Http::randomId(10);
            $orderId = Db::q("INSERT INTO orders (token, access_key, total_paise, payment_status, created_at, updated_at)
                              VALUES (?, ?, ?, 'unpaid', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [$token, $key, $total])['id'];
            foreach ($lines as $i => $l) {
                $u = $l['u'];
                Db::q("INSERT INTO jobs (order_id, ticket, upload_id, file_path, file_name, file_kind, total_pages,
                        page_start, page_end, copies, color_mode, note, pages_bw, pages_partial, pages_full,
                        rate_bw, rate_partial, rate_full, color_threshold, amount_paise, payment_status,
                        micro_verdict, micro_reason, print_status, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'unpaid', ?, ?, 'awaiting_payment', UTC_TIMESTAMP(), UTC_TIMESTAMP())",
                    [$orderId, $token . '-' . ($i + 1), $u['id'], $u['file_path'], $u['file_name'], $u['file_kind'], (int) $u['page_count'],
                        $l['start'], $l['end'], $l['copies'], $l['mode'], $l['note'], $l['p']['bw'], $l['p']['partial'], $l['p']['full'],
                        $s['rate_bw'], $s['rate_partial'], $s['rate_full'], $s['color_threshold'], $l['p']['amount'],
                        $u['micro_verdict'], $u['micro_reason']]);
            }
            // upload rows stay until they expire, so the customer can go back and change the order before paying
            return ['token' => $token, 'key' => $key, 'total_paise' => $total];
        });
    }

    /* ---------------- lookups ---------------- */

    private static function forCustomer(string $token, string $key, bool $lock = false): array
    {
        $o = Db::one('SELECT * FROM orders WHERE token = ?' . ($lock ? ' FOR UPDATE' : ''), [strtoupper($token)]);
        if (!$o || $key === '' || !hash_equals((string) $o['access_key'], $key)) {
            throw new UserError(404, 'Order not found. Please check the link.', 'not_found');
        }
        return $o;
    }

    private static function byToken(string $token, bool $lock = false): array
    {
        $o = Db::one('SELECT * FROM orders WHERE token = ?' . ($lock ? ' FOR UPDATE' : ''), [strtoupper($token)]);
        if (!$o) throw new UserError(404, 'Order not found.', 'not_found');
        return $o;
    }

    /** What the customer sees for each file. */
    private static function customerState(array $o, array $j): string
    {
        if ($j['print_status'] === 'cancelled' || in_array($o['payment_status'], ['rejected', 'refunded', 'expired'], true)) return 'cancelled';
        switch ($o['payment_status']) {
            case 'unpaid': case 'gateway_pending': return 'waiting_payment';
            case 'pending_cash': return 'waiting_cash';
            case 'pending_verify': return 'verifying_upi';
        }
        if ($j['print_status'] === 'held') return 'checking_file';
        return $j['print_status'];
    }

    private const OVERALL = ['failed', 'waiting_payment', 'waiting_cash', 'verifying_upi', 'checking_file', 'printing', 'queued', 'completed', 'cancelled'];

    public static function status(string $token, string $key): array
    {
        $o = self::forCustomer($token, $key);
        if ($o['payment_status'] === 'gateway_pending' && $o['gateway_ref']) {
            try { self::reconcileGateway($o); } catch (\Throwable $e) { /* keep showing current state */ }
            $o = self::forCustomer($token, $key);
        }
        $files = [];
        foreach (Db::q('SELECT * FROM jobs WHERE order_id = ? ORDER BY id', [$o['id']]) as $j) {
            $files[] = [
                'ticket' => $j['ticket'], 'file_name' => $j['file_name'], 'pages' => "{$j['page_start']}-{$j['page_end']}",
                'copies' => (int) $j['copies'], 'mode' => $j['color_mode'], 'amount_paise' => (int) $j['amount_paise'],
                'state' => self::customerState($o, $j),
                'breakdown' => Pricing::describe(['pages' => $j['page_end'] - $j['page_start'] + 1, 'bw' => (int) $j['pages_bw'], 'partial' => (int) $j['pages_partial'], 'full' => (int) $j['pages_full'], 'copies' => (int) $j['copies']]),
                'error' => $j['print_status'] === 'failed' ? 'There was a problem at the printer. Please tell the shop.' : null,
            ];
        }
        $active = array_values(array_filter($files, fn($f) => $f['state'] !== 'cancelled'));
        $overall = 'cancelled';
        if ($active) {
            $states = array_column($active, 'state');
            if (count(array_unique($states)) === 1 && $states[0] === 'completed') {
                $overall = 'completed';
            } else {
                $overall = 'queued';
                foreach (self::OVERALL as $st) {
                    if ($st !== 'completed' && in_array($st, $states, true)) { $overall = $st; break; }
                }
            }
        }
        return [
            'token' => $o['token'], 'total_paise' => (int) $o['total_paise'], 'payment_status' => $o['payment_status'],
            'payment_method' => $o['payment_method'], 'utr' => $o['utr'], 'overall' => $overall, 'files' => $files,
            'refund_if_paid' => (bool) $o['refund_if_paid'],
        ];
    }

    /* ---------------- payments ---------------- */

    /** Mark paid and release files (call inside a transaction). Suspect files go to "held". */
    private static function markPaid(array $o, string $method, ?string $utr = null, ?string $gatewayRef = null): void
    {
        Db::q("UPDATE orders SET payment_status = 'paid', payment_method = ?, paid_at = COALESCE(paid_at, UTC_TIMESTAMP()),
                 utr = COALESCE(?, utr), gateway_ref = COALESCE(?, gateway_ref), updated_at = UTC_TIMESTAMP() WHERE id = ?",
            [$method, $utr, $gatewayRef, $o['id']]);
        Db::q("UPDATE jobs SET payment_status = 'paid', payment_method = ?, utr = COALESCE(?, utr), gateway_ref = COALESCE(?, gateway_ref),
                 print_status = CASE WHEN micro_verdict = 'suspect' AND reviewed = 0 THEN 'held' ELSE 'queued' END,
                 updated_at = UTC_TIMESTAMP()
               WHERE order_id = ? AND print_status = 'awaiting_payment'", [$method, $utr, $gatewayRef, $o['id']]);
    }

    private static function setJobsPayment(int $orderId, string $status, string $method, ?string $utr): void
    {
        Db::q("UPDATE jobs SET payment_status = ?, payment_method = ?, utr = ?, updated_at = UTC_TIMESTAMP()
               WHERE order_id = ? AND print_status = 'awaiting_payment'", [$status, $method, $utr, $orderId]);
    }

    public static function submitUtr(string $token, string $key, $utrRaw): array
    {
        $utr = trim((string) $utrRaw);
        if (!preg_match('/^\d{12}$/', $utr)) throw new UserError(400, 'The UTR must be exactly 12 digits (numbers only).', 'bad_utr');
        try {
            return Db::tx(function () use ($token, $key, $utr) {
                $o = self::forCustomer($token, $key, true);
                if (!in_array($o['payment_status'], ['unpaid', 'pending_cash'], true)) {
                    throw new UserError(409, 'This order has already been paid or closed.', 'not_payable');
                }
                $s = Settings::get();
                if ($s['verify_upi']) {
                    Db::q("UPDATE orders SET payment_status = 'pending_verify', payment_method = 'upi', utr = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [$utr, $o['id']]);
                    self::setJobsPayment((int) $o['id'], 'pending_verify', 'upi', $utr);
                } else {
                    Db::q('UPDATE orders SET utr = ? WHERE id = ?', [$utr, $o['id']]); // unique check
                    self::markPaid($o, 'upi', $utr);
                }
                return ['ok' => true, 'verify' => (bool) $s['verify_upi']];
            });
        } catch (\PDOException $e) {
            if (Db::isDuplicate($e)) throw new UserError(409, 'This UTR number has already been used for another order. Please check the number in your UPI app.', 'utr_used');
            throw $e;
        }
    }

    public static function chooseCash(string $token, string $key): array
    {
        return Db::tx(function () use ($token, $key) {
            $o = self::forCustomer($token, $key, true);
            if (!Settings::get()['allow_cash']) throw new UserError(400, 'Cash payment is not available right now. Please pay by UPI.', 'no_cash');
            if ($o['payment_status'] !== 'unpaid') throw new UserError(409, 'This order has already been paid or closed.', 'not_payable');
            Db::q("UPDATE orders SET payment_status = 'pending_cash', payment_method = 'cash', updated_at = UTC_TIMESTAMP() WHERE id = ?", [$o['id']]);
            self::setJobsPayment((int) $o['id'], 'pending_cash', 'cash', null);
            return ['ok' => true];
        });
    }

    /** Owner: "Payment received — print". */
    public static function ownerConfirm(string $token): array
    {
        return Db::tx(function () use ($token) {
            $o = self::byToken($token, true);
            if ($o['payment_status'] === 'paid') return ['ok' => true, 'already' => true];
            if (!in_array($o['payment_status'], ['pending_cash', 'pending_verify', 'unpaid'], true)) {
                throw new UserError(409, 'This order is ' . str_replace('_', ' ', $o['payment_status']) . ' and cannot be confirmed.');
            }
            self::markPaid($o, $o['payment_status'] === 'pending_verify' ? 'upi' : 'cash');
            return ['ok' => true];
        });
    }

    /** Owner: "Not received — cancel". Cancels everything not yet printing. */
    public static function ownerReject(string $token): array
    {
        return Db::tx(function () use ($token) {
            $o = self::byToken($token, true);
            if ($o['payment_status'] === 'rejected') return ['ok' => true, 'already' => true];
            $claimed = ($o['payment_status'] === 'paid' || $o['utr'] || $o['payment_status'] === 'pending_cash') ? 1 : 0;
            Db::q("UPDATE orders SET payment_status = 'rejected', refund_if_paid = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [$claimed, $o['id']]);
            Db::q("UPDATE jobs SET print_status = 'cancelled', payment_status = 'rejected', refund_if_paid = ?, finished_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
                   WHERE order_id = ? AND print_status NOT IN ('printing', 'completed')", [$claimed, $o['id']]);
            return ['ok' => true];
        });
    }

    /** Owner reviews a file held for possible micro-printing. */
    public static function review(int $jobId, bool $approve): array
    {
        return Db::tx(function () use ($jobId, $approve) {
            $j = Db::one('SELECT * FROM jobs WHERE id = ? FOR UPDATE', [$jobId]);
            if (!$j) throw new UserError(404, 'File not found.');
            if ($j['print_status'] !== 'held' && !($j['print_status'] === 'awaiting_payment' && $j['micro_verdict'] === 'suspect')) {
                throw new UserError(409, 'This file is not waiting for review.');
            }
            if ($approve) {
                Db::q('UPDATE jobs SET reviewed = 1, print_status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
                    [$j['print_status'] === 'held' ? 'queued' : 'awaiting_payment', $jobId]);
            } else {
                $paid = $j['payment_status'] === 'paid' ? 1 : 0;
                Db::q("UPDATE jobs SET reviewed = 1, print_status = 'cancelled', refund_if_paid = ?, finished_at = UTC_TIMESTAMP(),
                         error = 'Refused by the shop (possible micro-printing)', updated_at = UTC_TIMESTAMP() WHERE id = ?", [$paid, $jobId]);
                if ($paid) Db::q('UPDATE orders SET refund_if_paid = 1 WHERE id = ?', [$j['order_id']]);
            }
            return ['ok' => true];
        });
    }

    /** Owner: send a failed (or stuck >10 min) file back to the queue. */
    public static function retry(int $jobId): array
    {
        $r = Db::q("UPDATE jobs SET print_status = 'queued', printer_label = NULL, computer_name = NULL, claimed_at = NULL, error = NULL,
                      updated_at = UTC_TIMESTAMP()
                    WHERE id = ? AND (print_status = 'failed' OR (print_status = 'printing' AND claimed_at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE))
                      AND payment_status = 'paid'", [$jobId]);
        if (!$r['affected']) throw new UserError(409, 'Only failed files, or files stuck "printing" for over 10 minutes, can be retried.');
        return ['ok' => true];
    }

    /* ---------------- gateway ---------------- */

    public static function startGateway(string $token, string $key): array
    {
        $a = Payments::adapter();
        if (!$a || Payments::effectiveMode(Settings::get()) !== 'gateway') throw new UserError(400, 'Online payment is not available. Please pay by UPI.', 'no_gateway');
        $o = self::forCustomer($token, $key);
        if (!in_array($o['payment_status'], ['unpaid', 'gateway_pending'], true)) throw new UserError(409, 'This order has already been paid or closed.', 'not_payable');
        $base = rtrim((string) Config::get('PUBLIC_URL'), '/');
        $r = $a->createCheckout($o['token'], (int) $o['total_paise'], "Print order {$o['token']}", "$base/?order={$o['token']}&k={$o['access_key']}");
        Db::q("UPDATE orders SET payment_status = 'gateway_pending', gateway_provider = ?, gateway_ref = ?, updated_at = UTC_TIMESTAMP()
               WHERE id = ? AND payment_status IN ('unpaid','gateway_pending')", [$a->name(), $r['gatewayRef'], $o['id']]);
        return ['checkout' => $r['checkout']];
    }

    /**
     * Apply a gateway event — only from a signed webhook or a server-side status fetch,
     * never from the browser redirect. Idempotent: each event id is processed once.
     */
    public static function applyGatewayEvent(string $provider, array $evt, string $source): array
    {
        if (empty($evt['gatewayRef']) || empty($evt['type']) || $evt['type'] === 'ignore') return ['outcome' => 'ignored'];
        return Db::tx(function () use ($provider, $evt, $source) {
            $eventId = isset($evt['eventId']) ? substr((string) $evt['eventId'], 0, 120) : null;
            if ($eventId !== null && $eventId !== '') {
                try {
                    Db::q("INSERT INTO payment_events (provider, event_id, order_token, event_type, amount_paise, outcome, received_at)
                           VALUES (?, ?, NULL, ?, ?, 'processing', UTC_TIMESTAMP())", [$provider, $eventId, (string) $evt['type'], isset($evt['amountPaise']) ? (int) $evt['amountPaise'] : null]);
                } catch (\PDOException $e) {
                    if (Db::isDuplicate($e)) return ['outcome' => 'duplicate'];
                    throw $e;
                }
            }
            $o = Db::one('SELECT * FROM orders WHERE gateway_ref = ? FOR UPDATE', [(string) $evt['gatewayRef']]);
            if (!$o) $outcome = 'unknown_order';
            elseif ($o['gateway_provider'] && $o['gateway_provider'] !== $provider) $outcome = 'provider_mismatch';
            elseif ($evt['type'] === 'paid') {
                if ((int) ($evt['amountPaise'] ?? -1) !== (int) $o['total_paise']) $outcome = 'amount_mismatch';
                elseif ($o['payment_status'] === 'paid') $outcome = 'already_paid';
                elseif (in_array($o['payment_status'], ['rejected', 'refunded', 'expired'], true)) $outcome = 'order_closed';
                else { self::markPaid($o, 'gateway', null, (string) $evt['gatewayRef']); $outcome = 'paid'; }
            } elseif ($evt['type'] === 'failed' || $evt['type'] === 'expired') {
                if ($o['payment_status'] === 'gateway_pending') Db::q("UPDATE orders SET payment_status = 'unpaid', updated_at = UTC_TIMESTAMP() WHERE id = ?", [$o['id']]);
                $outcome = $evt['type'];
            } elseif ($evt['type'] === 'refunded') {
                Db::q("UPDATE orders SET payment_status = 'refunded', refund_if_paid = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?", [$o['id']]);
                Db::q("UPDATE jobs SET print_status = 'cancelled', payment_status = 'refunded', finished_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
                       WHERE order_id = ? AND print_status NOT IN ('printing','completed')", [$o['id']]);
                $outcome = 'refunded';
            } else {
                $outcome = 'ignored';
            }
            if ($eventId !== null && $eventId !== '') {
                Db::q('UPDATE payment_events SET outcome = ?, order_token = ? WHERE provider = ? AND event_id = ?',
                    ["$source:$outcome", $o['token'] ?? null, $provider, $eventId]);
            }
            return ['outcome' => $outcome];
        });
    }

    private static function reconcileGateway(array $o): void
    {
        $a = Payments::adapter();
        if (!$a || $a->name() !== $o['gateway_provider']) return;
        $st = $a->fetchStatus((string) $o['gateway_ref']);
        if ($st && ($st['type'] ?? 'ignore') !== 'ignore') {
            self::applyGatewayEvent($a->name(), $st + ['eventId' => "reconcile:{$o['gateway_ref']}:{$st['type']}"], 'poll');
        }
    }
}
