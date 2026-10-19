<?php
/* Shop settings (single row). Owner credentials are never included in public output. */
declare(strict_types=1);

final class Settings
{
    public static function get(bool $forUpdate = false): array
    {
        return Db::one('SELECT * FROM settings WHERE id = 1' . ($forUpdate ? ' FOR UPDATE' : '')) ?? [];
    }

    public static function publicView(array $s): array
    {
        return [
            'shop_name' => $s['shop_name'],
            'rate_bw' => (float) $s['rate_bw'],
            'rate_partial' => (float) $s['rate_partial'],
            'rate_full' => (float) $s['rate_full'],
            'color_threshold' => (float) $s['color_threshold'],
            'upi_id' => $s['upi_id'],
            'payee_name' => $s['payee_name'] ?: $s['shop_name'],
            'payment_mode' => Payments::effectiveMode($s),
            'allow_cash' => (bool) $s['allow_cash'],
            'accepting_orders' => (bool) $s['accepting_orders'],
        ];
    }

    public static function ownerView(array $s): array
    {
        return self::publicView($s) + [
            'payment_mode_selected' => $s['payment_mode'],
            'verify_upi' => (bool) $s['verify_upi'],
            'owner_username' => $s['owner_username'] ?? '',
            'gateway' => Payments::gatewayInfo(),
        ];
    }

    public static function update(array $in): array
    {
        $rules = [
            'shop_name' => fn($v) => mb_substr(trim((string) $v), 0, 120) ?: 'Print Shop',
            'rate_bw' => [self::class, 'money'], 'rate_partial' => [self::class, 'money'], 'rate_full' => [self::class, 'money'],
            'color_threshold' => function ($v) {
                $n = (float) $v;
                if (!is_numeric($v) || !($n > 0 && $n <= 100)) throw new UserError(400, 'Threshold must be between 1 and 100%');
                return round($n, 2);
            },
            'upi_id' => function ($v) {
                $s = trim((string) $v);
                if ($s !== '' && !preg_match('/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/', $s)) {
                    throw new UserError(400, 'That UPI ID does not look right (example: shopname@okaxis)');
                }
                return $s;
            },
            'payee_name' => fn($v) => mb_substr(trim((string) $v), 0, 120),
            'payment_mode' => function ($v) {
                if (!in_array($v, ['utr', 'gateway'], true)) throw new UserError(400, 'Unknown payment mode');
                return $v;
            },
            'verify_upi' => [self::class, 'bool'], 'allow_cash' => [self::class, 'bool'], 'accepting_orders' => [self::class, 'bool'],
        ];
        $sets = [];
        $vals = [];
        foreach ($rules as $k => $fn) {
            if (!array_key_exists($k, $in)) continue;
            $sets[] = "`$k` = ?";
            $vals[] = $fn($in[$k]);
        }
        if ($sets) Db::q('UPDATE settings SET ' . implode(', ', $sets) . ', updated_at = UTC_TIMESTAMP() WHERE id = 1', $vals);
        return self::get();
    }

    public static function money($v): string
    {
        $n = (float) $v;
        if (!is_numeric($v) || $n < 0 || $n > 10000) throw new UserError(400, 'Rates must be between ₹0 and ₹10,000');
        return number_format($n, 2, '.', '');
    }

    public static function bool($v): int
    {
        return ($v === true || $v === 1 || $v === '1' || $v === 'true') ? 1 : 0;
    }
}
