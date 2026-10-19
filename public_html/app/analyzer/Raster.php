<?php
/*
 * Pixel helpers built on PHP's GD extension (available on all shared hosting).
 * GD does the heavy lifting in C (decode, resize); PHP only walks bytes.
 *
 *  - colourFraction(): share of visibly coloured pixels (grey/neutral = 0)
 *  - toGrayBytes():    8-bit grey string, one byte per pixel, row by row
 *  - imageFromRaw():   build a GD image from raw PDF image samples
 */
declare(strict_types=1);

final class Raster
{
    public const CHROMA_MIN = 40;          // max(r,g,b) - min(r,g,b) above this = visibly coloured
    public const COLOR_NOISE_FLOOR = 0.003; // below 0.3% coloured pixels = scanner/JPEG noise
    public const MIN_COLOR = 0.01;          // any real colour counts as at least 1%

    /** Put a (possibly transparent) image on a white background, as a truecolor image. */
    public static function flatten(\GdImage $im): \GdImage
    {
        $w = imagesx($im);
        $h = imagesy($im);
        $out = imagecreatetruecolor($w, $h);
        imagefilledrectangle($out, 0, 0, $w, $h, imagecolorallocate($out, 255, 255, 255));
        imagealphablending($out, true);
        imagecopy($out, $im, 0, 0, 0, 0, $w, $h);
        return $out;
    }

    /** Export as 24-bit BMP and return [bytes, dataOffset, rowStride]. Rows are bottom-up, BGR. */
    private static function bmp24(\GdImage $im): array
    {
        if (!imageistruecolor($im)) imagepalettetotruecolor($im);
        ob_start();
        imagebmp($im, null, false);
        $b = (string) ob_get_clean();
        $off = unpack('V', substr($b, 10, 4))[1];
        $stride = ((imagesx($im) * 3) + 3) & ~3;
        return [$b, $off, $stride];
    }

    /** Fraction (0..1) of visibly coloured pixels, sampled (nearest neighbour) to at most ~1.5M pixels. */
    public static function colourFraction(\GdImage $im): float
    {
        $w = imagesx($im);
        $h = imagesy($im);
        $max = 1500000;
        if ($w * $h > $max) {
            $s = sqrt($max / ($w * $h));
            $nw = max(1, (int) ($w * $s));
            $nh = max(1, (int) ($h * $s));
            $small = imagecreatetruecolor($nw, $nh);
            imagecopyresized($small, $im, 0, 0, 0, 0, $nw, $nh, $w, $h); // no blending: keeps colours true
            $im = $small;
            $w = $nw;
            $h = $nh;
        }
        [$b, $off, $stride] = self::bmp24($im);
        $coloured = 0;
        $n3 = $w * 3;
        $min = self::CHROMA_MIN;
        for ($y = 0; $y < $h; $y++) {
            $row = substr($b, $off + $y * $stride, $n3);
            for ($i = 0; $i < $n3; $i += 3) {
                $p = ord($row[$i]);
                $q = ord($row[$i + 1]);
                $r = ord($row[$i + 2]);
                $mx = $p > $q ? ($p > $r ? $p : $r) : ($q > $r ? $q : $r);
                $mn = $p < $q ? ($p < $r ? $p : $r) : ($q < $r ? $q : $r);
                if ($mx - $mn > $min) $coloured++;
            }
        }
        $f = $coloured / max(1, $w * $h);
        return $f < self::COLOR_NOISE_FLOOR ? 0.0 : $f;
    }

    public static function withMinimum(float $f): float
    {
        return $f > 0 ? min(1.0, max(self::MIN_COLOR, $f)) : 0.0;
    }

    /** 8-bit grey bytes (top row first). */
    public static function toGrayBytes(\GdImage $im): string
    {
        $w = imagesx($im);
        $h = imagesy($im);
        [$b, $off, $stride] = self::bmp24($im);
        $rows = [];
        $n3 = $w * 3;
        for ($y = $h - 1; $y >= 0; $y--) { // BMP is stored bottom-up
            $row = substr($b, $off + $y * $stride, $n3);
            $g = '';
            for ($i = 0; $i < $n3; $i += 3) {
                $g .= chr((ord($row[$i]) * 29 + ord($row[$i + 1]) * 150 + ord($row[$i + 2]) * 77) >> 8);
            }
            $rows[] = $g;
        }
        return implode('', $rows);
    }

    /* ---------------- raw PDF image samples -> GD ---------------- */

    /**
     * Build a GD image from raw samples.
     *  $mode: 'gray' | 'rgb' | 'cmyk' | 'indexed'
     *  $palette: for indexed, list of [r,g,b]
     *  $invert: PDF /Decode [1 0] on grey/1-bit data
     * Returns null for unsupported layouts.
     */
    public static function imageFromRaw(string $data, int $w, int $h, int $bpc, string $mode, array $palette = [], bool $invert = false): ?\GdImage
    {
        if ($w <= 0 || $h <= 0 || $w * $h > 60000000) return null;
        $comps = ['gray' => 1, 'rgb' => 3, 'cmyk' => 4, 'indexed' => 1][$mode] ?? 0;
        if (!$comps) return null;
        $rowBytes = intdiv($w * $comps * $bpc + 7, 8);
        if (strlen($data) < $rowBytes * $h) {
            if (strlen($data) < $rowBytes) return null;
            $h = intdiv(strlen($data), $rowBytes); // truncated image: use what is there
        }

        // 16-bit samples: keep the high byte
        if ($bpc === 16) {
            $out = '';
            for ($i = 0, $n = $rowBytes * $h; $i < $n; $i += 2) $out .= $data[$i];
            $data = $out;
            $bpc = 8;
            $rowBytes = $w * $comps;
        }
        // CMYK -> RGB
        if ($mode === 'cmyk' && $bpc === 8) {
            $out = '';
            for ($i = 0, $n = $w * $h * 4; $i < $n; $i += 4) {
                $k = 255 - ord($data[$i + 3]);
                $out .= chr(intdiv((255 - ord($data[$i])) * $k, 255))
                      . chr(intdiv((255 - ord($data[$i + 1])) * $k, 255))
                      . chr(intdiv((255 - ord($data[$i + 2])) * $k, 255));
            }
            $data = $out;
            $mode = 'rgb';
            $rowBytes = $w * 3;
        }
        // 2-bit (no BMP equivalent) or 4-bit grey -> 8-bit
        if (($bpc === 2 || ($bpc === 4 && $mode === 'gray')) && ($mode === 'gray' || $mode === 'indexed')) {
            $out = '';
            $maxv = (1 << $bpc) - 1;
            for ($y = 0; $y < $h; $y++) {
                $row = substr($data, $y * $rowBytes, $rowBytes);
                for ($x = 0; $x < $w; $x++) {
                    $bit = $x * $bpc;
                    $v = (ord($row[$bit >> 3]) >> (8 - $bpc - ($bit & 7))) & $maxv;
                    $out .= chr($mode === 'gray' ? intdiv($v * 255, $maxv) : $v);
                }
            }
            $data = $out;
            $bpc = 8;
            $rowBytes = $w;
        }

        if ($mode === 'rgb' && $bpc === 8) {
            $pal = null;
            $bmpBpp = 24;
        } elseif ($mode === 'gray' && ($bpc === 8 || $bpc === 1)) {
            $pal = [];
            $levels = $bpc === 1 ? 2 : 256;
            for ($i = 0; $i < $levels; $i++) {
                $v = $bpc === 1 ? $i * 255 : $i;
                if ($invert) $v = 255 - $v;
                $pal[] = [$v, $v, $v];
            }
            $bmpBpp = $bpc;
        } elseif ($mode === 'indexed' && in_array($bpc, [1, 4, 8], true)) {
            $pal = array_slice(array_pad($palette, 1 << $bpc, [0, 0, 0]), 0, 1 << $bpc);
            $bmpBpp = $bpc;
        } else {
            return null;
        }

        // Assemble a top-down BMP (negative height) and let GD decode it.
        $bmpRow = (intdiv($w * $bmpBpp + 7, 8) + 3) & ~3;
        $srcRow = intdiv($w * ($mode === 'rgb' ? 3 : 1) * $bpc + 7, 8);
        $pad = str_repeat("\0", $bmpRow - min($bmpRow, $srcRow));
        $pixels = [];
        for ($y = 0; $y < $h; $y++) {
            $pixels[] = substr($data, $y * $srcRow, min($srcRow, $bmpRow)) . $pad;
        }
        $pixels = implode('', $pixels);
        $palBytes = '';
        if ($pal !== null) {
            foreach ($pal as [$r, $g, $b]) $palBytes .= chr($b & 255) . chr($g & 255) . chr($r & 255) . "\0";
        }
        $off = 14 + 40 + strlen($palBytes);
        $hdr = 'BM' . pack('VvvV', $off + strlen($pixels), 0, 0, $off)
             . pack('VVVvvVVVVVV', 40, $w, (-$h) & 0xFFFFFFFF, 1, $bmpBpp, 0, strlen($pixels), 2835, 2835, $pal ? count($pal) : 0, 0);
        $im = @imagecreatefromstring($hdr . $palBytes . $pixels);
        return $im instanceof \GdImage ? $im : null;
    }
}
