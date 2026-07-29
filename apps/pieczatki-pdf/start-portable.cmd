@echo off
cd /d %~dp0
REM Opcjonalny portable Node - ustaw zmienna SCYZORYK_PORTABLE_NODE na folder z node.exe,
REM jesli nie masz Node.js zainstalowanego globalnie na tym komputerze.
if defined SCYZORYK_PORTABLE_NODE if exist "%SCYZORYK_PORTABLE_NODE%\node.exe" (
  set "Path=%SCYZORYK_PORTABLE_NODE%;%Path%"
)
node server.js
pause
