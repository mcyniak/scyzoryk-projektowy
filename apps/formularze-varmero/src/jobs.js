// Orkiestracja paczki zgloszen - wzorowana na apps/formularze-ecodan/src/jobs.js
// (pula workerow, maszyna stanow joba, obsluga anulowania). Prostsze "utworz
// nowa sesje przy bledzie" bez Ecodanowego rozroznienia przyczyny bledu
// (closed-session-streak itp.) - Varmero nie ma dzis takiej kategorii.
// DOSTAJE JEDNAK ten sam prosty wylacznik calej paczki po serii bledow z
// rzedu (audyt 2026-08-21, patrz MAX_CONSECUTIVE_FAILURES w config.js) - bez
// niego, jesli strona Varmero sie zmieni/IMAP przestanie dzialac, KAZDY
// pozostaly wiersz i tak wysylalby REALNE zgloszenie do Varmero, zanim
// identyczny blad zostanie wykryty.
// Cykl zycia KAZDEGO wiersza ma jeden dodatkowy krok, ktorego Ecodan nie ma:
// po udanym zgloszeniu (submit) czeka na przychodzacy mail (mailbox.js)
// PRZED oznaczeniem wiersza jako gotowego.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sanitize from 'sanitize-filename';
import { readTabelaAdresowa } from './excel.js';
import { createAutomationSession, closeAutomationSession } from './automation/session.js';
import { gotoCalculator, fillCalculatorForm, submitForm } from './automation/steps.js';
import { solveCaptcha, UnknownCaptchaIconError } from './automation/captcha.js';
import { waitForVarmeroCard, NoNewEmailError } from './mailbox.js';
import { saveDebug } from './debug.js';
import { ensureJobWorkspace, appendJobEvent as appendJobEventRaw, writeResultsCsv, writeSummary } from './telemetry.js';
import { BATCH_CONCURRENCY_DEFAULT, EMAIL_WAIT_TIMEOUT_MS, CAPTCHA_MAX_ATTEMPTS, MAX_CONSECUTIVE_FAILURES } from './config.js';

export const jobs = new Map();
const jobSessions = new Map(); // jobId -> Set<session>

function terminalStatus(status) {
  return ['finished', 'finished-with-errors', 'cancelled', 'fatal-error'].includes(status);
}

// Audyt zuzycia RAM 2026-08-21: `jobs` rosla bez zadnego ograniczenia - po
// wielu paczkach mapa mialaby wpis na kazde zadanie, kazdy z wlasna
// tablica `results`/`errors`. AKTYWNE zadania (jeszcze nie terminalStatus)
// nigdy nie sa usuwane - usuwamy tylko zakonczone, i to dopiero gdy sa
// naprawde stare (7 dni) albo jest ich zbyt duzo naraz (ponad
// MAX_TERMINAL_JOBS, liczac od najstarszych). Same pliki wynikowe (karty
// PDF na dysku) NIE sa tu ruszane - to tylko czyszczenie stanu w pamieci.
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_TERMINAL_JOBS = 200;

export function pruneOldJobs() {
  const now = Date.now();
  const terminalEntries = [];
  for (const [id, job] of jobs.entries()) {
    if (!terminalStatus(job.status)) continue;
    const finishedAtMs = job.finishedAt ? Date.parse(job.finishedAt) : 0;
    if (now - finishedAtMs > JOB_RETENTION_MS) { jobs.delete(id); continue; }
    terminalEntries.push([id, finishedAtMs]);
  }
  if (terminalEntries.length > MAX_TERMINAL_JOBS) {
    terminalEntries.sort((a, b) => a[1] - b[1]);
    const toDelete = terminalEntries.length - MAX_TERMINAL_JOBS;
    for (let i = 0; i < toDelete; i += 1) jobs.delete(terminalEntries[i][0]);
  }
}

async function appendJobEvent(job, type, payload) {
  await appendJobEventRaw(job, type, payload);
}

function registerSession(jobId, session) {
  if (!jobSessions.has(jobId)) jobSessions.set(jobId, new Set());
  jobSessions.get(jobId).add(session);
}

function unregisterSession(jobId, session) {
  jobSessions.get(jobId)?.delete(session);
}

export async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (terminalStatus(job.status)) return { alreadyFinished: true, status: job.status };
  job.cancelRequested = true;
  job.status = 'cancelling';
  for (const session of jobSessions.get(jobId) || []) {
    await closeAutomationSession(session).catch(() => {});
  }
  return { alreadyFinished: false, status: job.status };
}

export async function cancelAllJobs(reason) {
  for (const job of jobs.values()) {
    if (!terminalStatus(job.status)) {
      job.cancelRequested = true;
      job.fatalReason = job.fatalReason || reason;
    }
  }
  for (const [jobId, sessions] of jobSessions) {
    for (const session of sessions) await closeAutomationSession(session).catch(() => {});
    jobSessions.delete(jobId);
  }
}

export function createJob({ sourceFile, options }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 15)}`;
  const job = {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    current: null,
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    cancelled: 0,
    skippedExisting: 0,
    skipped: {},
    results: [],
    errors: [],
    restartedSessions: 0,
    unknownCaptchaIcons: 0,
    emailTimeouts: 0,
    fatalReason: null,
    cancelRequested: false,
    sourceFile,
    options,
    concurrency: Math.max(1, Number(options?.concurrency) || BATCH_CONCURRENCY_DEFAULT)
  };
  pruneOldJobs();
  jobs.set(id, job);
  return job;
}

export function makePdfName(record) {
  const label = `${record.input.name || 'brak-nazwiska'} - ${record.input.address || 'brak-adresu'}`;
  // Przedrostek "Dob_" (wlasciciel, 2026-08-20) - pozwala odroznic gotowe PDF-y
  // doboru od innych plikow w tym samym folderze klienta i jest rozpoznawany
  // przez tryb "Dobory" w apps/karty-katalogowe (dopasowanie po adresie
  // dziala niezaleznie od przedrostka - patrz znajdzPlikiPoAdresie tamze).
  return sanitize(`Dob_${String(record.rowNumber).padStart(3, '0')} - ${label}.pdf`) || `Dob_${record.rowNumber}.pdf`;
}

async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

// Kazdy wiersz dostaje WLASNY, unikalny adres plusowy (baseEmail
// "jan@gmail.com" -> "jan+varmero-<12 losowych hex>@gmail.com"), zamiast
// jednego wspolnego adresu dla calej paczki - patrz szczegolowy komentarz w
// mailbox.js#waitForVarmeroCard o realnym bledzie, ktory to naprawia
// (dopasowanie po czasie zawodzilo, bo IMAP SINCE porownuje tylko date, nie
// dokladny czas). 96 bitow losowosci - kolizja praktycznie niemozliwa.
export function deriveSubmissionEmail(baseEmail) {
  const at = baseEmail.indexOf('@');
  if (at < 0) throw new Error(`Adres e-mail bez "@": ${baseEmail}`);
  const token = crypto.randomBytes(12).toString('hex');
  return `${baseEmail.slice(0, at)}+varmero-${token}${baseEmail.slice(at)}`;
}

async function processRecord(record, { job, session, imapConfig, baseEmail, skipExisting, createImapClient }) {
  const startedAt = Date.now();
  const base = { rowNumber: record.rowNumber, name: record.input.name, address: record.input.address };
  const pdfPath = path.join(job.pdfDir, makePdfName(record));
  if (skipExisting && await pathExists(pdfPath)) {
    await appendJobEvent(job, 'record-skipped-existing', { rowNumber: record.rowNumber });
    return { ...base, ok: true, skippedExisting: true, pdf: pdfPath, durationMs: Date.now() - startedAt };
  }

  const recipientEmail = deriveSubmissionEmail(baseEmail);
  await appendJobEvent(job, 'record-start', { rowNumber: record.rowNumber });

  try {
    await gotoCalculator(session.page);
    await fillCalculatorForm(session.page, record, recipientEmail);

    let iconLabel = null;
    let lastUnknownWord = null;
    for (let attempt = 1; attempt <= CAPTCHA_MAX_ATTEMPTS && !iconLabel; attempt += 1) {
      try {
        iconLabel = await solveCaptcha(session.page);
      } catch (err) {
        if (!(err instanceof UnknownCaptchaIconError)) throw err;
        job.unknownCaptchaIcons += 1;
        lastUnknownWord = err.word;
        if (attempt < CAPTCHA_MAX_ATTEMPTS) {
          await gotoCalculator(session.page);
          await fillCalculatorForm(session.page, record, recipientEmail);
        }
      }
    }
    if (!iconLabel) throw new Error(`Nie udało się trafić znanej ikony CAPTCHY po ${CAPTCHA_MAX_ATTEMPTS} próbach (ostatnie nieznane słowo: "${lastUnknownWord}").`);
    await appendJobEvent(job, 'captcha-solved', { rowNumber: record.rowNumber, icon: iconLabel });

    await submitForm(session.page);
    await appendJobEvent(job, 'submitted', { rowNumber: record.rowNumber });

    let card;
    try {
      card = await waitForVarmeroCard({
        imapConfig,
        recipientEmail,
        timeoutMs: EMAIL_WAIT_TIMEOUT_MS,
        createClient: createImapClient,
        isCancelled: () => job.cancelRequested
      });
    } catch (err) {
      if (err instanceof NoNewEmailError) job.emailTimeouts += 1;
      throw err;
    }

    await fs.writeFile(pdfPath, card.buffer);
    await appendJobEvent(job, 'record-ok', { rowNumber: record.rowNumber });
    return { ...base, ok: true, pdf: pdfPath, durationMs: Date.now() - startedAt };
  } catch (error) {
    const message = String(error?.message || error);
    await saveDebug(session.page, `row${record.rowNumber}-error`, message, null, job.outputRoot).catch(() => {});
    await appendJobEvent(job, 'record-error', { rowNumber: record.rowNumber, error: message });
    // cancelled: przerwanie na zadanie uzytkownika (patrz mailbox.js#CancelledWaitError)
    // NIE jest "prawdziwym" bledem - runWorker nie powinien liczyc tego do
    // wylacznika calej paczki (audyt 2026-08-21).
    return { ...base, ok: false, cancelled: error?.name === 'CancelledWaitError', error: message, durationMs: Date.now() - startedAt };
  }
}

// `createImapClient` jest wstrzykiwalny (testy jednostkowe) - domyslnie
// undefined, mailbox.js#waitForVarmeroCard sam zbuduje prawdziwy ImapFlow.
// `selectedRows` (opcjonalne, wzorem apps/formularze-ecodan) - lista numerow
// wierszy Excela do faktycznego przetworzenia; bez tego kazde uruchomienie
// zglaszaloby CALA tabele adresowa (dziesiatki/setki prawdziwych zgloszen
// naraz) - w praktyce zawsze chce sie wybrac konkretne, gotowe adresy.
export async function runBatchJob(job, excelFilePath, { email: baseEmail, imapConfig, gminaName, postalCode, zone, wojewodztwo, skipExisting = true, selectedRows, selectAll = false, createImapClient } = {}) {
  job.status = 'reading-excel';
  job.startedAt = new Date().toISOString();

  await ensureJobWorkspace(job, job.outputBase);

  let parsed;
  try {
    parsed = await readTabelaAdresowa(excelFilePath, { gminaName, postalCode, zone, wojewodztwo });
  } catch (error) {
    job.status = 'fatal-error';
    job.fatalReason = String(error?.message || error);
    job.finishedAt = new Date().toISOString();
    return job;
  }

  // Audyt 2026-08-21 (real incydent): pusta/brakujaca selekcja NIGDY nie
  // oznacza "zglos cala tabele" - /api/batch/start juz blokuje ten przypadek
  // u zrodla, ale ta funkcja jest tez wywolywalna bezposrednio (np. przez
  // pipeline), wiec ta sama ochrona zostaje TU jako druga warstwa - kazdy
  // wiersz to realne, nieodwracalne zgloszenie do Varmero.
  // Wyjatek selectAll: programatyczne wywolania miedzyapkami (pipeline) -
  // plik juz przefiltrowany przez selekcje uzytkownika, patrz server.js.
  const wanted = new Set(Array.isArray(selectedRows) ? selectedRows : []);
  const wszystkie = selectAll === true || String(selectAll).toLowerCase() === 'true';
  parsed = { ...parsed, records: wanted.size ? parsed.records.filter(r => wanted.has(r.rowNumber)) : (wszystkie ? parsed.records : []) };

  job.skipped = parsed.skipped;
  job.total = parsed.records.length;
  job.zoneKnown = parsed.zoneKnown;

  if (!parsed.records.length) {
    job.status = job.zoneKnown === false ? 'fatal-error' : 'finished';
    job.fatalReason = job.zoneKnown === false ? 'Podaj strefę klimatyczną (1-5) przed uruchomieniem paczki.' : job.fatalReason;
    job.finishedAt = new Date().toISOString();
    await writeSummary(job);
    return job;
  }

  job.status = 'running';
  const records = [...parsed.records];
  let nextIndex = 0;
  job.consecutiveFailures = 0;
  const takeNext = () => (job.cancelRequested || nextIndex >= records.length ? null : records[nextIndex++]);

  // Audyt 2026-08-21: wylacznik calej paczki po N zgloszeniach z rzedu
  // zakonczonych bledem - takie samo dzialanie jak wlasciciel zainicjowal
  // recznie przyciskiem "Anuluj" (job.cancelRequested = true), tylko
  // automatycznie i zanim caly pozostaly batch zdazy wyslac kolejne realne,
  // najprawdopodobniej rowniez nieudane zgloszenia do Varmero.
  function markCircuitBreaker(reason) {
    if (job.fatalReason) return;
    job.fatalReason = reason;
    job.cancelRequested = true;
    job.cancelRequestedAt = job.cancelRequestedAt || new Date().toISOString();
    job.circuitBroken = true;
  }

  async function runWorker(workerId) {
    let session = null;
    try {
      let record;
      while ((record = takeNext())) {
        // Audyt UX 2026-08-21: koncurrencja jest w UI na sztywno zablokowana
        // na 1 (index.html), wiec "worker N" pojawialo sie w KAZDYM komunikacie
        // postepu, mimo ze nigdy nie bylo realnie wiecej niz jeden - slowo bez
        // znaczenia dla nietechnicznego uzytkownika. Pokazujemy je tylko, gdy
        // faktycznie dziala wiecej niz jeden watek (np. przyszla zmiana
        // konfiguracji), zeby nie zgubic informacji diagnostycznej.
        job.current = workerCount > 1
          ? `worker ${workerId}: wiersz ${record.rowNumber} (${record.input.address})`
          : `wiersz ${record.rowNumber} (${record.input.address})`;
        const startedAt = Date.now();
        const pdfPath = path.join(job.pdfDir, makePdfName(record));
        let result;
        if (skipExisting && await pathExists(pdfPath)) {
          await appendJobEvent(job, 'record-skipped-existing', { rowNumber: record.rowNumber });
          result = {
            rowNumber: record.rowNumber,
            name: record.input.name,
            address: record.input.address,
            ok: true,
            skippedExisting: true,
            pdf: pdfPath,
            durationMs: Date.now() - startedAt
          };
        } else {
          if (!session) {
            session = await createAutomationSession(job.outputRoot);
            registerSession(job.id, session);
          }
          result = await processRecord(record, { job, session, imapConfig, baseEmail, skipExisting, createImapClient });
        }
        job.results.push(result);
        job.done += 1;
        if (result.ok) {
          if (result.skippedExisting) job.skippedExisting += 1;
          else { job.ok += 1; job.consecutiveFailures = 0; }
        }
        else {
          job.failed += 1;
          job.errors.push(result);
          // Przerwanie na zadanie uzytkownika (result.cancelled) nie jest
          // "prawdziwym" bledem strony/skrzynki - nie powinno wliczac sie do
          // wylacznika calej paczki (audyt 2026-08-21).
          if (!result.cancelled) {
            job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
            if (job.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              markCircuitBreaker(`Przerwano po ${job.consecutiveFailures} zgloszeniach z rzedu zakonczonych bledem - dalsze wiersze najprawdopodobniej takze by sie nie udaly (np. zmiana na stronie Varmero albo problem ze skrzynka IMAP).`);
            }
          }
        }

        // Sesja jest odtwarzana po kazdym wierszu, w ktorym cos nie
        // zadzialalo (formularz/CAPTCHA/submit) - prostsze niz Ecodanowy licznik
        // "closed session streak", wystarczajace przy tej skali paczek.
        if (!result.ok && session) {
          unregisterSession(job.id, session);
          await closeAutomationSession(session).catch(() => {});
          if (job.cancelRequested) break;
          session = await createAutomationSession(job.outputRoot);
          registerSession(job.id, session);
          job.restartedSessions += 1;
        }
      }
    } finally {
      if (session) {
        unregisterSession(job.id, session);
        await closeAutomationSession(session).catch(() => {});
      }
    }
  }

  const workerCount = Math.max(1, Math.min(job.concurrency, records.length));
  // Awaria workera (np. nieudany restart sesji Chromium) leciala przez
  // Promise.all i omijala writeResultsCsv/writeSummary ponizej - po serii
  // realnie wyslanych zgloszen uzytkownik nie dostawal ani CSV, ani
  // podsumowania. Artefakty zapisujemy zawsze, blad propagujemy dalej.
  let workerFatalError = null;
  try {
    await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(i + 1)));
  } catch (err) {
    workerFatalError = err;
    job.fatalError = String(err?.message || err);
    console.error(`[formularze-varmero] Awaria workera: ${job.fatalError}`);
  }

  job.current = null;
  job.finishedAt = new Date().toISOString();
  job.status = (workerFatalError || job.circuitBroken) ? 'fatal-error' : job.cancelRequested ? 'cancelled' : job.failed > 0 ? 'finished-with-errors' : 'finished';

  await writeResultsCsv(job);
  await writeSummary(job);
  if (workerFatalError) throw workerFatalError;
  return job;
}
