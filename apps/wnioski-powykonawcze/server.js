const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
// archiver 8.x jest czystym ESM. Synchroniczne require() ESM-owego pakietu
// dziala TYLKO na Node >=20.19/22.12 ("require(esm)") - na starszych, wciaz
// oficjalnie wspieranych wersjach (w tym Node 18.x, deklarowany jako minimum
// w package.json/README) rzuca ERR_REQUIRE_ESM i wywala cala aplikacje na
// starcie. Zlapane realnym testem instalacji na Node 20.18.1 w GitHub Actions.
// Poprawka: leniwy dynamiczny import() zamiast require() - dziala na kazdej
// wspieranej wersji Node.
let ZipArchiveClass = null;
async function loadZipArchive() {
  if (!ZipArchiveClass) {
    ({ ZipArchive: ZipArchiveClass } = await import('archiver'));
  }
  return ZipArchiveClass;
}
const sanitize = require('sanitize-filename');
const { normalizeDate } = require('./src/dateValidation');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { setupProcessDiagnostics, applyHttpTimeouts, createSerialQueue, readJsonFileNoBom, writeJsonFileNoBom, scheduleCleanup } = require('../../lib/hardening');
const { getAppDataDir } = require('../../lib/appPaths');
const wmFolderScan = require('./src/wmFolderScan');

const app = express();
const PORT = Number(process.env.PORT || 3005);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const APP_DATA_ROOT = getAppDataDir('wnioski-powykonawcze');
setupProcessDiagnostics('wnioski-powykonawcze', APP_DATA_ROOT);
const wordQueue = createSerialQueue('wnioski-word');
const DATA_DIR = path.join(APP_DATA_ROOT, 'data');
const UPLOAD_DIR = path.join(APP_DATA_ROOT, 'uploads');
const OUTPUT_DIR = path.join(APP_DATA_ROOT, 'output');
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
  // Panel glowny odpytuje /api/health KAZDEJ apki co 10s (patrz public/inline-1.js
  // w korzeniu) - to samo ~90 zadan/15min, wiecej niz limit 60 - bez tego
  // wyjatku ta apka permanentnie sama sobie generowala falszywy status "nie
  // dziala" (429) w panelu, mimo ze proces byl cały czas zdrowy. Ten sam
  // wzorzec juz dawno dziala w apps/drukarka i apps/drukarka-projekty.
  skip: (req) => req.method === 'GET',
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

app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
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
      prefix: job.prefix || null,
      total: job.total || 0,
      done: job.done || 0
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
      const interrupted = ['queued', 'running', 'cancelling'].includes(item.status);
      jobs.set(item.id, {
        id: item.id,
        createdAt: Number(item.createdAt || Date.now()),
        status: interrupted ? 'interrupted' : (item.status || 'restored'),
        interruptedReason: interrupted ? 'process-restarted' : item.interruptedReason,
        pdfDir: item.pdfDir,
        debugDir: item.debugDir || path.join(jobDir, 'docx'),
        zipPath: item.zipPath || null,
        files: item.files || [],
        failed: item.failed || [],
        uploadPaths: [],
        error: item.error || null,
        dateText: item.dateText || null,
        prefix: item.prefix || null,
        total: item.total || 0,
        done: item.done || 0,
        child: null
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

async function runConvertScript(inputJson, outputJson, job = null) {
  const timeoutMs = Number(process.env.WM_TIMEOUT_MS || 60 * 60 * 1000);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT,
      '-InputJson', inputJson, '-OutputJson', outputJson
    ], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) job.child = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Przekroczono limit czasu konwersji (${Math.round(timeoutMs / 60000)} min).`));
    }, timeoutMs);
    timer.unref();
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (job) job.child = null;
      if (code === 0 || fs.existsSync(outputJson)) return resolve({ code, stdout, stderr, recoveredFromOutputJson: code !== 0 });
      reject(new Error(stderr.trim() || `PowerShell zakonczyl sie kodem ${code}.`));
    });
  });
}

async function zipDirectory(sourceDir, zipPath) {
  const ZipArchive = await loadZipArchive();
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

app.post('/api/jobs', heavyJobLimiter, upload.array('files', MAX_FILES), async (req, res) => {
  const jobId = crypto.randomUUID();
  const createdAt = Date.now();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  const pdfDir = path.join(jobDir, 'pdf');
  const debugDir = path.join(jobDir, 'docx');
  await fsp.mkdir(pdfDir, { recursive: true });
  await fsp.mkdir(debugDir, { recursive: true });
  const job = { id: jobId, createdAt, status: 'queued', pdfDir, debugDir, files: [], failed: [], uploadPaths: [], total: 0, done: 0, child: null };
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
    job.total = manifestFiles.length;
    job.dateText = dateText;
    job.prefix = prefix;
    persistJobsIndex();
    res.status(202).json({ ok: true, jobId, status: 'queued' });

    setImmediate(async () => {
      try {
        await wordQueue.run(async () => {
          if (job.status === 'cancelled') return;
          job.status = 'running';
          persistJobsIndex();
          await runConvertScript(inputJson, outputJson, job);
        });
        if (job.status === 'cancelled') return;
        const result = readJsonFileNoBom(outputJson);
        if (!result.ok) throw new Error(result.error || 'Nie udało się przetworzyć dokumentów.');

        const okFiles = [];
        const failed = [];
        for (const item of result.results || []) {
          if (item.ok && item.pdf && fs.existsSync(item.pdf)) {
            // Widocznosc tego, co skrypt faktycznie zmienil/usunal w dokumencie
            // (audyt v1.0.4, P0-3/P0-4) - zamiana WSZYSTKICH dat w dokumencie na
            // jedna wartosc i usuwanie od markera "ZATWIERDZAM..." do konca
            // dokumentu wciaz nie maja bezpiecznej, wskazanej granicy (wymaga
            // realnego szablonu WM, zeby ja poprawnie ustalic) - dopoki jej nie
            // ma, przynajmniej pokazujemy uzytkownikowi co zostalo zmienione,
            // zeby dalo sie to zauwazyc przed wyslaniem dokumentu dalej.
            okFiles.push({
              file: path.basename(item.pdf), path: item.pdf,
              deletedSection: Boolean(item.deletedSection),
              deletedCharCount: Number(item.deletedCharCount || 0),
              deletedPreview: item.deletedPreview || '',
              dateReplacements: Array.isArray(item.dateReplacements) ? item.dateReplacements : []
            });
          } else {
            failed.push({ input: item.input, error: item.error || 'Nieznany błąd' });
          }
        }
        if (!okFiles.length) throw new Error(failed[0]?.error || 'Nie utworzono żadnego PDF-a.');
        job.files = okFiles;
        job.failed = failed;
        job.done = okFiles.length + failed.length;
        job.status = failed.length ? 'finished-with-errors' : 'finished';

        if (okFiles.length > 1) {
          const zipPath = path.join(jobDir, `wnioski-powykonawcze-${jobId.slice(0, 8)}.zip`);
          try {
            await zipDirectory(pdfDir, zipPath);
            job.zipPath = zipPath;
          } catch (zipErr) {
            job.zipError = String(zipErr?.message || zipErr);
            job.zipPath = null;
            job.status = 'finished-with-errors';
          }
        }
        persistJobsIndex();
      } catch (error) {
        if (job.status !== 'cancelled') {
          job.status = 'fatal-error';
          job.error = error.message;
          persistJobsIndex();
        }
      }
    });
  } catch (error) {
    job.status = 'fatal-error';
    job.error = error.message;
    persistJobsIndex();
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  res.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      interruptedReason: job.interruptedReason || null,
      total: job.total || 0,
      done: job.done || 0,
      error: job.error || null,
      failed: job.failed || [],
      zipError: job.zipError || null,
      zipUrl: job.zipPath ? `/api/jobs/${job.id}/zip` : null,
      files: (job.files || []).map(file => ({ file: file.file, url: `/api/jobs/${job.id}/files/${encodeURIComponent(file.file)}` }))
    }
  });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  if (['finished', 'finished-with-errors', 'cancelled', 'fatal-error'].includes(job.status)) {
    return res.json({ ok: true, status: job.status, message: 'Zadanie jest już zakończone.' });
  }
  job.status = 'cancelled';
  try { job.child?.kill(); } catch {}
  job.child = null;
  persistJobsIndex();
  res.json({ ok: true, status: job.status });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('Nie znaleziono zadania.');
  if (job.zipPath && fs.existsSync(job.zipPath)) return res.download(job.zipPath, path.basename(job.zipPath));
  const onlyFile = job.files?.length === 1 ? job.files[0] : null;
  if (onlyFile?.path && fs.existsSync(onlyFile.path)) return res.download(onlyFile.path, onlyFile.file);
  return res.status(404).send('Nie znaleziono gotowego pliku do pobrania.');
});

// Audyt rozdz. 13, P0/P1: /api/wm-folder/convert dawniej przyjmowal
// sourcePath/folderPath dla kazdej pozycji WPROST z ciala zadania, bez
// zadnej weryfikacji, ze te sciezki pochodza z faktycznie przeskanowanego
// folderu - klient mogl wskazac dowolny plik DOCX na dysku i dowolny
// istniejacy folder docelowy. scanToken wiaze convert z konkretnym,
// niedawno przeskanowanym rootPath (zwracanym tylko z /api/wm-folder/scan),
// a kazda sciezka z convert jest ponownie sprawdzana pod katem containment
// wzgledem tego rootPath.
const wmScans = new Map();
const WM_SCAN_TTL_MS = 30 * 60 * 1000;
function cleanupOldWmScans() {
  const now = Date.now();
  for (const [token, scan] of wmScans) {
    if (now - scan.createdAt > WM_SCAN_TTL_MS) wmScans.delete(token);
  }
}
setInterval(cleanupOldWmScans, 10 * 60 * 1000).unref();

function isPathInsideFolder(filePath, folderPath) {
  if (!filePath || !folderPath) return false;
  try {
    const resolved = path.resolve(String(filePath)).toLowerCase();
    const resolvedFolder = path.resolve(String(folderPath)).toLowerCase();
    return resolved === resolvedFolder || resolved.startsWith(resolvedFolder + path.sep);
  } catch (_) {
    return false;
  }
}

// Automatyczny tryb "caly folder WM": uzytkownik podaje tylko sciezke
// nadrzednego folderu (np. folderu inwestycji zawierajacego podfoldery WM),
// a aplikacja sama znajduje w kazdym podfolderze plik "WM ..." do przerobienia.
app.post('/api/wm-folder/scan', async (req, res) => {
  const folderPath = String(req.body?.folderPath || '').trim();
  if (!folderPath) return res.status(400).json({ ok: false, message: 'Podaj ścieżkę folderu z wnioskami materiałowymi (WM).' });
  let stat;
  try { stat = await fsp.stat(folderPath); } catch (_) { stat = null; }
  if (!stat || !stat.isDirectory()) {
    return res.status(400).json({ ok: false, message: 'Nie znaleziono folderu: ' + folderPath });
  }
  try {
    const result = await wmFolderScan.scanWmFolder(folderPath);
    const scanToken = crypto.randomUUID();
    wmScans.set(scanToken, { folderPath, createdAt: Date.now() });
    res.json({ ok: true, scanToken, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się przeskanować folderu WM.' });
  }
});

// Przerabia wybrane kategorie na dokumentacje powykonawcza i zapisuje PDF-y
// BEZPOSREDNIO w tych samych folderach, w ktorych lezaly zrodlowe pliki WM -
// bez uploadu, bez ZIP-a do pobrania, tak jak przy zwyklym uploadzie tylko
// ze sciezka docelowa jest folderem uzytkownika, nie folderem aplikacji.
app.post('/api/wm-folder/convert', heavyJobLimiter, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, message: 'Wybierz przynajmniej jedną kategorię do przerobienia.' });
  if (items.length > MAX_FILES) return res.status(400).json({ ok: false, message: `Za dużo pozycji na raz (limit ${MAX_FILES}).` });

  const scanToken = String(req.body?.scanToken || '');
  const scan = wmScans.get(scanToken);
  if (!scan) {
    return res.status(400).json({ ok: false, message: 'Sesja skanowania folderu wygasła lub jest nieprawidłowa - przeskanuj folder ponownie.' });
  }

  let dateText;
  let prefix;
  try {
    dateText = normalizeDate(req.body?.date);
    prefix = cleanPrefix(req.body?.prefix || 'WM dok.pod');
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    const manifestFiles = items.map(item => {
      const sourcePath = String(item.sourcePath || '');
      const folderPath = String(item.folderPath || '');
      if (!isPathInsideFolder(sourcePath, scan.folderPath)) {
        throw new Error('Plik źródłowy leży poza przeskanowanym folderem: ' + sourcePath);
      }
      if (!isPathInsideFolder(folderPath, scan.folderPath)) {
        throw new Error('Folder docelowy leży poza przeskanowanym folderem: ' + folderPath);
      }
      let sourceStat;
      try { sourceStat = fs.statSync(sourcePath); } catch (_) { sourceStat = null; }
      if (!sourceStat || !sourceStat.isFile() || path.extname(sourcePath).toLowerCase() !== '.docx') {
        throw new Error('Nie znaleziono pliku źródłowego DOCX: ' + sourcePath);
      }
      let folderStat;
      try { folderStat = fs.statSync(folderPath); } catch (_) { folderStat = null; }
      if (!folderStat || !folderStat.isDirectory()) throw new Error('Nie znaleziono folderu docelowego: ' + folderPath);

      const pdfPath = uniquePath(folderPath, outputFileName(path.basename(sourcePath), prefix));
      const debugDocxPath = path.join(jobDir, path.basename(pdfPath, '.pdf') + '.docx');
      return { inputPath: sourcePath, category: String(item.category || ''), pdfPath, debugDocxPath };
    });

    const inputJson = path.join(jobDir, 'input.json');
    const outputJson = path.join(jobDir, 'result.json');
    writeJsonFileNoBom(inputJson, { dateText, files: manifestFiles, saveDocx: false, visibleWord: false });

    await wordQueue.run(() => runConvertScript(inputJson, outputJson));
    const result = readJsonFileNoBom(outputJson);
    if (!result.ok) throw new Error(result.error || 'Nie udało się przetworzyć dokumentów.');

    const okItems = [];
    const failed = [];
    const byInputPath = new Map(manifestFiles.map(m => [m.inputPath, m]));
    for (const item of result.results || []) {
      const manifestEntry = byInputPath.get(item.input);
      if (item.ok && item.pdf && fs.existsSync(item.pdf)) {
        okItems.push({
          category: manifestEntry?.category || '', file: path.basename(item.pdf), path: item.pdf,
          deletedSection: Boolean(item.deletedSection),
          deletedCharCount: Number(item.deletedCharCount || 0),
          deletedPreview: item.deletedPreview || '',
          dateReplacements: Array.isArray(item.dateReplacements) ? item.dateReplacements : []
        });
      } else {
        failed.push({ category: manifestEntry?.category || '', input: item.input, error: item.error || 'Nieznany błąd' });
      }
    }

    res.json({ ok: true, created: okItems.length, files: okItems, failed });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się przetworzyć dokumentów.' });
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
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

// require.main === module: uruchomienie serwera TYLKO gdy plik jest startowany
// bezposrednio (node server.js), nie przy require() z testow (patrz ten sam
// wzorzec w apps/drukarka-projekty/server.js).
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => console.log(`Wnioski powykonawcze: http://${HOST}:${PORT}`));
  applyHttpTimeouts(server, 'WM');
}

module.exports = { app, isPathInsideFolder };
