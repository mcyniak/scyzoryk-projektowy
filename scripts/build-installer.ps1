# Buduje prawdziwy instalator Windows (.exe, Inno Setup) dla Scyzoryka Projektowego.
#
# W odroznieniu od scripts/build-package.js (ZIP do recznego rozpakowania), ten skrypt
# produkuje jeden plik setup.exe, ktory:
#   - kopiuje czysty eksport repo (git archive HEAD - ten sam zestaw plikow co ZIP),
#   - dolacza bundlowany, portable Node.js (Windows x64), zeby uzytkownik koncowy nie
#     musial miec Node.js zainstalowanego globalnie,
#   - podczas instalacji uruchamia scripts/install-all.js (uzywajac WYLACZNIE
#     bundlowanego node/npm) zeby od razu doinstalowac zaleznosci kazdej aplikacji +
#     przegladarke Chromium dla Playwrighta,
#   - opcjonalnie dolacza konfiguracje Google Document AI przekazana przez bezpieczne
#     zmienne srodowiskowe procesu budowania,
#   - instaluje sie per-uzytkownik, bez wymogu uprawnien administratora.
#
# Wymaga: git, polaczenia z internetem (pobranie portable Node.js przy pierwszym
# uruchomieniu - potem cache w %TEMP%), Inno Setup 6 (ISCC.exe) - GitHub-hostowany
# runner "windows-latest" ma go juz zainstalowanego domyslnie.
#
# Opcjonalna konfiguracja OCR podczas budowania:
#   OCR_DOCAI_CREDENTIALS_B64 - plik JSON konta serwisowego zakodowany Base64
#   OCR_DOCAI_PROJECT_ID
#   OCR_DOCAI_LOCATION
#   OCR_DOCAI_PROCESSOR_ID
# Wszystkie cztery wartosci musza byc podane razem. Nie sa zapisywane w repozytorium,
# lecz gotowy instalator bedzie zawieral dane logowania i dlatego powinien byc
# rozpowszechniany tylko wewnetrznie.
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
    Write-Warning 'Instalator zostanie zbudowany bez konfiguracji Google Document AI. OCR uruchomi sie lokalnie, ale pliki wymagajace OCR nie zostana przetworzone.'
    return
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
    Get-Content -Raw -Path $credentialsPath -Encoding UTF8 | ConvertFrom-Json | Out-Null
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $credentialsPath
    throw 'Dane OCR po zdekodowaniu nie sa poprawnym plikiem JSON konta serwisowego.'
  }

  $config = [ordered]@{
    projectId   = $values.OCR_DOCAI_PROJECT_ID.Trim()
    location    = $values.OCR_DOCAI_LOCATION.Trim()
    processorId = $values.OCR_DOCAI_PROCESSOR_ID.Trim()
    keyFile     = 'service-account.json'
  }
  $config | ConvertTo-Json | Set-Content -Path (Join-Path $configDir 'document-ai.json') -Encoding UTF8

  Write-Host 'Dolaczono konfiguracje Google Document AI do wewnetrznego instalatora.'
  Write-Warning 'Gotowy instalator zawiera dane konta serwisowego. Traktuj plik EXE jak poufny i nie publikuj go publicznie.'
}

$iscc = Find-ISCC
if (-not $iscc) {
  Write-Error "Nie znaleziono ISCC.exe (kompilator Inno Setup 6). Zainstaluj z https://jrsoftware.org/isdl.php albo 'winget install JRSoftware.InnoSetup', potem uruchom ponownie."
  exit 1
}
Write-Host "Uzywam ISCC: $iscc"

# --- 1) Czysty eksport repo (git archive HEAD - to samo co scripts/build-package.js) ---
$dirty = (& git -C $Root status --porcelain)
if ($dirty) {
  Write-Warning "W drzewie roboczym sa niescommitowane zmiany - NIE trafia one do instalatora (pakowany jest ostatni commit HEAD)."
}

if (-not $Version) {
  $Version = (& git -C $Root rev-parse --short HEAD).Trim()
}
Write-Host "Wersja instalatora: $Version"

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

# --- 2) Opcjonalna konfiguracja Google Document AI ---
Add-OcrConfigurationToStaging -StagingDir $stagingDir

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

# --- 4) Launcher + skrypt instalacji zaleznosci (installer\ w repo) ---
Copy-Item -Path (Join-Path $Root 'installer\Uruchom-Scyzoryk.cmd') -Destination $stagingDir -Force
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
  Write-Host "`nGotowe ($sizeMb MB): $outputExe"
} else {
  Write-Warning "ISCC zakonczyl sie sukcesem, ale nie znalazlem oczekiwanego pliku wyjsciowego: $outputExe"
}
