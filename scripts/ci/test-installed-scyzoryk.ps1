param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$LogsDir,
  [switch]$ExpectBundledOcr,
  [switch]$TestLiveOcr
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$InstallerPath = (Resolve-Path $InstallerPath).Path
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:TaskName = 'Scyzoryk CI test instalatora'

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

function Stop-Scyzoryk {
  # Scyzoryk.exe --stop jest tym samym mechanizmem, ktorego uzywa [UninstallRun]
  # (patrz installer\scyzoryk.iss) - testujemy tu realna, uzytkownikowi widoczna
  # sciezke zatrzymania, nie osobna, prywatna implementacje.
  $launcherExe = Join-Path $InstallDir 'Scyzoryk.exe'
  if (Test-Path $launcherExe) {
    & $launcherExe --stop
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
  # ktorym scripts\run-update.ps1 (prawdziwy aktualizator) juz sie chroni
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
    '/VERYSILENT', '/SUPPRESSMSG', '/NORESTART', '/CURRENTUSER', '/MERGETASKS=!autostart',
    "/DIR=`"$InstallDir`"", "/LOG=`"$log`""
  )
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Instalator zakonczyl sie kodem $($proc.ExitCode)."
}

Run-Test 'Kompletnosc zainstalowanej aplikacji' {
  $required = @(
    'Scyzoryk.exe',
    'server.js','package.json','public\index.html','public\instrukcja.html','public\instrukcja.css',
    'node-runtime\node.exe','node-runtime\npm.cmd','unins000.exe',
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

  $configPath = Join-Path $InstallDir 'apps\ocr-audytow\config\document-ai.json'
  $keyPath = Join-Path $InstallDir 'apps\ocr-audytow\config\service-account.json'

  if ($ExpectBundledOcr) {
    Assert-True (Test-Path $configPath) 'Gotowy instalator nie zawiera konfiguracji OCR.'
    Assert-True (Test-Path $keyPath) 'Gotowy instalator nie zawiera klucza OCR.'

    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$cfg.projectId)) 'Brak projectId OCR.'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$cfg.location)) 'Brak location OCR.'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$cfg.processorId)) 'Brak processorId OCR.'
    Assert-True ($cfg.keyFile -eq 'service-account.json') 'Nieprawidlowa sciezka keyFile OCR.'

    if (-not [string]::IsNullOrWhiteSpace($env:OCR_DOCAI_PROJECT_ID)) {
      Assert-True ($cfg.projectId -eq $env:OCR_DOCAI_PROJECT_ID) 'Instalator zawiera nieprawidlowy projekt OCR.'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:OCR_DOCAI_LOCATION)) {
      Assert-True ($cfg.location -eq $env:OCR_DOCAI_LOCATION) 'Instalator zawiera nieprawidlowa lokalizacje OCR.'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:OCR_DOCAI_PROCESSOR_ID)) {
      Assert-True ($cfg.processorId -eq $env:OCR_DOCAI_PROCESSOR_ID) 'Instalator zawiera nieprawidlowy processor ID OCR.'
    }

    $credentials = Get-Content $keyPath -Raw | ConvertFrom-Json
    Assert-True ($credentials.type -eq 'service_account') 'Plik OCR nie jest kontem serwisowym.'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$credentials.client_email)) 'Brak client_email w kluczu OCR.'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$credentials.private_key)) 'Brak private_key w kluczu OCR.'
  } else {
    Assert-True (-not (Test-Path $configPath)) 'Zwykly instalator nie powinien zawierac konfiguracji OCR.'
    Assert-True (-not (Test-Path $keyPath)) 'Zwykly instalator nie powinien zawierac klucza OCR.'
  }
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
    'data-app="pieczatki-pdf"',
    'data-app="karty-katalogowe"',
    'data-app="ocr-audytow"',
    'href="/instrukcja.html"',
    '<h3>Drukarka dokumentów</h3>',
    '<h3>Dokumenty seryjne PDF</h3>',
    '<h3>OCR audytów</h3>'
  )
  $missing = @($requiredFragments | Where-Object { -not $html.Contains($_) })
  Assert-True ($missing.Count -eq 0) "W panelu brakuje stabilnych elementow: $($missing -join ' | ')"
  Assert-True (-not $html.Contains('helpModalOverlay')) 'Panel nadal zawiera stary modal pomocy.'

  $instructionFragments = @(
    'Instrukcja obsługi Scyzoryka Projektowego',
    'Drukarka dokumentów',
    'Drukarka projektów',
    'Dokumenty seryjne PDF',
    'Wnioski powykonawcze PDF',
    'Formularze Ecodan',
    'Pieczątki PDF',
    'Karty katalogowe',
    'OCR audytów',
    'pierwsze trzy strony'
  )
  $missingInstruction = @($instructionFragments | Where-Object { -not $instruction.Contains($_) })
  Assert-True ($missingInstruction.Count -eq 0) "Instrukcja jest niekompletna: $($missingInstruction -join ' | ')"
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
  Assert-True ([bool]$ocr.ocrConfigured -eq [bool]$ExpectBundledOcr) "Nieprawidlowy stan ocrConfigured. Oczekiwano: $([bool]$ExpectBundledOcr)."
}

Run-Test 'Przyjazny adres http://scyzoryk.localhost:3000 dziala bez zadnej konfiguracji' {
  # Domena .localhost (RFC 6761) rozwiazuje sie do loopbacku na poziomie systemu/
  # przegladarki, wiec powinno to dzialac identycznie jak na prawdziwym komputerze
  # uzytkownika - zero wpisu w hosts, zero uprawnien administratora.
  $response = Invoke-WebRequest -Uri 'http://scyzoryk.localhost:3000/api/health' -UseBasicParsing -TimeoutSec 10
  Assert-True ($response.StatusCode -eq 200) "http://scyzoryk.localhost:3000/api/health zwrocilo $($response.StatusCode) zamiast 200."
  $payload = $response.Content | ConvertFrom-Json
  Assert-True ([bool]$payload.ok) 'Odpowiedz /api/health przez scyzoryk.localhost nie ma ok=true.'
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

if ($TestLiveOcr) {
  Run-Test 'Prawdziwe polaczenie z Google Document AI bez konfiguracji po instalacji' {
    Assert-True ([bool]$ExpectBundledOcr) 'Test prawdziwego OCR wymaga -ExpectBundledOcr.'
    Add-Type -AssemblyName System.Drawing
    $jpg = Join-Path $LogsDir 'input\ocr-test.jpg'
    $bitmap = New-Object Drawing.Bitmap 1000,300
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $font = New-Object Drawing.Font('Arial',32)
    try {
      $graphics.Clear([Drawing.Color]::White)
      $graphics.DrawString('TEST OCR SCYZORYK 123', $font, [Drawing.Brushes]::Black, 40, 100)
      $bitmap.Save($jpg, [Drawing.Imaging.ImageFormat]::Jpeg)
    } finally {
      $font.Dispose()
      $graphics.Dispose()
      $bitmap.Dispose()
    }

    $testJs = Join-Path $LogsDir 'ocr-api-test.js'
    $jsLines = @(
      "const { ocrImage, getConfigurationStatus } = require(process.argv[2]);",
      "console.log('Konfiguracja OCR:', getConfigurationStatus());",
      "ocrImage(process.argv[3]).then((result) => {",
      "  const text = String(result && result.text || '').trim();",
      "  console.log('Document AI odpowiedzial. Tekst:', text);",
      "  if (!text) process.exit(2);",
      "}).catch((error) => {",
      "  console.error(error && error.stack || error);",
      "  process.exit(1);",
      "});"
    )
    [IO.File]::WriteAllLines($testJs, $jsLines, [Text.UTF8Encoding]::new($false))

    $node = Join-Path $InstallDir 'node-runtime\node.exe'
    $engine = Join-Path $InstallDir 'apps\ocr-audytow\src\documentAiEngine.js'
    & $node $testJs $engine $jpg
    Assert-True ($LASTEXITCODE -eq 0) 'Prawdziwe wywolanie Google Document AI nie powiodlo sie.'
  }
}

Run-Test 'Zrzuty ekranow wszystkich narzedzi i instrukcji' {
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
    @{slug='10-instrukcja'; url='http://127.0.0.1:3000/instrukcja.html'}
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
    '/VERYSILENT', '/SUPPRESSMSG', '/NORESTART', '/CURRENTUSER', '/MERGETASKS=!autostart',
    "/DIR=`"$InstallDir`"", "/LOG=`"$log`""
  )
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Ponowna instalacja zakonczyla sie kodem $($proc.ExitCode)."

  $configPath = Join-Path $InstallDir 'apps\ocr-audytow\config\document-ai.json'
  $keyPath = Join-Path $InstallDir 'apps\ocr-audytow\config\service-account.json'
  if ($ExpectBundledOcr) {
    Assert-True (Test-Path $configPath) 'Po reinstalacji brakuje konfiguracji OCR.'
    Assert-True (Test-Path $keyPath) 'Po reinstalacji brakuje klucza OCR.'
  } else {
    Assert-True (-not (Test-Path $configPath)) 'Reinstalacja dodala konfiguracje OCR.'
    Assert-True (-not (Test-Path $keyPath)) 'Reinstalacja dodala klucz OCR.'
  }
}

Run-Test 'Odinstalowanie' {
  Stop-Scyzoryk
  $uninstaller = Join-Path $InstallDir 'unins000.exe'
  Assert-True (Test-Path $uninstaller) 'Brak deinstalatora.'
  $log = Join-Path $LogsDir 'install\uninstall.log'
  $proc = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSG','/NORESTART',"/LOG=`"$log`"") -Wait -PassThru
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
