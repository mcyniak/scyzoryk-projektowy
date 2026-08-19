const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const readXlsxFile = require('read-excel-file/node');
const AdmZip = require('adm-zip');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { setupProcessDiagnostics, applyHttpTimeouts, readJsonFileNoBom, writeJsonFileNoBom, scheduleCleanup, createSemaphore } = require('../../lib/hardening');
const { getAppDataDir } = require('../../lib/appPaths');
const { isAffirmativeFlag } = require('../../lib/businessFlags');
const { browseFolder } = require('../../lib/folderBrowse');

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
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://scyzoryk.localhost:3000 http://127.0.0.1:3000; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
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
  // Panel glowny odpytuje /api/health KAZDEJ apki co 10s (patrz public/inline-1.js
  // w korzeniu) - to samo ~90 zadan/15min, wiecej niz limit 60 - bez tego
  // wyjatku ta apka permanentnie sama sobie generowala falszywy status "nie
  // dziala" (429) w panelu, mimo ze proces byl cały czas zdrowy. Ten sam
  // wzorzec juz dawno dziala w apps/drukarka i apps/drukarka-projekty.
  skip: (req) => req.method === 'GET',
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

// Cztery niezalezne pola pliku w jednym requescie: "excel" (zawsze wymagany),
// oraz opcjonalne "audytyZip"/"schematyZip"/"dokumentySeryjneZip" - alternatywa
// dla wpisania sciezki do folderu na dysku (audytyPath/schematyPath/
// dokumentySeryjnePath), bo audyty/schematy czesto leza na dysku Google
// innego dzialu, do ktorego nie ma stalej, zmapowanej sciezki (patrz
// komentarz przy rozpakujZipDoTemp nizej).
const MAX_ZIP_MB = Number(process.env.KK_MAX_ZIP_MB || 500);
const uploadWieloplikowy = multer({
  storage,
  // 4 mozliwe pola naraz: excel + audytyZip + schematyZip + dokumentySeryjneZip
  // (limit files musi nadazac za liczba pol w .fields() ponizej - bylo 3,
  // zanim dolozono dokumentySeryjneZip, co realnie wywalalo "too many files"
  // przy wgrywaniu wszystkich trzech dodatkow naraz).
  limits: { fileSize: Math.max(MAX_FILE_MB, MAX_ZIP_MB) * 1024 * 1024, files: 4 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeOriginalName(file.originalname || '')).toLowerCase();
    if (file.fieldname === 'excel') {
      if (ext === '.xlsx') return cb(null, true);
      return cb(new Error('Wybierz plik Excel .xlsx.'));
    }
    if (file.fieldname === 'audytyZip' || file.fieldname === 'schematyZip' || file.fieldname === 'dokumentySeryjneZip') {
      if (ext === '.zip') return cb(null, true);
      return cb(new Error('Audyty/schematy/dokumenty seryjne przyjmowane sa wylacznie jako plik .zip.'));
    }
    return cb(new Error('Nieoczekiwane pole pliku.'));
  }
});

// --- Logika doboru kart katalogowych ---

// Karty, ktore ida ZAWSZE (nazwy plikow zrodlowych w folderze "karty" na dysku) -
// starsza, PLASKA konwencja (wszystkie rozmiary w jednym folderze, rozmiar
// zakodowany w nazwie pliku zasobnika). Zweryfikowana realnie dla Paradyz
// Żarnów/Zagórów.
const ZAWSZE_KARTY = ['Grupa pompowa.pdf', 'Kolektor KSG 21GT.pdf'];
// Zasobnik dobierany wg ostatniej liczby w UID (np. "2/250" -> 250, "2x4/400" -> 400)
const ROZMIARY_ZASOBNIKA = ['250', '300', '400'];
function nazwaZasobnika(rozmiar) { return `Zasobnik SGW(S)B ${rozmiar}.pdf`; }

// Nowsza konwencja (zweryfikowana realnie - Kamiensk): karty NIE leza plasko
// w jednym folderze - kazdy rozmiar zestawu ma WLASNY podfolder pod
// kartyDir (np. "2.300", "3.400"), a pliki w srodku sa recznie numerowane
// przez osobe wgrywajaca ("1. Karta katalogowa kolektora słonecznego.pdf",
// "2. Zasobnik A klasa 300.pdf", "3. Grupa pompowa.pdf") zamiast miec stale
// nazwy - TRESC nazwy po numerze bywa rozna nawet MIEDZY rozmiarami tej
// samej inwestycji (np. "2. Zasobnik A klasa 300.pdf" vs "2. Zasobnik 400 A
// klasa.pdf" - inna kolejnosc slow, nie tylko inna liczba), wiec dopasowanie
// dziala po SAMYM NUMERZE na poczatku nazwy, nigdy po pelnej tresci.
//
// Sprawdzana PRZED plaska konwencja (patrz przetworzArkusz FAZA 2) - jesli
// podfolder rozmiaru istnieje, ma pierwszenstwo; jesli nie istnieje, kod
// spada do ZAWSZE_KARTY/nazwaZasobnika jak dotychczas - stara, juz
// zweryfikowana sciezka dla innych inwestycji zostaje bez zmian.
async function znajdzPodfolderRozmiaru(kartyDir, rozmiar) {
  const nazwyFolderow = await listujFoldery(kartyDir);
  if (!nazwyFolderow) return null;
  const trafiony = nazwyFolderow.find(nazwa => nazwa.includes(rozmiar));
  return trafiony ? path.join(kartyDir, trafiony) : null;
}

async function listujKartyNumerowane(folder) {
  let wpisy;
  try { wpisy = await fsp.readdir(folder, { withFileTypes: true }); } catch { return null; }
  return wpisy
    .filter(w => w.isFile() && /^\d+\.\s/.test(w.name))
    .map(w => w.name)
    .sort((a, b) => a.localeCompare(b, 'pl', { numeric: true }));
}

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
  // 'LP gminy' bywa zapisane w Excelu jako float (78.0) - to jest bezpieczne
  // do sprowadzenia do zwyklego inta jako string. Audyt rozdz. 16, P1: NIE
  // WOLNO tego robic przez Math.trunc() dla KAZDEJ wartosci - "78.9" tez
  // przechodzilo przez Math.trunc do "78", cicho dopasowujac wiersz do
  // NIEWLASCIWEGO folderu (numer 78, nie prawdziwa - nieistniejaca - wartosc
  // 78.9). Number.isInteger tutaj poprawnie odroznia "78.0" (=== 78,
  // integer) od prawdziwie ulamkowego "78.9" (nie jest integer) - drugie
  // jest teraz twardym bledem (null), nie cichym zgadywaniem.
  // Uwaga: Number(null) === 0, wiec puste/brakujace pole trzeba odrzucic ZANIM przejdzie przez Number().
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) return null;
  return String(num);
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

// Rozpoznaje arkusz solarow po nazwie zakladki - "Solary <gmina>" (starsza
// konwencja, jeden rootPath obsluguje wiele gmin naraz, karty trafiaja pod
// Projekty/<gmina>/) albo samo "Solary" (nowsza konwencja, jedna inwestycja =
// jeden rootPath, bez warstwy gminy - real przypadek: Kamiensk, gdzie
// zakladka to dokladnie "Solary" i przez to stara wersja tej funkcji zwracala
// null dla KAZDEGO arkusza, a caly plik pokazywal 0 dopasowan bez zadnego
// bledu). Zwraca { gmina: string } (gmina moze byc pustym stringiem dla
// nowszej konwencji) albo null, gdy arkusz w ogole nie dotyczy solarow
// (Pompy, Kotly, adresy, obreby itp.).
function rozpoznajArkuszSolarow(sheetName) {
  const name = String(sheetName || '').trim();
  if (/^solary$/i.test(name)) return { gmina: '' };
  const match = name.match(/^solary\s+(.+)$/i);
  if (!match) return null;
  // Nazwa arkusza XLSX jest danymi od klienta i trafia bezposrednio do
  // sciezki na dysku (patrz przetworzArkusz -> projektyDir). Bez sanityzacji
  // arkusz nazwany np. "Solary ../../../Windows" wyprowadzalby zapis poza
  // folder Projekty. sanitize-filename usuwa / \ oraz zamienia samo ".."
  // na pusty string, wiec taki arkusz zostanie po prostu potraktowany jak
  // "nie dotyczy solarow" zamiast wyjsc poza dozwolony katalog.
  const gmina = safeName(match[1].trim(), '');
  return gmina ? { gmina } : null;
}

// Zrodlowy folder z kartami solarow - starsza konwencja nazywa go "karty",
// nowsza "wzór" (ten sam folder co uzywany przez dokumenty seryjne dla
// innych typow dokumentow - real przypadek, uzytkownik potwierdzil ze obie
// nazwy wystepuja w praktyce). Sprawdzamy "karty" jako pierwsze (stara,
// nadal najczestsza konwencja), potem "wzór".
function znajdzFolderZrodlowySolarow(rootPath) {
  const karty = path.join(rootPath, 'karty');
  if (fs.existsSync(karty)) return karty;
  const wzor = path.join(rootPath, 'wzór');
  if (fs.existsSync(wzor)) return wzor;
  return karty; // zaden nie istnieje - komunikat bledu nizej i tak pokaze ta sciezke
}

// Pompy powietrzne Varmero maja model zapisany w kolumnie "Model pompy" jako
// "VPM<cyfry>" (wartosc WYLICZONA formula w arkuszu - read-excel-file czyta
// gotowy wynik, nie sama formule, wiec to dziala bez dodatkowej obslugi).
// Inne wartosci (np. "Basic 270l" - pompa CWU, nie powietrzna) albo puste
// komorki (brak dobranej pompy dla tego adresu) sa pomijane CICHO, bez
// bledu - to normalne, nie kazdy wiersz/inwestycja ma pompy Varmero (np.
// inwestycje na myEcodan zamiast Varmero po prostu nigdy nie maja pasujacej
// wartosci w tej kolumnie).
function parseModelPompy(value) {
  const match = normalizujTekst(value).match(/^VPM\d+/i);
  return match ? match[0].toUpperCase() : null;
}

// Rozpoznaje arkusz pomp ciepla po nazwie zakladki (np. "Pompy ciepła") - ten
// sam wzorzec (dopasowanie po rdzeniu "pomp") co apps/formularze-varmero/src/excel.js#chooseSheet.
function rozpoznajArkuszPomp(sheetName) {
  return /pomp/i.test(String(sheetName || ''));
}

// Wyciaga token "VPM<cyfry>" z nazwy folderu wzoru, ignorujac spacje i
// wielkosc liter - realne foldery pisza to jako "VARMERO VPM 9008" (ze
// spacja miedzy VPM a numerem), nie "VPM9008" jak w znormalizowanym modelu
// z Excela (parseModelPompy), wiec proste porownanie tekstu nigdy by nie
// trafilo. Zwraca null, jesli w nazwie w ogole nie ma wzorca VPM<cyfry>.
function wyciagnijTokenModeluPompy(nazwaFolderu) {
  const match = String(nazwaFolderu || '').toUpperCase().match(/VPM\s*(\d+)/);
  return match ? `VPM${match[1]}` : null;
}

// Szuka WSZYSTKICH podfolderow w zrodlowym folderze wzorow pomp, ktorych
// token modelu (patrz wyzej) pasuje do modelu z Excela - moze byc WIECEJ NIZ
// JEDEN, bo ten sam model wystepuje czasem w kilku wariantach z dodatkowym
// zrodlem ciepla ("VARMERO VPM 9008", "VARMERO VPM 9008 + Kocioł gazowy",
// "... + Kocioł stałopalny (UO)/(UZ)" - zweryfikowane realnie, Kamiensk).
// Wywolujacy MUSI sam zdecydowac, co zrobic z wiecej niz jednym trafieniem -
// ta funkcja swiadomie nigdy nie zgaduje, ktory wariant wybrac.
async function znajdzFolderyModeluPompy(wzorDir, model) {
  const nazwyFolderow = await listujFoldery(wzorDir);
  if (!nazwyFolderow) return null;
  return nazwyFolderow.filter(nazwa => wyciagnijTokenModeluPompy(nazwa) === model);
}

// Ustala sciezki wzoru/projektow dla pomp - patrz komentarz przy wywolaniu w
// przetworzArkuszPomp. Zwraca "PC powietrzne" jako domyslny (do komunikatu
// bledu), jesli ZADEN wariant nie istnieje na dysku.
function znajdzFolderyPomp(rootPath) {
  const warianty = ['PC powietrzne', 'PC'];
  for (const folder of warianty) {
    const wzorDir = path.join(rootPath, folder, 'wzór');
    if (fs.existsSync(wzorDir)) return { wzorDir, projektyDir: path.join(rootPath, folder, 'Projekty') };
  }
  return { wzorDir: path.join(rootPath, warianty[0], 'wzór'), projektyDir: path.join(rootPath, warianty[0], 'Projekty') };
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
//
// Audyt rozdz. 16, P0/P1, dwie poprawki:
//   1. Pusty adres w Excelu juz NIE przepuszcza dopasowania - zwraca false.
//      Wczesniej "brak adresu" bylo traktowane jak "nie mam z czym porownac,
//      wiec ufam samemu LP" - to pozwalalo skopiowac karty do NIEWLASCIWEGO
//      klienta, gdy dwie inwestycje maja folder zaczynajacy sie od tego
//      samego numeru (patrz test "konflikt numeracji"), a wiersz akurat nie
//      mial wypelnionego adresu. przetworzArkusz zglasza to teraz jako
//      OSOBNY, wczesniejszy blad ("brak adresu") z czytelniejszym
//      komunikatem niz to "false" tutaj - to zostaje jako bezpieczny domysly
//      wynik funkcji, gdyby byla kiedys wywolana skads indziej.
//   2. Przy DOKLADNIE 2 tokenach adresu (typowo "ulica" + "numer") samo
//      trafienie NUMERU juz nie wystarcza - krotkie numery (1-99) latwo
//      przypadkiem pasuja do zupelnie innego adresu. Wymagane jest trafienie
//      przynajmniej jednego tokenu TEKSTOWEGO (nazwy ulicy/miejscowosci) -
//      to zachowuje tolerancje na foldery bez numeru domu w nazwie (real
//      przypadek z produkcji), ale nie pozwala samemu numerowi "przepchnac"
//      dopasowania.
function adresPasujeDoFolderu(adres, folderNazwa) {
  const tokeny = tokenyAdresu(adres);
  if (!tokeny.length) return false;

  const folderNorm = normalizeAdresDoPorownania(folderNazwa);
  const trafioneTokeny = tokeny.filter(t => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(folderNorm));
  const tekstoweWAdresie = tokeny.filter(t => !/^\d+$/.test(t));
  const trafioneTekstowe = trafioneTokeny.filter(t => !/^\d+$/.test(t));

  // Sam numer (bez zadnego trafionego tokenu tekstowego) nigdy nie wystarcza,
  // o ile adres w ogole ma jakis token tekstowy do porownania.
  if (tekstoweWAdresie.length > 0 && trafioneTekstowe.length === 0) return false;

  const wymagane = tokeny.length <= 1 ? tokeny.length : (tokeny.length === 2 ? 1 : Math.max(2, Math.ceil(tokeny.length * 0.6)));
  return trafioneTokeny.length >= wymagane;
}

async function istniejacePlikiWFolderze(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return new Set(entries.filter(e => e.isFile()).map(e => e.name.toLowerCase()));
  } catch {
    return new Set();
  }
}

// --- Audyty (PV) i schematy elektryczne wg mocy - dolaczane do folderu
// klienta OBOK kart katalogowych (wylacznie arkusz Solary/PV - schematy sa
// dobierane po mocy zestawu fotowoltaicznego). W odroznieniu od kart
// katalogowych (komplet-albo-nic, patrz FAZA A/B w przetworzArkusz) brak
// audytu/schematu dla adresu NIGDY nie blokuje skopiowania kart - to tylko
// ostrzezenie w wyniku wiersza (decyzja wlasciciela, 2026-08-19: audyty
// czesto nie sa jeszcze gotowe dla wszystkich adresow w momencie doboru kart).

// Zrodlo audytow/schematow bywa zipem (czesty przypadek: pliki leza na
// dysku Google INNEGO dzialu, do ktorego uzytkownik ma dostep tylko przez
// pobranie/wgranie zipa, bez stalej, zmapowanej sciezki) albo zwyklym
// folderem na dysku (jak reszta tego narzedzia) - oba warianty rownolegle,
// wybor per uruchomienie. Zip jest rozpakowywany do wlasnego podfolderu w
// UPLOAD_DIR (juz objetego scheduleCleanup) i jawnie usuwany w finally w
// /api/run - nigdy nie zostaje jako trwaly artefakt.
async function rozpakujZipDoTemp(zipPath, jobId, etykieta) {
  const destDir = path.join(UPLOAD_DIR, `${jobId}-${etykieta}`);
  await fsp.mkdir(destDir, { recursive: true });
  try {
    new AdmZip(zipPath).extractAllTo(destDir, true);
  } catch (err) {
    throw new Error(`Nie udalo sie rozpakowac zipa (${etykieta}): ${err.message}`);
  }
  return destDir;
}

// Rekurencyjne zebranie wszystkich PDF-ow (audyty/schematy nie maja
// gwarantowanej, jednolitej glebokosci - zip ma zwykle jeden poziom
// nadrzednego folderu, jak "PV/plik.pdf", wskazana sciezka na dysku moze
// wskazywac albo na sam lisc, albo na folder nadrzedny). Ograniczenie
// glebokosci (podobnie do reszty tego narzedzia) chroni przed przypadkowym
// przeskanowaniem calego dysku, gdyby ktos wskazal zbyt ogolna sciezke.
const KK_MAX_GLEBOKOSC_SKANU = 4;
async function zbierzPlikiPdf(rootDir, glebokosc = 0) {
  if (glebokosc > KK_MAX_GLEBOKOSC_SKANU) return [];
  let wpisy;
  try { wpisy = await fsp.readdir(rootDir, { withFileTypes: true }); } catch { return []; }
  const wyniki = [];
  for (const wpis of wpisy) {
    const pelnaSciezka = path.join(rootDir, wpis.name);
    if (wpis.isDirectory()) {
      wyniki.push(...await zbierzPlikiPdf(pelnaSciezka, glebokosc + 1));
    } else if (wpis.isFile() && path.extname(wpis.name).toLowerCase() === '.pdf') {
      wyniki.push({ nazwa: wpis.name, sciezka: pelnaSciezka, nazwaBezRozszerzenia: wpis.name.slice(0, -4) });
    }
  }
  return wyniki;
}

// Dopasowanie PLIKU DO ADRESU ponownie uzywa adresPasujeDoFolderu (ten sam
// tokenowy, tolerancyjny na "ul."/wielkosc liter/diakrytyki mechanizm co przy
// dopasowaniu folderu klienta) - nazwa pliku (bez ".pdf") jest podstawiana w
// miejsce "nazwy folderu". Uzywane DWUKROTNIE: dla audytow PV (nazwa pliku =
// adres + "_PV") i dla dokumentow seryjnych (nazwa pliku = <prefiks><adres>,
// patrz apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1#Join-PrefixAndAddress)
// - oba maja identyczna konwencje "nazwa pliku zawiera adres", wiec ten sam
// mechanizm dopasowania dziala dla obu bez zmian. Zwraca liste trafien -
// pusta (brak), jednoelementowa (jednoznaczne) albo wieloelementowa
// (niejednoznaczne - wywolujacy NIGDY nie zgaduje, ktory plik jest wlasciwy).
function znajdzPlikiPoAdresie(adres, pliki) {
  return pliki.filter(p => adresPasujeDoFolderu(adres, p.nazwaBezRozszerzenia));
}

// "Trójfazowe"/"Jednofazowe" (realna wartosc z kolumny "Instalacja 3
// fazowa") - normalizeAdresDoPorownania juz usuwa polskie znaki, wiec
// wystarczy szukac rdzenia "troj"/"3" kontra "jedno"/"1". Nieznana/pusta
// wartosc zwraca null (nie zgadujemy fazy).
function rozpoznajFaze(value) {
  const norm = normalizeAdresDoPorownania(value);
  if (!norm) return null;
  if (/(^|[^a-z])(troj|3)/.test(norm)) return '3F';
  if (/(^|[^a-z])(jedno|1)/.test(norm)) return '1F';
  return null;
}

// Nazwy plikow schematow: "2,85.pdf" (bez ujednoznacznienia fazy - tylko
// jeden wariant istnieje dla tej mocy) albo "2,85 3F.pdf"/"2,85 1F.pdf" (dwa
// warianty tej samej mocy, rozne dla instalacji 1- i 3-fazowej) -
// zweryfikowane na prawdziwym zipie SCHEMAT (2026-08-19). Pliki
// niepasujace do wzorca (np. "plot.log", eksportowany log narzedzia, ktore
// wygenerowalo schematy) sa cicho pomijane - to nie sa schematy.
function sparsujPlikSchematu(nazwaBezRozszerzenia) {
  const match = nazwaBezRozszerzenia.trim().match(/^(\d+(?:,\d+)?)(?:\s+(1F|3F))?$/i);
  if (!match) return null;
  const moc = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(moc)) return null;
  return { moc, faza: match[2] ? match[2].toUpperCase() : null };
}

function zbudujIndeksSchematow(pliki) {
  const indeks = [];
  for (const plik of pliki) {
    const sparsowany = sparsujPlikSchematu(plik.nazwaBezRozszerzenia);
    if (sparsowany) indeks.push({ ...plik, ...sparsowany });
  }
  return indeks;
}

// Dopasowanie po mocy z tolerancja na szum zmiennoprzecinkowy (obie wartosci
// - w Excelu i w nazwie pliku schematu - pochodza z tego samego wyliczenia
// liczba_modulow x moc_modulu, wiec powinny byc identyczne, nie tylko
// "blisko"). Jesli dla danej mocy istnieje wiecej niz jeden plik (warianty
// fazowe), rozstrzyga kolumna fazy z Excela - gdy faza nieznana/kolumny
// brak, pozostaje niejednoznaczne (nigdy nie zgadujemy).
const TOLERANCJA_MOCY_KW = 0.001;
function znajdzSchemat(moc, faza, indeksSchematow) {
  if (!Number.isFinite(moc)) return [];
  const trafienia = indeksSchematow.filter(s => Math.abs(s.moc - moc) < TOLERANCJA_MOCY_KW);
  if (trafienia.length <= 1) return trafienia;
  if (!faza) return trafienia; // niejednoznaczne, faza nieznana - nie zgadujemy
  const poFazie = trafienia.filter(s => s.faza === faza);
  return poFazie.length ? poFazie : trafienia;
}

// Wspolna logika kopiowania JEDNEGO dodatku (audyt/dokument seryjny/schemat)
// po tym, jak wywolujacy juz ustalil liste trafien (0/1/wiecej). W
// przeciwienstwie do kart katalogowych (komplet-albo-nic) kazdy dodatek jest
// NIEZALEZNY od pozostalych i od kart - brak/niejednoznacznosc jednego
// dodatku nigdy nie wplywa na inne.
async function dopasujISkopiujDodatek({ trafienia, folderKlienta, istniejace, dryRun }) {
  if (trafienia.length === 0) return { status: 'brak' };
  if (trafienia.length > 1) return { status: 'wieloznaczne', kandydaci: trafienia.map(p => p.nazwa) };
  const zrodlo = trafienia[0];
  if (istniejace.has(zrodlo.nazwa.toLowerCase())) return { status: 'pominieto-juz-sa', plik: zrodlo.nazwa };
  if (dryRun) return { status: 'do-skopiowania', plik: zrodlo.nazwa };
  try {
    await fsp.copyFile(zrodlo.sciezka, path.join(folderKlienta, zrodlo.nazwa), fs.constants.COPYFILE_EXCL);
    return { status: 'skopiowano', plik: zrodlo.nazwa };
  } catch (err) {
    return { status: 'blad', plik: zrodlo.nazwa, komunikat: err.message };
  }
}

// audytyPliki/dokumentySeryjnePliki/schematyIndeks: null = zrodlo nie zostalo
// podane dla tego uruchomienia (dodatek w ogole nie pojawia sie w wyniku
// wiersza); pusta tablica = zrodlo podane, ale nic sie w nim nie znalazlo
// (kazdy wiersz dostanie ostrzezenie 'brak'). Patrz komentarz przy
// znajdzPlikiPoAdresie/znajdzSchemat.
async function przetworzArkusz({ sheetName, rows, rootPath, dryRun, audytyPliki = null, dokumentySeryjnePliki = null, schematyIndeks = null, pominKarty = false }) {
  const rozpoznany = rozpoznajArkuszSolarow(sheetName);
  const wyniki = [];
  if (!rozpoznany) return wyniki; // arkusz nie dotyczy solarow (np. Pompy, Kotly, adresy)
  const { gmina } = rozpoznany;

  // pominKarty: tryb "tylko dodatek" (dodaj-audyty/dodaj-schematy/dodaj-dokumenty-seryjne
  // jako osobna opcja, analogicznie do Solary/Pompy - patrz komentarz przy 'typ'
  // w /api/run) - karty katalogowe w ogole nie sa dobierane/kopiowane w tym
  // trybie, wiec folder zrodlowy kart nie musi nawet istniec.
  const kartyDir = pominKarty ? null : znajdzFolderZrodlowySolarow(rootPath);
  const projektyBazowyDir = path.join(rootPath, 'Projekty');
  // Nowsza konwencja (gmina === '', patrz rozpoznajArkuszSolarow) - jedna
  // inwestycja = jeden rootPath, foldery klientow leza wprost pod Projekty/,
  // bez posredniej warstwy gminy.
  const projektyDir = gmina ? path.join(projektyBazowyDir, gmina) : projektyBazowyDir;
  // Druga warstwa ochrony obok sanityzacji w rozpoznajArkuszSolarow - nawet
  // gdyby sanityzacja kiedys zawiodla, nie pozwalamy wyjsc poza rootPath/Projekty.
  if (gmina && path.relative(projektyBazowyDir, projektyDir).startsWith('..')) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": niepoprawna nazwa gminy z arkusza - pominieto.` });
    return wyniki;
  }

  const kartyIstnieja = pominKarty ? true : fs.existsSync(kartyDir);
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
  // Kolumna identyfikujaca zestaw bywa nazwana "UID" w starszych arkuszach,
  // ale w realnych danych (Kamiensk) to "Rodzaj zestawu" - obie nazwy
  // wskazuja na ta sama role (id/opis zestawu solarnego przypisanego do
  // adresu), wiec akceptujemy dowolna z nich.
  const colUid = findColumn(header, ['uid']) !== -1
    ? findColumn(header, ['uid'])
    : findColumn(header, ['rodzaj', 'zestaw']);
  // Tylko dla dopasowania schematow (opcjonalne, nigdy nie blokuje calego
  // arkusza jak kolumny wyzej) - "biuro" w tresci naglowka odroznia ta
  // kolumne od podobnie nazwanej "MOC ZESTAWU PO ROZBUDOWIE", ktora tez
  // zawiera "moc"+"zestaw" (real przypadek: obie kolumny wystepuja w tym
  // samym arkuszu operacyjnym).
  const colMoc = findColumn(header, ['moc', 'zestaw', 'biuro']);
  const colFazowa = findColumn(header, ['fazow']);

  const brakujaceKolumny = [];
  if (colLpGmina === -1) brakujaceKolumny.push('LP gminy');
  if (colAdres === -1) brakujaceKolumny.push('adres');
  if (colUid === -1) brakujaceKolumny.push('UID (lub "Rodzaj zestawu")');
  if (brakujaceKolumny.length) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono kolumn: ${brakujaceKolumny.join(', ')}. Sprawdz naglowki w pierwszym wierszu arkusza.` });
    return wyniki;
  }
  // colRezygnacja moze byc -1 (nie kazdy arkusz ma taka kolumne) - wtedy po
  // prostu nikt nigdy nie ma rezygnacji, co jest bezpiecznym zachowaniem.

  // Brak kolumny mocy NIE blokuje calego arkusza (karty katalogowe i tak sie
  // dobiora) - jeden, ogolny komunikat zamiast identycznego ostrzezenia przy
  // kazdym wierszu z osobna.
  if (schematyIndeks !== null && colMoc === -1) {
    wyniki.push({ gmina, sheet: sheetName, id: null, adres: null, uid: null, status: 'ostrzezenie', komunikat: `Arkusz "${sheetName}": podano zrodlo schematow, ale nie znaleziono kolumny mocy zestawu (oczekiwano naglowka zawierajacego "moc", "zestaw" i "biuro") - schematy nie zostana dolaczone dla zadnego wiersza.` });
  }

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

    // Audyt rozdz. 16, P0/P1: pusty adres nie moze polegac wylacznie na LP -
    // dwie rozne inwestycje moga miec folder zaczynajacy sie od tego samego
    // numeru (patrz komentarz przy adresPasujeDoFolderu). Osobny, wczesniejszy
    // blad z jasnym komunikatem zamiast myslacego "nie zawiera adresu"
    // (ktore sugerowaloby, ze adres byl podany, tylko sie nie zgadzal).
    if (!adres) {
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres: null, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak adresu w Excelu - nie mozna bezpiecznie potwierdzic, ze folder "${folderNazwa}" (dopasowany po samym numerze LP "${id}") faktycznie nalezy do tego wiersza. Uzupelnij adres i sprobuj ponownie.` };
      continue;
    }

    // Sam numer LP nie wystarcza (patrz komentarz przy adresPasujeDoFolderu) -
    // potwierdzamy adresem PRZED faza kopiowania (zadania.push nizej), zeby zla
    // para adres/folder nigdy tam nie dotarla.
    if (!adresPasujeDoFolderu(adres, folderNazwa)) {
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: znaleziono folder "${folderNazwa}" dla numeru LP "${id}", ale jego nazwa nie zawiera adresu z Excela "${adres}" - mozliwy konflikt numeracji miedzy inwestycjami. Sprawdz recznie.` };
      continue;
    }

    // Rozmiar zasobnika sluzy WYLACZNIE do doboru kart katalogowych - w
    // trybie pominKarty (dodaj-tylko-audyty/schematy/dokumenty-seryjne) nie
    // jest w ogole potrzebny, wiec nierozpoznany format UID nie blokuje
    // wiersza (audyty/dokumenty seryjne dopasowuja po adresie, schematy po
    // mocy/fazie - zaden z nich nie czyta rozmiaru zasobnika).
    const rozmiar = parseRozmiarZUid(uid);
    if (!pominKarty && (!rozmiar || typeof rozmiar === 'object')) {
      const nieznany = rozmiar && rozmiar.nieznany ? rozmiar.nieznany : uid;
      wynikiByIdx[i] = { gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nierozpoznany rozmiar zasobnika w UID ("${nieznany}") dla adresu "${opisAdresu}". Oczekiwano 250/300/400.` };
      continue;
    }

    // Wylacznie do dopasowania schematu - brak/nierozpoznana wartosc NIE jest
    // bledem tego wiersza (karty i tak sie skopiuja), po prostu schemat
    // dostanie status "brak" w dodatku.
    const mocRaw = colMoc !== -1 ? row[colMoc] : null;
    const moc = typeof mocRaw === 'number' ? mocRaw : parseFloat(String(mocRaw ?? '').replace(',', '.').trim());
    const faza = colFazowa !== -1 ? rozpoznajFaze(row[colFazowa]) : null;

    zadania.push({ idx: i, wiersz, id, adres, uid, opisAdresu, folderNazwa, rozmiar, moc, faza });
  }

  // FAZA 2 (rownolegla, z ograniczeniem KK_CONCURRENCY): listowanie folderu
  // klienta i ewentualne kopiowanie - to jest czesc, ktora realnie czeka na
  // dysk sieciowy, wiec robimy wiele adresow naraz zamiast jednego po drugim.
  const semafor = createSemaphore(KK_CONCURRENCY);
  await Promise.all(zadania.map(zadanie => semafor.run(async () => {
    const { idx, wiersz, id, adres, uid, folderNazwa, rozmiar, moc, faza } = zadanie;

    // folderKlienta/istniejace nie zaleza od rozmiaru/podfolderu kart, wiec
    // liczone raz na samej gorze - potrzebne zarowno kartom, jak i kazdemu z
    // dodatkow (audyt/dokument seryjny/schemat) nizej, niezaleznie od tego,
    // czy karty w ogole sie skopiuja.
    const folderKlienta = path.join(projektyDir, folderNazwa);
    const istniejace = await istniejacePlikiWFolderze(folderKlienta);

    // Dodatki (audyt/dokument seryjny/schemat) sa CALKOWICIE niezalezne od
    // wyniku kart katalogowych (patrz komentarz przy dopasujISkopiujDodatek) -
    // dolaczane do KAZDEGO wyniku wiersza ponizej, niezaleznie od tego, ktora
    // galaz kart (blad/juz-sa/do-skopiowania/skopiowano/blad-kopiowania)
    // zostanie wybrana.
    async function zDodatkami(wynikBazowy) {
      const dodatki = {};
      if (audytyPliki !== null) {
        dodatki.audyt = await dopasujISkopiujDodatek({ trafienia: znajdzPlikiPoAdresie(adres, audytyPliki), folderKlienta, istniejace, dryRun });
      }
      if (dokumentySeryjnePliki !== null) {
        dodatki.dokumentSeryjny = await dopasujISkopiujDodatek({ trafienia: znajdzPlikiPoAdresie(adres, dokumentySeryjnePliki), folderKlienta, istniejace, dryRun });
      }
      if (schematyIndeks !== null) {
        dodatki.schemat = colMoc === -1
          ? { status: 'brak' }
          : await dopasujISkopiujDodatek({ trafienia: znajdzSchemat(moc, faza, schematyIndeks), folderKlienta, istniejace, dryRun });
      }
      return { ...wynikBazowy, ...dodatki };
    }

    if (pominKarty) {
      // Tryb "tylko dodatek": status/komunikat calego wiersza to WPROST status
      // jedynego dodatku, ktory ten przebieg dostarcza (dokladnie jeden z
      // audytyPliki/schematyIndeks/dokumentySeryjnePliki jest non-null - patrz
      // /api/run) - brak osobnego stanu "karty" do zgloszenia w tym trybie.
      const zDod = await zDodatkami({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa });
      const jedynyDodatek = zDod.audyt || zDod.schemat || zDod.dokumentSeryjny || null;
      wynikiByIdx[idx] = {
        ...zDod,
        status: jedynyDodatek ? jedynyDodatek.status : 'blad',
        komunikat: jedynyDodatek
          ? (jedynyDodatek.plik || (jedynyDodatek.kandydaci ? `Kilka pasujacych plikow: ${jedynyDodatek.kandydaci.join(', ')}` : ''))
          : 'Nie podano zrodla dodatku.'
      };
      return;
    }

    // Nowsza konwencja (podfolder per rozmiar, patrz znajdzPodfolderRozmiaru
    // wyzej) ma pierwszenstwo przed starsza, plaska - jesli podfolder
    // rozmiaru istnieje, ZRODLEM jest ON (nie glowny kartyDir), a wymagane
    // pliki to WSZYSTKIE numerowane pliki w srodku, nie stala lista nazw.
    let zrodloDir = kartyDir;
    let wymaganePliki;
    const podfolderRozmiaru = await znajdzPodfolderRozmiaru(kartyDir, rozmiar);
    if (podfolderRozmiaru) {
      zrodloDir = podfolderRozmiaru;
      const numerowane = await listujKartyNumerowane(podfolderRozmiaru);
      if (!numerowane || !numerowane.length) {
        wynikiByIdx[idx] = await zDodatkami({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: podfolder rozmiaru "${path.basename(podfolderRozmiaru)}" nie ma zadnych numerowanych plikow karty (np. "1. ...pdf") dla adresu "${adres || '(brak adresu)'}".` });
        return;
      }
      wymaganePliki = numerowane;
    } else {
      wymaganePliki = [...ZAWSZE_KARTY, nazwaZasobnika(rozmiar)];
    }

    const doSkopiowania = wymaganePliki.filter(nazwa => !istniejace.has(nazwa.toLowerCase()));

    if (doSkopiowania.length === 0) {
      wynikiByIdx[idx] = await zDodatkami({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'pominieto-juz-sa', komunikat: 'Karty katalogowe juz sa w folderze klienta.' });
      return;
    }

    // Audyt rozdz. 16, P1 - FAZA A: sprawdz KOMPLET zrodel PRZED
    // skopiowaniem czegokolwiek. Wczesniej kazdy plik byl kopiowany
    // niezaleznie w tej samej petli - brakujace jedno zrodlo konczylo sie
    // statusem "czesciowo" z RESZTA kart juz lezaca w folderze klienta,
    // czyli niekompletnym, mylacym zestawem dokumentacji.
    // fs.existsSync tutaj blokowaloby caly proces (jeden watek Node) na
    // czas odczytu z dysku - a to jest kod wewnatrz Promise.all po wielu
    // adresach naraz (FAZA 2 nizej), wiec przy wiekszej paczce i/lub
    // wolnym dysku sieciowym sumowalo sie to na tyle, ze health-check z
    // panelu glownego dostawal timeout i apka przez chwile wygladala jak
    // "uruchamianie sie", mimo ze dzialala.
    const brakujaceZrodla = [];
    for (const nazwaPliku of doSkopiowania) {
      const istnieje = await fsp.access(path.join(zrodloDir, nazwaPliku)).then(() => true).catch(() => false);
      if (!istnieje) brakujaceZrodla.push(nazwaPliku);
    }
    if (brakujaceZrodla.length) {
      wynikiByIdx[idx] = await zDodatkami({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak plikow zrodlowych: ${brakujaceZrodla.join(', ')} - nie skopiowano ZADNEJ karty dla tego adresu (komplet albo nic).` });
      return;
    }

    if (dryRun) {
      wynikiByIdx[idx] = await zDodatkami({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'do-skopiowania', komunikat: `Pliki: ${doSkopiowania.map(n => n + ' (podglad)').join(', ')}` });
      return;
    }

    // FAZA B: kopiuj caly komplet. COPYFILE_EXCL chroni przed CICHYM
    // nadpisaniem pliku, ktory pojawil sie w folderze klienta MIEDZY
    // sprawdzeniem (istniejacePlikiWFolderze wyzej) a kopiowaniem - bez
    // tego flaga druga osoba/inny przebieg tego samego narzedzia moglyby
    // nadpisac sobie nawzajem karty w tej samej krotkiej chwili. Jesli
    // KTOKOLWIEK plik zawiedzie, cofamy (usuwamy) to, co juz zdazylo sie
    // skopiowac w TEJ probie - nigdy nie zostawiamy czesciowego kompletu.
    const skopiowaneWTejProbie = [];
    try {
      for (const nazwaPliku of doSkopiowania) {
        await fsp.copyFile(path.join(zrodloDir, nazwaPliku), path.join(folderKlienta, nazwaPliku), fs.constants.COPYFILE_EXCL);
        skopiowaneWTejProbie.push(nazwaPliku);
      }
      wynikiByIdx[idx] = await zDodatkami({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'skopiowano', komunikat: `Pliki: ${doSkopiowania.join(', ')}` });
    } catch (err) {
      for (const nazwaPliku of skopiowaneWTejProbie) {
        await fsp.unlink(path.join(folderKlienta, nazwaPliku)).catch(() => {});
      }
      wynikiByIdx[idx] = await zDodatkami({ gmina, sheet: sheetName, wiersz, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nie udalo sie skopiowac kompletu kart (${err.message}) - zaden plik NIE zostal dodany do folderu klienta (komplet albo nic).` });
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

// Analogiczne do przetworzArkusz, ale dla pomp powietrznych Varmero - inny
// arkusz ("Pompy ciepła"), inna kolumna rozpoznawcza ("Model pompy" zamiast
// UID), inny uklad folderow na dysku (PC powietrzne/wzór + PC powietrzne/Projekty
// zamiast karty + Projekty/<gmina>), i tylko JEDEN plik do skopiowania
// ("Karty katalogowe.pdf") zamiast zestawu zaleznego od rozmiaru zasobnika.
// Dopasowanie folderu klienta (LP + potwierdzenie adresem) jest identyczne -
// ta sama zbudujMapeFolderow/adresPasujeDoFolderu co dla solarow.
async function przetworzArkuszPomp({ sheetName, rows, rootPath, dryRun }) {
  const wyniki = [];
  if (!rozpoznajArkuszPomp(sheetName)) return wyniki; // arkusz nie dotyczy pomp (np. Solary, Kotly, adresy)

  // Nazewnictwo folderu pomp na poziomie inwestycji ROZNI SIE miedzy
  // inwestycjami (zweryfikowane realnie): niektore maja "PC powietrzne"
  // bezposrednio pod inwestycja, inne maja go zagniezdzony w ogolnym "PC"
  // (Kamiensk: "17. Kamieńsk\PC\wzór", nie "17. Kamieńsk\PC powietrzne\wzór" -
  // ten sam folder "PC" obejmuje tam WSZYSTKIE pompy, nie tylko powietrzne).
  // Probujemy "PC powietrzne" jako pierwsze (bardziej opisowa, starsza
  // konwencja), potem plaskie "PC".
  const { wzorDir, projektyDir } = znajdzFolderyPomp(rootPath);

  const wzorIstnieje = fs.existsSync(wzorDir);
  const nazwyFolderowKlientow = await listujFoldery(projektyDir);

  if (!wzorIstnieje) {
    wyniki.push({ gmina: null, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono folderu ze wzorami kart pomp: ${wzorDir}` });
    return wyniki;
  }
  if (nazwyFolderowKlientow === null) {
    wyniki.push({ gmina: null, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono folderu projektow: ${projektyDir}` });
    return wyniki;
  }

  const { mapa: mapaFolderow, duplikaty } = zbudujMapeFolderow(nazwyFolderowKlientow);

  const header = rows[0] || [];
  const colLpGmina = findColumn(header, ['lp', 'gmin']);
  const colAdres = findColumn(header, ['adres'], ['kod', 'email', 'e mail']);
  const colModelPompy = findColumn(header, ['model', 'pomp']);

  const brakujaceKolumny = [];
  if (colLpGmina === -1) brakujaceKolumny.push('LP gminy');
  if (colAdres === -1) brakujaceKolumny.push('adres');
  if (colModelPompy === -1) brakujaceKolumny.push('Model pompy');
  if (brakujaceKolumny.length) {
    wyniki.push({ gmina: null, sheet: sheetName, id: null, adres: null, uid: null, status: 'blad', komunikat: `Arkusz "${sheetName}": nie znaleziono kolumn: ${brakujaceKolumny.join(', ')}. Sprawdz naglowki w pierwszym wierszu arkusza.` });
    return wyniki;
  }

  const wynikiByIdx = new Array(rows.length).fill(null);
  const zadania = [];

  for (let i = 1; i < rows.length; i += 1) {
    const wiersz = i + 1;
    const row = rows[i];
    if (!row || row.every(v => v === null || v === undefined || v === '')) continue;

    const model = parseModelPompy(row[colModelPompy]);
    if (!model) continue; // brak pompy powietrznej Varmero w tym wierszu (np. CWU/Basic albo inny dostawca) - normalne, pomijamy cicho

    const id = parseIdFolderu(row[colLpGmina]);
    const adres = normalizujTekst(row[colAdres]);
    const opisAdresu = adres || '(brak adresu)';

    if (!id) {
      wynikiByIdx[i] = { gmina: null, sheet: sheetName, wiersz, id: row[colLpGmina], adres, model, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak poprawnego "LP gminy" dla adresu "${opisAdresu}" - nie mozna dopasowac folderu.` };
      continue;
    }
    if (duplikaty.has(id)) {
      wynikiByIdx[i] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: na dysku jest wiecej niz jeden folder zaczynajacy sie od "${id}" dla adresu "${opisAdresu}" - wymaga recznego sprawdzenia.` };
      continue;
    }

    const folderNazwa = mapaFolderow.get(id);
    if (!folderNazwa) {
      wynikiByIdx[i] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nie znaleziono na dysku folderu zaczynajacego sie od "${id} -" dla adresu "${opisAdresu}".` };
      continue;
    }
    if (!adres) {
      wynikiByIdx[i] = { gmina: null, sheet: sheetName, wiersz, id, adres: null, model, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak adresu w Excelu - nie mozna bezpiecznie potwierdzic, ze folder "${folderNazwa}" (dopasowany po samym numerze LP "${id}") faktycznie nalezy do tego wiersza. Uzupelnij adres i sprobuj ponownie.` };
      continue;
    }
    if (!adresPasujeDoFolderu(adres, folderNazwa)) {
      wynikiByIdx[i] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: znaleziono folder "${folderNazwa}" dla numeru LP "${id}", ale jego nazwa nie zawiera adresu z Excela "${adres}" - mozliwy konflikt numeracji miedzy inwestycjami. Sprawdz recznie.` };
      continue;
    }

    zadania.push({ idx: i, wiersz, id, adres, model, folderNazwa });
  }

  const semafor = createSemaphore(KK_CONCURRENCY);
  await Promise.all(zadania.map(zadanie => semafor.run(async () => {
    const { idx, wiersz, id, adres, model, folderNazwa } = zadanie;

    const folderyModelu = await znajdzFolderyModeluPompy(wzorDir, model);
    if (folderyModelu === null) {
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nie znaleziono folderu ${wzorDir}.` };
      return;
    }
    if (folderyModelu.length === 0) {
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nie znaleziono folderu wzoru dla modelu "${model}" w ${wzorDir}.` };
      return;
    }
    if (folderyModelu.length > 1) {
      // Nigdy nie zgadujemy, ktory wariant (np. z dodatkowym kotlem) pasuje -
      // Excel nie mowi, ktory dokladnie, wiec to musi trafic do recznego
      // sprawdzenia (na wyrazna prosbe wlasciciela, 2026-08-19).
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: model "${model}" ma kilka pasujących wariantów folderu wzoru (${folderyModelu.join(', ')}) - to narzędzie nie rozróżnia dodatkowego źródła ciepła (np. kocioł gazowy/stałopalny), wybierz kartę ręcznie dla adresu "${adres || '(brak adresu)'}".` };
      return;
    }
    const folderModelu = path.join(wzorDir, folderyModelu[0]);
    const zrodlo = path.join(folderModelu, 'Karty katalogowe.pdf');
    const zrodloIstnieje = await fsp.access(zrodlo).then(() => true).catch(() => false);
    if (!zrodloIstnieje) {
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: brak pliku "Karty katalogowe.pdf" w ${folderModelu}.` };
      return;
    }

    const folderKlienta = path.join(projektyDir, folderNazwa);
    const istniejace = await istniejacePlikiWFolderze(folderKlienta);
    if (istniejace.has('karty katalogowe.pdf')) {
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'pominieto-juz-sa', komunikat: 'Karta katalogowa juz jest w folderze klienta.' };
      return;
    }

    if (dryRun) {
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'do-skopiowania', komunikat: `Plik: Karty katalogowe.pdf (${model}, podglad)` };
      return;
    }

    try {
      await fsp.copyFile(zrodlo, path.join(folderKlienta, 'Karty katalogowe.pdf'), fs.constants.COPYFILE_EXCL);
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'skopiowano', komunikat: `Plik: Karty katalogowe.pdf (${model})` };
    } catch (err) {
      wynikiByIdx[idx] = { gmina: null, sheet: sheetName, wiersz, id, adres, model, folder: folderNazwa, status: 'blad', komunikat: `Arkusz "${sheetName}", wiersz ${wiersz}: nie udalo sie skopiowac karty (${err.message}).` };
    }
  })));

  for (const wynik of wynikiByIdx) {
    if (wynik) wyniki.push(wynik);
  }

  return wyniki;
}

// --- Endpointy ---

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'karty-katalogowe' }));

// Przegladarka folderow w stronie (przycisk "Przegladaj..." przy polu
// sciezki glownej) - patrz lib/folderBrowse.js dla pelnego uzasadnienia
// (dwie proby prawdziwego natywnego okna Windows zawiodly na zywo).
app.get('/api/browse-folder', (req, res) => {
  try {
    const result = browseFolder(req.query.path);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// Zrodlo (audyty/schematy/dokumenty seryjne) - zip (wgrany plik) ma
// pierwszenstwo przed sciezka (jesli oba jakims trafem podano naraz).
// Zwraca { dir, wyczysc } albo null, jesli zrodlo nie zostalo w ogole podane
// dla tego uruchomienia - "wyczysc" usuwa rozpakowany zip po zakonczeniu
// (sciezka wskazana recznie NIGDY nie jest usuwana - to nie nasz plik).
async function rozstrzygnijZrodloDodatku(req, etykieta, zipPole, sciezkaPole) {
  const zipFile = req.files?.[zipPole]?.[0];
  if (zipFile) {
    const dir = await rozpakujZipDoTemp(zipFile.path, req.jobId, etykieta);
    return { dir, wyczysc: true };
  }
  const sciezka = normalizujTekst(req.body[sciezkaPole]);
  if (sciezka) {
    if (!fs.existsSync(sciezka)) throw new Error(`Podana sciezka (${etykieta}) nie istnieje: ${sciezka}`);
    return { dir: sciezka, wyczysc: false };
  }
  return null;
}

app.post('/api/run', uploadWieloplikowy.fields([
  { name: 'excel', maxCount: 1 },
  { name: 'audytyZip', maxCount: 1 },
  { name: 'schematyZip', maxCount: 1 },
  { name: 'dokumentySeryjneZip', maxCount: 1 }
]), async (req, res) => {
  const jobId = crypto.randomUUID();
  req.jobId = jobId;
  const doWyczyszczenia = [];
  const wszystkieWgrane = () => [
    ...(req.files?.excel || []),
    ...(req.files?.audytyZip || []),
    ...(req.files?.schematyZip || []),
    ...(req.files?.dokumentySeryjneZip || [])
  ];
  try {
    const excelFile = req.files?.excel?.[0];
    if (!excelFile) throw new Error('Dodaj plik Excel (.xlsx).');
    const rootPath = normalizujTekst(req.body.rootPath);
    if (!rootPath) throw new Error('Podaj sciezke do glownego folderu (np. ...\\Kolektory).');
    if (!fs.existsSync(rootPath)) throw new Error(`Podana sciezka nie istnieje: ${rootPath}`);
    const dryRun = String(req.body.dryRun || '').toLowerCase() === 'true';
    // Solary i pompy powietrzne maja rozna interpretacje "rootPath" (patrz
    // przetworzArkusz vs przetworzArkuszPomp) - jednoczesne odpalanie obu
    // dla tej samej sciezki bylo realnym bledem znalezionym na Kamiensku
    // (sciezka wpisana dla solarow nigdy nie mogla pasowac do ukladu pomp).
    // Frontend zawsze wysyla 'typ' po jawnym wyborze rodzaju w UI.
    //
    // "audyty"/"schematy"/"dokumenty-seryjne" sa osobnymi trybami - dokladnie
    // jedna rzecz na raz, tak samo jak Solary/Pompy - a nie jednym wspolnym
    // formularzem z trzema opcjonalnymi zipami naraz. Zmiana 2026-08-19:
    // wlasciciel realnie chcial dodawac kazdy dodatek OSOBNO (tak jak wybiera
    // sie Solary albo Pompy), a wspolny formularz z 3 zipami naraz byl mylacy
    // i przy okazji ujawnil bug z limitem multera (patrz commit "napraw too
    // many files"). Backend nadal potrafi obsluzyc wszystkie 3 zipy razem w
    // trybie 'solary' (przez rozstrzygnijZrodloDodatku ponizej), gdyby kiedys
    // frontend chcial to zaoferowac - tylko UI juz z tego nie korzysta.
    const DODATEK_ZRODLA = {
      audyty: { etykieta: 'audyty', zip: 'audytyZip', sciezka: 'audytyPath' },
      schematy: { etykieta: 'schematy', zip: 'schematyZip', sciezka: 'schematyPath' },
      'dokumenty-seryjne': { etykieta: 'dokumenty-seryjne', zip: 'dokumentySeryjneZip', sciezka: 'dokumentySeryjnePath' }
    };
    const typRaw = normalizujTekst(req.body.typ);
    const typ = typRaw === 'pompy' ? 'pompy' : (DODATEK_ZRODLA[typRaw] ? typRaw : 'solary');

    // Audyty/schematy/dokumenty seryjne dotycza WYLACZNIE solarow (schematy
    // sa dobierane po mocy zestawu fotowoltaicznego, audyty/dokumenty
    // seryjne po adresie z arkusza PV) - dla pomp te pola sa po prostu
    // ignorowane, nawet jesli front-end jakims trafem by je wyslal.
    let audytyPliki = null;
    let dokumentySeryjnePliki = null;
    let schematyIndeks = null;
    let pominKarty = false;
    if (typ === 'solary') {
      const audytyZrodlo = await rozstrzygnijZrodloDodatku(req, 'audyty', 'audytyZip', 'audytyPath');
      if (audytyZrodlo) {
        if (audytyZrodlo.wyczysc) doWyczyszczenia.push(audytyZrodlo.dir);
        audytyPliki = await zbierzPlikiPdf(audytyZrodlo.dir);
      }
      const dokSeryjneZrodlo = await rozstrzygnijZrodloDodatku(req, 'dokumenty-seryjne', 'dokumentySeryjneZip', 'dokumentySeryjnePath');
      if (dokSeryjneZrodlo) {
        if (dokSeryjneZrodlo.wyczysc) doWyczyszczenia.push(dokSeryjneZrodlo.dir);
        dokumentySeryjnePliki = await zbierzPlikiPdf(dokSeryjneZrodlo.dir);
      }
      const schematyZrodlo = await rozstrzygnijZrodloDodatku(req, 'schematy', 'schematyZip', 'schematyPath');
      if (schematyZrodlo) {
        if (schematyZrodlo.wyczysc) doWyczyszczenia.push(schematyZrodlo.dir);
        schematyIndeks = zbudujIndeksSchematow(await zbierzPlikiPdf(schematyZrodlo.dir));
      }
    } else if (DODATEK_ZRODLA[typ]) {
      pominKarty = true;
      const cfg = DODATEK_ZRODLA[typ];
      const zrodlo = await rozstrzygnijZrodloDodatku(req, cfg.etykieta, cfg.zip, cfg.sciezka);
      if (!zrodlo) throw new Error(`Dodaj plik .zip albo podaj sciezke do folderu z: ${cfg.etykieta}.`);
      if (zrodlo.wyczysc) doWyczyszczenia.push(zrodlo.dir);
      const pliki = await zbierzPlikiPdf(zrodlo.dir);
      if (typ === 'audyty') audytyPliki = pliki;
      else if (typ === 'dokumenty-seryjne') dokumentySeryjnePliki = pliki;
      else if (typ === 'schematy') schematyIndeks = zbudujIndeksSchematow(pliki);
    }

    // Uwaga: w tej wersji read-excel-file { getSheets: true } zwraca od razu
    // wszystkie arkusze z danymi (pole 'sheet' = nazwa, 'data' = wiersze),
    // wiec nie trzeba osobno doczytywac kazdego arkusza.
    const wszystkieArkusze = await readXlsxFile(excelFile.path, { getSheets: true });

    const wynikiWszystkie = [];
    for (const arkusz of wszystkieArkusze) {
      const sheetName = arkusz.sheet;
      const rows = arkusz.data;
      // Kazda funkcja sama rozpoznaje, czy dany arkusz jej dotyczy (i cicho
      // nic nie zwraca, jesli nie) - np. arkusz "Kotly"/"obreby" nie pasuje.
      // Uruchamiamy WYLACZNIE funkcje pasujaca do wybranego rodzaju.
      if (typ === 'pompy') {
        const wynikiPompy = await przetworzArkuszPomp({ sheetName, rows, rootPath, dryRun });
        wynikiWszystkie.push(...wynikiPompy);
      } else {
        const wynikiSolary = await przetworzArkusz({ sheetName, rows, rootPath, dryRun, audytyPliki, dokumentySeryjnePliki, schematyIndeks, pominKarty });
        wynikiWszystkie.push(...wynikiSolary);
      }
    }

    const podsumowanie = wynikiWszystkie.reduce((acc, w) => {
      acc[w.status] = (acc[w.status] || 0) + 1;
      return acc;
    }, {});

    const logPath = path.join(LOGS_DIR, `dobor-kart-${jobId}.json`);
    writeJsonFileNoBom(logPath, { jobId, createdAt: new Date().toISOString(), rootPath, typ, dryRun, podsumowanie, wyniki: wynikiWszystkie });

    res.json({ ok: true, jobId, dryRun, podsumowanie, wyniki: wynikiWszystkie });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  } finally {
    // Wgrane pliki (excel + ewentualne zipy) sa tylko robocze - kasowane
    // zawsze, niezaleznie od sukcesu/bledu. Rozpakowane zipy (doWyczyszczenia)
    // sprzatane osobno - sciezki wskazane recznie (audytyPath itp.) NIGDY tu
    // nie trafiaja, bo to nie sa nasze pliki.
    for (const plik of wszystkieWgrane()) fsp.unlink(plik.path).catch(() => {});
    for (const dir of doWyczyszczenia) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
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

module.exports = {
  app,
  przetworzArkusz,
  przetworzArkuszPomp,
  adresPasujeDoFolderu,
  parseIdFolderu,
  rozpoznajArkuszSolarow,
  parseModelPompy,
  rozpoznajArkuszPomp,
  znajdzPlikiPoAdresie,
  sparsujPlikSchematu,
  zbudujIndeksSchematow,
  znajdzSchemat,
  rozpoznajFaze,
  zbierzPlikiPdf,
  dopasujISkopiujDodatek
};
