@echo off
cd /d %~dp0
npm.cmd config set registry https://registry.npmjs.org/
if exist package-lock.json del package-lock.json
if exist node_modules rmdir /s /q node_modules
npm.cmd install
pause
