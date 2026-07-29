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
rem Instalacje z instalatora (installer\scyzoryk.iss) maja bundlowany, przenosny
rem Node.js obok siebie i NIE modyfikuja globalnego PATH - preferuj go, jesli
rem istnieje, zamiast zakladac ze "node" jest globalnie dostepny w PATH.
if exist "%~dp0node-runtime\node.exe" (
  set "PATH=%~dp0node-runtime;%PATH%"
)
set "PLAYWRIGHT_BROWSERS_PATH=0"
node server.js
