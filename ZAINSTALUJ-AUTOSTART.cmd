@echo off
setlocal
cd /d "%~dp0"

echo Ta operacja zarejestruje automatyczny start Scyzoryka przy kazdym logowaniu
echo na ten komputer oraz doda adres scyzoryk.projektowy (zamiast 127.0.0.1:3000).
echo Za chwile pojawi sie okno z prosba o uprawnienia administratora (UAC) -
echo potrzebne jednorazowo do wpisu w pliku hosts. Kliknij "Tak".
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-autostart.ps1"

echo.
echo Gotowe.
pause
