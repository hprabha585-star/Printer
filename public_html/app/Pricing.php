<?php
/*
 * Server-side pricing — an exact PHP twin of public/shared/pricing.js.
 * (PHP hosting cannot run JavaScript, so the browser module is mirrored here.
 *  tests/pricing_parity.test.js checks both give identical results on thousands
 *  of random cases. Change both files together.)
 * All money is integer PAISE.
 */
declare(strict_types=1);

final class Pricing
{
    public static function toPaise($rupees): int
    {
        $n = is_numeric($rupees) ? (float) $rupees : 0.0;
        if ($n < 0 || !is_finite($n)) return 0;
        return self::roundHalfUp($n * 100);
    }

    /** JavaScript Math.round semantics (halves round up). */
    private static function roundHalfUp(float $x): int
    {
        return (int) floor($x + 0.5);
    }

    public static function classifyPage($coverage, $thresholdPct): string
    {
        $c = is_numeric($coverage) ? (float) $coverage : 0.0;
        $t = ((float) $thresholdPct > 0 ? (float) $thresholdPct : 25.0) / 100;
        if ($c <= 0) return 'bw';
        if ($c >= $t) return 'full';
        return 'partial';
    }

    /**
     * opts: coverage[], start, end, copies, mode ('bw'|'color'); rates: bw, partial, full (paise), threshold (%)
     */
    public static function priceFile(array $opts, array $rates): array
    {
        $cov = $opts['coverage'] ?? [];
        $total = count($cov);
        $start = max(1, (int) floor(is_numeric($opts['start'] ?? null) ? (float) $opts['start'] : 1));
        $endIn = is_numeric($opts['end'] ?? null) ? (int) floor((float) $opts['end']) : 0;
        $end = min($total, $endIn ?: $total);
        $copies = max(1, min(999, (int) floor(is_numeric($opts['copies'] ?? null) ? (float) $opts['copies'] : 1) ?: 1));
        $mode = ($opts['mode'] ?? '') === 'color' ? 'color' : 'bw';
        $out = ['pages' => 0, 'bw' => 0, 'partial' => 0, 'full' => 0, 'copies' => $copies, 'perCopy' => 0, 'amount' => 0, 'start' => $start, 'end' => $end, 'mode' => $mode];
        if ($total === 0 || $end < $start) return $out;
        for ($i = $start - 1; $i < $end; $i++) {
            $out['pages']++;
            if ($mode === 'bw') { $out['bw']++; continue; }
            $out[self::classifyPage($cov[$i], $rates['threshold'])]++;
        }
        $out['perCopy'] = $out['bw'] * $rates['bw'] + $out['partial'] * $rates['partial'] + $out['full'] * $rates['full'];
        $out['amount'] = $out['perCopy'] * $copies;
        return $out;
    }

    public static function describe(array $p): string
    {
        $parts = [];
        if ($p['bw']) $parts[] = $p['bw'] . ' B&W';
        if ($p['partial']) $parts[] = $p['partial'] . ' partial colour';
        if ($p['full']) $parts[] = $p['full'] . ' full colour';
        $s = $p['pages'] . ($p['pages'] === 1 ? ' page' : ' pages');
        if ($parts) $s .= ': ' . implode(', ', $parts);
        if ($p['copies'] > 1) $s .= ', x' . $p['copies'];
        return $s;
    }

    public static function ratesFromSettings(array $s): array
    {
        return [
            'bw' => self::toPaise($s['rate_bw']),
            'partial' => self::toPaise($s['rate_partial']),
            'full' => self::toPaise($s['rate_full']),
            'threshold' => (float) $s['color_threshold'] ?: 25.0,
        ];
    }
}
