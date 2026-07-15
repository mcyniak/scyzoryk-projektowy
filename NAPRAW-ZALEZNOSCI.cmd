@echo off
setlocal
cd /d "%~dp0"
set "PLAYWRIGHT_BROWSERS_PATH=0"

echo Usuwam stare node_modules i locki w aplikacjach...
for /d %%D in (apps\*) do (
  if exist "%%D\node_modules" rmdir /s /q "%%D\node_modules"
  if exist "%%D\package-lock.json" del /q "%%D\package-lock.json"
)

echo.
echo Uruchamiam instalacje od zera...
node scripts\install-all.js
if errorlevel 1 goto error

echo.
echo Gotowe. Teraz uruchom STARTUJ-SCYZORYK.cmd albo node server.js
pause
exit /b 0

:error
echo.
echo BLAD INSTALACJI. Wklej caly blad od tego miejsca w ChatGPT.
pause
exit /b 1
