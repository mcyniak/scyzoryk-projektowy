// Kroki 1-4 planu brancha zaimplementowane: odczyt tabeli adresowej,
// automatyzacja przegladarki (automation/session.js/steps.js/captcha.js),
// skrzynka pocztowa (mailbox.js) i pelna orkiestracja (jobs.js). NIE
// przetestowane jeszcze end-to-end na prawdziwej skrzynce (potrzebne realne
// dane IMAP - patrz readImapConfig() nizej - i kolejne swiadome zgloszenie
// testowe, jak przy weryfikacji krokow 2-3).
import fs from 'fs/promises';
import fsSync from 'fs';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { APP_VERSION, PORT, BATCH_CONCURRENCY_DEFAULT, BATCH_CONCURRENCY_MAX } from './src/config.js';
import { readTabelaAdresowa } from './src/excel.js';
import { calculate } from './src/rules.js';
import { createJob, jobs, runBatchJob, cancelJob, cancelAllJobs } from './src/jobs.js';
import appPaths from '../../lib/appPaths.js';
import telemetryLib from '../../lib/telemetry.js';
import timeBenchmarks from '../../lib/timeBenchmarks.js';
import hardening from '../../lib/hardening.js';
import folderBrowse from '../../lib/folderBrowse.js';
import localRequestSecurity from '../../lib/localRequestSecurity.js';

const { getDataRoot, getAppDataDir } = appPaths;
const { runPowerShell } = hardening;
const { browseFolder } = folderBrowse;
const { applySecurityHeaders, applyMutationGuard } = localRequestSecurity;
const { createTelemetryService } = telemetryLib;
const { estimateManualMs } = timeBenchmarks;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DATA_ROOT = getAppDataDir('formularze-varmero');
const OUTPUT_DIR = path.join(APP_DATA_ROOT, 'output');
const telemetryService = createTelemetryService({
  dataRoot: getDataRoot(),
  endpoint: process.env.SCYZORYK_TELEMETRY_URL || 'https://scyzoryk-monitor.scyzoryk.workers.dev',
  getVersion: () => process.env.SCYZORYK_MAIN_VERSION || APP_VERSION,
  enabled: process.env.SCYZORYK_TELEMETRY_ENABLED === '1'
});

function operationDurationMs(job) {
  const start = Date.parse(job?.startedAt || job?.createdAt || "");
  const end = Date.parse(job?.finishedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

function reportBatchTelemetry(job) {
  if (!job || job.monitorTelemetryReported) return;
  const status = String(job.status || "");
  const successfulItems = Math.max(0, Number(job.ok || 0));
  const durationMs = operationDurationMs(job);
  if ((status === 'finished' || status === 'finished-with-errors') && successfulItems > 0) {
    telemetryService.recordEvent({
      tool: 'formularze-varmero',
      eventType: 'completed',
      durationMs,
      estimatedManualMs: estimateManualMs('formularze-varmero', successfulItems),
      success: true
    });
  }
  if (status === 'finished-with-errors') {
    telemetryService.recordEvent({
      tool: 'formularze-varmero',
      eventType: 'failed',
      durationMs,
      success: false,
      errorCode: 'partial-failure'
    });
  } else if (status === 'fatal-error') {
    telemetryService.recordEvent({
      tool: 'formularze-varmero',
      eventType: 'failed',
      durationMs,
      success: false,
      errorCode: 'batch-fatal-error'
    });
  }
  job.monitorTelemetryReported = true;
}

const app = express();
const diagnosticsDir = path.join(APP_DATA_ROOT, 'logs');
try { fsSync.mkdirSync(diagnosticsDir, { recursive: true }); } catch {}
function appendDiagnostic(level, event, data = {}) {
  try { fsSync.appendFileSync(path.join(diagnosticsDir, 'formularze-varmero.jsonl'), JSON.stringify({ ts: new Date().toISOString(), level, app: 'formularze-varmero', event, pid: process.pid, memory: process.memoryUsage(), ...data }) + '\n', 'utf8'); } catch {}
}
process.on('uncaughtException', err => { appendDiagnostic('fatal', 'uncaughtException', { message: err?.message || String(err), stack: err?.stack || '' }); setTimeout(() => process.exit(1), 50).unref(); });
process.on('unhandledRejection', err => appendDiagnostic('error', 'unhandledRejection', { message: err?.message || String(err), stack: err?.stack || '' }));
appendDiagnostic('info', 'process-start', { node: process.version, platform: process.platform });

const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
// Wzorzec wspolny z kazda inna appka w repo - patrz lib/localRequestSecurity.js
// i CLAUDE.md "Security posture".
applySecurityHeaders(app, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://scyzoryk.localhost:3000 http://127.0.0.1:3000; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
applyMutationGuard(app, (req, res) => res.status(403).json({ ok: false, error: 'Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie.' }));
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.VARMERO_API_RATE_LIMIT || 6000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Za dużo żądań w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.VARMERO_HEAVY_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Za dużo ciężkich żądań w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.' }
});
app.use('/api', apiLimiter);

app.use('/shared', express.static(path.join(__dirname, '..', '..', 'shared-styles')));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(APP_DATA_ROOT, 'uploads');
fs.mkdir(uploadDir, { recursive: true }).catch(() => {});
const upload = multer({
  dest: uploadDir,
  // fieldNestingDepth: patrz komentarz w apps/drukarka/server.js (audyt 2026-08-20).
  limits: { fileSize: 20 * 1024 * 1024, fieldNestingDepth: 2 },
  fileFilter: (req, file, cb) => {
    const originalName = String(file.originalname || '');
    if (/\.xlsx$/i.test(originalName)) return cb(null, true);
    if (/\.gsheet$/i.test(originalName)) {
      return cb(new Error('Wybrano plik .gsheet, czyli skrót do Google Sheets. Pobierz arkusz jako Microsoft Excel (.xlsx) i wybierz pobrany plik.'));
    }
    cb(new Error('Dozwolone są tylko prawdziwe pliki Excel .xlsx. Jeśli masz .xls, zapisz go w Excelu jako .xlsx.'));
  }
});

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

function cleanText(value, max = 120) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'formularze-varmero', version: APP_VERSION });
});

app.get('/api/version', (req, res) => {
  res.json({ ok: true, version: APP_VERSION, defaults: { concurrency: BATCH_CONCURRENCY_DEFAULT, maxConcurrency: BATCH_CONCURRENCY_MAX } });
});

app.get('/api/browse-folder', (req, res) => {
  try {
    const result = browseFolder(req.query.path);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/calculate', (req, res) => {
  res.json(calculate(req.body));
});

// Krok 1 planu konczy sie tutaj - podglad tabeli adresowej dziala
// samodzielnie, bez przegladarki. /api/batch/start (rzeczywiste
// zgloszenia) doda sie dopiero z automation/ + mailbox.js w kolejnym kroku.
app.post('/api/batch/preview', heavyJobLimiter, (req, res, next) => {
  upload.single('excel')(req, res, error => {
    if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  try {
    await validateXlsxFile(req.file);
    const gminaName = cleanText(req.body.gminaName, 80);
    const postalCode = cleanText(req.body.postalCode, 10);
    const zone = cleanText(req.body.zone, 1);
    const wojewodztwo = cleanText(req.body.wojewodztwo, 40);
    const parsed = await readTabelaAdresowa(req.file.path, { gminaName, postalCode, zone, wojewodztwo });
    res.json({
      ok: true,
      sheetName: parsed.sheetName,
      sheetNames: parsed.sheetNames || [],
      totalRows: parsed.totalRows,
      zoneKnown: parsed.zoneKnown,
      records: parsed.records.map(record => ({
        rowNumber: record.rowNumber,
        lp: record.lp,
        name: record.input.name,
        address: record.input.address,
        ozcKw: record.input.ozcKw,
        heatingType: record.calculated.heatingType,
        device: record.calculated.device
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

// Dane skrzynki IMAP - na razie tylko zmienne srodowiskowe (placeholder).
// Docelowy mechanizm (alias plusowy per instalator, konfiguracja przetrwajaca
// aktualizacje - patrz plan, wzorowany na lib/ocrConfigMigration.js) NIE jest
// jeszcze zbudowany, bo nie ma jeszcze prawdziwej skrzynki do skonfigurowania.
function readImapConfig() {
  const host = process.env.VARMERO_IMAP_HOST;
  const user = process.env.VARMERO_IMAP_USER;
  const pass = process.env.VARMERO_IMAP_PASSWORD;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.VARMERO_IMAP_PORT || 993),
    secure: String(process.env.VARMERO_IMAP_SECURE || 'true').toLowerCase() !== 'false',
    auth: { user, pass }
  };
}

// 1:1 wzor z apps/formularze-ecodan/server.js#parseSelectedRows.
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

// Audyt UX 2026-08-21: tresc widoczna uzytkownikowi nie powinna wymieniac
// nazw zmiennych srodowiskowych (VARMERO_IMAP_HOST/USER/PASSWORD) - to nic
// nie znaczy dla nietechnicznego pracownika biura. Pelny szczegol techniczny
// zostaje w logu serwera (console.error nizej), na ekran idzie tylko
// wskazowka "zglos do administratora".
const MAILBOX_NOT_CONFIGURED_MESSAGE = 'Skrzynka pocztowa do odbioru kart Varmero nie jest jeszcze skonfigurowana na tym komputerze - zgłoś to do administratora/IT przed uruchomieniem zgłoszeń.';

// Audyt UX 2026-08-21: brak konfiguracji skrzynki wczesniej wykrywano
// dopiero w /api/batch/start (ostatnie kliknieccie, po wgraniu Excela,
// przejrzeniu adresow i wypelnieniu wszystkich pol) - uzytkownik mogl
// stracic realny czas na przygotowanie duzej paczki, zeby na koncu dostac
// blad, ktory dalo sie wykryc od razu. Ten endpoint pozwala frontendowi
// sprawdzic to od razu po zaladowaniu strony.
app.get('/api/mailbox-status', (req, res) => {
  res.json({ ok: true, configured: Boolean(readImapConfig()) });
});

function publicJob(job) {
  return {
    ...job,
    resultsPreview: job.results || []
  };
}

app.post('/api/batch/start', heavyJobLimiter, (req, res, next) => {
  upload.single('excel')(req, res, error => {
    if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  const imapConfig = readImapConfig();
  if (!imapConfig) {
    if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ ok: false, error: MAILBOX_NOT_CONFIGURED_MESSAGE });
  }
  try {
    await validateXlsxFile(req.file);
    const gminaName = cleanText(req.body.gminaName, 80);
    const postalCode = cleanText(req.body.postalCode, 10);
    const zone = cleanText(req.body.zone, 1);
    const wojewodztwo = cleanText(req.body.wojewodztwo, 40);
    // Baza adresu plusowego jest ZAWSZE ta sama, co skonfigurowana skrzynka
    // IMAP - to jedyna skrzynka, ktora jest realnie odpytywana o karte, wiec
    // pozwolenie na dowolny inny adres w formularzu byloby nie tylko zbedne,
    // ale wrecz bledne (karta nigdy by nie trafila na przeszukiwana
    // skrzynke). Uzytkownik konfiguruje mailbox RAZ (VARMERO_IMAP_*), nie
    // wpisuje go przy kazdej paczce - patrz tez public/inline-1.js (formularz
    // nie ma juz pola e-mail).
    const email = imapConfig.auth.user;
    const investmentName = cleanText(req.body.investmentName, 120);
    const outputPath = String(req.body.outputPath || '').trim().replace(/^['"]|['"]$/g, '').slice(0, 1000);
    const skipExisting = String(req.body.skipExisting || 'true').toLowerCase() !== 'false';
    const selectedRows = parseSelectedRows(req.body.selectedRows);
    if (!/^[1-5]$/.test(zone)) return res.status(400).json({ ok: false, error: 'Podaj strefę klimatyczną (1-5) - kalkulator Varmero jej wymaga, a nie da się jej wyczytać z tabeli adresowej.' });
    // Audyt 2026-08-21 (real incydent - przypadkowy start na 70 adresow):
    // pusta/brakujaca selectedRows kiedys po cichu oznaczala "zglos cala
    // tabele" (patrz jobs.js#runBatchJob) - dla Varmero kazdy wiersz to
    // realne, nieodwracalne zgloszenie do zewnetrznego kalkulatora + realny
    // mail, wiec blokujemy zamiast zgadywac "wszystko".
    // Wyjatek: selectAll='true' dla programatycznych wywolan miedzy apkami
    // (pipeline) - tam plik jest juz przefiltrowany przez selekcje uzytkownika
    // w kroku 1 Pipeline'u, wiec "wszystkie wiersze" = dokladnie jego jawna
    // intencja ("Dobor Varmero" zaznaczony recznie). UI tej flagi nie wysyla.
    const selectAll = String(req.body.selectAll || '').trim().toLowerCase() === 'true';
    if (!selectedRows.length && !selectAll) {
      if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ ok: false, error: 'Nie wybrano żadnych adresów. Wczytaj podgląd tabeli i zaznacz adresy do zgłoszenia przed uruchomieniem.' });
    }

    const job = createJob({
      sourceFile: req.file.originalname,
      options: { investmentName, outputPath, skipExisting, gminaName, postalCode, zone, wojewodztwo, concurrency: Number(req.body.concurrency) || undefined }
    });
    job.outputBase = OUTPUT_DIR;
    res.json({ ok: true, jobId: job.id });

    // Fire-and-forget, jak w Ecodanie - odpowiedz HTTP nie czeka na cala
    // paczke (kazdy wiersz to realne zgloszenie + czekanie na maila, moze
    // trwac minuty).
    setImmediate(() => {
      runBatchJob(job, req.file.path, { email, imapConfig, gminaName, postalCode, zone, wojewodztwo, outputPath, skipExisting, selectedRows, selectAll })
        .then(() => {
          reportBatchTelemetry(job);
        })
        .catch(error => {
          job.status = 'fatal-error';
          job.fatalReason = String(error?.message || error);
          job.finishedAt = new Date().toISOString();
          reportBatchTelemetry(job);
        })
        .finally(() => { fs.unlink(req.file.path).catch(() => {}); });
    });
  } catch (error) {
    if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/batch/cancel/:jobId', async (req, res) => {
  const result = await cancelJob(req.params.jobId);
  if (!result) return res.status(404).json({ ok: false, error: 'Nie znaleziono zadania.' });
  res.json({ ok: true, ...result });
});

app.get('/api/batch/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Nie znaleziono zadania.' });
  res.json({ ok: true, job: publicJob(job) });
});

// Otwiera folder z kartami PDF danego zadania w Eksploratorze. Bezpieczne
// mimo ze sciezka jest per-zadanie (nie stala, w odroznieniu od
// apps/drukarka-projekty#/api/open-saved-pdf-folder): jobId musi odpowiadac
// istniejacemu zadaniu utworzonemu przez createJob() na tym serwerze, a
// job.pdfDir jest zawsze wyliczany po stronie serwera
// (telemetry.js#ensureJobWorkspace, przez sanitize-filename +
// isInsideOrEqual) - klient nigdy nie podaje surowej sciezki wprost.
//
// Uzywa scripts/open-folder.ps1 (nie samego spawn('explorer.exe', ...))
// zeby dodatkowo probowac wymusic okno na pierwszym planie - zlapane realnie
// przez wlasciciela: goly spawn otwiera okno gdzies w tle bez zadnego
// potwierdzenia, wiec klikal przycisk kilkanascie razy myslac ze nic sie nie
// dzieje. Best-effort (Windows moze i tak zablokowac fokus procesowi w tle),
// dlatego blad z PowerShella NIE jest traktowany jako porazka calego
// zadania - folder i tak zdazyl sie otworzyc, zanim skrypt probuje fokusu.
const OPEN_FOLDER_SCRIPT = path.join(__dirname, 'scripts', 'open-folder.ps1');
app.post('/api/batch/open-folder/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Nie znaleziono zadania.' });
  if (!job.pdfDir) return res.status(409).json({ ok: false, error: 'Folder zadania nie jest jeszcze gotowy.' });
  res.json({ ok: true });
  runPowerShell(OPEN_FOLDER_SCRIPT, ['-FolderPath', job.pdfDir], { timeoutMs: 10000 })
    .catch(error => appendDiagnostic('warn', 'open-folder-failed', { message: String(error?.message || error) }));
});

app.get('/api/batch/jobs', (req, res) => {
  res.json({ ok: true, jobs: [...jobs.values()].map(job => ({ id: job.id, status: job.status, sourceFile: job.sourceFile, total: job.total, done: job.done, ok: job.ok, failed: job.failed, createdAt: job.createdAt })) });
});

process.on('SIGINT', () => cancelAllJobs('SIGINT').finally(() => process.exit(0)));
process.on('SIGTERM', () => cancelAllJobs('SIGTERM').finally(() => process.exit(0)));

app.listen(PORT, HOST, () => {
  console.log(`formularze-varmero (${APP_VERSION}) nasłuchuje na http://${HOST}:${PORT}`);
});
