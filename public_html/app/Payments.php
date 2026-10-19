<?php
/*
 * Payment-provider layer.
 *
 * Modes (owner chooses in Settings):
 *   "utr"     (default, no fees) – customer pays by UPI and types the 12-digit UTR.
 *   "gateway" – a payment gateway confirms payment through a signed webhook.
 *               No real gateway adapter is installed yet (the provider is to be chosen);
 *               see app/payments/README.md. If "gateway" is selected without an adapter,
 *               the site keeps working in UTR mode and the dashboard shows a warning.
 * Cash at the counter works in both modes.
 *
 * Adapter interface (a class in app/payments/):
 *   name(): string                    isConfigured(): bool          info(): array{label, feeNote}
 *   createCheckout(token, amountPaise, description, returnUrl): array{gatewayRef, checkout{type,url,...}}
 *   verifyWebhook(rawBody, headers): bool   (signature, constant-time)
 *   parseWebhook(rawBody): array{eventId, type: paid|failed|expired|refunded|ignore, gatewayRef, amountPaise}
 *   fetchStatus(gatewayRef): ?array (same shape; used to reconcile when the status page polls)
 */
declare(strict_types=1);

interface GatewayAdapter
{
    public function name(): string;
    public function isConfigured(): bool;
    public function info(): array;
    public function createCheckout(string $token, int $amountPaise, string $description, string $returnUrl): array;
    public function verifyWebhook(string $raw, array $headers): bool;
    public function parseWebhook(string $raw): array;
    public function fetchStatus(string $gatewayRef): ?array;
}

final class Payments
{
    /** @return array<string, GatewayAdapter> */
    private static function adapters(): array
    {
        $a = [];
        // Real providers are registered here once chosen, e.g.:
        //   require_once __DIR__ . '/payments/RazorpayGateway.php'; $a['razorpay'] = new RazorpayGateway();
        if (Config::isTest()) {
            require_once __DIR__ . '/payments/MockGateway.php';
            $a['mock'] = new MockGateway();
        }
        return $a;
    }

    public static function adapter(): ?GatewayAdapter
    {
        $a = self::adapters()[strtolower((string) Config::get('PAYMENT_GATEWAY'))] ?? null;
        return $a && $a->isConfigured() ? $a : null;
    }

    public static function effectiveMode(array $s): string
    {
        return ($s['payment_mode'] ?? 'utr') === 'gateway' && self::adapter() ? 'gateway' : 'utr';
    }

    public static function gatewayInfo(): array
    {
        $a = self::adapter();
        return [
            'configured' => (bool) $a,
            'provider' => $a ? $a->name() : (Config::get('PAYMENT_GATEWAY') ?: null),
            'label' => $a ? $a->info()['label'] : null,
            'note' => $a ? $a->info()['feeNote'] : 'No payment gateway is set up yet. UTR mode is used. (A developer adds the chosen gateway — see the README.)',
        ];
    }
}
