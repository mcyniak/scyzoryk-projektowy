# Cofa scripts/install-autostart.ps1: usuwa zaplanowane zadanie autostartu.
# Program dalej dziala - tylko trzeba go bedzie znow uruchamiac recznie
# skrotem/plikiem Scyzoryk.exe. Nie dotyka pliku hosts (install-autostart.ps1
# tez juz go nie dotyka od 2026-08-05 - adres http://scyzoryk.localhost:3000
# dziala bez zadnego wpisu w hosts, patrz domena .localhost, RFC 6761) i nie
# wymaga uprawnien administratora - Unregister-ScheduledTask dla WLASNEGO,
# biezacego uzytkownika tego nie potrzebuje.
$ErrorActionPreference = 'Stop'

$TaskName = "Scyzoryk Projektowy - autostart"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Usunieto zadanie '$TaskName' z Harmonogramu zadan Windows."
} else {
    Write-Host "Zadanie autostartu nie bylo zarejestrowane."
}

Write-Host "`nGotowe - Scyzoryk nie startuje juz automatycznie. Uruchamiaj go recznie skrotem/plikiem Scyzoryk.exe (adres: http://scyzoryk.localhost:3000)."
