@echo off
setlocal
cd /d "%~dp0"

echo Node:
node -v
if errorlevel 1 goto no_node

echo.
echo Buduje prawdziwy instalator Windows (.exe) - wymaga Inno Setup 6 (ISCC.exe)
echo oraz polaczenia z internetem (pobranie portable Node.js do bundlowania)...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
if errorlevel 1 goto error

echo.
echo Gotowe - instalator jest w folderze release\.
pause
exit /b 0

:no_node
echo Nie znaleziono Node.js. Zainstaluj Node.js i otworz nowe okno CMD/PowerShell.
pause
exit /b 1

:error
echo.
echo BLAD. Skopiuj to co jest wyzej.
pause
exit /b 1
