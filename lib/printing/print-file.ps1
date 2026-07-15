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
function Write-PrintLog([string]$msg) {
  try { "$(Get-Date -Format "yyyy-MM-dd HH:mm:ss") | $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch {}
}
Write-PrintLog "--- START druku: $FilePath | drukarka: $PrinterName ---"

$SumatraPath = Join-Path $PSScriptRoot "SumatraPDF.exe"
$AcrobatPath = "C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe"
if (-not (Test-Path $AcrobatPath)) {
  $AcrobatPath = "C:\Program Files (x86)\Adobe\Acrobat Reader DC\Reader\AcroRd32.exe"
}
$useTargetedPrinter = ($PrinterName -and $PrinterName.Trim() -and ((Test-Path $SumatraPath) -or (Test-Path $AcrobatPath)))

function Get-DefaultPrinterName {
  try {
    $p = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Default -eq $true } | Select-Object -First 1
    if ($p) { return $p.Name }
  } catch {}
  return $null
}

function Get-PrintJobCount([string]$printerName) {
  if (-not $printerName) { return -1 }
  try {
    return (Get-PrintJob -PrinterName $printerName -ErrorAction SilentlyContinue | Measure-Object).Count
  } catch {
    return -1
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

function Set-WindowMinimized([IntPtr]$handle) {
  try { if ($handle -ne [IntPtr]::Zero) { [void][ScyzorykFocusGuard]::ShowWindowAsync($handle, 6) } } catch {}
}

function Set-PrintAppWindowsMinimized {
  try {
    $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($name in @('Acrobat','AcroRd32','WINWORD','SumatraPDF')) {
      Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
    }
    if ($pids.Count -eq 0) { return }
    $handles = [ScyzorykFocusGuard]::FindVisibleWindowsForProcesses($pids)
    foreach ($h in $handles) { Set-WindowMinimized $h }
  } catch {}
}

$originalForeground = [IntPtr]::Zero
try { $originalForeground = [ScyzorykFocusGuard]::GetForegroundWindow() } catch {}
Set-PrintAppWindowsMinimized

$printerName = if ($useTargetedPrinter) { $PrinterName.Trim() } else { Get-DefaultPrinterName }
$jobCountBefore = Get-PrintJobCount $printerName

function Invoke-PrintWithShell([string]$path) {
  try { return Start-Process -FilePath $path -Verb Print -PassThru -WindowStyle Hidden }
  catch { return Start-Process -FilePath $path -Verb Print -PassThru }
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
# zawodzi (i tylko marnuje czas na oczekiwanie) - dla plikow nie-PDF od
# razu uzywamy zwyklego "otworz i wydrukuj przez skojarzony program"
# (Word), co realnie dziala, ale nie pozwala wybrac innej niz domyslna
# drukarki systemu (to jest dzisiejsze ograniczenie, nie da sie tego
# latwo obejsc bez prawdziwej automatyzacji Worda).
$isPdf = $FilePath.ToLower().EndsWith(".pdf")

if ($useTargetedPrinter -and $isPdf) {
  $sent = Invoke-PrintWithSumatra -path $FilePath -targetPrinter $printerName
  if (-not $sent) {
    Write-PrintLog "Sumatra nie wyslala - probuje Acrobata"
    $sent = Invoke-PrintWithAcrobat -path $FilePath -targetPrinter $printerName
    Write-PrintLog "Acrobat wynik: $sent"
  }
  if (-not $sent) { $null = Invoke-PrintWithShell -path $FilePath }
} else {
  if ($useTargetedPrinter -and -not $isPdf) {
    Write-PrintLog "Plik nie-PDF - wybor drukarki pomijam, drukuje na domyslna systemu"
  }
  $null = Invoke-PrintWithShell -path $FilePath
}

Restore-Foreground $originalForeground

$maxWaitMs = 20000
$waited = 0
$trackingAvailable = ($printerName -and $jobCountBefore -ge 0)

while ($waited -lt $maxWaitMs) {
  Set-PrintAppWindowsMinimized
  Restore-Foreground $originalForeground
  if ($trackingAvailable) {
    $current = Get-PrintJobCount $printerName
    if ($current -gt $jobCountBefore) { break }
  } elseif ($waited -ge 300) {
    break
  }
  $stepMs = if ($waited -lt 1500) { 15 } else { 80 }
  Start-Sleep -Milliseconds $stepMs
  $waited += $stepMs
}

Set-PrintAppWindowsMinimized
Restore-Foreground $originalForeground

Write-PrintLog "--- KONIEC (wyslano do sledzenia kolejki) ---"
Write-Output "OK"
