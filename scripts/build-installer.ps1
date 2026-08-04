# Buduje prawdziwy instalator Windows (.exe, Inno Setup) dla Scyzoryka Projektowego.
#
# Produkuje jeden plik setup.exe, ktory:
#   - kopiuje czysty eksport repo (git archive HEAD),
#   - buduje i dolacza natywny launcher Scyzoryk.exe (C#/.NET 8, launcher\Scyzoryk.Launcher,
#     przez scripts\build-launcher.ps1) - jedyny sposob normalnego startu aplikacji,
#     bez CMD/PowerShell/VBS,
#   - dolacza bundlowany, portable Node.js (Windows x64),
#   - podczas instalacji doinstalowuje zaleznosci kazdej aplikacji i Chromium,
#   - opcjonalnie dolacza gotowa konfiguracje Google Document AI przekazana
#     wyłącznie przez zmienne srodowiskowe procesu budowania,
#   - instaluje sie per-uzytkownik, bez wymogu stalego konta administratora.
#
# Opcjonalna konfiguracja OCR podczas budowania:
#   OCR_DOCAI_CREDENTIALS_B64 - JSON konta serwisowego zakodowany Base64
#   OCR_DOCAI_PROJECT_ID
#   OCR_DOCAI_LOCATION
#   OCR_DOCAI_PROCESSOR_ID
#
# Wszystkie cztery wartosci musza byc podane razem. Nie sa zapisywane w repo,
# ale gotowy instalator bedzie zawieral dane logowania i dlatego wolno go
# udostepniac wyłącznie wewnetrznie.
#
# Uzycie:
#   powershell -File scripts\build-installer.ps1
#   powershell -File scripts\build-installer.ps1 -NodeVersion 20.18.1 -Version 1.2.3

param(
  [string]$NodeVersion = '20.18.1',
  [string]$Version = '',
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root 'release' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Find-ISCC {
  $candidates = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    "$env:LocalAppData\Programs\Inno Setup 6\ISCC.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Add-OcrConfigurationToStaging {
  param([Parameter(Mandatory = $true)][string]$StagingDir)

  $values = [ordered]@{
    OCR_DOCAI_CREDENTIALS_B64 = [string]$env:OCR_DOCAI_CREDENTIALS_B64
    OCR_DOCAI_PROJECT_ID      = [string]$env:OCR_DOCAI_PROJECT_ID
    OCR_DOCAI_LOCATION        = [string]$env:OCR_DOCAI_LOCATION
    OCR_DOCAI_PROCESSOR_ID    = [string]$env:OCR_DOCAI_PROCESSOR_ID
  }

  $provided = @($values.GetEnumerator() | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Value) })
  if ($provided.Count -eq 0) {
    Write-Host 'Buduje instalator bez wbudowanej konfiguracji OCR.'
    return $false
  }

  if ($provided.Count -ne $values.Count) {
    $missing = @($values.GetEnumerator() | Where-Object { [string]::IsNullOrWhiteSpace($_.Value) } | ForEach-Object { $_.Key })
    throw "Niepelna konfiguracja OCR dla instalatora. Brakuje: $($missing -join ', ')."
  }

  $configDir = Join-Path $StagingDir 'apps\ocr-audytow\config'
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null

  $credentialsPath = Join-Path $configDir 'service-account.json'
  try {
    $credentialBytes = [Convert]::FromBase64String($values.OCR_DOCAI_CREDENTIALS_B64)
  } catch {
    throw 'OCR_DOCAI_CREDENTIALS_B64 nie jest poprawnym tekstem Base64.'
  }

  [IO.File]::WriteAllBytes($credentialsPath, $credentialBytes)
  try {
    $credentialJson = Get-Content -Raw -Path $credentialsPath -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $credentialsPath
    throw 'Dane OCR po zdekodowaniu nie sa poprawnym plikiem JSON.'
  }

  if ($credentialJson.type -ne 'service_account' -or
      [string]::IsNullOrWhiteSpace([string]$credentialJson.client_email) -or
      [string]::IsNullOrWhiteSpace([string]$credentialJson.private_key)) {
    Remove-Item -Force -ErrorAction SilentlyContinue $credentialsPath
    throw 'Sekret OCR nie jest kompletnym plikiem konta serwisowego Google Cloud.'
  }

  $config = [ordered]@{
    projectId   = $values.OCR_DOCAI_PROJECT_ID.Trim()
    location    = $values.OCR_DOCAI_LOCATION.Trim()
    processorId = $values.OCR_DOCAI_PROCESSOR_ID.Trim()
    keyFile     = 'service-account.json'
  }
  $configJson = $config | ConvertTo-Json
  $configPath = Join-Path $configDir 'document-ai.json'
  [IO.File]::WriteAllText($configPath, $configJson, [Text.UTF8Encoding]::new($false))

  Write-Host 'Dolaczono gotowa konfiguracje Google Document AI do instalatora.'
  Write-Warning 'Gotowy instalator zawiera dane konta serwisowego. Traktuj plik EXE jak poufny i nie publikuj go publicznie.'
  return $true
}

$iscc = Find-ISCC
if (-not $iscc) {
  Write-Error "Nie znaleziono ISCC.exe (kompilator Inno Setup 6). Zainstaluj z https://jrsoftware.org/isdl.php albo 'winget install JRSoftware.InnoSetup', potem uruchom ponownie."
  exit 1
}
Write-Host "Uzywam ISCC: $iscc"

# --- 1) Czysty eksport repo ---
$dirty = (& git -C $Root status --porcelain)
if ($dirty) {
  Write-Warning 'W drzewie roboczym sa niescommitowane zmiany - NIE trafia one do instalatora.'
}

$commitHash = (& git -C $Root rev-parse --short HEAD).Trim()
if (-not $Version) {
  # Domyslnie wersja instalatora = wersja z package.json (SemVer), NIE hash
  # gita - system aktualizacji (lib/updateVersion.js) porownuje wersje
  # numerycznie i musi widziec ta sama wartosc, co jest w package.json.
  # Jawne -Version nadal jest mozliwe (np. do doraznych buildow testowych),
  # ale domyslny, "produkcyjny" przebieg (uzywany przez workflow publikujacy
  # wydania) nigdy nie powinien go podawac.
  $packageJsonPath = Join-Path $Root 'package.json'
  $Version = (Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json).version
}
Write-Host "Wersja instalatora: $Version (commit $commitHash)"

$stagingDir = Join-Path $env:TEMP ("scyzoryk-installer-staging-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

$archiveZip = Join-Path $env:TEMP ("scyzoryk-archive-" + [guid]::NewGuid().ToString('N') + '.zip')
try {
  & git -C $Root archive --format=zip -o $archiveZip HEAD
  if ($LASTEXITCODE -ne 0) { throw "git archive nie powiodl sie (kod $LASTEXITCODE)" }
  Expand-Archive -Path $archiveZip -DestinationPath $stagingDir -Force
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $archiveZip
}
Write-Host "Rozpakowano eksport repo do: $stagingDir"

# Sekret nie moze pochodzic z repo. Jedynym dozwolonym zrodlem jest zmienna
# srodowiskowa procesu budowania, np. GitHub Actions Secret.
$secretFiles = @(Get-ChildItem -Path $stagingDir -Recurse -File -Filter 'service-account.json')
if ($secretFiles.Count -gt 0) {
  throw "Eksport repo zawiera zabroniony plik service-account.json: $($secretFiles.FullName -join ', ')"
}

# --- 1.5) build-info.json - wersja/commit zainstalowanej kopii (patrz lib/updateBuildInfo.js) ---
$buildInfo = [ordered]@{
  version = $Version
  commit  = $commitHash
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText((Join-Path $stagingDir 'build-info.json'), ($buildInfo | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host 'Zapisano build-info.json.'

# --- 2) Opcjonalna konfiguracja Google Document AI ---
$ocrIncluded = Add-OcrConfigurationToStaging -StagingDir $stagingDir

# --- 3) Bundlowany, portable Node.js (Windows x64) ---
$nodeCacheDir = Join-Path $env:TEMP 'scyzoryk-node-cache'
New-Item -ItemType Directory -Force -Path $nodeCacheDir | Out-Null
$nodeZipName = "node-v$NodeVersion-win-x64.zip"
$nodeZipPath = Join-Path $nodeCacheDir $nodeZipName

if (-not (Test-Path $nodeZipPath)) {
  $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeZipName"
  Write-Host "Pobieram portable Node.js: $nodeUrl"
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZipPath -UseBasicParsing
} else {
  Write-Host "Portable Node.js juz w cache: $nodeZipPath"
}

$nodeExtractDir = Join-Path $env:TEMP ("scyzoryk-node-extract-" + [guid]::NewGuid().ToString('N'))
Expand-Archive -Path $nodeZipPath -DestinationPath $nodeExtractDir -Force
$nodeSourceDir = Join-Path $nodeExtractDir "node-v$NodeVersion-win-x64"
if (-not (Test-Path $nodeSourceDir)) {
  throw "Nieoczekiwana struktura archiwum Node.js - brak folderu $nodeSourceDir"
}
$nodeRuntimeDir = Join-Path $stagingDir 'node-runtime'
Copy-Item -Path $nodeSourceDir -Destination $nodeRuntimeDir -Recurse -Force
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $nodeExtractDir
Write-Host "Bundlowany Node.js gotowy: $nodeRuntimeDir"

# --- 4) Natywny launcher (Scyzoryk.exe) + skrypt instalacji zaleznosci ---
# Scyzoryk.exe jest wynikiem budowania (launcher\Scyzoryk.Launcher, C#/.NET 8),
# NIE jest sciagany przez git archive jak reszta stagingu - build-launcher.ps1
# uruchamia jego wlasne testy jednostkowe i publikuje self-contained/single-file
# win-x64 EXE, ktory tu dopiero kopiujemy do stagingu.
$launcherExePath = & (Join-Path $Root 'scripts\build-launcher.ps1') -Version $Version
if ($LASTEXITCODE -ne 0 -or -not $launcherExePath -or -not (Test-Path $launcherExePath)) {
  throw "Budowa launchera (Scyzoryk.exe) nie powiodla sie - build-launcher.ps1 nie zwrocil poprawnej sciezki."
}
Copy-Item -Path $launcherExePath -Destination (Join-Path $stagingDir 'Scyzoryk.exe') -Force
Copy-Item -Path (Join-Path $Root 'installer\instaluj-zaleznosci.cmd') -Destination $stagingDir -Force

# --- 5) Kompilacja instalatora ---
$issPath = Join-Path $Root 'installer\scyzoryk.iss'
& $iscc $issPath "/DStagingDir=$stagingDir" "/DAppVersion=$Version" "/DOutputDir=$OutputDir"
$isccExit = $LASTEXITCODE

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stagingDir

if ($isccExit -ne 0) {
  Write-Error "Kompilacja instalatora nie powiodla sie (ISCC kod $isccExit)."
  exit $isccExit
}

$outputExe = Join-Path $OutputDir "ScyzorykProjektowy-Setup-$Version.exe"
if (Test-Path $outputExe) {
  $sizeMb = [math]::Round((Get-Item $outputExe).Length / 1MB, 1)
  $ocrLabel = if ($ocrIncluded) { 'z gotowym OCR' } else { 'bez wbudowanego OCR' }
  Write-Host "`nGotowe ($sizeMb MB, $ocrLabel): $outputExe"
} else {
  Write-Warning "ISCC zakonczyl sie sukcesem, ale nie znalazlem oczekiwanego pliku wyjsciowego: $outputExe"
}
