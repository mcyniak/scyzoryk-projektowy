import fs from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';

// name/address/error w tym CSV pochodza z wgranego przez klienta Excela.
// Samo cudzyslowanie chroni tylko przed rozjechaniem kolumn, nie przed CSV
// formula injection: wartosc zaczynajaca sie od =, +, -, @ (albo tab/CR) jest
// przez Excel/LibreOffice przy otwarciu interpretowana jako formula, co przy
// spreparowanej nazwie/adresie mogloby wykonac kod na komputerze osoby
// otwierajacej ten raport. Dopisujemy wiodacy apostrof, zeby wymusic tekst.
function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function cleanPathInput(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function isInsideOrEqual(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeOutputBase(defaultOutputRoot) {
  const configured = cleanPathInput(process.env.SCYZORYK_OUTPUT_BASE || '');
  return path.resolve(configured || defaultOutputRoot);
}

function safeFolderName(value, fallback = 'inwestycja') {
  const cleaned = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = sanitize(cleaned).replace(/\s+/g, ' ').trim();
  return (safe || fallback).slice(0, 120);
}

function makeTimestampForFolder(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function getInvestmentFolderName(job) {
  const requested = String(job?.options?.investmentName || '').trim();
  if (requested) return safeFolderName(requested, `zadanie-${job.id}`);

  const sourceBase = String(job?.sourceFile || '').replace(/\.(xlsx|xls)$/i, '').trim();
  if (sourceBase) return safeFolderName(sourceBase, `zadanie-${job.id}`);

  return `zadanie-${job.id}`;
}

export function resolveJobWorkspaceRoot(job, outputRoot) {
  const rawOutputPath = cleanPathInput(job?.options?.outputPath || '');
  const investmentFolder = getInvestmentFolderName(job);

  const allowedBase = safeOutputBase(outputRoot);
  if (rawOutputPath) {
    const requestedBase = path.resolve(rawOutputPath);
    if (isInsideOrEqual(allowedBase, requestedBase)) return path.join(requestedBase, investmentFolder);
    job.outputPathWarning = `Podany folder wyjściowy jest poza dozwolonym miejscem. Używam bezpiecznego folderu: ${allowedBase}`;
  }
  const fallbackName = `${investmentFolder}-${makeTimestampForFolder()}-${String(job.id).slice(-6)}`;
  return path.join(allowedBase, 'jobs', safeFolderName(fallbackName, `zadanie-${job.id}`));
}

export async function ensureJobWorkspace(job, outputRoot) {
  const jobRoot = resolveJobWorkspaceRoot(job, outputRoot);
  const pdfDir = path.join(jobRoot, 'pdf');
  const tmpDir = path.join(jobRoot, 'tmp');
  const debugDir = path.join(jobRoot, 'debug');
  const logsDir = path.join(jobRoot, 'logs');
  await Promise.all([
    fs.mkdir(pdfDir, { recursive: true }),
    fs.mkdir(tmpDir, { recursive: true }),
    fs.mkdir(debugDir, { recursive: true }),
    fs.mkdir(logsDir, { recursive: true })
  ]);
  job.outputRoot = jobRoot;
  job.pdfDir = pdfDir;
  job.tmpDir = tmpDir;
  job.debugDir = debugDir;
  job.logsDir = logsDir;
  job.telemetryFile = path.join(logsDir, 'events.jsonl');
  job.resultsCsv = path.join(jobRoot, 'wyniki.csv');
  job.summaryFile = path.join(jobRoot, 'podsumowanie.json');
  job.investmentFolder = path.basename(jobRoot);
  job.customOutputPath = job.outputPathWarning ? null : (cleanPathInput(job?.options?.outputPath || '') || null);
  return { jobRoot, pdfDir, tmpDir, debugDir, logsDir };
}

// Ten log techniczny (events.jsonl) zyje obok wygenerowanych PDF-ow, ale to
// NIE jest raport dla operatora (tym jest wyniki.csv/podsumowanie.json,
// gdzie imie/adres sa potrzebne, bo o to caly raport chodzi) - to surowy
// strumien zdarzen do diagnostyki technicznej. Zgodnie z decyzja "brak
// trwalych logow uzytkownikow" nie duplikujemy w nim danych klienta - numer
// wiersza wystarczy zeby w razie potrzeby zestawic zdarzenie z wyniki.csv.
function stripCustomerFields(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { name, address, ...rest } = payload;
  return rest;
}

export async function appendJobEvent(job, type, payload = {}) {
  if (!job?.telemetryFile) return;
  const event = {
    at: new Date().toISOString(),
    jobId: job.id,
    type,
    ...stripCustomerFields(payload)
  };
  await fs.appendFile(job.telemetryFile, JSON.stringify(event) + '\n', 'utf8').catch(() => {});
}

export async function writeResultsCsv(job) {
  if (!job?.resultsCsv) return;
  const header = ['status','rowNumber','workerId','name','address','pdf','error','skippedExisting','retriedAfterClosedSession','durationMs'];
  const lines = [header.join(';')];
  for (const row of job.results || []) {
    const status = row.cancelled ? 'cancelled' : row.ok ? (row.skippedExisting ? 'skipped-existing' : 'ok') : 'error';
    lines.push([
      status,
      row.rowNumber || '',
      row.workerId || '',
      row.name || '',
      row.address || '',
      row.pdf || '',
      row.error || '',
      row.skippedExisting ? 'true' : 'false',
      row.retriedAfterClosedSession ? 'true' : 'false',
      row.durationMs || ''
    ].map(csvEscape).join(';'));
  }
  await fs.writeFile(job.resultsCsv, lines.join('\n'), 'utf8').catch(() => {});
}

export async function writeSummary(job) {
  if (!job?.summaryFile) return;
  const summary = {
    id: job.id,
    sourceFile: job.sourceFile,
    investmentName: job.options?.investmentName || null,
    investmentFolder: job.investmentFolder || null,
    customOutputPath: job.customOutputPath || null,
    outputPathWarning: job.outputPathWarning || null,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    total: job.total,
    done: job.done,
    ok: job.ok,
    failed: job.failed,
    cancelled: job.cancelled,
    skippedExisting: job.skippedExisting,
    concurrency: job.concurrency,
    restartedSessions: job.restartedSessions || 0,
    closedSessionErrors: job.closedSessionErrors || 0,
    fatalReason: job.fatalReason || null,
    outputRoot: job.outputRoot,
    pdfDir: job.pdfDir,
    errorsFile: job.errorsFile,
    resultsCsv: job.resultsCsv,
    telemetryFile: job.telemetryFile
  };
  await fs.writeFile(job.summaryFile, JSON.stringify(summary, null, 2), 'utf8').catch(() => {});
}
