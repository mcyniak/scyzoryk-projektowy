@echo off
setlocal
cd /d "%~dp0"

if exist "C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64\node.exe" (
  set "PATH=C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64;%PATH%"
)

set "npm_config_registry=https://registry.npmjs.org/"
set "npm_config_audit=false"
set "npm_config_fund=false"
set "PLAYWRIGHT_BROWSERS_PATH=0"

echo This will remove node_modules and install packages again.
echo Close all generator, node.exe and Chrome windows before continuing.
echo.
pause

if exist package-lock.json del /f /q package-lock.json
if exist node_modules (
  echo Removing node_modules...
  rmdir /s /q node_modules
)

if exist node_modules (
  echo.
  echo Could not fully remove node_modules. Restart Windows or close locking processes and try again.
  pause
  exit /b 1
)

call install-public.cmd
exit /b %errorlevel%
