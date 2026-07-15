@echo off
setlocal
cd /d "%~dp0"

REM Ecodan Generator - safe Windows starter without PowerShell execution policy.
REM It always verifies local project dependencies before installing Playwright browsers.
REM It also forces the public npm registry, so it will not use build-machine registry URLs.

if exist "C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64\node.exe" (
  set "PATH=C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64;%PATH%"
)

if not defined HEADLESS set "HEADLESS=true"
if not defined BATCH_CONCURRENCY set "BATCH_CONCURRENCY=2"
if not defined BATCH_RESTART_EVERY set "BATCH_RESTART_EVERY=5"

set "npm_config_registry=https://registry.npmjs.org/"
set "npm_config_audit=false"
set "npm_config_fund=false"
set "PLAYWRIGHT_BROWSERS_PATH=0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Check the portable Node path or install Node.js.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found. Check the portable Node path or install Node.js.
  pause
  exit /b 1
)

echo Using Node:
node --version

echo.
echo Checking local npm dependencies...
node -e "const r=require.resolve; for (const p of ['express','playwright','read-excel-file','pdf-parse','multer','sanitize-filename','archiver']) r(p + '/package.json');" >nul 2>nul
if errorlevel 1 (
  echo Dependencies missing or incomplete. Installing from public npm registry...
  call npm.cmd install --no-package-lock --no-audit --fund=false --registry=https://registry.npmjs.org/
  if errorlevel 1 goto error
) else (
  echo Dependencies OK - skipping npm install.
)

echo.
echo Verifying dependencies after install...
node -e "const r=require.resolve; for (const p of ['express','playwright','read-excel-file','pdf-parse','multer','sanitize-filename','archiver']) r(p + '/package.json'); console.log('All dependencies OK');"
if errorlevel 1 goto depserror

echo.
echo Checking Playwright Chromium browser...
node -e "const fs=require('fs'); const { chromium }=require('playwright'); const p=chromium.executablePath(); if (!fs.existsSync(p)) process.exit(2); console.log(p);" >nul 2>nul
if errorlevel 1 (
  echo Installing Playwright Chromium browser using local project Playwright...
  call npm.cmd run install-browsers
  if errorlevel 1 goto error
) else (
  echo Playwright Chromium OK - skipping browser install.
)

echo.
echo Starting Ecodan Generator...
call npm.cmd start
exit /b %errorlevel%

:depserror
echo.
echo Dependencies are still broken after npm install.
echo This usually means node_modules is partially locked or corrupted.
echo.
echo Recommended repair:
echo 1. Close all generator, node.exe and Chrome windows.
echo 2. Run clean-install.cmd in this folder.
echo 3. Run start.cmd again.
echo.
pause
exit /b 1

:error
echo.
echo Start failed.
echo.
echo Most common reasons:
echo - no internet during first npm install,
echo - node_modules is locked by running node.exe/chrome.exe,
echo - antivirus holds files in node_modules,
echo - a previous install was interrupted.
echo.
echo Recommended repair:
echo 1. Close all generator, node.exe and Chrome windows.
echo 2. Run clean-install.cmd in this folder.
echo 3. Run start.cmd again.
echo.
pause
exit /b 1
