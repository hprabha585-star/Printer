<?php
/*
 * All API routes. URLs and JSON are identical to the earlier Node.js version,
 * so the customer page, dashboard and Print Connector are unchanged.
 * Literal routes are registered before ":param" routes, so they are never shadowed.
 */
declare(strict_types=1);

final class Routes
{
    private array $routes = [];

    private function add(string $method, string $pattern, callable $fn): void
    {
        $re = '#^' . preg_replace('#\\\\\{(\w+)\\\\\}#', '(?P<$1>[^/]+)', preg_quote($pattern, '#')) . '$#';
        $this->routes[] = [$method, $re, $fn];
    }

    public function dispatch(string $method, string $path): void
    {
        $pathMatched = false;
        foreach ($this->routes as [$m, $re, $fn]) {
            if (!preg_match($re, $path, $mm)) continue;
            $pathMatched = true;
            if ($m !== $method) continue;
            $params = array_map('rawurldecode', array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY));
            $fn($params);
            return;
        }
        throw new UserError($pathMatched ? 405 : 404, $pathMatched ? 'Method not allowed' : 'Not found');
    }

    public function __construct()
    {
        $this->webhook();
        $this->connector();
        $this->owner();
        $this->public();
    }

    /* ======================= public (customer) ======================= */
    private function public(): void
    {
        $this->add('GET', '/api/settings', function () {
            $s = Settings::get();
            Http::json(Settings::publicView($s) + [
                'max_upload_mb' => (int) floor(Config::maxUploadBytes() / 1048576),
                'max_pages' => Config::int('MAX_PAGES'),
            ]);
        });

        $this->add('POST', '/api/analyse', function () {
            Http::rateLimit('analyse', Config::int('ANALYSE_RATE_LIMIT'), 600, 'You have uploaded a lot of files. Please wait a few minutes and try again.');
            $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
            // bigger than PHP's post_max_size: PHP silently drops the whole upload
            if ($len > Config::maxUploadBytes() + 64 * 1024 || $len > Config::iniBytes('post_max_size')) {
                throw new UserError(413, 'This file is too big. The limit is ' . (int) floor(Config::maxUploadBytes() / 1048576) . ' MB.', 'too_big');
            }
            $f = $_FILES['file'] ?? null;
            if (!$f || ($f['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) throw new UserError(400, 'Please choose a file.', 'no_file');
            if (in_array($f['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) || $f['size'] > Config::maxUploadBytes()) {
                throw new UserError(413, 'This file is too big. The limit is ' . (int) floor(Config::maxUploadBytes() / 1048576) . ' MB.', 'too_big');
            }
            if ($f['error'] !== UPLOAD_ERR_OK) throw new UserError(400, 'Upload failed. Please try again.', 'upload');
            Upload::analyse($f);
        });

        $this->add('POST', '/api/orders', function () {
            Http::json(Orders::create(Http::body()['items'] ?? null));
        });
        $this->add('GET', '/api/orders/{token}', function ($p) {
            Http::json(Orders::status($p['token'], (string) ($_GET['k'] ?? '')));
        });
        $this->add('POST', '/api/orders/{token}/utr', function ($p) {
            $b = Http::body();
            Http::json(Orders::submitUtr($p['token'], (string) ($b['k'] ?? ''), $b['utr'] ?? ''));
        });
        $this->add('POST', '/api/orders/{token}/cash', function ($p) {
            Http::json(Orders::chooseCash($p['token'], (string) (Http::body()['k'] ?? '')));
        });
        $this->add('POST', '/api/orders/{token}/gateway', function ($p) {
            Http::json(Orders::startGateway($p['token'], (string) (Http::body()['k'] ?? '')));
        });
    }

    /* ======================= payment webhooks ======================= */
    private function webhook(): void
    {
        $this->add('POST', '/api/payments/webhook/{provider}', function ($p) {
            $a = Payments::adapter();
            if (!$a || $a->name() !== $p['provider']) throw new UserError(404, 'Unknown payment provider');
            $raw = Http::raw();
            if (!$a->verifyWebhook($raw, Http::headers())) throw new UserError(401, 'Invalid signature');
            try {
                $evt = $a->parseWebhook($raw);
            } catch (\Throwable $e) {
                throw new UserError(400, 'Bad payload');
            }
            $r = Orders::applyGatewayEvent($a->name(), $evt, 'webhook');
            Http::json(['received' => true, 'outcome' => $r['outcome']]);
        });
    }

    /* ======================= owner dashboard ======================= */
    private function owner(): void
    {
        $this->add('POST', '/api/owner/login', function () {
            Http::rateLimit('login', 20, 900, 'Too many sign-in attempts. Please wait 15 minutes.');
            $b = Http::body();
            $s = Settings::get();
            $master = (string) ($b['master_key'] ?? '');
            $ok = false;
            if ($master !== '') {
                $ok = Auth::isMasterKey($master);
            } elseif (!empty($b['username']) && !empty($b['password']) && $s['owner_username']) {
                $ok = strtolower(trim((string) $b['username'])) === strtolower((string) $s['owner_username'])
                    && password_verify((string) $b['password'], (string) $s['owner_password_hash']);
            }
            if (!$ok) {
                $msg = $master !== '' ? 'That master key is not correct.'
                    : (!$s['owner_username'] ? 'No login has been set up yet. Sign in with the master key first.' : 'Wrong username or password.');
                throw new UserError(401, $msg, 'bad_login');
            }
            Http::json(['token' => Auth::ownerToken(), 'needs_setup' => !$s['owner_username'], 'username' => $s['owner_username'] ?: null]);
        });

        $owner = function (callable $fn) {
            return function ($p) use ($fn) {
                Auth::requireOwner();
                $fn($p);
            };
        };

        $this->add('GET', '/api/owner/me', $owner(function () {
            $s = Settings::get();
            Http::json(['username' => $s['owner_username'] ?: null, 'needs_setup' => !$s['owner_username']]);
        }));
        $this->add('POST', '/api/owner/credentials', $owner(function () {
            $b = Http::body();
            $u = trim((string) ($b['username'] ?? ''));
            $pw = (string) ($b['password'] ?? '');
            if (!preg_match('/^[a-zA-Z0-9._@-]{3,60}$/', $u)) throw new UserError(400, 'Username: 3–60 letters or numbers (no spaces).');
            if (strlen($pw) < 8) throw new UserError(400, 'Password must be at least 8 characters.');
            Db::q('UPDATE settings SET owner_username = ?, owner_password_hash = ?, session_version = session_version + 1, updated_at = UTC_TIMESTAMP() WHERE id = 1',
                [$u, password_hash($pw, PASSWORD_DEFAULT)]);
            Http::json(['ok' => true, 'token' => Auth::ownerToken(), 'username' => $u]);
        }));
        $this->add('GET', '/api/owner/settings', $owner(fn() => Http::json(Settings::ownerView(Settings::get()))));
        $this->add('PUT', '/api/owner/settings', $owner(fn() => Http::json(Settings::ownerView(Settings::update(Http::body())))));
        $this->add('GET', '/api/owner/printers', $owner(fn() => Http::json(Owner::printers())));
        $this->add('PUT', '/api/owner/printers', $owner(fn() => Http::json(Owner::savePrinters(Http::body()))));
        $this->add('GET', '/api/owner/connectors', $owner(fn() => Http::json(Owner::connectors())));
        $this->add('DELETE', '/api/owner/connectors/{name}', $owner(function ($p) {
            Db::q('DELETE FROM connectors WHERE computer_name = ?', [$p['name']]);
            Http::json(['ok' => true]);
        }));
        $this->add('GET', '/api/owner/stats', $owner(function () {
            Cleanup::maybeRun();
            Http::json(Owner::stats());
        }));
        $this->add('GET', '/api/owner/attention', $owner(fn() => Http::json(Owner::attention())));
        $this->add('GET', '/api/owner/jobs', $owner(fn() => Http::json(Owner::jobs((int) ($_GET['limit'] ?? 100)))));
        $this->add('GET', '/api/owner/jobs/{id}/file', $owner(function ($p) {
            $j = Db::one('SELECT file_path, file_name, file_kind FROM jobs WHERE id = ?', [(int) $p['id']]);
            if (!$j || !$j['file_path']) throw new UserError(404, 'This file has already been deleted from the server.');
            Http::sendFile(Config::storage('uploads') . '/' . basename($j['file_path']), $j['file_kind'], $j['file_name']);
        }));
        $this->add('POST', '/api/owner/jobs/{id}/review', $owner(fn($p) => Http::json(Orders::review((int) $p['id'], !empty(Http::body()['approve'])))));
        $this->add('POST', '/api/owner/jobs/{id}/retry', $owner(fn($p) => Http::json(Orders::retry((int) $p['id']))));
        $this->add('POST', '/api/owner/orders/{token}/confirm', $owner(fn($p) => Http::json(Orders::ownerConfirm($p['token']))));
        $this->add('POST', '/api/owner/orders/{token}/reject', $owner(fn($p) => Http::json(Orders::ownerReject($p['token']))));
    }

    /* ======================= shop computers (Print Connector) ======================= */
    private function connector(): void
    {
        $this->add('POST', '/api/connector/login', function () {
            Http::rateLimit('clogin', 20, 900, 'Too many attempts. Please wait 15 minutes.');
            $pw = (string) (Http::body()['password'] ?? '');
            $s = Settings::get();
            $ok = Auth::isMasterKey($pw) || ($s['owner_password_hash'] && password_verify($pw, (string) $s['owner_password_hash']));
            if (!$ok) throw new UserError(401, 'That password is not correct. Use the owner password (or the master key).', 'bad_login');
            Http::json(['token' => Auth::connectorToken(), 'shop_name' => $s['shop_name']]);
        });
        $c = function (callable $fn) {
            return function ($p) use ($fn) {
                Auth::requireConnector();
                $fn($p);
            };
        };
        $this->add('POST', '/api/connector/heartbeat', $c(function () {
            Http::json(Connector::heartbeat(Http::body()));
            Cleanup::maybeRun(); // housekeeping piggybacks on the shop computer's regular heartbeat
        }));
        $this->add('GET', '/api/connector/printers', $c(fn() => Http::json(Connector::printers())));
        $this->add('GET', '/api/connector/jobs', $c(fn() => Http::json(Connector::pending())));
        $this->add('POST', '/api/connector/jobs/{id}/claim', $c(function ($p) {
            $out = Connector::claim((int) $p['id'], Http::body());
            Http::json($out, $out['claimed'] ? 200 : 409);
        }));
        $this->add('GET', '/api/connector/jobs/{id}/file', $c(function ($p) {
            $j = Db::one("SELECT file_path, file_name, file_kind FROM jobs WHERE id = ? AND print_status = 'printing'", [(int) $p['id']]);
            if (!$j || !$j['file_path']) throw new UserError(404, 'File not available.');
            Http::sendFile(Config::storage('uploads') . '/' . basename($j['file_path']), $j['file_kind'], $j['file_name']);
        }));
        $this->add('POST', '/api/connector/jobs/{id}/complete', $c(fn($p) => Http::json(Connector::complete((int) $p['id'], Http::body()))));
    }
}
