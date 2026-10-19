<?php
// Every /api/... request comes here (see .htaccess). The application lives in ./app (not web-accessible).
require __DIR__ . '/app/bootstrap.php';
App::handleApi();
