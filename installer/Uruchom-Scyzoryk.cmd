@echo off
setlocal
cd /d "%~dp0"

REM Ten plik trafia do zainstalowanego folderu Scyzoryka (patrz installer\scyzoryk.iss).
REM Uzywa WYLACZNIE bundlowanego node-runtime obok siebie - nie wymaga Node.js
REM zainstalowanego globalnie na komputerze.
set "PATH=%~dp0node-runtime;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=0"

REM Audyt v1.0.4, P1-9: pojedyncze sprawdzenie z 2s timeoutem moglo dac
REM falszywy negatyw dla zywego, ale chwilowo zajetego panelu (np. agreguje
REM health 8 podaplikacji) - is-panel-alive.ps1 probuje kilka razy przez
REM ~12s, zanim uzna panel za martwy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\is-panel-alive.ps1" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:3000"
  exit /b 0
)

echo Zatrzymuje tylko osierocone procesy Scyzoryka, jesli istnieja...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-scyzoryk.ps1

REM Start w tle bez widocznego okna konsoli - ten sam mechanizm co autostart
REM (scripts\run-hidden.vbs -> STARTUJ-SCYZORYK-CICHO.cmd). Wczesniej ten plik
REM odpalal "node.exe server.js" wprost w widocznym oknie cmd, wiec przypadkowe
REM zamkniecie tego okna ubijalo cala aplikacje, a uzytkownik mogl wziac to za blad.
cscript //nologo "%~dp0scripts\run-hidden.vbs" >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\wait-and-open-panel.ps1"
exit /b %errorlevel%
