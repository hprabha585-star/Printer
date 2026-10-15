@echo off
REM Builds PrintShopConnector.exe (one file, no console window).
REM Needs Python 3.10+ for Windows from python.org (tick "Add python.exe to PATH" when installing).
cd /d "%~dp0"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m PyInstaller --onefile --windowed --name PrintShopConnector --hidden-import win32print printshop_connector.py
echo.
echo Done. Your program is in the "dist" folder: dist\PrintShopConnector.exe
echo Put SumatraPDF.exe in the same folder as PrintShopConnector.exe.
pause
