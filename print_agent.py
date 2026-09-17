#!/usr/bin/env python3
"""
print_agent.py
--------------------------------------------------------------------------
Runs on the shop's PC (the one physically connected to the printer).

Every POLL_INTERVAL seconds it:
  1. Asks the backend for paid-but-not-yet-printed jobs   (GET /api/jobs/pending)
  2. Downloads each job's file to a local "downloads" folder
  3. Sends it to the printer (Windows: default app's print verb / Linux & Mac: CUPS "lp")
  4. Reports success or failure back to the backend        (POST /api/jobs/complete)

Setup:
  pip install requests
  Set the two environment variables below (or edit the defaults).

Run:
  python print_agent.py

To run this permanently on the shop PC, set it up as a Windows scheduled
task / service, or a systemd service / cron @reboot job on Linux, so it
starts automatically and keeps running in the background.
--------------------------------------------------------------------------
"""

import os
import sys
import time
import platform
import subprocess
import logging
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Configuration — set these as environment variables, or edit the defaults.
# ---------------------------------------------------------------------------
SERVER_URL = os.environ.get("PRINT_SHOP_SERVER_URL", "http://localhost:5000")
OWNER_KEY = os.environ.get("PRINT_SHOP_OWNER_KEY", "change-me-owner-key")
POLL_INTERVAL_SECONDS = int(os.environ.get("PRINT_SHOP_POLL_INTERVAL", "5"))
DOWNLOAD_DIR = Path(os.environ.get("PRINT_SHOP_DOWNLOAD_DIR", "./downloads")).resolve()
# Optional: name of a specific printer to use instead of the OS default.
# On Windows this is the printer's exact name in "Devices and Printers".
# On Linux/Mac this is the CUPS queue name (see `lpstat -p`).
PRINTER_NAME = os.environ.get("PRINT_SHOP_PRINTER_NAME", "").strip() or None

HEADERS = {"x-owner-key": OWNER_KEY}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("print_agent.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("print_agent")


# ---------------------------------------------------------------------------
# Backend API helpers
# ---------------------------------------------------------------------------
def fetch_pending_jobs():
    """Returns a list of jobs that are paid and queued for printing."""
    try:
        resp = requests.get(f"{SERVER_URL}/api/jobs/pending", headers=HEADERS, timeout=15)
        if resp.status_code == 401:
            log.error("Owner key rejected by server. Check PRINT_SHOP_OWNER_KEY matches the server's OWNER_KEY.")
            return []
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        log.warning(f"Could not reach server for pending jobs: {e}")
        return []


def download_file(url, dest_path):
    """Streams a job's file from the backend to local disk."""
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)


def report_result(job_id, status, error=None):
    """Tells the backend a job finished (or failed) printing."""
    body = {"jobId": job_id, "status": status}
    if error:
        body["error"] = str(error)[:500]
    try:
        resp = requests.post(f"{SERVER_URL}/api/jobs/complete", headers=HEADERS, json=body, timeout=15)
        resp.raise_for_status()
        log.info(f"Reported job {job_id} as {status}")
    except requests.RequestException as e:
        log.error(f"Failed to report job {job_id} result to server: {e}")


# ---------------------------------------------------------------------------
# Printing
# ---------------------------------------------------------------------------
def print_file(file_path: Path, copies: int = 1):
    """
    Sends a file to the local printer. Implementation differs by OS:
      - Windows: uses the file's default application's "print" verb via
        ShellExecute (works well for PDFs, DOCX, images with a default
        viewer installed, e.g. Adobe Reader / Word / Photos).
      - Linux/Mac: uses the CUPS command-line tool `lp`.
    Raises an exception on failure; caller catches it and reports 'failed'.
    """
    system = platform.system()

    if system == "Windows":
        import win32api  # provided by the 'pywin32' package on Windows

        for _ in range(copies):
            if PRINTER_NAME:
                # ShellExecute with an explicit printer via the "printto" verb
                win32api.ShellExecute(0, "printto", str(file_path), f'"{PRINTER_NAME}"', ".", 0)
            else:
                win32api.ShellExecute(0, "print", str(file_path), None, ".", 0)
            # Give the shell a moment to hand off to the spooler before the
            # next copy is triggered, and before we potentially delete files.
            time.sleep(3)

    elif system in ("Linux", "Darwin"):
        cmd = ["lp", "-n", str(copies)]
        if PRINTER_NAME:
            cmd += ["-d", PRINTER_NAME]
        cmd.append(str(file_path))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"lp command failed: {result.stderr.strip()}")

    else:
        raise RuntimeError(f"Unsupported OS for printing: {system}")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def process_job(job):
    job_id = job["_id"]
    file_url = job["fileUrl"]
    file_name = job["fileName"]
    copies = job.get("copies", 1)

    log.info(f"Processing job {job.get('tokenId', job_id)} — {file_name} ({job['printType']}, {copies}x)")

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    local_path = DOWNLOAD_DIR / f"{job_id}_{file_name}"

    try:
        download_file(file_url, local_path)
    except Exception as e:
        log.error(f"Download failed for job {job_id}: {e}")
        report_result(job_id, "failed", f"Download error: {e}")
        return

    try:
        print_file(local_path, copies=copies)
        report_result(job_id, "completed")
    except Exception as e:
        log.error(f"Print failed for job {job_id}: {e}")
        report_result(job_id, "failed", f"Print error: {e}")


def main():
    log.info("Print agent starting")
    log.info(f"Server: {SERVER_URL} | Poll interval: {POLL_INTERVAL_SECONDS}s | Printer: {PRINTER_NAME or '(system default)'}")

    if OWNER_KEY == "change-me-owner-key":
        log.warning("Using the default OWNER_KEY — set PRINT_SHOP_OWNER_KEY to match your server's OWNER_KEY.")

    while True:
        jobs = fetch_pending_jobs()
        if jobs:
            log.info(f"Found {len(jobs)} job(s) to print")
        for job in jobs:
            process_job(job)
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Print agent stopped by user")
