// Implementacja drukowania dla Windows - PowerShell + kolejka systemowa
// (SumatraPDF z fallbackiem na Adobe Acrobat, patrz print-file.ps1).
// Wydzielone z dawnego lib/printing.js bez zmiany logiki - tylko podzial na
// platformy, zeby lib/printing.js mogl wybrac wlasciwa implementacje wg
// process.platform.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { runPowerShell } = require('../hardening');

const PRINT_SCRIPT = path.join(__dirname, '..', 'printing', 'print-file.ps1');

// Filtrowane z listy - to nie sa fizyczne drukarki, tylko wirtualne
// "sterowniki" ktore i tak nie maja sensu do wyboru w tym narzedziu.
const VIRTUAL_PRINTER_PATTERN = /onenote|print to pdf|xps document writer|^fax$|send to (onenote|microsoft)/i;

async function checkAvailability() {
  if (process.platform !== 'win32') return { available: false, reason: 'Nie-Windows.' };
  try {
    await runPowerShell(null, ['-Command', 'Get-CimInstance Win32_Printer -First 1 | Out-Null'], { timeoutMs: 8000, windowsHide: true });
    return { available: true };
  } catch (err) {
    return { available: false, reason: err.message || String(err) };
  }
}

async function listPrinters() {
  const result = await runPowerShell(null, [
    '-Command',
    'Get-CimInstance Win32_Printer | Select-Object Name,Default | ConvertTo-Json -Compress'
  ], { cwd: __dirname, timeoutMs: 15000, windowsHide: true });

  let parsed;
  try { parsed = JSON.parse(result.stdout || '[]'); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [parsed];

  return parsed
    .filter(p => p && p.Name && !VIRTUAL_PRINTER_PATTERN.test(p.Name))
    .map(p => ({ name: p.Name, displayName: p.Name, isDefault: !!p.Default }));
}

// Windows nie ma prostego, jednolitego CLI do odpytania mozliwosci duplexu
// per-drukarka (wymagaloby to sterownikowo-specyficznego WMI/Get-PrintConfiguration).
// Zwracamy "nieznane" - UI powinien wtedy nie obiecywac duplexu, tak jak przy
// braku informacji z CUPS.
async function getPrinterOptions() {
  return { duplexSupported: null, duplexChoices: [] };
}

async function getQueueStatus() {
  return { jobs: [] };
}

async function cancelJob() {
  throw new Error('Anulowanie pojedynczego zadania z kolejki systemowej nie jest tu zaimplementowane na Windows.');
}

function printFile(filePath, printerName, options = {}) {
  const { cwd = process.cwd(), logDir, timeoutMs = 120000 } = options;
  if (process.platform !== 'win32') {
    throw new Error('Drukowanie z systemowej kolejki jest dostepne tylko na Windows.');
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('PRINT_PATH: Nie znaleziono pliku do druku: ' + filePath);
  }
  const psArgs = ['-FilePath', filePath];
  if (printerName) psArgs.push('-PrinterName', printerName);
  if (logDir) psArgs.push('-LogDir', logDir);
  return runPowerShell(PRINT_SCRIPT, psArgs, {
    cwd,
    timeoutMs: Number(timeoutMs),
    windowsHide: true
  }).catch(err => {
    const details = err.stderr || err.stdout || err.message || 'Nie udalo sie wyslac pliku do druku';
    throw new Error(String(details).trim());
  });
}

// Nie zamykamy Acrobata/Worda po kazdym pliku, bo to potrafilo anulowac
// buforowanie. Zamiast tego po calej serii robimy kilka lagodnych prob
// zamkniecia. Celowo BEZ Stop-Process -Force: to zabijaloby WSZYSTKIE
// procesy o tej nazwie uruchomione na maszynie (takze dokumenty otwarte
// przez inne osoby w firmie), nie tylko okno otwarte przez ten wydruk.
function closePdfAppsAfterBatch(cwd, closeDelaySeconds = 30) {
  if (process.platform !== 'win32') return;
  const delay = Math.max(10, Number(closeDelaySeconds || 30));

  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    function Close-PdfAppsGentle {
      foreach ($name in @('Acrobat','AcroRd32','WINWORD')) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
          try { [void]$_.CloseMainWindow() } catch {}
        }
      }
    }

    Start-Sleep -Seconds ${delay}
    Close-PdfAppsGentle
    Start-Sleep -Seconds 10
    Close-PdfAppsGentle
    Start-Sleep -Seconds 10
    Close-PdfAppsGentle
  `;

  const closer = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script
  ], {
    cwd,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });

  closer.unref?.();
}

module.exports = {
  PRINT_SCRIPT,
  checkAvailability,
  listPrinters,
  getPrinterOptions,
  getQueueStatus,
  cancelJob,
  printFile,
  printFileWindows: printFile,
  closePdfAppsAfterBatch,
};
