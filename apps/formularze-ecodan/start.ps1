$ErrorActionPreference = "Stop"

# Opcjonalny portable Node - ustaw zmienna srodowiskowa SCYZORYK_PORTABLE_NODE na folder
# z node.exe, jesli nie masz Node.js zainstalowanego globalnie na tym komputerze.
if ($env:SCYZORYK_PORTABLE_NODE -and (Test-Path $env:SCYZORYK_PORTABLE_NODE)) {
  $env:Path = "$($env:SCYZORYK_PORTABLE_NODE);$env:Path"
}

if (-not $env:HEADLESS) { $env:HEADLESS = "true" }
if (-not $env:BATCH_CONCURRENCY) { $env:BATCH_CONCURRENCY = "2" }
if (-not $env:BATCH_RESTART_EVERY) { $env:BATCH_RESTART_EVERY = "5" }

Write-Host "Instalowanie zaleznosci..."
npm.cmd install

Write-Host "Instalowanie Chromium dla Playwright..."
npm.cmd run install-browsers

Write-Host "Uruchamiam Ecodan Generator: http://localhost:3000"
npm.cmd start
