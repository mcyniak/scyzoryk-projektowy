const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
// archiver 8.x jest czystym ESM i eksportuje klasy (ZipArchive) zamiast
// starej funkcji-fabryki archiver('zip', opts) - bez tej zmiany kazde
// pobranie ZIP-a konczylo sie realnym bledem "Nie udalo sie przygotowac paczki ZIP".
const { ZipArchive } = require('archiver');
const sanitize = require('sanitize-filename');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { setupProcessDiagnostics, applyHttpTimeouts, createSerialQueue, runPowerShell, readJsonFileNoBom, writeJsonFileNoBom, scheduleCleanup } = require('../../lib/hardening');

const app = express();
const PORT = Number(process.env.PORT || 3005);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
setupProcessDiagnostics('wnioski-powykonawcze', ROOT);
const wordQueue = createSerialQueue('wnioski-word');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const PS_SCRIPT = path.join(ROOT, 'scripts', 'convert-wm.ps1');
const MAX_FILE_MB = Number(process.env.WM_MAX_FILE_MB || 50);
const MAX_FILES = Number(process.env.WM_MAX_FILES || 100);
const JOB_TTL_MS = Number(process.env.WM_JOB_TTL_MS || 24 * 60 * 60 * 1000);

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(dir, { recursive: true });
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

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.WM_API_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.WM_HEAVY_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za duzo ciezkich zadan w krotkim czasie. Uruchom mniejsza paczke albo odczekaj chwile.' }
});
app.use('/api', apiLimiter);

app.use(express.static(path.join(ROOT, 'public')));

const jobs = new Map();
const JOBS_INDEX = path.join(DATA_DIR, 'jobs.json');


function persistJobsIndex() {
  try {
    const items = [...jobs.values()].map(job => ({
      id: job.id,
      createdAt: job.createdAt,
      status: job.status,
      pdfDir: job.pdfDir,
      debugDir: job.debugDir,
      zipPath: job.zipPath,
      files: job.files || [],
      failed: job.failed || [],
      error: job.error || null,
      dateText: job.dateText || null,
      prefix: job.prefix || null
    }));
    writeJsonFileNoBom(JOBS_INDEX, { savedAt: new Date().toISOString(), jobs: items });
  } catch (err) {
    console.error('[wm-jobs-index]', err?.message || err);
  }
}

function restoreJobsIndex() {
  try {
    if (!fs.existsSync(JOBS_INDEX)) return;
    const data = readJsonFileNoBom(JOBS_INDEX);
    for (const item of data.jobs || []) {
      if (!item?.id || !item.pdfDir) continue;
      const jobDir = path.dirname(item.pdfDir);
      if (!fs.existsSync(jobDir)) continue;
      jobs.set(item.id, {
        id: item.id,
        createdAt: Number(item.createdAt || Date.now()),
        status: item.status || 'restored',
        pdfDir: item.pdfDir,
        debugDir: item.debugDir || path.join(jobDir, 'docx'),
        zipPath: item.zipPath || null,
        files: item.files || [],
        failed: item.failed || [],
        uploadPaths: [],
        error: item.error || null,
        dateText: item.dateText || null,
        prefix: item.prefix || null
      });
    }
  } catch (err) {
    console.error('[wm-jobs-restore]', err?.message || err);
  }
}
restoreJobsIndex();

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

function safeName(name, fallback = 'plik') {
  const cleaned = sanitize(String(name || fallback)).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return (cleaned || fallback).slice(0, 150);
}

function readHeader(filePath, length = 4) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

function validateDocx(file) {
  const original = decodeOriginalName(file.originalname || '');
  if (path.extname(original).toLowerCase() !== '.docx') throw new Error(`Plik ${original} nie jest DOCX.`);
  const header = readHeader(file.path, 4).toString('latin1');
  if (!header.startsWith('PK')) throw new Error(`Plik ${original} nie wygląda jak poprawny DOCX.`);
}

function normalizeDate(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Wpisz datę dokumentacji powykonawczej.');
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  m = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
  m = raw.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[2]}.${m[1]}`;
  m = raw.match(/^(\d{1,2})[.\/-](\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}.${m[2]}`;
  throw new Error('Nieprawidłowa data. Użyj formatu RRRR-MM-DD, DD.MM.RRRR albo MM.RRRR (tylko miesiąc i rok).');
}

function cleanPrefix(value) {
  return safeName(String(value || 'WM dok.pod'), 'WM dok.pod').slice(0, 80);
}

function outputFileName(originalName, prefix) {
  const base = safeName(path.basename(originalName, path.extname(originalName)), 'wniosek');
  const p = cleanPrefix(prefix);
  let suffix = base;
  if (/^wm\s+/i.test(suffix) && /^wm\s+dok/i.test(p)) suffix = suffix.replace(/^wm\s+/i, '').trim();
  const result = p ? `${p} ${suffix}` : base;
  return safeName(result, 'wniosek-powykonawczy') + '.pdf';
}

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = safeName(decodeOriginalName(file.originalname), 'wniosek.docx');
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${original}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeOriginalName(file.originalname || '')).toLowerCase();
    if (ext === '.docx') return cb(null, true);
    return cb(new Error('Wybierz pliki DOCX / Word.'));
  }
});

async function purgeJobArtifacts(job) {
  const paths = [
    job?.pdfDir ? path.dirname(job.pdfDir) : null,
    job?.zipPath || null,
    ...(Array.isArray(job?.uploadPaths) ? job.uploadPaths : [])
  ].filter(Boolean);
  for (const p of paths) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
}

async function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt <= JOB_TTL_MS) continue;
    await purgeJobArtifacts(job);
    jobs.delete(id);
    persistJobsIndex();
  }
}
setInterval(() => cleanupOldJobs().catch(err => console.error('[wm-cleanup]', err?.message || err)), 60 * 60 * 1000).unref();

async function runConvertScript(inputJson, outputJson) {
  const timeoutMs = Number(process.env.WM_TIMEOUT_MS || 60 * 60 * 1000);
  try {
    return await runPowerShell(PS_SCRIPT, ['-InputJson', inputJson, '-OutputJson', outputJson], { cwd: ROOT, timeoutMs, windowsHide: true });
  } catch (err) {
    if (fs.existsSync(outputJson)) return { code: err.code || 1, stdout: err.stdout || '', stderr: err.stderr || '', recoveredFromOutputJson: true };
    throw err;
  }
}

async function zipDirectory(sourceDir, zipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'wnioski-powykonawcze', queue: wordQueue.getState() }));

app.post('/api/convert', heavyJobLimiter, upload.array('files', MAX_FILES), async (req, res) => {
  const jobId = crypto.randomUUID();
  const createdAt = Date.now();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  const pdfDir = path.join(jobDir, 'pdf');
  const debugDir = path.join(jobDir, 'docx');
  await fsp.mkdir(pdfDir, { recursive: true });
  await fsp.mkdir(debugDir, { recursive: true });
  const job = { id: jobId, createdAt, status: 'running', pdfDir, debugDir, files: [], failed: [], uploadPaths: [] };
  jobs.set(jobId, job);
persistJobsIndex();

  try {
    const files = req.files || [];
    job.uploadPaths = files.map(file => file.path).filter(Boolean);
    if (!files.length) throw new Error('Dodaj przynajmniej jeden plik DOCX.');
    for (const file of files) validateDocx(file);
    const dateText = normalizeDate(req.body.date);
    const prefix = cleanPrefix(req.body.prefix || 'WM dok.pod');
    const saveDocx = String(req.body.saveDocx || '').toLowerCase() === 'true';
    const visibleWord = String(req.body.visibleWord || '').toLowerCase() === 'true';

    const manifestFiles = files.map(file => {
      const original = decodeOriginalName(file.originalname || path.basename(file.path));
      const pdfPath = uniquePath(pdfDir, outputFileName(original, prefix));
      const debugDocxPath = path.join(debugDir, path.basename(pdfPath, '.pdf') + '.docx');
      return { inputPath: file.path, originalName: original, pdfPath, debugDocxPath };
    });

    const inputJson = path.join(jobDir, 'input.json');
    const outputJson = path.join(jobDir, 'result.json');
    writeJsonFileNoBom(inputJson, { dateText, files: manifestFiles, saveDocx, visibleWord });

    job.status = 'queued';
    persistJobsIndex();
    await wordQueue.run(() => runConvertScript(inputJson, outputJson));
    const result = readJsonFileNoBom(outputJson);
    if (!result.ok) throw new Error(result.error || 'Nie udało się przetworzyć dokumentów.');

    const okFiles = [];
    const failed = [];
    for (const item of result.results || []) {
      if (item.ok && item.pdf && fs.existsSync(item.pdf)) okFiles.push({ file: path.basename(item.pdf), path: item.pdf });
      else failed.push({ input: item.input, error: item.error || 'Nieznany błąd' });
    }
    if (!okFiles.length) throw new Error(failed[0]?.error || 'Nie utworzono żadnego PDF-a.');

    job.status = failed.length ? 'finished-with-errors' : 'finished';
    job.files = okFiles;
    job.failed = failed;
    job.dateText = dateText;
    job.prefix = prefix;

    let zipUrl = null;
    let zipError = null;
    if (okFiles.length > 1) {
      const zipPath = path.join(jobDir, `wnioski-powykonawcze-${jobId.slice(0, 8)}.zip`);
      try {
        await zipDirectory(pdfDir, zipPath);
        job.zipPath = zipPath;
        zipUrl = `/api/jobs/${jobId}/zip`;
      } catch (zipErr) {
        zipError = String(zipErr?.message || zipErr);
        job.zipPath = null;
        job.zipError = zipError;
        job.status = 'finished-with-errors';
        console.error('[wm-zip]', zipError);
      }
    } else if (okFiles.length === 1) {
      // Przy jednym PDF-ie ZIP nie jest potrzebny. W poprzedniej wersji blad ZIP-a
      // potrafil oznaczac caly plik jako bledny mimo gotowego PDF-a.
      job.zipPath = null;
    }

    persistJobsIndex();

    const filesForResponse = okFiles.map(f => ({
      file: f.file,
      url: `/api/jobs/${jobId}/files/${encodeURIComponent(f.file)}`
    }));

    res.json({
      ok: true,
      jobId,
      status: job.status,
      count: okFiles.length,
      failed,
      files: filesForResponse,
      queue: wordQueue.getState(),
      zipUrl,
      zipError
    });
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
    persistJobsIndex();
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get('/api/jobs/:id/zip', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.zipPath || !fs.existsSync(job.zipPath)) return res.status(404).send('Nie znaleziono ZIP-a.');
  res.download(job.zipPath, path.basename(job.zipPath));
});

app.get('/api/jobs/:id/files/:file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('Nie znaleziono zadania.');
  const file = safeName(req.params.file, 'plik.pdf');
  const filePath = path.join(job.pdfDir, file);
  if (!filePath.startsWith(job.pdfDir) || !fs.existsSync(filePath)) return res.status(404).send('Nie znaleziono pliku.');
  res.download(filePath, path.basename(filePath));
});

app.use((err, req, res, next) => {
  res.status(400).json({ ok: false, message: err.message || 'Błąd przetwarzania.' });
});

const server = app.listen(PORT, HOST, () => console.log(`Wnioski powykonawcze: http://${HOST}:${PORT}`));
applyHttpTimeouts(server, 'WM');
