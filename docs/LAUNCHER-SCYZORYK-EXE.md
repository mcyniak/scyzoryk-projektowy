# Natywny launcher Scyzoryk.exe — dziennik tej sesji (2026-08-04/05)

## Cel

Zastąpienie łańcucha `Uruchom-Scyzoryk.cmd` → `is-panel-alive.ps1` → `stop-scyzoryk.ps1`
→ `cscript run-hidden.vbs` → `STARTUJ-SCYZORYK-CICHO.cmd` → `node server.js` →
`wait-and-open-panel.ps1` (normalny start) oraz `wscript.exe run-hidden.vbs`
(autostart/restart po aktualizacji) jednym natywnym plikiem `Scyzoryk.exe`
(C#/.NET 8, `launcher/Scyzoryk.Launcher`). Powód: ten łańcuch CMD→PowerShell→VBS→CMD→Node
wygląda jak typowy dropper w oczach heurystyk AV, miga konsolą i jest trudny do
diagnozowania.

**Ważne ograniczenie, potwierdzone explicite**: sam launcher **nie usuwa** ostrzeżenia
SmartScreen przy pierwszym uruchomieniu `ScyzorykProjektowy-Setup-x.x.x.exe` — to
dotyczy niepodpisanego **instalatora**, nie launchera. Podpisywanie kodu (Authenticode)
nie zostało w tym zadaniu wdrożone.

## Co powstało

- `launcher/Scyzoryk.Launcher/` — projekt C#/.NET 8, `OutputType=WinExe`, self-contained,
  single-file, `win-x64`. Klasy: `InstallPaths`, `ArgsParser`/`LauncherMode`,
  `LauncherApp` (orkiestracja), `HealthChecker`, `ProcessManager`, `BrowserLauncher`,
  `SingleInstanceGate`, `LauncherLogger`, `FatalErrorPresenter`, `Program.cs`.
- `launcher/Scyzoryk.Launcher.Tests/` — ~50 testów xUnit (fakery dla każdego
  interfejsu, realny `HttpListener` do testów health-checka, realny `Mutex` do testów
  single-instance).
- **4 tryby CLI**: bez argumentów (start + otwórz przeglądarkę raz), `--autostart`
  (start, nigdy przeglądarki), `--stop` (zatrzymaj tylko własny `node-runtime\node.exe`),
  `--health` (jednorazowy `/api/health`, nigdy nic nie startuje).
- Nowy `scripts/build-launcher.ps1` — `dotnet restore`/`test`/`publish`, wywoływany przez
  `scripts/build-installer.ps1` przed stagingiem instalatora.
- Zmienione: `installer/scyzoryk.iss` (skróty/`[Run]`/`[UninstallRun]` → `Scyzoryk.exe`),
  `scripts/install-autostart.ps1` (Akcja Zaplanowanego zadania → `Scyzoryk.exe --autostart`),
  `scripts/run-update.ps1` (`Start-ScyzorykHidden`/`Stop-ScyzorykOwnedProcesses` →
  `Scyzoryk.exe`), 3× workflow GitHub Actions (`actions/setup-dotnet@v4`),
  `scripts/ci/test-installed-scyzoryk.ps1` (`Stop-Scyzoryk`, lista wymaganych plików,
  test autostartu, nowy test braku `cmd.exe`/`wscript.exe`/`cscript.exe`).
- Usunięte (zero żywych odwołań po weryfikacji): `installer/Uruchom-Scyzoryk.cmd`,
  `scripts/is-panel-alive.ps1`, `scripts/wait-and-open-panel.ps1`, `scripts/run-hidden.vbs`,
  `STARTUJ-SCYZORYK-CICHO.cmd`.
- Zachowane: `scripts/stop-scyzoryk.ps1` — wciąż używany przez dev-only
  `start.cmd`/`STARTUJ-SCYZORYK.cmd` (uruchamianie z kodu źródłowego, poza zakresem).

Pełny research/plan (obecny przepływ, lista odwołań, plan testów, ryzyka) jest zapisany
w planie sesji Claude Code (`virtual-moseying-koala.md`) — ten dokument to bardziej
"co się faktycznie stało po drodze", niż powtórzenie tamtego planu.

## Środowisko implementacji: brak lokalnego .NET SDK

W sesji, w której pisany był cały kod C#, nie było zainstalowanego .NET SDK 8
(instalacja przez `winget` poprosiła o UAC, którego nie było jak nieinteraktywnie
zatwierdzić — na tym komputerze i tak nie ma uprawnień administratora). Cały projekt
C# napisany był więc **bez lokalnego `dotnet build`/`dotnet test`** — jedyna
weryfikacja przed pierwszym wydaniem to `npm run check` (składnia JS/PS1) i ręczny
przegląd kodu C#. Skutek: pierwsze prawdziwe `dotnet build`/`test` nastąpiło w
GitHub Actions, dopiero po wypchnięciu taga.

## Historia iteracji wydań (v1.0.9 → v1.0.13)

Użytkownik poprosił o wydanie ("chce releas") zanim cokolwiek zostało skompilowane
lokalnie. Ponieważ `release-public-installer.yml` publikuje GitHub Release jako
**ostatni krok**, po pełnym build+test+install-test — nieudana kompilacja/test nigdy
nie publikuje zepsutego wydania, tylko czerwony przebieg CI. To pozwoliło bezpiecznie
iterować "na produkcji":

- **v1.0.9** (pierwsza próba) — realne błędy kompilacji C#, złapane przez pierwszy
  prawdziwy `dotnet build`:
  - `LauncherApp.cs`: dwa wywołania `WaitForHealthyAsync(...)` miały przesunięte
    argumenty — brakował `healthUrl` na początku (kompilator: "missing parameter").
  - `ProcessManager.cs`: błędne założenie, że `ProcessStartInfo.EnvironmentVariables`
    to `IDictionary<string,string>` z `.TryGetValue(...)` — w rzeczywistości to
    `System.Collections.Specialized.StringDictionary`, bez tej metody. Naprawione
    przez odczyt przez indekser (`[] ?? ""`, bezpieczny dla brakującego klucza).
- **v1.0.10** — poprawka powyższych dwóch błędów. Kompilacja przeszła, ale **4 z 51
  testów** xUnit padły w CI (nigdy nie uruchomione lokalnie wcześniej):
  1. `SingleInstanceGateTests.TryAcquire_WhenHeldByAnotherHandle...` — nazwane
     muteksy Windows są reentrantne **per wątek**, nie per obiekt `Mutex`. Test
     próbował przejąć ten sam muteks z tego samego wątku (owner+contender w jednym
     teście xUnit) — Windows zawsze to pozwalał, bo wątek już "posiadał" muteks.
  2. `BrowserLauncherTests.OpenDefaultBrowser_InvalidTarget...` — string z bajtem
     `\0` nie zawsze rzuca wyjątek przez `ShellExecute` (na CI nie rzucił wcale).
  3-4. `HealthCheckerTests.IsRespondingOnce_Returns200_True` i
     `WaitForHealthy_NeverHealthy_ProcessDead_NoExtensionAttempted` — sporadyczne,
     najpierw przypisane wyścigowi portów (`FakeHealthServer.GetFreePort()`
     zwalnia tymczasowy socket i używa tego samego numeru portu — realny wyścig
     przy równoległym wykonywaniu testów przez xUnit).
- **v1.0.11** — naprawa: kontender muteksu na osobnym `Thread`; pusty `FileName`
  (gwarantowanie rzuca `InvalidOperationException`) zamiast bajtu `\0`; wyłączone
  równoległe wykonywanie testów (`[assembly: CollectionBehavior(DisableTestParallelization = true)]`).
  Efekt: 50/51 — 3 z 4 testów naprawione. Jeden nadal padał:
  `WaitForHealthy_NeverHealthy_ProcessDead_NoExtensionAttempted` — okazało się, że
  to NIE był wyścig portów, tylko realne ~2-3s opóźnienie "connection refused" na
  loopbacku na tym konkretnym runnerze GitHub Actions.
- **v1.0.12** — próba naprawy przez zamianę `"localhost"` na literalny `"127.0.0.1"`
  w URL-ach testów bez realnego serwera (teoria: rozwiązywanie nazwy IPv4/IPv6
  dual-stack). **Nie pomogło** — test wciąż padał (~2s), co obaliło tę teorię:
  opóźnienie dotyczyło samego TCP connect-refused na tym sandboxie, niezależnie od
  adresu.
- **v1.0.13** — właściwa naprawa: zamiast gonić dokładny czas, test
  `WaitForHealthy_NeverHealthy_ProcessDead_NoExtensionAttempted` dostał dużo większy
  `extendedTimeout` (20s) i asercję względną (`elapsed < extendedTimeout / 2`) —
  sprawdza **zachowanie** (brak czekania na całe rozszerzenie), nie sztywną liczbę
  sekund, która okazała się zbyt krucha wobec realnej zmienności środowiska CI.

**Status na koniec tej sesji**: tag `v1.0.13` wypchnięty, workflow
`release-public-installer.yml` w trakcie/do sprawdzenia przez użytkownika na
GitHub Actions. Nie mam w tym środowisku `gh` CLI ani dostępu do API prywatnego
repozytorium, więc nie mogę sam monitorować przebiegu — użytkownik wkleja logi z
Actions, ja analizuję i poprawiam.

## Lekcje z tej sesji (przydatne na przyszłość)

- **Bez lokalnego kompilatora, każde "powinno działać" jest hipotezą, nie faktem.**
  Dwa z sześciu problemów (`WaitForHealthyAsync` przesunięte argumenty,
  `StringDictionary` vs `IDictionary`) to błędy, które `dotnet build` złapałby
  natychmiast lokalnie. Reszta (4 testy) to typowe pułapki testowania na realnym
  systemie operacyjnym, których nie widać czytając kod: reentrancja muteksu per
  wątek, niedeterministyczne `ShellExecute`, wyścigi portów, i zmienność czasowa
  "connection refused" na różnych sandboxach CI.
- **`release-public-installer.yml` jest bezpieczny do iteracji "na produkcji"**,
  bo publikacja GitHub Release jest ostatnim krokiem, po całym build+test+install-test.
  Nieudana kompilacja/test = czerwony przebieg, nie zepsute wydanie.
- **Testy z timingiem na CI potrzebują dużego zapasu i asercji względnych**, nie
  sztywnych progów w sekundach — różne runnery/sandboxy mają różną (czasem
  zaskakująco wysoką) latencję nawet dla operacji lokalnych/loopback.

## Kontynuacja sesji (2026-08-05)

Wznowiono pracę na branchu `ui-redesign-v1` (worktree
`.claude/worktrees/fix-pieczatki-filenames`), HEAD nadal na `v1.0.13` (`b0ec8ac`),
branch w pełni zsynchronizowany z `origin/ui-redesign-v1`, working tree czyste.
Zweryfikowane od nowa, bez zakładania niczego ze starej notatki:

- `git ls-remote --tags origin` potwierdza, że tag `v1.0.13` faktycznie dotarł na
  GitHub (`bb89e87...` wskazuje na `b0ec8ac`) — nie tylko lokalnie.
- `npm run check` (`node scripts/check-project.js`) przechodzi czysto: 109 plików JS
  + 15 PS1, zero błędów.
- Ponowne przeszukanie całego repo pod stare nazwy plików (`Uruchom-Scyzoryk.cmd`,
  `is-panel-alive.ps1`, `wait-and-open-panel.ps1`, `run-hidden.vbs`,
  `STARTUJ-SCYZORYK-CICHO.cmd`) — zero trafień, usunięcie się utrzymało.
  `scripts/stop-scyzoryk.ps1` nadal obecny i celowo zachowany (dev-only
  `start.cmd`/`STARTUJ-SCYZORYK.cmd`, poza zakresem tego zadania).
- `dotnet` nadal niedostępny na tej maszynie deweloperskiej (brak SDK,
  `Get-Command dotnet` puste) — jak poprzednio, jedyna realna weryfikacja
  `dotnet build`/`dotnet test`/`dotnet publish` to GitHub Actions.
- **Nadal nie mam w tym środowisku `gh` CLI ani dostępu do API prywatnego
  repozytorium** (próba `WebFetch` na Actions dla prywatnego repo nie zadziała bez
  uwierzytelnienia) — nie potwierdziłem samodzielnie, czy przebieg
  `release-public-installer.yml` dla `v1.0.13` faktycznie przeszedł na zielono.
  To wciąż wymaga wklejenia logu/wyniku przez użytkownika.

## Usunięcie PowerShella z aktualizatora (2026-08-05, ten sam dzień)

Realny bug report właściciela na firmowym laptopie: przycisk "Zaktualizuj i uruchom
ponownie" zawsze kończył się błędem "Proces aktualizatora nie uruchomił się (brak
nowego logu po uruchomieniu)". Diagnoza na żywo (Windows-MCP, bezpośredni dostęp do
zainstalowanej kopii) wykluczyła po kolei: Historię ochrony Defendera (pusta), log
operacyjny `Microsoft-Windows-Windows Defender/Operational` (zero wpisów o
Scyzoryku), AppLocker (0 zdarzeń), politykę wykonywania skryptów (`-ExecutionPolicy
Bypass` nadpisuje `RemoteSigned` na koncie). Dodanie przechwytywania stdout/stderr
spawnowanego procesu do pliku (`lib/updateService.js`) i powtórzenie próby dało
plik **0 bajtów** — proces `powershell.exe` był zabijany natychmiast, zanim zdążył
cokolwiek zrobić, bez żadnego lokalnie widocznego śladu. Wniosek: firmowy EDR
(raportuje tylko do centralnej konsoli IT), wychwytujący klasyczną sygnaturę
"living-off-the-land dropper" (ukryty proces odpala ukryty PowerShell z
`-ExecutionPolicy Bypass`, który uruchamia niepodpisany `.exe`).

Rozwiązanie: cała logika `scripts/run-update.ps1` (zatrzymaj → zainstaluj cicho →
uruchom ponownie → zweryfikuj wersję po restarcie → zapisz wynik) przeniesiona do
nowego trybu `Scyzoryk.exe --apply-update` (`UpdateApplier.cs`) — Node teraz
spawnuje kopię już zainstalowanego, zaufanego `Scyzoryk.exe` zamiast
`powershell.exe`. Zero PowerShella, zero `-ExecutionPolicy Bypass`, zero
`-WindowStyle Hidden` (WinExe nie ma okna z definicji) w całym łańcuchu. Kontrakt
plikowy z Node (`update-<timestamp>.log`, `last-result.json`) pozostał identyczny,
więc `lib/updateService.js`'s `confirmUpdaterStarted()`/`getStatusPayload()` nie
wymagały żadnych zmian poza tym, co dokładnie jest spawnowane.
`scripts/run-update.ps1` usunięty całkowicie (martwy kod, nic go już nie
wywołuje). Zweryfikowane lokalnie: `dotnet build`/`dotnet test` (64/64 zielone,
`.NET SDK 8` dostępne w tym środowisku via `$HOME/.dotnet/dotnet.exe` z
wcześniejszej sesji) + `npm run check` + `node --test test/group10-updater.test.js`.

**Brak gwarancji, że to faktycznie ominie ten konkretny firmowy EDR** — to
najlepsze, uzasadnione architektonicznie posunięcie (ten sam wzorzec co
self-update Chrome/VS Code/Slack), ale ostateczny dowód wymaga kolejnej żywej
próby aktualizacji na tej samej maszynie właściciela.
