param(
  [Parameter(Mandatory=$true)][string]$FilePath,
  [string]$PrinterName = "",
  [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

if ([string]::IsNullOrWhiteSpace($FilePath)) { throw "PRINT_PATH: Brak sciezki pliku do druku." }
if (-not (Test-Path -LiteralPath $FilePath)) { throw "PRINT_PATH: Nie znaleziono pliku do druku: $FilePath" }

# LogDir jest przekazywany przez wywolujacy modul (apps/<modul>/data), zeby
# kazdy modul mial swoj wlasny print-log.txt mimo ze ten skrypt jest teraz
# jedna wspolna kopia w lib/printing/. Bez -LogDir log ladowalby sie obok
# tego wspolnego skryptu, co mieszaloby diagnostyke wielu modulow w jednym pliku.
$LogDirResolved = if ($LogDir -and $LogDir.Trim()) { $LogDir } else { Join-Path $PSScriptRoot "..\..\logs" }
$LogFile = Join-Path $LogDirResolved "print-log.txt"
# "Out-File -Encoding utf8" (Windows PowerShell 5.1) dopisuje BOM przy
# pierwszym zapisie do pliku - niespojne z reszta projektu, ktora swiadomie
# unika BOM (patrz writeJsonFileNoBom w lib/hardening.js). AppendAllText z
# jawnym UTF8Encoding($false) nigdy nie dopisuje BOM.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-PrintLog([string]$msg) {
  try { [System.IO.File]::AppendAllText($LogFile, "$(Get-Date -Format "yyyy-MM-dd HH:mm:ss") | $msg`r`n", $script:Utf8NoBom) } catch {}
}
Write-PrintLog "--- START druku: $FilePath | drukarka: $PrinterName ---"

$SumatraPath = Join-Path $PSScriptRoot "SumatraPDF.exe"
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
$GhostscriptPath = Join-Path $PSScriptRoot "ghostscript\bin\gswin64c.exe"
$hasTargetedPrinter = ($PrinterName -and $PrinterName.Trim())

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
function Get-PrintJobIds([string]$printerName) {
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

try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class ScyzorykFocusGuard {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  public static List<IntPtr> FindVisibleWindowsForProcesses(HashSet<uint> pids) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pids.Contains(pid)) found.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@ -ErrorAction SilentlyContinue
} catch {}

function Restore-Foreground([IntPtr]$target) {
  if ($target -eq [IntPtr]::Zero) { return }
  try {
    $currentFg = [ScyzorykFocusGuard]::GetForegroundWindow()
    if ($currentFg -eq $target) { return }
    $currentThreadId = [ScyzorykFocusGuard]::GetCurrentThreadId()
    [uint32]$fgThreadId = 0
    [void][ScyzorykFocusGuard]::GetWindowThreadProcessId($currentFg, [ref]$fgThreadId)
    if ($fgThreadId -ne 0) { [void][ScyzorykFocusGuard]::AttachThreadInput($currentThreadId, $fgThreadId, $true) }
    [void][ScyzorykFocusGuard]::SetForegroundWindow($target)
    if ($fgThreadId -ne 0) { [void][ScyzorykFocusGuard]::AttachThreadInput($currentThreadId, $fgThreadId, $false) }
  } catch {}
}

$originalForeground = [IntPtr]::Zero
try { $originalForeground = [ScyzorykFocusGuard]::GetForegroundWindow() } catch {}

$printerName = if ($hasTargetedPrinter) { $PrinterName.Trim() } else { Get-DefaultPrinterName }
$jobIdsBefore = Get-PrintJobIds $printerName

function Invoke-PrintWithShell([string]$path) {
  try { return Start-Process -FilePath $path -Verb Print -PassThru -WindowStyle Hidden }
  catch { return Start-Process -FilePath $path -Verb Print -PassThru }
}

function Invoke-PrintWithWordCom($FilePath, $PrinterName) {
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

# Audyt 2026-08-12/13: wspolna logika "proces sie nie konczy w rozsadnym
# czasie, ale moze juz drukowac" - uzywana zarowno przez Sumatre (zawieszanie
# sie "-exit-when-done" na portach WSD), jak i przez Ghostscript (zapasowy
# silnik, patrz Invoke-PrintWithGhostscript - trzymany jako ta sama siatka
# bezpieczenstwa, mimo ze w testach na prawdziwej drukarce WSD Ghostscript
# zawsze konczyl sie sam). Zamiast zabijac proces na slepo po samym uplywie
# czasu (co przy WSD potrafilo zostawic w kolejce NIEKOMPLETNY wydruk -
# potwierdzone live: brakowalo jednego z polaczonych plikow po zabiciu
# Sumatry w polowie transferu) albo ufac samej OBECNOSCI zadania w kolejce
# (co nie odroznia niekompletnego zadania od prawdziwego sukcesu), SLEDZIMY
# realny postep (Get-PrintJob's PagesPrinted):
#   - zadanie robi postep -> NIE zabijamy, czekamy dalej
#   - zadanie znika z kolejki PO potwierdzonym postepie -> drukarka je
#     skonsumowala, prawdziwy sukces
#   - zadanie utknelo bez postepu (albo nigdy sie nie pojawilo) -> prawdziwe
#     zawieszenie, zabijamy i zwracamy porazke (wywolujacy decyduje o dalszym
#     fallbacku)
# Audyt na zywo 2026-08-13 (Flexi-archiwum2): zabicie PROCESU wysylajacego
# (Sumatra/Ghostscript) nie usuwa samego ZADANIA z kolejki drukarki - jesli
# zdazylo juz trafic do spoolera/urzadzenia, zostaje tam jako martwe,
# zawieszone zadanie. Kolejne proby druku (nawet innym silnikiem, albo zupelnie
# inny dokument pozniej) trafialy ZA nim w kolejce i same tez wygladaly na
# zawieszone, bo fizycznie nie mogly wyprzedzic zombie'a z przodu - jedyny
# realny sposob odblokowania byl wtedy recznie zabic caly Print Spooler.
# Probujemy WIEC teraz posprzatac po sobie od razu, best-effort (jesli sie nie
# uda, i tak i tak nic gorszego sie nie stanie niz stan sprzed tej poprawki).
function Remove-StalledPrintJob([string]$targetPrinter, [Nullable[int]]$jobId, [string]$engineName) {
  if (-not $jobId) { return }
  try {
    Remove-PrintJob -PrinterName $targetPrinter -ID $jobId -ErrorAction Stop
    Write-PrintLog "$engineName - usunieto zawieszone zadanie Id=$jobId z kolejki drukarki."
  } catch {
    Write-PrintLog "$engineName - nie udalo sie usunac zawieszonego zadania Id=$jobId z kolejki: $($_.Exception.Message)"
  }
}

function Wait-ForPrintJobProgress([System.Diagnostics.Process]$proc, [string]$targetPrinter, $jobIdsBeforeStart, [string]$engineName) {
  if (-not ($targetPrinter -and $null -ne $jobIdsBeforeStart)) {
    Write-PrintLog "$engineName - sledzenie kolejki niedostepne dla tej drukarki - nie da sie bezpiecznie odroznic zawieszenia od wyslanego zadania."
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    return $false
  }

  $trackedJobId = $null
  $lastPagesPrinted = -1
  $lastProgressAt = Get-Date
  $stallTimeout = [TimeSpan]::FromSeconds(20)
  $hardDeadline = (Get-Date).AddSeconds(90)

  while ((Get-Date) -lt $hardDeadline) {
    if ($proc.HasExited) {
      Write-PrintLog "$engineName zakonczyl sie po dluzszym oczekiwaniu, kod wyjscia: $($proc.ExitCode)"
      return ($proc.ExitCode -eq 0)
    }

    $jobs = $null
    try { $jobs = @(Get-PrintJob -PrinterName $targetPrinter -ErrorAction SilentlyContinue) } catch { $jobs = @() }

    if ($null -eq $trackedJobId) {
      foreach ($j in $jobs) {
        if ($null -ne $j -and -not $jobIdsBeforeStart.Contains([int]$j.Id)) {
          $trackedJobId = [int]$j.Id
          $lastPagesPrinted = [int]$j.PagesPrinted
          $lastProgressAt = Get-Date
          Write-PrintLog "$engineName - znaleziono nowe zadanie w kolejce (Id=$trackedJobId) - sledze jego postep."
          break
        }
      }
    } else {
      $trackedJob = $jobs | Where-Object { $null -ne $_ -and [int]$_.Id -eq $trackedJobId } | Select-Object -First 1
      if ($null -eq $trackedJob) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        if ($lastPagesPrinted -gt 0) {
          Write-PrintLog "$engineName - zadanie Id=$trackedJobId zniknelo z kolejki po realnym postepie (PagesPrinted=$lastPagesPrinted) - traktuje jako sukces."
          return $true
        }
        Write-PrintLog "$engineName - zadanie Id=$trackedJobId zniknelo z kolejki bez zadnego potwierdzonego postepu - porazka."
        return $false
      }
      $currentPages = [int]$trackedJob.PagesPrinted
      if ($currentPages -gt $lastPagesPrinted) {
        $lastPagesPrinted = $currentPages
        $lastProgressAt = Get-Date
      } elseif (((Get-Date) - $lastProgressAt) -gt $stallTimeout) {
        Write-PrintLog "$engineName - zadanie Id=$trackedJobId utknelo bez postepu przez $([int]$stallTimeout.TotalSeconds)s - zabijam proces."
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        Remove-StalledPrintJob -targetPrinter $targetPrinter -jobId $trackedJobId -engineName $engineName
        return $false
      }
    }

    Start-Sleep -Milliseconds 500
  }
  Write-PrintLog "$engineName - zadne zadanie nie pojawilo sie/nie zakonczylo w kolejce w rozsadnym czasie - zabijam proces."
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  Remove-StalledPrintJob -targetPrinter $targetPrinter -jobId $trackedJobId -engineName $engineName
  return $false
}

function Invoke-PrintWithSumatra([string]$path, [string]$targetPrinter, $jobIdsBeforeSumatra) {
  if (-not (Test-Path $SumatraPath)) { return $false }
  try {
    $sumatraArgs = @("-print-to", $targetPrinter, "-silent", "-exit-when-done", $path)
    $proc = Start-Process -FilePath $SumatraPath -ArgumentList $sumatraArgs -PassThru -WindowStyle Hidden

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

function Invoke-PrintWithGhostscript([string]$path, [string]$targetPrinter, $jobIdsBeforeGs) {
  if (-not (Test-Path $GhostscriptPath)) { return $false }
  try {
    # -dNoCancel: chowa wbudowany pasek postepu/przycisk Anuluj urzadzenia
    #   mswinpr2 (udokumentowane w Devices.rst - bez tej flagi Ghostscript
    #   pokazuje wlasne male okienko w trakcie druku, zlapane live 2026-08-13).
    # SAFER pozostaje domyslnie WLACZONE (gs 10.x) - NIE uzywamy -dNOSAFER,
    #   zeby zlosliwa tresc PDF-a nie mogla wykorzystac interpretera do
    #   odczytu/zapisu dowolnych plikow. --permit-devices=mswinpr2 dodaje
    #   WYLACZNIE zgode na wybor urzadzenia druku (potrzebne pod SAFER dla
    #   wyboru urzadzenia przez tresc dokumentu), nic wiecej.
    $gsArgs = @(
      "-dNoCancel", "-dNOPAUSE", "-dBATCH", "-q",
      "-sDEVICE=mswinpr2", "--permit-devices=mswinpr2",
      "-sOutputFile=%printer%$targetPrinter",
      $path
    )
    $proc = Start-Process -FilePath $GhostscriptPath -ArgumentList $gsArgs -PassThru -WindowStyle Hidden

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

# WAZNE: Sumatra i Ghostscript umieja drukowac TYLKO pliki PDF. Dla Worda
# (.docx) i innych formatow proba przez ktoregokolwiek z nich zawsze
# zawodzi. Dla plikow Worda tworzymy wlasna, niewidoczna instancje COM,
# zeby zastosowac drukarke wybrana w panelu i nie dotykac Worda uzytkownika.
$isPdf = $FilePath.ToLower().EndsWith(".pdf")

if ($isPdf) {
  # Audyt na zywo 2026-08-13: stara wersja tej galezi uzywala Sumatry/
  # Ghostscripta TYLKO gdy uzytkownik jawnie wybral drukarke ($hasTargetedPrinter),
  # a przy druku na "Domyslna systemu" (pusta wartosc w rozwijanej liscie -
  # patrz apps/drukarka/public/index.html#printerSelectInput, wybierana tez
  # gdy /api/printers nie zdazy sie jeszcze zaladowac) spadala na
  # Invoke-PrintWithShell (Start-Process -Verb Print) - kruche podejscie
  # zalezne od skojarzenia pliku PDF z aplikacja w Windows, ktore rzuca
  # InvalidOperationException "nie skojarzono zadnej aplikacji" na maszynach
  # bez zarejestrowanego domyslnego czytnika PDF (a Sumatra/Ghostscript same
  # w sobie NIC takiego nie rejestruja). $printerName (patrz wyzej) jest JUZ
  # poprawnie wyliczone na realna nazwe drukarki domyslnej nawet gdy
  # $hasTargetedPrinter jest false, wiec Sumatra/Ghostscript moga byc uzyte
  # zawsze - Invoke-PrintWithShell nie jest juz nigdzie potrzebny.
  $sent = Invoke-PrintWithSumatra -path $FilePath -targetPrinter $printerName -jobIdsBeforeSumatra $jobIdsBefore
  if (-not $sent) {
    Write-PrintLog "Sumatra nie wyslala - probuje Ghostscript"
    $sent = Invoke-PrintWithGhostscript -path $FilePath -targetPrinter $printerName -jobIdsBeforeGs $jobIdsBefore
    Write-PrintLog "Ghostscript wynik: $sent"
  }
  if (-not $sent) {
    # Audyt v1.0.4, P0-1: przy JAWNIE wskazanej drukarce celowo NIE ma tu
    # fallbacku na cokolwiek inne (np. drukarke domyslna) - uzytkownik mial
    # jasny wybor, wiec cicha zmiana drukarki po awarii bylaby zaskoczeniem.
    # Skoro Sumatra i Ghostscript obie zawiodly, to jest realny blad -
    # przerywamy z czytelnym komunikatem zamiast probowac cos jeszcze.
    Write-PrintLog "Sumatra i Ghostscript zawiodly dla drukarki '$printerName' - PRZERYWAM."
    throw "PRINT_TARGETED_FAILED: Nie udalo sie wyslac pliku na drukarke '$printerName' (Sumatra i Ghostscript zawiodly). Sprawdz, czy drukarka jest wlaczona i dostepna w sieci."
  }
} else {
  Invoke-PrintWithWordCom -FilePath $FilePath -PrinterName $printerName
}

Restore-Foreground $originalForeground

$maxWaitMs = 20000
$waited = 0
$trackingAvailable = ($printerName -and $null -ne $jobIdsBefore)
$jobConfirmed = $false

while ($waited -lt $maxWaitMs) {
  Restore-Foreground $originalForeground
  if ($trackingAvailable) {
    $jobIdsNow = Get-PrintJobIds $printerName
    $hasNewJob = $false
    if ($null -ne $jobIdsNow) {
      foreach ($id in $jobIdsNow) { if (-not $jobIdsBefore.Contains($id)) { $hasNewJob = $true; break } }
    }
    if ($hasNewJob) { $jobConfirmed = $true; break }
  } elseif ($waited -ge 300) {
    break
  }
  $stepMs = if ($waited -lt 1500) { 15 } else { 80 }
  Start-Sleep -Milliseconds $stepMs
  $waited += $stepMs
}

Restore-Foreground $originalForeground

# Audyt v1.0.4, P0-1: skrypt wczesniej ZAWSZE konczyl sie "OK", nawet gdy
# sledzenie kolejki BYLO dostepne (mamy nazwe drukarki i dziala Get-PrintJob),
# a mimo to zadne nowe zadanie sie nie pojawilo w 20s. To dawalo falszywe
# potwierdzenie wydruku. Gdy sledzenie NIE jest dostepne (np. sterownik/
# system nie wspiera Get-PrintJob), nie ma z czym porownac - zostaje
# dotychczasowe zachowanie (krotkie 300ms i "OK"), bo wymaganie potwierdzenia
# tam, gdzie technicznie nie da sie go uzyskac, tylko blokowaloby caly druk.
if ($trackingAvailable -and -not $jobConfirmed) {
  Write-PrintLog "--- KONIEC: BRAK POTWIERDZENIA zadania w kolejce drukarki '$printerName' po $($maxWaitMs / 1000)s ---"
  throw "PRINT_NOT_CONFIRMED: Nie potwierdzono pojawienia sie zadania w kolejce drukarki '$printerName' w ciagu $($maxWaitMs / 1000)s. Wydruk mogl sie nie powiesc."
}

Write-PrintLog "--- KONIEC (wyslano do sledzenia kolejki, potwierdzono: $jobConfirmed) ---"
Write-Output "OK"
