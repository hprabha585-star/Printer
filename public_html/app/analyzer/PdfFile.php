<?php
/*
 * Minimal, forgiving PDF file reader (pure PHP, zlib only).
 *
 * Instead of trusting the cross-reference table (often damaged in real files),
 * it scans the whole file for "N G obj" and also reads compressed object
 * streams. Values:
 *   names            -> PHP string starting with "/"     e.g. "/Page"
 *   strings          -> PStr object (decoded bytes)
 *   numbers/booleans -> int|float|bool, null -> null
 *   arrays           -> PHP list
 *   dictionaries     -> PHP associative array keyed by name WITHOUT the slash
 *   references       -> PRef object
 *   streams          -> PStream object (dict + raw bytes)
 */
declare(strict_types=1);

final class PStr { public function __construct(public string $v) {} }
final class PRef { public function __construct(public int $num, public int $gen) {} }
final class PStream
{
    public function __construct(public array $dict, public string $raw) {}
}

final class PdfFile
{
    private string $s;
    /** @var array<int,int> object number -> byte offset of "N G obj" */
    private array $offsets = [];
    /** @var array<int,array{0:int,1:int}> object number -> [object stream number, index] */
    private array $inStream = [];
    private array $cache = [];
    private array $objStmCache = [];
    public array $trailer = [];
    /** true when the PDF needs a password to open */
    public bool $encrypted = false;
    private ?PdfCrypt $crypt = null;
    private int $encryptNum = -1;

    public function __construct(string $data)
    {
        $this->s = $data;
        $this->scan();
    }

    private function scan(): void
    {
        $s = $this->s;
        if (preg_match_all('/(?<![^\s>])(\d{1,10})\s+(\d{1,5})\s+obj\b/', $s, $m, PREG_OFFSET_CAPTURE)) {
            foreach ($m[1] as $i => [$num, $off]) {
                $this->offsets[(int) $num] = $m[0][$i][1]; // later definitions win (incremental updates)
            }
        }
        // trailers (classic) — the last one is the newest
        if (preg_match_all('/trailer\s*<</', $s, $tm, PREG_OFFSET_CAPTURE)) {
            foreach ($tm[0] as [$txt, $off]) {
                $pos = $off + 7;
                try {
                    $d = (new PdfLexer($this->s))->parseValue($pos);
                    if (is_array($d)) $this->mergeTrailer($d);
                } catch (\Throwable $e) { /* damaged trailer: ignore */ }
            }
        }
        // cross-reference streams (hold the trailer in newer PDFs)
        $objStms = [];
        foreach (array_keys($this->offsets) as $num) {
            $o = $this->getRaw($num, false);
            if ($o instanceof PStream) {
                $type = $o->dict['Type'] ?? null;
                if ($type === '/XRef') $this->mergeTrailer($o->dict);
                if ($type === '/ObjStm') $objStms[] = $num;
            }
        }
        // encryption: open with the empty user password, or refuse
        if (isset($this->trailer['Encrypt'])) {
            $encRef = $this->trailer['Encrypt'];
            if ($encRef instanceof PRef) $this->encryptNum = $encRef->num;
            $enc = $encRef instanceof PRef ? $this->getRaw($encRef->num, false) : $encRef;
            $ids = $this->trailer['ID'] ?? [];
            $id0 = is_array($ids) && ($ids[0] ?? null) instanceof PStr ? $ids[0]->v : '';
            $this->crypt = is_array($enc) ? PdfCrypt::open($enc, $id0) : null;
            if ($this->crypt === null) {
                $this->encrypted = true;
                return;
            }
        }
        foreach ($objStms as $num) {
            $o = $this->getRaw($num);
            if ($o instanceof PStream) $this->indexObjStm($num, $o);
        }
    }

    private function mergeTrailer(array $d): void
    {
        foreach (['Root', 'Encrypt', 'Info', 'ID'] as $k) {
            if (isset($d[$k])) $this->trailer[$k] = $d[$k];
        }
    }

    private function indexObjStm(int $num, PStream $st): void
    {
        $data = $this->streamData($st);
        if ($data === null) return;
        $n = (int) $this->resolve($st->dict['N'] ?? 0);
        $first = (int) $this->resolve($st->dict['First'] ?? 0);
        $head = substr($data, 0, $first);
        if (!preg_match_all('/\d+/', $head, $mm)) return;
        $nums = $mm[0];
        $entries = [];
        for ($i = 0; $i + 1 < count($nums) && $i / 2 < $n; $i += 2) {
            $entries[] = [(int) $nums[$i], $first + (int) $nums[$i + 1]];
        }
        $this->objStmCache[$num] = ['data' => $data, 'entries' => $entries];
        foreach ($entries as $idx => [$objNum, $off]) {
            if (!isset($this->offsets[$objNum])) $this->inStream[$objNum] = [$num, $idx];
        }
    }

    /* ---------------- object access ---------------- */

    public function resolve($v, int $depth = 0)
    {
        while ($v instanceof PRef && $depth++ < 32) $v = $this->get($v->num);
        return $v;
    }

    public function get(int $num)
    {
        if (array_key_exists($num, $this->cache)) return $this->cache[$num];
        $this->cache[$num] = null; // guards against reference loops
        $val = null;
        try {
            if (isset($this->offsets[$num])) {
                $val = $this->getRaw($num);
            } elseif (isset($this->inStream[$num])) {
                [$stm, $idx] = $this->inStream[$num];
                $os = $this->objStmCache[$stm];
                $pos = $os['entries'][$idx][1];
                $val = (new PdfLexer($os['data']))->parseValue($pos);
            }
        } catch (\Throwable $e) {
            $val = null;
        }
        return $this->cache[$num] = $val;
    }

    private function getRaw(int $num, bool $decrypt = true)
    {
        $off = $this->offsets[$num];
        if (!preg_match('/\G\d+\s+(\d+)\s+obj\b/', $this->s, $m, 0, $off)) return null;
        $gen = (int) $m[1];
        $val = $this->parseObjectAt($off + strlen($m[0]));
        if ($decrypt && $this->crypt !== null && $num !== $this->encryptNum) {
            $val = $this->crypt->decryptValue($val, $num, $gen);
        }
        return $val;
    }

    private function parseObjectAt(int $pos)
    {
        $lex = new PdfLexer($this->s);
        $val = $lex->parseValue($pos);
        // stream?
        if (is_array($val) && preg_match('/\G\s*stream\r?\n?/', $this->s, $sm, 0, $pos)) {
            $start = $pos + strlen($sm[0]);
            $len = $val['Length'] ?? null;
            if ($len instanceof PRef) {
                $l = $this->offsets[$len->num] ?? null;
                $len = null;
                if ($l !== null && preg_match('/\G\d+\s+\d+\s+obj\s*(\d+)/', $this->s, $lm, 0, $l)) $len = (int) $lm[1];
            }
            $raw = null;
            if (is_int($len) && $len >= 0 && $start + $len <= strlen($this->s)
                && preg_match('/\G\s*endstream/', $this->s, $em, 0, $start + $len)) {
                $raw = substr($this->s, $start, $len);
            } else {
                $end = strpos($this->s, 'endstream', $start);
                if ($end === false) return null;
                $raw = rtrim(substr($this->s, $start, $end - $start), "\r\n");
            }
            return new PStream($val, $raw);
        }
        return $val;
    }

    public function dict($v): array
    {
        $v = $this->resolve($v);
        if ($v instanceof PStream) return $v->dict;
        return is_array($v) ? $v : [];
    }

    /* ---------------- streams ---------------- */

    /** Decoded stream bytes, or null if a filter is unsupported/broken. Image codecs (DCT etc.) are left encoded. */
    public function streamData(PStream $st, ?string &$imageCodec = null): ?string
    {
        $imageCodec = null;
        $filters = $this->resolve($st->dict['Filter'] ?? []);
        $parms = $this->resolve($st->dict['DecodeParms'] ?? ($st->dict['DP'] ?? []));
        if (!is_array($filters)) $filters = [$filters];
        if (!is_array($parms)) $parms = [];
        elseif ($parms !== [] && !array_is_list($parms)) $parms = [$parms];
        $data = $st->raw;
        foreach (array_values($filters) as $i => $f) {
            $f = $this->resolve($f);
            $p = $this->dict($parms[$i] ?? []);
            switch ($f) {
                case '/FlateDecode': case '/Fl':
                    $out = @gzuncompress($data);
                    if ($out === false) $out = @gzinflate(substr($data, 2));
                    if ($out === false) $out = self::inflatePartial($data);
                    if ($out === null) return null;
                    $data = self::predictor($out, $p);
                    break;
                case '/ASCII85Decode': case '/A85':
                    $data = self::ascii85($data);
                    break;
                case '/ASCIIHexDecode': case '/AHx':
                    $h = preg_replace('/[^0-9A-Fa-f]/', '', strstr($data . '>', '>', true));
                    if (strlen($h) % 2) $h .= '0';
                    $data = (string) hex2bin($h);
                    break;
                case '/RunLengthDecode': case '/RL':
                    $data = self::runLength($data);
                    break;
                case '/LZWDecode': case '/LZW':
                    $data = self::predictor(self::lzw($data, (int) ($p['EarlyChange'] ?? 1)), $p);
                    break;
                case '/DCTDecode': case '/DCT': case '/JPXDecode': case '/JBIG2Decode': case '/CCITTFaxDecode': case '/CCF':
                    $imageCodec = $f;
                    return $data;
                case null:
                    break;
                default:
                    return null;
            }
        }
        return $data;
    }

    private static function inflatePartial(string $data): ?string
    {
        // damaged/truncated deflate data: recover what we can
        if (!function_exists('inflate_init')) return null;
        $ctx = @inflate_init(ZLIB_ENCODING_DEFLATE);
        if (!$ctx) return null;
        $out = @inflate_add($ctx, substr($data, 2), ZLIB_SYNC_FLUSH);
        return ($out === false || $out === '') ? null : $out;
    }

    private static function predictor(string $data, array $p): string
    {
        $pred = (int) ($p['Predictor'] ?? 1);
        if ($pred < 2) return $data;
        $colors = (int) ($p['Colors'] ?? 1);
        $bpc = (int) ($p['BitsPerComponent'] ?? 8);
        $cols = (int) ($p['Columns'] ?? 1);
        $bpp = max(1, intdiv($colors * $bpc + 7, 8));
        $rowLen = intdiv($cols * $colors * $bpc + 7, 8);
        if ($pred === 2) { // TIFF predictor (8-bit only)
            if ($bpc !== 8) return $data;
            $out = '';
            for ($r = 0, $n = strlen($data); $r < $n; $r += $rowLen) {
                $row = substr($data, $r, $rowLen);
                for ($i = $bpp, $l = strlen($row); $i < $l; $i++) $row[$i] = chr((ord($row[$i]) + ord($row[$i - $bpp])) & 255);
                $out .= $row;
            }
            return $out;
        }
        // PNG predictors: each row starts with a filter-type byte
        $out = [];
        $prev = str_repeat("\0", $rowLen);
        for ($r = 0, $n = strlen($data); $r + 1 <= $n; $r += $rowLen + 1) {
            $type = ord($data[$r]);
            $row = str_pad(substr($data, $r + 1, $rowLen), $rowLen, "\0");
            switch ($type) {
                case 0: break;
                case 1: for ($i = $bpp; $i < $rowLen; $i++) $row[$i] = chr((ord($row[$i]) + ord($row[$i - $bpp])) & 255); break;
                case 2: for ($i = 0; $i < $rowLen; $i++) $row[$i] = chr((ord($row[$i]) + ord($prev[$i])) & 255); break;
                case 3:
                    for ($i = 0; $i < $rowLen; $i++) {
                        $a = $i >= $bpp ? ord($row[$i - $bpp]) : 0;
                        $row[$i] = chr((ord($row[$i]) + (($a + ord($prev[$i])) >> 1)) & 255);
                    }
                    break;
                case 4:
                    for ($i = 0; $i < $rowLen; $i++) {
                        $a = $i >= $bpp ? ord($row[$i - $bpp]) : 0;
                        $b = ord($prev[$i]);
                        $c = $i >= $bpp ? ord($prev[$i - $bpp]) : 0;
                        $pp = $a + $b - $c;
                        $pa = abs($pp - $a); $pb = abs($pp - $b); $pc = abs($pp - $c);
                        $pr = ($pa <= $pb && $pa <= $pc) ? $a : ($pb <= $pc ? $b : $c);
                        $row[$i] = chr((ord($row[$i]) + $pr) & 255);
                    }
                    break;
            }
            $out[] = $row;
            $prev = $row;
        }
        return implode('', $out);
    }

    private static function ascii85(string $d): string
    {
        $d = preg_replace('/\s+/', '', $d);
        if (str_starts_with($d, '<~')) $d = substr($d, 2);
        $end = strpos($d, '~>');
        if ($end !== false) $d = substr($d, 0, $end);
        $out = '';
        $tuple = 0;
        $cnt = 0;
        for ($i = 0, $n = strlen($d); $i < $n; $i++) {
            $c = $d[$i];
            if ($c === 'z' && $cnt === 0) { $out .= "\0\0\0\0"; continue; }
            $v = ord($c) - 33;
            if ($v < 0 || $v > 84) continue;
            $tuple = $tuple * 85 + $v;
            if (++$cnt === 5) {
                $out .= pack('N', $tuple);
                $tuple = 0;
                $cnt = 0;
            }
        }
        if ($cnt > 1) {
            for ($i = $cnt; $i < 5; $i++) $tuple = $tuple * 85 + 84;
            $out .= substr(pack('N', $tuple), 0, $cnt - 1);
        }
        return $out;
    }

    private static function runLength(string $d): string
    {
        $out = '';
        $i = 0;
        $n = strlen($d);
        while ($i < $n) {
            $len = ord($d[$i++]);
            if ($len === 128) break;
            if ($len < 128) { $out .= substr($d, $i, $len + 1); $i += $len + 1; }
            else { $out .= str_repeat($d[$i] ?? "\0", 257 - $len); $i++; }
        }
        return $out;
    }

    private static function lzw(string $d, int $early): string
    {
        $dict = [];
        for ($i = 0; $i < 256; $i++) $dict[$i] = chr($i);
        $next = 258;
        $bits = 9;
        $out = '';
        $prev = null;
        $buf = 0;
        $nb = 0;
        for ($i = 0, $n = strlen($d); $i < $n; $i++) {
            $buf = ($buf << 8) | ord($d[$i]);
            $nb += 8;
            while ($nb >= $bits) {
                $code = ($buf >> ($nb - $bits)) & ((1 << $bits) - 1);
                $nb -= $bits;
                if ($code === 256) { $next = 258; $bits = 9; $prev = null; continue; }
                if ($code === 257) return $out;
                if ($prev === null) { $entry = $dict[$code] ?? ''; }
                elseif (isset($dict[$code]) && $code < $next) { $entry = $dict[$code]; $dict[$next++] = $prev . $entry[0]; }
                else { $entry = $prev . $prev[0]; $dict[$next++] = $entry; }
                $out .= $entry;
                $prev = $entry;
                if ($next + $early >= (1 << $bits) && $bits < 12) $bits++;
            }
            $buf &= (1 << $nb) - 1;
        }
        return $out;
    }

    /* ---------------- page tree ---------------- */

    /** @return list<array{dict:array, resources:array, box:array}> */
    public function pages(int $limit): array
    {
        $root = $this->dict($this->trailer['Root'] ?? null);
        $pagesRoot = $root['Pages'] ?? null;
        if ($pagesRoot === null) {
            // no usable catalog: fall back to every /Type /Page object found
            return [];
        }
        $out = [];
        $seen = [];
        $walk = function ($node, array $inh, int $depth) use (&$walk, &$out, &$seen, $limit) {
            if ($depth > 64 || count($out) > $limit) return;
            if ($node instanceof PRef) {
                if (isset($seen[$node->num])) return;
                $seen[$node->num] = true;
            }
            $d = $this->dict($node);
            if (!$d) return;
            foreach (['Resources', 'MediaBox', 'CropBox'] as $k) if (isset($d[$k])) $inh[$k] = $d[$k];
            $kids = $this->resolve($d['Kids'] ?? null);
            $type = $d['Type'] ?? null;
            if (is_array($kids) && $type !== '/Page') {
                foreach ($kids as $k) $walk($k, $inh, $depth + 1);
                return;
            }
            $media = $this->numArray($inh['MediaBox'] ?? [0, 0, 612, 792]);
            $crop = isset($inh['CropBox']) ? $this->numArray($inh['CropBox']) : $media;
            $box = self::normBox(count($crop) === 4 ? $crop : $media);
            $mb = self::normBox(count($media) === 4 ? $media : [0, 0, 612, 792]);
            $box = [max($box[0], $mb[0]), max($box[1], $mb[1]), min($box[2], $mb[2]), min($box[3], $mb[3])];
            if ($box[2] <= $box[0] || $box[3] <= $box[1]) $box = $mb;
            $out[] = ['dict' => $d, 'resources' => $this->dict($inh['Resources'] ?? []), 'box' => $box];
        };
        $walk($pagesRoot, [], 0);
        return $out;
    }

    /** Count pages via the tree without analysing them. */
    public function pageCount(): int
    {
        $root = $this->dict($this->trailer['Root'] ?? null);
        $p = $this->dict($root['Pages'] ?? null);
        $c = $this->resolve($p['Count'] ?? null);
        return is_int($c) ? $c : -1;
    }

    public function numArray($v): array
    {
        $v = $this->resolve($v);
        if (!is_array($v)) return [];
        $o = [];
        foreach ($v as $x) {
            $x = $this->resolve($x);
            $o[] = is_numeric($x) ? (float) $x : 0.0;
        }
        return $o;
    }

    public static function normBox(array $b): array
    {
        return [min($b[0], $b[2]), min($b[1], $b[3]), max($b[0], $b[2]), max($b[1], $b[3])];
    }

    /** Raw content bytes of a page (all /Contents parts joined). */
    public function pageContent(array $page): string
    {
        $c = $this->resolve($page['dict']['Contents'] ?? null);
        $parts = [];
        if ($c instanceof PStream) $c = [$c];
        if (is_array($c)) {
            foreach ($c as $x) {
                $x = $this->resolve($x);
                if ($x instanceof PStream) {
                    $d = $this->streamData($x);
                    if ($d !== null) $parts[] = $d;
                }
            }
        }
        return implode("\n", $parts);
    }
}

/* ======================================================================== */

/** Tokenizer/parser for PDF object syntax. */
final class PdfLexer
{
    public function __construct(private string $s) {}

    private function skipWs(int &$p): void
    {
        $n = strlen($this->s);
        while ($p < $n) {
            $c = $this->s[$p];
            if ($c === '%') {
                while ($p < $n && $this->s[$p] !== "\n" && $this->s[$p] !== "\r") $p++;
            } elseif (strpos(" \t\r\n\f\0", $c) !== false) {
                $p++;
            } else {
                break;
            }
        }
    }

    public function parseValue(int &$p, int $depth = 0)
    {
        if ($depth > 200) throw new \RuntimeException('nesting too deep');
        $this->skipWs($p);
        $s = $this->s;
        $c = $s[$p] ?? '';
        if ($c === '') throw new \RuntimeException('eof');
        if ($c === '<' && ($s[$p + 1] ?? '') === '<') {
            $p += 2;
            $d = [];
            while (true) {
                $this->skipWs($p);
                if (($s[$p] ?? '') === '>' && ($s[$p + 1] ?? '') === '>') { $p += 2; break; }
                if (!isset($s[$p])) throw new \RuntimeException('eof in dict');
                $k = $this->parseValue($p, $depth + 1);
                if (!is_string($k) || ($k[0] ?? '') !== '/') continue; // junk key: skip
                $this->skipWs($p);
                if (($s[$p] ?? '') === '>' && ($s[$p + 1] ?? '') === '>') { $d[substr($k, 1)] = null; continue; }
                $d[substr($k, 1)] = $this->parseValue($p, $depth + 1);
            }
            return $d;
        }
        if ($c === '[') {
            $p++;
            $a = [];
            while (true) {
                $this->skipWs($p);
                if (($s[$p] ?? '') === ']') { $p++; break; }
                if (!isset($s[$p])) throw new \RuntimeException('eof in array');
                $a[] = $this->parseValue($p, $depth + 1);
            }
            return $a;
        }
        if ($c === '(') return new PStr(self::literal($s, $p));
        if ($c === '<') {
            $e = strpos($s, '>', $p);
            if ($e === false) throw new \RuntimeException('bad hex');
            $h = preg_replace('/[^0-9A-Fa-f]/', '', substr($s, $p + 1, $e - $p - 1));
            $p = $e + 1;
            if (strlen($h) % 2) $h .= '0';
            return new PStr((string) hex2bin($h));
        }
        if ($c === '/') {
            preg_match('/\G\/[^\s\/\[\]()<>{}%]*/', $s, $m, 0, $p);
            $p += strlen($m[0]);
            return self::name($m[0]);
        }
        if (preg_match('/\G[+-]?(?:\d+\.?\d*|\.\d+)/', $s, $m, 0, $p)) {
            $p += strlen($m[0]);
            if (preg_match('/\G\s+(\d+)\s+R(?![A-Za-z0-9])/', $s, $r, 0, $p) && ctype_digit($m[0])) {
                $p += strlen($r[0]);
                return new PRef((int) $m[0], (int) $r[1]);
            }
            return (strpbrk($m[0], '.') !== false) ? (float) $m[0] : (int) $m[0];
        }
        if (preg_match('/\G[A-Za-z]+/', $s, $m, 0, $p)) {
            $p += strlen($m[0]);
            if ($m[0] === 'true') return true;
            if ($m[0] === 'false') return false;
            return null; // null, or a stray keyword
        }
        $p++;
        return null;
    }

    public static function name(string $raw): string
    {
        if (strpos($raw, '#') === false) return $raw;
        return preg_replace_callback('/#([0-9A-Fa-f]{2})/', fn($m) => chr(hexdec($m[1])), $raw);
    }

    /** Decode a literal string starting at $p (which points at "("). */
    public static function literal(string $s, int &$p): string
    {
        $p++;
        $depth = 1;
        $out = '';
        $n = strlen($s);
        while ($p < $n) {
            $c = $s[$p++];
            if ($c === '\\') {
                $d = $s[$p++] ?? '';
                switch ($d) {
                    case 'n': $out .= "\n"; break;
                    case 'r': $out .= "\r"; break;
                    case 't': $out .= "\t"; break;
                    case 'b': $out .= "\x08"; break;
                    case 'f': $out .= "\f"; break;
                    case "\r": if (($s[$p] ?? '') === "\n") $p++; break;
                    case "\n": break;
                    default:
                        if ($d >= '0' && $d <= '7') {
                            $o = $d;
                            for ($k = 0; $k < 2 && ($s[$p] ?? '') >= '0' && ($s[$p] ?? '') <= '7'; $k++) $o .= $s[$p++];
                            $out .= chr(octdec($o) & 255);
                        } else {
                            $out .= $d;
                        }
                }
            } elseif ($c === '(') {
                $depth++;
                $out .= $c;
            } elseif ($c === ')') {
                if (--$depth === 0) break;
                $out .= $c;
            } else {
                $out .= $c;
            }
        }
        return $out;
    }
}
