<?php
/*
 * Walks a page's drawing operations (without rendering) and measures:
 *   - coloured area: coloured fills, strokes, text, gradients, patterns and images
 *   - real printed font sizes (for micro-printing)
 *   - embedded images (scans) for raster micro-printing
 * Grey/black/white counts as zero colour.
 */
declare(strict_types=1);

/** Document-wide counters shared by all pages. */
final class PdfScanState
{
    public int $tiny = 0;   // glyphs printed smaller than 2pt
    public int $small = 0;  // glyphs printed 2–3pt
    public ?string $imageSuspect = null;
    public int $imagesChecked = 0;
    public int $imagesSkipped = 0;
    public function __construct(public float $deadline) {}
}

final class PdfPage
{
    public const TINY_PT = 2.0;
    public const SMALL_PT = 3.0;
    private const MAX_MICRO_IMAGES = 12;
    private const MAX_DEPTH = 12;

    public float $coloured = 0.0;
    private int $tokens = 0;
    private array $fontCache = [];
    private array $patternCache = [];

    public function __construct(
        private PdfFile $f,
        private array $pageBox,
        private PdfScanState $scan,
        private int $pageNo,
        private bool $probe = false,
    ) {}

    public static function area(?array $b): float
    {
        return $b ? max(0.0, $b[2] - $b[0]) * max(0.0, $b[3] - $b[1]) : 0.0;
    }
    private static function intersect(?array $a, ?array $b): ?array
    {
        if (!$a) return $b;
        if (!$b) return $a;
        return [max($a[0], $b[0]), max($a[1], $b[1]), min($a[2], $b[2]), min($a[3], $b[3])];
    }
    /** m then n (row-vector convention [a b c d e f]) */
    private static function mul(array $m, array $n): array
    {
        return [
            $m[0] * $n[0] + $m[1] * $n[2], $m[0] * $n[1] + $m[1] * $n[3],
            $m[2] * $n[0] + $m[3] * $n[2], $m[2] * $n[1] + $m[3] * $n[3],
            $m[4] * $n[0] + $m[5] * $n[2] + $n[4], $m[4] * $n[1] + $m[5] * $n[3] + $n[5],
        ];
    }
    private static function boxThrough(array $m, float $x0, float $y0, float $x1, float $y1): array
    {
        $xs = [];
        $ys = [];
        foreach ([[$x0, $y0], [$x1, $y0], [$x0, $y1], [$x1, $y1]] as [$x, $y]) {
            $xs[] = $m[0] * $x + $m[2] * $y + $m[4];
            $ys[] = $m[1] * $x + $m[3] * $y + $m[5];
        }
        return [min($xs), min($ys), max($xs), max($ys)];
    }
    private static function scaleOf(array $m): float
    {
        return sqrt(abs($m[0] * $m[3] - $m[1] * $m[2]));
    }
    private function addArea(?array $box, ?array $clip, float $frac = 1.0): void
    {
        $this->coloured += self::area(self::intersect(self::intersect($box, $clip), $this->pageBox)) * $frac;
    }

    /* ======================= colour spaces ======================= */

    private const NEUTRAL_INKS = ['/All', '/Black', '/None', '/Gray', '/Grey', '/K'];

    /** Normalise a colour space into ['t'=>type, ...]. */
    private function colourSpace($cs, array $res, int $depth = 0): array
    {
        $cs = $this->f->resolve($cs);
        if ($depth > 8) return ['t' => 'gray', 'n' => 1];
        if (is_string($cs)) {
            switch ($cs) {
                case '/DeviceGray': case '/G': case '/CalGray': return ['t' => 'gray', 'n' => 1];
                case '/DeviceRGB': case '/RGB': case '/CalRGB': return ['t' => 'rgb', 'n' => 3];
                case '/DeviceCMYK': case '/CMYK': return ['t' => 'cmyk', 'n' => 4];
                case '/Pattern': return ['t' => 'pattern', 'n' => 0, 'base' => null];
            }
            $named = $this->f->dict($res['ColorSpace'] ?? [])[substr($cs, 1)] ?? null;
            return $named !== null ? $this->colourSpace($named, $res, $depth + 1) : ['t' => 'gray', 'n' => 1];
        }
        if (!is_array($cs) || !$cs) return ['t' => 'gray', 'n' => 1];
        $kind = $this->f->resolve($cs[0]);
        switch ($kind) {
            case '/ICCBased':
                $st = $this->f->resolve($cs[1] ?? null);
                $n = $st instanceof PStream ? (int) $this->f->resolve($st->dict['N'] ?? 3) : 3;
                return $n === 1 ? ['t' => 'gray', 'n' => 1] : ($n === 4 ? ['t' => 'cmyk', 'n' => 4] : ['t' => 'rgb', 'n' => 3]);
            case '/CalRGB': return ['t' => 'rgb', 'n' => 3];
            case '/CalGray': return ['t' => 'gray', 'n' => 1];
            case '/Lab': return ['t' => 'lab', 'n' => 3];
            case '/Indexed': case '/I':
                $base = $this->colourSpace($cs[1] ?? '/DeviceRGB', $res, $depth + 1);
                $hival = (int) $this->f->resolve($cs[2] ?? 0);
                $lk = $this->f->resolve($cs[3] ?? null);
                $bytes = $lk instanceof PStr ? $lk->v : ($lk instanceof PStream ? (string) $this->f->streamData($lk) : '');
                $pal = [];
                $nb = max(1, $base['n']);
                for ($i = 0; $i <= min(255, $hival); $i++) {
                    $comps = [];
                    for ($k = 0; $k < $nb; $k++) $comps[] = ord($bytes[$i * $nb + $k] ?? "\0") / 255;
                    $pal[] = $this->toRgb($base, $comps);
                }
                return ['t' => 'indexed', 'n' => 1, 'pal' => $pal];
            case '/Separation':
                $name = $this->f->resolve($cs[1] ?? '/All');
                return ['t' => 'sep', 'n' => 1, 'neutral' => [in_array($name, self::NEUTRAL_INKS, true) || stripos((string) $name, 'black') !== false]];
            case '/DeviceN':
                $names = $this->f->resolve($cs[1] ?? []);
                $neutral = [];
                foreach (is_array($names) ? $names : [] as $nm) {
                    $nm = $this->f->resolve($nm);
                    $neutral[] = in_array($nm, self::NEUTRAL_INKS, true) || in_array($nm, ['/Black'], true) || stripos((string) $nm, 'black') !== false;
                }
                return ['t' => 'sep', 'n' => max(1, count($neutral)), 'neutral' => $neutral ?: [true]];
            case '/Pattern':
                return ['t' => 'pattern', 'n' => 0, 'base' => isset($cs[1]) ? $this->colourSpace($cs[1], $res, $depth + 1) : null];
        }
        return ['t' => 'gray', 'n' => 1];
    }

    /** Convert components (0..1) in a colour space to [r,g,b] 0..255, or null if "coloured spot ink". */
    private function toRgb(array $cs, array $c): ?array
    {
        $v = fn($i, $d = 0.0) => is_numeric($c[$i] ?? null) ? (float) $c[$i] : $d;
        switch ($cs['t']) {
            case 'gray': $g = $v(0) * 255; return [$g, $g, $g];
            case 'rgb': return [$v(0) * 255, $v(1) * 255, $v(2) * 255];
            case 'cmyk':
                $k = 1 - $v(3);
                return [255 * (1 - $v(0)) * $k, 255 * (1 - $v(1)) * $k, 255 * (1 - $v(2)) * $k];
            case 'lab':
                return (abs($v(1)) > 15 || abs($v(2)) > 15) ? [255, 0, 0] : [128, 128, 128];
            case 'indexed':
                return $cs['pal'][(int) $v(0)] ?? [0, 0, 0];
            case 'sep':
                foreach ($cs['neutral'] as $i => $isNeutral) {
                    if (!$isNeutral && $v($i, 1.0) > 0.05) return [255, 0, 0];
                }
                return [0, 0, 0];
        }
        return [0, 0, 0];
    }

    private static function chromatic(?array $rgb): bool
    {
        if (!$rgb) return false;
        return max($rgb) - min($rgb) > Raster::CHROMA_MIN;
    }

    private function initialColour(array $cs): bool
    {
        if ($cs['t'] === 'sep') return $this->chromaticIn($cs, array_fill(0, $cs['n'], 1.0));
        if ($cs['t'] === 'cmyk') return false; // initial = black
        if ($cs['t'] === 'indexed') return self::chromatic($cs['pal'][0] ?? null);
        return false;
    }
    private function chromaticIn(array $cs, array $comps): bool
    {
        return $cs['t'] !== 'pattern' && self::chromatic($this->toRgb($cs, $comps));
    }

    /* ======================= patterns & shadings ======================= */

    private function functionColoured($fn, array $cs, int $depth = 0): bool
    {
        $fn = $this->f->resolve($fn);
        if ($depth > 6 || $fn === null) return $cs['t'] !== 'gray';
        if (is_array($fn) && array_is_list($fn)) { // one function per component
            return !in_array($cs['t'], ['gray'], true);
        }
        $d = $this->f->dict($fn);
        $type = (int) $this->f->resolve($d['FunctionType'] ?? -1);
        if ($type === 2) {
            $c0 = $this->f->numArray($d['C0'] ?? [0.0]);
            $c1 = $this->f->numArray($d['C1'] ?? [1.0]);
            return $this->chromaticIn($cs, $c0) || $this->chromaticIn($cs, $c1);
        }
        if ($type === 3) {
            foreach ((array) $this->f->resolve($d['Functions'] ?? []) as $sub) {
                if ($this->functionColoured($sub, $cs, $depth + 1)) return true;
            }
            return false;
        }
        if ($type === 0 && $fn instanceof PStream) {
            $data = $this->f->streamData($fn);
            $bps = (int) $this->f->resolve($d['BitsPerSample'] ?? 8);
            if ($data === null || $bps !== 8) return $cs['t'] !== 'gray';
            $n = max(1, $cs['n']);
            $count = intdiv(strlen($data), $n);
            $step = max(1, intdiv($count, 64));
            for ($i = 0; $i < $count; $i += $step) {
                $comps = [];
                for ($k = 0; $k < $n; $k++) $comps[] = ord($data[$i * $n + $k]) / 255;
                if ($this->chromaticIn($cs, $comps)) return true;
            }
            return false;
        }
        return $cs['t'] !== 'gray'; // PostScript functions etc.: assume colour unless grey space
    }

    private function shadingColoured($sh, array $res): bool
    {
        $d = $this->f->dict($sh);
        if (!$d) return false;
        $cs = $this->colourSpace($d['ColorSpace'] ?? '/DeviceGray', $res);
        if ($cs['t'] === 'gray') return false;
        if (isset($d['Function'])) return $this->functionColoured($d['Function'], $cs);
        return true; // mesh shadings with per-vertex colours in a colour space
    }

    private function patternColoured(string $name, array $comps, array $fillCS, array $res, int $depth): bool
    {
        $key = $name . '|' . implode(',', $comps);
        if (isset($this->patternCache[$key])) return $this->patternCache[$key];
        $this->patternCache[$key] = false;
        $pat = $this->f->resolve($this->f->dict($res['Pattern'] ?? [])[substr($name, 1)] ?? null);
        $d = $this->f->dict($pat);
        $out = false;
        $ptype = (int) $this->f->resolve($d['PatternType'] ?? 0);
        if ($ptype === 2) {
            $out = $this->shadingColoured($d['Shading'] ?? null, $res);
        } elseif ($ptype === 1 && $pat instanceof PStream) {
            if ((int) $this->f->resolve($d['PaintType'] ?? 1) === 2) { // uncoloured: colour comes from scn
                $base = $fillCS['base'] ?? null;
                $out = $base ? $this->chromaticIn($base, $comps) : false;
            } elseif ($depth < self::MAX_DEPTH) {
                $content = $this->f->streamData($pat);
                if ($content !== null) {
                    $probe = new PdfPage($this->f, [-1e9, -1e9, 1e9, 1e9], $this->scan, $this->pageNo, true);
                    $probe->run($content, $this->f->dict($d['Resources'] ?? []) ?: $res, self::initialState(), $depth + 1);
                    $out = $probe->coloured > 0;
                }
            }
        }
        return $this->patternCache[$key] = $out;
    }

    /* ======================= interpreter ======================= */

    public static function initialState(): array
    {
        return [
            'ctm' => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], 'clip' => null, 'lw' => 1.0,
            'fillCS' => ['t' => 'gray', 'n' => 1], 'strokeCS' => ['t' => 'gray', 'n' => 1],
            'fillC' => false, 'strokeC' => false, 'fillPat' => null,
        ];
    }

    private const TOKEN_RE = '/\G(?:[\s\x00]+|%[^\r\n]*)*((?<s>\((?:[^()\\\\]++|\\\\.|(?&s))*+\))|<<|>>|<[0-9A-Fa-f\s]*>|[\[\]{}]|\/[^\s\/\[\]()<>{}%]*|[^\s\x00\/\[\]()<>{}%]+)/s';

    public function run(string $c, array $res, array $st, int $depth = 0): void
    {
        if ($depth > self::MAX_DEPTH) return;
        $p = 0;
        $n = strlen($c);
        $ops = [];
        $marks = [];
        $stack = [];
        $path = null;
        $pendingClip = false;
        $tm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        $tlm = $tm;
        $leading = 0.0;
        $font = ['bytes' => 1, 'scale' => 1.0];
        $size = 0.0;
        $mode = 0;
        $inInline = false;
        $ARR = new \stdClass();
        $DICT = new \stdClass();

        while ($p < $n) {
            if (!preg_match(self::TOKEN_RE, $c, $m, 0, $p)) {
                // skip whitespace/comment tail or an unparseable byte
                $p++;
                continue;
            }
            $p += strlen($m[0]);
            $t = $m[1];
            if ((++$this->tokens & 4095) === 0 && microtime(true) > $this->scan->deadline) throw new AnalysisError('timeout', '');
            $ch = $t[0];

            if ($ch === '(') { $q = 0; $ops[] = new PStr(PdfLexer::literal($t, $q)); continue; }
            if ($ch === '/') { $ops[] = PdfLexer::name($t); continue; }
            if ($t === '[') { $marks[] = count($ops); $ops[] = $ARR; continue; }
            if ($t === ']') {
                $start = array_pop($marks);
                if ($start === null) continue;
                $arr = array_slice($ops, $start + 1);
                array_splice($ops, $start);
                $ops[] = $arr;
                continue;
            }
            if ($t === '<<') { $marks[] = count($ops); $ops[] = $DICT; continue; }
            if ($t === '>>') {
                $start = array_pop($marks);
                if ($start === null) continue;
                $items = array_slice($ops, $start + 1);
                array_splice($ops, $start);
                $d = [];
                for ($i = 0; $i + 1 < count($items); $i += 2) if (is_string($items[$i])) $d[substr($items[$i], 1)] = $items[$i + 1];
                $ops[] = $d;
                continue;
            }
            if ($ch === '<') {
                $h = preg_replace('/[^0-9A-Fa-f]/', '', $t);
                if (strlen($h) % 2) $h .= '0';
                $ops[] = new PStr((string) hex2bin($h));
                continue;
            }
            if ($ch === '{' || $ch === '}') continue;
            if (($ch >= '0' && $ch <= '9') || $ch === '-' || $ch === '+' || $ch === '.') {
                $ops[] = (float) $t;
                continue;
            }
            if ($t === 'true' || $t === 'false' || $t === 'null') { $ops[] = $t === 'true'; continue; }

            // ---- operator ----
            if ($inInline) {
                if ($t !== 'ID') continue; // dictionary keys/values collect on $ops
                $inInline = false;
                $d = [];
                for ($i = 0; $i + 1 < count($ops); $i += 2) if (is_string($ops[$i])) $d[substr($ops[$i], 1)] = $ops[$i + 1];
                $ops = [];
                if (($c[$p] ?? '') !== '' && strpos(" \r\n\t\0", $c[$p]) !== false) $p++;
                $dict = self::inlineDict($d);
                $end = null;
                $hasFilter = isset($dict['Filter']) && $dict['Filter'] !== [] && $dict['Filter'] !== null;
                if (!$hasFilter) {
                    $w = (int) ($dict['Width'] ?? 0);
                    $hh = (int) ($dict['Height'] ?? 0);
                    $bpc = !empty($dict['ImageMask']) ? 1 : (int) ($dict['BitsPerComponent'] ?? 8);
                    $ncomp = $this->colourSpace($dict['ColorSpace'] ?? '/DeviceGray', $res)['n'] ?: 1;
                    if (!empty($dict['ImageMask'])) $ncomp = 1;
                    $len = intdiv($w * $ncomp * $bpc + 7, 8) * $hh;
                    if ($len > 0 && $p + $len <= $n && preg_match('/\G[\s\x00]*EI(?=[\s\x00]|$)/', $c, $em, 0, $p + $len)) {
                        $end = [$p + $len, $p + $len + strlen($em[0])];
                    }
                }
                if ($end === null) {
                    if (!preg_match('/[\s\x00]EI(?=[\s\x00]|$)/', $c, $em, PREG_OFFSET_CAPTURE, $p)) break;
                    $end = [$em[0][1], $em[0][1] + strlen($em[0][0])];
                }
                $data = substr($c, $p, $end[0] - $p);
                $p = $end[1];
                $this->image(new PStream($dict, $data), $st, $res);
                continue;
            }

            $a = $ops;
            $ops = [];
            $marks = [];
            $num = fn(int $i) => isset($a[$i]) && (is_float($a[$i]) || is_int($a[$i])) ? (float) $a[$i] : 0.0;
            switch ($t) {
                case 'q': $stack[] = $st; break;
                case 'Q': if ($stack) $st = array_pop($stack); break;
                case 'cm': if (count($a) >= 6) $st['ctm'] = self::mul([$num(0), $num(1), $num(2), $num(3), $num(4), $num(5)], $st['ctm']); break;
                case 'w': $st['lw'] = $num(0); break;

                // colour
                case 'g': $st['fillCS'] = ['t' => 'gray', 'n' => 1]; $st['fillC'] = false; $st['fillPat'] = null; break;
                case 'G': $st['strokeCS'] = ['t' => 'gray', 'n' => 1]; $st['strokeC'] = false; break;
                case 'rg': $st['fillCS'] = ['t' => 'rgb', 'n' => 3]; $st['fillC'] = $this->chromaticIn($st['fillCS'], [$num(0), $num(1), $num(2)]); $st['fillPat'] = null; break;
                case 'RG': $st['strokeCS'] = ['t' => 'rgb', 'n' => 3]; $st['strokeC'] = $this->chromaticIn($st['strokeCS'], [$num(0), $num(1), $num(2)]); break;
                case 'k': $st['fillCS'] = ['t' => 'cmyk', 'n' => 4]; $st['fillC'] = $this->chromaticIn($st['fillCS'], [$num(0), $num(1), $num(2), $num(3)]); $st['fillPat'] = null; break;
                case 'K': $st['strokeCS'] = ['t' => 'cmyk', 'n' => 4]; $st['strokeC'] = $this->chromaticIn($st['strokeCS'], [$num(0), $num(1), $num(2), $num(3)]); break;
                case 'cs':
                    $st['fillCS'] = $this->colourSpace($a[0] ?? '/DeviceGray', $res);
                    $st['fillC'] = $this->initialColour($st['fillCS']);
                    $st['fillPat'] = null;
                    break;
                case 'CS':
                    $st['strokeCS'] = $this->colourSpace($a[0] ?? '/DeviceGray', $res);
                    $st['strokeC'] = $this->initialColour($st['strokeCS']);
                    break;
                case 'sc': case 'scn':
                    $comps = array_values(array_filter($a, fn($x) => is_float($x)));
                    $last = end($a);
                    if ($st['fillCS']['t'] === 'pattern' && is_string($last)) {
                        $st['fillPat'] = $last;
                        $st['fillPatComps'] = $comps;
                        $st['fillC'] = false;
                    } else {
                        $st['fillC'] = $this->chromaticIn($st['fillCS'], $comps);
                        $st['fillPat'] = null;
                    }
                    break;
                case 'SC': case 'SCN':
                    $comps = array_values(array_filter($a, fn($x) => is_float($x)));
                    $last = end($a);
                    $st['strokeC'] = ($st['strokeCS']['t'] === 'pattern' && is_string($last))
                        ? $this->patternColoured($last, $comps, $st['strokeCS'], $res, $depth)
                        : $this->chromaticIn($st['strokeCS'], $comps);
                    break;

                // paths
                case 'm': case 'l':
                    $path = self::extend($path, $st['ctm'], $num(0), $num(1));
                    break;
                case 'c':
                    $path = self::extend($path, $st['ctm'], $num(0), $num(1));
                    $path = self::extend($path, $st['ctm'], $num(2), $num(3));
                    $path = self::extend($path, $st['ctm'], $num(4), $num(5));
                    break;
                case 'v': case 'y':
                    $path = self::extend($path, $st['ctm'], $num(0), $num(1));
                    $path = self::extend($path, $st['ctm'], $num(2), $num(3));
                    break;
                case 're':
                    $b = self::boxThrough($st['ctm'], $num(0), $num(1), $num(0) + $num(2), $num(1) + $num(3));
                    $path = $path ? [min($path[0], $b[0]), min($path[1], $b[1]), max($path[2], $b[2]), max($path[3], $b[3])] : $b;
                    break;
                case 'h': break;
                case 'W': case 'W*': $pendingClip = true; break;
                case 'n':
                    if ($pendingClip && $path) $st['clip'] = self::intersect($st['clip'], $path);
                    $pendingClip = false; $path = null;
                    break;
                case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
                    if ($path) {
                        $fillCol = $st['fillPat'] !== null
                            ? $this->patternColoured($st['fillPat'], $st['fillPatComps'] ?? [], $st['fillCS'], $res, $depth)
                            : $st['fillC'];
                        if ($fillCol) $this->addArea($path, $st['clip']);
                        if ($pendingClip) $st['clip'] = self::intersect($st['clip'], $path);
                    }
                    $pendingClip = false; $path = null;
                    break;
                case 'S': case 's':
                    if ($path && $st['strokeC']) {
                        $lw = max(0.5, $st['lw'] * self::scaleOf($st['ctm']));
                        $per = 2 * (($path[2] - $path[0]) + ($path[3] - $path[1]));
                        $this->coloured += min(self::area($path), $per * $lw);
                    }
                    if ($pendingClip && $path) $st['clip'] = self::intersect($st['clip'], $path);
                    $pendingClip = false; $path = null;
                    break;
                case 'sh':
                    $sh = $this->f->dict($res['Shading'] ?? [])[substr((string) ($a[0] ?? '/'), 1)] ?? null;
                    if ($this->shadingColoured($sh, $res)) $this->addArea($st['clip'] ?? $this->pageBox, null);
                    break;

                // text
                case 'BT': $tm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]; $tlm = $tm; break;
                case 'Tf':
                    $font = $this->font((string) ($a[0] ?? ''), $res);
                    $size = abs($num(1)) * $font['scale'];
                    break;
                case 'Tm': $tm = [$num(0), $num(1), $num(2), $num(3), $num(4), $num(5)]; $tlm = $tm; break;
                case 'Td': $tlm = self::mul([1.0, 0.0, 0.0, 1.0, $num(0), $num(1)], $tlm); $tm = $tlm; break;
                case 'TD': $leading = -$num(1); $tlm = self::mul([1.0, 0.0, 0.0, 1.0, $num(0), $num(1)], $tlm); $tm = $tlm; break;
                case 'TL': $leading = $num(0); break;
                case 'T*': $tlm = self::mul([1.0, 0.0, 0.0, 1.0, 0.0, -$leading], $tlm); $tm = $tlm; break;
                case 'Tr': $mode = (int) $num(0); break;
                case "'": case '"':
                    $tlm = self::mul([1.0, 0.0, 0.0, 1.0, 0.0, -$leading], $tlm); $tm = $tlm;
                    // fall through to show
                case 'Tj': case 'TJ':
                    $glyphs = 0;
                    $items = $t === 'TJ' ? (is_array($a[0] ?? null) ? $a[0] : []) : [end($a)];
                    foreach ($items as $it) {
                        if (!$it instanceof PStr) continue;
                        if ($font['bytes'] === 2) {
                            foreach (str_split($it->v, 2) as $code) if ($code !== "\0 " && strlen($code) === 2) $glyphs++;
                        } else {
                            $glyphs += strlen($it->v) - substr_count($it->v, ' ');
                        }
                    }
                    if ($glyphs <= 0 || ($mode & 3) === 3) break; // invisible text (e.g. OCR layer)
                    $mm = self::mul($tm, $st['ctm']);
                    $eff = $size * hypot($mm[2], $mm[3]); // printed glyph height in points
                    if (!$this->probe) {
                        if ($eff > 0 && $eff < self::TINY_PT) $this->scan->tiny += $glyphs;
                        elseif ($eff >= self::TINY_PT && $eff < self::SMALL_PT) $this->scan->small += $glyphs;
                    }
                    $col = ($mode % 4 === 1) ? $st['strokeC'] : $st['fillC'];
                    if ($col) $this->coloured += min(self::area($this->pageBox), $glyphs * $eff * $eff * 0.5);
                    break;

                // images and forms
                case 'Do':
                    $xo = $this->f->resolve($this->f->dict($res['XObject'] ?? [])[substr((string) ($a[0] ?? '/'), 1)] ?? null);
                    if (!$xo instanceof PStream) break;
                    $sub = $xo->dict['Subtype'] ?? null;
                    if ($sub === '/Image') {
                        $this->image($xo, $st, $res);
                    } elseif ($sub === '/Form' && $depth < self::MAX_DEPTH) {
                        $content = $this->f->streamData($xo);
                        if ($content === null) break;
                        $fs = $st;
                        $mx = $this->f->numArray($xo->dict['Matrix'] ?? []);
                        if (count($mx) === 6) $fs['ctm'] = self::mul($mx, $st['ctm']);
                        $bb = $this->f->numArray($xo->dict['BBox'] ?? []);
                        if (count($bb) === 4) $fs['clip'] = self::intersect($st['clip'], self::boxThrough($fs['ctm'], $bb[0], $bb[1], $bb[2], $bb[3]));
                        $fres = $this->f->dict($xo->dict['Resources'] ?? []) ?: $res;
                        $this->run($content, $fres, $fs, $depth + 1);
                    }
                    break;
                case 'BI': $inInline = true; break;
                default: break;
            }
        }
    }

    private static function extend(?array $path, array $m, float $x, float $y): array
    {
        $px = $m[0] * $x + $m[2] * $y + $m[4];
        $py = $m[1] * $x + $m[3] * $y + $m[5];
        if (!$path) return [$px, $py, $px, $py];
        return [min($path[0], $px), min($path[1], $py), max($path[2], $px), max($path[3], $py)];
    }

    private function font(string $name, array $res): array
    {
        $fd = $this->f->dict($this->f->dict($res['Font'] ?? [])[substr($name, 1)] ?? null);
        $out = ['bytes' => 1, 'scale' => 1.0];
        if (($fd['Subtype'] ?? null) === '/Type0') $out['bytes'] = 2;
        if (($fd['Subtype'] ?? null) === '/Type3') {
            $fm = $this->f->numArray($fd['FontMatrix'] ?? []);
            if (count($fm) === 6 && $fm[3] != 0.0) $out['scale'] = abs($fm[3]) * 1000;
        }
        return $out;
    }

    /** Expand inline-image abbreviations. */
    private static function inlineDict(array $d): array
    {
        $map = ['W' => 'Width', 'H' => 'Height', 'BPC' => 'BitsPerComponent', 'CS' => 'ColorSpace', 'F' => 'Filter',
            'DP' => 'DecodeParms', 'IM' => 'ImageMask', 'D' => 'Decode', 'I' => 'Interpolate'];
        $out = [];
        foreach ($d as $k => $v) $out[$map[$k] ?? $k] = $v;
        $abbr = ['/G' => '/DeviceGray', '/RGB' => '/DeviceRGB', '/CMYK' => '/DeviceCMYK', '/I' => '/Indexed',
            '/AHx' => '/ASCIIHexDecode', '/A85' => '/ASCII85Decode', '/LZW' => '/LZWDecode', '/Fl' => '/FlateDecode',
            '/RL' => '/RunLengthDecode', '/CCF' => '/CCITTFaxDecode', '/DCT' => '/DCTDecode'];
        foreach (['ColorSpace', 'Filter'] as $k) {
            if (isset($out[$k]) && is_string($out[$k])) $out[$k] = $abbr[$out[$k]] ?? $out[$k];
            if (isset($out[$k]) && is_array($out[$k])) $out[$k] = array_map(fn($x) => is_string($x) ? ($abbr[$x] ?? $x) : $x, $out[$k]);
        }
        foreach (['Width', 'Height', 'BitsPerComponent'] as $k) if (isset($out[$k])) $out[$k] = (int) $out[$k];
        return $out;
    }

    /* ======================= images ======================= */

    private function image(PStream $img, array $st, array $res): void
    {
        $d = $img->dict;
        $ctm = $st['ctm'];
        $box = self::boxThrough($ctm, 0, 0, 1, 1);
        $shown = self::area(self::intersect(self::intersect($box, $st['clip']), $this->pageBox));
        if ($shown <= 0) return;
        $w = (int) $this->f->resolve($d['Width'] ?? 0);
        $h = (int) $this->f->resolve($d['Height'] ?? 0);
        $isMask = (bool) $this->f->resolve($d['ImageMask'] ?? false);
        $cs = $isMask ? ['t' => 'gray', 'n' => 1] : $this->colourSpace($d['ColorSpace'] ?? '/DeviceGray', $res);
        if ($isMask && $st['fillC']) $this->addArea($box, $st['clip'], 0.3);

        $pageArea = self::area($this->pageBox);
        $needColour = !$isMask && !in_array($cs['t'], ['gray', 'sep'], true);
        $wantMicro = !$this->probe && $this->scan->imageSuspect === null && $w * $h >= 40000
            && $shown >= $pageArea * 0.02 && $this->scan->imagesChecked < self::MAX_MICRO_IMAGES;
        if (!$needColour && !$wantMicro) return;

        $gd = $this->decodeImage($img, $w, $h, $cs, $isMask);
        if (!$gd) {
            $this->scan->imagesSkipped++;
            return;
        }
        if ($needColour) $this->coloured += $shown * Raster::colourFraction($gd);
        if ($wantMicro) {
            $wIn = hypot($ctm[0], $ctm[1]) / 72;
            $hIn = hypot($ctm[2], $ctm[3]) / 72;
            $dpi = max(imagesx($gd) / max($wIn, 0.01), imagesy($gd) / max($hIn, 0.01));
            $r = Microtext::detect($gd, $dpi, $this->scan->deadline);
            if ($r['checked']) $this->scan->imagesChecked++;
            if ($r['suspect']) $this->scan->imageSuspect = "page {$this->pageNo}: {$r['reason']}";
        }
    }

    private function decodeImage(PStream $img, int $w, int $h, array $cs, bool $isMask): ?\GdImage
    {
        $codec = null;
        $data = $this->f->streamData($img, $codec);
        if ($data === null) return null;
        if ($codec === '/DCTDecode' || $codec === '/DCT') {
            $im = @imagecreatefromstring($data);
            return $im instanceof \GdImage ? $im : null; // CMYK JPEGs are not supported by GD
        }
        if ($codec !== null) return null; // JPX / JBIG2 / CCITT: not decodable here
        $bpc = $isMask ? 1 : (int) $this->f->resolve($img->dict['BitsPerComponent'] ?? 8);
        $decode = $this->f->numArray($img->dict['Decode'] ?? []);
        $invert = count($decode) >= 2 && $decode[0] > $decode[1];
        switch ($cs['t']) {
            case 'gray': return Raster::imageFromRaw($data, $w, $h, $bpc, 'gray', [], $invert);
            case 'rgb': return Raster::imageFromRaw($data, $w, $h, $bpc, 'rgb');
            case 'cmyk': return Raster::imageFromRaw($data, $w, $h, $bpc, 'cmyk');
            case 'indexed':
                return Raster::imageFromRaw($data, $w, $h, $bpc, 'indexed', array_map(fn($c) => array_map(fn($v) => (int) round($v), $c ?? [0, 0, 0]), $cs['pal']));
            case 'sep':
                if ($cs['n'] === 1) return Raster::imageFromRaw($data, $w, $h, $bpc, 'gray', [], !$invert); // tint 1 = full ink = dark
                return null;
        }
        return null;
    }
}
