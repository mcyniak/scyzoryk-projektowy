import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import sanitize from 'sanitize-filename';
import appPaths from '../../../lib/appPaths.js';
import {
  DEBUG_MODE,
  TRACE_MODE,
  BATCH_RESTART_EVERY,
  BATCH_RETRY_CLOSED_SESSION,
  BATCH_CONCURRENCY_DEFAULT,
  BATCH_CONCURRENCY_MAX,
  MAX_CLOSED_SESSION_STREAK,
  MAX_JOB_CLOSED_SESSION_STREAK,
  RECORD_TIMEOUT_MS
} from './config.js';
import { calculate } from './rules.js';
import { saveDebug, cleanupDebugArtifact, getOutputRoot } from './debug.js';
import { readExcelRecords, makePdfName, pathExists } from './excel.js';
import { createAutomationSession, closeAutomationSession } from './automation/session.js';
import {
  captureCwuState,
  chooseCwu,
  chooseLocation,
  choosePowerMethodAndOzc,
  chooseReceiver,
  domClickRegex,
  downloadReport
} from './automation/steps.js';
import { chooseProduct } from './automation/product.js';
import { validatePdfProduct, quarantineInvalidPdf } from './pdfValidation.js';
import { keepFirstPdfPages } from './pdfTrim.js';
import { appendJobEvent as appendTelemetryJobEvent, ensureJobWorkspace, writeResultsCsv, writeSummary } from './telemetry.js';

const { getAppDataDir } = appPaths;
const jobsIndexPath = path.join(getAppDataDir('formularze-ecodan'), 'data', 'jobs-index.json');
export const jobs = new Map();
const jobSessions = new Map();

function persistedJob(job) {
  return { ...job, current: null, activeWorkers: {} };
}

export async function persistJobsIndex() {
  await fs.mkdir(path.dirname(jobsIndexPath), { recursive: true });
  const tempPath = `${jobsIndexPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = Object.fromEntries(Array.from(jobs, ([id, job]) => [id, persistedJob(job)]));
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tempPath, jobsIndexPath).catch(async () => {
    await fs.copyFile(tempPath, jobsIndexPath);
    await fs.unlink(tempPath).catch(() => {});
  });
}

export function restoreJobsFromDisk() {
  let persisted = {};
  try {
    persisted = JSON.parse(fsSync.readFileSync(jobsIndexPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    persisted = {};
  }
  for (const [id, saved] of Object.entries(persisted)) {
    const interrupted = ['running', 'queued', 'reading-excel', 'cancelling'].includes(saved.status);
    jobs.set(id, {
      ...saved,
      status: interrupted ? 'interrupted' : saved.status,
      interruptedReason: interrupted ? 'process-restarted' : saved.interruptedReason,
      resultFolderMissing: Boolean(saved.outputDir && !fsSync.existsSync(saved.outputDir)),
      current: null,
      activeWorkers: {}
    });
  }
  return jobs;
}

async function appendJobEvent(job, event, data = {}) {
  await appendTelemetryJobEvent(job, event, data);
  await persistJobsIndex();
}

restoreJobsFromDisk();

function terminalStatus(status) {
  return ['finished', 'finished-with-errors', 'fatal-error', 'cancelled'].includes(status);
}

function getJobSessionSet(jobId) {
  if (!jobSessions.has(jobId)) jobSessions.set(jobId, new Set());
  return jobSessions.get(jobId);
}

function registerJobSession(job, session) {
  if (!job?.id || !session) return;
  getJobSessionSet(job.id).add(session);
}

function unregisterJobSession(job, session) {
  if (!job?.id || !session) return;
  const set = jobSessions.get(job.id);
  if (!set) return;
  set.delete(session);
  if (!set.size) jobSessions.delete(job.id);
}

async function closeJobSessions(job, reason = 'cancel') {
  if (!job?.id) return;
  const sessions = Array.from(jobSessions.get(job.id) || []);
  job.lastSessionRestartReason = reason;
  await appendJobEvent(job, 'close-job-sessions', { reason, sessions: sessions.length });
  await Promise.allSettled(sessions.map(session => closeAutomationSession(session)));
  jobSessions.delete(job.id);
}

export async function cancelAllJobs(reason = 'process-shutdown') {
  const active = Array.from(jobs.values()).filter(job => !terminalStatus(job.status));
  await Promise.allSettled(active.map(async job => {
    job.cancelRequested = true;
    job.cancelRequestedAt = job.cancelRequestedAt || new Date().toISOString();
    if (job.status !== 'fatal-error') job.status = 'cancelling';
    await closeJobSessions(job, reason);
    await writeSummary(job);
  }));
}

function clampConcurrency(value) {
  const n = Math.floor(Number(value || BATCH_CONCURRENCY_DEFAULT || 1));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(BATCH_CONCURRENCY_MAX, n));
}

function normalizeSelectedRows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && item > 0)
    .filter((item, index, array) => array.indexOf(item) === index);
}

function sessionLooksUsable(session) {
  if (!session) return false;
  if (!session.page || session.page.isClosed()) return false;
  if (session.browser && typeof session.browser.isConnected === 'function' && !session.browser.isConnected()) return false;
  return true;
}

function isClosedSessionError(errorText = '') {
  const text = String(errorText || '');
  return /Target page, context or browser has been closed|Page closed|Browser has been closed|browser.*closed|context.*closed|page.*closed|crash/i.test(text);
}

function isTimeoutError(response) {
  return !!response?.timeout || /Limit czasu rekordu/i.test(String(response?.error || ''));
}

async function replaceBatchSession(session, outputRoot, job, reason = '', workerId = null) {
  await closeAutomationSession(session).catch(() => {});
  const next = await createAutomationSession(outputRoot);
  job.restartedSessions = (job.restartedSessions || 0) + 1;
  if (reason) job.lastSessionRestartReason = reason;
  if (workerId !== null) {
    job.workerRestarts = job.workerRestarts || {};
    job.workerRestarts[workerId] = (job.workerRestarts[workerId] || 0) + 1;
  }
  await appendJobEvent(job, 'session-restarted', { workerId, reason });
  return next;
}

function ensureWorkerState(job, workerId) {
  job.activeWorkers = job.activeWorkers || {};
  if (!job.activeWorkers[workerId]) {
    job.activeWorkers[workerId] = { workerId, status: 'starting' };
  }
  return job.activeWorkers[workerId];
}

function clearWorkerState(job, workerId) {
  if (job.activeWorkers) delete job.activeWorkers[workerId];
}

function updateCurrentFromWorkers(job) {
  const active = Object.values(job.activeWorkers || {});
  const firstWorking = active.find(item => item && item.current);
  job.current = firstWorking ? firstWorking.current : null;
}

function seconds(ms) {
  return Math.round(ms / 1000);
}

function markCircuitBreaker(job, reason) {
  if (job.fatalReason) return;
  job.fatalReason = reason;
  job.cancelRequested = true;
  job.cancelRequestedAt = job.cancelRequestedAt || new Date().toISOString();
  job.status = 'fatal-error';
}

async function runWithRecordTimeout(promiseFactory, timeoutMs, onTimeout) {
  let timer = null;
  let timedOut = false;
  const guarded = Promise.resolve()
    .then(promiseFactory)
    .catch(error => ({ ok: false, error: String(error?.message || error), stack: String(error?.stack || '') }));

  const timeout = new Promise(resolve => {
    timer = setTimeout(async () => {
      timedOut = true;
      await onTimeout?.().catch(() => {});
      resolve({ ok: false, timeout: true, error: `Limit czasu rekordu przekroczony (${seconds(timeoutMs)} s). Sesja została zamknięta i zostanie uruchomiona ponownie.` });
    }, timeoutMs);
  });

  const result = await Promise.race([guarded, timeout]);
  if (!timedOut && timer) clearTimeout(timer);
  return result;
}

export function createJob(initial = {}) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    current: null,
    activeWorkers: {},
    concurrency: 1,
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    cancelled: 0,
    cancelRequested: false,
    cancelRequestedAt: null,
    cancelledRemaining: 0,
    skippedExisting: 0,
    skipped: {},
    pdfDir: null,
    errorsFile: null,
    resultsCsv: null,
    telemetryFile: null,
    summaryFile: null,
    results: [],
    errors: [],
    restartedSessions: 0,
    closedSessionErrors: 0,
    closedSessionStreak: 0,
    fatalReason: null,
    ...initial
  };
  jobs.set(id, job);
  persistJobsIndex().catch(() => {});
  return job;
}

export async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: 'Nie znaleziono zadania.' };

  if (terminalStatus(job.status)) {
    return { ok: true, alreadyFinished: true, job };
  }

  job.cancelRequested = true;
  job.cancelRequestedAt = job.cancelRequestedAt || new Date().toISOString();
  job.status = 'cancelling';
  job.current = null;
  await appendJobEvent(job, 'cancel-requested', { source: 'ui' });

  // Zamykamy aktywne contexty, żeby przerwanie było szybkie nawet gdy worker jest w trakcie strony.
  await closeJobSessions(job, 'cancelled-by-user').catch(() => {});
  return { ok: true, job };
}

async function runEcodanFlow(page, input, result, tmpDir) {
  await page.goto('https://my-ecodan.me', { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await domClickRegex(page, /zgadzam się/i, { timeout: 2500, name: 'popup zgoda' });
  } catch {}

  await domClickRegex(page, /ROZPOCZNIJ\s+DOBÓR/i, { name: 'ROZPOCZNIJ DOBÓR' });
  // Brak lokalizacji jest juz zablokowany wczesniej (calculate().errors,
  // sprawdzane w runAutomation/runAutomationInSession) - nie ma tu cichego
  // fallbacku na prawdziwy adres "62-561 Slesin", zeby zla/pusta lokalizacja
  // z Excela nigdy nie skonczyla sie realnym zgloszeniem dla innej miejscowosci.
  await chooseLocation(page, input.location);
  await choosePowerMethodAndOzc(page, result);
  await chooseReceiver(page, result);
  await chooseCwu(page, result);
  await chooseProduct(page, result);

  return await downloadReport(page, result, input, tmpDir);
}

async function findExistingReportPath(pdfDir, fileName, options = {}) {
  const desiredPath = path.join(pdfDir, fileName);
  if (await pathExists(desiredPath)) return desiredPath;
  if (options.includeLegacy === false) return null;

  const jobRoot = path.dirname(pdfDir);
  const jobsRoot = path.dirname(jobRoot);
  const investmentFolder = path.basename(jobRoot);
  let entries = [];
  try {
    entries = await fs.readdir(jobsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const legacyRoots = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${investmentFolder}-`))
    .map(entry => path.join(jobsRoot, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  for (const legacyRoot of legacyRoots) {
    const legacyPdf = path.join(legacyRoot, 'pdf', fileName);
    if (await pathExists(legacyPdf)) return legacyPdf;
  }
  return null;
}

async function copySkippedReportIntoCurrentJob(existingPath, desiredPath) {
  if (!existingPath || existingPath === desiredPath) return existingPath;
  await fs.mkdir(path.dirname(desiredPath), { recursive: true });
  await fs.copyFile(existingPath, desiredPath);
  return desiredPath;
}

export async function runAutomationInSession(input, session, pdfDir, options = {}) {
  const startedAt = Date.now();
  const result = calculate(input);
  const page = session.page;
  const desiredFileName = options.fileName || makePdfName(input, options.rowNumber || '');
  const desiredPath = path.join(pdfDir, desiredFileName);
  const outputRoot = options.workspaceRoot || path.dirname(pdfDir);

  // Obrona w glab: nawet gdyby cos ominelo filtrowanie na poziomie Excela
  // (readExcelRecords) albo wywolalo ta funkcje wprost, dobor NIGDY nie
  // powinien ruszyc z danymi, ktorych calculate() nie potrafilo poprawnie
  // zinterpretowac - zero cichych domyslnych wartosci (6 kW, Slesin, itd.).
  if (!result.calculated.valid) {
    return { ok: false, blocked: true, result, error: result.calculated.errors.join(' '), durationMs: Date.now() - startedAt };
  }

  const existingReportPath = options.skipExisting
    ? await findExistingReportPath(pdfDir, desiredFileName, { includeLegacy: !options.outputPath })
    : null;
  if (existingReportPath) {
    // "Pomiń istniejące" ma oznaczać dosłownie brak jakichkolwiek zmian w
    // istniejącym pliku - poprzednio ta gałąź otwierała i PRZYCINAŁA
    // istniejący PDF do pierwszych 3 stron, co mogło nadpisać ręcznie
    // umieszczony/starszy raport. Przycinanie ma sens tylko dla PLIKU
    // WŁAŚNIE POBRANEGO z Ecodana (patrz niżej po pobraniu), nie dla pliku,
    // który miał zostać w ogóle nietknięty.
    const pdf = await copySkippedReportIntoCurrentJob(existingReportPath, desiredPath);
    return { ok: true, skippedExisting: true, result, pdf, existingPdf: existingReportPath, durationMs: Date.now() - startedAt };
  }

  try {
    const workerPart = options.workerId ? `worker-${String(options.workerId).replace(/[^a-zA-Z0-9_-]/g, '_')}` : 'single';
    const tmpDir = path.join(outputRoot, 'tmp', workerPart);
    await fs.mkdir(tmpDir, { recursive: true });
    const downloadedPath = await runEcodanFlow(page, input, result, tmpDir);

    let pdfValidation;
    try {
      pdfValidation = await validatePdfProduct(downloadedPath, result);
    } catch (validationError) {
      const invalidPdf = await quarantineInvalidPdf(downloadedPath, String(validationError?.message || validationError), outputRoot);
      throw new Error(`${String(validationError?.message || validationError)}. Błędny PDF przeniesiono do: ${invalidPdf || 'debug/invalid-pdf'}`);
    }

    if (downloadedPath !== desiredPath) {
      await fs.rename(downloadedPath, desiredPath).catch(async () => {
        await fs.copyFile(downloadedPath, desiredPath);
        await fs.unlink(downloadedPath).catch(() => {});
      });
    }

    const pdfTrim = await keepFirstPdfPages(desiredPath).catch(error => ({ ok: false, error: String(error?.message || error) }));
    if (!pdfTrim.ok) throw new Error(`Nie udało się skrócić PDF do pierwszych 3 stron: ${pdfTrim.error}`);

    return { ok: true, result, pdf: desiredPath, pdfValidation, pdfTrim, durationMs: Date.now() - startedAt };
  } catch (error) {
    const errorText = String(error?.message || error);
    if (typeof options.shouldCancel === 'function' && options.shouldCancel()) {
      return { ok: false, cancelled: true, result, error: 'Przerwano przez użytkownika', durationMs: Date.now() - startedAt };
    }

    const extra = page && !page.isClosed()
      ? {
          runtimeEvents: session.runtimeEvents,
          cwuState: await captureCwuState(page, Number(result.calculated.tankLitres || 200)).catch(() => null),
          result,
          rowNumber: options.rowNumber,
          workerId: options.workerId,
          retry: !!options.retry
        }
      : { runtimeEvents: session.runtimeEvents, pageClosed: true, result, rowNumber: options.rowNumber, workerId: options.workerId, retry: !!options.retry };

    const debug = await saveDebug(page, `batch-row-${options.rowNumber || 'x'}-worker-${options.workerId || 'x'}-error`, String(error?.stack || error?.message || error), extra, outputRoot);
    return { ok: false, result, error: errorText, debug, durationMs: Date.now() - startedAt };
  }
}

async function processRecordWithWorker(record, recordIndex, worker, job, pdfDir, outputRoot, options = {}) {
  if (job.cancelRequested) return;
  const workerState = ensureWorkerState(job, worker.id);
  const startedAt = Date.now();
  workerState.current = {
    index: recordIndex + 1,
    rowNumber: record.rowNumber,
    name: record.input.name || '',
    address: record.input.address || ''
  };
  workerState.status = 'running';
  workerState.startedRowAt = new Date().toISOString();
  updateCurrentFromWorkers(job);
  await appendJobEvent(job, 'record-start', { workerId: worker.id, rowNumber: record.rowNumber, name: record.input.name, address: record.input.address });

  // my-ecodan potrafi po kilku rekordach zamknąć stronę/kontekst.
  // Każdy worker ma własną sesję i własny licznik restartów.
  if (!sessionLooksUsable(worker.session)) {
    unregisterJobSession(job, worker.session);
    worker.session = await replaceBatchSession(worker.session, outputRoot, job, 'session-not-usable-before-row', worker.id);
    registerJobSession(job, worker.session);
    worker.recordsInCurrentSession = 0;
  } else if (BATCH_RESTART_EVERY > 0 && worker.recordsInCurrentSession >= BATCH_RESTART_EVERY) {
    unregisterJobSession(job, worker.session);
    worker.session = await replaceBatchSession(worker.session, outputRoot, job, `periodic-restart-after-${worker.recordsInCurrentSession}-records`, worker.id);
    registerJobSession(job, worker.session);
    worker.recordsInCurrentSession = 0;
  }

  // Audyt rozdz. 14, P1: nazwa pliku uzywa LP (stabilny, niezalezny od
  // pozycji wiersza), gdy arkusz ma taka kolumne - readExcelRecords juz
  // przefiltrowal wiersze z brakujacym/zduplikowanym LP, wiec kazdy record
  // tutaj ma poprawna wartosc, jesli record.lp nie jest null. Bez kolumny LP
  // w arkuszu (record.lp === null) zostaje dawny fallback na numer wiersza.
  const fileName = makePdfName(record.input, record.lp || record.rowNumber);
  const runOptions = {
    rowNumber: record.rowNumber,
    fileName,
    skipExisting: options.skipExisting !== false,
    outputPath: options.outputPath || '',
    workspaceRoot: outputRoot,
    workerId: worker.id,
    shouldCancel: () => !!job.cancelRequested
  };

  let response = await runWithRecordTimeout(
    () => runAutomationInSession(record.input, worker.session, pdfDir, runOptions),
    RECORD_TIMEOUT_MS,
    async () => closeAutomationSession(worker.session)
  );

  if (!response.cancelled && !job.cancelRequested && !response.ok && BATCH_RETRY_CLOSED_SESSION && isClosedSessionError(response.error)) {
    unregisterJobSession(job, worker.session);
    worker.session = await replaceBatchSession(worker.session, outputRoot, job, `retry-after-closed-session-row-${record.rowNumber}`, worker.id);
    registerJobSession(job, worker.session);
    worker.recordsInCurrentSession = 0;
    const firstError = response.error;
    const firstDebug = response.debug;
    const retry = await runWithRecordTimeout(
      () => runAutomationInSession(record.input, worker.session, pdfDir, { ...runOptions, retry: true }),
      RECORD_TIMEOUT_MS,
      async () => closeAutomationSession(worker.session)
    );
    response = {
      ...retry,
      retriedAfterClosedSession: true,
      firstError,
      firstDebug: retry.ok ? null : firstDebug
    };

    if (retry.ok) {
      await cleanupDebugArtifact(firstDebug).catch(() => {});
    }
  }

  job.done += 1;
  worker.recordsInCurrentSession += 1;
  workerState.finishedLastRowAt = new Date().toISOString();

  const durationMs = response.durationMs || (Date.now() - startedAt);

  if (response.cancelled || job.cancelRequested) {
    job.cancelled += 1;
    const item = {
      ok: false,
      cancelled: true,
      workerId: worker.id,
      rowNumber: record.rowNumber,
      name: record.input.name,
      address: record.input.address,
      error: job.fatalReason || 'Przerwano przez użytkownika',
      durationMs,
      calculated: response.result?.calculated,
      pdfTrim: response.pdfTrim
    };
    job.results.push(item);
    await appendJobEvent(job, 'record-cancelled', item);
  } else if (response.ok) {
    worker.closedSessionStreak = 0;
    job.closedSessionStreak = 0;
    if (response.skippedExisting) job.skippedExisting += 1;
    else job.ok += 1;
    const item = {
      ok: true,
      workerId: worker.id,
      rowNumber: record.rowNumber,
      name: record.input.name,
      address: record.input.address,
      pdf: response.pdf,
      // Wskazuje na PRAWDZIWY endpoint serwujacy ten plik (server.js:
      // GET /api/batch/pdf/:jobId/:rowNumber), nie na surowa sciezke
      // filesystemowa - "output/..." nigdy nie bylo pod zadnym
      // express.static, wiec link "Otworz PDF" konczylby sie 404 bez
      // pokrywajacej to logiki w publicJob() po stronie server.js.
      pdfUrl: response.pdf ? `api/batch/pdf/${encodeURIComponent(job.id)}/${encodeURIComponent(record.rowNumber)}` : null,
      skippedExisting: !!response.skippedExisting,
      retriedAfterClosedSession: !!response.retriedAfterClosedSession,
      durationMs,
      calculated: response.result?.calculated,
      pdfTrim: response.pdfTrim
    };
    job.results.push(item);
    await appendJobEvent(job, response.skippedExisting ? 'record-skipped-existing' : 'record-success', item);
  } else {
    job.failed += 1;
    const closedSession = isClosedSessionError(response.error);
    if (closedSession) {
      worker.closedSessionStreak = (worker.closedSessionStreak || 0) + 1;
      job.closedSessionStreak = (job.closedSessionStreak || 0) + 1;
      job.closedSessionErrors = (job.closedSessionErrors || 0) + 1;
    } else {
      worker.closedSessionStreak = 0;
      job.closedSessionStreak = 0;
    }

    const item = {
      workerId: worker.id,
      rowNumber: record.rowNumber,
      name: record.input.name,
      address: record.input.address,
      error: response.error,
      firstError: response.firstError,
      closedSession,
      timeout: isTimeoutError(response),
      durationMs,
      calculated: response.result?.calculated,
      debug: response.debug,
      firstDebug: response.firstDebug
    };
    job.errors.push(item);
    job.results.push({ ok: false, ...item });
    await appendJobEvent(job, 'record-error', item);

    if (closedSession && (worker.closedSessionStreak >= MAX_CLOSED_SESSION_STREAK || job.closedSessionStreak >= MAX_JOB_CLOSED_SESSION_STREAK)) {
      const reason = `Zbyt dużo błędów zamkniętej sesji Chrome. Worker streak=${worker.closedSessionStreak}, job streak=${job.closedSessionStreak}.`;
      markCircuitBreaker(job, reason);
      await appendJobEvent(job, 'circuit-breaker', { workerId: worker.id, reason });
      await closeJobSessions(job, 'circuit-breaker').catch(() => {});
    }
  }

  if (!job.cancelRequested && (!sessionLooksUsable(worker.session) || isClosedSessionError(response.error) || isTimeoutError(response))) {
    unregisterJobSession(job, worker.session);
    worker.session = await replaceBatchSession(worker.session, outputRoot, job, `restart-after-row-${record.rowNumber}`, worker.id);
    registerJobSession(job, worker.session);
    worker.recordsInCurrentSession = 0;
  }

  workerState.current = null;
  workerState.status = 'idle';
  updateCurrentFromWorkers(job);
}

export async function runBatchJob(job, filePath, options = {}) {
  job.status = 'reading-excel';
  job.startedAt = new Date().toISOString();
  const outputBase = getOutputRoot();
  const { jobRoot, pdfDir } = await ensureJobWorkspace(job, outputBase);
  await appendJobEvent(job, 'job-created', { sourceFile: job.sourceFile, options: job.options });

  const parsed = await readExcelRecords(filePath, options.location || '');
  const allRecords = parsed.records;
  const selectedRows = normalizeSelectedRows(options.selectedRows);
  const selectedSet = new Set(selectedRows.map(String));
  const recordsToProcess = selectedSet.size ? allRecords.filter(record => selectedSet.has(String(record.rowNumber))) : allRecords;
  parsed.records = recordsToProcess;
  job.selectedRows = selectedRows;
  job.eligibleTotal = allRecords.length;
  job.selectedTotal = recordsToProcess.length;
  const concurrency = clampConcurrency(options.concurrency);
  job.sheetName = parsed.sheetName;
  job.headers = parsed.headers;
  job.skipped = parsed.skipped;
  job.totalRows = parsed.totalRows;
  job.total = parsed.records.length;
  job.pdfDir = pdfDir;
  job.concurrency = concurrency;
  job.activeWorkers = {};
  if (!job.cancelRequested) job.status = 'running';
  await appendJobEvent(job, 'job-start', { total: job.total, totalRows: job.totalRows, eligibleTotal: job.eligibleTotal, selectedRows: selectedRows.length, concurrency, sheetName: job.sheetName, skipped: job.skipped });

  if (!parsed.records.length) {
    job.status = 'finished';
    job.finishedAt = new Date().toISOString();
    await appendJobEvent(job, 'job-empty', { message: selectedRows.length ? 'Nie wybrano pasujących adresów z Excela.' : 'Nie znaleziono adresów do wygenerowania.' });
    await writeResultsCsv(job);
    await writeSummary(job);
    return;
  }

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(parsed.records.length, 1)) }, (_, i) => ({
    id: i + 1,
    session: null,
    recordsInCurrentSession: 0,
    closedSessionStreak: 0
  }));

  const takeNext = () => {
    if (job.cancelRequested) return null;
    if (nextIndex >= parsed.records.length) return null;
    const index = nextIndex;
    nextIndex += 1;
    return { index, record: parsed.records[index] };
  };

  async function runWorker(worker) {
    ensureWorkerState(job, worker.id).status = 'starting';
    try {
      if (job.cancelRequested) return;
      worker.session = await createAutomationSession(jobRoot);
      registerJobSession(job, worker.session);
      ensureWorkerState(job, worker.id).status = 'idle';
      await appendJobEvent(job, 'worker-start', { workerId: worker.id });

      while (!job.cancelRequested) {
        const item = takeNext();
        if (!item) break;
        await processRecordWithWorker(item.record, item.index, worker, job, pdfDir, jobRoot, options);
      }
    } catch (error) {
      if (!job.cancelRequested) {
        job.failed += 1;
        const err = {
          workerId: worker.id,
          error: String(error?.message || error),
          stack: String(error?.stack || '')
        };
        job.errors.push(err);
        job.results.push({ ok: false, ...err });
        await appendJobEvent(job, 'worker-error', err);
      }
    } finally {
      unregisterJobSession(job, worker.session);
      await closeAutomationSession(worker.session);
      clearWorkerState(job, worker.id);
      updateCurrentFromWorkers(job);
      await appendJobEvent(job, 'worker-finished', { workerId: worker.id });
    }
  }

  try {
    await Promise.all(workers.map(worker => runWorker(worker)));
    if (job.fatalReason) {
      job.status = 'fatal-error';
    } else if (job.cancelRequested) {
      job.status = 'cancelled';
      job.cancelledRemaining = Math.max(0, job.total - job.done);
    } else {
      job.status = job.failed ? 'finished-with-errors' : 'finished';
    }
  } catch (error) {
    job.status = 'fatal-error';
    job.fatalReason = String(error?.message || error);
    job.errors.push({ error: job.fatalReason, stack: String(error?.stack || '') });
    await appendJobEvent(job, 'fatal-error', { error: job.fatalReason, stack: String(error?.stack || '') }).catch(() => {});
  } finally {
    await closeJobSessions(job, 'job-finished-cleanup').catch(() => {});

    if (job.errors.length || job.fatalReason) {
      const errorsFile = path.join(jobRoot, 'bledy.txt');
      const lines = job.errors.map(err => {
        const workerText = err.workerId ? `Worker ${err.workerId}, ` : '';
        return `${workerText}Wiersz ${err.rowNumber || '?'}: ${err.name || ''} ${err.address || ''} - ${err.error || 'Błąd'}`.trim();
      });
      if (job.fatalReason) lines.push(`Błąd krytyczny: ${job.fatalReason}`);
      await fs.writeFile(errorsFile, lines.join('\n'), 'utf8').catch(() => {});
      job.errorsFile = errorsFile;
    }

    job.finishedAt = new Date().toISOString();
    job.current = null;
    job.activeWorkers = {};
    await writeResultsCsv(job);
    await writeSummary(job);
    await appendJobEvent(job, 'job-finished', { status: job.status, done: job.done, ok: job.ok, failed: job.failed, cancelled: job.cancelled, skippedExisting: job.skippedExisting });
    await fs.unlink(filePath).catch(() => {});
  }
}

export async function runAutomation(input) {
  const result = calculate(input);
  if (!result.calculated.valid) {
    return { ok: false, blocked: true, result, error: result.calculated.errors.join(' ') };
  }
  const outputRoot = getOutputRoot();
  const tmpDir = path.join(outputRoot, 'tmp', 'single');
  const pdfDir = path.join(outputRoot, 'pdf');
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(pdfDir, { recursive: true });

  let session = null;
  try {
    session = await createAutomationSession(outputRoot);
    if (TRACE_MODE || DEBUG_MODE) {
      await session.context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});
    }

    const tmpPdf = await runEcodanFlow(session.page, input, result, tmpDir);

    // W trybie pojedynczego rekordu zamykamy widoczną przeglądarkę od razu po pobraniu PDF.
    if (TRACE_MODE || DEBUG_MODE) await session.context.tracing.stop().catch(() => {});
    await closeAutomationSession(session);
    session = null;

    let pdfValidation;
    try {
      pdfValidation = await validatePdfProduct(tmpPdf, result);
    } catch (validationError) {
      const invalidPdf = await quarantineInvalidPdf(tmpPdf, String(validationError?.message || validationError), outputRoot);
      throw new Error(`${String(validationError?.message || validationError)}. Błędny PDF przeniesiono do: ${invalidPdf || 'debug/invalid-pdf'}`);
    }

    const pdf = path.join(pdfDir, makePdfName(input));
    await fs.rename(tmpPdf, pdf).catch(async () => {
      await fs.copyFile(tmpPdf, pdf);
      await fs.unlink(tmpPdf).catch(() => {});
    });

    const pdfTrim = await keepFirstPdfPages(pdf).catch(error => ({ ok: false, error: String(error?.message || error) }));
    if (!pdfTrim.ok) throw new Error(`Nie udało się skrócić PDF do pierwszych 3 stron: ${pdfTrim.error}`);

    return { ok: true, result, pdf, pdfValidation, pdfTrim };
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let tracePath = null;
    if (session && (TRACE_MODE || DEBUG_MODE)) {
      tracePath = path.join(outputRoot, 'debug', `${stamp}-automation-error.trace.zip`);
      await session.context.tracing.stop({ path: tracePath }).catch(() => {});
    }

    const page = session?.page;
    const extra = page && !page.isClosed()
      ? {
          runtimeEvents: session.runtimeEvents,
          cwuState: await captureCwuState(page, Number(result.calculated.tankLitres || 200)).catch(() => null),
          result
        }
      : { runtimeEvents: session?.runtimeEvents || [], pageClosed: true, result };

    const debug = await saveDebug(page, 'automation-error', String(error?.stack || error?.message || error), extra, outputRoot);
    if (tracePath) debug.trace = tracePath;

    await closeAutomationSession(session);
    return {
      ok: false,
      result,
      error: String(error?.message || error),
      debug,
      note: 'Automat zatrzymał się. Sprawdź output/debug: screenshot, HTML, TXT, JSON i trace.zip.'
    };
  }
}
