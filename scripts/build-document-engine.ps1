# Buduje Scyzoryk.DocumentEngine.exe (C#/.NET 8, Open XML SDK,
# tools\Scyzoryk.DocumentEngine) - silnik strukturalnych operacji na DOCX bez
# Word/COM (patrz CLAUDE.md, "Migracja Word COM -> Open XML"). Ten sam wzorzec
# co scripts\build-launcher.ps1 dla Scyzoryk.exe: dotnet test PRZED
# dotnet publish, self-contained/single-file win-x64, wersja z zewnatrz.
#
# W przeciwienstwie do launchera (ktory idzie od razu do stagingu
# instalatora), wynik ladowany jest w STALYM, znanym katalogu w repo
# (tools\Scyzoryk.DocumentEngine\publish\) - lib/documentEngine.js szuka tam
# w trybie deweloperskim (git clone bez instalatora); scripts\build-installer.ps1
# kopiuje stamtad exe do stagingu, tak jak build-launcher.ps1 robi to dla
# Scyzoryk.exe.
#
# Uzycie:
#   powershell -File scripts\build-document-engine.ps1
#   powershell -File scripts\build-document-engine.ps1 -Version 1.2.3

param(
  [string]$Version = '',
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ProjectDir = Join-Path $Root 'tools\Scyzoryk.DocumentEngine'
$ProjectPath = Join-Path $ProjectDir 'Scyzoryk.DocumentEngine.csproj'
$TestProjectPath = Join-Path $Root 'tools\Scyzoryk.DocumentEngine.Tests\Scyzoryk.DocumentEngine.Tests.csproj'
$PublishDir = Join-Path $ProjectDir 'publish'

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
  $packageJsonPath = Join-Path $Root 'package.json'
  $Version = (Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json).version
}
Write-Host "Buduje Scyzoryk.DocumentEngine.exe w wersji $Version (konfiguracja $Configuration)..."

Write-Host "`n=== dotnet restore ==="
& $dotnet restore $ProjectPath | Out-Host
if ($LASTEXITCODE -ne 0) { throw "dotnet restore nie powiodlo sie (kod $LASTEXITCODE)." }
& $dotnet restore $TestProjectPath | Out-Host
if ($LASTEXITCODE -ne 0) { throw "dotnet restore (testy) nie powiodlo sie (kod $LASTEXITCODE)." }

Write-Host "`n=== dotnet test (testy silnika dokumentow musza przejsc przed budowa) ==="
& $dotnet test $TestProjectPath -c $Configuration --nologo | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Testy silnika dokumentow nie przeszly (kod $LASTEXITCODE) - budowa Scyzoryk.DocumentEngine.exe przerwana." }

if (Test-Path $PublishDir) { Remove-Item $PublishDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $PublishDir | Out-Null

Write-Host "`n=== dotnet publish (self-contained, single-file, win-x64) ==="
& $dotnet publish $ProjectPath `
  -c $Configuration `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:PublishTrimmed=false `
  -p:Version=$Version `
  -o $PublishDir | Out-Host
if ($LASTEXITCODE -ne 0) { throw "dotnet publish nie powiodlo sie (kod $LASTEXITCODE)." }

$exeFiles = @(Get-ChildItem -Path $PublishDir -Filter 'Scyzoryk.DocumentEngine.exe' -File)
if ($exeFiles.Count -ne 1) {
  throw "Oczekiwano dokladnie jednego pliku Scyzoryk.DocumentEngine.exe w $PublishDir, znaleziono $($exeFiles.Count)."
}

$exePath = $exeFiles[0].FullName
$sizeMb = [math]::Round($exeFiles[0].Length / 1MB, 1)
Write-Host "`nGotowe: $exePath ($sizeMb MB)"

$exePath
