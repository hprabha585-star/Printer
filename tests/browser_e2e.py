"""
Browser test of the customer page and owner dashboard (developer use).
Needs: pip install playwright && playwright install chromium, and a running server
(started by this script) with a fresh test database.
  DB_USER=.. DB_PASSWORD=.. DB_NAME=printshop_test python3 tests/browser_e2e.py [screenshot_dir]
"""
import os, subprocess, sys, time, json, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, 'tests', 'fixtures', 'out')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'tests', 'screens')
os.makedirs(SHOTS, exist_ok=True)
PORT = 3871
BASE = f'http://127.0.0.1:{PORT}'
MASTER = 'test-master-key-123'
env = dict(os.environ, NODE_ENV='test', OWNER_MASTER_KEY=MASTER, PORT=str(PORT), STORAGE_DIR='/tmp/printshop-e2e-storage')

# fresh database
subprocess.run(['node', '-e', """
const db=require('./src/db');(async()=>{for(const t of await db.q('SHOW TABLES'))await db.q('DROP TABLE `'+Object.values(t)[0]+'`');await db.close();})()"""],
               cwd=ROOT, env=env, check=True)
server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        urllib.request.urlopen(BASE + '/api/settings'); break
    except Exception:
        time.sleep(0.2)

errors = []
ok = True
def check(cond, what):
    global ok
    print(('PASS ' if cond else 'FAIL ') + what)
    ok = ok and cond

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        # ---------- owner first-time setup ----------
        o = b.new_page(viewport={'width': 1280, 'height': 900})
        o.on('pageerror', lambda e: errors.append('owner: ' + str(e)))
        o.goto(BASE + '/owner')
        o.click('#toggleMaster'); o.fill('#lMaster', MASTER); o.click('#loginForm button')
        o.wait_for_selector('#setup:not(.hidden)')
        o.fill('#sUser', 'ravi'); o.fill('#sPass', 'xerox-2024!'); o.fill('#sPass2', 'xerox-2024!'); o.click('#setupForm button')
        o.wait_for_selector('#dash:not(.hidden)')
        o.click('[data-tab=settings]')
        o.fill('#fShop', 'Sri Lakshmi Xerox'); o.fill('#fUpi', 'srilakshmi@okaxis'); o.fill('#fPayee', 'Sri Lakshmi Xerox')
        o.fill('#fBw', '2'); o.fill('#fPartial', '5'); o.fill('#fFull', '10')
        o.click('#settingsForm button'); o.wait_for_selector('#settingsMsg.ok')
        check('Saved' in o.inner_text('#settingsMsg'), 'owner: settings saved')

        # ---------- customer on a phone ----------
        c = b.new_page(viewport={'width': 390, 'height': 844}, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')
        c.on('pageerror', lambda e: errors.append('customer: ' + str(e)))
        c.goto(BASE + '/')
        expect(c.locator('#shopName')).to_have_text('Sri Lakshmi Xerox')
        c.screenshot(path=f'{SHOTS}/1-customer-empty.png', full_page=True)
        c.set_input_files('#fileInput', os.path.join(FIX, 'mixed.pdf'))
        c.wait_for_selector('#editor:not(.hidden)')
        check('4 pages' in c.inner_text('#edPages'), 'customer: page count shown')
        c.click('[data-mode=color]'); c.fill('#edCopies', '2')
        c.locator('#edCopies').dispatch_event('input')
        check(c.inner_text('#edPrice') == '₹38.00', f"customer: live colour price ₹38.00 (got {c.inner_text('#edPrice')})")
        check('1 partial colour, 1 full colour, x2' in c.inner_text('#edBreak'), 'customer: price breakdown')
        c.fill('#edEnd', '9'); c.locator('#edEnd').dispatch_event('blur')
        check(c.input_value('#edEnd') == '4', 'customer: end page clamped to the real page count')
        c.screenshot(path=f'{SHOTS}/2-customer-options.png')
        c.click('#edSave')
        # add the same document again in B&W
        c.click('[data-act=again]'); c.click('[data-mode=bw]'); c.fill('#edCopies', '1'); c.locator('#edCopies').dispatch_event('input'); c.click('#edSave')
        check(c.locator('#cart .line').count() == 2, 'customer: same document added twice')
        check(c.inner_text('#cartTotal') == '₹46.00', f"customer: cart total ₹46.00 (got {c.inner_text('#cartTotal')})")
        # edit + remove
        c.locator('[data-act=edit]').nth(1).click(); c.fill('#edStart', '2'); c.fill('#edEnd', '3'); c.locator('#edEnd').dispatch_event('input'); c.click('#edSave')
        check(c.inner_text('#cartTotal') == '₹42.00', f"customer: edited total ₹42.00 (got {c.inner_text('#cartTotal')})")
        c.set_input_files('#fileInput', os.path.join(FIX, 'photo.jpg')); c.wait_for_selector('#editor:not(.hidden)'); c.click('#edSave')
        c.once('dialog', lambda d: d.accept()); c.locator('[data-act=remove]').nth(2).click()
        check(c.locator('#cart .line').count() == 2, 'customer: remove works')
        # office file and blocked file messages
        c.set_input_files('#fileInput', {'name': 'letter.docx', 'mimeType': 'application/octet-stream', 'buffer': b'PK\x03\x04xx'})
        check('saved as PDF' in c.inner_text('#fileErr'), 'customer: Word file → "Save as PDF" message')
        c.set_input_files('#fileInput', os.path.join(FIX, 'micro_pdf_blocked.pdf'))
        c.wait_for_selector('#fileErr:not(.hidden)')
        c.wait_for_function("document.querySelector('#fileErr').textContent.includes('Micro-printing') || document.querySelector('#fileErr').textContent.includes('small text')")
        check('cannot be printed' in c.inner_text('#fileErr'), 'customer: micro-printing file rejected with a clear message')
        c.screenshot(path=f'{SHOTS}/3-customer-cart.png', full_page=True)
        c.click('#toPay'); c.wait_for_selector('#step2:not(.hidden)')
        href = c.get_attribute('#upiAny', 'href')
        check(href.startswith('upi://pay?pa=srilakshmi%40okaxis') and 'am=42.00' in href and 'cu=INR' in href and 'tn=PX-' in href, 'customer: UPI link with UPI ID, exact amount, INR and token: ' + href)
        check(c.get_attribute('#upiPhonepe', 'href').startswith('phonepe://pay?'), 'customer: PhonePe button')
        check(c.locator('#payQr svg').count() == 1, 'customer: QR code shown')
        c.fill('#utr', '12345'); check(c.is_disabled('#sendUtr'), 'customer: short UTR blocked')
        c.fill('#utr', 'ab12345678901234'); check(c.input_value('#utr') == '123456789012', 'customer: UTR keeps digits only, max 12')
        c.locator('#utr').dispatch_event('input')
        c.screenshot(path=f'{SHOTS}/4-customer-pay.png', full_page=True)
        c.click('#sendUtr'); c.wait_for_selector('#step3:not(.hidden)')
        check('checking' in c.inner_text('#stOverall').lower(), 'customer: status "shop checking UPI"')
        c.screenshot(path=f'{SHOTS}/5-customer-status.png', full_page=True)

        # ---------- owner confirms ----------
        o.click('[data-tab=today]')
        o.wait_for_selector('[data-confirm]')
        check('123456789012' in o.inner_text('#attention'), 'owner: UTR shown in attention panel')
        o.screenshot(path=f'{SHOTS}/6-owner-today.png', full_page=True)
        o.click('[data-confirm]')
        o.wait_for_function("!document.querySelector('[data-confirm]')")
        c.wait_for_function("document.querySelector('#stOverall').textContent === 'In queue'", timeout=15000)
        check(True, 'customer: status auto-refreshed to "In queue"')
        o.click('[data-tab=files]'); o.wait_for_selector('#jobsTable tbody tr')
        check(o.locator('#jobsTable tbody tr').count() == 2, 'owner: recent files table')
        o.screenshot(path=f'{SHOTS}/7-owner-files.png', full_page=True)
        o.click('[data-tab=printers]'); o.wait_for_selector('.prow')
        o.screenshot(path=f'{SHOTS}/8-owner-printers.png', full_page=True)
        o.click('[data-tab=qr]'); check(o.locator('#shopQr svg').count() == 1, 'owner: shop QR poster')
        o.screenshot(path=f'{SHOTS}/9-owner-qr.png', full_page=True)
        # phone layout of the dashboard
        m = b.new_page(viewport={'width': 390, 'height': 844})
        m.on('pageerror', lambda e: errors.append('owner-mobile: ' + str(e)))
        m.goto(BASE + '/owner')
        m.fill('#lUser', 'ravi'); m.fill('#lPass', 'xerox-2024!'); m.click('#loginForm button')
        m.wait_for_selector('#dash:not(.hidden)'); m.click('[data-tab=files]'); m.wait_for_selector('#jobsTable tbody tr')
        check(m.evaluate("getComputedStyle(document.querySelector('#jobsTable tr')).display") == 'block', 'owner (phone): table rows become cards')
        m.screenshot(path=f'{SHOTS}/10-owner-phone.png', full_page=True)
        b.close()
finally:
    server.terminate()

check(not errors, 'no JavaScript errors ' + json.dumps(errors))
print('BROWSER:', 'all passed' if ok else 'FAILURES')
sys.exit(0 if ok else 1)
