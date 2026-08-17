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

# Audyt 2026-08-14: silnik druku (budowanie argumentow Sumatry/Ghostscripta,
# Wait-ForPrintJobProgress, Invoke-PrintWith*) zostal wydzielony do
# PrintEngine.psm1, zeby test/print-engine.Tests.ps1 (Pester) mogl go
# testowac w izolacji - ten skrypt ma Mandatory $FilePath i sprawdza
# Test-Path zanim cokolwiek by sie zdefiniowalo, wiec dot-source'owanie
# samych funkcji do testow nie bylo tu mozliwe bez tego wydzielenia.
Import-Module (Join-Path $PSScriptRoot "PrintEngine.psm1") -Force

# LogDir jest przekazywany przez wywolujacy modul (apps/<modul>/data), zeby
# kazdy modul mial swoj wlasny print-log.txt mimo ze ten skrypt jest teraz
# jedna wspolna kopia w lib/printing/. Bez -LogDir log ladowalby sie obok
# tego wspolnego skryptu, co mieszaloby diagnostyke wielu modulow w jednym pliku.
$LogDirResolved = if ($LogDir -and $LogDir.Trim()) { $LogDir } else { Join-Path $PSScriptRoot "..\..\logs" }
Set-PrintEngineLogFile (Join-Path $LogDirResolved "print-log.txt")
Write-PrintLog "--- START druku: $FilePath | drukarka: $PrinterName ---"

$hasTargetedPrinter = ($PrinterName -and $PrinterName.Trim())

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
