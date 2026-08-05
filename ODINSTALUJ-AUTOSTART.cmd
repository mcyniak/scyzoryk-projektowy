@echo off
setlocal
cd /d "%~dp0"

echo Ta operacja wylaczy automatyczny start Scyzoryka. Program nadal bedzie
echo dzialal - trzeba go bedzie uruchamiac recznie skrotem/plikiem Scyzoryk.exe
echo (adres http://scyzoryk.localhost:3000).
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-autostart.ps1"

echo.
echo Gotowe.
pause
