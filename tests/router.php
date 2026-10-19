<?php
/*
 * Router for PHP's built-in test server, mimicking public_html/.htaccess:
 *   php -S 127.0.0.1:8080 -t public_html tests/router.php
 * (Developer use only — the real site uses .htaccess on LiteSpeed/Apache.)
 */
$root = realpath(__DIR__ . '/../public_html');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(app|storage)(/|$)#', $path) || preg_match('#/\.|\.(md|sql|log|lock|version|ini)$#', $path)) {
    http_response_code(403);
    echo 'Forbidden';
    return true;
}
if (preg_match('#^/api(/|$)#', $path)) {
    $_SERVER['SCRIPT_NAME'] = '/api.php';
    require $root . '/api.php';
    return true;
}
if (preg_match('#^/owner/?$#', $path)) {
    header('Content-Type: text/html; charset=utf-8');
    readfile($root . '/owner.html');
    return true;
}
if (preg_match('#^/setup/?$#', $path)) {
    $_SERVER['SCRIPT_NAME'] = '/setup.php';
    require $root . '/setup.php';
    return true;
}
return false; // static files
