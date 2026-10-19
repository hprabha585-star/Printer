"""
Extra PDF fixtures that stress the PHP PDF reader (developer use).
Adds to tests/fixtures/out/expectations.json:
  - compressed object streams / xref streams (qpdf)
  - hand-written PDFs: form XObjects with matrices, inline images, CMYK and
    Indexed colour, Type0 (2-byte) fonts, Separation inks, invisible OCR text
  - real office-exported PDFs (LibreOffice): text, coloured headings, tables
Run after make_fixtures.py.
"""
import json, os, subprocess, tempfile, zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
EXP_PATH = os.path.join(OUT, 'expectations.json')
EXP = json.load(open(EXP_PATH))


def expect(name, pages, classes=None, micro='ok'):
    EXP[name] = {'pages': pages, 'classes': classes, 'micro': micro}


def build_pdf(path, pages, extra_objs=None):
    """pages: list of (content_bytes, resources_str). extra_objs: {num: bytes} added as-is."""
    objs = {}
    n_extra = max(extra_objs.keys()) if extra_objs else 0
    first = n_extra + 1
    objs[first] = b'<< /Type /Catalog /Pages %d 0 R >>' % (first + 1)
    kids = []
    num = first + 2
    for content, res in pages:
        data = zlib.compress(content)
        objs[num] = b'<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(data) + data + b'\nendstream'
        objs[num + 1] = (b'<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Contents %d 0 R /Resources %s >>'
                         % (first + 1, num, res.encode()))
        kids.append(b'%d 0 R' % (num + 1))
        num += 2
    objs[first + 1] = b'<< /Type /Pages /Kids [' + b' '.join(kids) + b'] /Count %d >>' % len(kids)
    if extra_objs:
        objs.update(extra_objs)
    out = b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'
    offsets = {}
    for k in sorted(objs):
        offsets[k] = len(out)
        out += b'%d 0 obj\n' % k + objs[k] + b'\nendobj\n'
    xref = len(out)
    size = max(objs) + 1
    out += b'xref\n0 %d\n0000000000 65535 f \n' % size
    for k in range(1, size):
        out += (b'%010d 00000 n \n' % offsets[k]) if k in offsets else b'0000000000 65535 f \n'
    out += b'trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (size, first, xref)
    open(path, 'wb').write(out)


FONT = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
TEXT_LINES = b''.join(b'BT /F1 11 Tf 60 %d Td (The quick brown fox jumps over the lazy dog again and again) Tj ET\n' % y
                      for y in range(780, 400, -14))


def handmade():
    # 1) Form XObject drawn 4x larger via its /Matrix, coloured -> full colour; second page uses form at 1x -> partial
    form = b'0.9 0.1 0.1 rg 0 0 100 100 re f'
    extra = {
        1: FONT,
        2: b'<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [4 0 0 4 0 0] /Length %d >>\nstream\n' % len(form) + form + b'\nendstream',
    }
    res = '<< /Font << /F1 1 0 R >> /XObject << /Fm1 2 0 R >> >>'
    build_pdf(f'{OUT}/form_xobject.pdf', [
        (b'q 1 0 0 1 50 300 cm /Fm1 Do Q\n' + TEXT_LINES, res),
        (b'q 0.25 0 0 0.25 450 700 cm /Fm1 Do Q\n' + TEXT_LINES, res),
    ], extra)
    expect('form_xobject.pdf', 2, ['full', 'partial'])

    # 2) inline RGB image (coloured) and inline grey image; CMYK fills; grey CMYK (K only)
    w, h = 40, 30
    rgb = bytes([200, 30, 30] * (w * h))
    gray = bytes([90] * (w * h))
    page1 = (b'q 450 0 0 340 70 450 cm BI /W %d /H %d /BPC 8 /CS /RGB ID ' % (w, h) + rgb + b' EI Q\n'
             + b'q 300 0 0 225 100 60 cm BI /W %d /H %d /BPC 8 /CS /G ID ' % (w, h) + gray + b' EI Q\n')
    page2 = b'0 0 0 1 k 40 40 500 700 re f\n' + TEXT_LINES   # pure black ink in CMYK -> B&W
    page3 = b'0 0.8 0.9 0 k 40 500 500 300 re f\n' + TEXT_LINES  # CMYK orange -> full
    build_pdf(f'{OUT}/inline_cmyk.pdf', [(page1, '<< >>'), (page2, '<< /Font << /F1 1 0 R >> >>'),
                                          (page3, '<< /Font << /F1 1 0 R >> >>')], {1: FONT})
    expect('inline_cmyk.pdf', 3, ['full', 'bw', 'full'])

    # 3) Indexed image with a palette of greys only (B&W) and with one colour used (colour)
    iw, ih = 64, 64
    pix_grey = bytes([(x // 8) % 2 for x in range(iw)] * ih)
    pal_grey = b'000000ffffff'
    img_grey = zlib.compress(pix_grey)
    pal_col = b'ff0000ffffff'
    extra = {
        1: b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8 /ColorSpace [/Indexed /DeviceRGB 1 <%s>] /Filter /FlateDecode /Length %d >>\nstream\n' % (iw, ih, pal_grey, len(img_grey)) + img_grey + b'\nendstream',
        2: b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8 /ColorSpace [/Indexed /DeviceRGB 1 <%s>] /Filter /FlateDecode /Length %d >>\nstream\n' % (iw, ih, pal_col, len(img_grey)) + img_grey + b'\nendstream',
    }
    build_pdf(f'{OUT}/indexed_images.pdf', [
        (b'q 400 0 0 400 100 300 cm /Im1 Do Q', '<< /XObject << /Im1 1 0 R >> >>'),
        (b'q 520 0 0 780 30 30 cm /Im2 Do Q', '<< /XObject << /Im2 2 0 R >> >>'),
    ], extra)
    expect('indexed_images.pdf', 2, ['bw', 'full'])

    # 4) Type0 (2-byte) font: lots of 1.5pt text -> blocked; OCR-style invisible tiny text -> ok
    t0 = b'<< /Type /Font /Subtype /Type0 /BaseFont /Fake /Encoding /Identity-H /DescendantFonts [] >>'
    tiny = b''.join(b'BT /F2 1.5 Tf 60 %d Td <%s> Tj ET\n' % (300 - k * 2, (b'0024' * 40)) for k in range(10))
    invisible = b''.join(b'BT 3 Tr /F1 1 Tf 60 %d Td (hidden OCR words for searching only) Tj ET\n' % (300 - k * 2) for k in range(40))
    build_pdf(f'{OUT}/type0_tiny.pdf', [(TEXT_LINES + tiny, '<< /Font << /F1 1 0 R /F2 2 0 R >> >>')], {1: FONT, 2: t0})
    expect('type0_tiny.pdf', 1, None, 'blocked')
    build_pdf(f'{OUT}/ocr_invisible.pdf', [(TEXT_LINES + invisible, '<< /Font << /F1 1 0 R >> >>')], {1: FONT})
    expect('ocr_invisible.pdf', 1, ['bw'], 'ok')

    # 5) Separation inks: "Black" spot = B&W; "PANTONE 185 C" spot = colour
    sep_black = '[/Separation /Black /DeviceCMYK 1 0 R]'
    build_pdf(f'{OUT}/separation.pdf', [
        (b'/CS0 cs 1 sc 40 40 500 700 re f', '<< /ColorSpace << /CS0 [/Separation /Black /DeviceGray 1 0 R] >> >>'),
        (b'/CS0 cs 1 sc 40 400 500 400 re f', '<< /ColorSpace << /CS0 [/Separation /PANTONE#20185#20C /DeviceCMYK 1 0 R] >> >>'),
    ], {1: b'<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>'})
    expect('separation.pdf', 2, ['bw', 'full'])
    del sep_black

    # 6) colour text only (coloured words on a page) -> partial
    red_text = b'0.8 0 0 rg\n' + TEXT_LINES[:400]
    build_pdf(f'{OUT}/red_text.pdf', [(TEXT_LINES + red_text, '<< /Font << /F1 1 0 R >> >>')], {1: FONT})
    expect('red_text.pdf', 1, ['partial'])


def objstreams():
    for src in ['mixed.pdf', 'micro_pdf_blocked.pdf', 'form_xobject.pdf', 'text.pdf']:
        dst = src.replace('.pdf', '_objstm.pdf')
        subprocess.run(['qpdf', '--object-streams=generate', '--compress-streams=y', f'{OUT}/{src}', f'{OUT}/{dst}'], check=True)
        EXP[dst] = dict(EXP[src])
    # owner-password only (open without a password; only editing is restricted) -> must be accepted
    for src, bits, extra, dst in [
        ('mixed.pdf', '256', [], 'owner_pw_aes256.pdf'),
        ('mixed.pdf', '128', ['--use-aes=y'], 'owner_pw_aes128.pdf'),
        ('micro_pdf_blocked.pdf', '128', ['--use-aes=n'], 'owner_pw_rc4_128.pdf'),
        ('mixed.pdf', '40', [], 'owner_pw_rc4_40.pdf'),
    ]:
        subprocess.run(['qpdf', '--allow-weak-crypto', '--encrypt', '', 'owner123', bits, *extra, '--', f'{OUT}/{src}', f'{OUT}/{dst}'], check=True)
        EXP[dst] = dict(EXP[src])
    # real password needed to open -> refused
    subprocess.run(['qpdf', '--encrypt', 'user123', 'owner123', '128', '--use-aes=y', '--', f'{OUT}/text.pdf', f'{OUT}/user_pw_aes128.pdf'], check=True)
    EXP['user_pw_aes128.pdf'] = {'error': 'encrypted'}
    if os.path.exists(f'{OUT}/owner_pw_only.pdf'):
        os.remove(f'{OUT}/owner_pw_only.pdf')
    EXP.pop('owner_pw_only.pdf', None)


def office():
    tmp = tempfile.mkdtemp()
    html = """<html><body>
<h1 style="color:#1f5fbf">Quarterly Report</h1>
<p>""" + ' '.join(['This is a normal paragraph of body text in a word processor document.'] * 30) + """</p>
<table border="1">""" + ''.join(f'<tr><td>Row {i}</td><td>{i*37}</td><td>{i*11} units</td></tr>' for i in range(25)) + """</table>
<p style="font-size:7pt">Footnote: small print at seven points for terms and conditions.</p>
</body></html>"""
    open(f'{tmp}/report.html', 'w').write(html)
    plain = "<html><body>" + ''.join(f"<p>Paragraph {i}: " + "plain black text for an assignment. " * 12 + "</p>" for i in range(40)) + "</body></html>"
    open(f'{tmp}/assignment.html', 'w').write(plain)
    for name in ['report', 'assignment']:
        subprocess.run(['soffice', '--headless', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', tmp, f'{tmp}/{name}.html'],
                       check=True, capture_output=True, timeout=180)
        os.replace(f'{tmp}/{name}.pdf', f'{OUT}/office_{name}.pdf')
    # page counts come from the office export; colour classes checked by the test on page 1 only
    EXP['office_report.pdf'] = {'pages': None, 'classes': None, 'first': 'partial', 'micro': 'ok'}
    EXP['office_assignment.pdf'] = {'pages': None, 'classes': None, 'all': 'bw', 'micro': 'ok'}


handmade()
objstreams()
office()
json.dump(EXP, open(EXP_PATH, 'w'), indent=1)
print(len(EXP), 'fixtures in total')
