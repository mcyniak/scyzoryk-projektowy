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
const { analyzeDocument, finalizeSplit, buildFieldPreview } = require('./src/ocrPipeline');
const { isConfigured: isOcrConfigured } = require('./src/documentAiEngine');
const { extractFields, COLUMN_ORDER, COLUMN_LABELS } = require('./src/fieldExtraction');
const { appendRow, validatePath: validateExcelPath } = require('./src/excelExport');

const app = express();
const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
setupProcessDiagnostics('ocr-audytow', ROOT);

const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');
const MAX_FILE_MB = Number(process.env.OCR_MAX_FILE_MB || 100);
const MAX_FILES = Number(process.env.OCR_MAX_FILES || 20);
const JOB_TTL_MS = Number(process.env.OCR_JOB_TTL_MS || 24 * 60 * 60 * 1000);
// Krotszy TTL niz JOB_TTL_MS: sesja analizy to tylko przegladanie/poprawianie
// podzialu na bloki przed pobraniem, nie docelowe miejsce przechowywania plikow -
// nie ma powodu trzymac jej godzinami tak jak juz gotowe wyniki w OUTPUT_DIR.
const ANALYSIS_TTL_MS = Number(process.env.OCR_ANALYSIS_TTL_MS || 2 * 60 * 60 * 1000);

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR, ANALYSIS_DIR]) fs.mkdirSync(dir, { recursive: true });
scheduleCleanup([UPLOAD_DIR, OUTPUT_DIR], JOB_TTL_MS, 60 * 60 * 1000);

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

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'ocr-audytow', ocrConfigured: isOcrConfigured() }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.OCR_API_RATE_LIMIT || 60),
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

app.use(express.static(path.join(ROOT, 'public')));

const jobs = new Map();
// analysisId -> { id, createdAt, dir, files: Map(fileId -> {...}) } - stan miedzy
// /api/ocr/analyze (rozpoznanie + propozycja podzialu na bloki) a
// /api/ocr/finalize (zatwierdzony, ewentualnie recznie poprawiony podzial) -
// patrz src/ocrPipeline.js.
const analyses = new Map();

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

function safeName(name, fallback = 'plik') {
  const cleaned = sanitize(String(name || fallback)).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return (cleaned || fallback).slice(0, 150);
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
  for (const fileEntry of analysis.files.values()) {
    await fsp.rm(fileEntry.sourcePdfPath, { force: true }).catch(() => {});
  }
}

async function cleanupOldAnalyses() {
  const now = Date.now();
  for (const [id, analysis] of analyses) {
    if (now - analysis.createdAt <= ANALYSIS_TTL_MS) continue;
    await purgeAnalysis(analysis);
    analyses.delete(id);
  }
}
setInterval(() => cleanupOldAnalyses().catch(err => console.error('[ocr-analysis-cleanup]', err?.message || err)), 15 * 60 * 1000).unref();

// Krok 1/2: rozpoznaje tekst i - dla plikow, ktore tego wymagaly - proponuje
// podzial na bloki adresowe + miniatury stron do przegladu. NIC tu jeszcze nie
// trafia do pobrania - to robi dopiero /api/ocr/finalize po zatwierdzeniu
// (ewentualnie recznie poprawionego) podzialu przez uzytkownika.
app.post('/api/ocr/analyze', heavyJobLimiter, upload.array('files', MAX_FILES), async (req, res) => {
  if (!isOcrConfigured()) {
    return res.status(500).json({ ok: false, message: 'Brak konfiguracji Google Document AI na tym serwerze (zmienne środowiskowe OCR_DOCAI_KEY_FILE/OCR_DOCAI_PROJECT_ID/OCR_DOCAI_LOCATION/OCR_DOCAI_PROCESSOR_ID). Skontaktuj się z administratorem.' });
  }

  const analysisId = crypto.randomUUID();
  const analysisDir = path.join(ANALYSIS_DIR, analysisId);
  const analysis = { id: analysisId, createdAt: Date.now(), dir: analysisDir, files: new Map() };

  try {
    const files = req.files || [];
    if (!files.length) throw new Error('Dodaj przynajmniej jeden plik PDF.');
    for (const file of files) validatePdf(file);

    await fsp.mkdir(analysisDir, { recursive: true });
    analyses.set(analysisId, analysis);

    const results = [];
    for (const file of files) {
      const fileId = crypto.randomUUID();
      const original = decodeOriginalName(file.originalname || path.basename(file.path));
      const baseName = safeName(path.basename(original, path.extname(original)), 'audyt');
      const workDir = path.join(analysisDir, fileId);
      try {
        const result = await analyzeDocument({ sourcePdfPath: file.path, workDir, lang: 'pol' });
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
    fields[key] = { value: '', confidence: null, needsReview: false, resolved: true, pageIndex: null, labelBBox: null, valueBBox: null };
  }
  return fields;
}

// Krok 3: dla kazdego ZATWIERDZONEGO bloku wyciaga pola formularza (patrz
// src/fieldExtraction.js) i generuje podglady z zaznaczeniem dla tych, ktore
// wymagaja recznego przegladu (puste ALBO niska pewnosc). Wynik zapisywany w
// sesji analizy (fileEntry.resolvedBlocks) - finalize pozniej korzysta z
// TYCH danych, nie z surowego body zadania, zeby wymusic ze tabelka faktycznie
// jest kompletna (patrz walidacja w /api/ocr/finalize).
app.post('/api/ocr/extract-fields', heavyJobLimiter, async (req, res) => {
  const { analysisId, files: requestedFiles } = req.body || {};
  const analysis = analyses.get(analysisId);
  if (!analysis) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje - wgraj pliki ponownie.' });
  if (!Array.isArray(requestedFiles) || !requestedFiles.length) {
    return res.status(400).json({ ok: false, message: 'Brak plików do przetworzenia.' });
  }

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

        // Kazda strona bywa uzywana przez dziesiatki pol (wiele
        // brakujacych/niepewnych pol trafia na te sama strone formularza) -
        // dekodowanie tego samego duzego JPEG-a od zera dla kazdego z nich
        // bylo najdrozsza czescia calego generowania podgladow (Jimp jest
        // czystym JS, bez natywnego kodu) - dekodujemy raz per strona i
        // podajemy juz-zdekodowany obraz do buildFieldPreview (patrz
        // sourceImage w ocrPipeline.js), zamiast raz na kazde pole.
        const pageImageCache = new Map();
        async function loadPageImage(imagePath) {
          if (!pageImageCache.has(imagePath)) {
            pageImageCache.set(imagePath, await Jimp.read(imagePath));
          }
          return pageImageCache.get(imagePath);
        }

        const resolvedBlocks = [];
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
          const block = blocks[blockIndex];
          const fields = fileEntry.status === 'ocr-done' && fileEntry.pages ? extractFields(fileEntry.pages, block) : trivialFields();

          for (const [key, field] of Object.entries(fields)) {
            if (!field.needsReview) continue;
            const refBBox = field.valueBBox || field.labelBBox;
            if (!refBBox || field.pageIndex === null) continue;
            const page = fileEntry.pages.find((p) => p.pageIndex === field.pageIndex);
            if (!page?.imagePath) continue;
            const previewFile = `block${blockIndex}-${key}.jpg`;
            const sourceImage = await loadPageImage(page.imagePath);
            const builtPath = await buildFieldPreview({
              pageImagePath: page.imagePath,
              labelBBox: field.labelBBox,
              valueBBox: field.valueBBox,
              outPath: path.join(previewDir, previewFile),
              sourceImage
            });
            // buildFieldPreview zwraca null, jesli nie udalo sie wygenerowac
            // podgladu (patrz jej wlasny komentarz) - poprzednio previewUrl
            // bylo ustawiane BEZWARUNKOWO, wiec przeglądarka probowala
            // wczytac obrazek, ktory nigdy nie zostal zapisany na dysk =
            // zepsuta ikonka zamiast czytelnego komunikatu "nie udalo sie
            // zlokalizowac" (realny bug zgloszony przez wlasciciela
            // 2026-07-22 - "większość tych podglądów było popsute").
            if (builtPath) {
              field.previewUrl = `/api/analysis/${analysisId}/files/${fileEntry.fileId}/field-preview/${encodeURIComponent(previewFile)}`;
            }
          }

          resolvedBlocks.push({ ...block, blockIndex, fields });
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
            fields: Object.fromEntries(Object.entries(b.fields).map(([key, f]) => [key, {
              value: f.value,
              confidence: f.confidence,
              needsReview: f.needsReview,
              resolved: f.resolved,
              previewUrl: f.previewUrl || null,
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
  const { analysisId, files: requestedFiles, excelPath } = req.body || {};
  const analysis = analyses.get(analysisId);
  if (!analysis) return res.status(404).json({ ok: false, message: 'Sesja analizy wygasła lub nie istnieje - wgraj pliki ponownie.' });
  if (!Array.isArray(requestedFiles) || !requestedFiles.length) {
    return res.status(400).json({ ok: false, message: 'Brak plików do finalizacji.' });
  }
  if (excelPath) {
    try { validateExcelPath(excelPath); } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  const job = { id: jobId, createdAt: Date.now(), jobDir, uploadPaths: [] };
  jobs.set(jobId, job);

  try {
    await fsp.mkdir(jobDir, { recursive: true });
    const results = [];

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

      const unresolved = fileEntry.resolvedBlocks.some((b) => Object.values(b.fields).some((f) => f.needsReview));
      if (unresolved) {
        results.push({ ok: false, originalName: fileEntry.originalName, error: 'Ten plik ma jeszcze nieuzupełnione pola - dokończ "Uzupełnij dane" przed pobraniem.' });
        continue;
      }

      try {
        const blocks = fileEntry.resolvedBlocks;
        const outPaths = blocks.map((b, i) => {
          const suffix = blocks.length > 1 ? ` - ${b.label || `blok ${i + 1}`}` : '';
          return path.join(jobDir, safeName(`${fileEntry.baseName}${suffix} (OCR).pdf`, `audyt-${i + 1}.pdf`));
        });

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
            const rowValues = { adres: addressLabel };
            for (const [key, field] of Object.entries(b.fields)) rowValues[key] = field.value || '';
            try {
              appendRow(excelPath, 'Audyty', COLUMN_ORDER, COLUMN_LABELS, rowValues);
            } catch (excelErr) {
              results.push({ ok: false, originalName: fileEntry.originalName, error: `Zapisano PDF, ale nie udało się dopisać wiersza do Excela: ${excelErr.message}` });
              return;
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

    await purgeAnalysis(analysis);
    analyses.delete(analysisId);

    res.json({ ok: true, jobId, results });
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

const server = app.listen(PORT, HOST, () => console.log(`OCR audytów: http://${HOST}:${PORT}`));
applyHttpTimeouts(server, 'OCR-AUDYTOW');
