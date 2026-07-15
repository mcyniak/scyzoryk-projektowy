const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const readXlsxFile = require('read-excel-file/node');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { setupProcessDiagnostics, applyHttpTimeouts, readJsonFileNoBom, writeJsonFileNoBom, scheduleCleanup } = require('../../lib/hardening');
const { createStorageClient } = require('../../lib/storage/googleDriveStorage');

const app = express();
const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
setupProcessDiagnostics('karty-katalogowe', ROOT);

const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const LOGS_DIR = path.join(ROOT, 'logs');
const MAX_FILE_MB = Number(process.env.KK_MAX_FILE_MB || 25);
const JOB_TTL_MS = Number(process.env.KK_JOB_TTL_MS || 24 * 60 * 60 * 1000);

// SCYZORYK_PROJECTS_ROOT (podkatalog zamontowanego Dysku Google) ogranicza,
// gdzie ta aplikacja moze w ogole czytac/zapisywac - uzytkownik podaje juz
// tylko sciezke WZGLEDEM tego katalogu (np. "6. Paradyz Zarnow/Kolektory"),
// nie dowolna sciezke systemowa. Jesli zmienna nie jest ustawiona (np.
// uruchomienie poza pilotem/lokalny test), zachowujemy stare zachowanie -
// pelna sciezka wpisana przez uzytkownika, z prosta walidacja istnienia -
// zeby nie zlamac dzialania poza kontekstem pilota.
const PROJECTS_ROOT = process.env.SCYZORYK_PROJECTS_ROOT || null;
const projectsStorage = PROJECTS_ROOT ? createStorageClient(PROJECTS_ROOT) : null;

for (const dir of [DATA_DIR, UPLOAD_DIR, LOGS_DIR]) fs.mkdirSync(dir, { recursive: true });
scheduleCleanup([UPLOAD_DIR], JOB_TTL_MS, 60 * 60 * 1000);

// --- Bezpieczenstwo / middleware, wzorowane na pozostalych modulach Scyzoryka ---

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};

app.disable('x-powered-by');
app.use((req, res, next) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); next(); });
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Scyzoryk-Request') === '1') return next();
  return res.status(403).json({ ok: false, message: 'Odśwież stronę i spróbuj ponownie.' });
});
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.KK_API_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie.' }
});
app.use('/api', apiLimiter);
app.use(express.static(path.join(ROOT, 'public')));

// --- Upload Excela ---

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

function safeName(name, fallback = 'plik') {
  const cleaned = sanitize(String(name || fallback)).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return (cleaned || fallback).slice(0, 150);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = safeName(decodeOriginalName(file.originalname), 'dane.xlsx');
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${original}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeOriginalName(file.originalname || '')).toLowerCase();
    if (ext === '.xlsx') return cb(null, true);
    return cb(new Error('Wybierz plik Excel .xlsx.'));
  }
});

// --- Logika doboru kart katalogowych ---

// Karty, ktore ida ZAWSZE (nazwy plikow zrodlowych w folderze "karty" na dysku)
const ZAWSZE_KARTY = ['Grupa pompowa.pdf', 'Kolektor KSG 21GT.pdf'];
// Zasobnik dobierany wg ostatniej liczby w UID (np. "2/250" -> 250, "2x4/400" -> 400)
const ROZMIARY_ZASOBNIKA = ['250', '300', '400'];
function nazwaZasobnika(rozmiar) { return `Zasobnik SGW(S)B ${rozmiar}.pdf`; }

function normalizujTekst(value) {
  return String(value ?? '').trim();
}

function normalizeHeader(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Szuka kolumny po dopasowaniu znormalizowanego naglowka - ten sam wzorzec
// co w apps/drukarka-projekty/src/excelInvestment.js, zeby dobor kolumn
// przetrwal przestawienie kolejnosci kolumn w arkuszu (zamiast sztywnych
// numerow indeksow jak wczesniej).
function findColumn(headerRow, mustIncludeAll, mustNotInclude = []) {
  for (let col = 0; col < headerRow.length; col += 1) {
    const norm = normalizeHeader(headerRow[col]);
    if (!norm) continue;
    const hasAll = mustIncludeAll.every(kw => norm.includes(kw));
    const hasNone = mustNotInclude.every(kw => !norm.includes(kw));
    if (hasAll && hasNone) return col;
  }
  return -1;
}

function parseIdFolderu(value) {
  // 'LP gminy' bywa liczba zmiennoprzecinkowa (78.0) - normalizujemy do zwyklego inta jako string.
  // Uwaga: Number(null) === 0, wiec puste/brakujace pole trzeba odrzucic ZANIM przejdzie przez Number().
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return String(Math.trunc(num));
}

function parseRozmiarZUid(uidRaw) {
  const uid = normalizujTekst(uidRaw);
  if (!uid) return null;
  const parts = uid.split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const match = last.match(/(\d+)/);
  if (!match) return null;
  const rozmiar = match[1];
  return ROZMIARY_ZASOBNIKA.includes(rozmiar) ? rozmiar : { nieznany: rozmiar };
}

// Rozpoznaje nazwe gminy z nazwy arkusza, np. "Solary Paradyż" -> "Paradyż"
function gminaZNazwyArkusza(sheetName) {
  const match = String(sheetName || '').match(/^\s*Solary\s+(.+?)\s*$/i);
  if (!match) return null;
  // Nazwa arkusza XLSX jest danymi od klienta i trafia bezposrednio do
  // sciezki na dysku (patrz przetworzArkusz -> projektyDir). Bez sanityzacji
  // arkusz nazwany np. "Solary ../../../Windows" wyprowadzalby zapis poza
  // folder Projekty. sanitize-filename usuwa / \ oraz zamienia samo ".."
  // na pusty string, wiec taki arkusz zostanie po prostu potraktowany jak
  // "nie dotyczy solarow" zamiast wyjsc poza dozwolony katalog.
  return safeName(match[1], '') || null;
}

// Buduje mape: id (string) -> nazwa folderu, na podstawie prefiksu "123 - " lub "123."
function zbudujMapeFolderow(nazwyFolderow) {
  const mapa = new Map();
  const duplikaty = new Set();
  for (const nazwa of nazwyFolderow) {
    const match = nazwa.match(/^\s*(\d+)\s*[-.]\s*/);
    if (!match) continue;
    const id = match[1];
    if (mapa.has(id)) duplikaty.add(id);
    else mapa.set(id, nazwa);
  }
  return { mapa, duplikaty };
}

// `client` to instancja lib/storage/googleDriveStorage (albo prawdziwy
// SCYZORYK_PROJECTS_ROOT, albo per-zadanie klient zbudowany z pelnej sciezki
// w trybie zapasowym - patrz resolveRequestRoot) - ta funkcja nigdy nie wie,
// czy pod spodem jest rclone czy zwykly lokalny dysk.
async function przetworzArkusz({ sheetName, rows, client, baseRelative, dryRun }) {
  const gmina = gminaZNazwyArkusza(sheetName);
  const wyniki = [];
  if (!gmina) return wyniki; // arkusz nie dotyczy solarow (np. Pompy, Kotly, adresy)

  const kartyRel = path.join(baseRelative, 'karty');
  const projektyBazowyRel = path.join(baseRelative, 'Projekty');
  const projektyRel = path.join(projektyBazowyRel, gmina);
  // Druga warstwa ochrony obok sanityzacji w gminaZNazwyArkusza - nawet gdyby
  // sanityzacja kiedys zawiodla, nie pozwalamy wyjsc poza .../Projekty.
  if (path.relative(projektyBazowyRel, projektyRel).startsWith('..')) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": niepoprawna nazwa gminy z arkusza - pominieto.` });
    return wyniki;
  }

  const kartyEntries = await client.listDirectory(kartyRel);
  const folderyKlientowEntries = await client.listDirectory(projektyRel);

  if (kartyEntries === null) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono folderu ze zrodlowymi kartami ("karty").` });
    return wyniki;
  }
  if (folderyKlientowEntries === null) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono folderu projektow dla gminy "${gmina}".` });
    return wyniki;
  }

  const { mapa: mapaFolderow, duplikaty } = zbudujMapeFolderow(
    folderyKlientowEntries.filter(e => e.isDirectory).map(e => e.name)
  );

  // rows[0] to naglowek - kolumny wykrywane po nazwie, nie po sztywnym
  // numerze indeksu, zeby przestawienie kolumn w arkuszu nie psulo doboru.
  const header = rows[0] || [];
  // "gmin" (rdzen), nie "gmina" - naglowek bywa odmieniony ("LP Gminy"),
  // a dopasowanie po pelnym slowie "gmina" nie zlapaloby wtedy substringu
  // (ten sam blad odmiany co wczesniej w drukarka-projekty/folderMatch.js).
  const colLpGmina = findColumn(header, ['lp', 'gmin']);
  const colRezygnacja = findColumn(header, ['rezygnacj']);
  const colAdres = findColumn(header, ['adres'], ['kod', 'email', 'e mail']);
  const colUid = findColumn(header, ['uid']);

  const brakujaceKolumny = [];
  if (colLpGmina === -1) brakujaceKolumny.push('LP gminy');
  if (colAdres === -1) brakujaceKolumny.push('adres');
  if (colUid === -1) brakujaceKolumny.push('UID');
  if (brakujaceKolumny.length) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono kolumn: ${brakujaceKolumny.join(', ')}. Sprawdz naglowki w pierwszym wierszu arkusza.` });
    return wyniki;
  }
  // colRezygnacja moze byc -1 (nie kazdy arkusz ma taka kolumne) - wtedy po
  // prostu nikt nigdy nie ma rezygnacji, co jest bezpiecznym zachowaniem.

  for (let i = 1; i < rows.length; i += 1) {
    const wiersz = i + 1; // numer wiersza w Excelu (1 = naglowek)
    const row = rows[i];
    if (!row || row.every(v => v === null || v === undefined || v === '')) continue;

    const id = parseIdFolderu(row[colLpGmina]);
    const rezygnacja = colRezygnacja !== -1 ? normalizujTekst(row[colRezygnacja]) : '';
    const adres = normalizujTekst(row[colAdres]);
    const uid = normalizujTekst(row[colUid]);
    const opisAdresu = adres || '(brak adresu)';

    if (!uid) {
      // NIE pomijamy cicho - moze to byc adres ktory faktycznie nie dotyczy
      // solarow (normalne), ale rownie dobrze ktos mogl zapomniec wpisac UID -
      // uzytkownik ma to zobaczyc w raporcie, nie musiec zgadywac.
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid: null, status: 'pominieto-brak-uid', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak wartosci UID dla adresu "${opisAdresu}" - pominieto.` });
      continue;
    }

    if (rezygnacja) {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, status: 'pominieto-rezygnacja', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: rezygnacja dla adresu "${opisAdresu}" - pominieto.` });
      continue;
    }

    if (!id) {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id: row[colLpGmina], adres, uid, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak poprawnego "LP gminy" dla adresu "${opisAdresu}" - nie mozna dopasowac folderu.` });
      continue;
    }

    if (duplikaty.has(id)) {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: na dysku jest wiecej niz jeden folder zaczynajacy sie od "${id}" dla adresu "${opisAdresu}" - wymaga recznego sprawdzenia.` });
      continue;
    }

    const folderNazwa = mapaFolderow.get(id);
    if (!folderNazwa) {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nie znaleziono na dysku folderu zaczynajacego sie od "${id} -" dla adresu "${opisAdresu}".` });
      continue;
    }

    const rozmiar = parseRozmiarZUid(uid);
    if (!rozmiar || typeof rozmiar === 'object') {
      const nieznany = rozmiar && rozmiar.nieznany ? rozmiar.nieznany : uid;
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nierozpoznany rozmiar zasobnika w UID ("${nieznany}") dla adresu "${opisAdresu}". Oczekiwano 250/300/400.` });
      continue;
    }

    const wymaganePliki = [...ZAWSZE_KARTY, nazwaZasobnika(rozmiar)];
    const folderKlientaRel = path.join(projektyRel, folderNazwa);
    const istniejaceEntries = await client.listDirectory(folderKlientaRel);
    const istniejace = new Set((istniejaceEntries || []).filter(e => e.isFile).map(e => e.name.toLowerCase()));

    const doSkopiowania = wymaganePliki.filter(nazwa => !istniejace.has(nazwa.toLowerCase()));

    if (doSkopiowania.length === 0) {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'pominieto-juz-sa', komunikat: 'Karty katalogowe juz sa w folderze klienta.' });
      continue;
    }

    const skopiowane = [];
    const bledy = [];
    for (const nazwaPliku of doSkopiowania) {
      const zrodloRel = path.join(kartyRel, nazwaPliku);
      const celRel = path.join(folderKlientaRel, nazwaPliku);
      const zrodloIstnieje = await client.fileExists(zrodloRel);
      if (!zrodloIstnieje) {
        bledy.push(`Brak pliku zrodlowego: ${nazwaPliku}`);
        continue;
      }
      if (!dryRun) {
        try {
          // copyWithinDrive weryfikuje po skopiowaniu rozmiar pliku (czy
          // zapis rzeczywiscie sie zakonczyl), a nie tylko ze copyFile()
          // nie rzucil wyjatku - rclone potrafi "zwrocic sukces" zanim
          // dane naprawde trafia do chmury.
          await client.copyWithinDrive(zrodloRel, celRel);
          skopiowane.push(nazwaPliku);
        } catch (err) {
          bledy.push(`Nie udalo sie skopiowac ${nazwaPliku}: ${err.message}`);
        }
      } else {
        skopiowane.push(nazwaPliku + ' (podglad)');
      }
    }

    if (bledy.length && skopiowane.length === 0) {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: ${bledy.join('; ')}` });
    } else if (bledy.length) {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'czesciowo', komunikat: `Skopiowano: ${skopiowane.join(', ')}. Bledy: ${bledy.join('; ')}` });
    } else {
      wyniki.push({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: dryRun ? 'do-skopiowania' : 'skopiowano', komunikat: `Pliki: ${skopiowane.join(', ')}` });
    }
  }

  return wyniki;
}

// Ustala, wzgledem czego uzytkownik podaje folder do przetworzenia. W
// pilocie (SCYZORYK_PROJECTS_ROOT ustawione) uzytkownik podaje sciezke
// WZGLEDEM tego katalogu (Dysk Google) - containment sprawdza
// projectsStorage.resolveRelative (realpath, odporne na symlinki i "..").
// Bez tej zmiennej (uruchomienie poza pilotem) dzialamy jak dawniej: pelna
// sciezka wpisana przez uzytkownika, per-zadaniowy klient zbudowany wprost
// z niej.
function resolveRequestRoot(userRootPathInput) {
  const raw = normalizujTekst(userRootPathInput);
  if (!raw) throw new Error('Podaj folder do przetworzenia.');

  if (projectsStorage) {
    let resolved;
    try {
      resolved = projectsStorage.resolveRelative(raw);
    } catch (err) {
      throw new Error(err.message);
    }
    if (!fs.existsSync(resolved)) throw new Error(`Podana sciezka nie istnieje: ${raw}`);
    const relFromProjectsRoot = path.relative(fs.realpathSync(PROJECTS_ROOT), resolved);
    return { client: projectsStorage, baseRelative: relFromProjectsRoot };
  }

  if (!fs.existsSync(raw)) throw new Error(`Podana sciezka nie istnieje: ${raw}`);
  return { client: createStorageClient(raw), baseRelative: '' };
}

// --- Endpointy ---

app.get('/api/health', async (req, res) => {
  const payload = { ok: true, name: 'karty-katalogowe' };
  if (projectsStorage) payload.googleDrive = await projectsStorage.checkAvailability();
  res.json(payload);
});

app.get('/api/drive-status', async (req, res) => {
  if (!projectsStorage) return res.json({ ok: true, configured: false });
  const status = await projectsStorage.checkAvailability({ useCache: false, testWrite: true });
  res.json({ ok: true, configured: true, ...status });
});

app.post('/api/run', upload.single('excel'), async (req, res) => {
  const jobId = crypto.randomUUID();
  try {
    if (!req.file) throw new Error('Dodaj plik Excel (.xlsx).');
    const dryRun = String(req.body.dryRun || '').toLowerCase() === 'true';

    if (projectsStorage) {
      const availability = await projectsStorage.checkAvailability();
      if (!availability.available) {
        throw new Error(`Dysk Google jest obecnie niedostepny. Sprawdz polaczenie internetowe lub usluge rclone. (${availability.reason || 'brak szczegolow'})`);
      }
    }

    const { client, baseRelative } = resolveRequestRoot(req.body.rootPath);

    // Uwaga: w tej wersji read-excel-file { getSheets: true } zwraca od razu
    // wszystkie arkusze z danymi (pole 'sheet' = nazwa, 'data' = wiersze),
    // wiec nie trzeba osobno doczytywac kazdego arkusza.
    const wszystkieArkusze = await readXlsxFile(req.file.path, { getSheets: true });

    const wynikiWszystkie = [];
    for (const arkusz of wszystkieArkusze) {
      const sheetName = arkusz.sheet;
      const rows = arkusz.data;
      const gmina = gminaZNazwyArkusza(sheetName);
      if (!gmina) continue; // pomijamy arkusze Pompy / Kotly / adresy itp.
      const wynikiArkusza = await przetworzArkusz({ sheetName, rows, client, baseRelative, dryRun });
      wynikiWszystkie.push(...wynikiArkusza);
    }

    const podsumowanie = wynikiWszystkie.reduce((acc, w) => {
      acc[w.status] = (acc[w.status] || 0) + 1;
      return acc;
    }, {});

    const logPath = path.join(LOGS_DIR, `dobor-kart-${jobId}.json`);
    writeJsonFileNoBom(logPath, { jobId, createdAt: new Date().toISOString(), rootPath: normalizujTekst(req.body.rootPath), dryRun, podsumowanie, wyniki: wynikiWszystkie });

    res.json({ ok: true, jobId, dryRun, podsumowanie, wyniki: wynikiWszystkie });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  } finally {
    if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ ok: false, message: err.message || 'Blad przetwarzania.' });
});

const server = app.listen(PORT, HOST, () => console.log(`Karty katalogowe: http://${HOST}:${PORT}`));
applyHttpTimeouts(server, 'KK');
