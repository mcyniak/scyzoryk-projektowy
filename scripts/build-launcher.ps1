# Buduje natywny launcher Scyzoryk.exe (C#/.NET 8, launcher\Scyzoryk.Launcher) -
# zastepuje lancuch Uruchom-Scyzoryk.cmd -> is-panel-alive.ps1 -> stop-scyzoryk.ps1
# -> cscript run-hidden.vbs -> STARTUJ-SCYZORYK-CICHO.cmd -> node server.js ->
# wait-and-open-panel.ps1 (patrz CLAUDE.md i launcher\README dla pelnego opisu).
#
# Wywolywany przez scripts\build-installer.ps1 PRZED przygotowaniem stagingu
# instalatora - "zbuduj launcher" i "wstaw go do instalatora" sa swiadomie dwoma
# odrebnymi krokami, zeby przyszle podpisywanie kodu (Authenticode) moglo wejsc
# miedzy nie bez przebudowy obu skryptow.
#
# Zwraca (jako JEDYNA linia w strumieniu wyjsciowym pipeline) pelna sciezke do
# opublikowanego Scyzoryk.exe - wszystko inne (w tym surowy stdout dotnet.exe)
# idzie przez Out-Host, zeby wywolujacy mogl bezpiecznie zrobic
# "$exePath = & scripts\build-launcher.ps1 ..." bez zanieczyszczenia wyniku.
#
# Uzycie:
#   powershell -File scripts\build-launcher.ps1
#   powershell -File scripts\build-launcher.ps1 -Version 1.2.3

param(
  [string]$Version = '',
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$LauncherDir = Join-Path $Root 'launcher'
$SolutionPath = Join-Path $LauncherDir 'Scyzoryk.Launcher.sln'
$ProjectPath = Join-Path $LauncherDir 'Scyzoryk.Launcher\Scyzoryk.Launcher.csproj'
$TestProjectPath = Join-Path $LauncherDir 'Scyzoryk.Launcher.Tests\Scyzoryk.Launcher.Tests.csproj'

function Find-Dotnet {
  $cmd = Get-Command dotnet.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$dotnet = Find-Dotnet
if (-not $dotnet) {
  Write-Error "Nie znaleziono dotnet (.NET SDK 8). Zainstaluj z https://dotnet.microsoft.com/download/dotnet/8.0 albo 'winget install Microsoft.DotNet.SDK.8', potem uruchom ponownie."
  exit 1
}
Write-Host "Uzywam dotnet: $dotnet"

$sdkLines = & $dotnet --list-sdks
$has8 = @($sdkLines | Where-Object { $_ -match '^8\.' })
if ($has8.Count -eq 0) {
  Write-Error (".NET SDK 8 nie jest zainstalowane. Znalezione SDK-i:`n" + ($sdkLines -join "`n") + "`nZainstaluj .NET SDK 8 (https://dotnet.microsoft.com/download/dotnet/8.0).")
  exit 1
}

if (-not $Version) {
  # Domyslnie wersja launchera = wersja z package.json, tak jak build-installer.ps1
  # robi to dla samego instalatora - jedna, spojna wersja w calym repo.
  $packageJsonPath = Join-Path $Root 'package.json'
  $Version = (Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json).version
}
Write-Host "Buduje Scyzoryk.exe w wersji $Version (konfiguracja $Configuration)..."

Write-Host "`n=== dotnet restore ==="
& $dotnet restore $SolutionPath | Out-Host
if ($LASTEXITCODE -ne 0) { throw "dotnet restore nie powiodlo sie (kod $LASTEXITCODE)." }

Write-Host "`n=== dotnet test (testy launchera musza przejsc przed budowa) ==="
& $dotnet test $TestProjectPath -c $Configuration --nologo | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Testy launchera nie przeszly (kod $LASTEXITCODE) - budowa Scyzoryk.exe przerwana." }

$publishDir = Join-Path $env:TEMP ("scyzoryk-launcher-publish-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $publishDir | Out-Null

Write-Host "`n=== dotnet publish (self-contained, single-file, win-x64) ==="
& $dotnet publish $ProjectPath `
  -c $Configuration `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:PublishTrimmed=false `
  -p:Version=$Version `
  -o $publishDir | Out-Host
if ($LASTEXITCODE -ne 0) { throw "dotnet publish nie powiodlo sie (kod $LASTEXITCODE)." }

$exeFiles = @(Get-ChildItem -Path $publishDir -Filter 'Scyzoryk.exe' -File)
if ($exeFiles.Count -ne 1) {
  throw "Oczekiwano dokladnie jednego pliku Scyzoryk.exe w $publishDir, znaleziono $($exeFiles.Count)."
}

$exePath = $exeFiles[0].FullName
$sizeMb = [math]::Round($exeFiles[0].Length / 1MB, 1)
Write-Host "`nGotowe: $exePath ($sizeMb MB)"

$exePath
