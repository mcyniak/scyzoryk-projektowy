# Cofa scripts/install-autostart.ps1: usuwa zaplanowane zadanie autostartu i wpis
# w pliku hosts. Program dalej dziala - tylko trzeba go bedzie znow uruchamiac
# recznie przez STARTUJ-SCYZORYK.cmd, a adres w przegladarce wraca do
# http://127.0.0.1:3000.
$ErrorActionPreference = 'Stop'

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Wymagane uprawnienia administratora - potwierdz w oknie UAC..."
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$TaskName = "Scyzoryk Projektowy - autostart"
$Hostname = "scyzoryk.projektowy"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Usunieto zadanie '$TaskName' z Harmonogramu zadan Windows."
} else {
    Write-Host "Zadanie autostartu nie bylo zarejestrowane."
}

$hostsPath = "$env:WINDIR\System32\drivers\etc\hosts"
$hostsContent = @(Get-Content $hostsPath -ErrorAction SilentlyContinue)
$filtered = $hostsContent | Where-Object { $_ -notmatch "\b$([regex]::Escape($Hostname))\b" }
if ($filtered.Count -ne $hostsContent.Count) {
    Set-Content -Path $hostsPath -Value $filtered -Encoding ASCII
    Write-Host "Usunieto wpis '$Hostname' z pliku hosts."
} else {
    Write-Host "Wpis '$Hostname' nie byl obecny w pliku hosts."
}

Write-Host "`nGotowe - Scyzoryk nie startuje juz automatycznie. Uruchamiaj go recznie przez STARTUJ-SCYZORYK.cmd (adres: http://127.0.0.1:3000)."
