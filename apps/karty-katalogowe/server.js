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
const { setupProcessDiagnostics, applyHttpTimeouts, readJsonFileNoBom, writeJsonFileNoBom, scheduleCleanup, createSemaphore } = require('../../lib/hardening');
const { getAppDataDir } = require('../../lib/appPaths');
const { isAffirmativeFlag } = require('../../lib/businessFlags');

const app = express();
const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const APP_DATA_ROOT = getAppDataDir('karty-katalogowe');
setupProcessDiagnostics('karty-katalogowe', APP_DATA_ROOT);

const DATA_DIR = path.join(APP_DATA_ROOT, 'data');
const UPLOAD_DIR = path.join(APP_DATA_ROOT, 'uploads');
const LOGS_DIR = path.join(APP_DATA_ROOT, 'logs');
const MAX_FILE_MB = Number(process.env.KK_MAX_FILE_MB || 25);
const JOB_TTL_MS = Number(process.env.KK_JOB_TTL_MS || 24 * 60 * 60 * 1000);

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
app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
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

// Sprawdzanie kazdego adresu (listowanie folderu klienta na dysku, potem
// ewentualne kopiowanie) bylo do tej pory SEKWENCYJNE - jeden adres na raz,
// czeka na odpowiedz dysku sieciowego, dopiero potem nastepny. Przy 100+
// wierszach to realnie kilka minut. Adresy sa od siebie niezalezne, wiec
// przetwarzamy je rownolegle z ograniczeniem (nie bez ograniczenia - zbyt
// duzo naraz zadan do dysku sieciowego mogloby zaczac dostawac bledy).
const KK_CONCURRENCY = Math.max(1, Number(process.env.KK_CONCURRENCY || 8));

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
  if (ROZMIARY_ZASOBNIKA.includes(rozmiar)) return rozmiar;
  // Fizyczne zasobniki wystepuja tylko w tych konkretnych rozmiarach (karty
  // katalogowe sa tylko dla 250/300/400) - liczba w UID to WYMAGANA
  // pojemnosc (np. z obliczen doboru), ktora trzeba zaokraglic W GORE do
  // najblizszego dostepnego rozmiaru (np. "200"/"220" -> 250), nigdy w dol -
  // za maly zasobnik nie spelnilby wymogu. Realny przyklad z produkcji:
  // 92 ze 147 wierszy mialo UID konczace sie na "200" i bylo odrzucane jako
  // "nierozpoznany rozmiar", mimo ze 250 jest oczywistym, jedynym sensownym
  // dopasowaniem. Liczby WIEKSZE niz najwiekszy dostepny rozmiar (>400) nadal
  // sa bledem - nie ma czym ich zaspokoic, wiec nie zgadujemy w gore w
  // nieskonczonosc.
  const liczba = Number(rozmiar);
  const najblizszyWiekszy = ROZMIARY_ZASOBNIKA
    .map(Number)
    .sort((a, b) => a - b)
    .find(dostepny => dostepny >= liczba);
  return najblizszyWiekszy ? String(najblizszyWiekszy) : { nieznany: rozmiar };
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

async function listujFoldery(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (err) {
    return null; // folder nie istnieje / brak dostepu
  }
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

// Adres z Excela byl dotad czytany tylko do komunikatow/logow - dopasowanie
// folderu dzialo sie WYLACZNIE po numerze "LP gminy". Dwie rozne inwestycje
// moga miec folder zaczynajacy sie od tego samego numeru (inna gmina/rok),
// wiec samo dopasowanie po numerze nie gwarantuje, ze trafiony folder
// rzeczywiscie nalezy do adresu z wiersza - trzeba to potwierdzic tokenami
// adresu (audyt zewnetrzny). Wzorowane na apps/drukarka-projekty/src/folderMatch.js
// (addressTokens/normalize), z ta sama poprawka na "l" - nie dekomponuje sie
// pod NFKD tak jak pozostale polskie diakrytyki.
function normalizeAdresDoPorownania(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const POMIJANE_TOKENY_ADRESU = new Set(['ul', 'nr']);

function tokenyAdresu(adres) {
  return normalizeAdresDoPorownania(adres)
    .split(' ')
    .filter(t => t && (t.length > 1 || /^\d$/.test(t)) && !POMIJANE_TOKENY_ADRESU.has(t));
}

// Prog jak w folderMatch.js's filenameMatchesOwnAddress: przy 1 tokenie wymagany
// jest on caly, przy 2 wystarczy jeden (folder czesto nie ma numeru domu w
// nazwie), przy wiekszej liczbie - min. 60%. Tokeny sa juz czysto alfanumeryczne
// (po normalizacji), wiec bezpieczne do wstawienia wprost w RegExp.
function adresPasujeDoFolderu(adres, folderNazwa) {
  const tokeny = tokenyAdresu(adres);
  if (!tokeny.length) return true; // brak adresu w Excelu - nie ma z czym porownac, przepuszczamy jak dotychczas
  const folderNorm = normalizeAdresDoPorownania(folderNazwa);
  const trafione = tokeny.filter(t => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(folderNorm)).length;
  const wymagane = tokeny.length <= 1 ? tokeny.length : (tokeny.length === 2 ? 1 : Math.max(2, Math.ceil(tokeny.length * 0.6)));
  return trafione >= wymagane;
}

async function istniejacePlikiWFolderze(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return new Set(entries.filter(e => e.isFile()).map(e => e.name.toLowerCase()));
  } catch {
    return new Set();
  }
}

async function przetworzArkusz({ sheetName, rows, rootPath, dryRun }) {
  const gmina = gminaZNazwyArkusza(sheetName);
  const wyniki = [];
  if (!gmina) return wyniki; // arkusz nie dotyczy solarow (np. Pompy, Kotly, adresy)

  const kartyDir = path.join(rootPath, 'karty');
  const projektyBazowyDir = path.join(rootPath, 'Projekty');
  const projektyDir = path.join(projektyBazowyDir, gmina);
  // Druga warstwa ochrony obok sanityzacji w gminaZNazwyArkusza - nawet gdyby
  // sanityzacja kiedys zawiodla, nie pozwalamy wyjsc poza rootPath/Projekty.
  if (path.relative(projektyBazowyDir, projektyDir).startsWith('..')) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": niepoprawna nazwa gminy z arkusza - pominieto.` });
    return wyniki;
  }

  const kartyIstnieja = fs.existsSync(kartyDir);
  const nazwyFolderowKlientow = await listujFoldery(projektyDir);

  if (!kartyIstnieja) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono folderu ze zrodlowymi kartami: ${kartyDir}` });
    return wyniki;
  }
  if (nazwyFolderowKlientow === null) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono folderu projektow dla gminy: ${projektyDir}` });
    return wyniki;
  }

  const { mapa: mapaFolderow, duplikaty } = zbudujMapeFolderow(nazwyFolderowKlientow);

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

  // FAZA 1 (szybka, synchroniczna): walidacja kazdego wiersza bez zadnych
  // odwolan do dysku. Wiersze, ktore odpadaja tutaj, trafiaja do wynikiByIdx
  // od razu; wiersze, ktore przeszly walidacje, licza sie do dalszej,
  // rownoleglej fazy (potrzebuja listowania/kopiowania plikow).
  const wynikiByIdx = new Array(rows.length).fill(null);
  const zadania = [];

  for (let i = 1; i < rows.length; i += 1) {
    const wiersz = i + 1; // numer wiersza w Excelu (1 = naglowek)
    const row = rows[i];
    if (!row || row.every(v => v === null || v === undefined || v === '')) continue;

    const id = parseIdFolderu(row[colLpGmina]);
    const rezygnacja = colRezygnacja !== -1 ? normalizujTekst(row[colRezygnacja]) : '';
    const adres = normalizujTekst(row[colAdres]);
    const uid = normalizujTekst(row[colUid]);
    const opisAdresu = adres || '(brak adresu)';

    // Rezygnacja PRZED brakiem UID - ktos kto zrezygnowal bardzo czesto ma
    // tez puste pole UID (nikt nie wypelnia doboru dla anulowanego zlecenia),
    // wiec sprawdzenie w odwrotnej kolejnosci klasyfikowaloby te wiersze jako
    // "brak UID" zamiast "rezygnacja" - myllace, bo to nie jest zapomniany
    // UID tylko naturalna konsekwencja rezygnacji. Realny przyklad z
    // produkcji: kilka z 17 wierszy "brak UID" w jednym uruchomieniu to
    // faktycznie byly rezygnacje z pustym UID.
    if (isAffirmativeFlag(rezygnacja)) {
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid: uid || null, status: 'pominieto-rezygnacja', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: rezygnacja dla adresu "${opisAdresu}" - pominieto.` };
      continue;
    }

    if (!uid) {
      // NIE pomijamy cicho - moze to byc adres ktory faktycznie nie dotyczy
      // solarow (normalne), ale rownie dobrze ktos mogl zapomniec wpisac UID -
      // uzytkownik ma to zobaczyc w raporcie, nie musiec zgadywac.
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid: null, status: 'pominieto-brak-uid', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak wartosci UID dla adresu "${opisAdresu}" - pominieto.` };
      continue;
    }

    if (!id) {
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id: row[colLpGmina], adres, uid, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak poprawnego "LP gminy" dla adresu "${opisAdresu}" - nie mozna dopasowac folderu.` };
      continue;
    }

    if (duplikaty.has(id)) {
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: na dysku jest wiecej niz jeden folder zaczynajacy sie od "${id}" dla adresu "${opisAdresu}" - wymaga recznego sprawdzenia.` };
      continue;
    }

    const folderNazwa = mapaFolderow.get(id);
    if (!folderNazwa) {
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nie znaleziono na dysku folderu zaczynajacego sie od "${id} -" dla adresu "${opisAdresu}".` };
      continue;
    }

    // Sam numer LP nie wystarcza (patrz komentarz przy adresPasujeDoFolderu) -
    // potwierdzamy adresem PRZED faza kopiowania (zadania.push nizej), zeby zla
    // para adres/folder nigdy tam nie dotarla.
    if (!adresPasujeDoFolderu(adres, folderNazwa)) {
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: znaleziono folder "${folderNazwa}" dla numeru LP "${id}", ale jego nazwa nie zawiera adresu z Excela "${adres}" - mozliwy konflikt numeracji miedzy inwestycjami. Sprawdz recznie.` };
      continue;
    }

    const rozmiar = parseRozmiarZUid(uid);
    if (!rozmiar || typeof rozmiar === 'object') {
      const nieznany = rozmiar && rozmiar.nieznany ? rozmiar.nieznany : uid;
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nierozpoznany rozmiar zasobnika w UID ("${nieznany}") dla adresu "${opisAdresu}". Oczekiwano 250/300/400.` };
      continue;
    }

    zadania.push({ idx: i, wiersz, id, adres, uid, opisAdresu, folderNazwa, rozmiar });
  }

  // FAZA 2 (rownolegla, z ograniczeniem KK_CONCURRENCY): listowanie folderu
  // klienta i ewentualne kopiowanie - to jest czesc, ktora realnie czeka na
  // dysk sieciowy, wiec robimy wiele adresow naraz zamiast jednego po drugim.
  const semafor = createSemaphore(KK_CONCURRENCY);
  await Promise.all(zadania.map(zadanie => semafor.run(async () => {
    const { idx, wiersz, id, adres, uid, folderNazwa, rozmiar } = zadanie;
    const wymaganePliki = [...ZAWSZE_KARTY, nazwaZasobnika(rozmiar)];
    const folderKlienta = path.join(projektyDir, folderNazwa);
    const istniejace = await istniejacePlikiWFolderze(folderKlienta);

    const doSkopiowania = wymaganePliki.filter(nazwa => !istniejace.has(nazwa.toLowerCase()));

    if (doSkopiowania.length === 0) {
      wynikiByIdx[idx] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'pominieto-juz-sa', komunikat: 'Karty katalogowe juz sa w folderze klienta.' };
      return;
    }

    const skopiowane = [];
    const bledy = [];
    for (const nazwaPliku of doSkopiowania) {
      const zrodlo = path.join(kartyDir, nazwaPliku);
      const cel = path.join(folderKlienta, nazwaPliku);
      // fs.existsSync tutaj blokowaloby caly proces (jeden watek Node) na
      // czas odczytu z dysku - a to jest kod wewnatrz Promise.all po wielu
      // adresach naraz (FAZA 2 nizej), wiec przy wiekszej paczce i/lub
      // wolnym dysku sieciowym sumowalo sie to na tyle, ze health-check z
      // panelu glownego dostawal timeout i apka przez chwile wygladala jak
      // "uruchamianie sie", mimo ze dzialala.
      const zrodloIstnieje = await fsp.access(zrodlo).then(() => true).catch(() => false);
      if (!zrodloIstnieje) {
        bledy.push(`Brak pliku zrodlowego: ${nazwaPliku}`);
        continue;
      }
      if (!dryRun) {
        try {
          await fsp.copyFile(zrodlo, cel);
          skopiowane.push(nazwaPliku);
        } catch (err) {
          bledy.push(`Nie udalo sie skopiowac ${nazwaPliku}: ${err.message}`);
        }
      } else {
        skopiowane.push(nazwaPliku + ' (podglad)');
      }
    }

    if (bledy.length && skopiowane.length === 0) {
      wynikiByIdx[idx] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: ${bledy.join('; ')}` };
    } else if (bledy.length) {
      wynikiByIdx[idx] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'czesciowo', komunikat: `Skopiowano: ${skopiowane.join(', ')}. Bledy: ${bledy.join('; ')}` };
    } else {
      wynikiByIdx[idx] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: dryRun ? 'do-skopiowania' : 'skopiowano', komunikat: `Pliki: ${skopiowane.join(', ')}` };
    }
  })));

  // Kolejnosc wierszy z arkusza zachowana (wynikiByIdx jest indeksowane
  // pozycja w arkuszu), mimo ze FAZA 2 konczyla zadania w nieprzewidywalnej
  // kolejnosci.
  for (const wynik of wynikiByIdx) {
    if (wynik) wyniki.push(wynik);
  }

  return wyniki;
}

// --- Endpointy ---

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'karty-katalogowe' }));

app.post('/api/run', upload.single('excel'), async (req, res) => {
  const jobId = crypto.randomUUID();
  try {
    if (!req.file) throw new Error('Dodaj plik Excel (.xlsx).');
    const rootPath = normalizujTekst(req.body.rootPath);
    if (!rootPath) throw new Error('Podaj sciezke do glownego folderu (np. ...\\Kolektory).');
    if (!fs.existsSync(rootPath)) throw new Error(`Podana sciezka nie istnieje: ${rootPath}`);
    const dryRun = String(req.body.dryRun || '').toLowerCase() === 'true';

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
      const wynikiArkusza = await przetworzArkusz({ sheetName, rows, rootPath, dryRun });
      wynikiWszystkie.push(...wynikiArkusza);
    }

    const podsumowanie = wynikiWszystkie.reduce((acc, w) => {
      acc[w.status] = (acc[w.status] || 0) + 1;
      return acc;
    }, {});

    const logPath = path.join(LOGS_DIR, `dobor-kart-${jobId}.json`);
    writeJsonFileNoBom(logPath, { jobId, createdAt: new Date().toISOString(), rootPath, dryRun, podsumowanie, wyniki: wynikiWszystkie });

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

// require.main === module: uruchomienie serwera TYLKO gdy plik jest
// startowany bezposrednio (node server.js), nie gdy jest wymagany przez testy
// (test/*.test.js wymaga przetworzArkusz/adresPasujeDoFolderu ponizej i nie
// powinien przy tym bindowac prawdziwego portu).
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => console.log(`Karty katalogowe: http://${HOST}:${PORT}`));
  applyHttpTimeouts(server, 'KK');
}

module.exports = { przetworzArkusz, adresPasujeDoFolderu };
