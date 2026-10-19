<?php
// Written in old-style PHP on purpose: it must run even on old PHP versions,
// so the owner sees a clear message instead of a blank "HTTP ERROR 500".
if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    $msg = 'This website needs PHP 8.1 or newer, but this server is running PHP ' . PHP_VERSION
         . '. In the hosting control panel open "Manage PHP" / "Select PHP Version", choose 8.2 or 8.3 for this domain, save, and reload this page.';
    if (isset($PRINTSHOP_JSON) && $PRINTSHOP_JSON) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(array('error' => $msg, 'code' => 'php_too_old'));
    } else {
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup</title>'
           . '<body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">'
           . '<h2>PHP version too old</h2><p>' . htmlspecialchars($msg) . '</p></body>';
    }
    exit;
}

// While the site is not set up yet, show the real reason if PHP crashes while loading,
// so a blank "HTTP ERROR 500" can be diagnosed. Hidden once setup has saved the config.
if (!is_file(__DIR__ . '/config.php') && !is_file(dirname(__DIR__, 2) . '/printshop-config.php')) {
    register_shutdown_function(function () {
        $e = error_get_last();
        if (!$e || !in_array($e['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) return;
        while (ob_get_level()) ob_end_clean();
        if (!headers_sent()) header('Content-Type: text/plain; charset=utf-8');
        echo "Setup problem (send this to whoever installs the site):\n\n"
           . $e['message'] . "\nFile: " . basename(dirname($e['file'])) . '/' . basename($e['file']) . ' line ' . $e['line']
           . "\nPHP " . PHP_VERSION . "\n";
    });
}
