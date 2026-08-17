# Silnik druku wydzielony z print-file.ps1 (audyt 2026-08-14) - print-file.ps1
# ma [Parameter(Mandatory=$true)]$FilePath i sprawdza Test-Path ZANIM
# cokolwiek zdefiniuje, wiec dot-source'owanie samych definicji funkcji do
# testow (Pester) nie bylo tam mozliwe bez przebudowy kolejnosci. Ten modul
# pozwala testowac logike druku (budowanie argumentow, decyzje
# Wait-ForPrintJobProgress) w izolacji, bez uruchamiania calego skryptu.
# Zachowanie jest IDENTYCZNE jak przed wydzieleniem - patrz test/print-engine.Tests.ps1
# i test/group2-printing.test.js dla regresji.

$script:SumatraPath = Join-Path $PSScriptRoot "SumatraPDF.exe"
# Audyt 2026-08-13: Adobe Acrobat (dawny zapasowy silnik druku) zastapiony
# Ghostscriptem - Acrobata nie dalo sie legalnie dolaczyc do instalatora (na
# maszynie bez zainstalowanego Acrobata druk po prostu by nie dzialal), a do
# tego wymagal recznego chowania/zamykania wlasnego okna. Ghostscript jest
# darmowy, redystrybuowalny (AGPL, patrz lib/printing/ghostscript/COPYING),
# dzialajacy jako czyste narzedzie konsolowe (bez okna z definicji - "-dNoCancel"
# wylacza nawet wbudowany maly pasek postepu, patrz Devices.rst z dystrybucji).
# Uzywa urzadzenia "mswinpr2" - drukuje przez GDI Windows (jak kazda zwykla
# aplikacja), a nie przez bezposrednie sterowniki PDF/PS, co omija dokladnie
# ta klase problemow z portami WSD.
$script:GhostscriptPath = Join-Path $PSScriptRoot "ghostscript\bin\gswin64c.exe"

$script:LogFile = $null
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Wywolywane przez print-file.ps1 po policzeniu docelowej sciezki logu (kazdy
# modul apps/<modul>/data ma swoj wlasny print-log.txt, patrz komentarz w
# print-file.ps1). W testach po prostu sie tego nie woluje - Write-PrintLog
# wtedy cicho nic nie robi (patrz try/catch), zero efektow ubocznych.
function Set-PrintEngineLogFile {
  param([string]$Path)
  $script:LogFile = $Path
}

function Write-PrintLog {
  param([string]$msg)
  try { [System.IO.File]::AppendAllText($script:LogFile, "$(Get-Date -Format "yyyy-MM-dd HH:mm:ss") | $msg`r`n", $script:Utf8NoBom) } catch {}
}

function Get-DefaultPrinterName {
  try {
    $p = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Default -eq $true } | Select-Object -First 1
    if ($p) { return $p.Name }
  } catch {}
  return $null
}

# Zwraca ZBIOR Id aktualnych zadan tej drukarki (albo $null, gdy sledzenie
# nie jest dostepne). Poprzednia wersja liczyla tylko ILOSC zadan - na
# wspoldzielonej (sieciowej) drukarce cudze zadanie znikajace/pojawiajace
# sie w tym samym momencie moglo dac ta sama (lub przypadkiem wieksza)
# liczbe, co dawalo falszywy sygnal "nasze zadanie zostalo przyjete". Zbior
# konkretnych Id pozwala sprawdzic, czy pojawilo sie NOWE zadanie, a nie
# tylko czy liczba sie zmienila.
function Get-PrintJobIds {
  param([string]$printerName)
  if (-not $printerName) { return $null }
  try {
    $jobs = Get-PrintJob -PrinterName $printerName -ErrorAction SilentlyContinue
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($null -ne $jobs) {
      foreach ($j in @($jobs)) { if ($null -ne $j) { [void]$ids.Add([int]$j.Id) } }
    }
    # "return ,$ids" (nie samo "return $ids") - PowerShell domyslnie
    # ROZWIJA kolekcje pisane do potoku; przy 0 lub 1 elemencie zwracalby
    # wtedy $null albo goly Int32 zamiast obiektu HashSet, co dalej psulo
    # "$jobIdsBefore.Contains(...)" bledem "Int32 nie ma metody Contains"
    # (zlapane realnym testem, nie tylko czytaniem kodu). Unarny przecinek
    # wymusza, zeby caly HashSet trafil do potoku jako jeden obiekt.
    return ,$ids
  } catch {
    return $null
  }
}

# Audyt na zywo 2026-08-13: prawdziwa przyczyna niemal wszystkich tamtejszych
# awarii Sumatry na drukarka-projekty (ktora, w przeciwienstwie do zwyklej
# drukarki, generuje pliki wynikowe z SPACJAMI/przecinkami w nazwie, np.
# "... - Ul. Witkiewicza 12, Posada.pdf") - odsloniete dopiero po recznym
# wylaczeniu -silent: prawdziwy blad Sumatry to "Couldn't open file '...' for
# printing" ze SCIETA w polowie sciezka na spacji. -ArgumentList jako tablica
# bez recznie doklejonych cudzyslowow NIE cytuje niezawodnie argumentow ze
# spacjami w tym srodowisku - drukarki bywaja nazwane ze spacjami (np.
# "Brother HL-L8240CDW series Printer"), wiec dotyczy to obu argumentow, nie
# tylko sciezki pliku. Wydzielone do osobnej funkcji, zeby test/print-engine.Tests.ps1
# mogl zweryfikowac to bezposrednio (dekodujac wynik przez prawdziwe Windows
# API CommandLineToArgvW), bez potrzeby spawnowania Sumatry.
function New-SumatraPrintArgs {
  param([string]$path, [string]$targetPrinter)
  return "-print-to", "`"$targetPrinter`"", "-silent", "-exit-when-done", "`"$path`""
}

# Ta sama poprawka cytowania co New-SumatraPrintArgs (patrz komentarz tam) -
# drukarki/sciezki ze spacjami inaczej nie byly niezawodnie cytowane.
function New-GhostscriptPrintArgs {
  param([string]$path, [string]$targetPrinter)
  # -dNoCancel: chowa wbudowany pasek postepu/przycisk Anuluj urzadzenia
  #   mswinpr2 (udokumentowane w Devices.rst - bez tej flagi Ghostscript
  #   pokazuje wlasne male okienko w trakcie druku, zlapane live 2026-08-13).
  # SAFER pozostaje domyslnie WLACZONE (gs 10.x) - NIE uzywamy -dNOSAFER,
  #   zeby zlosliwa tresc PDF-a nie mogla wykorzystac interpretera do
  #   odczytu/zapisu dowolnych plikow. --permit-devices=mswinpr2 dodaje
  #   WYLACZNIE zgode na wybor urzadzenia druku (potrzebne pod SAFER dla
  #   wyboru urzadzenia przez tresc dokumentu), nic wiecej.
  return @(
    "-dNoCancel", "-dNOPAUSE", "-dBATCH", "-q",
    "-sDEVICE=mswinpr2", "--permit-devices=mswinpr2",
    "`"-sOutputFile=%printer%$targetPrinter`"",
    "`"$path`""
  )
}

# Audyt 2026-08-12/13: wspolna logika "proces sie nie konczy w rozsadnym
# czasie, ale moze juz drukowac" - uzywana zarowno przez Sumatre (zawieszanie
# sie "-exit-when-done" na portach WSD), jak i przez Ghostscript (zapasowy
# silnik, patrz Invoke-PrintWithGhostscript - trzymany jako ta sama siatka
# bezpieczenstwa, mimo ze w testach na prawdziwej drukarce WSD Ghostscript
# zawsze konczyl sie sam).
#
# Audyt na zywo 2026-08-13 (Flexi-archiwum2, WSD): wczesniejsza wersja tej
# funkcji probowala odroznic realny postep od zawieszenia sledzac
# Get-PrintJob's PagesPrinted - ale na tej konkretnej drukarce PagesPrinted
# konsekwentnie NIE rusza sie WCALE nawet dla zadan, ktore naprawde drukuja
# (zweryfikowane dwukrotnie na zywo: zadanie zabite jako "zawieszone" po
# braku postepu okazywalo sie chwile pozniej miec status "Complete" w
# kolejce). Podnoszenie samego progu czasu nie pomagalo, bo brak postepu byl
# trwaly, nie chwilowy. Zamiast dalej zgadywac czas, jak tylko zadanie
# NAPRAWDE trafi do kolejki drukarki, uznajemy to za sukces - spooler/
# drukarka przejmuja od tego momentu, a wywolujacy silnik (Sumatra/
# Ghostscript) i tak juz swoja robote skonczyl (przekazal dane do spoolera).
# HardDeadlineSeconds jest parametrem (domyslnie 90, jak wczesniej) wylacznie
# po to, zeby test/print-engine.Tests.ps1 mogl uzyc krotkiego limitu zamiast
# naprawde czekac 90s.
function Wait-ForPrintJobProgress {
  param(
    [System.Diagnostics.Process]$proc,
    [string]$targetPrinter,
    $jobIdsBeforeStart,
    [string]$engineName,
    [int]$HardDeadlineSeconds = 90
  )
  if (-not ($targetPrinter -and $null -ne $jobIdsBeforeStart)) {
    Write-PrintLog "$engineName - sledzenie kolejki niedostepne dla tej drukarki - nie da sie bezpiecznie odroznic zawieszenia od wyslanego zadania."
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    return $false
  }

  $hardDeadline = (Get-Date).AddSeconds($HardDeadlineSeconds)

  while ((Get-Date) -lt $hardDeadline) {
    if ($proc.HasExited) {
      Write-PrintLog "$engineName zakonczyl sie po dluzszym oczekiwaniu, kod wyjscia: $($proc.ExitCode)"
      return ($proc.ExitCode -eq 0)
    }

    $jobs = $null
    try { $jobs = @(Get-PrintJob -PrinterName $targetPrinter -ErrorAction SilentlyContinue) } catch { $jobs = @() }

    foreach ($j in $jobs) {
      if ($null -ne $j -and -not $jobIdsBeforeStart.Contains([int]$j.Id)) {
        Write-PrintLog "$engineName - znaleziono nowe zadanie w kolejce (Id=$([int]$j.Id))."
        return $true
      }
    }

    Start-Sleep -Milliseconds 500
  }
  Write-PrintLog "$engineName - zadne zadanie nie pojawilo sie w kolejce w rozsadnym czasie - zabijam proces."
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  return $false
}

function Invoke-PrintWithSumatra {
  param(
    [string]$path,
    [string]$targetPrinter,
    $jobIdsBeforeSumatra,
    [string]$SumatraExePath = $script:SumatraPath
  )
  if (-not (Test-Path $SumatraExePath)) { return $false }
  try {
    $sumatraArgs = New-SumatraPrintArgs -path $path -targetPrinter $targetPrinter
    $proc = Start-Process -FilePath $SumatraExePath -ArgumentList $sumatraArgs -PassThru -WindowStyle Hidden

    # Szybka sciezka - normalny przypadek (wszystkie nie-WSD drukarki, i
    # wiekszosc czasu). Bez zmian wzgledem zachowania sprzed audytu 2026-08-12.
    if ($proc.WaitForExit(15000)) {
      Write-PrintLog "Sumatra zakonczyla sie, kod wyjscia: $($proc.ExitCode)"
      return ($proc.ExitCode -eq 0)
    }

    # Audyt 2026-08-12 (zlapane live na produkcji, drukarki WSD - Lexmark
    # "Flexi-archiwum2"): "-exit-when-done" na niektorych portach WSD nie
    # dziala niezawodnie - Sumatra potrafi juz wysylac dane do spoolera i mimo
    # to NIGDY nie zakonczyc wlasnego procesu.
    Write-PrintLog "Sumatra nie zakonczyla sie w 15s - sledze postep w kolejce drukarki zamiast od razu zabijac."
    return Wait-ForPrintJobProgress -proc $proc -targetPrinter $targetPrinter -jobIdsBeforeStart $jobIdsBeforeSumatra -engineName "Sumatra"
  } catch {
    Write-PrintLog "Sumatra wyjatek: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-PrintWithGhostscript {
  param(
    [string]$path,
    [string]$targetPrinter,
    $jobIdsBeforeGs,
    [string]$GhostscriptExePath = $script:GhostscriptPath
  )
  if (-not (Test-Path $GhostscriptExePath)) { return $false }
  try {
    $gsArgs = New-GhostscriptPrintArgs -path $path -targetPrinter $targetPrinter
    $proc = Start-Process -FilePath $GhostscriptExePath -ArgumentList $gsArgs -PassThru -WindowStyle Hidden

    # Zweryfikowane live na realnej drukarce WSD (Brother HL-L8240CDW,
    # 2026-08-13): Ghostscript konczy sie sam, czysto, kodem 0 (w przeciwienstwie
    # do Sumatry na tych samych portach) - to jednak jedyny silnik druku, ktory
    # nam zostal (bez Acrobata jako trzeciej linii), wiec i tak zabezpieczamy
    # sie ta sama siatka co Sumatra, gdyby kiedys sie zawiesil.
    if ($proc.WaitForExit(30000)) {
      Write-PrintLog "Ghostscript zakonczyl sie, kod wyjscia: $($proc.ExitCode)"
      return ($proc.ExitCode -eq 0)
    }

    Write-PrintLog "Ghostscript nie zakonczyl sie w 30s - sledze postep w kolejce drukarki zamiast od razu zabijac."
    return Wait-ForPrintJobProgress -proc $proc -targetPrinter $targetPrinter -jobIdsBeforeStart $jobIdsBeforeGs -engineName "Ghostscript"
  } catch {
    Write-PrintLog "Ghostscript wyjatek: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-PrintWithWordCom {
  param($FilePath, $PrinterName)
  $word = $null
  $doc = $null
  try {
    # Audyt v1.1.7: PID-y PRZED utworzeniem obiektu COM, zeby po starcie
    # jednoznacznie wskazac WLASNIE NOWY proces (nie jakis inny, juz otwarty
    # recznie przez uzytkownika Word) - patrz obnizenie priorytetu nizej.
    $priorWinwordPids = @(Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3

    # Obnizamy priorytet PROCESU WINWORD.EXE (nie calego skryptu - COM
    # aktywowany serwer Worda NIE dziedziczy priorytetu z PowerShella) do
    # BelowNormal, zeby druk serii dokumentow nie "dusil" reszty komputera
    # uzytkownika (zgloszone realnie). Brak sukcesu nigdy nie przerywa druku -
    # to tylko optymalizacja, nie wymog.
    try {
      Start-Sleep -Milliseconds 300
      $newWinwordPid = Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" -ErrorAction SilentlyContinue |
        Where-Object { $priorWinwordPids -notcontains $_.ProcessId } |
        Select-Object -First 1 -ExpandProperty ProcessId
      if ($newWinwordPid) {
        $winwordProc = Get-Process -Id $newWinwordPid -ErrorAction SilentlyContinue
        if ($null -ne $winwordProc) { $winwordProc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal }
      }
    } catch {}

    # Audyt v1.1.7 (zlapane realnie na produkcji w analogicznym skrypcie
    # mailmerge-to-pdf.ps1): kilka udokumentowanych HRESULT-ow oznacza
    # PRZEJSCIOWA zajetosc/niedostepnosc serwera COM Worda - retry z krotkim
    # opoznieniem naprawia to bez realnej straty czasu.
    $maxAttempts = 3
    $attempt = 0
    $openedAndPrinted = $false
    while (-not $openedAndPrinted -and $attempt -lt $maxAttempts) {
      $attempt++
      try {
        if ($null -ne $doc) { try { $doc.Close([ref]$false) } catch {}; $doc = $null }
        $doc = $word.Documents.Open($FilePath, [ref]$false, [ref]$true)
        if ($PrinterName) { $word.ActivePrinter = $PrinterName }
        $doc.PrintOut()
        $openedAndPrinted = $true
      } catch {
        $errMsg = $_.Exception.Message
        $isTransientComBusy = ($errMsg -match "0x80010001" -or $errMsg -match "0x8001010A" -or $errMsg -match "0x8001010B" -or $errMsg -match "0x800706BA" -or $errMsg -match "0x80080005" -or $errMsg -match "RPC_E_" -or $errMsg -match "null-valued expression")
        if ($isTransientComBusy -and $attempt -lt $maxAttempts) {
          Write-PrintLog "Word byl chwilowo zajety przy druku przez COM (proba $attempt/$maxAttempts) - ponawiam: $errMsg"
          Start-Sleep -Seconds (1.5 * $attempt)
          continue
        }
        throw
      }
    }

    # Czekamy, az utworzona przez nas instancja Worda przekaze zadanie do spoolera.
    # Audyt v1.0.4, P1-10: petla nie miala zadnego limitu czasu - zawieszony
    # sterownik/spooler zawieszalby to CALKOWICIE, na zawsze, blokujac finally
    # (Close/Quit/FinalReleaseComObject) nizej. Po 60s przestajemy czekac (finally
    # nadal posprzata Worda) - dalsze potwierdzenie pojawienia sie zadania w
    # kolejce robi juz zewnetrzna petla nizej w tym pliku.
    $printWaitDeadline = (Get-Date).AddSeconds(60)
    while ($word.BackgroundPrintingStatus -ne 0) {
      if ((Get-Date) -gt $printWaitDeadline) {
        Write-PrintLog "OSTRZEZENIE: Word nie zakonczyl przekazywania wydruku do spoolera w 60s - przerywam oczekiwanie (mozliwe zawieszenie sterownika/spoolera)."
        break
      }
      Start-Sleep -Milliseconds 200
    }
  } finally {
    if ($doc) { try { $doc.Close([ref]$false) } catch {} }
    if ($word) { try { $word.Quit() } catch {} }
    if ($doc) { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) | Out-Null }
    if ($word) { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
  }
}

Export-ModuleMember -Function @(
  'Set-PrintEngineLogFile',
  'Write-PrintLog',
  'Get-DefaultPrinterName',
  'Get-PrintJobIds',
  'New-SumatraPrintArgs',
  'New-GhostscriptPrintArgs',
  'Wait-ForPrintJobProgress',
  'Invoke-PrintWithSumatra',
  'Invoke-PrintWithGhostscript',
  'Invoke-PrintWithWordCom'
)
