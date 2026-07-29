param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$LogsDir
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
    Write-Error "$Name`: $message"
  }
}

function Stop-Scyzoryk {
  if (Test-Path (Join-Path $InstallDir 'scripts\stop-scyzoryk.ps1')) {
    powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'scripts\stop-scyzoryk.ps1')
  }
  if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
  }
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

Run-Test 'Kompletnosc instalacji i konfiguracja OCR' {
  $required = @(
    'server.js','package.json','public\index.html','node-runtime\node.exe','unins000.exe',
    'apps\drukarka\node_modules\express',
    'apps\pieczatki-pdf\node_modules\express',
    'apps\formularze-ecodan\node_modules\playwright',
    'apps\dokumenty-seryjne\node_modules\express',
    'apps\wnioski-powykonawcze\node_modules\express',
    'apps\karty-katalogowe\node_modules\express',
    'apps\drukarka-projekty\node_modules\express',
    'apps\ocr-audytow\node_modules\express',
    'apps\ocr-audytow\config\document-ai.json',
    'apps\ocr-audytow\config\service-account.json'
  )
  $missing = @($required | Where-Object { -not (Test-Path (Join-Path $InstallDir $_)) })
  Assert-True ($missing.Count -eq 0) "Brakuje elementow instalacji: $($missing -join ', ')"

  $cfg = Get-Content (Join-Path $InstallDir 'apps\ocr-audytow\config\document-ai.json') -Raw | ConvertFrom-Json
  Assert-True ($cfg.projectId -eq 'scyzoryk-ocr-test') 'Nieprawidlowy projekt OCR.'
  Assert-True ($cfg.location -eq 'eu') 'Nieprawidlowa lokalizacja OCR.'
  Assert-True ($cfg.processorId -eq 'c8cea9ff6f6430c3') 'Nieprawidlowy processor ID OCR.'
}

Run-Test 'Nowe opisy narzedzi w instalatorze' {
  $html = Get-Content (Join-Path $InstallDir 'public\index.html') -Raw
  $requiredTexts = @(
    'Tworzy komplet dokumentów seryjnych dla każdego adresu',
    'Przygotowuje paczkę plików do zwykłego drukowania',
    'Przygotowuje do druku pełną dokumentację projektową',
    'Odczytuje dane ze skanów audytów'
  )
  $missing = @($requiredTexts | Where-Object { -not $html.Contains($_) })
  Assert-True ($missing.Count -eq 0) "Instalator nie zawiera nowych opisow: $($missing -join ' | ')"
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

Run-Test 'Uruchomienie Scyzoryka bez globalnego Node.js' {
  $nodeExe = Join-Path $InstallDir 'node-runtime\node.exe'
  $outLog = Join-Path $LogsDir 'app-logs\panel-stdout.log'
  $errLog = Join-Path $LogsDir 'app-logs\panel-stderr.log'
  $launcher = Join-Path $LogsDir 'start-scyzoryk.ps1'
  $restrictedPath = "$InstallDir\node-runtime;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  $lines = @(
    "`$env:PATH = '$restrictedPath'",
    "`$env:PLAYWRIGHT_BROWSERS_PATH = '0'",
    "Set-Location -LiteralPath '$InstallDir'",
    "& '$nodeExe' server.js 1> '$outLog' 2> '$errLog'"
  )
  [IO.File]::WriteAllText($launcher, ($lines -join "`r`n"), [Text.UTF8Encoding]::new($true))

  if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $script:TaskName -Action $action -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $script:TaskName
}

Run-Test 'Health-check wszystkich narzedzi i ocrConfigured' {
  $checks = @(
    @{ name='panel'; port=3000; path='/api/apps' },
    @{ name='drukarka'; port=3001; path='/api/status' },
    @{ name='pieczatki'; port=3002; path='/api/health' },
    @{ name='formularze'; port=3003; path='/api/version' },
    @{ name='dokumenty-seryjne'; port=3004; path='/api/health' },
    @{ name='wnioski-powykonawcze'; port=3005; path='/api/health' },
    @{ name='karty-katalogowe'; port=3006; path='/api/health' },
    @{ name='drukarka-projekty'; port=3010; path='/api/status' },
    @{ name='ocr-audytow'; port=3011; path='/api/health' }
  )

  foreach ($check in $checks) {
    $deadline = (Get-Date).AddSeconds(90)
    $ok = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($check.port)$($check.path)" -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ok = $true; break }
      } catch {}
      Start-Sleep -Seconds 2
    }
    Assert-True $ok "Nie odpowiada: $($check.name)"
  }

  $ocr = Invoke-RestMethod 'http://127.0.0.1:3011/api/health' -TimeoutSec 10
  $ocr | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $LogsDir 'reports\ocr-health.json') -Encoding utf8
  Assert-True ([bool]$ocr.ocrConfigured) 'OCR odpowiada, ale ocrConfigured=false.'
}

Run-Test 'Prawdziwe polaczenie z Google Document AI' {
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
    "const { ocrImage } = require(process.argv[2]);",
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

Run-Test 'Zrzuty ekranow wszystkich narzedzi' {
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
    @{slug='09-ocr'; url='http://127.0.0.1:3011/'}
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

Run-Test 'Ponowna instalacja' {
  Stop-Scyzoryk
  $log = Join-Path $LogsDir 'install\reinstall.log'
  $args = @(
    '/VERYSILENT', '/SUPPRESSMSG', '/NORESTART', '/CURRENTUSER', '/MERGETASKS=!autostart',
    "/DIR=`"$InstallDir`"", "/LOG=`"$log`""
  )
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
  Assert-True ($proc.ExitCode -eq 0) "Ponowna instalacja zakonczyla sie kodem $($proc.ExitCode)."
  Assert-True (Test-Path (Join-Path $InstallDir 'apps\ocr-audytow\config\document-ai.json')) 'Po reinstalacji brakuje konfiguracji OCR.'
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
