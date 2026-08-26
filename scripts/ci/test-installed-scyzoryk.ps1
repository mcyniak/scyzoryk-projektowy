param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$LogsDir,
  # Audyt 2026-08-06 - opcjonalny maly instalator aktualizacyjny (bez
  # node-runtime/node_modules, patrz scripts\build-installer.ps1). Gdy podany,
  # dodatkowy test naklada go na juz zainstalowana (przez $InstallerPath,
  # pelna) kopie i sprawdza, ze runtime przetrwal nietkniety. Pominiety, gdy
  # nie podano - InstallerPath sam w sobie zawsze musi byc PELNYM instalatorem.
  [string]$UpdateInstallerPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$InstallerPath = (Resolve-Path $InstallerPath).Path
if ($UpdateInstallerPath) { $UpdateInstallerPath = (Resolve-Path $UpdateInstallerPath).Path }
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:TaskName = 'Scyzoryk CI test instalatora'

# Ten skrypt uruchamia PRAWDZIWA, zainstalowana aplikacje (root + do 8 dzieci)
# na swiezym runnerze GitHub Actions przy KAZDYM przebiegu - bez tego
# wylaczenia kazdy przebieg CI rejestrowalby sie jako nowa "instalacja" w
# prawdziwym monitorze telemetrii (scyzoryk-monitor.scyzoryk.workers.dev),
# zawyzajac liczniki instalacji/uzycia widoczne wlascicielowi na Discordzie
# (zaobserwowane na zywo - liczba "instalacji" nie mialo zwiazku z realna
# liczba maszyn). Ustawiamy zarowno w biezacej sesji (obejmuje kazdy
# Start-Process nizej, w tym --apply-update) jak i w rejestrze na poziomie
# Machine (obejmuje zadanie Harmonogramu Zadan uruchamiane przez
# Scyzoryk.exe --autostart, ktore NIE dziedziczy zmiennych z tej sesji
# PowerShell - Task Scheduler odczytuje srodowisko z rejestru przy starcie).
$env:SCYZORYK_TELEMETRY_ENABLED = '0'
[Environment]::SetEnvironmentVariable('SCYZORYK_TELEMETRY_ENABLED', '0', 'Machine')

foreach ($sub in 'install','app-logs','reports','input','screenshots') {
  New-Item -ItemType Directory -Force -Path (Join-Path $LogsDir $sub) | Out-Null
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Run-Test {
  param([string]$Name, [scriptblock]$Body)
  Write-Host "`n=== $Name ==="
  try {
    & $Body
    Write-Host "OK: $Name"
  } catch {
    $message = $_.Exception.Message
    $script:Failures.Add("$Name`: $message")
    # -ErrorAction Continue: bez tego, globalne $ErrorActionPreference =
    # 'Stop' (ustawione na starcie skryptu) zmienia Write-Error w blad
    # TERMINUJACY, co zabijaloby CALY skrypt na PIERWSZYM nieudanym tescie -
    # dokladnie wbrew celowi zbierania $script:Failures i podsumowania na
    # koniec (zlapane realnie: jeden nieudany test ucinal reszte przebiegu).
    Write-Error "$Name`: $message" -ErrorAction Continue
  }
}

# Audyt zuzycia RAM 2026-08-21 (lazy-start): apki-dzieci JUZ NIE startuja
# automatycznie razem z panelem - kazda startuje dopiero na zadanie
# (POST /api/apps/:slug/start, patrz server.js#ensureChildStarted). Ten test
# CI wczesniej zakladal, ze po samym starcie Scyzoryk.exe wszystkie apki juz
# odpowiadaja - teraz trzeba je jawnie poprosic o start, tak jak robi to
# klikniecie "Otworz" w prawdziwym panelu.
function Start-ScyzorykApp {
  param([string]$Slug)
  # Retry, nie pojedyncza proba: tuz po (re)starcie panelu (np. zaraz po
  # wyzwoleniu zadania --autostart) sam panel moze jeszcze nie sluchac na
  # porcie - bez ponawiania to "poprosze o start" ginelo w ciszy i apka
  # nigdy by nie dostala zadania startu, mimo ze pozniejszy health-check
  # cierpliwie by na nia czekal 90s.
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/apps/$Slug/start" -Method Post -Headers @{ 'X-Scyzoryk-Request' = '1' } -TimeoutSec 5 -UseBasicParsing | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  # Nie przerywamy tutaj nawet po wyczerpaniu prob - kolejny health-check i
  # tak zglosi czytelny blad, jesli apka faktycznie nie wstanie.
}

function Start-AllScyzorykApps {
  param([string[]]$Slugs)
  foreach ($slug in $Slugs) { Start-ScyzorykApp -Slug $slug }
}

$script:AllAppSlugs = @(
  'drukarka','pieczatki-pdf','formularze-ecodan','dokumenty-seryjne','wnioski-powykonawcze',
  'karty-katalogowe','drukarka-projekty','ocr-audytow','formularze-varmero','nazywarka-skanow',
  'tworzenie-folderow','protokoly','pipeline'
)

function Stop-Scyzoryk {
  # Scyzoryk.exe --stop jest tym samym mechanizmem, ktorego uzywa [UninstallRun]
  # (patrz installer\scyzoryk.iss) - testujemy tu realna, uzytkownikowi widoczna
  # sciezke zatrzymania, nie osobna, prywatna implementacje.
  $launcherExe = Join-Path $InstallDir 'Scyzoryk.exe'
  if (Test-Path $launcherExe) {
    # Scyzoryk.exe jest aplikacja WinExe. Bez Start-Process -Wait PowerShell
    # moze przejsc dalej, zanim proces --stop zwolni plik EXE. Wtedy Restart
    # Manager nadal widzi aplikacje Scyzoryk i cicha instalacja konczy sie
    # kodem 5. Prawdziwy aktualizator uzywa tego samego oczekiwania.
    $stopProc = Start-Process -FilePath $launcherExe -ArgumentList @('--stop') -Wait -PassThru -WindowStyle Hidden
    Assert-True ($stopProc.ExitCode -eq 0) "Scyzoryk.exe --stop zakonczyl sie kodem $($stopProc.ExitCode)."
  }
  if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
  }

  # Czekamy, az WSZYSTKIE procesy node.exe tej instalacji (glowny panel +
  # osmiu jego dzieci - server.js spawnuje po jednym procesie na aplikacje)
  # faktycznie zakoncza dzialanie, zamiast na slepo spac 2s. Zlapane realnie:
  # sam sleep nie zawsze wystarczal - Windows Restart Manager przy nastepnej
  # cichej instalacji potrafil jeszcze zobaczyc "Node.js JavaScript Runtime"
  # jako trzymajacy pliki i pod /SUPPRESSMSGBOXES automatycznie przerywal
  # instalacje (Setup.exe kod wyjscia 5) - dokladnie ten problem, przed
  # ktorym Scyzoryk.exe --apply-update (prawdziwy aktualizator) juz sie chroni
  # wlasna petla potwierdzajaca zamkniecie procesow.
  $nodeExe = Join-Path $InstallDir 'node-runtime\node.exe'
  if (Test-Path $nodeExe) {
    $nodeExeFull = (Resolve-Path $nodeExe).Path
    $deadline = (Get-Date).AddSeconds(20)
    do {
      $remaining = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $nodeExeFull) })
      if ($remaining.Count -eq 0) { break }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
  }
  # Dodatkowy krotki bufor na zwolnienie uchwytow plikow przez system po
  # zakonczeniu procesow (TerminateProcess nie gwarantuje natychmiastowego
  # zwolnienia wszystkich uchwytow), zanim wywolujacy odpali kolejny instalator.
  Start-Sleep -Seconds 2
}

Run-Test 'Instalacja na swiezym Windowsie' {
  $log = Join-Path $LogsDir 'install\install.log'
  $args = @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/MERGETASKS=!autostart',
    "/DIR=`"$InstallDir`"", "/LOG=`"$log`""
  )
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Instalator zakonczyl sie kodem $($proc.ExitCode)."
}

Run-Test 'Kompletnosc zainstalowanej aplikacji' {
  $required = @(
    'Scyzoryk.exe',
    'server.js','package.json','public\index.html','public\instrukcja.html','shared-styles\help.css',
    'node-runtime\node.exe','node-runtime\npm.cmd','unins000.exe',
    'lib\printing\SumatraPDF.exe',
    'lib\printing\ghostscript\bin\gswin64c.exe',
    'lib\printing\ghostscript\bin\gsdll64.dll',
    'lib\printing\ghostscript\Resource\Init\gs_init.ps',
    'apps\drukarka\node_modules\express',
    'apps\pieczatki-pdf\node_modules\express',
    'apps\formularze-ecodan\node_modules\playwright',
    'apps\dokumenty-seryjne\node_modules\express',
    'apps\wnioski-powykonawcze\node_modules\express',
    'apps\karty-katalogowe\node_modules\express',
    'apps\drukarka-projekty\node_modules\express',
    'apps\ocr-audytow\node_modules\express'
  )
  $missing = @($required | Where-Object { -not (Test-Path (Join-Path $InstallDir $_)) })
  Assert-True ($missing.Count -eq 0) "Brakuje elementow instalacji: $($missing -join ', ')"

  # OCR audytow (Google Gemini od 2026-08-12, patrz apps/ocr-audytow/src/geminiFieldEngine.js)
  # nie ma juz zadnej konfiguracji bakowanej w instalator - klucz API uzytkownik
  # wpisuje recznie w samej aplikacji. Zaden wariant instalatora nie powinien
  # nigdy zawierac tych plikow.
  $configPath = Join-Path $InstallDir 'apps\ocr-audytow\config\document-ai.json'
  $keyPath = Join-Path $InstallDir 'apps\ocr-audytow\config\service-account.json'
  Assert-True (-not (Test-Path $configPath)) 'Instalator nie powinien zawierac wbudowanej konfiguracji OCR.'
  Assert-True (-not (Test-Path $keyPath)) 'Instalator nie powinien zawierac wbudowanego klucza OCR.'
}

Run-Test 'Aktualny panel i instrukcja w instalatorze' {
  $indexPath = Join-Path $InstallDir 'public\index.html'
  $instructionPath = Join-Path $InstallDir 'public\instrukcja.html'
  # -Encoding UTF8 jest tu obowiazkowe: bez niego Windows PowerShell 5.1
  # czyta plik bez BOM w systemowej stronie kodowej (nie UTF-8), co lamie
  # porownanie polskich znakow ("Drukarka dokumentów", "OCR audytów") -
  # zlapane realnie lokalnie (system nie majacy domyslnie codepage 65001).
  $html = Get-Content $indexPath -Raw -Encoding UTF8
  $instruction = Get-Content $instructionPath -Raw -Encoding UTF8

  $requiredFragments = @(
    'data-app="drukarka"',
    'data-app="drukarka-projekty"',
    'data-app="dokumenty-seryjne"',
    'data-app="wnioski-powykonawcze"',
    'data-app="formularze-ecodan"',
    'data-app="formularze-varmero"',
    'data-app="pieczatki-pdf"',
    'data-app="nazywarka-skanow"',
    'data-app="protokoly"',
    'data-app="karty-katalogowe"',
    'data-app="ocr-audytow"',
    'data-app="tworzenie-folderow"',
    'href="/instrukcja.html"',
    '<h3>Drukarka dokumentów</h3>',
    '<h3>Drukarka projektów</h3>',
    '<h3>Dokumenty seryjne PDF</h3>',
    '<h3>Wnioski powykonawcze PDF</h3>',
    '<h3>Dobory myEcodan</h3>',
    '<h3>Dobory Varmero</h3>',
    '<h3>Pieczątki PDF</h3>',
    '<h3>Nazywarka skanów</h3>',
    '<h3>Zdjęcia do PDF Protokołów</h3>',
    '<h3>Przypisywanie plików do folderów</h3>',
    '<h3>OCR audytów</h3>',
    '<h3>Tworzenie folderów</h3>'
  )
  $missing = @($requiredFragments | Where-Object { -not $html.Contains($_) })
  Assert-True ($missing.Count -eq 0) "W panelu brakuje stabilnych elementow: $($missing -join ' | ')"
  Assert-True (-not $html.Contains('helpModalOverlay')) 'Panel nadal zawiera stary modal pomocy.'

  $instructionFragments = @(
    'Instrukcja obsługi Scyzoryka Projektowego',
    'Drukarka dokumentów',
    'Drukarka projektów',
    'Zdjęcia do PDF Protokołów',
    'Dokumenty seryjne PDF',
    'Wnioski powykonawcze PDF',
    'Dobory myEcodan',
    'Pieczątki PDF',
    'Przypisywanie plików do folderów',
    'OCR audytów',
    'Dobory Varmero',
    'Nazywarka skanów',
    'Tworzenie folderów',
    'pierwsze trzy strony'
  )
  $missingInstruction = @($instructionFragments | Where-Object { -not $instruction.Contains($_) })
  Assert-True ($missingInstruction.Count -eq 0) "Instrukcja jest niekompletna: $($missingInstruction -join ' | ')"
  Assert-True (-not $instruction.Contains('Formularze Ecodan')) 'Instrukcja nadal zawiera stara nazwe Formularze Ecodan.'
  Assert-True (-not $instruction.Contains('Formularze Varmero')) 'Instrukcja nadal zawiera stara nazwe Formularze Varmero.'
}

Run-Test 'Regresje zainstalowanej wersji' {
  $npm = Join-Path $InstallDir 'node-runtime\npm.cmd'
  Push-Location $InstallDir
  try {
    & $npm run test:regressions
    Assert-True ($LASTEXITCODE -eq 0) 'Testy regresyjne zainstalowanej wersji nie przeszly.'
  } finally {
    Pop-Location
  }
}

Run-Test 'Sortowanie dokumentow projektowych' {
  $node = Join-Path $InstallDir 'node-runtime\node.exe'
  Push-Location (Join-Path $InstallDir 'apps\drukarka-projekty')
  try {
    & $node test-sorting-regression.js
    Assert-True ($LASTEXITCODE -eq 0) 'Test sortowania nie przeszedl.'
  } finally {
    Pop-Location
  }
}

Run-Test 'Utworzenie testowego PDF' {
  $node = Join-Path $InstallDir 'node-runtime\node.exe'
  $pdf = Join-Path $LogsDir 'input\testowy dokument.pdf'
  & $node (Join-Path $PSScriptRoot 'create-sample-pdf.js') $pdf
  Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path $pdf)) 'Nie utworzono testowego PDF.'
}

Run-Test 'Uruchomienie Scyzoryka przez Scyzoryk.exe --autostart (bez globalnego Node.js)' {
  $launcherExe = Join-Path $InstallDir 'Scyzoryk.exe'
  Assert-True (Test-Path $launcherExe) "Brak $launcherExe - niekompletna instalacja."

  if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
  }
  # Dokladnie ta sama Akcja, jaka scripts\install-autostart.ps1 rejestruje na
  # prawdziwej instalacji (Execute=Scyzoryk.exe, Argument=--autostart) - testujemy
  # realny mechanizm autostartu. Scyzoryk.exe sam sobie ustawia PATH/env
  # wewnetrznie (patrz ProcessManager.cs) - nie trzeba juz recznie ograniczac PATH.
  $action = New-ScheduledTaskAction -Execute $launcherExe -Argument '--autostart'
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $script:TaskName -Action $action -Principal $principal -Settings $settings | Out-Null

  $script:AutostartTriggerTime = Get-Date
  Start-ScheduledTask -TaskName $script:TaskName
}

Run-Test 'Autostart nie tworzy cmd.exe/wscript.exe/cscript.exe (lancuch wygladajacy jak dropper)' {
  # Audyt, ktory doprowadzil do powstania Scyzoryk.exe: normalny start NIE moze
  # przechodzic przez CMD/VBS/dodatkowy PowerShell. Sprawdzamy calosc procesow w
  # systemie powstalych PO wyzwoleniu zadania (nie tylko potomkow Scyzoryk.exe -
  # sam launcher jest efemeryczny, konczy sie po odpaleniu serwera, wiec nie da
  # sie juz sprawdzic jego wlasnych, minionych procesow potomnych).
  Start-Sleep -Seconds 3
  $forbiddenFilter = "Name='cmd.exe' OR Name='wscript.exe' OR Name='cscript.exe'"
  $suspicious = @(Get-CimInstance Win32_Process -Filter $forbiddenFilter | Where-Object {
    try { [Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate) -ge $script:AutostartTriggerTime }
    catch { $true }
  })
  $details = ($suspicious | ForEach-Object { "$($_.Name) PID $($_.ProcessId)" }) -join ', '
  Assert-True ($suspicious.Count -eq 0) "Wykryto procesy-powloki po autostarcie: $details"
}

Run-Test 'Health-check wszystkich narzedzi i stan OCR' {
  $checks = @(
    @{ name='panel'; port=3000; path='/api/apps' },
    @{ name='drukarka'; port=3001; path='/api/health'; expectedName='drukarka' },
    @{ name='pieczatki-pdf'; port=3002; path='/api/health'; expectedName='pieczatki-pdf' },
    @{ name='formularze-ecodan'; port=3003; path='/api/health'; expectedName='formularze-ecodan' },
    @{ name='dokumenty-seryjne'; port=3004; path='/api/health'; expectedName='dokumenty-seryjne' },
    @{ name='wnioski-powykonawcze'; port=3005; path='/api/health'; expectedName='wnioski-powykonawcze' },
    @{ name='karty-katalogowe'; port=3006; path='/api/health'; expectedName='karty-katalogowe' },
    @{ name='drukarka-projekty'; port=3010; path='/api/health'; expectedName='drukarka-projekty' },
    @{ name='ocr-audytow'; port=3011; path='/api/health'; expectedName='ocr-audytow' }
  )

  Start-AllScyzorykApps -Slugs ($checks | Where-Object { $_.name -ne 'panel' } | ForEach-Object { $_.name })

  foreach ($check in $checks) {
    $deadline = (Get-Date).AddSeconds(90)
    $ok = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($check.port)$($check.path)" -UseBasicParsing -TimeoutSec 3
        $payload = $response.Content | ConvertFrom-Json
        $nameMatches = (-not $check.ContainsKey('expectedName')) -or ($payload.name -eq $check.expectedName)
        if ($response.StatusCode -eq 200 -and $payload.ok -eq $true -and $nameMatches) { $ok = $true; break }
      } catch {}
      Start-Sleep -Seconds 2
    }
    Assert-True $ok "Nie odpowiada: $($check.name)"
  }

  $ocr = Invoke-RestMethod 'http://127.0.0.1:3011/api/health' -TimeoutSec 10
  $ocr | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $LogsDir 'reports\ocr-health.json') -Encoding utf8
  Assert-True ($ocr.ocrConfigured -eq $false) 'Swiezo zainstalowana kopia nie powinna miec skonfigurowanego klucza API Gemini (zaden instalator go nie bakuje).'
}

Run-Test 'Przyjazny adres http://scyzoryk.localhost:3000 dziala w Chromium bez konfiguracji' {
  # Invoke-WebRequest korzysta z systemowego resolvera Windows, ktory na runnerze
  # GitHub Actions nie obsluguje subdomen *.localhost. Uzytkownik otwiera ten
  # adres w Edge/Chrome, wiec test przechodzi przez prawdziwy silnik Chromium.
  # Nie dodajemy wpisu hosts ani sztucznych reguł rozwiązywania nazw.
  $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $hostsText = Get-Content $hostsPath -Raw -ErrorAction SilentlyContinue
  Assert-True ($hostsText -notmatch '(?i)\bscyzoryk\.localhost\b') 'Testowy Windows ma wpis scyzoryk.localhost w hosts, wiec test nie sprawdza wariantu bez konfiguracji.'

  $targetsPath = Join-Path $LogsDir 'friendly-localhost-target.json'
  $targetJson = '[{"slug":"friendly-localhost-health","url":"http://scyzoryk.localhost:3000/api/health"}]'
  [IO.File]::WriteAllText($targetsPath, $targetJson, [Text.UTF8Encoding]::new($false))

  $env:NODE_PATH = Join-Path $InstallDir 'apps\formularze-ecodan\node_modules'
  $env:PLAYWRIGHT_BROWSERS_PATH = '0'
  $node = Join-Path $InstallDir 'node-runtime\node.exe'
  $screenshotDir = Join-Path $LogsDir 'screenshots\friendly-localhost'
  & $node (Join-Path $PSScriptRoot 'screenshot-all.js') $screenshotDir $targetsPath
  Assert-True ($LASTEXITCODE -eq 0) 'Chromium nie otworzyl http://scyzoryk.localhost:3000/api/health bez wpisu w hosts.'
}

Run-Test 'build-info.json obecny i zgodny z wersja z /api/health' {
  $buildInfoPath = Join-Path $InstallDir 'build-info.json'
  Assert-True (Test-Path $buildInfoPath) 'Brak build-info.json w zainstalowanej wersji (patrz scripts\build-installer.ps1).'
  $buildInfo = Get-Content $buildInfoPath -Raw | ConvertFrom-Json
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]$buildInfo.version)) 'build-info.json nie ma pola "version".'
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]$buildInfo.commit)) 'build-info.json nie ma pola "commit".'
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]$buildInfo.builtAt)) 'build-info.json nie ma pola "builtAt".'

  $health = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 10
  Assert-True ($health.version -eq $buildInfo.version) "Wersja dzialajacej aplikacji ($($health.version)) nie zgadza sie z build-info.json ($($buildInfo.version))."
}

Run-Test 'Endpoint /api/update/status odpowiada z poprawnym kontraktem' {
  $status = Invoke-RestMethod 'http://127.0.0.1:3000/api/update/status' -TimeoutSec 10
  foreach ($field in @('enabled', 'state', 'available', 'currentVersion')) {
    Assert-True ($status.PSObject.Properties.Name -contains $field) "Odpowiedz /api/update/status nie ma pola `"$field`"."
  }
}

Run-Test 'Zrzuty ekranow wszystkich narzedzi i instrukcji' {
  Start-AllScyzorykApps -Slugs $script:AllAppSlugs
  $targetsPath = Join-Path $LogsDir 'screenshot-targets.json'
  @(
    @{slug='01-panel'; url='http://127.0.0.1:3000/'},
    @{slug='02-drukarka'; url='http://127.0.0.1:3001/'},
    @{slug='03-pieczatki'; url='http://127.0.0.1:3002/'},
    @{slug='04-formularze'; url='http://127.0.0.1:3003/'},
    @{slug='05-dokumenty-seryjne'; url='http://127.0.0.1:3004/'},
    @{slug='06-wnioski'; url='http://127.0.0.1:3005/'},
    @{slug='07-karty'; url='http://127.0.0.1:3006/'},
    @{slug='08-drukarka-projekty'; url='http://127.0.0.1:3010/'},
    @{slug='09-ocr'; url='http://127.0.0.1:3011/'},
    @{slug='10-instrukcja'; url='http://127.0.0.1:3000/instrukcja.html'},
    @{slug='11-varmero'; url='http://127.0.0.1:3012/'},
    @{slug='12-nazywarka-skanow'; url='http://127.0.0.1:3007/'},
    @{slug='13-tworzenie-folderow'; url='http://127.0.0.1:3013/'},
    @{slug='14-protokoly'; url='http://127.0.0.1:3014/'},
    @{slug='15-pipeline'; url='http://127.0.0.1:3015/'}
  ) | ConvertTo-Json | Set-Content $targetsPath -Encoding utf8

  $env:NODE_PATH = Join-Path $InstallDir 'apps\formularze-ecodan\node_modules'
  $env:PLAYWRIGHT_BROWSERS_PATH = '0'
  $node = Join-Path $InstallDir 'node-runtime\node.exe'
  & $node (Join-Path $PSScriptRoot 'screenshot-all.js') (Join-Path $LogsDir 'screenshots') $targetsPath
  Assert-True ($LASTEXITCODE -eq 0) 'Nie udalo sie wykonac wszystkich zrzutow ekranow.'
}

Run-Test 'Pieczatki PDF' {
  $pdf = Join-Path $LogsDir 'input\testowy dokument.pdf'
  $out = Join-Path $LogsDir 'reports\pieczatki-wynik.pdf'
  $form = @{
    pdfs = Get-Item $pdf
    stampText = 'TEST CI'
    xPct = '10'; yPct = '10'; widthPct = '40'; heightPct = '15'
    rotation = '0'; opacity = '1'; pageMode = 'all'; fontSize = '20'
  }
  $response = Invoke-WebRequest 'http://127.0.0.1:3002/api/stamp' -Method Post -Form $form -Headers @{ 'X-Scyzoryk-Request'='1' } -TimeoutSec 30 -UseBasicParsing
  [IO.File]::WriteAllBytes($out, $response.Content)
  Assert-True ((Test-Path $out) -and (Get-Item $out).Length -gt 10) 'Pieczatki PDF nie utworzyly wyniku.'
}

Run-Test 'Drukarka dokumentow' {
  $pdf = Join-Path $LogsDir 'input\testowy dokument.pdf'
  $response = Invoke-RestMethod 'http://127.0.0.1:3001/api/upload' -Method Post -Form @{ files = Get-Item $pdf } -Headers @{ 'X-Scyzoryk-Request'='1' } -TimeoutSec 30
  Assert-True ([bool]$response.ok) 'Upload do Drukarki nie powiodl sie.'
  $queue = Invoke-RestMethod 'http://127.0.0.1:3001/api/queue' -TimeoutSec 10
  Assert-True ($queue.queue -and $queue.queue.Count -ge 1) 'Kolejka Drukarki jest pusta.'
  Invoke-RestMethod 'http://127.0.0.1:3001/api/clear' -Method Post -Headers @{ 'X-Scyzoryk-Request'='1' } | Out-Null
}

Run-Test 'Tryb /SCYZORYKUPDATE: cicha reinstalacja bez ponownej konfiguracji autostartu i bez drugiego wpisu aplikacji' {
  Stop-Scyzoryk

  $uninstallKeysBefore = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Scyzoryk Projektowy' })
  Assert-True ($uninstallKeysBefore.Count -eq 1) "Oczekiwano dokladnie 1 wpisu odinstalowywania PRZED cicha aktualizacja, jest $($uninstallKeysBefore.Count)."

  $autostartTaskName = 'Scyzoryk Projektowy - autostart'
  if (Get-ScheduledTask -TaskName $autostartTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $autostartTaskName -Confirm:$false
  }

  $log = Join-Path $LogsDir 'install\update-mode.log'
  # /MERGETASKS=autostart PROBUJE zaznaczyc zadanie autostartu mimo trybu
  # cichego - to jest kluczowy test: /SCYZORYKUPDATE (Check: not IsScyzorykUpdate
  # w installer\scyzoryk.iss [Tasks]) musi WYGRAC i zablokowac to zadanie,
  # zeby aktualizacja nigdy nie wywolala UAC/edycji pliku hosts.
  $args = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/SCYZORYKUPDATE', '/MERGETASKS=autostart', "/DIR=`"$InstallDir`"", "/LOG=`"$log`"")
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Cicha aktualizacja (/SCYZORYKUPDATE) zakonczyla sie kodem $($proc.ExitCode)."

  $autostartTask = Get-ScheduledTask -TaskName $autostartTaskName -ErrorAction SilentlyContinue
  Assert-True ($null -eq $autostartTask) 'Tryb /SCYZORYKUPDATE zarejestrowal zadanie autostartu (UAC/hosts), mimo ze mial to pominac.'

  $uninstallKeysAfter = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Scyzoryk Projektowy' })
  Assert-True ($uninstallKeysAfter.Count -eq 1) "Cicha aktualizacja utworzyla drugi wpis aplikacji (jest $($uninstallKeysAfter.Count) wpisow) - powinna byc dokladnie 1."
}

Run-Test 'Ponowna instalacja' {
  Stop-Scyzoryk
  $log = Join-Path $LogsDir 'install\reinstall.log'
  $args = @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/MERGETASKS=!autostart',
    "/DIR=`"$InstallDir`"", "/LOG=`"$log`""
  )
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Ponowna instalacja zakonczyla sie kodem $($proc.ExitCode)."

  $configPath = Join-Path $InstallDir 'apps\ocr-audytow\config\document-ai.json'
  $keyPath = Join-Path $InstallDir 'apps\ocr-audytow\config\service-account.json'
  Assert-True (-not (Test-Path $configPath)) 'Reinstalacja dodala konfiguracje OCR.'
  Assert-True (-not (Test-Path $keyPath)) 'Reinstalacja dodala klucz OCR.'
}

if ($UpdateInstallerPath) {
  Run-Test 'Maly instalator aktualizacyjny NIE dotyka node-runtime/node_modules i aplikacja dalej dziala (audyt 2026-08-06)' {
    # To jest sedno calej zmiany: aktualizacja NIE moze pobierac/nadpisywac
    # ~1,2 GB node_modules/Chromium. Dowod: hash i czas modyfikacji
    # node-runtime\node.exe musza byc identyczne PRZED i PO nalozeniu
    # instalatora aktualizacyjnego na juz istniejaca (pelna) instalacje -
    # gdyby Inno Setup w ogole "dotknal" tego pliku (nawet zapisujac
    # identyczna zawartosc), mtime by sie zmienil.
    $nodeExe = Join-Path $InstallDir 'node-runtime\node.exe'
    Assert-True (Test-Path $nodeExe) 'Brak node-runtime\node.exe przed testem instalatora aktualizacyjnego.'
    $beforeHash = (Get-FileHash -Algorithm SHA256 -Path $nodeExe).Hash
    $beforeWriteTime = (Get-Item $nodeExe).LastWriteTimeUtc

    $sampleAppNodeModules = Join-Path $InstallDir 'apps\ocr-audytow\node_modules'
    Assert-True (Test-Path $sampleAppNodeModules) 'Brak apps\ocr-audytow\node_modules przed testem instalatora aktualizacyjnego.'
    $beforeFileCount = (Get-ChildItem $sampleAppNodeModules -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Assert-True ($beforeFileCount -gt 0) 'apps\ocr-audytow\node_modules jest puste przed testem - test bylby bez sensu.'

    Stop-Scyzoryk
    $log = Join-Path $LogsDir 'install\update-variant.log'
    $args = @(
      '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/MERGETASKS=!autostart',
      "/DIR=`"$InstallDir`"", "/LOG=`"$log`""
    )
    $proc = Start-Process -FilePath $UpdateInstallerPath -ArgumentList $args -Wait -PassThru
    Assert-True ($proc.ExitCode -eq 0) "Instalator aktualizacyjny zakonczyl sie kodem $($proc.ExitCode)."

    $afterHash = (Get-FileHash -Algorithm SHA256 -Path $nodeExe).Hash
    $afterWriteTime = (Get-Item $nodeExe).LastWriteTimeUtc
    Assert-True ($afterHash -eq $beforeHash) 'node-runtime\node.exe zmienil sie po instalatorze aktualizacyjnym - runtime NIE powinien byc dotykany.'
    Assert-True ($afterWriteTime -eq $beforeWriteTime) 'Czas modyfikacji node-runtime\node.exe zmienil sie po instalatorze aktualizacyjnym - Inno Setup dotknal pliku, ktorego nie powinno byc w tym wariancie.'

    $afterFileCount = (Get-ChildItem $sampleAppNodeModules -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Assert-True ($afterFileCount -eq $beforeFileCount) "Liczba plikow w apps\ocr-audytow\node_modules zmienila sie ($beforeFileCount -> $afterFileCount) po instalatorze aktualizacyjnym."

    # Aplikacja musi nadal normalnie dzialac po "malej" aktualizacji - nie
    # wystarczy, ze pliki runtime przetrwaly, musi tez realnie wystartowac.
    $launcherExe = Join-Path $InstallDir 'Scyzoryk.exe'
    Start-Process -FilePath $launcherExe -WindowStyle Hidden | Out-Null

    # Lazy-start: apki nie wstaja same, tylko na zadanie - zanim odpytamy
    # panel o wszystkie, poczekaj az SAM panel zacznie odpowiadac, potem
    # popros go o start kazdej apki.
    $panelDeadline = (Get-Date).AddSeconds(30)
    $panelUp = $false
    while ((Get-Date) -lt $panelDeadline) {
      try {
        if ((Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/apps' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $panelUp = $true; break }
      } catch {}
      Start-Sleep -Seconds 1
    }
    Assert-True $panelUp 'Panel nie odpowiedzial po restarcie z instalatora aktualizacyjnego.'
    Start-AllScyzorykApps -Slugs $script:AllAppSlugs

    $deadline = (Get-Date).AddSeconds(90)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/apps' -UseBasicParsing -TimeoutSec 3
        $payload = $response.Content | ConvertFrom-Json
        if ($response.StatusCode -eq 200 -and @($payload.apps | Where-Object { -not $_.health.ok }).Count -eq 0) { $healthy = $true; break }
      } catch {}
      Start-Sleep -Seconds 2
    }
    Assert-True $healthy 'Panel/aplikacje nie wystartowaly poprawnie po instalatorze aktualizacyjnym.'
  }
}

Run-Test 'Zaznaczony autostart podczas instalacji tworzy dzialajace zadanie bez PowerShella (audyt 2026-08-06)' {
  # Kazdy wczesniejszy test w tym pliku uzywa /MERGETASKS=!autostart (autostart
  # ODZNACZONY) - ta sciezka (Scyzoryk.exe --register-autostart przez natywny
  # schtasks.exe, patrz launcher\Scyzoryk.Launcher\AutostartManager.cs, ktory
  # zastapil ukrytego "powershell.exe -ExecutionPolicy Bypass" flagowanego przez
  # Chrome/AV jako wirus) nigdy dotad nie byla realnie wykonana w CI. Testujemy
  # tu wprost, ze zaznaczenie zadania "autostart" faktycznie tworzy poprawne
  # zadanie w Harmonogramie.
  Stop-Scyzoryk

  $autostartTaskName = 'Scyzoryk Projektowy - autostart'
  if (Get-ScheduledTask -TaskName $autostartTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $autostartTaskName -Confirm:$false
  }

  $log = Join-Path $LogsDir 'install\autostart-enabled.log'
  $args = @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/MERGETASKS=autostart',
    "/DIR=`"$InstallDir`"", "/LOG=`"$log`""
  )
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Instalacja z zaznaczonym autostartem zakonczyla sie kodem $($proc.ExitCode)."

  $task = Get-ScheduledTask -TaskName $autostartTaskName -ErrorAction SilentlyContinue
  Assert-True ($null -ne $task) 'Instalator z zaznaczonym autostartem nie zarejestrowal zadania w Harmonogramie.'

  $action = $task.Actions | Select-Object -First 1
  $expectedExe = Join-Path $InstallDir 'Scyzoryk.exe'
  Assert-True ($action.Execute -ieq $expectedExe) "Akcja zadania wskazuje '$($action.Execute)', oczekiwano '$expectedExe'."
  Assert-True ($action.Arguments -eq '--autostart') "Argumenty zadania to '$($action.Arguments)', oczekiwano '--autostart'."
  Assert-True ($task.Principal.RunLevel -eq 'Limited') "RunLevel zadania to '$($task.Principal.RunLevel)', oczekiwano 'Limited' (bez podnoszenia uprawnien)."

  Unregister-ScheduledTask -TaskName $autostartTaskName -Confirm:$false
  Stop-Scyzoryk
}

Run-Test 'Odinstalowanie' {
  Stop-Scyzoryk
  $uninstaller = Join-Path $InstallDir 'unins000.exe'
  Assert-True (Test-Path $uninstaller) 'Brak deinstalatora.'
  $log = Join-Path $LogsDir 'install\uninstall.log'
  $proc = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=`"$log`"") -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Deinstalacja zakonczyla sie kodem $($proc.ExitCode)."
}

try {
  Stop-Scyzoryk
} catch {
  Write-Warning "Sprzatanie procesu nie powiodlo sie: $($_.Exception.Message)"
}

Write-Host "`n=== PODSUMOWANIE ==="
if ($script:Failures.Count -gt 0) {
  $script:Failures | ForEach-Object { Write-Host "BLAD: $_" }
  throw "Nie przeszlo $($script:Failures.Count) testow instalatora."
}

Write-Host 'Wszystkie testy instalatora przeszly.'
