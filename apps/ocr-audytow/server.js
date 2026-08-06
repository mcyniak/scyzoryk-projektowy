const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Jimp } = require('jimp');
const { setupProcessDiagnostics, applyHttpTimeouts, scheduleCleanup } = require('../../lib/hardening');
const { getAppDataDir } = require('../../lib/appPaths');
const { analyzeDocument, inspectDocument, finalizeSplit, buildFieldPreview, cropPageRegion, runWithGlobalOcrLimit } = require('./src/ocrPipeline');
const { isConfigured: isOcrConfigured, ocrImage: docAiOcrImage } = require('./src/documentAiEngine');
const { extractFields, extractSingleField, COLUMN_ORDER, COLUMN_LABELS } = require('./src/fieldExtraction');
const { writeFreshRows, writeFamilyTemplateRows, validatePath: validateExcelPath } = require('./src/excelExport');
const { TABELA_FAMILIES, buildRowValues, allowedKeysForFamily } = require('./src/tabelaAdresowaColumns');
const { loadTemplates, matchTemplate, extractFieldsFromTemplate, buildTemplateFromReview, harvestTemplateFields } = require('./src/templateEngine');
const { validateOcrBatchInspections } = require('./src/ocrLimits');
const { saveUserOcrConfig } = require('../../lib/ocrConfigMigration');

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
  const templates = await loadTemplates();
  res.json({ ok: true, name: 'ocr-audytow', ocrConfigured: isOcrConfigured(), templatesLoaded: templates.length });
});

// Ekran "OCR zablokowany" w public/index.html (pokazywany, gdy /api/health
// zwraca ocrConfigured:false) pozwala uzytkownikowi wgrac klucz konta
// serwisowego RECZNIE, bez potrzeby specjalnego instalatora z wbudowanym
// sekretem - patrz saveUserOcrConfig w lib/ocrConfigMigration.js (ten sam
// trwaly katalog %LOCALAPPDATA%\Scyzoryk co migracja z instalatora, wiec
// przezyje kolejne aktualizacje bez ponownego wpisywania). memoryStorage -
// plik klucza to kilka KB tekstu, nigdy nie musi dotknac dysku jako
// posrednia kopia w UPLOAD_DIR.
const credentialsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024, files: 1 } });
app.post('/api/ocr/setup-credentials', credentialsUpload.single('keyFile'), (req, res) => {
  try {
    if (!req.file) throw new Error('Wybierz plik klucza (service-account.json).');
    const saved = saveUserOcrConfig({
      keyFileContent: req.file.buffer.toString('utf8'),
      location: req.body?.location,
      processorId: req.body?.processorId,
      projectId: req.body?.projectId
    });
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się zapisać konfiguracji OCR.' });
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

// Krok 1/2: rozpoznaje tekst i - dla plikow, ktore tego wymagaly - proponuje
// podzial na bloki adresowe + miniatury stron do przegladu. NIC tu jeszcze nie
// trafia do pobrania - to robi dopiero /api/ocr/finalize po zatwierdzeniu
// (ewentualnie recznie poprawionego) podzialu przez uzytkownika.
// Uwaga (2026-07-24): celowo NIE ma tu gornego "if (!isOcrConfigured()) return 500" blokujacego
// caly batch - analyzeDocument() (ocrPipeline.js) juz ma swoj wlasny, poprawnie zawezony check,
// ktory rzuca TYLKO gdy dany plik faktycznie potrzebuje OCR-u (plik z juz istniejaca warstwa
// tekstu - np. eksport z aplikacji rodziny FLEXIPOWER - w ogole pomija OCR i nie dotyka
// isConfigured()). Gorna blokada psula wlasnie ten przypadek: caly upload odrzucany, mimo ze
// zaden z plikow nie potrzebowal skonfigurowanego Document AI. Per-plikowy try/catch ponizej i tak
// surowo przekazuje ten sam czytelny komunikat blad-per-plik, gdy OCR jest faktycznie wymagany.
app.post('/api/ocr/analyze', heavyJobLimiter, upload.array('files', MAX_FILES), async (req, res) => {
  const analysisId = crypto.randomUUID();
  const analysisDir = path.join(ANALYSIS_DIR, analysisId);
  // templateState kumuluje sie MIEDZY kolejnymi wywolaniami recalibrate-remaining (patrz
  // nizej, mergeHarvestedIntoTemplate) - NIE jest zastepowany za kazdym razem swiezym
  // wzorem z tylko-co-skonczonego bloku, zeby wiedza z WCZESNIEJSZYCH adresow (zwlaszcza
  // reczne zaznaczenia uzytkownika) nie ginela, gdy kolejny adres dostarczy nowy wzor.
  const analysis = { id: analysisId, createdAt: Date.now(), lastActivityAt: Date.now(), dir: analysisDir, files: new Map(), uploadPaths: [], templateState: { textFields: [], groupFields: [] } };

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
          ocrPdfPath: result.ocrPdfPath,
          avgConfidence: result.avgConfidence,
          warnings: result.warnings,
          blocks: result.blocks
        });
        results.push({
          ok: true,
          fileId,
          originalName: original,
          status: result.status,
          pageCount: result.pageCount,
          avgConfidence: result.avgConfidence,
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

app.get('/api/analysis/:analysisId/files/:fileId/field-preview/:file', (req, res) => {
  const fileEntry = analyses.get(req.params.analysisId)?.files.get(req.params.fileId);
  if (!fileEntry) return res.status(404).send('Nie znaleziono podglądu.');
  const previewDir = path.join(fileEntry.workDir, 'fields');
  const filePath = path.join(previewDir, safeName(req.params.file, 'field.jpg'));
  if (!filePath.startsWith(previewDir) || !fs.existsSync(filePath)) return res.status(404).send('Nie znaleziono podglądu.');
  res.sendFile(filePath);
});

// Pelny obraz jednej strony (nie miniatura 220px z /thumb/) - uzywany przez UI recznego
// zaznaczania pola (patrz /api/ocr/mark-field-region), gdzie potrzebna jest rozdzielczosc
// wystarczajaca do precyzyjnego zaznaczenia myszem. To TEN SAM plik, ktory pipeline juz
// zapisal w workDir (page-XXX.jpg) - zadnego nowego przetwarzania obrazu.
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

// Pola bez zadnej geometrii (etykieta tez nie znaleziona) dostaja "trywialny"
// wynik - puste, ale JUZ rozstrzygniete jako niewymagajace przegladu tylko
// dla plikow spoza rodziny szablonow, na ktorej opiera sie fieldExtraction.js
// (rodzina "juz ma tekst"/bez OCR - patrz status ponizej). Dla realnych
// plikow rodziny A/B kazde nieznalezione pole i tak trafia do przegladu -
// to jest zamierzone (patrz plan z 2026-07-21).
function trivialFields() {
  const fields = {};
  for (const key of COLUMN_ORDER) {
    if (key === 'adres') continue;
    fields[key] = { value: '', confidence: null, needsReview: true, resolved: false, pageIndex: null, labelBBox: null, valueBBox: null };
  }
  return fields;
}

// Druga proba OCR dla pol, ktore po pierwszym przebiegu wymagaja recznego
// przegladu (puste/niepewne) - wycina TYLKO obszar wokol tego pola (patrz
// cropPageRegion) i ponownie woła Document AI na tym mniejszym, izolowanym
// fragmencie, licząc na czystszy wynik bez szumu z reszty gestego
// formularza. Dziala dla CZESCI przypadkow (male, izolowane checkboxy typu
// "Moc kotla") - NIE naprawia przypadkow, gdzie kilka pol jest fizycznie
// zlepionych blisko siebie (maly kadr wokol nich nadal zawiera WSZYSTKIE, wiec
// to samo zlepienie) - swiadoma decyzja wlasciciela 2026-07-22 mimo tego
// ograniczenia, bo koszt (kolejne zapytanie Document AI) jest akceptowalny
// przy realnej skali, a czesciowa poprawa nadal zmniejsza liczbe pol do
// recznego uzupelnienia. Modyfikuje `field` W MIEJSCU (value/confidence/
// needsReview/resolved) TYLKO gdy nowy wynik jest lepszy - NIE zmienia
// labelBBox/valueBBox (te zostaja z pierwszego przebiegu, we wspolrzednych
// oryginalnej strony - wspolrzedne z przycietego fragmentu byłyby bledne po
// przeliczeniu na oryginalny obraz, a to i tak tylko przyblizony wskaznik
// "gdzie patrzec" dla podgladu, nie potrzebuje pelnej precyzji).
// Jimp.read() tego samego duzego JPEG-a od zera dla kazdego pola bylo najdrozsza czescia
// generowania podgladow - jeden cache per zadanie, dzielony miedzy wszystkie pola tej samej
// strony (patrz komentarz przy uzyciu w extract-fields/recalibrate-remaining).
function makePageImageLoader() {
  const pageImageCache = new Map();
  return async function loadPageImage(imagePath) {
    if (!pageImageCache.has(imagePath)) {
      pageImageCache.set(imagePath, await Jimp.read(imagePath));
    }
    return pageImageCache.get(imagePath);
  };
}

// Realny, powazny blad zlapany 2026-07-24 (na zywej sesji wlasciciela): zarowno
// /api/ocr/extract-fields (dopasowany zapisany wzor gminy) jak i /api/ocr/recalibrate-
// remaining (wzor zebrany w pamieci) uzywaly wyniku `extractFieldsFromTemplate` WPROST
// jako calego `block.fields` - a ten wynik zawiera WYLACZNIE klucze, ktore akurat
// pokrywa dany wzor. Kazde pole SPOZA wzoru (np. nowo dodany klucz FIELD_DEFS, ktorego
// zapisany wzor jeszcze nie zna, albo pole ktore po prostu nigdy nie mialo bboxa w
// zadnym wczesniej sprawdzonym adresie) znikalo CALKOWICIE - nie "wymagalo ponownego
// zaznaczenia", tylko bylo nieobecne w kolejce przegladu I w koncowym eksporcie, po
// cichu. Brakujace klucze musza dostac normalna (pelnostronicowa) ekstrakcje jako
// uzupelnienie - wspolne dla obu miejsc, zeby nie powtorzyc tego samego bledu gdziekolwiek
// indziej w przyszlosci.
function fillMissingFieldsFromTemplate(pages, block, templateFields, allowedKeys) {
  const expectedKeys = allowedKeys || new Set(COLUMN_ORDER.filter((k) => k !== 'adres'));
  const missingKeys = new Set([...expectedKeys].filter((k) => !(k in templateFields)));
  if (!missingKeys.size) return templateFields;
  const fallbackFields = extractFields(pages, block, missingKeys);
  return { ...fallbackFields, ...templateFields };
}

function normalizedBlockHeader(fileEntry, block) {
  const page = fileEntry.pages?.find((item) => item.pageIndex === block.startPage);
  return String(page?.ocrText || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 160);
}

function blockLayoutFingerprint(fileEntry, block) {
  return (fileEntry.pages || [])
    .filter((page) => page.pageIndex >= block.startPage && page.pageIndex <= block.endPage)
    .map((page) => `${Math.round((page.width || 0) / 50)}x${Math.round((page.height || 0) / 50)}`)
    .join('|');
}

function calibrationGroupKey({ fileEntry, block, forcedTemplate, usedTemplate }) {
  if (forcedTemplate?.id) return `manual-template:${forcedTemplate.id}`;
  if (usedTemplate?.id) return `matched-template:${usedTemplate.id}`;
  const header = normalizedBlockHeader(fileEntry, block);
  if (header.length >= 20) return `header:${header}`;
  const layout = blockLayoutFingerprint(fileEntry, block);
  if (layout) return `layout:${layout}`;
  return `file:${fileEntry.fileId}`;
}

// Buduje podglady (+ retry-with-crop dla pol NIE z wzoru) dla wszystkich pol needsReview
// jednego bloku - wydzielone z /api/ocr/extract-fields (2026-07-23), zeby ta sama logika
// dala sie reuzyc w /api/ocr/recalibrate-remaining bez duplikowania.
async function buildPreviewsForBlock({ fields, fileEntry, blockIndex, previewDir, analysisId, loadPageImage }) {
  for (const [key, field] of Object.entries(fields)) {
    if (!field.needsReview) continue;
    const refBBox = field.valueBBox || field.labelBBox;
    if (!refBBox || field.pageIndex === null) continue;
    const page = fileEntry.pages.find((p) => p.pageIndex === field.pageIndex);
    if (!page?.imagePath) continue;

    const sourceImage = await loadPageImage(page.imagePath);
    if (!field.fromTemplate) {
      await retryFieldWithCrop({ field, key, page, refBBox, sourceImage, previewDir, blockIndex });
    }

    const previewFile = `block${blockIndex}-${key}.jpg`;
    const builtPath = await buildFieldPreview({
      pageImagePath: page.imagePath,
      labelBBox: field.labelBBox,
      valueBBox: field.valueBBox,
      outPath: path.join(previewDir, previewFile),
      sourceImage
    });
    if (builtPath) {
      field.previewUrl = `/api/analysis/${analysisId}/files/${fileEntry.fileId}/field-preview/${encodeURIComponent(previewFile)}`;
    }
  }
}

async function retryFieldWithCrop({ field, key, page, refBBox, sourceImage, previewDir, blockIndex }) {
  const cropPath = path.join(previewDir, `_retry-block${blockIndex}-${key}.jpg`);
  try {
    const built = await cropPageRegion({ pageImagePath: page.imagePath, bbox: refBBox, outPath: cropPath, sourceImage });
    if (!built) return;
    const { text, words, formFields, tables, visualElements } = await runWithGlobalOcrLimit(() => docAiOcrImage(cropPath));
    const miniPage = { pageIndex: field.pageIndex, ocrText: text, ocrWords: words, formFields: formFields || [], tables: tables || [], visualElements: visualElements || [] };
    const retried = extractSingleField(miniPage, key);
    if (!retried) return;
    // "Lepszy" = ma wartosc, ktorej wczesniej nie bylo, ALBO ta sama/inna
    // wartosc z WYZSZA pewnoscia niz oryginal - nigdy nie podmieniamy na
    // gorszy/mniej pewny wynik.
    const better = retried.value && (!field.value || (retried.confidence ?? 0) > (field.confidence ?? 0));
    if (better) {
      field.value = retried.value;
      field.confidence = retried.confidence;
      field.needsReview = retried.needsReview;
      field.resolved = retried.resolved;
    }
  } catch (_) {
    // Druga proba jest czysto "best effort" - jej blad (np. przejsciowy
    // problem z Document AI) nigdy nie moze zepsuc calego przegladu pol,
    // pole po prostu zostaje przy wyniku z pierwszego przebiegu.
  } finally {
    await fsp.unlink(cropPath).catch(() => {});
  }
}

// Krok 3: dla kazdego ZATWIERDZONEGO bloku wyciaga pola formularza (patrz
// src/fieldExtraction.js) i generuje podglady z zaznaczeniem dla tych, ktore
// wymagaja recznego przegladu (puste ALBO niska pewnosc). Wynik zapisywany w
// sesji analizy (fileEntry.resolvedBlocks) - finalize pozniej korzysta z
// TYCH danych, nie z surowego body zadania, zeby wymusic ze tabelka faktycznie
// jest kompletna (patrz walidacja w /api/ocr/finalize).
// Lista zapisanych wzorow gmin (data/templates/*.json) - dotad NIGDZIE nie byla widoczna
// dla uzytkownika (dopasowanie po naglowku dzialo w pelni automatycznie/po cichu, bez
// zadnego potwierdzenia czy w ogole cos sie dopasowalo) - wlasciciel: "czemu jak sobie
// zapisalem wczesniej szablon dla gminy to nigdzie nie moge go wybrac". Uzywane przez UI
// do pokazania listy + pozwolenia na RECZNE wymuszenie konkretnego wzoru (patrz
// templateId nizej w /api/ocr/extract-fields), zamiast polegac wylacznie na automatycznym
// dopasowaniu po tekscie naglowka.
app.get('/api/ocr/templates', async (req, res) => {
  try {
    const templates = await loadTemplates();
    res.json({
      ok: true,
      templates: templates.map((t) => ({
        id: t.id,
        label: t.label,
        textFieldsCount: (t.textFields || []).length,
        groupFieldsCount: (t.groupFields || []).length
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Nie udało się wczytać listy wzorów.' });
  }
});

app.post('/api/ocr/extract-fields', heavyJobLimiter, async (req, res) => {
  const { analysisId, files: requestedFiles, family, templateId } = req.body || {};
  const analysis = analyses.get(analysisId);
  if (!analysis) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje - wgraj pliki ponownie.' });
  if (!Array.isArray(requestedFiles) || !requestedFiles.length) {
    return res.status(400).json({ ok: false, message: 'Brak plików do przetworzenia.' });
  }
  if (family && !TABELA_FAMILIES[family]) {
    return res.status(400).json({ ok: false, message: 'Nieznana rodzina protokołu.' });
  }
  // Zawezenie ekstrakcji/przegladu TYLKO do pol potrzebnych tabelce adresowej
  // wybranej rodziny (2026-07-23, na wyrazna prosbe wlasciciela - dawniej
  // przegladano WSZYSTKIE ~44 pola FIELD_DEFS niezaleznie od tego, czy trafiaja
  // gdziekolwiek dalej) - null (brak wybranej rodziny) zachowuje stare, pelne
  // zachowanie bez zmian.
  const allowedKeys = family ? allowedKeysForFamily(family) : null;

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
        const previewDir = path.join(fileEntry.workDir, 'fields');
        await fsp.mkdir(previewDir, { recursive: true });
        const loadPageImage = makePageImageLoader();

        // Rozpoznanie znanego wzoru gminy (patrz src/templateEngine.js) - jesli dopasuje,
        // pola tego bloku leca przez szybsza, kalibrowana sciezke (wyciecie z gory znanego
        // miejsca zamiast pelnego przebiegu Document AI na calej stronie). Wczytywane na
        // swiezo przy kazdym zadaniu (nie cache'owane w pamieci procesu), zeby wzor
        // zapisany chwile wczesniej przez "Zapisz uklad jako wzor" byl od razu widoczny bez
        // restartu serwera - biblioteka jest mala (kilkanascie plikow), wiec koszt odczytu
        // jest pomijalny.
        const knownTemplates = fileEntry.status === 'ocr-done' && fileEntry.pages ? await loadTemplates() : [];
        // Uzytkownik moze RECZNIE wymusic konkretny, zapisany wzor (patrz GET
        // /api/ocr/templates + selektor w UI, 2026-07-24 - wczesniej dopasowanie po
        // naglowku dzialo w 100% automatycznie/po cichu, bez zadnego sposobu na
        // podejrzenie listy wzorow albo wybranie innego niz automat by wybral). Jesli
        // podany templateId nie istnieje (np. wzor skasowany miedzyczasie), po cichu
        // wraca do automatycznego dopasowania zamiast twardego bledu.
        const forcedTemplate = templateId ? knownTemplates.find((t) => t.id === templateId) : null;

        const resolvedBlocks = [];
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
          const block = blocks[blockIndex];
          let fields;
          let usedTemplate = null;
          if (fileEntry.status === 'ocr-done' && fileEntry.pages) {
            usedTemplate = forcedTemplate || matchTemplate(fileEntry.pages, block, knownTemplates);
            fields = usedTemplate
              ? fillMissingFieldsFromTemplate(fileEntry.pages, block, await extractFieldsFromTemplate(fileEntry.pages, block, usedTemplate, { workDir: previewDir, allowedKeys }), allowedKeys)
              : extractFields(fileEntry.pages, block, allowedKeys);
          } else {
            fields = trivialFields();
          }

          await buildPreviewsForBlock({ fields, fileEntry, blockIndex, previewDir, analysisId, loadPageImage });

          resolvedBlocks.push({
            ...block,
            blockIndex,
            fields,
            matchedTemplateLabel: usedTemplate?.label || null,
            calibrationGroupKey: calibrationGroupKey({ fileEntry, block, forcedTemplate, usedTemplate })
          });
        }

        fileEntry.resolvedBlocks = resolvedBlocks;

        results.push({
          ok: true,
          fileId: fileEntry.fileId,
          originalName: fileEntry.originalName,
          blocks: resolvedBlocks.map((b) => ({
            blockIndex: b.blockIndex,
            startPage: b.startPage,
            endPage: b.endPage,
            label: b.label,
            matchedTemplateLabel: b.matchedTemplateLabel,
            fields: Object.fromEntries(Object.entries(b.fields).map(([key, f]) => [key, {
              value: f.value,
              confidence: f.confidence,
              needsReview: f.needsReview,
              resolved: f.resolved,
              previewUrl: f.previewUrl || null,
              pageIndex: f.pageIndex,
              columnLabel: COLUMN_LABELS[key] || key
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

// Laczy nowo zharwestowany wzor z JEDNEGO wlasnie skonczonego adresu z JUZ zgromadzonym
// stanem CALEJ sesji (analysis.templateState) - stan ROSNIE (nie jest zastepowany) w miare
// kolejnych adresow, zeby wiedza z WCZESNIEJSZYCH adresow nie ginela, gdy kolejny adres
// dostarczy nowy (czesciowy) wzor. Realny problem zlapany 2026-07-24 (wlasciciel: "jak juz
// raz zaznacze to [pole] to sie po prostu nie zapisuje... jak uzytkownik to zaznaczyl, to
// powinien uzywac tego w pierwszej kolejnosci") - reczne zaznaczenie (textFields entry z
// manual:true, patrz harvestTemplateFields w templateEngine.js) ZAWSZE wygrywa: raz
// zapisane reczne NIGDY nie jest nadpisywane przez pozniejszy automat, a nowy reczny
// PODMIENIA wczesniejszy automat dla tego samego klucza. Automatyczne (niereczne) wpisy
// trzymaja sie prostej zasady "kto pierwszy sie uda" - nie ma sensu zamieniac jednego
// zgadywania na inne rownie niepewne.
function mergeHarvestedIntoTemplate(templateState, harvested) {
  const textByKey = new Map(templateState.textFields.map((e) => [e.key, e]));
  for (const entry of harvested.textFields) {
    const already = textByKey.get(entry.key);
    if (already?.manual) continue;
    if (!already || entry.manual) {
      textByKey.set(entry.key, entry);
      templateState.groupFields = templateState.groupFields
        .map((g) => ({ ...g, keys: g.keys.filter((k) => k !== entry.key) }))
        .filter((g) => g.keys.length);
    }
  }
  templateState.textFields = Array.from(textByKey.values());

  const coveredKeys = new Set([...textByKey.keys(), ...templateState.groupFields.flatMap((g) => g.keys)]);
  for (const group of harvested.groupFields) {
    const newKeys = group.keys.filter((k) => !coveredKeys.has(k));
    if (newKeys.length) {
      templateState.groupFields.push({ ...group, keys: newKeys });
      newKeys.forEach((k) => coveredKeys.add(k));
    }
  }
  return templateState;
}

// Wykorzystuje JUZ zrecenzowany (przez czlowieka) blok jako wzor dla POZOSTALYCH blokow tej
// samej paczki (wszystkie pliki/adresy tej sesji analizy, bez wzgledu na to, w ktorym pliku
// siedza) - patrz plan z 2026-07-23 (wlasciciel: "wykorzystaj jeden sprawdzony adres jako
// wzor dla pozostalych w TYM SAMYM pliku, to tez zmniejszy ile trzeba zaznaczac recznie").
// W odroznieniu od "Zapisz uklad jako wzor" (POST /api/ocr/save-template) - NIC nie zapisuje
// do data/templates/ (harvestTemplateFields uzyty tu w pamieci, patrz komentarz w
// templateEngine.js) - stosowany wprost do pozostalych blokow, bez przechodzenia przez
// matchTemplate/naglowek. Wywolywane przez klienta PO KAZDYM skonczonym bloku (nie tylko
// pierwszym - patrz app.js), zeby kolejne adresy mogly nadgonic to, czego wczesniejszy
// adres nie zdolal zlokalizowac.
app.post('/api/ocr/recalibrate-remaining', heavyJobLimiter, async (req, res) => {
  const { analysisId, sourceFileId, sourceBlockIndex, family } = req.body || {};
  const analysis = analyses.get(analysisId);
  if (!analysis) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje.' });
  const sourceFileEntry = analysis.files.get(sourceFileId);
  const sourceBlock = sourceFileEntry?.resolvedBlocks?.[sourceBlockIndex];
  if (!sourceFileEntry || !sourceBlock) return res.status(400).json({ ok: false, message: 'Nie znaleziono bloku źródłowego.' });
  if (family && !TABELA_FAMILIES[family]) return res.status(400).json({ ok: false, message: 'Nieznana rodzina protokołu.' });
  const allowedKeys = family ? allowedKeysForFamily(family) : null;

  let harvested;
  try {
    harvested = harvestTemplateFields({ pages: sourceFileEntry.pages, block: sourceBlock, fields: sourceBlock.fields });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || 'Nie udało się skalibrować z tego adresu.' });
  }
  const sourceGroupKey = sourceBlock.calibrationGroupKey || `file:${sourceFileEntry.fileId}`;
  if (!analysis.templateStates) analysis.templateStates = new Map();
  const templateState = analysis.templateStates.get(sourceGroupKey) || { textFields: [], groupFields: [] };
  mergeHarvestedIntoTemplate(templateState, harvested);
  analysis.templateStates.set(sourceGroupKey, templateState);
  if (!templateState.textFields.length && !templateState.groupFields.length) {
    return res.json({ ok: true, updatedBlocks: [] });
  }
  const inMemoryTemplate = { textFields: templateState.textFields, groupFields: templateState.groupFields };
  const loadPageImage = makePageImageLoader();

  const updatedBlocks = [];
  for (const fileEntry of analysis.files.values()) {
    if (!fileEntry.resolvedBlocks?.length || !fileEntry.pages) continue;
    for (let blockIndex = 0; blockIndex < fileEntry.resolvedBlocks.length; blockIndex++) {
      if (fileEntry.fileId === sourceFileId && blockIndex === sourceBlockIndex) continue;
      const block = fileEntry.resolvedBlocks[blockIndex];
      if (block.calibrationGroupKey !== sourceGroupKey) continue;
      // Realny problem zlapany 2026-07-24: to wywolanie teraz odpala sie PO KAZDYM
      // bloku (nie tylko raz po pierwszym - patrz app.js), zeby pole, ktorego adres 1
      // nie zdolal zlokalizowac (uzytkownik po prostu wpisal wartosc recznie, bez
      // zaznaczania), moglo zostac zlapane z KOLEJNEGO adresu, ktory akurat sie udal -
      // zamiast zeby uzytkownik musial poprawiac to samo pole w kazdym pozostalym
      // adresie z osobna. Ale to oznacza, ze blok moze byc JUZ CZESCIOWO/CALKOWICIE
      // przejrzany przez uzytkownika w momencie kolejnego wywolania - nie wolno
      // nadpisywac takiego bloku (zgubilibysmy juz wpisane odpowiedzi).
      //
      // Realny blad #2 zlapany 2026-07-24 (na zywej sesji wlasciciela): pierwsza wersja
      // tego sprawdzenia patrzyla na `field.resolved` w KTORYMKOLWIEK polu bloku - ale
      // pola z wysoka pewnoscia dostaja resolved:true JUZ przy pierwszej automatycznej
      // ekstrakcji (extract-fields), ZANIM uzytkownik w ogole zobaczy ten blok. To
      // znaczylo, ze `alreadyTouched` wychodzil `true` dla prawie kazdego bloku od razu
      // po starcie calej analizy - rekalibracja NIGDY nie mialismy szans zadzialac,
      // dokladnie objaw zgloszony przez wlasciciela ("dalej trzeba zaznaczac podglady").
      // Naprawka: osobna flaga NA POZIOMIE BLOKU (`block.userReviewed`), ustawiana
      // wylacznie przez /api/ocr/resolve-field i /api/ocr/mark-field-region - czyli
      // faktyczna interakcje uzytkownika z TYM blokiem, nie stan pojedynczych pol.
      if (block.userReviewed) continue;
      const previewDir = path.join(fileEntry.workDir, 'fields');
      await fsp.mkdir(previewDir, { recursive: true });

      let fields;
      try {
        fields = fillMissingFieldsFromTemplate(
          fileEntry.pages, block,
          await extractFieldsFromTemplate(fileEntry.pages, block, inMemoryTemplate, { workDir: previewDir, allowedKeys }),
          allowedKeys
        );
      } catch (err) {
        continue; // best-effort - ten blok zostaje przy poprzedniej (mniej skalibrowanej) ekstrakcji
      }
      await buildPreviewsForBlock({ fields, fileEntry, blockIndex, previewDir, analysisId, loadPageImage });

      block.fields = fields;
      updatedBlocks.push({
        fileId: fileEntry.fileId,
        blockIndex,
        fields: Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, {
          value: f.value,
          confidence: f.confidence,
          needsReview: f.needsReview,
          resolved: f.resolved,
          previewUrl: f.previewUrl || null,
          pageIndex: f.pageIndex,
          columnLabel: COLUMN_LABELS[key] || key
        }]))
      });
    }
  }

  res.json({ ok: true, updatedBlocks });
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
  // Odroznia "uzytkownik faktycznie przejrzal ten blok" od "pole akurat wyszlo
  // resolved:true z automatycznej ekstrakcji" (patrz komentarz przy alreadyTouched
  // w /api/ocr/recalibrate-remaining) - flaga na poziomie BLOKU, nie pola.
  block.userReviewed = true;
  res.json({ ok: true });
});

// Reczne zaznaczenie miejsca pola na skanie, gdy automatyczna ekstrakcja nie znalazla ani
// labelBBox ani valueBBox ("Nie udalo sie zlokalizowac tego pola na skanie" w UI) - patrz
// plan "Reczne zaznaczanie pola na skanie". Zapisuje prostokat jako valueBBox TEGO pola w
// dokladnie tym samym miejscu (`fileEntry.resolvedBlocks[...].fields[...]`), z ktorego
// buildTemplateFromReview juz dzis czyta przy "Zapisz uklad jako wzor" - zero dodatkowych
// zmian potrzebnych, zeby reczne zaznaczenie trafilo do wzoru gminy.
app.post('/api/ocr/mark-field-region', async (req, res) => {
  const { analysisId, fileId, blockIndex, fieldKey, pageIndex, region } = req.body || {};
  const fileEntry = analyses.get(analysisId)?.files.get(fileId);
  if (!fileEntry) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje.' });
  const block = fileEntry.resolvedBlocks?.[blockIndex];
  if (!block || !block.fields[fieldKey]) return res.status(400).json({ ok: false, message: 'Nie znaleziono wskazanego pola.' });

  const pIdx = Number(pageIndex);
  const page = fileEntry.pages?.find((p) => p.pageIndex === pIdx);
  if (!page?.imagePath) return res.status(400).json({ ok: false, message: 'Nie znaleziono wskazanej strony.' });

  const { minX, minY, maxX, maxY } = region || {};
  const valid = [minX, minY, maxX, maxY].every((n) => typeof n === 'number' && Number.isFinite(n))
    && minX >= 0 && minY >= 0 && minX < maxX && minY < maxY && maxX <= page.width && maxY <= page.height;
  if (!valid) return res.status(400).json({ ok: false, message: 'Nieprawidłowy zaznaczony obszar.' });

  block.fields[fieldKey] = {
    ...block.fields[fieldKey],
    pageIndex: pIdx,
    labelBBox: null,
    valueBBox: { minX, minY, maxX, maxY },
    // Uzytkownik SAM wskazal to miejsce - przy harwestowaniu wzoru (recalibrate-remaining)
    // taki region ZAWSZE wygrywa z automatycznym zgadywaniem dla innych adresow, nawet
    // jesli automat "cos" znalazl gdzie indziej (patrz mergeHarvestedIntoTemplate).
    manuallyMarked: true
  };
  block.userReviewed = true;

  try {
    const previewDir = path.join(fileEntry.workDir, 'fields');
    await fsp.mkdir(previewDir, { recursive: true });
    const previewFile = `block${blockIndex}-${fieldKey}.jpg`;
    const builtPath = await buildFieldPreview({
      pageImagePath: page.imagePath,
      labelBBox: null,
      valueBBox: { minX, minY, maxX, maxY },
      outPath: path.join(previewDir, previewFile)
    });
    if (!builtPath) return res.status(500).json({ ok: false, message: 'Nie udało się wygenerować podglądu zaznaczonego obszaru.' });
    block.fields[fieldKey].previewUrl = `/api/analysis/${analysisId}/files/${fileEntry.fileId}/field-preview/${encodeURIComponent(previewFile)}`;
    res.json({ ok: true, previewUrl: block.fields[fieldKey].previewUrl });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Nie udało się zapisać zaznaczenia.' });
  }
});

// Regex-escape'owana etykieta uzytkownika, ze spacjami zamienionymi na "dowolna
// ilosc bialych znakow" - naglowek protokolu bywa lamany na kilka linii/spacji
// inaczej niz w tym, co uzytkownik wpisal.
// Kazde slowo dluzsze niz 4 znaki jest obcinane do ~75% swojej dlugosci + "\S*"
// na koncu - realny blad zlapany 2026-07-23: Document AI czasem myli sie na
// OSTATNICH znakach dlugiego slowa w naglowku (np. "Biskupi" odczytane jako
// "BiskupŁ™"), co z ISCISLYM dopasowaniem calego slowa powodowalo, ze
// dopasowanie wzoru CALKOWICIE zawodzilo (matchTemplate zwracal null), a caly
// blok cichutko spadal na starsza, mniej dokladna sciezke ekstrakcji zamiast
// tylko tego jednego pola. Tolerowanie literowki na koncu slowa (nie na
// poczatku - tam bledy sa rzadsze, OCR zwykle traci pewnosc pod koniec
// dlugiego tokenu) znaczaco zmniejsza ryzyko takiego calkowitego niedopasowania.
function buildHeaderPattern(label) {
  const words = String(label || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = words.map((w) => {
    if (w.length <= 4) return escapeRegex(w);
    const keep = Math.max(4, Math.ceil(w.length * 0.75));
    return `${escapeRegex(w.slice(0, keep))}\\S*`;
  });
  return parts.join('\\s+');
}

// Kalibracja nowego "wzoru gminy" (patrz src/templateEngine.js) z JUZ zrecenzowanego przez
// czlowieka bloku - harvestuje labelBBox/valueBBox kazdego pola jako uamki strony. Uzytkownik
// podaje jedna etykiete, uzywana jednoczesnie jako nazwa wyswietlana I jako wzorzec
// rozpoznawania naglowka (musi wiec byc charakterystycznym fragmentem naglowka protokolu,
// np. nazwa gminy - nie dowolnym opisem).
app.post('/api/ocr/save-template', async (req, res) => {
  const { analysisId, fileId, blockIndex, label } = req.body || {};
  const fileEntry = analyses.get(analysisId)?.files.get(fileId);
  if (!fileEntry) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje.' });
  const block = fileEntry.resolvedBlocks?.[blockIndex];
  if (!block) return res.status(400).json({ ok: false, message: 'Nie znaleziono wskazanego bloku - najpierw uzupełnij dane.' });
  const cleanLabel = typeof label === 'string' ? label.trim().slice(0, 120) : '';
  if (!cleanLabel) return res.status(400).json({ ok: false, message: 'Podaj nazwę wzoru (np. nazwę gminy z nagłówka protokołu).' });

  try {
    const template = await buildTemplateFromReview({
      pages: fileEntry.pages,
      block,
      fields: block.fields,
      label: cleanLabel,
      headerPattern: buildHeaderPattern(cleanLabel)
    });
    res.json({ ok: true, templateId: template.id, textFieldsCount: template.textFields.length, groupFieldsCount: template.groupFields.length });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Nie udało się zapisać wzoru.' });
  }
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
  const { analysisId, files: requestedFiles, excelPath, family, overwriteConfirmed } = req.body || {};
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
    if (fs.existsSync(excelPath) && overwriteConfirmed !== true) {
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

      const unresolved = excelPath && fileEntry.resolvedBlocks.some((b) => Object.values(b.fields).some((f) => f.needsReview || !f.resolved));
      if (unresolved) {
        results.push({ ok: false, originalName: fileEntry.originalName, error: 'Ten plik ma jeszcze nieuzupełnione pola - dokończ "Uzupełnij dane" przed pobraniem.' });
        continue;
      }

      try {
        const blocks = fileEntry.resolvedBlocks;
        const outPaths = dedupeOutPaths(blocks.map((b, i) => {
          const suffix = blocks.length > 1 ? ` - ${b.label || `blok ${i + 1}`}` : '';
          return path.join(jobDir, safeName(`${fileEntry.baseName}${suffix} (OCR).pdf`, `audyt-${i + 1}.pdf`));
        }));

        await finalizeSplit({
          sourcePdfPath: fileEntry.sourcePdfPath,
          ocrPdfPath: fileEntry.ocrPdfPath,
          pages: fileEntry.pages,
          blocks,
          outPaths
        });

        blocks.forEach((b, i) => {
          const outFileName = path.basename(outPaths[i]);
          const addressLabel = b.label || (blocks.length > 1 ? `Adres ${i + 1}` : fileEntry.originalName);

          if (excelPath) {
            if (family) {
              const addressRow = buildRowValues(family, b.fields);
              excelRows.push(addressRow);
            } else {
              const addressRow = { adres: addressLabel };
              for (const [key, field] of Object.entries(b.fields)) addressRow[key] = field.value || '';
              excelRows.push(addressRow);
            }
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
            avgConfidence: fileEntry.avgConfidence,
            warnings: warningsForBlock(fileEntry.warnings, b, blocks.length),
            excelRow: excelPath ? true : false
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
    if (excelPath && excelRows.length) {
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
    res.json({ ok: true, jobId, results, excelPath: excelPath || null, excelBackupPath, excelRowCount: excelRows.length, excelError });
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
