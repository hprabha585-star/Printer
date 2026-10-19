<?php
// Temporary test page. Delete it after the site works.
echo "PHP OK " . PHP_VERSION . "<br>";
foreach (["pdo_mysql","gd","mbstring","zlib","openssl"] as $e) echo $e . ": " . (extension_loaded($e) ? "yes" : "NO") . "<br>";
echo "folder: " . basename(__DIR__) . "<br>";
echo "app folder files: " . (is_dir(__DIR__."/app") ? count(glob(__DIR__."/app/*.php")) : "missing") . "<br>";
echo "analyzer files: " . (is_dir(__DIR__."/app/analyzer") ? count(glob(__DIR__."/app/analyzer/*.php")) : "missing") . "<br>";
