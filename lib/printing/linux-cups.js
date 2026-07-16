// Implementacja drukowania dla Linuksa przez CUPS (lp/lpstat/lpoptions/cancel).
// Zamiennik dla windows.js pod tym samym interfejsem - lib/printing.js
// wybiera jedno z dwoch wg process.platform, reszta aplikacji nie wie
// (i nie musi wiedziec), z ktorej implementacji korzysta.
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function runCups(cmd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: options.timeoutMs || 15000 });
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
  const duplexLine = lines.find(l => /^duplex\//i.test(l.trim()));
  if (!duplexLine) return { duplexSupported: false, duplexChoices: [] };
  const afterColon = duplexLine.split(':')[1] || '';
  const choices = afterColon.trim().split(/\s+/).filter(Boolean).map(c => c.replace(/^\*/, ''));
  const duplexSupported = choices.some(c => /^duplex/i.test(c));
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
    return { jobs };
  } catch (_) {
    return { jobs: [] };
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

  args.push(filePath);
  const { stdout } = await runCups('lp', args, { timeoutMs: options.timeoutMs || 30000 });
  const match = stdout.match(/request id is (\S+)/i);
  return { jobId: match ? match[1] : null, raw: stdout.trim() };
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
