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

echo Installing dependencies from public npm registry...
call npm.cmd install --no-package-lock --no-audit --fund=false --registry=https://registry.npmjs.org/
if errorlevel 1 goto error

echo Verifying dependencies...
node -e "const r=require.resolve; for (const p of ['express','playwright','read-excel-file','pdf-parse','multer','sanitize-filename','archiver']) r(p + '/package.json'); console.log('All dependencies OK');"
if errorlevel 1 goto error

echo Installing Playwright Chromium browser using local project Playwright...
call npm.cmd run install-browsers
if errorlevel 1 goto error

echo Done.
pause
exit /b 0

:error
echo Installation failed. Check your internet connection, close node/chrome processes, then try clean-install.cmd.
pause
exit /b 1
