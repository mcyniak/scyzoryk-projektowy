@echo off
setlocal
cd /d "%~dp0"
node scripts\install-all.js
pause
