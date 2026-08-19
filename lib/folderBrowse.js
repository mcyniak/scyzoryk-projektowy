// Przegladarka folderow wewnatrz strony (zamiast wpisywania sciezki
// recznie) - patrz plan w tworzenie-folderow/drukarka-projekty/
// karty-katalogowe: dwie proby prawdziwego natywnego okna Windows
// (explorer.exe w tle, System.Windows.Forms.FolderBrowserDialog) zostaly
// przetestowane NA ZYWO i obie zawiodly na maszynie wlasciciela
// (prawdopodobnie polityka grupowa blokujaca okna z procesow w tle) -
// zwykla przegladarka folderow w samej stronie dziala niezaleznie od tego
// ograniczenia, bo to serwer (ma pelny dostep do prawdziwych sciezek) i
// zwykla strona (bez zadnego zewnetrznego okna).
//
// Endpoint GET korzystajacy z tego modulu CELOWO nie ma dodatkowej
// weryfikacji "czy sciezka jest w dozwolonym katalogu" (w odroznieniu od
// isPathInsideFolder w apps/drukarka-projekty i apps/tworzenie-folderow,
// ktore ZAPISUJA/TWORZA pliki) - przegladarka ma pokazywac DOWOLNY folder
// na dysku uzytkownika, o to w niej chodzi. To czysty odczyt NAZW
// podkatalogow, nigdy zawartosci plikow.
const fs = require('fs');
const path = require('path');

function listDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const drivePath = `${String.fromCharCode(code)}:\\`;
    if (fs.existsSync(drivePath)) drives.push(drivePath);
  }
  return drives;
}

// Zwraca { path, parent, entries }. Brak requestedPath -> lista dyskow
// (path: null, parent: null). parent: null tez gdy jestesmy w korzeniu
// dysku (np. "G:\") - UI wie wtedy, ze strzalka "w gore" wraca do listy
// dyskow, nie proboje isc "wyzej" niz istnieje.
//
// `options.fileExtensions` (2026-08-19, dodane dla ocr-audytow - wybor
// KONKRETNEGO pliku .xlsx, nie tylko folderu): jesli podane, `entries`
// zawiera TAKZE pliki o pasujacym rozszerzeniu (male litery, z kropka, np.
// ['.xlsx']), oznaczone `isFile: true`. Bez tej opcji zachowanie jest
// DOKLADNIE takie samo jak dotad (tylko podfoldery, `isFile: false` na
// kazdym wpisie - dodatkowa wlasciwosc niczego nie psuje istniejacym
// wywolujacym, ktorzy jej nie sprawdzaja).
function browseFolder(requestedPath, options = {}) {
  const fileExtensions = options.fileExtensions || null;
  const trimmed = String(requestedPath || '').trim();
  if (!trimmed) {
    return {
      path: null,
      parent: null,
      entries: listDrives().map(drivePath => ({ name: drivePath, path: drivePath, isFile: false }))
    };
  }

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Folder nie istnieje: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`To nie jest folder: ${resolved}`);
  }

  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || (fileExtensions && entry.isFile() && fileExtensions.includes(path.extname(entry.name).toLowerCase())))
    .map(entry => ({ name: entry.name, path: path.join(resolved, entry.name), isFile: entry.isFile() }))
    // numeric:true - sortowanie naturalne (2, 10, 11 zamiast 10, 11, 2), wazne
    // bo foldery adresow w tym projekcie nazywaja sie np. "2.Kijowiec-Szyszynek 2".
    .sort((a, b) => a.name.localeCompare(b.name, 'pl', { numeric: true, sensitivity: 'base' }));

  const isDriveRoot = /^[A-Za-z]:\\?$/.test(resolved);
  const parent = isDriveRoot ? null : path.dirname(resolved);

  return { path: resolved, parent, entries };
}

module.exports = { listDrives, browseFolder };
