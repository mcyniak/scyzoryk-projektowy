// 1:1 wzor z apps/formularze-ecodan/src/telemetry.js (folder roboczy per
// zadanie, CSV wynikow, log JSONL bez danych klienta) - patrz tam po
// uzasadnienie kazdej decyzji.
import fs from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';

function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function cleanPathInput(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function safeOutputBase(defaultOutputRoot) {
  const configured = cleanPathInput(process.env.SCYZORYK_OUTPUT_BASE || '');
  return path.resolve(configured || defaultOutputRoot);
}

function safeFolderName(value, fallback = 'inwestycja') {
  const cleaned = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const safe = sanitize(cleaned).replace(/\s+/g, ' ').trim();
  return (safe || fallback).slice(0, 120);
}

export function getInvestmentFolderName(job) {
  const requested = String(job?.options?.investmentName || '').trim();
  if (requested) return safeFolderName(requested, `zadanie-${job.id}`);
  const sourceBase = String(job?.sourceFile || '').replace(/\.(xlsx|xls)$/i, '').trim();
  if (sourceBase) return safeFolderName(sourceBase, `zadanie-${job.id}`);
  return `zadanie-${job.id}`;
}

export function resolveJobWorkspaceRoot(job, outputRoot) {
  const investmentFolder = getInvestmentFolderName(job);
  const allowedBase = safeOutputBase(outputRoot);
  return path.join(allowedBase, 'jobs', investmentFolder);
}

export function resolvePdfDir(job, jobRoot) {
  const rawOutputPath = cleanPathInput(job?.options?.outputPath || '');
  if (rawOutputPath) return path.resolve(rawOutputPath);
  return path.join(jobRoot, 'pdf');
}
export async function ensureJobWorkspace(job, outputRoot) {
  const jobRoot = resolveJobWorkspaceRoot(job, outputRoot);
  const pdfDir = resolvePdfDir(job, jobRoot);
  const debugDir = path.join(jobRoot, 'debug');
  const logsDir = path.join(jobRoot, 'logs');
  await Promise.all([
    fs.mkdir(pdfDir, { recursive: true }),
    fs.mkdir(debugDir, { recursive: true }),
    fs.mkdir(logsDir, { recursive: true })
  ]);
  job.outputRoot = jobRoot;
  job.pdfDir = pdfDir;
  job.debugDir = debugDir;
  job.logsDir = logsDir;
  job.telemetryFile = path.join(logsDir, 'events.jsonl');
  job.resultsCsv = path.join(jobRoot, 'wyniki.csv');
  job.summaryFile = path.join(jobRoot, 'podsumowanie.json');
  job.investmentFolder = path.basename(jobRoot);
  job.customOutputPath = job.outputPathWarning ? null : (cleanPathInput(job?.options?.outputPath || '') || null);
  return { jobRoot, pdfDir, debugDir, logsDir };
}

// Ten log techniczny NIE zawiera danych klienta (imie/adres) - zgodnie z ta
// sama decyzja co w Ecodanie ("brak trwalych logow uzytkownikow"), numer
// wiersza wystarczy zeby zestawic zdarzenie z wyniki.csv w razie potrzeby.
function stripCustomerFields(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { name, address, email, ...rest } = payload;
  return rest;
}

export async function appendJobEvent(job, type, payload = {}) {
  if (!job?.telemetryFile) return;
  const event = { at: new Date().toISOString(), jobId: job.id, type, ...stripCustomerFields(payload) };
  await fs.appendFile(job.telemetryFile, JSON.stringify(event) + '\n', 'utf8').catch(() => {});
}

export async function writeResultsCsv(job) {
  if (!job?.resultsCsv) return;
  const header = ['status', 'rowNumber', 'name', 'address', 'pdf', 'error', 'skippedExisting', 'durationMs'];
  const lines = [header.join(';')];
  for (const row of job.results || []) {
    const status = row.cancelled ? 'cancelled' : row.ok ? (row.skippedExisting ? 'skipped-existing' : 'ok') : 'error';
    lines.push([status, row.rowNumber || '', row.name || '', row.address || '', row.pdf || '', row.error || '', row.skippedExisting ? 'true' : 'false', row.durationMs || '']
      .map(csvEscape).join(';'));
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
    unknownCaptchaIcons: job.unknownCaptchaIcons || 0,
    emailTimeouts: job.emailTimeouts || 0,
    fatalReason: job.fatalReason || null,
    outputRoot: job.outputRoot,
    pdfDir: job.pdfDir,
    resultsCsv: job.resultsCsv,
    telemetryFile: job.telemetryFile
  };
  await fs.writeFile(job.summaryFile, JSON.stringify(summary, null, 2), 'utf8').catch(() => {});
}
