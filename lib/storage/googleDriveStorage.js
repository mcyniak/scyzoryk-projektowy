// Wspolny adapter Dysku Google (montowanego przez rclone) - jedyne miejsce
// w calym projekcie, ktore wie ze pod danym katalogiem jest rclone, a nie
// zwykly lokalny dysk. Pozostale aplikacje (Karty katalogowe, docelowo
// Drukarka projektow) korzystaja wylacznie z funkcji ponizej - dzieki temu
// gdy kiedys rclone zostanie zastapione bezposrednim Google Drive API, zmiana
// bedzie tylko tutaj, nie w kazdej aplikacji z osobna.
//
// createStorageClient(rootPath) zwraca komplet funkcji "zawezonych" do
// danego katalogu - potrzebne bo rozne aplikacje maja dostep do roznych
// podkatalogow Dysku (np. Karty katalogowe tylko do SCYZORYK_PROJECTS_ROOT,
// nie do calego SCYZORYK_GOOGLE_DRIVE_ROOT), a logika dostepnosci/retry ma
// byc jedna, nie duplikowana per aplikacja.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const CHECK_CACHE_MS = 5000;

// Nazwa zdalnego remote'a rclone (np. "scyzoryk-drive:") potrzebna WYLACZNIE
// do dwoch nowych funkcji nizej (browseViaRclone/exportFileViaRclone), ktore
// wywoluja rclone CLI bezposrednio zamiast czytac przez zamontowany katalog.
// Powod: prawdziwe Arkusze/Dokumenty Google (nie zwykle .xlsx wgrane na
// Dysk) sa eksportowane "w locie" i maja NIEZNANY rozmiar (-1) - montowanie
// FUSE poprawnie je WIDZI (nazwa, katalog nadrzedny), ale odczyt ich
// zawartosci przez zamontowana sciezke zwraca 0 bajtow (zweryfikowane
// bezposrednio na dwoch wersjach rclone, 1.60.1 i 1.74.4 - to ograniczenie
// warstwy FUSE, nie blad konkretnej wersji). "rclone cat"/"rclone copyto"
// wywolane wprost na remote (z pominieciem punktu montowania) dzialaja
// poprawnie - stad te funkcje. Reszta modulu (resolveRelative, copyToLocal
// itd.) zostaje BEZ ZMIAN i dalej dziala na zwyklych plikach przez FUSE -
// to sa wylacznie DODATKOWE funkcje dla nowej przegladarki Dysku.
const RCLONE_REMOTE = process.env.SCYZORYK_GOOGLE_DRIVE_REMOTE || null;

// Uzytkownicy wpisuja sciezki z przyzwyczajenia tak jak na Windows (ukosnik
// wsteczny "\") - na Linuksie "\" to zwykly znak w nazwie pliku, nie
// separator katalogow, wiec bez tej zamiany cala wpisana sciezka trafialaby
// do path.resolve() jako JEDEN segment (nazwa folderu z literalnymi "\" w
// srodku) i nigdy by nie istniala. Zamieniamy przed kazdym uzyciem sciezki
// wzglednej pochodzacej od uzytkownika.
function normalizeUserPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function createStorageClient(rootPath) {
  const ROOT = rootPath || null;
  let lastCheck = { at: 0, result: null };
  // Cache listowan przegladarki Dysku (browseViaRclone) - "rclone lsjson"
  // z eksportem Arkuszy Google jest realnie wolne (zmierzone: ~34s dla
  // najwyzszego poziomu), a uzytkownik w UI typowo wchodzi/wychodzi z tego
  // samego folderu kilka razy pod rzad (np. cofa sie o poziom i wraca).
  // Krotki TTL - wystarczy zeby powtorna nawigacja byla szybka, wystarczajaco
  // krotki, zeby swiezo dodany plik pojawil sie po chwili, nie po godzinach.
  const BROWSE_CACHE_MS = 60000;
  const browseCache = new Map();

  // Zamienia sciezke WZGLEDNA (od ROOT) na absolutna, sprawdzajac realpath
  // (odporne na symlinki), zeby "../../etc" albo symlink prowadzacy poza
  // ROOT nigdy nie przeszedl. Celowo rzuca wyjatek zamiast zwracac null -
  // proba wyjscia poza dozwolony katalog to blad programisty/atak, nie
  // "zwykly brak pliku", ktory reszta funkcji obsluguje przez try/catch.
  function resolveRelative(relativePath) {
    if (!ROOT) throw new Error('Katalog Dysku Google nie jest ustawiony w konfiguracji.');
    const resolvedRoot = fs.realpathSync(ROOT);
    const candidate = path.resolve(resolvedRoot, normalizeUserPath(relativePath) || '.');
    let real;
    try { real = fs.realpathSync(candidate); } catch { real = candidate; }
    const rel = path.relative(resolvedRoot, real);
    if (rel === '') return resolvedRoot;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Sciezka wychodzi poza dozwolony katalog Dysku Google.');
    }
    return real;
  }

  function resolveDestinationInRoot(relativeDestPath) {
    if (!ROOT) throw new Error('Katalog Dysku Google nie jest ustawiony w konfiguracji.');
    const resolvedRoot = fs.realpathSync(ROOT);
    const destCandidate = path.resolve(resolvedRoot, normalizeUserPath(relativeDestPath));
    const rel = path.relative(resolvedRoot, destCandidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Docelowa sciezka wychodzi poza dozwolony katalog Dysku Google.');
    return destCandidate;
  }

  // Sprawdza CZY REALNIE da sie skorzystac z Dysku - samo istnienie katalogu
  // ROOT nie jest tego dowodem (rclone mogl padnac zostawiajac pusty/martwy
  // punkt montowania, ktory formalnie "istnieje"). Wynik jest krotko
  // cache'owany, zeby kilka wywolan w jednym zadaniu nie odpytywalo dysku
  // wielokrotnie.
  async function checkAvailability(options = {}) {
    const { useCache = true, testWrite = false } = options;
    if (useCache && !testWrite && Date.now() - lastCheck.at < CHECK_CACHE_MS) {
      return lastCheck.result;
    }
    const result = { available: false, reason: null, checkedAt: new Date().toISOString() };
    if (!ROOT) {
      result.reason = 'Katalog Dysku Google nie jest ustawiony w konfiguracji.';
      lastCheck = { at: Date.now(), result };
      return result;
    }
    try {
      await fsp.readdir(ROOT);
    } catch (err) {
      result.reason = `Nie mozna odczytac katalogu Dysku Google (${err.code || err.message}). Sprawdz, czy usluga rclone dziala.`;
      lastCheck = { at: Date.now(), result };
      return result;
    }
    if (testWrite) {
      const testFile = path.join(ROOT, `.scyzoryk-write-test-${crypto.randomUUID()}`);
      try {
        await fsp.writeFile(testFile, 'test');
        await fsp.unlink(testFile);
      } catch (err) {
        result.reason = `Katalog Dysku Google jest widoczny, ale probny zapis nie powiodl sie (${err.code || err.message}).`;
        lastCheck = { at: Date.now(), result };
        return result;
      }
    }
    result.available = true;
    lastCheck = { at: Date.now(), result };
    return result;
  }

  function getStatus() {
    return {
      root: ROOT,
      available: lastCheck.result?.available ?? null,
      reason: lastCheck.result?.reason ?? null,
      lastCheckedAt: lastCheck.result?.checkedAt ?? null,
    };
  }

  async function withLimitedRetry(fn, { retries = 2, delayMs = 500 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw lastErr;
  }

  async function listDirectory(relativePath = '.') {
    const dir = resolveRelative(relativePath);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
    } catch (_) {
      return null; // folder nie istnieje / brak dostepu - to NIE jest wyjscie poza ROOT (to juz obsluzyl resolveRelative)
    }
  }

  async function listFiles(relativePath = '.') {
    const entries = await listDirectory(relativePath);
    if (!entries) return null;
    return entries.filter(e => e.isFile).map(e => e.name);
  }

  async function findDirectory(relativePath, predicate) {
    const entries = await listDirectory(relativePath);
    if (!entries) return null;
    return entries.filter(e => e.isDirectory).find(e => predicate(e.name)) || null;
  }

  async function fileExists(relativePath) {
    try {
      const stat = await fsp.stat(resolveRelative(relativePath));
      return stat.isFile();
    } catch (_) {
      return false;
    }
  }

  // Sciezke wzgledem TEGO klienta (ROOT) zamienia na argument dla rclone CLI
  // (nazwa remote'a + sciezka wzgledem korzenia CALEGO montowania). Zaklada,
  // ze ROOT jest samym korzeniem montowania (tak jest dzis w kazdej
  // aplikacji - SCYZORYK_PROJECTS_ROOT=/mnt/scyzoryk-google-drive wprost) -
  // gdyby kiedys ROOT byl podkatalogiem montowania, ta funkcja wymagalaby
  // dodatkowego parametru z offsetem.
  function toRcloneArg(localAbsolutePath) {
    const resolvedRoot = fs.realpathSync(ROOT);
    const relFromRoot = path.relative(resolvedRoot, localAbsolutePath);
    return RCLONE_REMOTE + (relFromRoot ? relFromRoot.split(path.sep).join('/') : '');
  }

  // Przegladanie zawartosci folderu WPROST przez rclone CLI (nie fs.readdir
  // przez FUSE) - dzieki temu dostajemy prawdziwy rozmiar kazdego pliku
  // (albo -1 dla eksportowanych "w locie" Arkuszy/Dokumentow Google), co
  // pozwala UI odroznic "zwykly plik" od "trzeba eksportowac przez rclone".
  async function browseViaRclone(relativePath = '.') {
    if (!RCLONE_REMOTE) throw new Error('Przegladanie Dysku Google nie jest skonfigurowane (brak SCYZORYK_GOOGLE_DRIVE_REMOTE).');
    const dir = resolveRelative(relativePath);

    const cached = browseCache.get(dir);
    if (cached && Date.now() - cached.at < BROWSE_CACHE_MS) return cached.entries;

    const remoteArg = toRcloneArg(dir);
    let stdout;
    try {
      // "--fast-list" grupuje zapytania do API Google w mniejsza liczbe
      // wiekszych partii zamiast wielu malych - zmierzone bezposrednio:
      // listowanie najwyzszego poziomu Dysku spadlo z ~34s do ~22s. Timeout
      // 45s zostaje jako bezpieczny margines.
      ({ stdout } = await execFileAsync('rclone', ['lsjson', remoteArg, '--drive-export-formats', 'xlsx', '--fast-list'], { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }));
    } catch (err) {
      throw new Error('Nie udalo sie odczytac zawartosci folderu z Dysku Google: ' + (err.stderr || err.message || String(err)));
    }
    let entries;
    try { entries = JSON.parse(stdout); } catch { entries = []; }
    const result = entries
      .map(e => ({
        name: e.Name,
        isDirectory: !!e.IsDir,
        size: typeof e.Size === 'number' ? e.Size : -1,
        isNativeExport: !e.IsDir && e.Size === -1,
      }))
      .sort((a, b) => (Number(b.isDirectory) - Number(a.isDirectory)) || a.name.localeCompare(b.name, 'pl'));

    browseCache.set(dir, { at: Date.now(), entries: result });
    return result;
  }

  // Pobiera plik (zwykly ALBO naliwy Google) do lokalnej sciezki tymczasowej
  // wprost przez rclone CLI - jedyny niezawodny sposob na eksportowane "w
  // locie" Arkusze/Dokumenty Google (patrz komentarz przy RCLONE_REMOTE u
  // gory pliku). Uzywane przez nowa przegladarke Dysku, kiedy uzytkownik
  // wybiera plik Excel bezposrednio z Dysku zamiast go wgrywac.
  async function exportFileViaRclone(relativePath, localDestPath) {
    if (!RCLONE_REMOTE) throw new Error('Pobieranie plikow z Dysku Google nie jest skonfigurowane (brak SCYZORYK_GOOGLE_DRIVE_REMOTE).');
    const localPath = resolveRelative(relativePath);
    const remoteArg = toRcloneArg(localPath);
    try {
      await execFileAsync('rclone', ['copyto', remoteArg, localDestPath, '--drive-export-formats', 'xlsx'], { timeout: 60000 });
    } catch (err) {
      throw new Error('Nie udalo sie pobrac pliku z Dysku Google: ' + (err.stderr || err.message || String(err)));
    }
    return localDestPath;
  }

  // Jak exportFileViaRclone, ale zwraca bajty od razu w pamieci (Buffer) -
  // wygodne dla aplikacji, ktore i tak czytaja Excel z bufora (np. Drukarka
  // projektow), zeby nie tworzyc zbednego pliku tymczasowego na dysku.
  async function catFileViaRclone(relativePath) {
    if (!RCLONE_REMOTE) throw new Error('Pobieranie plikow z Dysku Google nie jest skonfigurowane (brak SCYZORYK_GOOGLE_DRIVE_REMOTE).');
    const localPath = resolveRelative(relativePath);
    const remoteArg = toRcloneArg(localPath);
    try {
      const { stdout } = await execFileAsync('rclone', ['cat', remoteArg, '--drive-export-formats', 'xlsx'], { timeout: 60000, encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      throw new Error('Nie udalo sie pobrac pliku z Dysku Google: ' + (err.stderr || err.message || String(err)));
    }
  }

  async function directoryExists(relativePath) {
    try {
      const stat = await fsp.stat(resolveRelative(relativePath));
      return stat.isDirectory();
    } catch (_) {
      return false;
    }
  }

  async function ensureDirectory(relativePath) {
    const candidate = resolveDestinationInRoot(relativePath);
    await fsp.mkdir(candidate, { recursive: true });
    return candidate;
  }

  async function getFileMetadata(relativePath) {
    const stat = await fsp.stat(resolveRelative(relativePath));
    return { size: stat.size, mtime: stat.mtime, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
  }

  async function verifiedCopy(sourcePath, destPath) {
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.copyFile(sourcePath, destPath);
    const [srcStat, destStat] = await Promise.all([fsp.stat(sourcePath), fsp.stat(destPath)]);
    if (srcStat.size !== destStat.size) {
      throw new Error(`Skopiowany plik ma inny rozmiar niz zrodlo (oczekiwano ${srcStat.size} B, jest ${destStat.size} B).`);
    }
    return destPath;
  }

  // Kopiuje plik Z Dysku Google NA DYSK LOKALNY - tego uzywaja aplikacje przed
  // ciezszymi operacjami (drukowanie, laczenie PDF), zeby nigdy nie pracowac
  // bezposrednio na plikach w zamontowanym katalogu.
  async function copyToLocal(relativePath, localDestPath) {
    const source = resolveRelative(relativePath);
    return withLimitedRetry(() => verifiedCopy(source, localDestPath));
  }

  // Kopiuje plik Z DYSKU LOKALNEGO na Dysk Google (np. gotowy wynik zadania).
  async function copyFromLocal(localSourcePath, relativeDestPath) {
    const dest = resolveDestinationInRoot(relativeDestPath);
    return withLimitedRetry(() => verifiedCopy(localSourcePath, dest));
  }

  // Kopiuje plik W OBREBIE Dysku Google (np. karta katalogowa -> folder
  // klienta) - dla lekkich operacji na pojedynczych malych plikach. Ciezsze
  // operacje maja isc przez copyToLocal + przetwarzanie lokalnie + copyFromLocal.
  async function copyWithinDrive(relativeSourcePath, relativeDestPath) {
    const source = resolveRelative(relativeSourcePath);
    const dest = resolveDestinationInRoot(relativeDestPath);
    return withLimitedRetry(() => verifiedCopy(source, dest));
  }

  // Czeka az plik stanie sie widoczny (np. tuz po synchronizacji rclone) -
  // ograniczona liczba prob w ramach timeoutu, NIGDY w nieskonczonosc.
  async function waitUntilFileAvailable(relativePath, { timeoutMs = 15000, intervalMs = 1000 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await fileExists(relativePath)) return true;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  return {
    ROOT,
    resolveRelative,
    checkAvailability,
    getStatus,
    listDirectory,
    listFiles,
    findDirectory,
    fileExists,
    directoryExists,
    ensureDirectory,
    getFileMetadata,
    copyToLocal,
    copyFromLocal,
    copyWithinDrive,
    waitUntilFileAvailable,
    browseViaRclone,
    exportFileViaRclone,
    catFileViaRclone,
  };
}

// Domyslna instancja dla calego Dysku (SCYZORYK_GOOGLE_DRIVE_ROOT) - wygodne
// dla aplikacji, ktorym wolno przegladac caly Dysk. Aplikacje ograniczone do
// wezszego podkatalogu (np. Karty katalogowe -> SCYZORYK_PROJECTS_ROOT)
// powinny wywolac createStorageClient(process.env.SCYZORYK_PROJECTS_ROOT)
// zamiast tego.
const defaultClient = createStorageClient(process.env.SCYZORYK_GOOGLE_DRIVE_ROOT || null);

module.exports = { createStorageClient, ...defaultClient };
