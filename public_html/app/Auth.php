<?php
/*
 * Owner authentication.
 *  - First sign-in uses OWNER_MASTER_KEY. The owner then sets a username + password.
 *    The master key keeps working as a recovery path.
 *  - A successful login returns a signed token sent back in the "X-Owner-Key" header.
 *  - Changing the login details invalidates all old dashboard sessions.
 *  - Shop computers (Print Connector) get their own long-lived token.
 */
declare(strict_types=1);

final class Auth
{
    private const SESSION_DAYS = 30;
    private const CONNECTOR_DAYS = 3650;

    private static function secret(): string
    {
        return 'owner-token:' . (string) Config::get('OWNER_MASTER_KEY');
    }

    public static function isMasterKey(string $key): bool
    {
        $mk = (string) Config::get('OWNER_MASTER_KEY');
        return $mk !== '' && $key !== '' && hash_equals($mk, $key);
    }

    private static function b64(string $s): string
    {
        return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    }

    private static function sign(array $payload): string
    {
        $body = self::b64(json_encode($payload));
        return $body . '.' . self::b64(hash_hmac('sha256', $body, self::secret(), true));
    }

    public static function verify(string $token): ?array
    {
        if ($token === '' || strpos($token, '.') === false || (string) Config::get('OWNER_MASTER_KEY') === '') return null;
        [$body, $sig] = explode('.', $token, 2);
        if (!hash_equals(self::b64(hash_hmac('sha256', $body, self::secret(), true)), $sig)) return null;
        $p = json_decode((string) base64_decode(strtr($body, '-_', '+/')), true);
        if (!is_array($p) || ($p['exp'] ?? 0) < time() * 1000) return null;
        return $p;
    }

    private static function sessionVersion(): int
    {
        $r = Db::one('SELECT session_version FROM settings WHERE id = 1');
        return $r ? (int) $r['session_version'] : 1;
    }

    public static function ownerToken(): string
    {
        return self::sign(['s' => 'owner', 'v' => self::sessionVersion(), 'exp' => (time() + self::SESSION_DAYS * 86400) * 1000]);
    }

    public static function connectorToken(): string
    {
        return self::sign(['s' => 'connector', 'exp' => (time() + self::CONNECTOR_DAYS * 86400) * 1000]);
    }

    public static function requireOwner(): void
    {
        $key = Http::header('X-Owner-Key');
        if (self::isMasterKey($key)) return;
        $p = self::verify($key);
        if (!$p || ($p['s'] ?? '') !== 'owner') throw new UserError(401, 'Please sign in again.');
        if ((int) ($p['v'] ?? 0) !== self::sessionVersion()) {
            throw new UserError(401, 'Your login details were changed. Please sign in again.');
        }
    }

    public static function requireConnector(): void
    {
        $key = Http::header('X-Owner-Key');
        if (self::isMasterKey($key)) return;
        $p = self::verify($key);
        if ($p && in_array($p['s'] ?? '', ['connector', 'owner'], true)) return;
        throw new UserError(401, 'This computer is not connected. Enter the shop password again.');
    }
}
