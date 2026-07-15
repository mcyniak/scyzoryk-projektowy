@echo off
setlocal
cd /d "%~dp0"

if exist "C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64\node.exe" (
  set "PATH=C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64;%PATH%"
)

if not defined HEADLESS set "HEADLESS=true"
if not defined BATCH_CONCURRENCY set "BATCH_CONCURRENCY=2"
if not defined BATCH_RESTART_EVERY set "BATCH_RESTART_EVERY=5"
set "PLAYWRIGHT_BROWSERS_PATH=0"

echo Checking dependencies...
node -e "const r=require.resolve; for (const p of ['express','playwright','read-excel-file','pdf-parse','multer','sanitize-filename']) r(p + '/package.json');" >nul 2>nul
if errorlevel 1 (
  echo Dependencies are missing. Run start.cmd or install-public.cmd first.
  pause
  exit /b 1
)

npm.cmd start
pause
