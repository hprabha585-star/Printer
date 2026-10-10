# Building `PrintShopConnector.exe` (for the developer, once)

The shop owner should never need to install Python or run anything from a
terminal. Do this one time (on a Windows machine, or a Windows VM) to turn
`print_agent_gui.py` into a single `.exe` file you hand to the owner.

## 1. On a Windows machine, install Python once

Download from https://python.org (check "Add Python to PATH" during install).
This step is only needed on **your** build machine, never on the shop PC.

## 2. Install the build tools

```powershell
pip install requests pyinstaller
```

## 3. Build the executable

From the folder containing `print_agent_gui.py`, run:

```powershell
pyinstaller --onefile --windowed --name "PrintShopConnector" print_agent_gui.py
```

- `--onefile` bundles everything into a single `.exe` — nothing else to copy.
- `--windowed` stops a black console window from popping up behind the app.

This creates `dist/PrintShopConnector.exe`. That single file is everything
the shop owner needs — no Python, no pip, no terminal.

## 4. Test it yourself first

Copy `dist/PrintShopConnector.exe` to a different folder (or a different PC)
and double-click it before handing it off, to make sure Windows Defender /
SmartScreen doesn't block it on first run (click "More info" → "Run anyway"
if it does — this is normal for new, unsigned `.exe` files, and only appears
once per machine).

## 5. Hand it to the shop owner

Give them:
- `PrintShopConnector.exe`
- The `INSTALL_FOR_OWNER.txt` sheet (also in this project), with your
  website address and their connector password filled in or written on it

They just need to double-click it — see `INSTALL_FOR_OWNER.txt` for the
exact steps written for them.

## Notes

- If you update `print_agent_gui.py` later, just re-run step 3 and send the
  new `.exe` — the owner's saved settings (`printshop_config.json`, created
  next to the `.exe` on first run) carry over automatically since it lives
  in the same folder as the exe, not inside it.
- macOS/Linux shops: PyInstaller can also build a Mac `.app` or Linux binary
  the same way, run on that OS (`pyinstaller --onefile --windowed print_agent_gui.py`),
  but most small print shops in practice run Windows, so this guide focuses there.
