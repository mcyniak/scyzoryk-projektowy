@echo off
setlocal
cd /d "%~dp0"

echo Ta operacja zarejestruje automatyczny start Scyzoryka przy kazdym logowaniu
echo na ten komputer. Adres w przegladarce to http://scyzoryk.localhost:3000.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-autostart.ps1"

echo.
echo Gotowe.
pause
