// Fasada drukowania - wybiera implementacje wg process.platform (Windows:
// PowerShell + SumatraPDF/Adobe, Linux: CUPS), tak ze reszta aplikacji nie
// musi wiedziec, ktorej platformy dotyczy. Funkcje platformowo-niezalezne
// (safeName, contentDispositionHeader, wait, buildPrintJobs) zyja tu wprost.
const platformImpl = process.platform === 'win32'
  ? require('./printing/windows')
  : require('./printing/linux-cups');
const { acquirePrintLock } = require('./printing/printLock');

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

module.exports = {
  PRINT_SCRIPT: platformImpl.PRINT_SCRIPT || null,
  safeName,
  contentDispositionHeader,
  wait,
  buildPrintJobs,
  // Miedzyprocesowa blokada, zeby serie druku od dwoch uzytkownikow
  // (osobne procesy Node: drukarka + drukarka-projekty) nie przeplataly
  // sie w kolejce fizycznej drukarki. Platformowo-niezalezna.
  acquirePrintLock,
  // Platformowo-zalezne - deleguja do windows.js albo linux-cups.js:
  checkAvailability: platformImpl.checkAvailability,
  listPrinters: platformImpl.listPrinters,
  getPrinterOptions: platformImpl.getPrinterOptions,
  getQueueStatus: platformImpl.getQueueStatus,
  cancelJob: platformImpl.cancelJob,
  printFile: platformImpl.printFile,
  // Stara nazwa - zachowana dla wstecznej zgodnosci z apps/drukarka-projekty,
  // ktore jeszcze jej uzywa (nie tkniete w tym przejsciu na CUPS).
  printFileWindows: platformImpl.printFileWindows,
  closePdfAppsAfterBatch: platformImpl.closePdfAppsAfterBatch,
};
