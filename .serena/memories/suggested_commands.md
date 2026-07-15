# Komendy — z zastrzeżeniami specyficznymi dla tego projektu

## Start / restart (Windows, PowerShell)
```
Get-Process node -EA SilentlyContinue | Stop-Process -Force
cd <root>
Start-Process node -ArgumentList "server.js" -WorkingDirectory $PWD -WindowStyle Hidden
```
Weryfikacja że wstało (osiem portów: 3000-3006, 3010):
```
netstat -ano | findstr "LISTENING" | findstr ":30"
```
UWAGA: filtr `":300"` NIE złapie portu **3010** (podciąg "300" nie występuje w "3010").
Sprawdzać 3010 osobno albo użyć `findstr ":30"`.

## Instalacja zależności
`install-all.cmd` / `node scripts/install-all.js` — instaluje per-moduł. Sprawdzanie
"czy pakiet jest zainstalowany" robione jest przez `fs.existsSync(node_modules/<dep>)`,
CELOWO nie przez `require.resolve(dep)` — pakiety z restrykcyjnym polem `exports`
w package.json (np. `express-rate-limit`, `read-excel-file`) wywalały fałszywe
"brakuje pakietu" mimo poprawnej instalacji.

## KRYTYCZNE: sprawdzanie składni plików .ps1
**`node --check plik.ps1` NIC NIE WALIDUJE** — próbuje parsować jako JavaScript i
często "przechodzi" nawet na zepsutym PowerShellu (proste `$x = "..."` przypadkiem
wygląda jak poprawny JS). Jedyny wiarygodny sposób:
```powershell
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($sciezka, [ref]$null, [ref]$errors)
if ($errors.Count -eq 0) { "OK" } else { $errors }
```
Ten błąd realnie wyprodukował działający-pozornie, zepsuty skrypt drukowania,
który wykrył się dopiero na produkcji.

## Edycja dużych plików .js/.ps1 przez PowerShell
`$content.Replace(oldMultilineString, newMultilineString)` z here-stringami (`@'...'@`)
ZAWODZI CICHO (0 dopasowań, brak błędu) przy niedopasowaniu końca linii CRLF vs LF —
zdarzało się to wielokrotnie. Dla edycji wielolinijkowych bezpieczniej jest:
1. odczytać cały plik, skonstruować pełną nową treść w pamięci, zapisać całość
   narzędziem do zapisu plików (nie przez PowerShell string-replace), ALBO
2. dla dużych plików: dopisać nową logikę jako OSOBNY moduł `.js` i podłączyć go
   do istniejącego pliku dwiema krótkimi liniami (`require` + wywołanie) zamiast
   edytować duży plik w miejscu.

## Testy end-to-end
Brak automatycznych testów. Weryfikacja robiona ręcznie przez faktyczne wywołania
HTTP (PowerShell `System.Net.Http.HttpClient`) przeciw żywemu serwerowi + realne
dane na `G:\Dyski współdzielone\...`.
