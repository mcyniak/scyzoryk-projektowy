@echo off
cd /d %~dp0
set "NODE_PORTABLE=C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64"
if exist "%NODE_PORTABLE%\node.exe" (
  set "Path=%NODE_PORTABLE%;%Path%"
)
node server.js
pause
