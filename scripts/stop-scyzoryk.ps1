$ErrorActionPreference = 'SilentlyContinue'

# Zatrzymuje WYLACZNIE procesy node.exe uruchomione z bundlowanego node-runtime tej
# instalacji (rozroznione po pelnej sciezce pliku wykonywalnego), zeby odinstalowanie
# Scyzoryka nie ubijalo innych, niepowiazanych procesow node.exe na tym komputerze
# Launchery korzystaja z tego skryptu zamiast globalnego "taskkill /IM node.exe",
# ktory moglby zatrzymac niepowiazane aplikacje deweloperskie.
$nodeExe = Join-Path $PSScriptRoot '..\node-runtime\node.exe'
if (-not (Test-Path $nodeExe)) { exit 0 }
$nodeExeFull = (Resolve-Path $nodeExe).Path

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $nodeExeFull) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

exit 0
