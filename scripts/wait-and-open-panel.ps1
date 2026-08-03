# Czeka az panel odpowie po cichym starcie (installer\Uruchom-Scyzoryk.cmd)
# i dopiero wtedy otwiera przegladarke. Uzytkownik nie widzi zadnego okna
# konsoli w trakcie dzialania Scyzoryka - dzieki temu nie moze przypadkiem
# zamknac "okienka" i ubic calej aplikacji, myslac ze to byl blad (dokladnie
# taka sytuacja zdarzala sie realnie, gdy node.exe dzialal wprost w widocznym
# oknie cmd z ta sama zywotnoscia co samo okno).
param(
  [string]$Url = 'http://127.0.0.1:3000',
  [int]$TimeoutSeconds = 30
)

$healthUrl = "$Url/api/health"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$ok = $false
do {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($response.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

if ($ok) {
  Start-Process $Url
  exit 0
}

# Scyzoryk nie odpowiedzial na czas - to jedyny moment, w ktorym pokazujemy
# cokolwiek uzytkownikowi wprost (normalny start jest calkowicie cichy).
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  "Scyzoryk nie odpowiedzial w ciagu $TimeoutSeconds sekund.`n`nSprawdz logi w folderze 'logs' w folderze instalacji, albo sprobuj uruchomic ponownie.",
  'Scyzoryk Projektowy',
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Warning
) | Out-Null
exit 1
