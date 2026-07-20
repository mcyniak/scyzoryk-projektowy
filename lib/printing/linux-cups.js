// Implementacja drukowania dla Linuksa przez CUPS (lp/lpstat/lpoptions/cancel).
// Zamiennik dla windows.js pod tym samym interfejsem - lib/printing.js
// wybiera jedno z dwoch wg process.platform, reszta aplikacji nie wie
// (i nie musi wiedziec), z ktorej implementacji korzysta.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Wszystkie polecenia CUPS/gs/soffice ponizej parsuja swoje wlasne wyjscie
// tekstowe (np. "is running", "system default destination:", "request id
// is ..."). Bez wymuszenia locale C, na systemie z ustawionym jezykiem
// innym niz angielski (np. pl_PL.UTF-8) te same polecenia zwracaja
// przetlumaczony tekst i caly parsing po prostu przestaje dzialac -
// zwracajac fALSZYWE "nieudane"/"puste" wyniki zamiast prawdziwego stanu.
const C_LOCALE_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

// Niektore realne dokumenty (m.in. eksportowane z Word/LibreOffice) maja
// osadzone czcionki CID TrueType (Identity-H) z niestandardowa tabela cmap
// oraz slowo kluczowe "stream" zakonczone samym CR (bez LF) - Ghostscript
// (uzywany wewnetrznie przez CUPS/sterowniki drukarek sieciowych do
// rasteryzacji PDF-a) na czesci takich plikow konczy sie realnym bledem
// "invalid true type data found, assert failed cmap_off>-1" i zamiast
// tresci drukuje strone/strony z tym komunikatem bledu (potwierdzone na
// tym samym Pi - CUPS error_log zglaszal "file is damaged"/"stream keyword
// followed by carriage return only" na wielu zadaniach z tej apki).
// Naprawa: przepuszczenie pliku przez "gs -sDEVICE=pdfwrite" przed
// wyslaniem do "lp" - Ghostscript wtedy sam na nowo generuje i osadza
// czcionki, co w praktyce naprawia dokladnie ten rodzaj uszkodzenia.
// Jesli sama naprawa zawiedzie (np. brak gs, naprawde uszkodzony plik),
// drukujemy oryginal - nigdy nie blokujemy calego druku z powodu
// nieudanej sanityzacji.
async function sanitizePdfForPrinting(filePath) {
  const outPath = path.join(os.tmpdir(), `scyzoryk-print-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`);
  try {
    await execFileAsync('gs', [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER',
      `-sOutputFile=${outPath}`,
      filePath
    ], { timeout: 60000, env: C_LOCALE_ENV });
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
    return null;
  } catch (_) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    return null;
  }
}

// CUPS/sterowniki drukarek sieciowych nie potrafia wydrukowac surowego
// DOC/DOCX - "lp" po prostu wysle bajty pliku Worda jako "tekst" i drukarka
// wypluje strony smieci. Konwertujemy przez LibreOffice w trybie headless
// zanim plik trafi do "lp". Kazde wywolanie dostaje WLASNY, unikalny profil
// uzytkownika (-env:UserInstallation) - bez tego rownolegle konwersje z
// dwoch apek (drukarka + drukarka-projekty) albo dwoch sesji uzytkownikow
// wpadaja na blokade "soffice juz dziala, uzyj istniejacej instancji" i
// druga konwersja sie zawiesza/failuje.
async function convertOfficeDocToPdf(filePath) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-soffice-'));
  try {
    await execFileAsync('soffice', [
      '--headless', '--nologo', '--nofirststartwizard', '--norestore',
      `-env:UserInstallation=file://${path.join(workDir, 'profile')}`,
      '--convert-to', 'pdf', '--outdir', workDir, filePath
    ], { timeout: 90000, env: C_LOCALE_ENV });
    const outPath = path.join(workDir, `${path.basename(filePath, path.extname(filePath))}.pdf`);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      throw new Error('LibreOffice nie utworzylo pliku wyjsciowego PDF.');
    }
    return { outPath, workDir };
  } catch (err) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    const details = err.stderr || err.stdout || err.message || String(err);
    throw new Error('Konwersja DOC/DOCX do PDF (LibreOffice) nie powiodla sie: ' + String(details).trim());
  }
}

async function runCups(cmd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: options.timeoutMs || 15000, env: C_LOCALE_ENV });
    return { stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    const details = err.stderr || err.stdout || err.message || `Polecenie ${cmd} nie powiodlo sie.`;
    const wrapped = new Error(String(details).trim());
    wrapped.code = err.code;
    wrapped.stdout = err.stdout;
    wrapped.stderr = err.stderr;
    throw wrapped;
  }
}

// "Czy CUPS w ogole dziala" - nie samo "czy polecenie lpstat istnieje", tylko
// czy scheduler faktycznie odpowiada (ten sam duch co checkAvailability w
// adapterze Dysku Google - nie ufamy samej obecnosci binarki).
async function checkAvailability() {
  try {
    const { stdout } = await runCups('lpstat', ['-r'], { timeoutMs: 5000 });
    const running = /is running/i.test(stdout);
    return { available: running, reason: running ? null : stdout.trim() || 'CUPS scheduler nie odpowiada.' };
  } catch (err) {
    const notFound = err.code === 'ENOENT';
    return { available: false, reason: notFound ? 'CUPS (lpstat) nie jest zainstalowany.' : (err.message || String(err)) };
  }
}

async function listPrinters() {
  let printersOutput = '';
  try {
    // "-l" (nie samo "-p") - dokleja tez "Description:" per drukarka, co
    // pozwala pokazac przyjazna nazwe (np. "Flexi-archiwum2") zamiast
    // technicznej nazwy kolejki CUPS (np. "Lexmark_MS811_2"), jesli ktos ja
    // ustawil przez "lpadmin -p <kolejka> -D <nazwa>". Nazwa kolejki
    // (uzywana do wszystkich operacji drukowania) zostaje bez zmian - to
    // tylko etykieta wyswietlana uzytkownikowi.
    const { stdout } = await runCups('lpstat', ['-l', '-p']);
    printersOutput = stdout;
  } catch (err) {
    // "lpstat -p" zwraca kod bledu z tekstem "no destinations added", gdy
    // NIE MA zadnej skonfigurowanej drukarki - to jest normalny, pusty
    // wynik, nie awaria.
    if (/no destinations/i.test(err.message || '')) return [];
    throw err;
  }

  let defaultName = null;
  try {
    const { stdout } = await runCups('lpstat', ['-d']);
    const match = stdout.match(/system default destination:\s*(\S+)/i);
    if (match) defaultName = match[1];
  } catch (_) {
    // brak domyslnej drukarki nie jest bledem
  }

  const printers = [];
  const blocks = printersOutput.split(/(?=^printer\s)/m);
  for (const block of blocks) {
    const header = block.match(/^printer\s+(\S+)\s+is\s+([^.]+)\./);
    if (!header) continue;
    const name = header[1];
    const status = header[2].trim();
    const descMatch = block.match(/^\s*Description:\s*(.*)$/m);
    const description = descMatch ? descMatch[1].trim() : '';
    const displayName = description && description !== name ? description : name;
    printers.push({ name, displayName, status, isDefault: name === defaultName });
  }
  return printers;
}

// Odczytuje mozliwosci konkretnej drukarki ZANIM cokolwiek wydrukujemy -
// zeby moc pokazac ostrzezenie zamiast udawac ze duplex zostal zastosowany,
// gdy sterownik go w ogole nie obsluguje.
async function getPrinterOptions(printerName) {
  if (!printerName) throw new Error('Podaj nazwe drukarki.');
  const { stdout } = await runCups('lpoptions', ['-p', printerName, '-l']);
  const lines = stdout.split('\n');
  // Starsze sterowniki PPD wystawiaja opcje "Duplex/..." (wartosci typu
  // DuplexNoTumble/DuplexTumble/None), a nowoczesne drukarki IPP-Everywhere
  // (driverless) wystawiaja zamiast tego standardowa opcje CUPS-a
  // "sides/..." (wartosci one-sided/two-sided-long-edge/two-sided-short-edge)
  // - trzeba sprawdzic obie, inaczej duplex na driverless drukarce wyglada
  // jak nieobslugiwany mimo ze faktycznie dziala.
  const optionLine = lines.find(l => /^(duplex|sides)\//i.test(l.trim()));
  if (!optionLine) return { duplexSupported: false, duplexChoices: [] };
  const afterColon = optionLine.split(':')[1] || '';
  const choices = afterColon.trim().split(/\s+/).filter(Boolean).map(c => c.replace(/^\*/, ''));
  const duplexSupported = choices.some(c => /^duplex/i.test(c) || /^two-sided/i.test(c));
  return { duplexSupported, duplexChoices: choices };
}

async function getQueueStatus(printerName) {
  const args = printerName ? ['-o', printerName] : ['-o'];
  try {
    const { stdout } = await runCups('lpstat', args);
    const jobs = stdout.split('\n').filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      return { jobId: parts[0], raw: line.trim() };
    });
    return { ok: true, jobs };
  } catch (err) {
    // "lpstat -o" zwraca kod bledu z pustym wyjsciem, gdy kolejka jest po
    // prostu pusta - to NIE jest awaria. Prawdziwe awarie (CUPS nie
    // odpowiada, zla nazwa drukarki) trzeba jednak odroznic od "pusto",
    // inaczej wywolujacy nigdy sie nie dowie ze cos jest nie tak.
    const message = String(err.message || err || '').trim();
    if (!message || /no entries/i.test(message)) return { ok: true, jobs: [] };
    return { ok: false, jobs: [], message };
  }
}

async function cancelJob(jobId) {
  if (!jobId) throw new Error('Podaj identyfikator zadania do anulowania.');
  await runCups('cancel', [jobId]);
  return { ok: true };
}

async function printFile(filePath, printerName, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('PRINT_PATH: Nie znaleziono pliku do druku: ' + filePath);
  }
  const args = [];
  if (printerName) args.push('-d', printerName);
  const copies = Math.max(1, Math.min(99, Number(options.copies) || 1));
  args.push('-n', String(copies));

  // Nie zakladamy, ze kazda drukarka obsluguje duplex - wolajacy (server.js
  // aplikacji) ma wczesniej sprawdzic getPrinterOptions() i pokazac
  // ostrzezenie, jesli uzytkownik prosil o dwustronny wydruk na drukarce,
  // ktora go nie wspiera, zamiast po cichu zignorowac ta prosbe.
  if (options.duplex) {
    const sides = options.duplexEdge === 'short' ? 'two-sided-short-edge' : 'two-sided-long-edge';
    args.push('-o', `sides=${sides}`);
  } else {
    args.push('-o', 'sides=one-sided');
  }

  let printPath = filePath;
  let sanitizedPath = null;
  let convertedWorkDir = null;
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.doc' || ext === '.docx') {
    const converted = await convertOfficeDocToPdf(filePath);
    printPath = converted.outPath;
    convertedWorkDir = converted.workDir;
  }

  if (path.extname(printPath).toLowerCase() === '.pdf') {
    sanitizedPath = await sanitizePdfForPrinting(printPath);
    if (sanitizedPath) printPath = sanitizedPath;
  }

  args.push(printPath);
  try {
    const { stdout } = await runCups('lp', args, { timeoutMs: options.timeoutMs || 30000 });
    const match = stdout.match(/request id is (\S+)/i);
    // "lp" zakonczyl sie kodem 0 (inaczej runCups juz rzucilby wyjatek), ale
    // gdy jego wyjscie nie pasuje do oczekiwanego formatu, NIE mamy pewnosci
    // ze zadanie faktycznie trafilo do CUPS - "accepted: false" pozwala
    // wolajacemu pokazac ostrzezenie zamiast cichego "wszystko OK".
    return { jobId: match ? match[1] : null, accepted: Boolean(match), raw: stdout.trim() };
  } finally {
    // "lp" kopiuje plik do wlasnego spoolu CUPS-a od razu przy przyjeciu
    // zadania, wiec tymczasowe pliki (zsanityzowany PDF, katalog roboczy
    // konwersji LibreOffice) mozna bezpiecznie usunac zaraz po powrocie
    // polecenia, bez czekania na fizyczny wydruk.
    if (sanitizedPath) { try { fs.unlinkSync(sanitizedPath); } catch (_) {} }
    if (convertedWorkDir) { try { fs.rmSync(convertedWorkDir, { recursive: true, force: true }); } catch (_) {} }
  }
}

// CUPS zarzadza calym cyklem zycia zadania samodzielnie (spool + wysylka) -
// w przeciwienstwie do Windows nie ma tu osobnej aplikacji desktopowej
// (SumatraPDF/Acrobat) trzymajacej otwarty podglad/bufor po wydruku, wiec
// nie ma czego "domykac" po serii wydrukow.
function closePdfAppsAfterBatch() {}

module.exports = {
  checkAvailability,
  listPrinters,
  getPrinterOptions,
  getQueueStatus,
  cancelJob,
  printFile,
  printFileWindows: printFile,
  closePdfAppsAfterBatch,
};
