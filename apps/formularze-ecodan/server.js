import fs from 'fs/promises';
import fsSync from 'fs';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import sanitize from 'sanitize-filename';
// archiver 8.x jest teraz czystym ESM i eksportuje klasy (ZipArchive) zamiast
// starej funkcji-fabryki archiver('zip', opts) - stad "new ZipArchive(opts)"
// nizej, nie "archiver('zip', opts)". Bez tej zmiany kazde pobranie ZIP-a
// konczylo sie realnym bledem 500 "Nie udalo sie przygotowac paczki ZIP".
import { ZipArchive } from 'archiver';
import { APP_VERSION, PORT, BATCH_CONCURRENCY_DEFAULT, BATCH_CONCURRENCY_MAX } from './src/config.js';
import { setProjectRoot, getProjectRoot } from './src/debug.js';
import { calculate } from './src/rules.js';
import { cancelAllJobs, cancelJob, createJob, jobs, persistJobsIndex, runAutomation, runBatchJob } from './src/jobs.js';
import { readExcelRecords } from './src/excel.js';
import appPaths from '../../lib/appPaths.js';

const { getAppDataDir } = appPaths;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DATA_ROOT = getAppDataDir('formularze-ecodan');
const OUTPUT_DIR = path.join(APP_DATA_ROOT, 'output');
setProjectRoot(APP_DATA_ROOT);

const app = express();
const diagnosticsDir = path.join(APP_DATA_ROOT, 'logs');
try { fsSync.mkdirSync(diagnosticsDir, { recursive: true }); } catch {}
function appendDiagnostic(level, event, data = {}) {
  try { fsSync.appendFileSync(path.join(diagnosticsDir, 'formularze-ecodan.jsonl'), JSON.stringify({ ts: new Date().toISOString(), level, app: 'formularze-ecodan', event, pid: process.pid, memory: process.memoryUsage(), ...data }) + '\n', 'utf8'); } catch {}
}
process.on('uncaughtException', err => { appendDiagnostic('fatal', 'uncaughtException', { message: err?.message || String(err), stack: err?.stack || '' }); setTimeout(() => process.exit(1), 50).unref(); });
process.on('unhandledRejection', err => appendDiagnostic('error', 'unhandledRejection', { message: err?.message || String(err), stack: err?.stack || '' }));
appendDiagnostic('info', 'process-start', { node: process.version, platform: process.platform });
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};
app.disable('x-powered-by');
app.use((req, res, next) => { for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value); next(); });
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Scyzoryk-Request') === '1') return next();
  res.status(403).json({ ok: false, error: 'Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie.' });
});
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Status zadania jest odpytywany co 1.5s (public/inline-1.js), czyli samo
  // odswiezanie jednego batcha generuje ~600 zadan/15min. Stary limit 60
  // odcinal wlasny frontend po ~90s dzialania, wiec podniesiony z zapasem
  // dla wielu rownoleglych jobow - apka i tak dziala tylko lokalnie (127.0.0.1).
  max: Number(process.env.ECODAN_API_RATE_LIMIT || 6000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ECODAN_HEAVY_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Za duzo ciezkich zadan w krotkim czasie. Uruchom mniejsza paczke albo odczekaj chwile.' }
});
app.use('/api', apiLimiter);

app.use('/shared', express.static(path.join(__dirname, '..', '..', 'shared-styles')));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(APP_DATA_ROOT, 'uploads');
fs.mkdir(uploadDir, { recursive: true }).catch(() => {});
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const originalName = String(file.originalname || '');
    if (/\.xlsx$/i.test(originalName)) return cb(null, true);
    if (/\.gsheet$/i.test(originalName)) {
      return cb(new Error('Wybrano plik .gsheet, czyli skrót do Google Sheets. Pobierz arkusz jako Microsoft Excel (.xlsx) i wybierz pobrany plik.'));
    }
    cb(new Error('Dozwolone są tylko prawdziwe pliki Excel .xlsx. Jeśli masz .xls, zapisz go w Excelu jako .xlsx.'));
  }
});

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function displayPath(filePath) {
  if (!filePath) return null;
  const root = getProjectRoot();
  if (isInside(root, filePath)) return path.relative(root, filePath).replace(/\\/g, '/');
  return filePath;
}

function cleanText(value, max = 260) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseSelectedRows(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => Number(item))
      .filter(item => Number.isInteger(item) && item > 0)
      .filter((item, index, array) => array.indexOf(item) === index)
      .slice(0, 10000);
  } catch {
    return [];
  }
}


async function validateXlsxFile(file) {
  const original = String(file?.originalname || 'plik.xlsx');
  if (!/\.xlsx$/i.test(original)) throw new Error('Dozwolone są tylko pliki .xlsx. Pliki .xls zapisz najpierw jako .xlsx.');
  const fh = await fs.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buffer, 0, 4, 0);
    if (bytesRead < 4 || buffer.toString('latin1', 0, 4) !== 'PK\x03\x04') {
      throw new Error('Plik nie wygląda jak poprawny XLSX. Sprawdź, czy to nie jest skrót .gsheet albo stary plik .xls.');
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

function publicJob(job) {
  const resultsPreview = (job.results || []).slice(-20).map(row => ({
    ...row,
    pdfDisplay: row.pdf ? displayPath(row.pdf) : null,
    pdfUrl: row.pdf && row.rowNumber ? `/api/batch/pdf/${encodeURIComponent(job.id)}/${encodeURIComponent(String(row.rowNumber))}` : row.pdfUrl || null
  }));

  return {
    ...job,
    pdfDirDisplay: displayPath(job.pdfDir) || job.pdfDir,
    errorsFileDisplay: displayPath(job.errorsFile) || job.errorsFile,
    resultsCsvDisplay: displayPath(job.resultsCsv) || job.resultsCsv,
    summaryFileDisplay: displayPath(job.summaryFile) || job.summaryFile,
    telemetryFileDisplay: displayPath(job.telemetryFile) || job.telemetryFile,
    outputRootDisplay: displayPath(job.outputRoot) || job.outputRoot,
    downloadZipUrl: `/api/batch/download/${encodeURIComponent(job.id)}`,
    resultsPreview
  };
}

function findPdfForJobRow(job, rowNumber) {
  const wanted = String(rowNumber || '');
  const row = [...(job.results || [])].reverse().find(item => String(item.rowNumber || '') === wanted && item.pdf);
  return row?.pdf || null;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'formularze-ecodan', version: APP_VERSION });
});

app.get('/api/version', (req, res) => {
  res.json({ ok: true, version: APP_VERSION, defaults: { concurrency: BATCH_CONCURRENCY_DEFAULT, maxConcurrency: BATCH_CONCURRENCY_MAX }, safeOutputBase: process.env.SCYZORYK_OUTPUT_BASE || OUTPUT_DIR });
});

app.post('/api/calculate', (req, res) => {
  res.json(calculate(req.body));
});

app.post('/api/run', heavyJobLimiter, async (req, res) => {
  const response = await runAutomation(req.body);
  res.json(response);
});


app.post('/api/batch/preview', heavyJobLimiter, (req, res, next) => {
  upload.single('excel')(req, res, error => {
    if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  try {
    await validateXlsxFile(req.file);
    const location = cleanText(req.body.location, 120);
    const parsed = await readExcelRecords(req.file.path, location || '');
    res.json({
      ok: true,
      sheetName: parsed.sheetName,
      sheetNames: parsed.sheetNames || [],
      totalRows: parsed.totalRows,
      records: parsed.records.map(record => ({
        rowNumber: record.rowNumber,
        name: record.input.name || '',
        address: record.input.address || '',
        location: record.input.location || '',
        ozc: record.input.ozc || '',
        municipalityPower: record.input.municipalityPower || '',
        chosenPower: record.input.chosenPower || '',
        pumpType: record.input.pumpType || ''
      })),
      skipped: parsed.skipped,
      headers: parsed.headers
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/batch/start', heavyJobLimiter, (req, res, next) => {
  upload.single('excel')(req, res, error => {
    if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  }

  try {
    await validateXlsxFile(req.file);
  } catch (error) {
    if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }

  const location = cleanText(req.body.location, 120);
  const investmentName = cleanText(req.body.investmentName, 120);
  const outputPath = String(req.body.outputPath || '').trim().replace(/^['"]|['"]$/g, '').slice(0, 1000);
  const skipExisting = String(req.body.skipExisting || 'true').toLowerCase() !== 'false';
  const selectedRows = parseSelectedRows(req.body.selectedRows);
  const rawConcurrency = Number(req.body.concurrency || process.env.BATCH_CONCURRENCY || BATCH_CONCURRENCY_DEFAULT);
  const concurrency = Math.max(1, Math.min(BATCH_CONCURRENCY_MAX, Math.floor(Number.isFinite(rawConcurrency) ? rawConcurrency : BATCH_CONCURRENCY_DEFAULT)));
  const job = createJob({
    sourceFile: req.file.originalname,
    options: { location, investmentName, outputPath, skipExisting, concurrency, selectedRows },
    concurrency
  });

  res.json({ ok: true, jobId: job.id });

  setImmediate(() => {
    runBatchJob(job, req.file.path, { location, investmentName, outputPath, skipExisting, concurrency, selectedRows }).catch(error => {
      job.status = 'fatal-error';
      job.finishedAt = new Date().toISOString();
      job.errors.push({ error: String(error?.message || error), stack: String(error?.stack || '') });
      persistJobsIndex().catch(() => {});
    });
  });
});

app.post('/api/batch/cancel/:jobId', async (req, res) => {
  const response = await cancelJob(req.params.jobId);
  if (!response.ok) return res.status(404).json(response);
  res.json({ ok: true, alreadyFinished: !!response.alreadyFinished, status: response.job?.status || 'cancelling' });
});

app.get('/api/batch/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Nie znaleziono zadania.' });
  res.json({ ok: true, job: publicJob(job) });
});

app.get('/api/batch/pdf/:jobId/:rowNumber', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send('Nie znaleziono zadania.');
  const pdf = findPdfForJobRow(job, req.params.rowNumber);
  if (!pdf || !fsSync.existsSync(pdf)) return res.status(404).send('Nie znaleziono PDF dla tego wiersza.');
  res.sendFile(path.resolve(pdf));
});

app.get('/api/batch/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Nie znaleziono zadania.' });
  if (!job.outputRoot || !fsSync.existsSync(job.outputRoot)) return res.status(404).json({ ok: false, error: 'Folder zadania jeszcze nie istnieje.' });

  const safeName = sanitize(job.options?.investmentName || job.investmentFolder || job.sourceFile || 'raporty-ecodan') || 'raporty-ecodan';
  res.attachment(`${safeName}.zip`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', error => {
    if (!res.headersSent) res.status(500);
    res.end(String(error?.message || error));
  });
  archive.pipe(res);

  if (job.pdfDir && fsSync.existsSync(job.pdfDir)) archive.directory(job.pdfDir, 'pdf');
  if (job.resultsCsv && fsSync.existsSync(job.resultsCsv)) archive.file(job.resultsCsv, { name: 'wyniki.csv' });
  if (job.errorsFile && fsSync.existsSync(job.errorsFile)) archive.file(job.errorsFile, { name: 'bledy.txt' });
  if (job.summaryFile && fsSync.existsSync(job.summaryFile)) archive.file(job.summaryFile, { name: 'podsumowanie.json' });
  if (String(process.env.INCLUDE_DEBUG_ZIP || '').toLowerCase() === 'true') {
    if (job.telemetryFile && fsSync.existsSync(job.telemetryFile)) archive.file(job.telemetryFile, { name: 'logs/events.jsonl' });
    if (job.debugDir && fsSync.existsSync(job.debugDir)) archive.directory(job.debugDir, 'debug');
  }

  archive.finalize();
});

app.get('/api/batch/jobs', (req, res) => {
  res.json({ ok: true, jobs: Array.from(jobs.values()).map(job => ({
    id: job.id,
    status: job.status,
    sourceFile: job.sourceFile,
    investmentName: job.options?.investmentName || '',
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    total: job.total,
    done: job.done,
    okCount: job.ok,
    failed: job.failed,
    skippedExisting: job.skippedExisting,
    cancelled: job.cancelled,
    cancelRequested: job.cancelRequested,
    pdfDirDisplay: displayPath(job.pdfDir) || job.pdfDir,
    outputRootDisplay: displayPath(job.outputRoot) || job.outputRoot,
    downloadZipUrl: `/api/batch/download/${encodeURIComponent(job.id)}`
  })) });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Ecodan generator ${APP_VERSION} dziala tylko lokalnie: http://${HOST}:${PORT}`);
});
server.requestTimeout = Number(process.env.FORMULARZE_REQUEST_TIMEOUT_MS || process.env.SCYZORYK_REQUEST_TIMEOUT_MS || 10 * 60 * 1000);
server.headersTimeout = Number(process.env.FORMULARZE_HEADERS_TIMEOUT_MS || process.env.SCYZORYK_HEADERS_TIMEOUT_MS || 65 * 1000);
server.keepAliveTimeout = Number(process.env.FORMULARZE_KEEPALIVE_TIMEOUT_MS || process.env.SCYZORYK_KEEPALIVE_TIMEOUT_MS || 5000);
server.timeout = Number(process.env.FORMULARZE_SOCKET_TIMEOUT_MS || process.env.SCYZORYK_SOCKET_TIMEOUT_MS || 10 * 60 * 1000);

async function shutdown(signal) {
  console.log(`\n${signal}: zamykam aktywne zadania i sesje Chrome...`);
  await cancelAllJobs(signal).catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
