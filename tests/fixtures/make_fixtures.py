"""
Generates the analyser test files (developer use only — not needed on the server).
Requires: Pillow, reportlab, qrcode, and the qpdf command for the encrypted PDF.
Each file name ends with its expected result, checked by tests/analyzer.test.js:
  expectations.json  ->  { file: { pages, classes, micro } }
"""
import io, json, math, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(OUT, exist_ok=True)
random.seed(7)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
W, H = A4
EXP = {}
LOREM = ("The quick brown fox jumps over the lazy dog while the shopkeeper prints "
         "receipts invoices and admission forms for students and families ").split()

def words(n):
    return ' '.join(random.choice(LOREM) for _ in range(n))

def expect(name, pages, classes=None, micro='ok'):
    EXP[name] = {'pages': pages, 'classes': classes, 'micro': micro}

def body_text(c, size=11, top=780, lines=40, color=(0, 0, 0), leading=1.3):
    c.setFillColorRGB(*color)
    c.setFont('Helvetica', size)
    y = top
    for _ in range(lines):
        if y < 60: break
        c.drawString(60, y, words(int(470 / (size * 0.5))))
        y -= size * leading

# ---------- PDFs: colour ----------
def pdf_text():
    c = canvas.Canvas(f'{OUT}/text.pdf', pagesize=A4)
    for _ in range(3): body_text(c); c.showPage()
    c.save(); expect('text.pdf', 3, ['bw', 'bw', 'bw'])

def pdf_mixed():
    c = canvas.Canvas(f'{OUT}/mixed.pdf', pagesize=A4)
    body_text(c); c.showPage()                                     # 1: B&W
    body_text(c); c.setFillColorRGB(0.9, 0.1, 0.1); c.setFont('Helvetica-Bold', 20)
    c.drawString(60, 810, 'Red heading'); c.setFillColorRGB(0.1, 0.3, 0.9)
    c.rect(450, 790, 80, 40, fill=1, stroke=0); c.showPage()       # 2: partial
    c.setFillColorRGB(0.2, 0.6, 0.3); c.rect(40, 300, W - 80, 500, fill=1, stroke=0)
    body_text(c, top=260, lines=12); c.showPage()                  # 3: full
    c.setFillGray(0.5); c.rect(40, 300, W - 80, 500, fill=1, stroke=0); body_text(c, color=(0.3, 0.3, 0.3), top=260, lines=12)
    c.showPage()                                                   # 4: grey only -> B&W
    c.save(); expect('mixed.pdf', 4, ['bw', 'partial', 'full', 'bw'])

def pdf_photo():
    im = Image.new('RGB', (600, 400))
    d = ImageDraw.Draw(im)
    for y in range(400):
        d.line([(0, y), (600, y)], fill=(255 - y // 2, 80 + y // 3, 40 + y // 2))
    c = canvas.Canvas(f'{OUT}/photo_page.pdf', pagesize=A4)
    c.drawImage(ImageReader(im), 50, 350, 495, 330); body_text(c, top=320, lines=10); c.showPage()
    c.drawImage(ImageReader(im), 450, 760, 90, 60); body_text(c, lines=35); c.showPage()
    c.save(); expect('photo_page.pdf', 2, ['full', 'partial'])

def pdf_gradient():
    c = canvas.Canvas(f'{OUT}/gradient.pdf', pagesize=A4)
    from reportlab.lib.colors import Color
    p = c.beginPath(); p.rect(40, 400, W - 80, 400); c.clipPath(p, stroke=0)
    c.linearGradient(40, 400, W - 40, 800, (Color(1, 0, 0), Color(0, 0, 1)))
    c.showPage(); c.save(); expect('gradient.pdf', 1, ['full'])

# ---------- images: colour ----------
def scan_like(text_size_px=40, size=(1240, 1754), dpi_note=150, color=False, footer=None):
    im = Image.new('L', size, 250)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, text_size_px)
    y = int(size[1] * 0.06)
    while y < size[1] * 0.85:
        d.text((int(size[0] * 0.07), y), words(9), font=f, fill=20)
        y += int(text_size_px * 1.5)
    if footer:
        ff = ImageFont.truetype(FONT, footer)
        d.text((int(size[0] * 0.07), int(size[1] * 0.95)), 'Footer: ' + words(12), font=ff, fill=40)
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    from PIL import ImageChops
    im = ImageChops.add(im, Image.effect_noise(size, 6), 1.0, -128)  # scanner noise
    return im

def images_colour():
    g = scan_like().convert('RGB')
    g.save(f'{OUT}/grey_scan.jpg', quality=70); expect('grey_scan.jpg', 1, ['bw'])
    c = g.copy(); d = ImageDraw.Draw(c); d.rectangle([900, 60, 1150, 220], fill=(200, 30, 30))
    c.save(f'{OUT}/logo_scan.png'); expect('logo_scan.png', 1, ['partial'])
    photo = Image.new('RGB', (1200, 900))
    px = photo.load()
    for y in range(900):
        for x in range(0, 1200):
            px[x, y] = (int(128 + 120 * math.sin(x / 90)), int(128 + 100 * math.cos(y / 70)), 90)
    photo.save(f'{OUT}/photo.jpg', quality=85); expect('photo.jpg', 1, ['full'])
    grey_photo = photo.convert('L').convert('RGB'); grey_photo.save(f'{OUT}/grey_photo.jpg', quality=60)
    expect('grey_photo.jpg', 1, ['bw'])

# ---------- normal documents that must NOT be flagged ----------
def normal_docs():
    c = canvas.Canvas(f'{OUT}/footer_5pt.pdf', pagesize=A4)
    for i in range(4):
        body_text(c, size=11)
        c.setFont('Helvetica', 5); c.setFillGray(0)
        c.drawString(60, 30, 'Registered office: ' + words(18))
        c.drawString(60, 24, 'Terms apply. ' + words(18))
        c.showPage()
    c.save(); expect('footer_5pt.pdf', 4, ['bw'] * 4)

    c = canvas.Canvas(f'{OUT}/font_sizes.pdf', pagesize=A4)
    y = 800
    for s in [5, 6, 7, 8, 9, 10, 12, 14, 18, 24]:
        for _ in range(3):
            c.setFont('Helvetica', s); c.drawString(50, y, words(int(480 / (s * 0.5)))); y -= s * 1.25
    c.setFont('Helvetica', 6)
    for k in range(25):  # superscript-style 4pt marks sprinkled in
        c.setFont('Helvetica', 4); c.drawString(60 + k * 18, 120, str(k))
    c.showPage(); c.save(); expect('font_sizes.pdf', 1, ['bw'])

    c = canvas.Canvas(f'{OUT}/table.pdf', pagesize=A4)
    c.setFont('Helvetica', 8)
    for r in range(45):
        y = 800 - r * 16
        c.line(40, y, W - 40, y)
        for k in range(6):
            c.drawString(45 + k * 85, y - 11, words(2)[:14])
    for k in range(7): c.line(40 + k * 85, 800, 40 + k * 85, 800 - 44 * 16)
    c.showPage(); c.save(); expect('table.pdf', 1, ['bw'])

    # Images of normal documents at various resolutions
    for dpi in (100, 150, 200, 300):
        size = (int(8.27 * dpi), int(11.69 * dpi))
        px10 = max(6, int(10 / 72 * dpi))
        im = scan_like(text_size_px=px10, size=size, footer=max(4, int(5 / 72 * dpi)))
        im.save(f'{OUT}/doc_{dpi}dpi.png'); expect(f'doc_{dpi}dpi.png', 1, ['bw'])
    # small-print paragraph at 5pt, 300 dpi (dense but not micro)
    dpi = 300; size = (int(8.27 * dpi), int(11.69 * dpi))
    im = Image.new('L', size, 255); d = ImageDraw.Draw(im); f = ImageFont.truetype(FONT, int(5 / 72 * dpi))
    for k in range(60): d.text((150, 300 + k * int(6.2 / 72 * dpi)), words(30), font=f, fill=0)
    im.save(f'{OUT}/smallprint_5pt_300dpi.png'); expect('smallprint_5pt_300dpi.png', 1, ['bw'])
    # more normal variants: dense small text, two columns, tight number grid
    for pt, dpi in ((8, 300), (6, 200), (6, 300)):
        size = (int(8.27 * dpi), int(11.69 * dpi)); im = Image.new('L', size, 255); d = ImageDraw.Draw(im)
        f = ImageFont.truetype(FONT, round(pt / 72 * dpi)); y = int(0.6 * dpi)
        while y < size[1] - dpi: d.text((int(0.6 * dpi), y), words(40), font=f, fill=10); y += round(pt * 1.15 / 72 * dpi)
        name = f'dense_{pt}pt_{dpi}dpi.png'; im.save(f'{OUT}/{name}'); expect(name, 1, ['bw'])
    dpi = 150; size = (int(8.27 * dpi), int(11.69 * dpi)); im = Image.new('L', size, 255); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, round(9 / 72 * dpi))
    for col in (0, 1):
        y = 90
        while y < size[1] - 90: d.text((70 + col * 600, y), words(7), font=f, fill=0); y += round(11 / 72 * dpi)
    im.convert('RGB').save(f'{OUT}/two_column_150dpi.jpg', quality=60); expect('two_column_150dpi.jpg', 1, ['bw'])
    dpi = 300; size = (int(8.27 * dpi), int(11.69 * dpi)); im = Image.new('L', size, 255); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, round(7 / 72 * dpi)); rowh = round(9 / 72 * dpi)
    for r in range(110):
        y = 150 + r * rowh; d.line([(100, y), (2380, y)], fill=120, width=1)
        for k in range(12): d.text((110 + k * 190, y + 3), str(random.randint(1000, 999999)), font=f, fill=0)
    im.save(f'{OUT}/number_grid_7pt_300dpi.png'); expect('number_grid_7pt_300dpi.png', 1, ['bw'])
    # table image
    im = Image.new('L', (1654, 2339), 255); d = ImageDraw.Draw(im); f = ImageFont.truetype(FONT, 22)
    for r in range(50):
        y = 100 + r * 42; d.line([(80, y), (1570, y)], fill=0, width=2)
        for k in range(6): d.text((90 + k * 248, y + 8), words(2)[:14], font=f, fill=0)
    for k in range(7): d.line([(80 + k * 248, 100), (80 + k * 248, 100 + 49 * 42)], fill=0, width=2)
    im.save(f'{OUT}/table_200dpi.png'); expect('table_200dpi.png', 1, ['bw'])
    # scanned normal document inside a PDF
    scan = scan_like(text_size_px=int(10 / 72 * 200), size=(1654, 2339))
    buf = io.BytesIO(); scan.save(buf, 'JPEG', quality=75); buf.seek(0)
    c = canvas.Canvas(f'{OUT}/scanned_doc.pdf', pagesize=A4)
    for _ in range(2): c.drawImage(ImageReader(buf), 0, 0, W, H); c.showPage()
    c.save(); expect('scanned_doc.pdf', 2, ['bw', 'bw'])

# ---------- microtext ----------
def microtext_block(dpi, pt, size_in=(1.6, 0.6), color=0, rows=None):
    """Lines of microtext of font size `pt` points, rendered at `dpi`."""
    wpx, hpx = int(size_in[0] * dpi), int(size_in[1] * dpi)
    im = Image.new('L', (wpx, hpx), 255); d = ImageDraw.Draw(im)
    fpx = max(3, round(pt / 72 * dpi)); f = ImageFont.truetype(FONT, fpx)
    pitch = max(fpx + 1, round(pt * 1.15 / 72 * dpi))
    y, n = 0, 0
    while y + pitch <= hpx and (rows is None or n < rows):
        d.text((0, y), ('RESERVEBANKOFINDIA' * 40), font=f, fill=color); y += pitch; n += 1
    return im

def page_with(block, dpi, at=(0.15, 0.2), base=None):
    size = (int(8.27 * dpi), int(11.69 * dpi))
    page = base.copy() if base else Image.new('L', size, 255)
    page.paste(block, (int(size[0] * at[0]), int(size[1] * at[1])))
    return page

def micro():
    # PDF text
    c = canvas.Canvas(f'{OUT}/micro_pdf_blocked.pdf', pagesize=A4)
    body_text(c, lines=10)
    c.setFont('Helvetica', 1.2)
    for k in range(20): c.drawString(60, 400 - k * 1.5, 'RESERVE BANK OF INDIA ' * 6)
    c.showPage(); c.save(); expect('micro_pdf_blocked.pdf', 1, None, 'blocked')

    c = canvas.Canvas(f'{OUT}/micro_pdf_few.pdf', pagesize=A4)
    body_text(c); c.setFont('Helvetica', 1.5); c.drawString(300, 100, 'AUTHORISED SIGN')
    c.drawString(300, 98, 'AUTHORISED SIGN'); c.showPage(); c.save()
    expect('micro_pdf_few.pdf', 1, ['bw'], 'suspect')

    c = canvas.Canvas(f'{OUT}/micro_pdf_2_5pt.pdf', pagesize=A4)
    body_text(c, lines=20); c.setFont('Helvetica', 2.5)
    for k in range(8): c.drawString(60, 300 - k * 3, 'GOVERNMENT CERTIFICATE SECURITY LINE ' * 5)
    c.showPage(); c.save(); expect('micro_pdf_2_5pt.pdf', 1, ['bw'], 'suspect')

    c = canvas.Canvas(f'{OUT}/micro_pdf_rotated.pdf', pagesize=A4)
    body_text(c, lines=10); c.saveState(); c.translate(500, 100); c.rotate(90); c.setFont('Helvetica', 1.0)
    for k in range(12): c.drawString(0, -k * 1.2, 'SECURITY ' * 30)
    c.restoreState(); c.showPage(); c.save(); expect('micro_pdf_rotated.pdf', 1, ['bw'], 'blocked')

    c = canvas.Canvas(f'{OUT}/micro_pdf_light.pdf', pagesize=A4)
    body_text(c, lines=10); c.setFillGray(0.8); c.setFont('Helvetica', 1.4)
    for k in range(12): c.drawString(60, 300 - k * 1.7, 'PAY TO THE ORDER OF ' * 8)
    c.showPage(); c.save(); expect('micro_pdf_light.pdf', 1, ['bw'], 'blocked')

    # Raster microtext (images): always SUSPECT
    dpi = 300
    base = scan_like(text_size_px=int(10 / 72 * dpi), size=(int(8.27 * dpi), int(11.69 * dpi)))
    band = microtext_block(dpi, 2.0, size_in=(5.0, 0.12))       # thin band (≈4 lines)
    page_with(band, dpi, at=(0.1, 0.9), base=base).save(f'{OUT}/micro_img_band.png')
    expect('micro_img_band.png', 1, ['bw'], 'suspect')

    blk = microtext_block(dpi, 2.0, size_in=(1.5, 1.0))
    page_with(blk.rotate(90, expand=True, fillcolor=255), dpi).save(f'{OUT}/micro_img_rotated.png')
    expect('micro_img_rotated.png', 1, ['bw'], 'suspect')

    page_with(microtext_block(dpi, 2.2, size_in=(2.0, 0.5), color=170), dpi).save(f'{OUT}/micro_img_light.png')
    expect('micro_img_light.png', 1, ['bw'], 'suspect')

    sk = microtext_block(dpi, 2.5, size_in=(2.5, 0.8)).rotate(2, expand=True, fillcolor=255)
    page_with(sk, dpi).save(f'{OUT}/micro_img_skew.jpg', quality=85)
    expect('micro_img_skew.jpg', 1, ['bw'], 'suspect')

    dpi2 = 400  # a scanned cheque-like page inside a PDF
    page = page_with(microtext_block(dpi2, 1.8, size_in=(3.0, 0.4)), dpi2,
                     base=scan_like(text_size_px=int(10 / 72 * dpi2), size=(int(8.27 * dpi2), int(11.69 * dpi2))))
    buf = io.BytesIO(); page.save(buf, 'JPEG', quality=85); buf.seek(0)
    c = canvas.Canvas(f'{OUT}/micro_scan.pdf', pagesize=A4); c.drawImage(ImageReader(buf), 0, 0, W, H); c.showPage(); c.save()
    expect('micro_scan.pdf', 1, ['bw'], 'suspect')

    # too low resolution to hold readable microtext -> cannot be flagged
    low = microtext_block(300, 2.0, size_in=(3.0, 1.0)).resize((int(3.0 * 60), int(1.0 * 60)), Image.BILINEAR)
    page_with(low, 60).save(f'{OUT}/lowres_60dpi.png'); expect('lowres_60dpi.png', 1, ['bw'], 'ok')

# ---------- traps that must NOT be flagged ----------
def traps():
    dpi = 300
    size = (int(8.27 * dpi), int(11.69 * dpi))
    # QR codes
    page = Image.new('L', size, 255)
    for k, (x, y, box) in enumerate([(200, 200, 6), (1200, 200, 4), (200, 1500, 10), (1200, 1500, 3)]):
        q = qrcode.QRCode(box_size=box, border=2); q.add_data('upi://pay?pa=shop@upi&am=%d&tn=' % k + 'X' * 120); q.make()
        page.paste(q.make_image().convert('L'), (x, y))
    page.save(f'{OUT}/trap_qr.png'); expect('trap_qr.png', 1, ['bw'])
    # Barcodes
    page = Image.new('L', size, 255); d = ImageDraw.Draw(page)
    for row in range(6):
        x = 150
        while x < 2200:
            w = random.choice([2, 3, 4, 6, 8]); d.rectangle([x, 150 + row * 500, x + w, 450 + row * 500], fill=0)
            x += w + random.choice([2, 3, 4, 6])
    page.save(f'{OUT}/trap_barcode.png'); expect('trap_barcode.png', 1, ['bw'])
    # Halftone dots
    page = Image.new('L', size, 255); d = ImageDraw.Draw(page)
    for y in range(0, size[1], 8):
        for x in range(0, size[0], 8):
            r = 1 + 3 * (0.5 + 0.5 * math.sin(x / 300) * math.cos(y / 250))
            d.ellipse([x + 4 - r, y + 4 - r, x + 4 + r, y + 4 + r], fill=0)
    page.save(f'{OUT}/trap_halftone.png'); expect('trap_halftone.png', 1, ['bw'])
    # Hatching: diagonal + horizontal + crosshatch
    page = Image.new('L', size, 255); d = ImageDraw.Draw(page)
    for k in range(-size[1], size[0], 9): d.line([(k, 0), (k + size[1], size[1])], fill=0, width=2)
    page.crop((0, 0, size[0], size[1] // 3)).save(f'{OUT}/_tmp.png')
    for y in range(size[1] // 3, 2 * size[1] // 3, 10): d.rectangle([0, y, size[0], y + 3], fill=0) if False else d.line([(0, y), (size[0], y)], fill=0, width=3)
    for y in range(2 * size[1] // 3, size[1], 10):
        d.line([(0, y), (size[0], y)], fill=0, width=2)
    for x in range(0, size[0], 10):
        d.line([(x, 2 * size[1] // 3), (x, size[1])], fill=0, width=2)
    page.save(f'{OUT}/trap_hatching.png'); expect('trap_hatching.png', 1, ['bw'])
    os.remove(f'{OUT}/_tmp.png')
    # Noise
    Image.effect_noise((1600, 2200), 90).save(f'{OUT}/trap_noise.png'); expect('trap_noise.png', 1, ['bw'])

# ---------- bad files ----------
def bad():
    c = canvas.Canvas(f'{OUT}/_plain.pdf', pagesize=A4); body_text(c); c.showPage(); c.save()
    subprocess.run(['qpdf', '--encrypt', 'user123', 'owner123', '256', '--', f'{OUT}/_plain.pdf', f'{OUT}/encrypted.pdf'], check=True)
    os.remove(f'{OUT}/_plain.pdf'); EXP['encrypted.pdf'] = {'error': 'encrypted'}
    with open(f'{OUT}/corrupt.pdf', 'wb') as f: f.write(b'%PDF-1.4\n' + os.urandom(3000))
    EXP['corrupt.pdf'] = {'error': 'corrupt'}
    with open(f'{OUT}/corrupt.jpg', 'wb') as f: f.write(b'\xff\xd8\xff\xe0' + os.urandom(2000))
    EXP['corrupt.jpg'] = {'error': 'corrupt'}
    Image.new('RGB', (50, 50), 'white').save(f'{OUT}/really_png.pdf', format='PNG'); EXP['really_png.pdf'] = {'error': 'mismatch'}
    import zipfile
    with zipfile.ZipFile(f'{OUT}/word_renamed.pdf', 'w') as z: z.writestr('word/document.xml', '<w/>')
    EXP['word_renamed.pdf'] = {'error': 'mismatch'}
    c = canvas.Canvas(f'{OUT}/too_many_pages.pdf', pagesize=A4)
    for k in range(201): c.drawString(100, 700, f'page {k}'); c.showPage()
    c.save(); EXP['too_many_pages.pdf'] = {'error': 'too_many_pages'}
    Image.new('L', (9000, 9000), 255).save(f'{OUT}/oversized.png'); EXP['oversized.png'] = {'error': 'oversized'}

import qrcode
for fn in (pdf_text, pdf_mixed, pdf_photo, pdf_gradient, images_colour, normal_docs, micro, traps, bad):
    fn(); print('made', fn.__name__, flush=True)
with open(f'{OUT}/expectations.json', 'w') as f: json.dump(EXP, f, indent=1)
print(len(EXP), 'fixtures')
