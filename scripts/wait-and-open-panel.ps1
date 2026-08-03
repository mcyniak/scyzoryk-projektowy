# Czeka az panel odpowie po cichym starcie (installer\Uruchom-Scyzoryk.cmd)
# i dopiero wtedy otwiera przegladarke. Uzytkownik nie widzi zadnego okna
# konsoli w trakcie dzialania Scyzoryka - dzieki temu nie moze przypadkiem
# zamknac "okienka" i ubic calej aplikacji, myslac ze to byl blad (dokladnie
# taka sytuacja zdarzala sie realnie, gdy node.exe dzialal wprost w widocznym
# oknie cmd z ta sama zywotnoscia co samo okno).
param(
  [string]$Url = 'http://127.0.0.1:3000',
  [int]$TimeoutSeconds = 30,
  [int]$ExtendedTimeoutSeconds = 240
)

# Audyt v1.0.4, P1-9: staly 30s limit byl czasem za krotki na PIERWSZY start
# (server.js sam instaluje brakujace zaleznosci kazdej podaplikacji - moze to
# realnie potrwac kilka minut na wolnym lączu/dysku) - falszywie pokazywal
# blad, mimo ze Scyzoryk po prostu jeszcze konczyl instalacje. Jesli po
# pierwszym limicie proces node.exe tej instalacji WCIAZ dziala, dajemy
# dodatkowy, dluzszy czas zamiast od razu straszyc uzytkownika.
function Test-ScyzorykHealthOnce {
  param([string]$HealthUrl)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-ScyzorykProcessRunning {
  try {
    $installDir = Split-Path -Parent $PSScriptRoot
    $nodeExe = Join-Path $installDir 'node-runtime\node.exe'
    if (-not (Test-Path $nodeExe)) { return $false }
    $nodeExeFull = (Resolve-Path $nodeExe).Path
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $nodeExeFull) })
    return $procs.Count -gt 0
  } catch {
    return $false
  }
}

function Wait-ForHealth {
  param([string]$HealthUrl, [datetime]$Deadline)
  do {
    if (Test-ScyzorykHealthOnce -HealthUrl $HealthUrl) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $Deadline)
  return $false
}

$healthUrl = "$Url/api/health"
$totalWaitedSeconds = $TimeoutSeconds
$ok = Wait-ForHealth -HealthUrl $healthUrl -Deadline ((Get-Date).AddSeconds($TimeoutSeconds))

if (-not $ok -and (Test-ScyzorykProcessRunning)) {
  $totalWaitedSeconds = $TimeoutSeconds + $ExtendedTimeoutSeconds
  $ok = Wait-ForHealth -HealthUrl $healthUrl -Deadline ((Get-Date).AddSeconds($ExtendedTimeoutSeconds))
}

if ($ok) {
  Start-Process $Url
  exit 0
}

# Scyzoryk nie odpowiedzial na czas - to jedyny moment, w ktorym pokazujemy
# cokolwiek uzytkownikowi wprost (normalny start jest calkowicie cichy).
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  "Scyzoryk nie odpowiedzial w ciagu $totalWaitedSeconds sekund.`n`nSprawdz logi w folderze 'logs' w folderze instalacji, albo sprobuj uruchomic ponownie.",
  'Scyzoryk Projektowy',
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Warning
) | Out-Null
exit 1
