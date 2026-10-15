#!/usr/bin/env python3
"""
Print Shop Connector — the small program that runs on the shop computers.

It asks the website for paid files, prints them on this computer's printers,
waits until the printer has really finished, deletes the file, and reports back.

  * Run on one, two or all three shop computers at once — the website makes sure
    each file is printed only once and each printer does one job at a time.
  * Double-click to open the window. First time: enter the website address and
    the shop password, then choose which shop printer each local printer is.
  * Windows printing uses SumatraPDF.exe placed next to this program.
    Linux / Mac printing uses CUPS (lp / lpstat).

Command line (for testing; the owner never needs this):
  --headless                 run without a window
  --config PATH              settings file to use
  --server URL --password P  connect (headless)
  --name NAME                computer name to report
  --map "Local=Shop label"   link a local printer to a shop printer (repeatable)
  --fake-printers SPEC       simulated printers, e.g. "A:color,B,C:offline,D:jam"
  --fake-log PATH            where simulated printers record what they "printed"
  --poll SECONDS             how often to check for new files (default 3)
  --run-seconds N            stop after N seconds (tests)
"""
import argparse
import json
import os
import platform
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"
APP_NAME = "PrintShopConnector"
IS_WINDOWS = platform.system() == "Windows"
POLL_SECONDS = 3
HEARTBEAT_SECONDS = 15
QUEUE_DRAIN_TIMEOUT = 10 * 60  # seconds a printer may stay busy before we report a problem
MAX_PARALLEL = 3
NO_WINDOW = 0x08000000 if IS_WINDOWS else 0  # CREATE_NO_WINDOW: never flash a console


def app_dir():
    """Folder of the program (works for the .py file and the PyInstaller .exe)."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def default_config_path():
    if IS_WINDOWS:
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, APP_NAME, "config.json")
    return os.path.join(os.path.expanduser("~"), ".config", "printshop-connector", "config.json")


def computer_name():
    return os.environ.get("COMPUTERNAME") or socket.gethostname() or "Shop computer"


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
class Config:
    def __init__(self, path):
        self.path = path
        self.data = {"server": "", "token": "", "computer_name": computer_name(), "mapping": {}, "autostart": False}
        try:
            with open(path, "r", encoding="utf-8") as f:
                self.data.update(json.load(f))
        except Exception:
            pass

    def __getitem__(self, k):
        return self.data.get(k)

    def __setitem__(self, k, v):
        self.data[k] = v

    def save(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2)
        os.replace(tmp, self.path)


# --------------------------------------------------------------------------
# Website API
# --------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status, message, body=None):
        super().__init__(message)
        self.status = status
        self.body = body or {}


class Api:
    def __init__(self, server, token=""):
        self.server = normalise_url(server)
        self.token = token

    def _req(self, method, path, body=None, raw=False, timeout=30):
        url = self.server + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Owner-Key", self.token or "")
        req.add_header("User-Agent", f"PrintShopConnector/{VERSION}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = r.read()
                return payload if raw else json.loads(payload.decode() or "{}")
        except urllib.error.HTTPError as e:
            try:
                j = json.loads(e.read().decode() or "{}")
            except Exception:
                j = {}
            raise ApiError(e.code, j.get("error") or f"Website error {e.code}", j)
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
            raise ApiError(0, f"Cannot reach the website ({getattr(e, 'reason', e)}). Check the internet connection.")

    def login(self, password):
        r = self._req("POST", "/api/connector/login", {"password": password})
        self.token = r["token"]
        return r

    def heartbeat(self, name, printers):
        return self._req("POST", "/api/connector/heartbeat", {"computer": name, "version": VERSION, "printers": printers})

    def pending(self):
        return self._req("GET", "/api/connector/jobs")

    def claim(self, job_id, label, name):
        try:
            return self._req("POST", f"/api/connector/jobs/{job_id}/claim", {"printer_label": label, "computer": name})
        except ApiError as e:
            if e.status == 409:
                return e.body
            raise

    def download(self, job_id):
        return self._req("GET", f"/api/connector/jobs/{job_id}/file", raw=True, timeout=180)

    def complete(self, job_id, ok, name, label, error=None):
        return self._req("POST", f"/api/connector/jobs/{job_id}/complete",
                         {"ok": ok, "computer": name, "printer_label": label, "error": error})


def normalise_url(u):
    u = (u or "").strip().rstrip("/")
    if u and not u.startswith(("http://", "https://")):
        u = "https://" + u
    return u


# --------------------------------------------------------------------------
# Printer backends
# --------------------------------------------------------------------------
class PrintError(Exception):
    pass


def run(cmd, timeout=60):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW)


class WindowsBackend:
    """Windows printers via pywin32 (if bundled) or PowerShell; printing via SumatraPDF."""

    def __init__(self):
        try:
            import win32print  # noqa: F401
            self.w32 = win32print
        except Exception:
            self.w32 = None

    def sumatra(self):
        for name in ("SumatraPDF.exe", "SumatraPDF-3.5.2-64.exe", "SumatraPDF-3.5.2.exe"):
            p = os.path.join(app_dir(), name)
            if os.path.exists(p):
                return p
        return None

    def problem(self):
        if not self.sumatra():
            return ("SumatraPDF.exe is missing. Download the free portable SumatraPDF and put "
                    "SumatraPDF.exe in the same folder as this program, then restart it.")
        return None

    def list_printers(self):
        if self.w32:
            flags = self.w32.PRINTER_ENUM_LOCAL | self.w32.PRINTER_ENUM_CONNECTIONS
            return sorted({p[2] for p in self.w32.EnumPrinters(flags, None, 1)})
        r = run(["powershell", "-NoProfile", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"])
        return sorted({l.strip() for l in r.stdout.splitlines() if l.strip()})

    def status(self, name):
        """Returns (status, jobs_in_queue). status: ready | printing | offline | error"""
        if self.w32:
            try:
                h = self.w32.OpenPrinter(name)
                try:
                    info = self.w32.GetPrinter(h, 2)
                finally:
                    self.w32.ClosePrinter(h)
            except Exception:
                return "offline", 0
            st, attrs, jobs = info["Status"], info["Attributes"], info["cJobs"]
            if st & 0x80 or attrs & 0x400:  # PRINTER_STATUS_OFFLINE / ATTRIBUTE_WORK_OFFLINE
                return "offline", jobs
            if st & (0x2 | 0x8 | 0x10 | 0x40 | 0x100000):  # error, jam, paper out, paper problem, door open
                return "error", jobs
            return ("printing" if jobs or st & 0x400 else "ready"), jobs
        ps = ("$p = Get-Printer -Name '%s' -ErrorAction Stop; "
              "$j = @(Get-PrintJob -PrinterName '%s' -ErrorAction SilentlyContinue).Count; "
              "Write-Output (\"{0}|{1}|{2}\" -f [int]$p.PrinterStatus, $j, $p.WorkOffline)") % (
            name.replace("'", "''"), name.replace("'", "''"))
        try:
            r = run(["powershell", "-NoProfile", "-Command", ps], timeout=30)
            code, jobs, wo = r.stdout.strip().split("|")
            code, jobs = int(code), int(jobs)
        except Exception:
            return "offline", 0
        if code == 8 or wo.lower() == "true":
            return "offline", jobs
        if code in (2, 4, 5, 7):
            return "error", jobs
        return ("printing" if jobs or code == 11 else "ready"), jobs

    def print_file(self, path, printer, job):
        exe = self.sumatra()
        if not exe:
            raise PrintError("SumatraPDF.exe is missing next to the program")
        pages = f"{job['page_start']}-{job['page_end']}"
        settings = f"{pages},{job['copies']}x,{'monochrome' if job['monochrome'] else 'color'},fit"
        r = run([exe, "-print-to", printer, "-print-settings", settings, "-silent", path], timeout=300)
        if r.returncode != 0:
            raise PrintError(f"SumatraPDF could not print (code {r.returncode}) {r.stderr.strip()[:200]}")


class CupsBackend:
    """Linux / macOS printers through CUPS."""

    def problem(self):
        return None if shutil.which("lp") else "The 'lp' command (CUPS) was not found on this computer."

    def list_printers(self):
        r = run(["lpstat", "-e"])
        names = [l.strip() for l in r.stdout.splitlines() if l.strip()]
        if not names:
            r = run(["lpstat", "-p"])
            names = [l.split()[1] for l in r.stdout.splitlines() if l.startswith("printer ")]
        return sorted(set(names))

    def status(self, name):
        r = run(["lpstat", "-p", name])
        out = r.stdout.lower()
        jobs = len([l for l in run(["lpstat", "-o", name]).stdout.splitlines() if l.strip()])
        if r.returncode != 0 or "disabled" in out or "not accepting" in out:
            return "offline", jobs
        return ("printing" if jobs or "printing" in out else "ready"), jobs

    def print_file(self, path, printer, job):
        cmd = ["lp", "-d", printer, "-n", str(job["copies"]), "-o", "fit-to-page"]
        if job["file_kind"] == "pdf":
            cmd += ["-P", f"{job['page_start']}-{job['page_end']}"]
        if job["monochrome"]:
            cmd += ["-o", "ColorModel=Gray", "-o", "print-color-mode=monochrome"]
        r = run(cmd + [path], timeout=120)
        if r.returncode != 0:
            raise PrintError(f"lp failed: {r.stderr.strip()[:200]}")


class FakeBackend:
    """Simulated printers for automated tests. SPEC: "Name[:color][:offline][:jam][:slow=SECONDS]"."""

    def __init__(self, spec, log_path=None):
        self.p = {}
        for part in [s.strip() for s in spec.split(",") if s.strip()]:
            bits = part.split(":")
            opts = {"color": False, "offline": False, "jam": False, "slow": 1.5}
            for b in bits[1:]:
                if b.startswith("slow="):
                    opts["slow"] = float(b[5:])
                else:
                    opts[b] = True
            opts["busy_until"] = 0
            self.p[bits[0]] = opts
        self.log_path = log_path
        self.lock = threading.Lock()

    def problem(self):
        return None

    def list_printers(self):
        return sorted(self.p)

    def status(self, name):
        p = self.p.get(name)
        if not p or p["offline"]:
            return "offline", 0
        busy = p["jam"] and p["busy_until"] > 0 or time.time() < p["busy_until"]
        return ("printing" if busy else "ready"), (1 if busy else 0)

    def print_file(self, path, printer, job):
        p = self.p[printer]
        size = os.path.getsize(path)
        start = time.time()
        p["busy_until"] = float("inf") if p["jam"] else start + p["slow"]
        if self.log_path:
            with self.lock, open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"job": job["id"], "ticket": job["ticket"], "local": printer, "start": start,
                                    "end": start + (0 if p["jam"] else p["slow"]), "bytes": size,
                                    "monochrome": job["monochrome"], "pages": [job["page_start"], job["page_end"]],
                                    "copies": job["copies"], "pid": os.getpid()}) + "\n")


def make_backend(args):
    if args.fake_printers:
        return FakeBackend(args.fake_printers, args.fake_log)
    return WindowsBackend() if IS_WINDOWS else CupsBackend()


# --------------------------------------------------------------------------
# The engine: heartbeat, polling, dispatch, printing
# --------------------------------------------------------------------------
class Engine:
    def __init__(self, cfg, backend, log, poll=POLL_SECONDS):
        self.cfg = cfg
        self.backend = backend
        self.log = log
        self.poll = poll
        self.stop_evt = threading.Event()
        self.thread = None
        self.lock = threading.Lock()
        self.shop_printers = []          # from the website: [{label, color_capable, enabled}]
        self.local_status = {}           # local name -> (status, jobs)
        self.busy = {}                   # local name -> ticket being printed here
        self.last_done = {}              # local name -> time it last finished (for "longest idle")
        self.unreported = []             # completions the website hasn't confirmed yet
        self.last_heartbeat = 0
        self.connected = False
        self.tmp = os.path.join(tempfile.gettempdir(), APP_NAME)
        os.makedirs(self.tmp, exist_ok=True)
        self._clean_tmp()

    @property
    def name(self):
        return self.cfg["computer_name"] or computer_name()

    def api(self):
        return Api(self.cfg["server"], self.cfg["token"])

    def running(self):
        return self.thread is not None and self.thread.is_alive()

    def start(self):
        if self.running():
            return
        self.stop_evt.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        self.log("Started. Waiting for paid files…")

    def stop(self):
        self.stop_evt.set()
        self.log("Stopped. Files already printing will finish.")

    # ---- helpers ----
    def _clean_tmp(self):
        for f in os.listdir(self.tmp):
            try:
                os.remove(os.path.join(self.tmp, f))
            except OSError:
                pass

    def refresh_local_status(self):
        st = {}
        for name in self.backend.list_printers():
            try:
                st[name] = self.backend.status(name)
            except Exception:
                st[name] = ("offline", 0)
        with self.lock:
            self.local_status = st
        return st

    def heartbeat(self):
        st = self.refresh_local_status()
        mapping = self.cfg["mapping"] or {}
        printers = [{"local": n, "label": mapping.get(n) or None,
                     "status": "busy" if n in self.busy else st[n][0]} for n in st]
        r = self.api().heartbeat(self.name, printers)
        with self.lock:
            self.shop_printers = r.get("printers", [])
        self.connected = True
        self.last_heartbeat = time.time()
        return r

    # ---- main loop ----
    def _loop(self):
        backoff = self.poll
        while not self.stop_evt.is_set():
            try:
                if time.time() - self.last_heartbeat >= HEARTBEAT_SECONDS:
                    self.heartbeat()
                else:
                    self.refresh_local_status()
                self._retry_reports()
                self._dispatch()
                backoff = self.poll
            except ApiError as e:
                self.connected = False
                if e.status == 401:
                    self.log("The website refused this computer. Open Setup and enter the shop password again.")
                else:
                    self.log(str(e))
                backoff = min(60, backoff * 2)
            except Exception as e:  # never die silently
                self.log(f"Unexpected problem: {e}")
                traceback.print_exc()
                backoff = min(60, backoff * 2)
            self.stop_evt.wait(backoff)

    def _free_printers(self):
        """Local printers that are mapped, enabled on the website, ready, and not busy here."""
        mapping = self.cfg["mapping"] or {}
        shop = {p["label"]: p for p in self.shop_printers if p.get("enabled")}
        free = []
        with self.lock:
            for local, (status, jobs) in self.local_status.items():
                label = mapping.get(local)
                if not label or label not in shop or local in self.busy:
                    continue
                if status in ("offline", "error"):
                    continue
                if jobs > 0:  # something is still in this printer's queue
                    continue
                free.append({"local": local, "label": label, "color": bool(shop[label]["color_capable"]),
                             "idle_since": self.last_done.get(local, 0)})
        return free

    def _dispatch(self):
        if len(self.busy) >= MAX_PARALLEL:
            return
        free = self._free_printers()
        if not free:
            return
        jobs = self.api().pending()
        for job in jobs:
            if not free or len(self.busy) >= MAX_PARALLEL:
                break
            if job["needs_color"]:
                candidates = sorted([p for p in free if p["color"]], key=lambda p: p["idle_since"])
            else:  # B&W: black-and-white printers first, colour printers only if they are busy
                candidates = sorted([p for p in free if not p["color"]], key=lambda p: p["idle_since"]) + \
                             sorted([p for p in free if p["color"]], key=lambda p: p["idle_since"])
            for p in candidates:
                r = self.api().claim(job["id"], p["label"], self.name)
                if r.get("claimed"):
                    free.remove(p)
                    self._start_print(r["job"], p)
                    break
                reason = r.get("reason")
                if reason in ("printer_busy", "printer_not_color", "printer_unavailable"):
                    free.remove(p)  # busy at another computer: try the next capable printer
                    continue
                break  # job_taken: another computer got it — move to the next job

    def _start_print(self, job, p):
        with self.lock:
            self.busy[p["local"]] = job["ticket"]
        threading.Thread(target=self._print_job, args=(job, p), daemon=True).start()

    def _print_job(self, job, p):
        local, label = p["local"], p["label"]
        path = os.path.join(self.tmp, f"job{job['id']}.{job['file_kind']}")
        ok, error = False, None
        self.log(f"{job['ticket']}: printing on {label} ({local}) — {job['file_name']}")
        try:
            data = self.api().download(job["id"])
            with open(path, "wb") as f:
                f.write(data)
            self.backend.print_file(path, local, job)
            ok, error = self._wait_until_printed(local)
        except ApiError as e:
            error = f"Download failed: {e}"
        except PrintError as e:
            error = str(e)
        except Exception as e:
            error = f"Unexpected printing problem: {e}"
        finally:
            try:
                if os.path.exists(path):
                    os.remove(path)  # customer files never stay on this computer
            except OSError:
                pass
        if not ok:
            error = (error or "Printing failed") + f" [printer {label}, computer {self.name}]"
        self.log(f"{job['ticket']}: {'done ✓' if ok else 'FAILED — ' + error}")
        with self.lock:
            self.busy.pop(local, None)
            self.last_done[local] = time.time()
        self._report(job["id"], ok, label, error)

    def _wait_until_printed(self, local):
        """Done only when the printer's own queue is empty (twice in a row)."""
        time.sleep(1.0)
        start = time.time()
        empty = 0
        while time.time() - start < QUEUE_DRAIN_TIMEOUT:
            status, jobs = self.backend.status(local)
            if status == "offline" and time.time() - start > 60:
                return False, "The printer went offline while printing. The file may still print once it is back on."
            empty = empty + 1 if jobs == 0 and status != "printing" else 0
            if empty >= 2:
                return True, None
            if self.stop_evt.is_set() and time.time() - start > 30:
                pass  # keep waiting: we never abandon a job mid-print
            time.sleep(2)
        waited = f"{round(QUEUE_DRAIN_TIMEOUT / 60)} minutes" if QUEUE_DRAIN_TIMEOUT >= 120 else f"{int(QUEUE_DRAIN_TIMEOUT)} seconds"
        return False, (f"The printer was still busy after {waited} (paper jam, no paper or toner?). "
                       "The file may still print once the problem is fixed — check before retrying.")

    def _report(self, job_id, ok, label, error):
        try:
            self.api().complete(job_id, ok, self.name, label, error)
        except ApiError as e:
            if e.status == 409:
                return  # owner already retried/cancelled it
            self.unreported.append((job_id, ok, label, error))

    def _retry_reports(self):
        pending, self.unreported = self.unreported, []
        for item in pending:
            self._report(*item)


# --------------------------------------------------------------------------
# Start with Windows
# --------------------------------------------------------------------------
def set_autostart(enabled):
    if not IS_WINDOWS:
        return False
    import winreg
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
    try:
        if enabled:
            if getattr(sys, "frozen", False):
                cmd = f'"{sys.executable}" --minimized'
            else:
                pyw = sys.executable.replace("python.exe", "pythonw.exe")
                cmd = f'"{pyw}" "{os.path.abspath(__file__)}" --minimized'
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, cmd)
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass
    finally:
        winreg.CloseKey(key)
    return True


# --------------------------------------------------------------------------
# The window
# --------------------------------------------------------------------------
def run_gui(cfg, backend, args):
    import tkinter as tk
    from tkinter import ttk, messagebox

    PAPER, INK, RED, OK = "#fbf8f1", "#1d2a48", "#c23b2e", "#2f6b45"
    logq = queue.Queue()

    def log(msg):
        logq.put(time.strftime("%H:%M:%S ") + msg)

    engine = Engine(cfg, backend, log, poll=args.poll)
    root = tk.Tk()
    root.title("Print Shop Connector")
    root.geometry("720x600")
    root.minsize(520, 480)
    root.configure(bg=PAPER)
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure(".", background=PAPER, foreground=INK, font=("Segoe UI", 10))
    style.configure("TLabel", background=PAPER, foreground=INK)
    style.configure("Head.TLabel", font=("Consolas", 13, "bold"))
    style.configure("Big.TButton", font=("Segoe UI", 11, "bold"), padding=8)
    style.configure("TCheckbutton", background=PAPER)
    style.configure("TLabelframe", background=PAPER)
    style.configure("TLabelframe.Label", background=PAPER, foreground=INK, font=("Segoe UI", 10, "bold"))

    top = ttk.Frame(root, padding=12)
    top.pack(fill="both", expand=True)

    status_var = tk.StringVar(value="Not connected")
    ttk.Label(top, text="PRINT SHOP CONNECTOR", style="Head.TLabel").pack(anchor="w")
    status_lbl = tk.Label(top, textvariable=status_var, bg=PAPER, fg=RED, font=("Segoe UI", 11, "bold"), anchor="w")
    status_lbl.pack(fill="x", pady=(2, 8))

    warn = backend.problem()
    if warn:
        tk.Label(top, text="⚠ " + warn, bg="#f6dcd6", fg=RED, wraplength=590, justify="left",
                 font=("Segoe UI", 10, "bold"), padx=8, pady=6).pack(fill="x", pady=(0, 8))

    # --- connection ---
    conn = ttk.LabelFrame(top, text=" 1. Website ", padding=8)
    conn.pack(fill="x")
    ttk.Label(conn, text="Website address").grid(row=0, column=0, sticky="w")
    server_var = tk.StringVar(value=cfg["server"] or "")
    ttk.Entry(conn, textvariable=server_var, width=40).grid(row=0, column=1, sticky="we", padx=6)
    ttk.Label(conn, text="Shop password").grid(row=1, column=0, sticky="w", pady=(6, 0))
    pw_var = tk.StringVar()
    ttk.Entry(conn, textvariable=pw_var, show="•", width=40).grid(row=1, column=1, sticky="we", padx=6, pady=(6, 0))
    ttk.Label(conn, text="This computer").grid(row=2, column=0, sticky="w", pady=(6, 0))
    name_var = tk.StringVar(value=cfg["computer_name"] or computer_name())
    ttk.Entry(conn, textvariable=name_var, width=40).grid(row=2, column=1, sticky="we", padx=6, pady=(6, 0))
    conn.columnconfigure(1, weight=1)

    def connect():
        server = normalise_url(server_var.get())
        if not server:
            return messagebox.showwarning("Website", "Enter the website address, e.g. myshop.in")
        cfg["server"] = server
        cfg["computer_name"] = name_var.get().strip() or computer_name()
        try:
            if pw_var.get():
                api = Api(server)
                api.login(pw_var.get())
                cfg["token"] = api.token
                pw_var.set("")
            cfg.save()
            engine.heartbeat()
            build_printer_rows()
            log("Connected to the website ✓")
        except ApiError as e:
            messagebox.showerror("Could not connect", str(e))
    ttk.Button(conn, text="Connect", command=connect).grid(row=0, column=2, rowspan=3, padx=(6, 0), sticky="ns")

    # --- printers ---
    pf = ttk.LabelFrame(top, text=" 2. Which shop printer is each printer on this computer? ", padding=8)
    pf.pack(fill="x", pady=8)
    rows_frame = ttk.Frame(pf)
    rows_frame.pack(fill="x")
    printer_widgets = {}  # local -> (combo var, status label)
    NOT_USED = "— not used —"

    def save_mapping(*_):
        mapping = {}
        used = set()
        for local, (var, _lbl) in printer_widgets.items():
            v = var.get()
            if v and v != NOT_USED:
                if v in used:
                    messagebox.showwarning("Printers", f"“{v}” is chosen twice. Each shop printer can be linked to only one printer here.")
                    var.set(NOT_USED)
                    continue
                used.add(v)
                mapping[local] = v
        cfg["mapping"] = mapping
        cfg.save()

    def build_printer_rows():
        for w in rows_frame.winfo_children():
            w.destroy()
        printer_widgets.clear()
        labels = [NOT_USED] + [p["label"] + ("" if p.get("enabled") else " (off)") for p in engine.shop_printers]
        values = [NOT_USED] + [p["label"] for p in engine.shop_printers]
        try:
            locals_ = backend.list_printers()
        except Exception as e:
            locals_ = []
            log(f"Could not list printers: {e}")
        if not locals_:
            ttk.Label(rows_frame, text="No printers found on this computer.").pack(anchor="w")
        mapping = cfg["mapping"] or {}
        for i, local in enumerate(locals_):
            ttk.Label(rows_frame, text=local, width=30).grid(row=i, column=0, sticky="w", pady=2)
            var = tk.StringVar(value=mapping.get(local, NOT_USED) if mapping.get(local) in values else NOT_USED)
            cb = ttk.Combobox(rows_frame, textvariable=var, values=values, state="readonly", width=26)
            cb.grid(row=i, column=1, padx=6, pady=2)
            cb.bind("<<ComboboxSelected>>", save_mapping)
            st = tk.Label(rows_frame, text="…", bg=PAPER, fg=INK, width=10, anchor="w", font=("Consolas", 10, "bold"))
            st.grid(row=i, column=2, sticky="w")
            printer_widgets[local] = (var, st)
        del labels

    # --- controls ---
    ctl = ttk.Frame(top)
    ctl.pack(fill="x", pady=(0, 6))
    run_btn = ttk.Button(ctl, text="▶ Start printing", style="Big.TButton")
    run_btn.pack(side="left")
    auto_var = tk.BooleanVar(value=bool(cfg["autostart"]))

    def toggle_auto():
        cfg["autostart"] = auto_var.get()
        cfg.save()
        if not set_autostart(auto_var.get()) and auto_var.get():
            log("Start-with-Windows is only available on Windows.")
    ttk.Checkbutton(ctl, text="Start with Windows (and start printing automatically)", variable=auto_var,
                    command=toggle_auto).pack(side="left", padx=12)

    def toggle_run():
        if engine.running() and not engine.stop_evt.is_set():
            engine.stop()
        else:
            if not cfg["token"] or not cfg["server"]:
                return messagebox.showinfo("Setup", "First enter the website address and shop password, then press Connect.")
            if not cfg["mapping"]:
                return messagebox.showinfo("Printers", "Choose which shop printer each printer is (step 2).")
            engine.start()
    run_btn.configure(command=toggle_run)

    # --- log ---
    lf = ttk.LabelFrame(top, text=" Activity ", padding=4)
    lf.pack(fill="both", expand=True)
    logbox = tk.Text(lf, height=10, bg="white", fg=INK, font=("Consolas", 9), relief="flat", state="disabled", wrap="word")
    logbox.pack(fill="both", expand=True)

    COLORS = {"ready": OK, "printing": INK, "busy": INK, "offline": RED, "error": RED}

    def tick():
        while not logq.empty():
            line = logq.get_nowait()
            logbox.configure(state="normal")
            logbox.insert("end", line + "\n")
            logbox.see("end")
            if int(logbox.index("end-1c").split(".")[0]) > 500:
                logbox.delete("1.0", "100.0")
            logbox.configure(state="disabled")
        with engine.lock:
            st = dict(engine.local_status)
            busy = dict(engine.busy)
        for local, (_var, lbl) in printer_widgets.items():
            s = "busy" if local in busy else st.get(local, ("…", 0))[0]
            lbl.configure(text=s.upper(), fg=COLORS.get(s, INK))
        running = engine.running() and not engine.stop_evt.is_set()
        run_btn.configure(text="■ Stop printing" if running else "▶ Start printing")
        if running and engine.connected:
            status_var.set(f"Printing is ON · connected as {engine.name}")
            status_lbl.configure(fg=OK)
        elif running:
            status_var.set("Printing is ON · trying to reach the website…")
            status_lbl.configure(fg=RED)
        else:
            status_var.set("Printing is OFF" + (" · connected" if engine.connected else ""))
            status_lbl.configure(fg=RED)
        root.after(1000, tick)

    def periodic_status():
        if not engine.running():
            threading.Thread(target=lambda: _safe(engine.refresh_local_status), daemon=True).start()
        root.after(10000, periodic_status)

    def _safe(fn):
        try:
            fn()
        except Exception:
            pass

    def on_close():
        if busy_now() and not messagebox.askyesno("Close", "Files are printing right now. Close anyway?"):
            return
        engine.stop()
        root.destroy()

    def busy_now():
        with engine.lock:
            return bool(engine.busy)
    root.protocol("WM_DELETE_WINDOW", on_close)

    # initial state
    if cfg["server"] and cfg["token"]:
        try:
            engine.heartbeat()
            log("Connected to the website ✓")
        except ApiError as e:
            log(str(e))
    build_printer_rows()
    if cfg["autostart"] or args.minimized:
        if cfg["token"] and cfg["mapping"]:
            engine.start()
        if args.minimized:
            root.iconify()
    if warn:
        log(warn)
    tick()
    periodic_status()
    if args.run_seconds:
        root.after(int(args.run_seconds * 1000), root.destroy)
    root.mainloop()


# --------------------------------------------------------------------------
# Headless mode (tests / advanced)
# --------------------------------------------------------------------------
def run_headless(cfg, backend, args):
    def log(msg):
        print(time.strftime("%H:%M:%S ") + f"[{cfg['computer_name']}] " + msg, flush=True)

    if args.password:
        api = Api(cfg["server"])
        api.login(args.password)
        cfg["token"] = api.token
    problem = backend.problem()
    if problem:
        log("WARNING: " + problem)
    engine = Engine(cfg, backend, log, poll=args.poll)
    engine.heartbeat()
    engine.start()
    end = time.time() + args.run_seconds if args.run_seconds else None
    try:
        while not end or time.time() < end:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    engine.stop()
    # let in-flight prints finish (they always report back)
    deadline = time.time() + 30
    while engine.busy and time.time() < deadline:
        time.sleep(0.5)


def main():
    ap = argparse.ArgumentParser(description="Print Shop Connector")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--minimized", action="store_true")
    ap.add_argument("--config")
    ap.add_argument("--server")
    ap.add_argument("--password")
    ap.add_argument("--name")
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--fake-printers")
    ap.add_argument("--fake-log")
    ap.add_argument("--poll", type=float, default=POLL_SECONDS)
    ap.add_argument("--run-seconds", type=float, default=0)
    ap.add_argument("--drain-timeout", type=float)
    args = ap.parse_args()

    global QUEUE_DRAIN_TIMEOUT
    if args.drain_timeout:
        QUEUE_DRAIN_TIMEOUT = args.drain_timeout

    cfg = Config(args.config or default_config_path())
    if args.server:
        cfg["server"] = normalise_url(args.server)
    if args.name:
        cfg["computer_name"] = args.name
    if args.map:
        cfg["mapping"] = dict(m.split("=", 1) for m in args.map)
    backend = make_backend(args)
    if args.headless:
        run_headless(cfg, backend, args)
    else:
        run_gui(cfg, backend, args)


if __name__ == "__main__":
    main()
