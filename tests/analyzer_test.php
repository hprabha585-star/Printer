<?php
/*
 * Analyser accuracy test (developer use): runs every generated fixture through
 * the PHP analyser and compares with tests/fixtures/out/expectations.json.
 *   php tests/analyzer_test.php [name-filter]
 */
declare(strict_types=1);
ini_set('memory_limit', '512M');
$app = __DIR__ . '/../public_html/app';
foreach (['analyzer/Raster.php', 'analyzer/Microtext.php', 'analyzer/PdfCrypt.php', 'analyzer/PdfFile.php', 'analyzer/PdfPage.php', 'analyzer/Analyzer.php'] as $f) require $app . '/' . $f;

$dir = getenv('FIXTURES') ?: __DIR__ . '/fixtures/out';
$exp = json_decode((string) file_get_contents("$dir/expectations.json"), true);
$only = $argv[1] ?? '';
$classify = function (float $c, float $t = 25): string {
    if ($c <= 0) return 'bw';
    return $c >= $t / 100 ? 'full' : 'partial';
};
$pass = $fail = 0;
foreach ($exp as $name => $e) {
    if ($only && strpos($name, $only) === false) continue;
    $t0 = microtime(true);
    try {
        $r = Analyzer::analyse("$dir/$name", Analyzer::kindFromName($name), ['maxPages' => 200, 'maxImageMegapixels' => 50, 'timeoutSec' => 120]);
        $err = null;
    } catch (AnalysisError $x) {
        $r = null;
        $err = $x;
    }
    $ms = (int) ((microtime(true) - $t0) * 1000);
    if (isset($e['error'])) {
        $ok = $err && $err->kind === $e['error'];
        $got = $err ? "{$err->kind}: {$err->getMessage()}" : 'analysed OK';
    } elseif ($err) {
        $ok = false;
        $got = "{$err->kind}: {$err->getMessage()}";
    } else {
        $classes = array_map($classify, $r['coverage']);
        $ok = ($e['pages'] === null || $r['pages'] === $e['pages']) && $r['micro']['verdict'] === $e['micro']
            && (empty($e['classes']) || $classes === $e['classes'])
            && (!isset($e['first']) || $classes[0] === $e['first'])
            && (!isset($e['all']) || count(array_unique($classes)) === 1 && $classes[0] === $e['all']);
        $got = "pages={$r['pages']} cov=" . json_encode($r['coverage']) . ' classes=' . implode(',', $classes) . " micro={$r['micro']['verdict']} {$r['micro']['reason']}";
    }
    $ok ? $pass++ : $fail++;
    printf("%s %-28s %6dms  %s\n", $ok ? 'PASS' : 'FAIL', $name, $ms, mb_strimwidth($got, 0, 170));
}
echo "\nAnalyser (PHP): $pass passed, $fail failed\n";
exit($fail ? 1 : 0);
