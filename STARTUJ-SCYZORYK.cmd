@echo off
setlocal
cd /d "%~dp0"
rem Instalacje z instalatora (installer\scyzoryk.iss) maja bundlowany, przenosny
rem Node.js obok siebie i NIE modyfikuja globalnego PATH - preferuj go, jesli
rem istnieje, zamiast zakladac ze "node" jest globalnie dostepny w PATH.
if exist "%~dp0node-runtime\node.exe" (
  set "PATH=%~dp0node-runtime;%PATH%"
)
set "PLAYWRIGHT_BROWSERS_PATH=0"

echo Zamykam stare procesy Node, jesli istnieja...
taskkill /F /IM node.exe >nul 2>nul

echo.
echo Node:
node -v
if errorlevel 1 goto no_node

echo.
echo Instalacja/sprawdzenie zaleznosci...
node scripts\install-all.js
if errorlevel 1 goto error

echo.
echo Sprawdzam projekt...
node scripts\check-project.js
if errorlevel 1 goto error

echo.
echo Startuje Scyzoryk: http://127.0.0.1:3000
node server.js
pause
exit /b 0

:no_node
echo Nie znaleziono Node.js. Zainstaluj Node.js i otworz nowe okno CMD/PowerShell.
pause
exit /b 1

:error
echo.
echo BLAD. Skopiuj to co jest wyzej, szczegolnie blad z instalacji npm.
pause
exit /b 1
