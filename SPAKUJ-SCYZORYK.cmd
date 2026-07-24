@echo off
setlocal
cd /d "%~dp0"

echo Node:
node -v
if errorlevel 1 goto no_node

echo.
echo Buduje paczke do rozeslania (tylko scommitowany stan, bez node_modules/danych)...
node scripts\build-package.js
if errorlevel 1 goto error

echo.
echo Gotowe - paczka jest w folderze release\.
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
