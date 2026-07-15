$ErrorActionPreference = "Stop"

# Ustaw tu folder z portable Node, jesli nie masz node w PATH:
$portableNode = "C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64"
if (Test-Path $portableNode) {
  $env:Path = "$portableNode;$env:Path"
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
