const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { setupProcessDiagnostics, applyHttpTimeouts, scheduleCleanup } = require('../../lib/hardening');
const { getAppDataDir } = require('../../lib/appPaths');
const { analyzeDocument, inspectDocument, finalizeSplit } = require('./src/ocrPipeline');
const { isConfigured: isAiConfigured, saveUserApiKey, extractFieldsForBlock, getActiveProvider, PROVIDER_LABELS } = require('./src/aiProvider');
const { COLUMN_ORDER, COLUMN_LABELS, COLUMN_OPTIONS, buildFieldsFromExtraction, filterExtractableFields, isFieldApplicable } = require('./src/fieldExtraction');
const { writeFreshRows, writeFamilyTemplateRows, readExistingTable, fillExistingTableRows, validatePath: validateExcelPath } = require('./src/excelExport');
const { TABELA_FAMILIES, buildRowValues, allowedKeysForFamily } = require('./src/tabelaAdresowaColumns');
const { validateOcrBatchInspections } = require('./src/ocrLimits');
const { browseFolder } = require('../../lib/folderBrowse');
const { contentDispositionHeader } = require('../../lib/printing');

const app = express();
const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const APP_DATA_ROOT = getAppDataDir('ocr-audytow');
setupProcessDiagnostics('ocr-audytow', APP_DATA_ROOT);

const DATA_DIR = path.join(APP_DATA_ROOT, 'data');
const UPLOAD_DIR = path.join(APP_DATA_ROOT, 'uploads');
const OUTPUT_DIR = path.join(APP_DATA_ROOT, 'output');
const ANALYSIS_DIR = path.join(APP_DATA_ROOT, 'analysis');
const MAX_FILE_MB = Number(process.env.OCR_MAX_FILE_MB || 100);
const MAX_FILES = Number(process.env.OCR_MAX_FILES || 20);
const OCR_MAX_TOTAL_PAGES = Number(process.env.OCR_MAX_TOTAL_PAGES || 300);
const OCR_MAX_PAGES_PER_FILE = Number(process.env.OCR_MAX_PAGES_PER_FILE || 60);
const JOB_TTL_MS = Number(process.env.OCR_JOB_TTL_MS || 24 * 60 * 60 * 1000);
// Krotszy TTL niz JOB_TTL_MS: sesja analizy to tylko przegladanie/poprawianie
// podzialu na bloki przed pobraniem, nie docelowe miejsce przechowywania plikow -
// nie ma powodu trzymac jej godzinami tak jak juz gotowe wyniki w OUTPUT_DIR.
const ANALYSIS_TTL_MS = Number(process.env.OCR_ANALYSIS_TTL_MS || 2 * 60 * 60 * 1000);

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR, ANALYSIS_DIR]) fs.mkdirSync(dir, { recursive: true });
scheduleCleanup([UPLOAD_DIR, OUTPUT_DIR], JOB_TTL_MS, 60 * 60 * 1000);
// cleanupOldAnalyses() nizej sprzata sesje tylko przez w-pamieci mape `analyses` - po restarcie
// procesu ta mapa jest pusta, wiec kazdy folder analizy otwarty w momencie restartu zostawalby
// osierocony na zawsze (potwierdzone: ~60 takich folderow ze zwyklej dzisiejszej pracy). Ten
// dodatkowy, oparty na dacie modyfikacji folderu sweep (ten sam mechanizm co UPLOAD_DIR/OUTPUT_DIR
// wyzej) dziala niezaleznie od stanu w pamieci i sprzata kazdy porzucony folder w ANALYSIS_DIR.
scheduleCleanup([ANALYSIS_DIR], ANALYSIS_TTL_MS, 15 * 60 * 1000);

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

app.get('/api/health', async (req, res) => {
  const ocrProvider = getActiveProvider();
  res.json({ ok: true, name: 'ocr-audytow', ocrConfigured: isAiConfigured(), ocrProvider, ocrProviderLabel: PROVIDER_LABELS[ocrProvider] });
});

// Przegladarka folderow w stronie (przycisk "Przegladaj..." przy polu
// sciezki do wgrywanej tabeli, krok 0) - patrz lib/folderBrowse.js dla
// pelnego uzasadnienia (dwie proby prawdziwego natywnego okna Windows
// zawiodly na zywo na innych apkach). `fileExtensions: ['.xlsx']` - w
// odroznieniu od innych apek (ktore wybieraja FOLDER), tu uzytkownik
// wybiera KONKRETNY plik Excela.
app.get('/api/browse-folder', (req, res) => {
  try {
    const result = browseFolder(req.query.path, { fileExtensions: ['.xlsx'] });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// Ekran "OCR zablokowany" w public/index.html (pokazywany, gdy /api/health
// zwraca ocrConfigured:false) pozwala uzytkownikowi wpisac klucz API RECZNIE -
// patrz saveUserApiKey w src/aiProvider.js (trwaly katalog %LOCALAPPDATA%\Scyzoryk,
// przezywa aktualizacje). Dużo prostsza konfiguracja niz dawny Document AI (jeden
// sekret zamiast pliku service-account.json + 3 zmiennych srodowiskowych).
// 2026-08-19: dwaj dostawcy (Gemini/OpenAI) zamiast jednego - `provider` w body
// wybiera KTORY klucz zapisac, a zapisanie klucza automatycznie ustawia tego
// dostawce jako aktywnego (patrz aiProvider.js#saveUserApiKey).
app.post('/api/ocr/setup-api-key', (req, res) => {
  try {
    const requestedProvider = req.body?.provider;
    const provider = requestedProvider === 'openai' || requestedProvider === 'manual' ? requestedProvider : 'gemini';
    const saved = saveUserApiKey(provider, req.body?.apiKey);
    res.json({ ok: true, provider, ...saved });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się zapisać klucza API.' });
  }
});

// Domyslnie 60/15min (typowy dla innych aplikacji Scyzoryka) jest za niskie dla TEGO
// przeplywu - krok 3 (recenzja pol) generuje min. 2 zadania na kazde pole wymagajace
// przegladu (obraz podgladu + "Zapisz i dalej"/"Zaznacz recznie"), a jeden gesty
// dokument potrafi miec >100 takich pol (zweryfikowane realnie: 147 na pierwszym
// przebiegu bez wzoru) - realna sesja przegladu latwo przekracza 60 zadan. To
// narzedzie jest lokalne (127.0.0.1, patrz CLAUDE.md) - granica izolacji to dostep
// sieciowy, nie liczba zadan, wiec dużo wyzszy limit jest tu bezpieczny.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.OCR_API_RATE_LIMIT || 2000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za dużo żądań w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.OCR_HEAVY_RATE_LIMIT || 15),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za dużo zadań OCR w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.' }
});
app.use('/api', apiLimiter);

app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
app.use(express.static(path.join(ROOT, 'public')));

const jobs = new Map();
// analysisId -> { id, createdAt, dir, files: Map(fileId -> {...}) } - stan miedzy
// /api/ocr/analyze (rozpoznanie + propozycja podzialu na bloki) a
// /api/ocr/finalize (zatwierdzony, ewentualnie recznie poprawiony podzial) -
// patrz src/ocrPipeline.js.
const analyses = new Map();

async function touchAnalysis(analysis) {
  if (!analysis) return;
  analysis.lastActivityAt = Date.now();
  await fsp.utimes(analysis.dir, new Date(), new Date()).catch(() => {});
}

app.use('/api', (req, res, next) => {
  const urlMatch = req.path.match(/^\/analysis\/([^/]+)/);
  const analysisId = req.body?.analysisId || urlMatch?.[1];
  const analysis = analysisId ? analyses.get(analysisId) : null;
  if (analysis) touchAnalysis(analysis).catch(() => {});
  next();
});

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

function safeName(name, fallback = 'plik') {
  const cleaned = sanitize(String(name || fallback)).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return (cleaned || fallback).slice(0, 150);
}

// Audyt v1.0.4 (OCR, ustalenie 7): uzytkownik moze recznie nadac dwom blokom
// identyczna etykiete - bez tego kazdy kolejny zapis do tej samej sciezki
// cicho nadpisywal poprzedni (zniknal caly wczesniejszy adres). Dodaje
// licznik " (2)", " (3)"... do KAZDEGO powtorzonego pliku w tej samej
// paczce (i sprawdza tez istniejace pliki na dysku, gdyby jakis juz tam byl).
function dedupeOutPaths(paths) {
  const usedPaths = new Set();
  return paths.map((outPath) => {
    const dir = path.dirname(outPath);
    const ext = path.extname(outPath);
    const base = path.basename(outPath, ext);
    let candidate = outPath;
    let n = 2;
    while (usedPaths.has(candidate) || fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base} (${n})${ext}`);
      n += 1;
    }
    usedPaths.add(candidate);
    return candidate;
  });
}

function readHeader(filePath, length = 5) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

function validatePdf(file) {
  const original = decodeOriginalName(file.originalname || '');
  if (path.extname(original).toLowerCase() !== '.pdf') throw new Error(`Plik ${original} nie jest PDF-em.`);
  const header = readHeader(file.path, 5).toString('latin1');
  if (!header.startsWith('%PDF-')) throw new Error(`Plik ${original} nie wygląda jak poprawny PDF.`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = safeName(decodeOriginalName(file.originalname), 'audyt.pdf');
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${original}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeOriginalName(file.originalname || '')).toLowerCase();
    if (ext === '.pdf') return cb(null, true);
    return cb(new Error('Wybierz pliki PDF.'));
  }
});

async function purgeJobArtifacts(job) {
  await fsp.rm(job.jobDir, { recursive: true, force: true }).catch(() => {});
  for (const uploadPath of job.uploadPaths || []) {
    await fsp.rm(uploadPath, { force: true }).catch(() => {});
  }
}

async function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt <= JOB_TTL_MS) continue;
    await purgeJobArtifacts(job);
    jobs.delete(id);
  }
}
setInterval(() => cleanupOldJobs().catch(err => console.error('[ocr-cleanup]', err?.message || err)), 60 * 60 * 1000).unref();

async function purgeAnalysis(analysis) {
  await fsp.rm(analysis.dir, { recursive: true, force: true }).catch(() => {});
  for (const uploadPath of analysis.uploadPaths || []) {
    await fsp.rm(uploadPath, { force: true }).catch(() => {});
  }
  for (const fileEntry of analysis.files.values()) {
    await fsp.rm(fileEntry.sourcePdfPath, { force: true }).catch(() => {});
  }
}

async function cleanupOldAnalyses() {
  const now = Date.now();
  for (const [id, analysis] of analyses) {
    if (now - analysis.lastActivityAt <= ANALYSIS_TTL_MS) continue;
    await purgeAnalysis(analysis);
    analyses.delete(id);
  }
}
setInterval(() => cleanupOldAnalyses().catch(err => console.error('[ocr-analysis-cleanup]', err?.message || err)), 15 * 60 * 1000).unref();

// Krok 0 (opcjonalny, przed wgraniem PDF-ow): wlasciciel juz ma tabelke
// adresowa (np. "Biala tabela adresowa.xlsx") czesciowo uzupelniona - zamiast
// zawsze ciagnac z Gemini pelny zestaw ~40 pol, czyta te tabelke i pokazuje,
// KTORYCH pol (z rodziny wybranej przez uzytkownika) faktycznie brakuje w co
// najmniej jednym wierszu - to steruje checklista w UI (pre-zaznaczone =
// brakujace). Sciezka jest podawana wprost (jak `excelPath` przy finalizacji
// od zawsze) - to lokalne, 127.0.0.1-owe narzedzie na tym samym dysku, wiec
// nie ma potrzeby uploadu/kopiowania pliku (w odroznieniu od PDF-ow audytow,
// ktore faktycznie trzeba przekazac serwerowi do przetworzenia).
app.post('/api/ocr/inspect-table', async (req, res) => {
  try {
    const excelPath = String(req.body?.excelPath || '').trim();
    const family = String(req.body?.family || '').trim();
    if (!family || !TABELA_FAMILIES[family]) {
      throw new Error('Wybierz rodzaj protokołu (Pompy ciepła / Solary / Kotły).');
    }
    validateExcelPath(excelPath);
    if (!fs.existsSync(excelPath)) throw new Error(`Nie znaleziono pliku: ${excelPath}`);

    const { rows, columns, unrecognizedHeaders } = await readExistingTable(excelPath, family);
    const allowedKeys = allowedKeysForFamily(family);

    // Kazde pole checklisty jest ZRODLOWYM kluczem FIELD_DEFS (nie etykieta
    // kolumny) - kolumny "Udział ogrzew. grzejnik."/"Udział ogrzew. podłog."
    // dziela jeden klucz (udzialGrzejnikowy), tak samo "kolektory" pokazuje
    // sie jako jedna pozycja mimo ze jej zrodlem jest zrodloCieplaInnyOpis.
    const fieldStats = new Map();
    for (const { def } of columns) {
      const sourceKey = def.fieldKey || def.complementOf || def.deriveFromKeyword?.sourceField;
      if (!sourceKey || !allowedKeys.has(sourceKey)) continue;
      if (!fieldStats.has(sourceKey)) fieldStats.set(sourceKey, { label: def.label, missingCount: 0 });
    }
    for (const row of rows) {
      const missingHere = new Set();
      for (const { def } of columns) {
        const sourceKey = def.fieldKey || def.complementOf || def.deriveFromKeyword?.sourceField;
        if (!sourceKey || !fieldStats.has(sourceKey)) continue;
        if (!row.values[def.label]) missingHere.add(sourceKey);
      }
      for (const key of missingHere) fieldStats.get(key).missingCount += 1;
    }

    const fields = [...fieldStats.entries()].map(([fieldKey, s]) => ({
      fieldKey, label: s.label, missingCount: s.missingCount, totalRows: rows.length
    }));

    res.json({ ok: true, rowCount: rows.length, fields, unrecognizedHeaders, lpValues: rows.map((r) => r.lp) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

// Krok 1/2: rozpoznaje tekst i - dla plikow, ktore tego wymagaly - proponuje
// podzial na bloki adresowe + miniatury stron do przegladu. NIC tu jeszcze nie
// trafia do pobrania - to robi dopiero /api/ocr/finalize po zatwierdzeniu
// (ewentualnie recznie poprawionego) podzialu przez uzytkownika.
// Uwaga: celowo NIE ma tu gornego "if (!isAiConfigured()) return 500" blokujacego caly
// batch - analiza (rozpoznanie liczby stron + propozycja podzialu na adresy) dziala bez
// klucza API; klucz jest potrzebny dopiero w /api/ocr/extract-fields. Gorna blokada
// odrzucalaby caly upload, zanim uzytkownik w ogole zobaczyl ekran podzialu.
app.post('/api/ocr/analyze', heavyJobLimiter, upload.array('files', MAX_FILES), async (req, res) => {
  const analysisId = crypto.randomUUID();
  const analysisDir = path.join(ANALYSIS_DIR, analysisId);
  const analysis = { id: analysisId, createdAt: Date.now(), lastActivityAt: Date.now(), dir: analysisDir, files: new Map(), uploadPaths: [] };

  try {
    const files = req.files || [];
    analysis.uploadPaths = files.map((file) => file.path);
    if (!files.length) throw new Error('Dodaj przynajmniej jeden plik PDF.');
    for (const file of files) validatePdf(file);

    await fsp.mkdir(analysisDir, { recursive: true });
    const inspections = new Map();
    const inspectionEntries = [];
    for (const file of files) {
      const inspection = await inspectDocument(file.path);
      const original = decodeOriginalName(file.originalname || path.basename(file.path));
      inspectionEntries.push({ originalName: original, inspection });
      inspections.set(file.path, inspection);
    }
    validateOcrBatchInspections(inspectionEntries, {
      maxTotalPages: OCR_MAX_TOTAL_PAGES,
      maxPagesPerFile: OCR_MAX_PAGES_PER_FILE
    });
    analyses.set(analysisId, analysis);
    await touchAnalysis(analysis);

    const results = [];
    for (const file of files) {
      const fileId = crypto.randomUUID();
      const original = decodeOriginalName(file.originalname || path.basename(file.path));
      const baseName = safeName(path.basename(original, path.extname(original)), 'audyt');
      const workDir = path.join(analysisDir, fileId);
      try {
        const result = await analyzeDocument({ sourcePdfPath: file.path, workDir, inspection: inspections.get(file.path) });
        analysis.files.set(fileId, {
          fileId,
          originalName: original,
          baseName,
          sourcePdfPath: file.path,
          workDir,
          status: result.status,
          pageCount: result.pageCount,
          pages: result.pages,
          warnings: result.warnings,
          blocks: result.blocks
        });
        results.push({
          ok: true,
          fileId,
          originalName: original,
          status: result.status,
          pageCount: result.pageCount,
          warnings: result.warnings,
          blocks: result.blocks,
          thumbnails: result.thumbnails.map(t => ({
            pageIndex: t.pageIndex,
            available: t.available,
            url: t.available ? `/api/analysis/${analysisId}/files/${fileId}/thumb/${encodeURIComponent(t.file)}` : null
          }))
        });
      } catch (fileErr) {
        results.push({ ok: false, originalName: original, error: fileErr.message || 'Nie udało się przeanalizować pliku.' });
      }
    }

    res.json({ ok: true, analysisId, results });
  } catch (error) {
    await purgeAnalysis(analysis).catch(() => {});
    analyses.delete(analysisId);
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get('/api/analysis/:analysisId/files/:fileId/thumb/:file', (req, res) => {
  const fileEntry = analyses.get(req.params.analysisId)?.files.get(req.params.fileId);
  if (!fileEntry) return res.status(404).send('Nie znaleziono miniatury.');
  const thumbsDir = path.join(fileEntry.workDir, 'thumbs');
  const filePath = path.join(thumbsDir, safeName(req.params.file, 'thumb.jpg'));
  if (!filePath.startsWith(thumbsDir) || !fs.existsSync(filePath)) return res.status(404).send('Nie znaleziono miniatury.');
  res.sendFile(filePath);
});

// Pelny obraz jednej strony (nie miniatura 220px z /thumb/) - link "zobacz oryginalna
// strone" przy polu wymagajacym recznej korekty (patrz ekran 3 w public/app.js). To TEN
// SAM plik, ktory pipeline juz zapisal w workDir (page-XXX.jpg) - zadnego nowego
// przetwarzania obrazu.
app.get('/api/analysis/:analysisId/files/:fileId/page/:pageIndex', (req, res) => {
  const fileEntry = analyses.get(req.params.analysisId)?.files.get(req.params.fileId);
  if (!fileEntry) return res.status(404).send('Nie znaleziono strony.');
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return res.status(400).send('Nieprawidlowy numer strony.');
  const filePath = fileEntry.pages?.find((page) => page.pageIndex === pageIndex)?.imagePath;
  if (!filePath) return res.status(404).send('Nie znaleziono strony.');
  if (!filePath.startsWith(fileEntry.workDir) || !fs.existsSync(filePath)) return res.status(404).send('Nie znaleziono strony.');
  res.sendFile(filePath);
});

// Caly, oryginalnie wgrany PDF (nie wyciety obraz jednej strony) - podglad na
// ekranie uzupelniania pol pokazuje go w <iframe> (natywna przegladarka PDF
// przez #page=/#zoom=, patrz public/app.js), zamiast statycznego obrazka -
// jesli skan ma juz warstwe tekstu, daje zaznaczanie/kopiowanie za darmo.
app.get('/api/analysis/:analysisId/files/:fileId/pdf', (req, res) => {
  const fileEntry = analyses.get(req.params.analysisId)?.files.get(req.params.fileId);
  if (!fileEntry) return res.status(404).send('Nie znaleziono pliku.');
  const filePath = fileEntry.sourcePdfPath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Nie znaleziono pliku.');
  // Globalny SECURITY_HEADERS wyzej ustawia "frame-ancestors 'none'" (blokuje
  // KAZDE osadzenie w ramce, nawet z tej samej strony) - to psulo wlasny
  // podglad w <iframe> (Chrome zglaszal "Framing ... violates ... frame-
  // ancestors 'none'" i w ogole nie laczyl sie z serwerem). Nadpisanie na
  // 'self' tylko dla TEJ trasy = ten sam wzorzec co
  // apps/nazywarka-skanow/server.js#/api/preview/:index.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDispositionHeader('inline', fileEntry.originalName || 'audyt.pdf'));
  res.sendFile(filePath);
});

// Krok 3: dla kazdego ZATWIERDZONEGO bloku pyta Gemini o wartosci wszystkich pol na raz
// (patrz src/aiProvider.js) i buduje wynik z needsReview wg deterministycznej
// reguly (patrz src/fieldExtraction.js#toFieldResult). Wynik zapisywany w sesji analizy
// (fileEntry.resolvedBlocks) - finalize pozniej korzysta z TYCH danych, nie z surowego
// body zadania, zeby wymusic ze tabelka faktycznie jest kompletna (patrz walidacja w
// /api/ocr/finalize).
app.post('/api/ocr/extract-fields', heavyJobLimiter, async (req, res) => {
  const { analysisId, files: requestedFiles, family, selectedKeys } = req.body || {};
  const analysis = analyses.get(analysisId);
  if (!analysis) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje - wgraj pliki ponownie.' });
  if (!Array.isArray(requestedFiles) || !requestedFiles.length) {
    return res.status(400).json({ ok: false, message: 'Brak plików do przetworzenia.' });
  }
  if (family && !TABELA_FAMILIES[family]) {
    return res.status(400).json({ ok: false, message: 'Nieznana rodzina protokołu.' });
  }
  if (!isAiConfigured()) {
    return res.status(400).json({ ok: false, message: 'Brak skonfigurowanego klucza API Gemini. Ustaw go w ustawieniach narzędzia.' });
  }
  // Zawezenie ekstrakcji/przegladu TYLKO do pol potrzebnych tabelce adresowej wybranej
  // rodziny (na wyrazna prosbe wlasciciela - null/brak wybranej rodziny = pelny zestaw pol).
  // `selectedKeys` (checklista z /api/ocr/inspect-table) zawezia to DALEJ - zawsze
  // przecinana z allowedKeysForFamily, zeby nikt nie mogl zazadac klucza spoza rodziny.
  let allowedKeys = family ? allowedKeysForFamily(family) : null;
  if (allowedKeys && Array.isArray(selectedKeys)) {
    const requested = new Set(selectedKeys.map(String));
    allowedKeys = new Set([...allowedKeys].filter((k) => requested.has(k)));
  }
  const fieldDefs = filterExtractableFields(allowedKeys);

  try {
    const results = [];
    for (const requested of requestedFiles) {
      const fileEntry = analysis.files.get(requested?.fileId);
      if (!fileEntry) { results.push({ ok: false, originalName: requested?.fileId || '?', error: 'Nie znaleziono pliku w sesji analizy.' }); continue; }

      try {
        const blocks = validateBlocks(
          Array.isArray(requested.blocks) && requested.blocks.length ? requested.blocks : fileEntry.blocks,
          fileEntry.pageCount
        );

        const resolvedBlocks = [];
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
          const block = blocks[blockIndex];
          let fields;
          try {
            const rawValues = await extractFieldsForBlock({
              sourcePdfPath: fileEntry.sourcePdfPath,
              startPage: block.startPage,
              endPage: block.endPage,
              fieldDefs
            });
            fields = buildFieldsFromExtraction(rawValues, allowedKeys);
          } catch (blockErr) {
            // Blad pojedynczego bloku (np. chwilowy problem z Gemini) nie moze zepsuc calej
            // reszty pliku - blok zostaje z pustymi polami wymagajacymi recznego uzupelnienia,
            // uzytkownik dostaje czytelny komunikat zamiast calego zadania odrzuconego.
            fields = buildFieldsFromExtraction(null, allowedKeys);
            fileEntry.warnings = [...(fileEntry.warnings || []), `Blok "${block.label || `adres ${blockIndex + 1}`}": nie udało się automatycznie rozpoznać pól (${blockErr.message || blockErr}) - uzupełnij ręcznie.`];
          }

          resolvedBlocks.push({ ...block, blockIndex, fields });
        }

        fileEntry.resolvedBlocks = resolvedBlocks;

        results.push({
          ok: true,
          fileId: fileEntry.fileId,
          originalName: fileEntry.originalName,
          warnings: fileEntry.warnings || [],
          blocks: resolvedBlocks.map((b) => ({
            blockIndex: b.blockIndex,
            startPage: b.startPage,
            endPage: b.endPage,
            label: b.label,
            fields: Object.fromEntries(Object.entries(b.fields).map(([key, f]) => [key, {
              value: f.value,
              confidence: f.confidence,
              needsReview: f.needsReview,
              resolved: f.resolved,
              pageIndex: f.pageIndex,
              columnLabel: COLUMN_LABELS[key] || key,
              options: COLUMN_OPTIONS[key] || null
            }]))
          }))
        });
      } catch (fileErr) {
        results.push({ ok: false, originalName: fileEntry.originalName, error: fileErr.message || 'Nie udało się przetworzyć pliku.' });
      }
    }

    res.json({ ok: true, columnOrder: COLUMN_ORDER, columnLabels: COLUMN_LABELS, results });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

// Zapisuje reczna poprawke JEDNEGO pola (albo jawne "brak w oryginale" -
// value pusty string/null) - oznacza pole jako rozstrzygniete, wiec przestaje
// blokowac finalizacje.
app.post('/api/ocr/resolve-field', async (req, res) => {
  const { analysisId, fileId, blockIndex, fieldKey, value } = req.body || {};
  const fileEntry = analyses.get(analysisId)?.files.get(fileId);
  if (!fileEntry) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje.' });
  const block = fileEntry.resolvedBlocks?.[blockIndex];
  if (!block || !block.fields[fieldKey]) return res.status(400).json({ ok: false, message: 'Nie znaleziono wskazanego pola.' });

  block.fields[fieldKey] = {
    ...block.fields[fieldKey],
    value: typeof value === 'string' ? value.trim().slice(0, 300) : '',
    needsReview: false,
    resolved: true
  };
  res.json({ ok: true });
});


// Ostrzezenia z analyzeDocument dotycza calego (jeszcze niepodzielonego) pliku -
// przy faktycznym podziale na kilka wyjsciowych PDF-ow filtrujemy je do stron
// nalezacych do danego bloku ("Strona N: ..."), zeby np. adres 1 nie pokazywal
// ostrzezen o obrocie strony 18. Ostrzezenia bez numeru strony (np. sama
// informacja o wykrytej liczbie blokow - juz nieaktualna po podziale) pomijamy
// wtedy calkowicie. Dla plikow z JEDNYM blokiem (najczestszy przypadek) nic
// sie nie filtruje - zachowanie identyczne jak przed etapem 3.
function warningsForBlock(warnings, block, blocksCount) {
  if (blocksCount <= 1) return warnings;
  return warnings.filter(w => {
    const match = w.match(/^Strona (\d+):/);
    if (!match) return false;
    const page = Number(match[1]);
    return page >= block.startPage + 1 && page <= block.endPage + 1;
  });
}

// Zakresy blokow przychodza z UI (uzytkownik mogl je recznie poprawic) - walidacja
// server-side, zeby nie dostac sie do assemblePdfRange z niespojnymi/nakladajacymi
// sie zakresami.
function validateBlocks(blocks, pageCount) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('Brak zdefiniowanych zakresów stron.');
  const cleaned = blocks
    .map(b => ({
      startPage: Math.trunc(Number(b?.startPage)),
      endPage: Math.trunc(Number(b?.endPage)),
      label: typeof b?.label === 'string' ? b.label.trim().slice(0, 80) : ''
    }))
    .sort((a, b) => a.startPage - b.startPage);
  for (const b of cleaned) {
    if (!Number.isInteger(b.startPage) || !Number.isInteger(b.endPage)) throw new Error('Nieprawidłowy zakres stron w podziale.');
    if (b.startPage < 0 || b.endPage > pageCount - 1 || b.startPage > b.endPage) throw new Error('Zakres stron w podziale wykracza poza dokument.');
  }
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i].startPage <= cleaned[i - 1].endPage) throw new Error('Zakresy stron w podziale nakładają się.');
  }
  // Audyt rozdz. 17, P0: brak nakladania nie oznacza pelnego pokrycia -
  // luka miedzy blokami (np. blok1=0-2, blok2=5-7) przechodzila wczesniej
  // walidacje bez zadnego bledu i CICHO gubila strony 3-4 z kazdego
  // wynikowego PDF-a. /api/ocr/finalize przyjmuje blocks WPROST z cialem
  // zadania (patrz wywolanie ponizej: "requested.blocks" ma pierwszenstwo
  // przed fileEntry.blocks z sesji analizy) - normalny frontend (public/app.js
  // #computeBlocks) zawsze konstruuje bloki bez luk z definicji (kazdy blok
  // konczy sie dokladnie tam, gdzie zaczyna kolejny), wiec ta walidacja nigdy
  // nie odrzuci prawdziwego, niezmienionego zadania - zamyka wylacznie
  // przypadek zniekstalconego/recznie spreparowanego zadania.
  if (cleaned[0].startPage !== 0 || cleaned[cleaned.length - 1].endPage !== pageCount - 1) {
    throw new Error('Podzial stron nie pokrywa calego dokumentu (luka na poczatku albo koncu) - niektore strony zostalyby pominiete.');
  }
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i].startPage !== cleaned[i - 1].endPage + 1) {
      throw new Error(`Podzial stron ma luke miedzy strona ${cleaned[i - 1].endPage + 1} a ${cleaned[i].startPage + 1} - te strony zostalyby pominiete w wynikowych PDF-ach.`);
    }
  }
  return cleaned;
}

// Krok 4: tnie JUŻ gotowy OCR (z sesji analizy) na osobne pliki wg zatwierdzonych
// bloków - OCR nigdy nie jest powtarzany - i, jesli podano `excelPath`, dopisuje
// po jednym wierszu na blok do wskazanej tabelki. body: { analysisId,
// files: [{ fileId }], excelPath? }. Wymaga wczesniejszego wywolania
// /api/ocr/extract-fields (uzywa fileEntry.resolvedBlocks, NIE surowego body) -
// jesli dla ktoregos bloku zostaly nierozstrzygniete pola do przegladu,
// finalizacja jest BLOKOWANA (wymaga tego kompletnosc tabelki, patrz plan).
app.post('/api/ocr/finalize', heavyJobLimiter, async (req, res) => {
  const { analysisId, files: requestedFiles, excelPath, family, overwriteConfirmed, mode, selectedKeys } = req.body || {};
  const fillExisting = mode === 'fill-existing';
  const analysis = analyses.get(analysisId);
  if (!analysis) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje - wgraj pliki ponownie.' });
  if (!Array.isArray(requestedFiles) || !requestedFiles.length) {
    return res.status(400).json({ ok: false, message: 'Brak plików do finalizacji.' });
  }
  if (excelPath) {
    try { validateExcelPath(excelPath); } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    if (family && !TABELA_FAMILIES[family]) {
      return res.status(400).json({ ok: false, message: 'Nieznana rodzina protokołu.' });
    }
    if (fillExisting) {
      // Tryb "wypelnij ta sama tabele" WYMAGA istniejacego pliku (przeciwnie
      // niz tryb "nowy plik" nizej) - nigdy nie tworzymy tu niczego od zera.
      if (!family) return res.status(400).json({ ok: false, message: 'Wybierz rodzaj protokołu (Pompy ciepła / Solary / Kotły).' });
      if (!fs.existsSync(excelPath)) return res.status(400).json({ ok: false, message: `Nie znaleziono pliku: ${excelPath}` });
    } else if (fs.existsSync(excelPath) && overwriteConfirmed !== true) {
      return res.status(409).json({
        ok: false,
        code: 'EXCEL_ALREADY_EXISTS',
        message: 'Plik Excel już istnieje. Wybierz inną nazwę albo potwierdź nadpisanie z kopią zapasową.'
      });
    }
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  const job = { id: jobId, createdAt: Date.now(), jobDir, uploadPaths: [] };
  jobs.set(jobId, job);

  try {
    await fsp.mkdir(jobDir, { recursive: true });
    const results = [];
    // Wiersze zbierane z CALEJ paczki (wszystkie wgrane pliki x wszystkie ich bloki-adresy)
    // i zapisywane JEDNYM writeFreshRows PO petli, zamiast po jednym appendRow na blok - patrz
    // komentarz w excelExport.js (nigdy nie doklejac do istniejacego pliku pod ta sciezka).
    const excelRows = [];
    // Tryb fillExisting: LP (etykieta bloku pelni ta role w tym trybie - patrz
    // app.js) -> fields, do pozniejszego fillExistingTableRows.
    const rowsByLp = new Map();

    for (const requested of requestedFiles) {
      const fileEntry = analysis.files.get(requested?.fileId);
      if (!fileEntry) {
        results.push({ ok: false, originalName: requested?.fileId || '?', error: 'Nie znaleziono pliku w sesji analizy.' });
        continue;
      }
      if (!fileEntry.resolvedBlocks?.length) {
        results.push({ ok: false, originalName: fileEntry.originalName, error: 'Najpierw sprawdź/uzupełnij dane pliku (krok "Uzupełnij dane").' });
        continue;
      }

      // isFieldApplicable wyklucza pola warunkowe (np. "zrodloCieplaInnyOpis"),
      // ktorych warunek nie jest spelniony - uzytkownik nigdy nie widzi takiego
      // wiersza w UI (patrz CONDITIONAL_FIELDS w app.js), wiec needsReview:true
      // zostawaloby tam na zawsze i blokowaloby pobranie kazdego pliku (real bug
      // zgloszony na zywo 2026-08-19, patrz komentarz przy isFieldApplicable).
      const unresolved = excelPath && fileEntry.resolvedBlocks.some((b) =>
        Object.entries(b.fields).some(([key, f]) => isFieldApplicable(b.fields, key) && (f.needsReview || !f.resolved)));
      if (unresolved) {
        results.push({ ok: false, originalName: fileEntry.originalName, error: 'Ten plik ma jeszcze nieuzupełnione pola - dokończ "Uzupełnij dane" przed pobraniem.' });
        continue;
      }

      try {
        const blocks = fileEntry.resolvedBlocks;
        const outPaths = dedupeOutPaths(blocks.map((b, i) => {
          const suffix = blocks.length > 1 ? ` - ${b.label || `blok ${i + 1}`}` : '';
          return path.join(jobDir, safeName(`${fileEntry.baseName}${suffix}.pdf`, `audyt-${i + 1}.pdf`));
        }));

        await finalizeSplit({
          sourcePdfPath: fileEntry.sourcePdfPath,
          blocks,
          outPaths
        });

        blocks.forEach((b, i) => {
          const outFileName = path.basename(outPaths[i]);
          const addressLabel = b.label || (blocks.length > 1 ? `Adres ${i + 1}` : fileEntry.originalName);

          let excelRow = false;
          const blockWarnings = warningsForBlock(fileEntry.warnings, b, blocks.length);
          if (excelPath && fillExisting) {
            const lp = String(b.label || '').trim();
            if (!lp) {
              blockWarnings.push('Brak numeru LP (pole "etykieta" na ekranie podziału) - dane audytu NIE trafiły do tabeli, uzupełnij ręcznie.');
            } else {
              rowsByLp.set(lp, b.fields);
              excelRow = true; // ostateczne dopasowanie do wiersza weryfikuje fillExistingTableRows (unmatchedLp)
            }
          } else if (excelPath) {
            if (family) {
              const addressRow = buildRowValues(family, b.fields);
              excelRows.push(addressRow);
            } else {
              const addressRow = { adres: addressLabel };
              for (const [key, field] of Object.entries(b.fields)) addressRow[key] = field.value || '';
              excelRows.push(addressRow);
            }
            excelRow = true;
          }

          results.push({
            ok: true,
            originalName: fileEntry.originalName,
            label: b.label || null,
            file: outFileName,
            url: `/api/jobs/${jobId}/files/${encodeURIComponent(outFileName)}`,
            status: fileEntry.status,
            pageRange: [b.startPage + 1, b.endPage + 1],
            pageCount: b.endPage - b.startPage + 1,
            warnings: blockWarnings,
            excelRow
          });
        });
      } catch (fileErr) {
        results.push({ ok: false, originalName: fileEntry.originalName, error: fileErr.message || 'Nie udało się zapisać pliku.' });
      }
    }

    // Jeden swiezy plik Excela dla CALEJ paczki (wszystkie wgrane pliki x wszystkie ich
    // bloki-adresy) - patrz komentarz w excelExport.js (2026-07-23, wlasciciel: "nie
    // powinno dopisywac do istniejacej tabelki tylko tworzyc nowa i jedna dla wszystkich
    // wyslanych adresow"). Zapisywane PO petli (nie per-blok), zeby jedno wywolanie
    // writeFreshRows objelo caly zestaw wierszy tej paczki naraz.
    let excelError = null;
    let excelBackupPath = null;
    let fillStats = null;
    if (excelPath && fillExisting) {
      // fillStats jest ZAWSZE ustawiane w tym trybie (nawet gdy rowsByLp jest
      // puste, np. zaden blok nie mial numeru LP) - frontend rozroznia tryb
      // po samej OBECNOSCI fillStats, nie po jego zawartosci.
      if (rowsByLp.size) {
        try {
          const familyAllowedKeys = allowedKeysForFamily(family);
          let allowedKeys = familyAllowedKeys;
          if (Array.isArray(selectedKeys)) {
            const requested = new Set(selectedKeys.map(String));
            allowedKeys = new Set([...familyAllowedKeys].filter((k) => requested.has(k)));
          }
          const written = await fillExistingTableRows(excelPath, family, rowsByLp, allowedKeys);
          excelBackupPath = written.backupPath;
          fillStats = { matchedRows: written.matchedRows, filledCells: written.filledCells, unmatchedLp: written.unmatchedLp };
        } catch (err) {
          excelError = err.message || 'Nie udało się zapisać pliku Excel.';
        }
      } else {
        fillStats = { matchedRows: 0, filledCells: 0, unmatchedLp: [] };
      }
    } else if (excelPath && excelRows.length) {
      try {
        if (family) {
          const definition = TABELA_FAMILIES[family];
          const written = await writeFamilyTemplateRows(
            definition.templateFile,
            excelPath,
            definition.sheetName,
            excelRows
          );
          excelBackupPath = written.backupPath;
        } else {
          const written = await writeFreshRows(excelPath, 'Audyty', COLUMN_ORDER, COLUMN_LABELS, excelRows);
          excelBackupPath = written.backupPath;
        }
      } catch (err) {
        excelError = err.message || 'Nie udało się zapisać pliku Excel.';
      }
    }

    // Sesja analizy NIE jest tu usuwana (dawniej: purgeAnalysis+analyses.delete zaraz po
    // finalizacji) - wlasciciel zglosil (2026-07-23), ze chce moc kliknac "Zapisz uklad
    // jako wzor" PO pobraniu gotowych plikow, nie tylko przed - natychmiastowe kasowanie
    // odcinalo to calkowicie (endpoint /api/ocr/save-template dostawal "sesja wygasla").
    // Sesja i tak zniknie sama przez istniejacy TTL (cleanupOldAnalyses, ANALYSIS_TTL_MS
    // = 2h domyslnie) - wystarczajaco duzo czasu, zeby po fakcie zdecydowac o wzorze.
    res.json({
      ok: true,
      jobId,
      results,
      excelPath: excelPath || null,
      excelBackupPath,
      excelRowCount: excelRows.length,
      excelError,
      fillStats
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get('/api/jobs/:id/files/:file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('Nie znaleziono zadania.');
  const file = safeName(req.params.file, 'plik.pdf');
  const filePath = path.join(job.jobDir, file);
  if (!filePath.startsWith(job.jobDir) || !fs.existsSync(filePath)) return res.status(404).send('Nie znaleziono pliku.');
  res.download(filePath, path.basename(filePath));
});

app.use((err, req, res, next) => {
  res.status(400).json({ ok: false, message: err.message || 'Błąd przetwarzania.' });
});

// require.main === module: uruchomienie serwera TYLKO gdy plik jest startowany
// bezposrednio (node server.js), nie gdy jest wymagany przez testy (test/*.test.js
// wymaga dedupeOutPaths ponizej i nie powinien przy tym bindowac portu).
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => console.log(`OCR audytów: http://${HOST}:${PORT}`));
  applyHttpTimeouts(server, 'OCR-AUDYTOW');
}

module.exports = { app, dedupeOutPaths, validateBlocks };
