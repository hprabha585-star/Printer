<?php
/*
 * PDF Standard Security Handler — decryption with the EMPTY user password only.
 *
 * Many PDFs (bank statements, e-tickets, forms) are "protected" only against
 * editing/copying: they open without a password. Those are decrypted here so they
 * can be checked and printed. A PDF that needs a password to OPEN is refused with
 * a friendly message (we never try to guess passwords).
 *
 * Supports revisions 2–4 (RC4 40/128-bit, AES-128) and 5–6 (AES-256).
 */
declare(strict_types=1);

final class PdfCrypt
{
    private const PAD = "\x28\xBF\x4E\x5E\x4E\x75\x8A\x41\x64\x00\x4E\x56\xFF\xFA\x01\x08\x2E\x2E\x00\xB6\xD0\x68\x3E\x80\x2F\x0C\xA9\xFE\x64\x53\x69\x7A";

    private string $key = '';
    private string $stmMethod = 'rc4'; // rc4 | aes128 | aes256 | none
    private string $strMethod = 'rc4';

    /** @return PdfCrypt|null null when the user password is not empty (cannot open) */
    public static function open(array $enc, string $id0): ?self
    {
        $c = new self();
        $filter = $enc['Filter'] ?? '/Standard';
        if ($filter !== '/Standard') return null;
        $v = (int) ($enc['V'] ?? 0);
        $r = (int) ($enc['R'] ?? 2);
        $o = self::str($enc['O'] ?? '');
        $u = self::str($enc['U'] ?? '');
        $p = (int) ($enc['P'] ?? 0);
        $encMeta = !array_key_exists('EncryptMetadata', $enc) || $enc['EncryptMetadata'] !== false;

        // crypt filters (V4/V5)
        if ($v >= 4) {
            $cf = is_array($enc['CF'] ?? null) ? $enc['CF'] : [];
            $c->stmMethod = self::cfMethod($cf, $enc['StmF'] ?? '/Identity');
            $c->strMethod = self::cfMethod($cf, $enc['StrF'] ?? '/Identity');
        }

        if ($r >= 5) {
            $ue = self::str($enc['UE'] ?? '');
            if (strlen($u) < 48 || strlen($ue) < 32) return null;
            $valSalt = substr($u, 32, 8);
            $keySalt = substr($u, 40, 8);
            $hash = $r === 5 ? hash('sha256', $valSalt, true) : self::hash2B('', $valSalt, '');
            if (!hash_equals(substr($u, 0, 32), substr($hash, 0, 32))) return null; // needs a password
            $ik = $r === 5 ? hash('sha256', $keySalt, true) : self::hash2B('', $keySalt, '');
            $key = openssl_decrypt(substr($ue, 0, 32), 'aes-256-cbc', substr($ik, 0, 32), OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, str_repeat("\0", 16));
            if ($key === false) return null;
            $c->key = $key;
            if ($v < 4) $c->stmMethod = $c->strMethod = 'aes256';
            return $c;
        }

        // revisions 2–4: Algorithm 2 with the empty password
        $len = $r === 2 ? 5 : max(5, min(16, intdiv((int) ($enc['Length'] ?? 40), 8)));
        $h = md5(self::PAD . substr($o, 0, 32) . pack('V', $p & 0xFFFFFFFF) . $id0 . ($r >= 4 && !$encMeta ? "\xFF\xFF\xFF\xFF" : ''), true);
        if ($r >= 3) for ($i = 0; $i < 50; $i++) $h = md5(substr($h, 0, $len), true);
        $key = substr($h, 0, $len);
        // check the empty user password (Algorithms 4/5)
        if ($r === 2) {
            $ok = self::rc4($key, self::PAD) === substr($u, 0, 32);
        } else {
            $x = self::rc4($key, md5(self::PAD . $id0, true));
            for ($i = 1; $i <= 19; $i++) {
                $k2 = '';
                for ($j = 0; $j < $len; $j++) $k2 .= chr(ord($key[$j]) ^ $i);
                $x = self::rc4($k2, $x);
            }
            $ok = substr($x, 0, 16) === substr($u, 0, 16);
        }
        if (!$ok) return null;
        $c->key = $key;
        return $c;
    }

    private static function str($v): string
    {
        return $v instanceof PStr ? $v->v : (is_string($v) ? $v : '');
    }

    private static function cfMethod(array $cf, $name): string
    {
        if ($name === '/Identity' || !is_string($name)) return 'none';
        $f = $cf[substr($name, 1)] ?? null;
        $m = is_array($f) ? ($f['CFM'] ?? '/V2') : '/V2';
        return ['/V2' => 'rc4', '/AESV2' => 'aes128', '/AESV3' => 'aes256', '/None' => 'none'][$m] ?? 'rc4';
    }

    /** ISO 32000-2 Algorithm 2.B (revision 6 hash). */
    private static function hash2B(string $pw, string $salt, string $udata): string
    {
        $k = hash('sha256', $pw . $salt . $udata, true);
        for ($i = 0; ; $i++) {
            $k1 = str_repeat($pw . $k . $udata, 64);
            $e = openssl_encrypt($k1, 'aes-128-cbc', substr($k, 0, 16), OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, substr($k, 16, 16));
            $sum = 0;
            for ($j = 0; $j < 16; $j++) $sum += ord($e[$j]);
            $k = hash(['sha256', 'sha384', 'sha512'][$sum % 3], $e, true);
            if ($i >= 63 && ord($e[strlen($e) - 1]) <= $i - 31) break;
        }
        return substr($k, 0, 32);
    }

    public static function rc4(string $key, string $data): string
    {
        if (in_array('rc4', openssl_get_cipher_methods(), true)) {
            $out = @openssl_encrypt($data, 'rc4', $key, OPENSSL_RAW_DATA);
            if ($out !== false) return $out;
        }
        $s = range(0, 255);
        $kl = strlen($key);
        for ($i = 0, $j = 0; $i < 256; $i++) {
            $j = ($j + $s[$i] + ord($key[$i % $kl])) & 255;
            [$s[$i], $s[$j]] = [$s[$j], $s[$i]];
        }
        $out = '';
        for ($i = 0, $j = 0, $k = 0, $n = strlen($data); $k < $n; $k++) {
            $i = ($i + 1) & 255;
            $j = ($j + $s[$i]) & 255;
            [$s[$i], $s[$j]] = [$s[$j], $s[$i]];
            $out .= chr(ord($data[$k]) ^ $s[($s[$i] + $s[$j]) & 255]);
        }
        return $out;
    }

    private function decrypt(string $data, int $num, int $gen, string $method): string
    {
        if ($method === 'none' || $data === '') return $data;
        if ($method === 'aes256') {
            $key = $this->key;
        } else {
            $k = md5($this->key . substr(pack('V', $num), 0, 3) . substr(pack('V', $gen), 0, 2) . ($method === 'aes128' ? 'sAlT' : ''), true);
            $key = substr($k, 0, min(16, strlen($this->key) + 5));
        }
        if ($method === 'rc4') return self::rc4($key, $data);
        if (strlen($data) < 32) return '';
        $out = openssl_decrypt(substr($data, 16), $method === 'aes256' ? 'aes-256-cbc' : 'aes-128-cbc', $key, OPENSSL_RAW_DATA, substr($data, 0, 16));
        if ($out === false) { // bad padding: decrypt without removing it
            $out = (string) openssl_decrypt(substr($data, 16), $method === 'aes256' ? 'aes-256-cbc' : 'aes-128-cbc', $key, OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, substr($data, 0, 16));
        }
        return $out;
    }

    /** Decrypt every string and the stream data inside a top-level object. */
    public function decryptValue($v, int $num, int $gen, int $depth = 0)
    {
        if ($depth > 50) return $v;
        if ($v instanceof PStr) return new PStr($this->decrypt($v->v, $num, $gen, $this->strMethod));
        if ($v instanceof PStream) {
            $dict = $this->decryptValue($v->dict, $num, $gen, $depth + 1);
            $type = $v->dict['Type'] ?? null;
            if ($type === '/XRef') return new PStream($dict, $v->raw); // cross-reference streams are never encrypted
            return new PStream($dict, $this->decrypt($v->raw, $num, $gen, $this->stmMethod));
        }
        if (is_array($v)) {
            foreach ($v as $k => $x) $v[$k] = $this->decryptValue($x, $num, $gen, $depth + 1);
        }
        return $v;
    }
}
