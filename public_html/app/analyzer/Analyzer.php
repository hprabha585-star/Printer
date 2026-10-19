<?php
/*
 * File analysis entry point.
 * Result: ['kind', 'pages', 'coverage' => [0..1 per page], 'micro' => ['verdict' => ok|suspect|blocked, 'reason']]
 * Throws AnalysisError with a friendly message for anything we can't accept.
 */
declare(strict_types=1);

final class AnalysisError extends \Exception
{
    public function __construct(public string $kind, string $message)
    {
        parent::__construct($message);
    }
}

final class Analyzer
{
    // micro-printing thresholds (characters counted across the whole PDF)
    private const BLOCK_TINY_CHARS = 150;   // a lot of text under 2pt -> BLOCKED
    private const SUSPECT_TINY_CHARS = 15;  // a little text under 2pt -> SUSPECT
    private const SUSPECT_SMALL_CHARS = 200; // a lot of 2–3pt text -> SUSPECT

    /** Identify by content, never by name. */
    public static function sniff(string $head): string
    {
        if (strlen($head) < 8) return 'unknown';
        if (strpos(substr($head, 0, 1024), '%PDF-') !== false) return 'pdf';
        if (substr($head, 0, 3) === "\xFF\xD8\xFF") return 'jpg';
        if (substr($head, 0, 8) === "\x89PNG\r\n\x1a\n") return 'png';
        if (substr($head, 0, 2) === 'PK') return 'zip';
        if (substr($head, 0, 4) === "\xD0\xCF\x11\xE0") return 'ole';
        return 'unknown';
    }

    public static function kindFromName(string $name): string
    {
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === 'pdf') return 'pdf';
        if ($ext === 'jpg' || $ext === 'jpeg') return 'jpg';
        if ($ext === 'png') return 'png';
        if (in_array($ext, ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp', 'rtf', 'txt'], true)) return 'office';
        return 'other';
    }

    /**
     * $opts: maxPages, maxImageMegapixels, timeoutSec
     */
    public static function analyse(string $path, string $claimed, array $opts): array
    {
        $deadline = microtime(true) + (float) ($opts['timeoutSec'] ?? 60);
        $fh = fopen($path, 'rb');
        $head = $fh ? (string) fread($fh, 1024) : '';
        if ($fh) fclose($fh);
        $actual = self::sniff($head);
        if ($actual !== $claimed) {
            if ($actual === 'zip' || $actual === 'ole') {
                throw new AnalysisError('mismatch', 'This looks like a Word, Excel or PowerPoint file. Please open it and use "Save as PDF", then upload the PDF.');
            }
            if (in_array($actual, ['pdf', 'jpg', 'png'], true)) {
                throw new AnalysisError('mismatch', "This file's contents don't match its name (it is really a " . strtoupper($actual) . '). Please rename it correctly or re-save it.');
            }
            throw new AnalysisError('mismatch', "This file's contents don't match its name, or it is not a PDF, JPG or PNG.");
        }
        try {
            $r = $actual === 'pdf' ? self::pdf($path, $opts, $deadline) : self::image($path, $actual, $opts, $deadline);
        } catch (AnalysisError $e) {
            if ($e->kind === 'timeout') {
                throw new AnalysisError('timeout', 'Checking this file took too long (over ' . (int) $opts['timeoutSec'] . ' seconds). Try a smaller file, or split a large scanned PDF.');
            }
            throw $e;
        }
        return ['kind' => $actual] + $r;
    }

    private static function image(string $path, string $kind, array $opts, float $deadline): array
    {
        $info = @getimagesize($path);
        if (!$info || !$info[0] || !$info[1]) throw new AnalysisError('corrupt', 'This image looks damaged and cannot be opened.');
        [$w, $h] = $info;
        if ($w * $h > $opts['maxImageMegapixels'] * 1e6) {
            throw new AnalysisError('oversized', "This image is too large ({$w}×{$h} pixels). Please resize it or save it as a PDF.");
        }
        $im = $kind === 'png' ? @imagecreatefrompng($path) : @imagecreatefromjpeg($path);
        if (!$im instanceof \GdImage) throw new AnalysisError('corrupt', 'This image looks damaged and cannot be opened.');
        $im = Raster::flatten($im); // transparent areas print as white paper
        $coverage = Raster::withMinimum(Raster::colourFraction($im));
        // a stand-alone image is printed fitted to an A4 page
        $portrait = $h >= $w;
        $dpi = max($w / ($portrait ? 8.27 : 11.69), $h / ($portrait ? 11.69 : 8.27));
        $mt = Microtext::detect($im, $dpi, $deadline);
        return [
            'pages' => 1,
            'coverage' => [round($coverage, 4)],
            'micro' => $mt['suspect']
                ? ['verdict' => 'suspect', 'reason' => 'Possible micro-printing: ' . $mt['reason']]
                : ['verdict' => 'ok', 'reason' => $mt['checked'] ? '' : 'Image ' . $mt['reason']],
        ];
    }

    private static function pdf(string $path, array $opts, float $deadline): array
    {
        $data = (string) file_get_contents($path);
        try {
            $pdf = new PdfFile($data);
        } catch (\Throwable $e) {
            throw new AnalysisError('corrupt', 'This PDF looks damaged and cannot be opened. Try re-saving it as PDF.');
        }
        if ($pdf->encrypted) {
            throw new AnalysisError('encrypted', 'This PDF is password-protected. Please remove the password (or "Print to PDF" a copy) and upload again.');
        }
        $count = $pdf->pageCount();
        if ($count > $opts['maxPages']) {
            throw new AnalysisError('too_many_pages', "This PDF has {$count} pages. The limit is {$opts['maxPages']} pages per file — please split it.");
        }
        $pages = $pdf->pages((int) $opts['maxPages']);
        if (!$pages) throw new AnalysisError('corrupt', 'This PDF looks damaged and cannot be opened. Try re-saving it as PDF.');
        if (count($pages) > $opts['maxPages']) {
            throw new AnalysisError('too_many_pages', 'This PDF has more than ' . $opts['maxPages'] . ' pages. Please split it.');
        }

        $scan = new PdfScanState($deadline);
        $coverage = [];
        foreach ($pages as $i => $page) {
            $area = PdfPage::area($page['box']) ?: 1.0;
            $runner = new PdfPage($pdf, $page['box'], $scan, $i + 1);
            $content = $pdf->pageContent($page);
            $runner->run($content, $page['resources'], PdfPage::initialState());
            $coverage[] = round(Raster::withMinimum(min(1.0, $runner->coloured / $area)), 4);
            if (microtime(true) > $deadline) throw new AnalysisError('timeout', '');
        }

        $verdict = 'ok';
        $reason = '';
        if ($scan->tiny >= self::BLOCK_TINY_CHARS) {
            $verdict = 'blocked';
            $reason = "This file contains a large amount of extremely small text ({$scan->tiny} characters under 2pt). Micro-printing like this is used on currency, cheques, certificates and IDs, so it cannot be printed here.";
        } elseif ($scan->tiny >= self::SUSPECT_TINY_CHARS) {
            $verdict = 'suspect';
            $reason = "Contains some extremely small text ({$scan->tiny} characters under 2pt).";
        } elseif ($scan->small >= self::SUSPECT_SMALL_CHARS) {
            $verdict = 'suspect';
            $reason = "Contains a lot of very small text ({$scan->small} characters of 2–3pt).";
        } elseif ($scan->imageSuspect !== null) {
            $verdict = 'suspect';
            $reason = "Possible micro-printing in an image ({$scan->imageSuspect}).";
        }
        return ['pages' => count($pages), 'coverage' => $coverage, 'micro' => ['verdict' => $verdict, 'reason' => $reason]];
    }
}
