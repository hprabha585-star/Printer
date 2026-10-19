<?php
/* Receives one uploaded file, checks it, and stores the analysis. */
declare(strict_types=1);

final class Upload
{
    public static function analyse(array $f): void
    {
        $s = Settings::get();
        if (!$s['accepting_orders']) throw new UserError(503, 'Sorry, the shop is not accepting orders right now.', 'closed');
        $name = Http::cleanFileName((string) $f['name']);
        $claimed = Analyzer::kindFromName($name);
        if ($claimed === 'office') {
            throw new UserError(415, 'Word, Excel and PowerPoint files can\'t be printed directly. Open the file and choose "Save as PDF" (or Print → Save as PDF), then upload the PDF.', 'office');
        }
        if (!in_array($claimed, ['pdf', 'jpg', 'png'], true)) throw new UserError(415, 'Only PDF, JPG and PNG files are accepted.', 'type');

        $dir = Config::storage('uploads');
        $id = Http::randomId(12);
        $tmp = "$dir/$id.tmp";
        if (!move_uploaded_file($f['tmp_name'], $tmp) && !(Config::isTest() && @rename($f['tmp_name'], $tmp))) {
            throw new UserError(500, 'Upload failed. Please try again.');
        }
        try {
            $slot = self::acquireSlot();
            try {
                $timeout = Config::int('ANALYSIS_TIMEOUT_SEC');
                @set_time_limit($timeout + 60);
                $GLOBALS['__analysing'] = $tmp; // lets the fatal-error handler clean up and answer politely
                $a = Analyzer::analyse($tmp, $claimed, [
                    'maxPages' => Config::int('MAX_PAGES'),
                    'maxImageMegapixels' => Config::int('MAX_IMAGE_MEGAPIXELS'),
                    'timeoutSec' => $timeout,
                ]);
                unset($GLOBALS['__analysing']);
            } finally {
                self::releaseSlot($slot);
            }
            if ($a['micro']['verdict'] === 'blocked') throw new UserError(422, $a['micro']['reason'], 'microtext_blocked');
            $final = "$dir/$id.{$a['kind']}";
            rename($tmp, $final);
            Db::q('INSERT INTO uploads (id, file_path, file_name, file_kind, file_size, page_count, coverage_json, micro_verdict, micro_reason, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP())',
                [$id, basename($final), $name, $a['kind'], (int) $f['size'], $a['pages'], json_encode($a['coverage']), $a['micro']['verdict'],
                    $a['micro']['reason'] !== '' ? mb_substr($a['micro']['reason'], 0, 255) : null]);
            Http::json([
                'upload_id' => $id, 'file_name' => $name, 'kind' => $a['kind'], 'pages' => $a['pages'], 'coverage' => $a['coverage'],
                'micro_verdict' => $a['micro']['verdict'],
                'notice' => $a['micro']['verdict'] === 'suspect' ? 'This file has some very small print. The shop will take a quick look before printing it.' : null,
            ]);
        } catch (AnalysisError $e) {
            @unlink($tmp);
            throw new UserError(422, $e->getMessage(), $e->kind);
        } catch (\Throwable $e) {
            @unlink($tmp);
            throw $e;
        }
    }

    /* At most ANALYSIS_CONCURRENCY files are analysed at once (file locks, works on shared hosting). */
    private static function acquireSlot()
    {
        $n = max(1, Config::int('ANALYSIS_CONCURRENCY'));
        $dir = Config::storage('locks');
        $until = microtime(true) + 45;
        do {
            for ($i = 0; $i < $n; $i++) {
                $h = fopen("$dir/analyse-$i.lock", 'c');
                if ($h && flock($h, LOCK_EX | LOCK_NB)) return $h;
                if ($h) fclose($h);
            }
            usleep(250000);
        } while (microtime(true) < $until);
        throw new UserError(503, 'The shop is busy checking other files. Please try again in a minute.', 'busy');
    }

    private static function releaseSlot($h): void
    {
        if ($h) {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }
}
