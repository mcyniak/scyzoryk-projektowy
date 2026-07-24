@echo off
rem Cichy wariant STARTUJ-SCYZORYK.cmd bez echo/pause/taskkill - uzywany WYLACZNIE
rem przez autostart przy logowaniu (scripts/run-hidden.vbs, zarejestrowany przez
rem scripts/install-autostart.ps1). Bez agresywnego "taskkill /F /IM node.exe" -
rem przy swiezym logowaniu nie powinno byc zadnego starego procesu Scyzoryka, a
rem zabijanie WSZYSTKICH procesow node.exe na starcie mogloby ubic inne,
rem niepowiazane aplikacje oparte o Node dzialajace w tej samej sesji uzytkownika.
rem Instalacja zaleznosci nie jest tu wywolywana wprost - server.js sam to robi
rem przy starcie, jesli czegos brakuje (patrz ensureDependenciesBeforeStart).
cd /d "%~dp0"
set "PLAYWRIGHT_BROWSERS_PATH=0"
node server.js
