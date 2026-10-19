<?php
/*
 * Micro-printing screening for raster images (photos, scans, images inside PDFs).
 *
 * Microtext looks like many very tightly spaced text lines. Inside a small square
 * tile, the amount of ink per row rises and falls with a short, regular period
 * (one period = one text line), while along each line the ink is broken into
 * short strokes (letters).
 *
 * Deliberately ignored:
 *   - QR codes, halftone dots, crosshatching: regular in BOTH directions
 *   - barcodes, ruled lines: long unbroken ink runs
 *   - noise and photos: no regular period
 *   - ordinary text: wide empty gaps between lines, longer line spacing
 *   - images too low-resolution to contain readable microtext
 * Image findings are only ever "suspect": the owner looks and decides.
 */
declare(strict_types=1);

final class Microtext
{
    public const MAX_PITCH_PT = 4.2;   // text-line pitch at or below this (≈3pt text) is "micro"
    private const MIN_PITCH_PX = 3;    // a line pitch below 3 px cannot be resolved
    private const TARGET_PITCH_PX = 12; // downscale so the largest pitch of interest is ~12 px
    private const MIN_FLAGGED_TILES = 4; // calibrated: microtext flags 12+ tiles, documents at most 2

    /**
     * $im: GD image (any size); $dpi: pixels per inch as printed.
     * Returns ['checked'=>bool, 'suspect'=>bool, 'reason'=>string, 'flagged'=>int, 'pitchPt'=>float]
     */
    public static function detect(\GdImage $im, float $dpi, ?float $deadline = null): array
    {
        $maxPitchPx = (self::MAX_PITCH_PT / 72) * $dpi;
        if (!($dpi > 0) || $maxPitchPx < self::MIN_PITCH_PX + 1) {
            return ['checked' => false, 'suspect' => false, 'reason' => 'resolution too low to contain readable microtext', 'flagged' => 0, 'pitchPt' => 0];
        }
        $W = imagesx($im);
        $H = imagesy($im);
        $s = min(1.0, self::TARGET_PITCH_PX / $maxPitchPx);
        $w = max(1, (int) floor($W * $s));
        $h = max(1, (int) floor($H * $s));
        $small = imagecreatetruecolor($w, $h);
        imagecopyresampled($small, $im, 0, 0, 0, 0, $w, $h, $W, $H); // box average

        $maxLag = max(self::MIN_PITCH_PX + 1, (int) floor($maxPitchPx * $s));
        [$mask, $tmask] = self::inkMask($small, $w, $h, max(6, $maxLag * 2));
        $T = max(24, (int) round($maxLag * 6)); // square tile ≈ 6 line pitches
        $step = max(8, (int) round($T / 2));

        $flagged = 0;
        $best = 0;
        for ($y0 = 0; $y0 + $T <= $h; $y0 += $step) {
            if ($deadline !== null && microtime(true) > $deadline) throw new AnalysisError('timeout', '');
            for ($x0 = 0; $x0 + $T <= $w; $x0 += $step) {
                $r = self::tile($mask, $tmask, $w, $h, $x0, $y0, $T, $maxLag);
                if ($r) {
                    $flagged++;
                    $best = $r;
                }
            }
        }
        $pitchPt = $best ? ($best / $s / $dpi) * 72 : 0.0;
        $suspect = $flagged >= self::MIN_FLAGGED_TILES;
        return [
            'checked' => true, 'suspect' => $suspect, 'flagged' => $flagged, 'pitchPt' => round($pitchPt, 1),
            'reason' => $suspect ? sprintf('tightly spaced text-like lines (about %.1fpt line spacing)', $pitchPt) : '',
        ];
    }

    /**
     * Ink mask: a pixel is ink if clearly darker than its neighbourhood (handles light ink).
     * The neighbourhood average comes from GD (shrink then enlarge), so PHP only compares bytes.
     * Returns [rowMajorMask, columnMajorMask] as strings of "0"/"1".
     */
    private static function inkMask(\GdImage $img, int $w, int $h, int $radius): array
    {
        $k = 2 * $radius + 1;
        $sw = max(1, (int) ceil($w / $k));
        $sh = max(1, (int) ceil($h / $k));
        $low = imagecreatetruecolor($sw, $sh);
        imagecopyresampled($low, $img, 0, 0, 0, 0, $sw, $sh, $w, $h);
        $mean = imagecreatetruecolor($w, $h);
        imagecopyresampled($mean, $low, 0, 0, 0, 0, $w, $h, $sw, $sh);

        $g = Raster::toGrayBytes($img);
        $m = Raster::toGrayBytes($mean);
        $rows = [];
        $cols = array_fill(0, $w, '');
        for ($y = 0; $y < $h; $y++) {
            $o = $y * $w;
            $row = '';
            for ($x = 0; $x < $w; $x++) {
                $v = ord($g[$o + $x]);
                $mu = ord($m[$o + $x]);
                $c = ($v < $mu - max(10, $mu * 0.08) && $v < 235) ? '1' : '0';
                $row .= $c;
                $cols[$x] .= $c;
            }
            $rows[] = $row;
        }
        return [implode('', $rows), implode('', $cols)];
    }

    private static function tile(string $mask, string $tmask, int $w, int $h, int $x0, int $y0, int $T, int $maxLag): int
    {
        $rows = [];
        $total = 0;
        for ($y = 0; $y < $T; $y++) {
            $c = substr_count($mask, '1', ($y0 + $y) * $w + $x0, $T);
            $rows[] = $c;
            $total += $c;
        }
        $frac = $total / ($T * $T);
        if ($frac < 0.04 || $frac > 0.6) return 0;
        $cols = [];
        for ($x = 0; $x < $T; $x++) $cols[] = substr_count($tmask, '1', ($x0 + $x) * $h + $y0, $T);

        $pr = self::periodicity($rows, self::MIN_PITCH_PX, $maxLag);
        $pc = self::periodicity($cols, self::MIN_PITCH_PX, $maxLag);
        foreach ([[$pr, $pc, true], [$pc, $pr, false]] as [$main, $other, $horiz]) {
            if ($main['strength'] < 0.45 || !$main['lag']) continue;
            if ($main['lag'] >= $maxLag) continue; // peak at the edge of the range: the true line spacing is longer
            $prof = $horiz ? $rows : $cols;
            $second = self::autocorrAt($prof, 2 * $main['lag']);
            if ($second < 0.2) continue;               // a true repeat also correlates at 2× the period
            if ($second > $main['strength'] + 0.15) continue; // the real line spacing is the longer one
            if ($other['strength'] > 0.35) continue;   // isotropic: halftone, QR, crosshatch
            if (!self::regularBands($prof, $main['lag'])) continue;
            if (!self::evenlySpread($horiz ? $cols : $rows, $main['lag'])) continue;
            [$run, $ruled] = self::runs($horiz ? $mask : $tmask, $horiz ? $w : $h, $horiz ? $x0 : $y0, $horiz ? $y0 : $x0, $T);
            if ($run <= 0 || $run > $main['lag'] * 1.2) continue; // letters = short strokes; rules/barcodes = long runs
            if ($ruled >= 2) continue; // unbroken lines right across the tile: ruling or hatching, not letters
            return $main['lag'];
        }
        return 0;
    }

    /** Strength (0..1) and lag of the strongest short repeat in a profile. */
    private static function periodicity(array $p, int $minLag, int $maxLag): array
    {
        $n = count($p);
        $mean = array_sum($p) / $n;
        $z = [];
        $var0 = 0.0;
        foreach ($p as $v) {
            $d = $v - $mean;
            $z[] = $d;
            $var0 += $d * $d;
        }
        if ($var0 <= 1e-9) return ['strength' => 0, 'lag' => 0];
        $ac = [];
        $top = min($maxLag + 2, $n - 1);
        for ($lag = 1; $lag <= $top; $lag++) {
            $s = 0.0;
            for ($i = 0; $i + $lag < $n; $i++) $s += $z[$i] * $z[$i + $lag];
            $ac[$lag] = ($s / ($n - $lag)) / ($var0 / $n);
        }
        $best = 0.0;
        $bestLag = 0;
        for ($lag = $minLag; $lag <= $maxLag && $lag + 1 < $n; $lag++) {
            if (!isset($ac[$lag + 1])) break;
            if ($ac[$lag] > $best && $ac[$lag] >= $ac[$lag - 1] && $ac[$lag] >= $ac[$lag + 1]) {
                $best = $ac[$lag];
                $bestLag = $lag;
            }
        }
        return ['strength' => $best, 'lag' => $bestLag];
    }

    private static function autocorrAt(array $p, int $lag): float
    {
        $n = count($p);
        if ($lag >= $n - 1) return 0.0;
        $mean = array_sum($p) / $n;
        $v0 = 0.0;
        $s = 0.0;
        for ($i = 0; $i < $n; $i++) $v0 += ($p[$i] - $mean) ** 2;
        for ($i = 0; $i + $lag < $n; $i++) $s += ($p[$i] - $mean) * ($p[$i + $lag] - $mean);
        return $v0 > 0 ? ($s / ($n - $lag)) / ($v0 / $n) : 0.0;
    }

    /** A regular run of separate line bands spaced ~lag apart, covering most of the tile. */
    private static function regularBands(array $p, int $lag): bool
    {
        $max = max($p);
        if ($max <= 0) return false;
        $starts = [];
        $in = false;
        foreach ($p as $i => $v) {
            if (!$in && $v > $max * 0.55) {
                $starts[] = $i;
                $in = true;
            } elseif ($in && $v < $max * 0.3) {
                $in = false;
            }
        }
        $n = count($starts);
        if ($n < 3) return false;
        $span = $starts[$n - 1] - $starts[0];
        if (($n - 1) * $lag < min(count($p) * 0.5, $span * 0.8)) return false;
        $good = 0;
        for ($i = 1; $i < $n; $i++) {
            $d = $starts[$i] - $starts[$i - 1];
            if ($d >= $lag * 0.7 && $d <= $lag * 1.3) $good++;
        }
        return $good >= ($n - 1) * 0.75 && $good >= 2;
    }

    /** Microtext lines run across the tile: no wide empty stretches along them. */
    private static function evenlySpread(array $p, int $lag): bool
    {
        $mean = array_sum($p) / count($p);
        if ($mean <= 0) return false;
        $sparse = 0;
        $run = 0;
        $longest = 0;
        foreach ($p as $v) {
            if ($v < $mean * 0.35) {
                $sparse++;
                $run++;
                if ($run > $longest) $longest = $run;
            } else {
                $run = 0;
            }
        }
        return $sparse <= count($p) * 0.35 && $longest <= max(2, $lag * 0.6);
    }

    /**
     * Along the lines inside the tile: [mean ink-run length, number of lines that
     * contain one unbroken run across most of the tile].
     */
    private static function runs(string $m, int $stride, int $a0, int $b0, int $T): array
    {
        $runs = 0;
        $total = 0;
        $ruled = 0;
        for ($b = 0; $b < $T; $b++) {
            $seg = substr($m, ($b0 + $b) * $stride + $a0, $T);
            if (preg_match_all('/1+/', $seg, $mm)) {
                $longest = 0;
                foreach ($mm[0] as $r) {
                    $l = strlen($r);
                    $runs++;
                    $total += $l;
                    if ($l > $longest) $longest = $l;
                }
                if ($longest >= $T * 0.6) $ruled++;
            }
        }
        return [$runs ? $total / $runs : 0.0, $ruled];
    }
}
