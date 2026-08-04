# Jednorazowy instalator autostartu Scyzoryka (2026-07-24, patrz
# scyzoryk_final_deployment_plan w pamieci projektu): rejestruje Zaplanowane
# zadanie Windows uruchamiane PRZY LOGOWANIU tego konkretnego uzytkownika, okno
# ukryte - CELOWO NIE jako usluga systemowa (LocalSystem) - usluga dzialalaby w
# odizolowanej sesji 0 i stracilaby dostep do zmapowanego dysku Google Drive i
# domyslnej drukarki uzytkownika, oba przypiete do jego interaktywnej sesji.
#
# Dopisuje tez przyjazna nazwe hosta do pliku hosts (127.0.0.1 -> scyzoryk.projektowy),
# zeby nie trzeba bylo pamietac/wpisywac adresu 127.0.0.1:3000 w przegladarce.
#
# Edycja pliku hosts wymaga uprawnien administratora (plik chroniony systemowo) -
# skrypt sam podnosi uprawnienia (jedno okno UAC), Zaplanowane zadanie jest
# rejestrowane w TEJ SAMEJ podniesionej sesji, zeby uniknac niespojnego zachowania
# Register-ScheduledTask na roznych wersjach Windows przy rejestracji zadania dla
# biezacego uzytkownika bez elewacji.
$ErrorActionPreference = 'Stop'

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Wymagane uprawnienia administratora (jednorazowo, do wpisu w pliku hosts) - potwierdz w oknie UAC..."
    # -Wait: bez tego ten (nie-podniesiony) proces konczylby sie natychmiast po
    # wystartowaniu podniesionej kopii, wiec wywolujacy (np. instalator Inno Setup,
    # ktory czeka na zakonczenie tego kroku przed pokazaniem "gotowe") nie
    # doczekalby sie faktycznego zarejestrowania zadania/wpisu w hosts.
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TaskName = "Scyzoryk Projektowy - autostart"
$Hostname = "scyzoryk.projektowy"
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

Write-Host "`n=== Wpis w pliku hosts ($Hostname -> 127.0.0.1) ==="
$hostsPath = "$env:WINDIR\System32\drivers\etc\hosts"
$hostsContent = @(Get-Content $hostsPath -ErrorAction SilentlyContinue)
$filtered = $hostsContent | Where-Object { $_ -notmatch "\b$([regex]::Escape($Hostname))\b" }
$newLine = "127.0.0.1`t$Hostname`t# Scyzoryk Projektowy (dodane automatycznie)"
Set-Content -Path $hostsPath -Value ($filtered + $newLine) -Encoding ASCII
Write-Host "Dodano/odswiezono wpis."

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
