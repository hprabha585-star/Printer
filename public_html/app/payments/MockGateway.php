<?php
/*
 * MOCK gateway adapter — used ONLY by the automated tests (APP_ENV=test).
 * Behaves like a real gateway sandbox: references, HMAC-SHA256-signed webhooks
 * over the raw body, and a status lookup. It is the template for a real adapter.
 * Its "gateway side" state lives in storage/mock-gateway.json.
 */
declare(strict_types=1);

final class MockGateway implements GatewayAdapter
{
    public function name(): string { return 'mock'; }
    public function isConfigured(): bool { return (string) Config::get('GATEWAY_WEBHOOK_SECRET') !== ''; }
    public function info(): array { return ['label' => 'Test gateway', 'feeNote' => 'Test only']; }

    private function file(): string { return Config::storage() . '/mock-gateway.json'; }
    private function load(): array { return json_decode((string) @file_get_contents($this->file()), true) ?: []; }
    private function save(array $d): void { file_put_contents($this->file(), json_encode($d), LOCK_EX); }

    public function createCheckout(string $token, int $amountPaise, string $description, string $returnUrl): array
    {
        $ref = 'mock_' . $token . '_' . bin2hex(random_bytes(4));
        $d = $this->load();
        $d[$ref] = ['type' => 'created', 'amountPaise' => $amountPaise];
        $this->save($d);
        return ['gatewayRef' => $ref, 'checkout' => ['type' => 'redirect', 'url' => '/mock-pay?ref=' . $ref]];
    }

    public function verifyWebhook(string $raw, array $headers): bool
    {
        $sig = (string) ($headers['x-mock-signature'] ?? '');
        return hash_equals(hash_hmac('sha256', $raw, (string) Config::get('GATEWAY_WEBHOOK_SECRET')), $sig);
    }

    public function parseWebhook(string $raw): array
    {
        $e = json_decode($raw, true);
        if (!is_array($e)) throw new \RuntimeException('bad payload');
        if (in_array($e['type'] ?? '', ['paid', 'refunded', 'failed'], true)) {
            $d = $this->load();
            $d[$e['ref']] = ['type' => $e['type'], 'amountPaise' => $e['amount'] ?? 0];
            $this->save($d);
        }
        return ['eventId' => $e['id'] ?? null, 'type' => $e['type'] ?? 'ignore', 'gatewayRef' => $e['ref'] ?? null, 'amountPaise' => $e['amount'] ?? null];
    }

    public function fetchStatus(string $gatewayRef): ?array
    {
        $s = $this->load()[$gatewayRef] ?? null;
        if (!$s) return null;
        return ['type' => $s['type'] === 'created' ? 'ignore' : $s['type'], 'gatewayRef' => $gatewayRef, 'amountPaise' => $s['amountPaise']];
    }
}
