@echo off
setlocal
cd /d "%~dp0"

REM Ten plik trafia do zainstalowanego folderu Scyzoryka (patrz installer\scyzoryk.iss).
REM Uzywa WYLACZNIE bundlowanego node-runtime obok siebie - nie wymaga Node.js
REM zainstalowanego globalnie na komputerze.
set "PATH=%~dp0node-runtime;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=0"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:3000"
  exit /b 0
)

echo Zatrzymuje tylko osierocone procesy Scyzoryka, jesli istnieja...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-scyzoryk.ps1

echo.
echo Startuje Scyzoryk: http://127.0.0.1:3000
"%~dp0node-runtime\node.exe" server.js
pause
