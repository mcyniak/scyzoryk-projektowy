# Oddzielny proces aktualizatora Scyzoryka Projektowego.
#
# Node.js (lib/updateService.js) NIGDY nie uruchamia instalatora sam z siebie -
# odpala TEN skrypt jako calkowicie odlaczony proces PowerShell i zaraz potem
# wysyla odpowiedz HTTP do przegladarki. Dopiero TEN skrypt (juz w oddzielnym
# procesie, po chwili odczekania) zatrzymuje Scyzoryka, uruchamia instalator
# po cichu i startuje aplikacje ponownie - dzieki temu zatrzymanie wlasnego
# procesu Node podczas aktualizacji nie przerywa samej aktualizacji.
#
# Skrypt jest KOPIOWANY (przez updateService.js) do katalogu konkretnej wersji
# w Updates, zanim zostanie odpalony - zeby przetrwal nawet gdyby instalator
# zdazyl juz zaczac nadpisywac folder programu, z ktorego pochodzi oryginal
# (scripts\run-update.ps1 w {app}).
#
# Wywolanie (patrz lib/updateService.js buildUpdaterInvocation):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden `
#     -File run-update.ps1 -InstallerPath ... -InstallDir ... -UpdateRoot ... -ExpectedVersion ... -Port 3000

param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$InstallDir,

    [Parameter(Mandatory = $true)]
    [string]$UpdateRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,

    [string]$Port = '3000'
)

$ErrorActionPreference = 'Stop'

$logsDir = Join-Path $UpdateRoot 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$logFile = Join-Path $logsDir ("update-{0}.log" -f (Get-Date -Format 'yyyyMMddTHHmmss'))

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'o'), $Message
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch {}
  Write-Host $line
}

# Zapis atomowy (plik tymczasowy + Move-Item) - kolejny odczyt last-result.json
# (przez Node przy nastepnym starcie) nigdy nie trafi na uciety/niekompletny
# plik, nawet gdyby ten proces zostal przerwany w polowie zapisu.
function Write-LastResult {
  param([bool]$Ok, [string]$Version, [int]$ExitCode, [string]$Message)
  $result = [ordered]@{
    ok        = $Ok
    version   = $Version
    exitCode  = $ExitCode
    message   = $Message
    logFile   = [IO.Path]::GetFileName($logFile)
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
  }
  $json = $result | ConvertTo-Json
  $resultPath = Join-Path $UpdateRoot 'last-result.json'
  $tmpPath = "$resultPath.tmp-$PID"
  try {
    [IO.File]::WriteAllText($tmpPath, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -Force -LiteralPath $tmpPath -Destination $resultPath
  } catch {
    Write-Log "Nie udalo sie zapisac last-result.json: $($_.Exception.Message)"
  }
}

# Zatrzymuje WYLACZNIE procesy node.exe nalezace do TEJ konkretnej instalacji
# (rozroznione po pelnej sciezce pliku wykonywalnego bundlowanego node-runtime),
# tak jak scripts\stop-scyzoryk.ps1 - nigdy globalny "taskkill /IM node.exe",
# ktory moglby ubic niepowiazane aplikacje Node dzialajace w tej samej sesji.
# Logika jest wpisana tutaj (nie wywolujemy stop-scyzoryk.ps1 z {app}\scripts),
# bo ten skrypt dziala z osobnego katalogu Updates\<wersja>\ bez wlasnego
# "..\node-runtime" obok siebie - stop-scyzoryk.ps1 liczy sciezke wzgledem
# WLASNEGO polozenia, wiec skopiowanie go tutaj bez node-runtime dalej by nie
# dzialalo. Zamiast tego uzywamy jawnie przekazanego $InstallDir.
function Stop-ScyzorykOwnedProcesses {
  param([string]$InstallDir)
  $nodeExe = Join-Path $InstallDir 'node-runtime\node.exe'
  if (-not (Test-Path $nodeExe)) {
    Write-Log "Brak $nodeExe - pomijam zatrzymywanie procesow (nietypowe, ale nie blokuje instalacji)."
    return
  }
  $nodeExeFull = (Resolve-Path $nodeExe).Path

  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $nodeExeFull) } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
        Write-Log "Zatrzymano proces Scyzoryka PID $($_.ProcessId)."
      } catch {
        Write-Log "Nie udalo sie zatrzymac PID $($_.ProcessId): $($_.Exception.Message)"
      }
    }

  $deadline = (Get-Date).AddSeconds(15)
  $remaining = @()
  do {
    $remaining = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $nodeExeFull) })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  if ($remaining.Count -gt 0) {
    Write-Log "UWAGA: $($remaining.Count) procesow node.exe Scyzoryka nadal dziala po 15s - instalator moze napotkac zablokowane pliki."
  } else {
    Write-Log 'Potwierdzono: procesy Scyzoryka zostaly zamkniete.'
  }
}

# Uruchamia Scyzoryka ponownie w ukryty sposob, korzystajac z istniejacego,
# juz sprawdzonego mechanizmu autostartu (run-hidden.vbs -> STARTUJ-SCYZORYK-CICHO.cmd)
# zamiast wynajdowac nowy sposob chowania okna.
function Start-ScyzorykHidden {
  param([string]$InstallDir)
  $vbsPath = Join-Path $InstallDir 'scripts\run-hidden.vbs'
  if (Test-Path $vbsPath) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList @($vbsPath) -WindowStyle Hidden
    Write-Log "Uruchomiono ponownie przez $vbsPath."
    return
  }
  Write-Log "Brak $vbsPath - probuje STARTUJ-SCYZORYK-CICHO.cmd wprost."
  $cmdPath = Join-Path $InstallDir 'STARTUJ-SCYZORYK-CICHO.cmd'
  if (Test-Path $cmdPath) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdPath) -WindowStyle Hidden
    Write-Log "Uruchomiono ponownie przez $cmdPath."
    return
  }
  Write-Log "BLAD: brak $vbsPath i $cmdPath - nie mozna automatycznie uruchomic Scyzoryka ponownie."
}

Write-Log "=== Start aktualizacji Scyzoryka Projektowego do wersji $ExpectedVersion ==="
Write-Log "InstallerPath = $InstallerPath"
Write-Log "InstallDir    = $InstallDir"

$exitCode = -1
$ok = $false
$message = ''

try {
  # Krotka pauza, aby odpowiedz HTTP (202 z /api/update/install) zdazyla
  # dojsc do przegladarki, zanim zaczniemy zatrzymywac serwer, ktory ja wysylal.
  Write-Log 'Czekam 2s, aby odpowiedz HTTP dotarla do przegladarki...'
  Start-Sleep -Seconds 2

  Write-Log 'Zatrzymuje procesy Scyzoryka...'
  Stop-ScyzorykOwnedProcesses -InstallDir $InstallDir

  Write-Log "Uruchamiam instalator cicho: $InstallerPath"
  # /SCYZORYKUPDATE (patrz installer\scyzoryk.iss [Code]) pomija kreator,
  # ponowna konfiguracje autostartu, UAC i postinstall-autostart aplikacji -
  # instalator tylko podmienia pliki i wychodzi, restart robimy sami nizej.
  $installerArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/SCYZORYKUPDATE', "/DIR=$InstallDir")
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $installerArgs -Wait -PassThru
  $exitCode = $proc.ExitCode
  Write-Log "Instalator zakonczony kodem wyjscia: $exitCode"
  $ok = ($exitCode -eq 0)
  $message = if ($ok) { "Zainstalowano wersje $ExpectedVersion." } else { "Instalator zakonczyl sie kodem $exitCode." }
} catch {
  $exitCode = -1
  $ok = $false
  $message = "Blad aktualizacji: $($_.Exception.Message)"
  Write-Log $message
} finally {
  Write-LastResult -Ok $ok -Version $ExpectedVersion -ExitCode $exitCode -Message $message

  # Restart Scyzoryka NIEZALEZNIE od wyniku instalacji - uzytkownik ma zawsze
  # zostac z dzialajaca aplikacja (starsza lub nowa), a nie z niczym. Jesli
  # instalacja sie nie powiodla, interfejs po restarcie pokaze bledny wynik
  # ostatniej aktualizacji (patrz lastResult w /api/update/status).
  Write-Log 'Uruchamiam Scyzoryka ponownie...'
  try {
    Start-ScyzorykHidden -InstallDir $InstallDir
  } catch {
    Write-Log "Nie udalo sie uruchomic ponownie Scyzoryka: $($_.Exception.Message)"
  }

  Write-Log 'Sprawdzam /api/health po restarcie...'
  $healthy = $false
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Seconds 2
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch {}
  } while ((Get-Date) -lt $deadline)
  Write-Log "Health-check po restarcie: $healthy"
  Write-Log '=== Koniec aktualizacji ==='
}

exit $exitCode
