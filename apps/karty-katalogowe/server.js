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
    wyniki.push({ gmina, id: null, adres: null, uid: null, status: 'blad', komunikat: 'Niepoprawna nazwa gminy z arkusza - pominieto.' });
    return wyniki;
  }

  const kartyIstnieja = fs.existsSync(kartyDir);
  const nazwyFolderowKlientow = await listujFoldery(projektyDir);

  if (!kartyIstnieja) {
    wyniki.push({ gmina, id: null, adres: null, uid: null, status: 'blad', komunikat: `Nie znaleziono folderu ze zrodlowymi kartami: ${kartyDir}` });
    return wyniki;
  }
  if (nazwyFolderowKlientow === null) {
    wyniki.push({ gmina, id: null, adres: null, uid: null, status: 'blad', komunikat: `Nie znaleziono folderu projektow dla gminy: ${projektyDir}` });
    return wyniki;
  }

  const { mapa: mapaFolderow, duplikaty } = zbudujMapeFolderow(nazwyFolderowKlientow);

  // rows[0] to naglowek
  const header = rows[0] || [];
  const idx = {
    lpGmina: 1,
    rezygnacja: 3,
    adres: 6,
    uid: 10
  };

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every(v => v === null || v === undefined || v === '')) continue;

    const id = parseIdFolderu(row[idx.lpGmina]);
    const rezygnacja = normalizujTekst(row[idx.rezygnacja]);
    const adres = normalizujTekst(row[idx.adres]);
    const uidRaw = row[idx.uid];
    const uid = normalizujTekst(uidRaw);

    if (!uid) continue; // wiersz bez UID pomijamy calkowicie (nie dotyczy solarow / brak danych)

    if (rezygnacja) {
      wyniki.push({ gmina, id, adres, uid, status: 'pominieto-rezygnacja', komunikat: 'Rezygnacja - pominieto.' });
      continue;
    }

    if (!id) {
      wyniki.push({ gmina, id: row[idx.lpGmina], adres, uid, status: 'blad', komunikat: 'Brak poprawnego "LP gminy" - nie mozna dopasowac folderu.' });
      continue;
    }

    if (duplikaty.has(id)) {
      wyniki.push({ gmina, id, adres, uid, status: 'blad', komunikat: `Na dysku jest wiecej niz jeden folder zaczynajacy sie od "${id}" - wymaga recznego sprawdzenia.` });
      continue;
    }

    const folderNazwa = mapaFolderow.get(id);
    if (!folderNazwa) {
      wyniki.push({ gmina, id, adres, uid, status: 'blad', komunikat: `Nie znaleziono na dysku folderu zaczynajacego sie od "${id} -".` });
      continue;
    }

    const rozmiar = parseRozmiarZUid(uid);
    if (!rozmiar || typeof rozmiar === 'object') {
      const nieznany = rozmiar && rozmiar.nieznany ? rozmiar.nieznany : uid;
      wyniki.push({ gmina, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: `Nierozpoznany rozmiar zasobnika w UID ("${nieznany}"). Oczekiwano 250/300/400.` });
      continue;
    }

    const wymaganePliki = [...ZAWSZE_KARTY, nazwaZasobnika(rozmiar)];
    const folderKlienta = path.join(projektyDir, folderNazwa);
    const istniejace = await istniejacePlikiWFolderze(folderKlienta);

    const doSkopiowania = wymaganePliki.filter(nazwa => !istniejace.has(nazwa.toLowerCase()));

    if (doSkopiowania.length === 0) {
      wyniki.push({ gmina, id, adres, uid, folder: folderNazwa, status: 'pominieto-juz-sa', komunikat: 'Karty katalogowe juz sa w folderze klienta.' });
      continue;
    }

    const skopiowane = [];
    const bledy = [];
    for (const nazwaPliku of doSkopiowania) {
      const zrodlo = path.join(kartyDir, nazwaPliku);
      const cel = path.join(folderKlienta, nazwaPliku);
      if (!fs.existsSync(zrodlo)) {
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
      wyniki.push({ gmina, id, adres, uid, folder: folderNazwa, status: 'blad', komunikat: bledy.join('; ') });
    } else if (bledy.length) {
      wyniki.push({ gmina, id, adres, uid, folder: folderNazwa, status: 'czesciowo', komunikat: `Skopiowano: ${skopiowane.join(', ')}. Bledy: ${bledy.join('; ')}` });
    } else {
      wyniki.push({ gmina, id, adres, uid, folder: folderNazwa, status: dryRun ? 'do-skopiowania' : 'skopiowano', komunikat: `Pliki: ${skopiowane.join(', ')}` });
    }
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

const server = app.listen(PORT, HOST, () => console.log(`Karty katalogowe: http://${HOST}:${PORT}`));
applyHttpTimeouts(server, 'KK');
