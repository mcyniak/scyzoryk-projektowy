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
$AcrobatPath = "C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe"
if (-not (Test-Path $AcrobatPath)) {
  $AcrobatPath = "C:\Program Files (x86)\Adobe\Acrobat Reader DC\Reader\AcroRd32.exe"
}
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
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3

    $doc = $word.Documents.Open($FilePath, [ref]$false, [ref]$true)
    if ($PrinterName) { $word.ActivePrinter = $PrinterName }
    $doc.PrintOut()

    # Czekamy, az utworzona przez nas instancja Worda przekaze zadanie do spoolera.
    while ($word.BackgroundPrintingStatus -ne 0) { Start-Sleep -Milliseconds 200 }
  } finally {
    if ($doc) { try { $doc.Close([ref]$false) } catch {} }
    if ($word) { try { $word.Quit() } catch {} }
    if ($doc) { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) | Out-Null }
    if ($word) { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
  }
}

function Quote-CmdArg([string]$value) { return '"' + $value.Replace('"', '\"') + '"' }

function Invoke-PrintWithSumatra([string]$path, [string]$targetPrinter) {
  if (-not (Test-Path $SumatraPath)) { return $false }
  try {
    $sumatraArgs = @("-print-to", $targetPrinter, "-silent", "-exit-when-done", $path)
    $proc = Start-Process -FilePath $SumatraPath -ArgumentList $sumatraArgs -PassThru -WindowStyle Hidden
    $finished = $proc.WaitForExit(15000)
    if (-not $finished) {
      Write-PrintLog "Sumatra ZAWIESILA SIE (>15s), zabijam, przechodze na Acrobata"
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
      return $false
    }
    Write-PrintLog "Sumatra zakonczyla sie, kod wyjscia: $($proc.ExitCode)"
    return ($proc.ExitCode -eq 0)
  } catch {
    Write-PrintLog "Sumatra wyjatek: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-PrintWithAcrobat([string]$path, [string]$targetPrinter) {
  if (-not (Test-Path $AcrobatPath)) { return $false }
  $quotedPath = Quote-CmdArg $path
  $quotedPrinter = Quote-CmdArg $targetPrinter
  try {
    $null = Start-Process -FilePath $AcrobatPath -ArgumentList ("/t $quotedPath $quotedPrinter") -PassThru -WindowStyle Hidden
    return $true
  } catch {
    return $false
  }
}

# WAZNE: Sumatra i Acrobat "/t" umieja drukowac TYLKO pliki PDF. Dla Worda
# (.docx) i innych formatow proba przez ktoregokolwiek z nich zawsze
# zawodzi. Dla plikow Worda tworzymy wlasna, niewidoczna instancje COM,
# zeby zastosowac drukarke wybrana w panelu i nie dotykac Worda uzytkownika.
$isPdf = $FilePath.ToLower().EndsWith(".pdf")

if ($hasTargetedPrinter -and $isPdf) {
  $sent = Invoke-PrintWithSumatra -path $FilePath -targetPrinter $printerName
  if (-not $sent) {
    Write-PrintLog "Sumatra nie wyslala - probuje Acrobata"
    $sent = Invoke-PrintWithAcrobat -path $FilePath -targetPrinter $printerName
    Write-PrintLog "Acrobat wynik: $sent"
  }
  if (-not $sent) { $null = Invoke-PrintWithShell -path $FilePath }
} elseif (-not $isPdf) {
  Invoke-PrintWithWordCom -FilePath $FilePath -PrinterName $printerName
} else {
  $null = Invoke-PrintWithShell -path $FilePath
}

Restore-Foreground $originalForeground

$maxWaitMs = 20000
$waited = 0
$trackingAvailable = ($printerName -and $null -ne $jobIdsBefore)

while ($waited -lt $maxWaitMs) {
  Restore-Foreground $originalForeground
  if ($trackingAvailable) {
    $jobIdsNow = Get-PrintJobIds $printerName
    $hasNewJob = $false
    if ($null -ne $jobIdsNow) {
      foreach ($id in $jobIdsNow) { if (-not $jobIdsBefore.Contains($id)) { $hasNewJob = $true; break } }
    }
    if ($hasNewJob) { break }
  } elseif ($waited -ge 300) {
    break
  }
  $stepMs = if ($waited -lt 1500) { 15 } else { 80 }
  Start-Sleep -Milliseconds $stepMs
  $waited += $stepMs
}

Restore-Foreground $originalForeground

Write-PrintLog "--- KONIEC (wyslano do sledzenia kolejki) ---"
Write-Output "OK"
