const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { runPowerShell, readJsonFileNoBom, writeJsonFileNoBom } = require('./hardening');

const PRINT_SCRIPT = path.join(__dirname, 'printing', 'print-file.ps1');
const DOCX_TO_PDF_SCRIPT = path.join(__dirname, 'printing', 'docx-to-pdf.ps1');

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

// Ustawia tryb jednostronnie/dwustronnie na poziomie DRUKARKI (nie
// pojedynczego zadania) - to jedyny sposob jaki daje Windows/SumatraPDF bez
// prawdziwego sterownika-per-job. WAZNE: to trwala zmiana domyslnej
// konfiguracji drukarki, wspoldzielona miedzy wszystkimi aplikacjami/osobami
// drukujacymi na tej samej (czesto sieciowej) drukarce - wywolujacy powinien
// to wywolywac tuz przed kazda seria wydrukow, tak jak juz robi apps/drukarka.
// Wyciagniete tutaj (bylo skopiowane tylko w apps/drukarka/server.js), zeby
// apps/drukarka-projekty moglo tez faktycznie respektowac wybor uzytkownika
// zamiast cicho go ignorowac (byl to prawdziwy blad - patrz historia audytu).
async function applyPrinterSides(sideMode, printerName, options = {}) {
  const platform = options.platform || process.platform;
  const runPowerShellImpl = options.runPowerShell || runPowerShell;
  if (platform !== 'win32') {
    return {
      ok: false,
      message: 'Ustawienie jednostronnie/dwustronnie jest dostepne tylko na Windows.'
    };
  }

  const mode = sideMode === 'two-sided' ? 'TwoSidedLongEdge' : 'OneSided';
  const label = sideMode === 'two-sided' ? 'dwustronnie' : 'jednostronnie';
  const targetPrinterPs = printerName ? "'" + String(printerName).replace(/'/g, "''") + "'" : '$null';
  const command = `
    $ErrorActionPreference = 'Stop'
    $printer = if (${targetPrinterPs}) { Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq ${targetPrinterPs} } | Select-Object -First 1 } else { Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1 }
    if (-not $printer) { throw 'Brak drukarki domyslnej.' }
    $before = Get-PrintConfiguration -PrinterName $printer.Name | Select-Object -ExpandProperty DuplexingMode
    Set-PrintConfiguration -PrinterName $printer.Name -DuplexingMode ${mode}
    Write-Output ($printer.Name + '|' + '${label}' + '|' + [string]$before)
  `;

  try {
    const result = await runPowerShellImpl(null, ['-Command', command], { cwd: __dirname, timeoutMs: 15000, windowsHide: true });
    const line = String(result.stdout || '').trim().split(/\r?\n/).pop() || '';
    const [resolvedPrinterName, , previousDuplexingMode] = line.split('|');

    return {
      ok: true,
      printerName: resolvedPrinterName || printerName || '',
      previousDuplexingMode: previousDuplexingMode || null,
      message: resolvedPrinterName
        ? `Ustawiono drukarke ${resolvedPrinterName}: ${label}.`
        : `Ustawiono drukowanie: ${label}.`
    };
  } catch (err) {
    return {
      ok: false,
      previousDuplexingMode: null,
      message: `Nie udalo sie automatycznie ustawic trybu ${label}. Sterownik drukarki moze tego nie obslugiwac. Drukowanie bedzie wyslane z aktualnymi ustawieniami drukarki.`
    };
  }
}

async function restorePrinterSides(printerName, previousDuplexingMode, options = {}) {
  const platform = options.platform || process.platform;
  const runPowerShellImpl = options.runPowerShell || runPowerShell;
  if (platform !== 'win32' || !printerName || previousDuplexingMode == null) {
    return { ok: false, message: 'Brak danych potrzebnych do przywrocenia duplexu.' };
  }

  const printerPs = "'" + String(printerName).replace(/'/g, "''") + "'";
  const duplexPs = "'" + String(previousDuplexingMode).replace(/'/g, "''") + "'";
  const command = `
    $ErrorActionPreference = 'Stop'
    Set-PrintConfiguration -PrinterName ${printerPs} -DuplexingMode ${duplexPs}
    Write-Output 'OK'
  `;

  try {
    await runPowerShellImpl(null, ['-Command', command], { cwd: __dirname, timeoutMs: 15000, windowsHide: true });
    return { ok: true, message: 'Przywrocono poprzednie ustawienie duplexu.' };
  } catch (err) {
    return { ok: false, message: `Nie udalo sie przywrocic poprzedniego duplexu: ${err.message || err}` };
  }
}

async function withPrinterSides(sideMode, printerName, fn, options = {}) {
  const setup = await applyPrinterSides(sideMode, printerName, options);
  try {
    return await fn(setup);
  } finally {
    if (setup.ok && setup.previousDuplexingMode != null) {
      const restored = await restorePrinterSides(setup.printerName || printerName, setup.previousDuplexingMode, options);
      if (!restored.ok) console.error(restored.message);
    }
  }
}

// Audyt UX 2026-08-21: throw-y z wlasnym prefiksem PRINT_* (patrz
// print-file.ps1) sa juz napisane po polsku, plain-language - ale KAZDY inny
// wyjatek (np. brak skonfigurowanej drukarki domyslnej w Windows, surowy
// .NET/PowerShell stacktrace) leciał wczesniej 1:1 na ekran nietechnicznego
// pracownika biura. Dla nierozpoznanych bledow dodajemy czytelny naglowek,
// nie tracac oryginalnego tekstu (nadal potrzebny do realnej diagnostyki).
// Wydzielone jako czysta funkcja, zeby dalo sie to przetestowac bez realnego
// wywolania PowerShell.
function formatPrintError(err) {
  const details = String(err?.stderr || err?.stdout || err?.message || 'Nie udalo sie wyslac pliku do druku').trim();
  const rozpoznany = /^PRINT_(PATH|TARGETED_FAILED|NOT_CONFIRMED):/.test(details);
  const wiadomosc = rozpoznany
    ? details
    : `Drukowanie nie powiodlo sie - drukarka moze byc wylaczona, niepodlaczona albo niedostepna w sieci. Sprawdz drukarke i sprobuj ponownie. (Szczegoly: ${details})`;
  return new Error(wiadomosc);
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
  }).catch(err => { throw formatPrintError(err); });
}

// Nie zamykamy Acrobata/Worda po kazdym pliku, bo to potrafilo anulowac
// buforowanie. Zamiast tego po calej serii robimy kilka lagodnych prob
// zamkniecia. Celowo BEZ Stop-Process -Force: to zabijaloby WSZYSTKIE
// procesy o tej nazwie uruchomione na maszynie (takze dokumenty otwarte
// przez inne osoby w firmie), nie tylko okno otwarte przez ten wydruk.

// Konwertuje paczke plikow DOCX do PDF przez jedna sesje Word COM
// (printing/docx-to-pdf.ps1) - wyciagniete z apps/drukarka-projekty/server.js
// (2026-08-19), zeby apps/drukarka moglo tez z tego skorzystac dla wlasnej
// opcji "Zapisz jako PDF" zamiast trzymac drugi, driftujacy egzemplarz.
// Jedna sesja Worda dla WSZYSTKICH plikow w wywolaniu (nie jedna na plik) -
// start Worda to dominujacy koszt czasowy calej operacji.
async function convertDocxBatchToPdf(opDir, files, options = {}) {
  if (!files.length) return [];
  const timeoutMs = Number(options.timeoutMs || 5 * 60 * 1000);
  const stamp = `${process.pid}_${Date.now()}`;
  const inputJson = path.join(opDir, `docx-to-pdf-in-${stamp}.json`);
  const outputJson = path.join(opDir, `docx-to-pdf-out-${stamp}.json`);
  writeJsonFileNoBom(inputJson, { files });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOCX_TO_PDF_SCRIPT,
        '-InputJson', inputJson, '-OutputJson', outputJson
      ], { cwd: __dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        reject(new Error(`Przekroczono limit czasu konwersji DOCX->PDF (${Math.round(timeoutMs / 60000)} min).`));
      }, timeoutMs);
      timer.unref();
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0 || fs.existsSync(outputJson)) return resolve();
        reject(new Error(stderr.trim() || `PowerShell (docx-to-pdf) zakonczyl sie kodem ${code}.`));
      });
    });
    const output = readJsonFileNoBom(outputJson);
    if (!output || output.ok !== true || !Array.isArray(output.results)) {
      throw new Error((output && output.error) || 'Konwersja DOCX->PDF nie zwrocila wynikow.');
    }
    return output.results;
  } finally {
    try { fs.rmSync(inputJson, { force: true }); } catch (_) {}
    try { fs.rmSync(outputJson, { force: true }); } catch (_) {}
  }
}

module.exports = {
  PRINT_SCRIPT,
  DOCX_TO_PDF_SCRIPT,
  listPrinters,
  safeName,
  contentDispositionHeader,
  wait,
  buildPrintJobs,
  applyPrinterSides,
  restorePrinterSides,
  withPrinterSides,
  printFileWindows,
  convertDocxBatchToPdf,
  formatPrintError,
};
