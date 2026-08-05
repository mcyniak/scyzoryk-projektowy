# Jednorazowy instalator autostartu Scyzoryka (2026-07-24, patrz
# scyzoryk_final_deployment_plan w pamieci projektu): rejestruje Zaplanowane
# zadanie Windows uruchamiane PRZY LOGOWANIU tego konkretnego uzytkownika, okno
# ukryte - CELOWO NIE jako usluga systemowa (LocalSystem) - usluga dzialalaby w
# odizolowanej sesji 0 i stracilaby dostep do zmapowanego dysku Google Drive i
# domyslnej drukarki uzytkownika, oba przypiete do jego interaktywnej sesji.
#
# Przyjazny adres w przegladarce to http://scyzoryk.localhost:3000 - domena
# .localhost jest zarezerwowana (RFC 6761): kazda nazwa konczaca sie na
# ".localhost" rozwiazuje sie bezposrednio do loopbacku w kazdej wspolczesnej
# przegladarce i w samym Windows, bez zadnego wpisu w pliku hosts, bez DNS i
# bez uprawnien administratora - dlatego ten skrypt (od 2026-08-05) NIE
# podnosi juz uprawnien ani nie dotyka pliku hosts w ogole. Register-
# ScheduledTask/Unregister-ScheduledTask dla WLASNEGO, biezacego uzytkownika
# (RunLevel Limited) tez nie wymaga admina.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TaskName = "Scyzoryk Projektowy - autostart"
$Hostname = "scyzoryk.localhost"
$Port = 3000

# Instalacje z instalatora (installer\scyzoryk.iss) maja bundlowany, przenosny
# Node.js obok siebie i NIE modyfikuja globalnego PATH - preferuj go, jesli
# istnieje, zamiast zakladac ze "node" jest globalnie dostepny w PATH.
$portableNode = Join-Path $RepoRoot 'node-runtime'
if (Test-Path (Join-Path $portableNode 'node.exe')) {
    $env:Path = "$portableNode;$env:Path"
}

Write-Host "=== Instalacja/sprawdzenie zaleznosci ==="
Push-Location $RepoRoot
& node scripts\install-all.js
if ($LASTEXITCODE -ne 0) { throw "Instalacja zaleznosci nie powiodla sie - zobacz bledy powyzej." }
& node scripts\check-project.js
if ($LASTEXITCODE -ne 0) { throw "Sprawdzenie projektu nie powiodlo sie - zobacz bledy powyzej." }
Pop-Location

Write-Host "`n=== Rejestracja autostartu w Harmonogramie zadan Windows ==="
# Scyzoryk.exe --autostart zastapil lancuch wscript.exe -> run-hidden.vbs ->
# STARTUJ-SCYZORYK-CICHO.cmd -> node server.js (patrz launcher\Scyzoryk.Launcher) -
# ten sam efekt (start bez okna, bez przegladarki), bez CMD/PowerShell/VBS przy
# kazdym logowaniu.
$launcherExe = Join-Path $RepoRoot "Scyzoryk.exe"
if (-not (Test-Path $launcherExe)) { throw "Brak $launcherExe - niekompletna instalacja, nie moge zarejestrowac autostartu." }
$action = New-ScheduledTaskAction -Execute $launcherExe -Argument "--autostart"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host "Zarejestrowano zadanie '$TaskName' (uruchomienie przy logowaniu $env:USERNAME, okno ukryte)."

Write-Host "`n=== Uruchamiam Scyzoryka teraz ==="
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

Write-Host "`nGotowe. Od teraz Scyzoryk uruchamia sie sam przy kazdym zalogowaniu na ten komputer."
Write-Host "Adres w przegladarce: http://${Hostname}:${Port}"
try { Start-Process "http://${Hostname}:${Port}" } catch {}
