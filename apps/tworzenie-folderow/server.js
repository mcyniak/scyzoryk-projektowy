// Automatyczne tworzenie struktury folderow (WM/pompy/kolektory/kotly) w
// JUZ ISTNIEJACYM folderze inwestycji, na podstawie tabeli adresowej -
// pelna specyfikacja: patrz pamiec scyzoryk_next_roadmap_2026_08_11.md,
// wynegocjowana krok po kroku z wlascicielem 2026-08-11. Appka NIE integruje
// sie z Google Sheets - .gsheet w folderze inwestycji jest tylko dla
// orientacji uzytkownika, ktory sam eksportuje .xlsx i go wskazuje (ten sam
// wzorzec co kazda inna apka w repo).
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { setupProcessDiagnostics, scheduleCleanup } = require('../../lib/hardening');
const { getDataRoot, getAppDataDir } = require('../../lib/appPaths');
const { browseFolder } = require('../../lib/folderBrowse');
const { readTabelaAdresowa } = require('./src/excel.js');
const { buildFolderPlan } = require('./src/folderPlan.js');
const { applySecurityHeaders, applyMutationGuard } = require('../../lib/localRequestSecurity');
const { createTelemetryService } = require('../../lib/telemetry');
const { estimateManualMs } = require('../../lib/timeBenchmarks');

const APP_VERSION = require('./package.json').version;
const app = express();
const PORT = Number(process.env.PORT || 3013);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const APP_DATA_ROOT = getAppDataDir('tworzenie-folderow');
setupProcessDiagnostics('tworzenie-folderow', APP_DATA_ROOT);
const telemetryService = createTelemetryService({
  dataRoot: getDataRoot(),
  endpoint: process.env.SCYZORYK_TELEMETRY_URL || 'https://scyzoryk-monitor.scyzoryk.workers.dev',
  getVersion: () => process.env.SCYZORYK_MAIN_VERSION || APP_VERSION,
  enabled: process.env.SCYZORYK_TELEMETRY_ENABLED === '1'
});

const UPLOAD_DIR = path.join(APP_DATA_ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
scheduleCleanup([UPLOAD_DIR], 24 * 60 * 60 * 1000, 60 * 60 * 1000);

// --- Bezpieczenstwo / middleware - ten sam wzorzec co kazda inna apka w repo ---
applySecurityHeaders(app, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://scyzoryk.localhost:3000 http://127.0.0.1:3000; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
applyMutationGuard(app, (req, res) => res.status(403).json({ ok: false, error: 'Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie.' }));
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.TF_API_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  // Panel glowny odpytuje /api/health co 10s - wyjatek na GET, ten sam
  // wzorzec co apps/karty-katalogowe (bez niego apka sama sobie generuje
  // falszywy status "nie dziala" w panelu).
  skip: (req) => req.method === 'GET',
  message: { ok: false, error: 'Za dużo żądań w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.' }
});
app.use('/api', apiLimiter);
app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
app.use(express.static(path.join(ROOT, 'public')));

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

const upload = multer({
  dest: UPLOAD_DIR,
  // fieldNestingDepth: patrz komentarz w apps/drukarka/server.js (audyt 2026-08-20).
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fieldNestingDepth: 2 },
  fileFilter: (req, file, cb) => {
    const originalName = decodeOriginalName(String(file.originalname || ''));
    if (/\.xlsx$/i.test(originalName)) return cb(null, true);
    if (/\.gsheet$/i.test(originalName)) {
      return cb(new Error('Wybrano plik .gsheet, czyli skrót do Google Sheets. Pobierz arkusz jako Microsoft Excel (.xlsx) i wybierz pobrany plik.'));
    }
    cb(new Error('Dozwolone są tylko prawdziwe pliki Excel .xlsx. Jeśli masz .xls, zapisz go w Excelu jako .xlsx.'));
  }
});

// Sprawdzenie prawdziwej zawartosci (magic bytes ZIP, ktorym .xlsx jest w
// srodku), nie tylko rozszerzenia - ten sam wzorzec co
// apps/formularze-varmero/server.js#validateXlsxFile.
async function validateXlsxFile(file) {
  const original = String(file?.originalname || 'plik.xlsx');
  if (!/\.xlsx$/i.test(original)) throw new Error('Dozwolone są tylko pliki .xlsx. Pliki .xls zapisz najpierw jako .xlsx.');
  const fh = await fsp.open(file.path, 'r');
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

// Ta sama funkcja co apps/drukarka-projekty/server.js#isPathInsideFolder -
// wielka litera nieistotna (Windows), porownanie po rozwiazanej sciezce.
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

function cleanText(value, max = 500) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function countUniqueAddresses(excelResult) {
  const keys = new Set();
  for (const sheet of (excelResult?.sheets || [])) {
    for (const record of (sheet.records || [])) {
      const address = String(record.address || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!address) continue;
      const gmina = String(record.gmina || '').trim().toLowerCase().replace(/\s+/g, ' ');
      keys.add(gmina + '|' + address);
    }
  }
  return keys.size;
}

async function readPlanFromUpload(req) {
  const investmentFolder = cleanText(req.body.investmentFolder, 500);
  if (!investmentFolder) throw new Error('Podaj ścieżkę do folderu inwestycji.');
  if (!fs.existsSync(investmentFolder) || !fs.statSync(investmentFolder).isDirectory()) {
    throw new Error(`Folder inwestycji nie istnieje: ${investmentFolder}. Ta appka wypełnia JUŻ ISTNIEJĄCY folder inwestycji, nie tworzy go od zera.`);
  }
  await validateXlsxFile(req.file);
  const excelResult = await readTabelaAdresowa(req.file.path);
  const plan = buildFolderPlan(excelResult);

  const withStatus = plan.map(relativePath => {
    const fullPath = path.join(investmentFolder, ...relativePath.split('/'));
    return { relativePath, fullPath, exists: fs.existsSync(fullPath) };
  });

  const sheetSummary = excelResult.sheets.map(sheet => ({
    type: sheet.type,
    sheetName: sheet.sheetName,
    recordCount: sheet.records.length,
    gminaColumnPresent: sheet.gminaColumnPresent,
    gruntCount: sheet.records.filter(r => r.pumpType === 'grunt').length,
    powietrznaCount: sheet.records.filter(r => r.pumpType === 'powietrzna').length
  }));

  return { investmentFolder, withStatus, sheetSummary, sheetNames: excelResult.sheetNames, addressCount: countUniqueAddresses(excelResult) };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'tworzenie-folderow', version: APP_VERSION });
});

app.get('/api/version', (req, res) => {
  res.json({ ok: true, version: APP_VERSION });
});

// Przegladarka folderow w stronie (przycisk "Przegladaj..." przy polu
// sciezki inwestycji) - patrz lib/folderBrowse.js dla pelnego uzasadnienia
// (dwie proby prawdziwego natywnego okna Windows zawiodly na zywo).
// Odczyt (GET), wiec nie wymaga naglowka X-Scyzoryk-Request - dokladnie
// tak samo jak /api/health.
app.get('/api/browse-folder', (req, res) => {
  try {
    const result = browseFolder(req.query.path);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/preview', (req, res, next) => {
  upload.single('excel')(req, res, error => {
    if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  try {
    const { investmentFolder, withStatus, sheetSummary, sheetNames } = await readPlanFromUpload(req);
    res.json({
      ok: true,
      investmentFolder,
      sheetNames,
      sheets: sheetSummary,
      folders: withStatus,
      toCreate: withStatus.filter(f => !f.exists).length,
      alreadyExisting: withStatus.filter(f => f.exists).length
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  } finally {
    if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/create', (req, res, next) => {
  upload.single('excel')(req, res, error => {
    if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  const operationStartedAt = Date.now();
  try {
    const { investmentFolder, withStatus, addressCount } = await readPlanFromUpload(req);
    const created = [];
    const alreadyExisted = [];
    const rejected = [];
    for (const folder of withStatus) {
      // Druga warstwa ochrony obok sanityzacji segmentow w folderPlan.js -
      // nawet gdyby sanityzacja kiedys zawiodla, nie pozwalamy wyjsc poza
      // wskazany folder inwestycji (ten sam wzorzec co
      // apps/karty-katalogowe/server.js).
      if (!isPathInsideFolder(folder.fullPath, investmentFolder)) {
        rejected.push(folder.relativePath);
        continue;
      }
      if (folder.exists) {
        alreadyExisted.push(folder.relativePath);
        continue;
      }
      await fsp.mkdir(folder.fullPath, { recursive: true });
      created.push(folder.relativePath);
    }
    const durationMs = Date.now() - operationStartedAt;
    telemetryService.recordEvent({
      tool: 'tworzenie-folderow',
      eventType: 'completed',
      durationMs,
      estimatedManualMs: estimateManualMs('tworzenie-folderow', addressCount),
      success: true
    });
    res.json({ ok: true, investmentFolder, created, alreadyExisted, rejected });
  } catch (error) {
    telemetryService.recordEvent({
      tool: 'tworzenie-folderow',
      eventType: 'failed',
      durationMs: Date.now() - operationStartedAt,
      success: false,
      errorCode: 'create-failed'
    });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  } finally {
    if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
  }
});

app.listen(PORT, HOST, () => {
  console.log(`tworzenie-folderow (${APP_VERSION}) nasłuchuje na http://${HOST}:${PORT}`);
});
