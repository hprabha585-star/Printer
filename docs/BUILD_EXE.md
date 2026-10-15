# Making the Print Connector program (.exe)

Do this **once**, on any Windows computer. Then copy the result to the shop computers.

## You need
- Windows 10 or 11
- **Python 3.10 or newer** from python.org. While installing, tick **"Add python.exe to PATH"**.
- **SumatraPDF portable** (free) from sumatrapdfreader.org → Download → the **portable** 64-bit version.

## Steps
1. Copy the `connector` folder from the zip to the computer (e.g. to the Desktop).
2. Double-click **`build_exe.bat`** inside it. A black window installs what it needs and builds the
   program. It takes 1–3 minutes.
3. When it says **Done**, open the new **`dist`** folder. You will find **`PrintShopConnector.exe`**.
4. Make a folder called **`PrintShop`** and put inside it:
   - `PrintShopConnector.exe`
   - `SumatraPDF.exe` (rename the downloaded portable file to exactly this name)
5. Copy that `PrintShop` folder to each shop computer (e.g. `C:\PrintShop`).

That's it. The owner sheet explains first-time setup on each computer.

## Notes for the technical person
- The program is a single Python file (`printshop_connector.py`) using only the standard library;
  `pywin32` is bundled for fast, reliable printer status on Windows (PowerShell is the fallback).
- Settings are saved in `%APPDATA%\PrintShopConnector\config.json` (website address, a computer
  token — never the password — and the printer mapping).
- Downloaded customer files go to `%TEMP%\PrintShopConnector` and are deleted after each print
  (and on start-up, in case of a crash).
- "Start with Windows" adds `PrintShopConnector.exe --minimized` to
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- Printing: `SumatraPDF.exe -print-to "<printer>" -print-settings "<from>-<to>,<copies>x,monochrome|color,fit" -silent <file>`.
- On Linux/macOS it prints through CUPS (`lp`, `lpstat`) — run `python3 printshop_connector.py`.
- Windows Defender sometimes warns about new PyInstaller programs. Click "More info → Run anyway",
  or sign the exe if you have a code-signing certificate.
- Test mode without real printers:
  `python printshop_connector.py --headless --server https://… --password … --fake-printers "A:color,B,C" --map "A=Printer 1 - Colour"`
