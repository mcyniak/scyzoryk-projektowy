@echo off
setlocal
cd /d "%~dp0"

echo Ta operacja wylaczy automatyczny start Scyzoryka i usunie adres
echo scyzoryk.projektowy. Program nadal bedzie dzialal - trzeba go bedzie
echo uruchamiac recznie przez STARTUJ-SCYZORYK.cmd (adres 127.0.0.1:3000).
echo Za chwile pojawi sie okno z prosba o uprawnienia administratora (UAC).
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-autostart.ps1"

echo.
echo Gotowe.
pause
