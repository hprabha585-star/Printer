<?php
// Every /api/... request comes here (see .htaccess). The application lives in ./app (not web-accessible).
$PRINTSHOP_JSON = true;
require __DIR__ . '/app/version_guard.php';
require __DIR__ . '/app/bootstrap.php';
App::handleApi();
