@echo off
setlocal
cd /d "%~dp0"

REM Ten plik trafia do zainstalowanego folderu Scyzoryka (patrz installer\scyzoryk.iss).
REM Uzywa WYLACZNIE bundlowanego node-runtime obok siebie - nie wymaga Node.js
REM zainstalowanego globalnie na komputerze.
set "PATH=%~dp0node-runtime;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=0"

echo Zamykam stare procesy Node, jesli istnieja...
taskkill /F /IM node.exe >nul 2>nul

echo.
echo Startuje Scyzoryk: http://127.0.0.1:3000
"%~dp0node-runtime\node.exe" server.js
pause
