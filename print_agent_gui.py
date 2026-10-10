#!/usr/bin/env python3
"""
print_agent_gui.py
--------------------------------------------------------------------------
A simple desktop app for the shop PC. No command line needed after setup.

What the shop owner does:
  1. Double-click this file (or the .exe built from it — see BUILD_EXE.md).
  2. Type in the website address and the connector password (given once by
     the developer), click "Connect", and leave the window open.
  3. It shows a friendly log of jobs as they print. That's the whole job.

Settings are remembered in "printshop_config.json" next to this file, so
step 2 only has to be done once.

For developers: this intentionally duplicates (rather than imports) the
polling/printing logic from print_agent.py, so this single file can be
frozen into a standalone .exe with PyInstaller with no other project files
needed on the shop PC. See BUILD_EXE.md.
--------------------------------------------------------------------------
"""

import os
import sys
import json
import time
import queue
import platform
import subprocess
import threading
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Config file (lives next to this script / the .exe, so it's easy to find)
# ---------------------------------------------------------------------------
def app_dir():
    if getattr(sys, "frozen", False):  # running as a PyInstaller .exe
        return Path(sys.executable).parent
    return Path(__file__).parent

CONFIG_PATH = app_dir() / "printshop_config.json"
DOWNLOAD_DIR = app_dir() / "downloads"
POLL_INTERVAL_SECONDS = 5


def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Printing (same approach as print_agent.py, kept self-contained here)
# ---------------------------------------------------------------------------
def print_file(file_path: Path, copies: int, log):
    system = platform.system()

    if system == "Windows":
        # Uses the file's default app's "print" verb — no extra installs
        # needed. Prints to whichever printer is set as the Windows default.
        for i in range(copies):
            os.startfile(str(file_path), "print")  # noqa: S606 (Windows only)
            time.sleep(3)

    elif system in ("Linux", "Darwin"):
        cmd = ["lp", "-n", str(copies), str(file_path)]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"lp command failed: {result.stderr.strip()}")

    else:
        raise RuntimeError(f"Unsupported operating system: {system}")


# ---------------------------------------------------------------------------
# Background worker: polls the server, downloads and prints jobs
# ---------------------------------------------------------------------------
class PrintWorker(threading.Thread):
    def __init__(self, server_url, owner_key, log_queue, stop_event):
        super().__init__(daemon=True)
        self.server_url = server_url.rstrip("/")
        self.owner_key = owner_key
        self.log_queue = log_queue
        self.stop_event = stop_event

    def log(self, msg):
        self.log_queue.put(msg)

    def headers(self):
        return {"x-owner-key": self.owner_key}

    def run(self):
        self.log("🔌 Connecting to " + self.server_url + " ...")
        first_check_ok = self._check_connection()
        if not first_check_ok:
            return  # error already logged by _check_connection

        self.log("✅ Connected. Watching for new print jobs every 5 seconds ...")
        while not self.stop_event.is_set():
            try:
                self._poll_once()
            except Exception as e:
                self.log(f"⚠️ Unexpected error: {e}")
            self.stop_event.wait(POLL_INTERVAL_SECONDS)
        self.log("⏹️ Stopped.")

    def _check_connection(self):
        try:
            resp = requests.get(f"{self.server_url}/api/orders/pending", headers=self.headers(), timeout=15)
            if resp.status_code == 401:
                self.log("❌ Password not accepted. Double-check it with your developer and try again.")
                return False
            resp.raise_for_status()
            return True
        except requests.RequestException as e:
            self.log(f"❌ Could not reach that address. Check the website address and your internet connection. ({e})")
            return False

    def _poll_once(self):
        try:
            resp = requests.get(f"{self.server_url}/api/orders/pending", headers=self.headers(), timeout=15)
            if resp.status_code == 401:
                self.log("❌ Password stopped working (was it changed?). Reconnect with the current password.")
                self.stop_event.set()
                return
            resp.raise_for_status()
            items = resp.json()
        except requests.RequestException:
            self.log("⚠️ Server not reachable right now, will try again shortly ...")
            return

        for item in items:
            self._handle_item(item)

    def _handle_item(self, item):
        # Each order can contain several files; every file shows up here as
        # its own entry, sharing the order's token (e.g. "PX-4821").
        token = item.get("orderTokenId", item["_id"])
        file_name = item["fileName"]
        copies = item.get("copies", 1)
        self.log(f"🖨️  Printing {token} — {file_name} ({item['printType'].upper()}, {copies}x) ...")

        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        local_path = DOWNLOAD_DIR / f"{item['_id']}_{file_name}"

        try:
            with requests.get(item["fileUrl"], stream=True, timeout=60) as r:
                r.raise_for_status()
                with open(local_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
        except Exception as e:
            self.log(f"❌ Could not download {token}: {e}")
            self._report(item["_id"], "failed", f"Download error: {e}")
            return

        try:
            print_file(local_path, copies, self.log)
            self.log(f"✅ Printed {token} — {file_name}")
            self._report(item["_id"], "completed")
        except Exception as e:
            self.log(f"❌ Printer error on {token}: {e}")
            self._report(item["_id"], "failed", f"Print error: {e}")

    def _report(self, item_id, status, error=None):
        body = {"status": status}
        if error:
            body["error"] = str(error)[:500]
        try:
            requests.post(f"{self.server_url}/api/order-items/{item_id}/complete", headers=self.headers(), json=body, timeout=15)
        except requests.RequestException:
            self.log("⚠️ Printed, but could not tell the website — it will retry showing this file.")


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------
class App:
    def __init__(self, root):
        self.root = root
        self.root.title("Print Shop Connector")
        self.root.geometry("560x520")
        self.root.minsize(480, 440)

        self.log_queue = queue.Queue()
        self.stop_event = threading.Event()
        self.worker = None

        cfg = load_config()

        pad = {"padx": 14, "pady": 6}

        header = tk.Label(root, text="🖨  Print Shop Connector", font=("Segoe UI", 16, "bold"))
        header.pack(anchor="w", **pad)

        sub = tk.Label(
            root,
            text="Keeps this computer connected to your print shop website so\norders can print automatically. Leave this window open while the shop is open.",
            justify="left", fg="#555",
        )
        sub.pack(anchor="w", padx=14)

        form = tk.Frame(root)
        form.pack(fill="x", **pad)
        form.columnconfigure(1, weight=1)

        tk.Label(form, text="Website address:").grid(row=0, column=0, sticky="w", pady=4)
        self.server_entry = tk.Entry(form)
        self.server_entry.grid(row=0, column=1, sticky="ew", pady=4)
        self.server_entry.insert(0, cfg.get("server_url", "https://"))

        tk.Label(form, text="Connector password:").grid(row=1, column=0, sticky="w", pady=4)
        pw_frame = tk.Frame(form)
        pw_frame.grid(row=1, column=1, sticky="ew", pady=4)
        pw_frame.columnconfigure(0, weight=1)
        self.key_entry = tk.Entry(pw_frame, show="•")
        self.key_entry.grid(row=0, column=0, sticky="ew")
        self.key_entry.insert(0, cfg.get("owner_key", ""))
        self.show_var = tk.BooleanVar(value=False)
        tk.Checkbutton(
            pw_frame, text="show", variable=self.show_var, command=self.toggle_show
        ).grid(row=0, column=1, padx=(6, 0))

        self.autostart_var = tk.BooleanVar(value=cfg.get("autostart", False))
        autostart_check = tk.Checkbutton(
            root, text="Start automatically when this computer turns on (Windows)",
            variable=self.autostart_var,
        )
        autostart_check.pack(anchor="w", padx=14)
        if platform.system() != "Windows":
            autostart_check.config(state="disabled")

        btn_frame = tk.Frame(root)
        btn_frame.pack(fill="x", **pad)
        self.connect_btn = tk.Button(btn_frame, text="Connect", command=self.toggle_connection, bg="#A6291B", fg="white", font=("Segoe UI", 11, "bold"), padx=16, pady=6)
        self.connect_btn.pack(side="left")

        self.status_label = tk.Label(root, text="● Not connected", fg="#888", font=("Segoe UI", 10, "bold"))
        self.status_label.pack(anchor="w", padx=14)

        tk.Label(root, text="Activity:").pack(anchor="w", padx=14, pady=(8, 0))
        self.log_box = scrolledtext.ScrolledText(root, height=14, state="disabled", font=("Consolas", 9))
        self.log_box.pack(fill="both", expand=True, padx=14, pady=(0, 14))

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(200, self.drain_log_queue)

    def toggle_show(self):
        self.key_entry.config(show="" if self.show_var.get() else "•")

    def append_log(self, msg):
        self.log_box.config(state="normal")
        self.log_box.insert("end", msg + "\n")
        self.log_box.see("end")
        self.log_box.config(state="disabled")

    def drain_log_queue(self):
        try:
            while True:
                msg = self.log_queue.get_nowait()
                self.append_log(msg)
                if msg.startswith("✅ Connected"):
                    self.set_status("connected")
                elif msg.startswith("❌"):
                    self.set_status("error")
        except queue.Empty:
            pass
        self.root.after(200, self.drain_log_queue)

    def set_status(self, state):
        if state == "connected":
            self.status_label.config(text="● Connected — watching for print jobs", fg="#2F6846")
        elif state == "connecting":
            self.status_label.config(text="● Connecting ...", fg="#8A6416")
        elif state == "error":
            self.status_label.config(text="● Connection problem", fg="#A6291B")
        else:
            self.status_label.config(text="● Not connected", fg="#888")

    def toggle_connection(self):
        if self.worker and self.worker.is_alive():
            self.disconnect()
        else:
            self.connect()

    def connect(self):
        server_url = self.server_entry.get().strip()
        owner_key = self.key_entry.get().strip()

        if not server_url.startswith("http"):
            messagebox.showerror("Missing info", "Please enter the full website address, e.g. https://yourshop.com")
            return
        if not owner_key:
            messagebox.showerror("Missing info", "Please enter the connector password given to you by your developer.")
            return

        save_config({
            "server_url": server_url,
            "owner_key": owner_key,
            "autostart": self.autostart_var.get(),
        })

        if self.autostart_var.get():
            self.try_register_autostart()

        self.set_status("connecting")
        self.stop_event = threading.Event()
        self.worker = PrintWorker(server_url, owner_key, self.log_queue, self.stop_event)
        self.worker.start()
        self.connect_btn.config(text="Disconnect", bg="#4B5468")

    def disconnect(self):
        self.stop_event.set()
        self.set_status("idle")
        self.connect_btn.config(text="Connect", bg="#A6291B")

    def try_register_autostart(self):
        """Best-effort: drops a small launcher into the Windows Startup
        folder so this app opens automatically after a reboot. Silently
        does nothing if anything about the environment looks unexpected."""
        if platform.system() != "Windows":
            return
        try:
            startup_dir = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
            if not startup_dir.exists():
                return
            launcher = startup_dir / "PrintShopConnector.bat"
            if getattr(sys, "frozen", False):
                target = f'"{sys.executable}"'
            else:
                pythonw = Path(sys.executable).with_name("pythonw.exe")
                interpreter = str(pythonw) if pythonw.exists() else sys.executable
                target = f'"{interpreter}" "{Path(__file__).resolve()}"'
            launcher.write_text(f'start "" {target}\n', encoding="utf-8")
            self.append_log("🗂️  Set to start automatically with Windows.")
        except Exception:
            pass  # not critical — the owner can still start it manually

    def on_close(self):
        self.stop_event.set()
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    try:
        style = ttk.Style()
        style.theme_use("clam")
    except Exception:
        pass
    App(root)
    root.mainloop()
