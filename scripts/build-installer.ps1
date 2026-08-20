# Buduje prawdziwe instalatory Windows (.exe, Inno Setup) dla Scyzoryka Projektowego.
#
# Audyt 2026-08-06 (Chrome/AV flagowaly pobrany instalator jako wirus na czesci
# komputerow + zastrzezenie wlasciciela: aktualizacje nie moga za kazdym razem
# pobierac ~1,2 GB node_modules/Chromium) - produkuje DWA pliki .exe z jednego
# przebiegu:
#   - ScyzorykProjektowy-Setup-<wersja>.exe  ("full")   - kompletny, offline
#     instalator: kod aplikacji, Scyzoryk.exe, portable Node.js ORAZ node_modules
#     wszystkich 9 aplikacji (w tym przegladarka Chromium dla Playwrighta) juz
#     zainstalowane. Zero pobierania/instalowania pakietow na komputerze
#     uzytkownika - npm install robi TEN skrypt, raz, przed spakowaniem.
#     Jedyny wariant zdolny do pierwszej instalacji/pelnej naprawy.
#   - ScyzorykProjektowy-Update-<wersja>.exe ("update") - to samo, ale BEZ
#     node-runtime i BEZ node_modules (~1/6 rozmiaru) - zaklada, ze runtime juz
#     jest na dysku z wczesniejszej pelnej instalacji. lib/updateService.js
#     wybiera ten wariant do zwyklych aktualizacji, gdy runtime-fingerprint.txt
#     (patrz scripts\generate-runtime-fingerprint.js) sie nie zmienil.
# Oba warianty:
#   - kopiuja czysty eksport repo (git archive HEAD),
#   - buduja i dolaczaja natywny launcher Scyzoryk.exe (C#/.NET 8, launcher\Scyzoryk.Launcher,
#     przez scripts\build-launcher.ps1) - jedyny sposob normalnego startu aplikacji,
#     bez CMD/PowerShell/VBS,
#   - instaluja sie per-uzytkownik, bez wymogu stalego konta administratora.
#
# OCR audytow (apps/ocr-audytow) od 2026-08-12 nie ma juz wbudowanej w instalator
# konfiguracji - korzysta z Google Gemini, ktorego klucz API uzytkownik wpisuje
# recznie w samej aplikacji przy pierwszym uruchomieniu (patrz
# apps/ocr-audytow/src/geminiFieldEngine.js). Nie ma juz osobnego "instalatora
# wewnetrznego z OCR" ani sekretu doklejanego podczas budowania.
#
# Uzycie:
#   powershell -File scripts\build-installer.ps1
#   powershell -File scripts\build-installer.ps1 -NodeVersion 24.19.0 -Version 1.2.3
#
# Audyt 2026-08-20: Node 20.x jest EOL (marzec 2026) - runtime bundlowany do
# instalatora przestal dostawac lataki bezpieczenstwa. Podbite do 24.19.0
# (aktualny LTS w dniu audytu). Przy kolejnych podbiciach: sprawdzic biezacy
# LTS na https://nodejs.org/dist/index.json (pole "lts" niepuste = aktywny LTS)
# i faktyczna dostepnosc paczki win-x64 pod tym adresem PRZED zmiana tej
# wartosci - build pobiera dokladnie ten zip, bez fallbacku.

param(
  [string]$NodeVersion = '24.19.0',
  [string]$Version = '',
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root 'release' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# Audyt 2026-08-17 (zmierzone na zywo w CI, ten sam "npm install-all" 5-15x
# wolniejszy tutaj niz chwile wczesniej przy repo root): na hostowanych
# windowsowych runnerach GitHub Actions $env:TEMP wskazuje na dysk C:, a
# checkout repo (i $env:RUNNER_TEMP) siedzi na wyraznie szybszym D:\a\...
# (potwierdzone w logu: "Working directory is 'D:\a\...'" kontra
# "C:\Users\RUNNER~1\AppData\Local\Temp\..." dla stagingu). Wypakowywanie
# node_modules kilkunastu aplikacji (tysiace malych plikow) na wolniejszym
# dysku to byl najwiekszy pojedynczy koszt czasowy calego workflow (~6,5
# minuty zamiast ~1). $env:RUNNER_TEMP istnieje tylko w CI - lokalny build
# wlasciciela (np. ZBUDUJ-INSTALATOR.cmd) nadal dostaje dotychczasowe
# zachowanie przez fallback do $env:TEMP.
$fastTempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }

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

# Krotki prefiks celowo - zlapane realnie w CI (GitHub Actions windows-latest,
# 2026-08-06): pelny wariant instalatora dolacza node_modules kazdej apki, w
# tym Chromium dla Playwrighta (glebokie, dlugie sciezki plikow) - dlugi
# prefiks stagingu ("scyzoryk-installer-staging-" + pelny GUID, prawie 60
# znakow ponad juz i tak dlugi $env:TEMP na runnerze) wystarczyl, zeby
# pojedyncze pliki przekroczyly limit Windows MAX_PATH (260 znakow), co ISCC
# zglaszal jako nieczytelne "the system cannot find the path specified" przy
# zupelnie innym, kolejnym Source (patrz walidacja node_modules ponizej,
# ktora teraz lapie to WCZESNIEJ, z czytelnym komunikatem).
$stagingDir = Join-Path $fastTempRoot ("sct-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

$archiveZip = Join-Path $fastTempRoot ("scyzoryk-archive-" + [guid]::NewGuid().ToString('N') + '.zip')
try {
  & git -C $Root archive --format=zip -o $archiveZip HEAD
  if ($LASTEXITCODE -ne 0) { throw "git archive nie powiodl sie (kod $LASTEXITCODE)" }
  Expand-Archive -Path $archiveZip -DestinationPath $stagingDir -Force
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $archiveZip
}
Write-Host "Rozpakowano eksport repo do: $stagingDir"

# --- 1.5) build-info.json - wersja/commit zainstalowanej kopii (patrz lib/updateBuildInfo.js) ---
$buildInfo = [ordered]@{
  version = $Version
  commit  = $commitHash
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText((Join-Path $stagingDir 'build-info.json'), ($buildInfo | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host 'Zapisano build-info.json.'

# --- 2) Bundlowany, portable Node.js (Windows x64) ---
$nodeCacheDir = Join-Path $fastTempRoot 'scyzoryk-node-cache'
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

$nodeExtractDir = Join-Path $fastTempRoot ("scyzoryk-node-extract-" + [guid]::NewGuid().ToString('N'))
Expand-Archive -Path $nodeZipPath -DestinationPath $nodeExtractDir -Force
$nodeSourceDir = Join-Path $nodeExtractDir "node-v$NodeVersion-win-x64"
if (-not (Test-Path $nodeSourceDir)) {
  throw "Nieoczekiwana struktura archiwum Node.js - brak folderu $nodeSourceDir"
}
$nodeRuntimeDir = Join-Path $stagingDir 'node-runtime'
Copy-Item -Path $nodeSourceDir -Destination $nodeRuntimeDir -Recurse -Force
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $nodeExtractDir
Write-Host "Bundlowany Node.js gotowy: $nodeRuntimeDir"

# --- 3) Natywny launcher (Scyzoryk.exe) ---
# Scyzoryk.exe jest wynikiem budowania (launcher\Scyzoryk.Launcher, C#/.NET 8),
# NIE jest sciagany przez git archive jak reszta stagingu - build-launcher.ps1
# uruchamia jego wlasne testy jednostkowe i publikuje self-contained/single-file
# win-x64 EXE, ktory tu dopiero kopiujemy do stagingu.
$launcherExePath = & (Join-Path $Root 'scripts\build-launcher.ps1') -Version $Version
if ($LASTEXITCODE -ne 0 -or -not $launcherExePath -or -not (Test-Path $launcherExePath)) {
  throw "Budowa launchera (Scyzoryk.exe) nie powiodla sie - build-launcher.ps1 nie zwrocil poprawnej sciezki."
}
Copy-Item -Path $launcherExePath -Destination (Join-Path $stagingDir 'Scyzoryk.exe') -Force

# --- 4) Zaleznosci kazdej aplikacji (npm install + Chromium dla Playwrighta) ---
# Audyt 2026-08-06 (Podejrzenie B): to kiedys robil ukryty CMD na komputerze
# UZYTKOWNIKA (installer\instaluj-zaleznosci.cmd, usuniety z [Run] w
# scyzoryk.iss). Ten sam efekt koncowy (node_modules kazdej apki gotowe),
# ale wykonany RAZ, tutaj, przy budowaniu - instalator juz nic nie pobiera.
# Uzywamy WLASNEJ, wlasnie skopiowanej kopii bundlowanego node-runtime (nie
# globalnego "node" z PATH maszyny budujacej) i WLASNYCH kopii
# scripts\install-all.js/check-project.js z tego samego stagingu (git archive
# juz je tam skopiowal w kroku 1) - __dirname w tych skryptach wskazuje wtedy
# na staging, wiec dzialaja dokladnie na apps\* w stagingu, nie w repo.
$stagingNodeExe = Join-Path $nodeRuntimeDir 'node.exe'
$env:PLAYWRIGHT_BROWSERS_PATH = '0'
Write-Host "`nInstaluje zaleznosci wszystkich aplikacji do stagingu (moze potrwac kilka minut)..."
& $stagingNodeExe (Join-Path $stagingDir 'scripts\install-all.js')
if ($LASTEXITCODE -ne 0) { throw "Instalacja zaleznosci do stagingu nie powiodla sie (kod $LASTEXITCODE)." }
& $stagingNodeExe (Join-Path $stagingDir 'scripts\check-project.js')
if ($LASTEXITCODE -ne 0) { throw "Sprawdzenie projektu w stagingu nie powiodlo sie (kod $LASTEXITCODE)." }
Write-Host "Zaleznosci gotowe w stagingu."

# --- 5) Fingerprint runtime (Node + wszystkie package-lock.json) ---
# Uzywany przez lib/updateService.js do wyboru miedzy pelnym a aktualizacyjnym
# instalatorem - patrz scripts\generate-runtime-fingerprint.js. Liczony z
# WLASNEJ kopii skryptu w stagingu (ten sam powod co krok 5), ale wynik jest
# identyczny z policzonym z repo - package-lock.json sa kopiowane 1:1 przez
# git archive, npm install ich nie modyfikuje.
$fingerprintPath = Join-Path $stagingDir 'runtime-fingerprint.txt'
& $stagingNodeExe (Join-Path $stagingDir 'scripts\generate-runtime-fingerprint.js') $NodeVersion $fingerprintPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $fingerprintPath)) {
  throw "Wygenerowanie runtime-fingerprint.txt nie powiodlo sie (kod $LASTEXITCODE)."
}
$runtimeFingerprint = (Get-Content -Raw -Path $fingerprintPath).Trim()
Write-Host "Runtime fingerprint: $runtimeFingerprint"
# Kopia do OutputDir - workflow release'owy publikuje ten plik jako
# WLASNY, maly asset wydania (obok obu instalatorow), zeby
# lib/updateService.js moglo sprawdzic zgodnosc runtime BEZ pobierania
# ktoregokolwiek z duzych plikow .exe.
Copy-Item -Path $fingerprintPath -Destination (Join-Path $OutputDir 'runtime-fingerprint.txt') -Force

# --- 6) Walidacja stagingu PRZED wywolaniem ISCC ---
# Zlapane realnie w CI: gdy ktoregokolwiek apps\*\node_modules zabraknie albo
# jest pusty, ISCC zglasza nieczytelne "the system cannot find the path
# specified" przy zupelnie innym, NASTEPNYM Source w [Files] (bo kompiluje
# je w kolejnosci) - bez zwiazku z prawdziwa przyczyna. Sprawdzamy to tutaj
# jawnie, dla kazdej apki osobno, z czytelnym komunikatem.
$appsWithMissingModules = @()
foreach ($appDir in Get-ChildItem (Join-Path $stagingDir 'apps') -Directory) {
  $nm = Join-Path $appDir.FullName 'node_modules'
  $hasFiles = (Test-Path $nm) -and @(Get-ChildItem $nm -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1).Count -gt 0
  if (-not $hasFiles) { $appsWithMissingModules += $appDir.Name }
}
if ($appsWithMissingModules.Count -gt 0) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stagingDir
  throw "Brak/pusty node_modules w stagingu dla: $($appsWithMissingModules -join ', ') - instalacja zaleznosci (krok 5) nie powiodla sie po cichu dla tych aplikacji."
}
Write-Host "Walidacja node_modules w stagingu OK."

# --- 7) Kompilacja obu wariantow instalatora z tego samego stagingu ---
$issPath = Join-Path $Root 'installer\scyzoryk.iss'
$results = @()
foreach ($variant in @('full', 'update')) {
  Write-Host "`n=== Kompiluje wariant: $variant ==="
  & $iscc $issPath "/DStagingDir=$stagingDir" "/DAppVersion=$Version" "/DOutputDir=$OutputDir" "/DBuildVariant=$variant"
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stagingDir
    Write-Error "Kompilacja instalatora (wariant $variant) nie powiodla sie (ISCC kod $LASTEXITCODE)."
    exit $LASTEXITCODE
  }
  $prefix = if ($variant -eq 'full') { 'Setup' } else { 'Update' }
  $results += Join-Path $OutputDir "ScyzorykProjektowy-$prefix-$Version.exe"
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stagingDir

Write-Host "`nGotowe:"
foreach ($outputExe in $results) {
  if (Test-Path $outputExe) {
    $sizeMb = [math]::Round((Get-Item $outputExe).Length / 1MB, 1)
    Write-Host "  $outputExe ($sizeMb MB)"
  } else {
    Write-Warning "ISCC zakonczyl sie sukcesem, ale nie znalazlem oczekiwanego pliku wyjsciowego: $outputExe"
  }
}
Write-Host "Runtime fingerprint tego wydania: $runtimeFingerprint"
