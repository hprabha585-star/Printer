<?php
/*
 * First-time setup page (/setup). Works only while the site is NOT yet configured.
 * Asks for the database details, tests them, creates the tables, makes a master key
 * and saves everything to app/config.php (never web-readable).
 */
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
ini_set('display_errors', '0');
header('X-Frame-Options: DENY');
header('Cache-Control: no-store');

function h($s): string { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }

$checks = [];
$checks[] = ['PHP 8.1 or newer', PHP_VERSION_ID >= 80100, 'Current: ' . PHP_VERSION . '. Change it in Select PHP Version.'];
foreach (['pdo_mysql', 'gd', 'zlib', 'mbstring', 'openssl'] as $e) {
    $checks[] = ["PHP extension: $e", extension_loaded($e), 'Turn it on in Select PHP Version → Extensions.'];
}
$upMb = (int) floor(Config::maxUploadBytes() / 1048576);
$checks[] = ['Upload size limit at least 20 MB', $upMb >= 20, "Now $upMb MB. Set upload_max_filesize = 30M and post_max_size = 32M in Select PHP Version → Options."];
$storageOk = is_writable(Config::storage()) && is_dir(Config::storage('uploads')) && is_writable(Config::storage('uploads'));
$checks[] = ['Storage folder is writable', $storageOk, 'Give the "storage" folder write permission (755) in the File Manager.'];
$blocking = array_filter($checks, fn($c) => !$c[1] && !str_starts_with($c[0], 'Upload'));

$state = 'form';
$error = '';
$master = '';
$configText = '';
if (Config::isConfigured()) {
    $state = 'done_before';
} elseif (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && !$blocking) {
    $in = [
        'DB_HOST' => trim((string) ($_POST['db_host'] ?? 'localhost')) ?: 'localhost',
        'DB_PORT' => (int) ($_POST['db_port'] ?? 3306) ?: 3306,
        'DB_NAME' => trim((string) ($_POST['db_name'] ?? '')),
        'DB_USER' => trim((string) ($_POST['db_user'] ?? '')),
        'DB_PASSWORD' => (string) ($_POST['db_password'] ?? ''),
        'PUBLIC_URL' => rtrim(trim((string) ($_POST['public_url'] ?? '')), '/'),
    ];
    try {
        if ($in['DB_NAME'] === '' || $in['DB_USER'] === '') throw new RuntimeException('Fill in the database name and username.');
        $pdo = new PDO("mysql:host={$in['DB_HOST']};port={$in['DB_PORT']};dbname={$in['DB_NAME']};charset=utf8mb4", $in['DB_USER'], $in['DB_PASSWORD'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 8]);
        $pdo->query('SELECT 1');
        // readable master key, e.g. K7QF-2MXP-9TRA-H4WZ-6CNE
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $parts = [];
        for ($g = 0; $g < 5; $g++) {
            $p = '';
            for ($i = 0; $i < 4; $i++) $p .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            $parts[] = $p;
        }
        $master = implode('-', $parts);
        $cfg = $in + ['OWNER_MASTER_KEY' => $master];
        $configText = "<?php\n// Print shop settings — keep this file private. Created by /setup on " . gmdate('Y-m-d H:i') . " UTC.\nreturn " . var_export($cfg, true) . ";\n";
        $target = getenv('PRINTSHOP_CONFIG') ?: __DIR__ . '/app/config.php';
        if (@file_put_contents($target, $configText, LOCK_EX) !== false) {
            @chmod($target, 0600);
            // load it and create the tables now
            Config::reset(); // re-read: now loads app/config.php
            Db::migrate();
            file_put_contents(Config::storage() . '/schema.version', Db::schemaVersion());
            $state = 'saved';
        } else {
            $state = 'manual';
        }
    } catch (Throwable $e) {
        $msg = $e->getMessage();
        if (stripos($msg, 'Access denied') !== false) $error = 'The database username or password is wrong (or the user is not added to this database).';
        elseif (stripos($msg, 'Unknown database') !== false) $error = 'There is no database with that name. Copy the full name shown in the control panel (it usually has a prefix).';
        elseif (stripos($msg, 'getaddrinfo') !== false || stripos($msg, 'Connection refused') !== false || stripos($msg, 'timed out') !== false) $error = 'Cannot reach the database server. The host is usually "localhost".';
        else $error = $msg;
    }
}
$guessUrl = 'https://' . ($_SERVER['HTTP_HOST'] ?? 'your-domain');
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Set up your print shop</title>
<link rel="stylesheet" href="style.css">
<style>.ck{display:flex;gap:8px;align-items:flex-start;padding:4px 0}.ck b{min-width:22px}.key{font:700 1.5rem var(--mono);letter-spacing:.08em;text-align:center;padding:14px;border:3px dashed var(--stamp);background:#fff;word-break:break-all}pre{white-space:pre-wrap;word-break:break-all;background:#fff;border:2px solid var(--line);padding:10px;font-size:.8rem}</style>
</head>
<body>
<main class="wrap">
  <header class="shop"><h1>Print shop setup</h1><div class="sub">One-time installation</div></header>

<?php if ($state === 'done_before'): ?>
  <div class="receipt torn">
    <span class="stamp ok">Already set up</span>
    <p>This website is already installed. For safety, this page cannot change anything now.</p>
    <p><a class="btn btn-block" href="owner">Open the owner dashboard</a></p>
    <p class="hint">To start again, delete the file <code>app/config.php</code> in the File Manager, then open this page.</p>
  </div>

<?php elseif ($state === 'saved' || $state === 'manual'): ?>
  <div class="receipt torn">
    <span class="stamp ok">Database connected</span>
    <h2 style="margin-top:14px">Your master key</h2>
    <p>Write this down on paper and keep it safe. You need it to sign in the first time, and if you ever forget your password.
       <b>It is shown only once.</b></p>
    <div class="key"><?= h($master) ?></div>
    <?php if ($state === 'manual'): ?>
      <div class="notice warn">The settings file could not be saved automatically. In the File Manager, create the file
        <code>app/config.php</code> and paste exactly this text into it:</div>
      <pre><?= h($configText) ?></pre>
    <?php else: ?>
      <div class="notice ok">Settings saved and the database tables were created.</div>
    <?php endif; ?>
    <p><a class="btn btn-block" href="owner">Next: open the owner dashboard →</a></p>
    <p class="hint">On the dashboard, choose "Use the master key", sign in, then pick your own username and password.</p>
  </div>

<?php else: ?>
  <div class="receipt torn">
    <h2>1. Server check</h2>
    <?php foreach ($checks as [$label, $ok, $fix]): ?>
      <div class="ck"><b style="color:<?= $ok ? 'var(--ok)' : 'var(--stamp)' ?>"><?= $ok ? '✓' : '✗' ?></b>
        <div><?= h($label) ?><?php if (!$ok): ?><div class="hint"><?= h($fix) ?></div><?php endif; ?></div></div>
    <?php endforeach; ?>
    <?php if ($blocking): ?><div class="notice err">Fix the red items above, then reload this page.</div><?php endif; ?>
  </div>

  <form class="receipt torn" method="post" autocomplete="off">
    <h2>2. Database</h2>
    <p class="hint">Use the details from your control panel → Databases (create a MySQL database and a user first, and add the user to the database with all privileges).</p>
    <?php if ($error): ?><div class="notice err"><?= h($error) ?></div><?php endif; ?>
    <label for="db_name">Database name</label><input type="text" id="db_name" name="db_name" value="<?= h($_POST['db_name'] ?? '') ?>" placeholder="e.g. abcd_printshop" required>
    <label for="db_user">Database username</label><input type="text" id="db_user" name="db_user" value="<?= h($_POST['db_user'] ?? '') ?>" placeholder="e.g. abcd_printshop" required>
    <label for="db_password">Database password</label><input type="password" id="db_password" name="db_password">
    <details><summary>Advanced (usually leave as is)</summary>
      <label for="db_host">Database host</label><input type="text" id="db_host" name="db_host" value="<?= h($_POST['db_host'] ?? 'localhost') ?>">
      <label for="db_port">Port</label><input type="number" id="db_port" name="db_port" value="<?= h($_POST['db_port'] ?? '3306') ?>">
    </details>
    <h2 style="margin-top:18px">3. Website address</h2>
    <input type="text" name="public_url" value="<?= h($_POST['public_url'] ?? $guessUrl) ?>">
    <button class="btn-block" style="margin-top:16px" <?= $blocking ? 'disabled' : '' ?>>Connect and finish setup</button>
  </form>
<?php endif; ?>
</main>
</body>
</html>
