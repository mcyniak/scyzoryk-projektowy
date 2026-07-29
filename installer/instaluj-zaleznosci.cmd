@echo off
setlocal
cd /d "%~dp0"

REM Uruchamiany raz przez instalator (sekcja [Run] w scyzoryk.iss) zaraz po skopiowaniu
REM plikow. Uzywa WYLACZNIE bundlowanego node-runtime - zero zaleznosci od globalnie
REM zainstalowanego Node.js/npm. Wymaga polaczenia z internetem (npm install kazdej
REM aplikacji + pobranie przegladarki Chromium dla Playwrighta, dokladnie jak dzis robi
REM to STARTUJ-SCYZORYK.cmd przy pierwszym uruchomieniu).
set "PATH=%~dp0node-runtime;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=0"

echo Node (bundlowany):
"%~dp0node-runtime\node.exe" -v

echo.
echo Instaluje skladniki Scyzoryka (npm install dla kazdej aplikacji + przegladarka
echo Chromium dla Playwrighta) - to moze potrwac kilka minut...
"%~dp0node-runtime\node.exe" scripts\install-all.js
if errorlevel 1 (
  echo.
  echo BLAD instalacji skladnikow. Szczegoly powyzej.
  exit /b 1
)

echo.
echo Sprawdzam projekt...
"%~dp0node-runtime\node.exe" scripts\check-project.js
exit /b %errorlevel%
