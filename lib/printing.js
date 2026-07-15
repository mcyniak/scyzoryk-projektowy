const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { runPowerShell } = require('./hardening');

const PRINT_SCRIPT = path.join(__dirname, 'printing', 'print-file.ps1');

// Filtrowane z listy - to nie sa fizyczne drukarki, tylko wirtualne
// "sterowniki" ktore i tak nie maja sensu do wyboru w tym narzedziu.
const VIRTUAL_PRINTER_PATTERN = /onenote|print to pdf|xps document writer|^fax$|send to (onenote|microsoft)/i;

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
    .map(p => ({ name: p.Name, isDefault: !!p.Default }));
}

function safeName(name) {
  return String(name || 'plik')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// Node.js pozwala w surowych naglowkach HTTP tylko na znaki Latin-1. Polskie
// znaki takie jak Z, N, A, L, E, S, Z (poza o/O, ktore akurat miesci sie w
// Latin-1) wywalaly caly request bledem 400 "Invalid character in header
// content [\"Content-Disposition\"]" - to byla przyczyna "podglad nie dziala"
// dla plikow z polskimi znakami w nazwie. Budujemy naglowek zgodnie z RFC
// 6266/5987: ASCII-owy fallback w filename= (dla starych klientow) i
// poprawnie zakodowana pelna nazwa w filename*=UTF-8''...
function contentDispositionHeader(disposition, filename) {
  const raw = String(filename || 'plik').replace(/"/g, '');
  const asciiFallback = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '_') || 'plik';
  const encoded = encodeURIComponent(raw).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPrintJobs(items, copies, copyMode) {
  const jobs = [];
  if (copyMode === 'set') {
    for (let copy = 1; copy <= copies; copy++) {
      for (const item of items) jobs.push({ item, copy, mode: 'set' });
    }
  } else {
    for (const item of items) {
      for (let copy = 1; copy <= copies; copy++) jobs.push({ item, copy, mode: 'file' });
    }
  }
  return jobs;
}

function printFileWindows(filePath, printerName, options = {}) {
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
  listPrinters,
  safeName,
  contentDispositionHeader,
  wait,
  buildPrintJobs,
  printFileWindows,
  closePdfAppsAfterBatch,
};
