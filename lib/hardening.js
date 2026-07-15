const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return JSON.stringify({ message: String(value) }); }
}

function appendJsonLine(filePath, payload) {
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, safeJson({ ts: nowIso(), ...payload }) + '\n', 'utf8');
  } catch (_) {}
}

function writeDiagnosticReport(logDir, reason) {
  try {
    if (!process.report || typeof process.report.writeReport !== 'function') return '';
    ensureDir(logDir);
    const file = path.join(logDir, `node-report-${Date.now()}-${String(reason || 'event').replace(/[^a-z0-9_-]+/gi, '_')}.json`);
    process.report.writeReport(file);
    return file;
  } catch (_) {
    return '';
  }
}

// Jeden wspolny plik na WSZYSTKIE aplikacje dla najpowazniejszych zdarzen
// (fatal/error) - zamiast przegladac logi kazdej aplikacji z osobna (7+
// plikow), wystarczy sprawdzic to jedno miejsce. Celowo NIE duplikuje
// calego contentu z logow per-aplikacja (te nadal istnieja, ze wszystkimi
// szczegolami/info-levelami) - tu trafiaja tylko rzeczy faktycznie warte
// natychmiastowej uwagi. lib/hardening.js zawsze siedzi w <root>/lib/, wiec
// polozenie tego pliku jest stale i nie wymaga zgadywania "gdzie jest
// korzen repo" z poziomu kazdej aplikacji-dziecka z osobna.
const CRITICAL_LOG_PATH = process.env.SCYZORYK_CRITICAL_LOG || path.join(__dirname, '..', 'logs', 'critical-errors.jsonl');

function appendCriticalLog(appName, level, event, data = {}) {
  appendJsonLine(CRITICAL_LOG_PATH, {
    level,
    app: appName,
    event,
    message: data.message || null,
  });
}

function setupProcessDiagnostics(appName, rootDir) {
  const logDir = ensureDir(path.join(rootDir || process.cwd(), 'logs'));
  const logFile = path.join(logDir, `${String(appName || 'app').replace(/[^a-z0-9_-]+/gi, '_')}.jsonl`);

  function log(level, event, data = {}) {
    appendJsonLine(logFile, {
      level,
      app: appName,
      event,
      pid: process.pid,
      memory: process.memoryUsage ? process.memoryUsage() : undefined,
      ...data,
    });
    if (level === 'fatal' || level === 'error') appendCriticalLog(appName, level, event, data);
  }

  process.on('uncaughtException', err => {
    const report = writeDiagnosticReport(logDir, 'uncaughtException');
    log('fatal', 'uncaughtException', { message: err?.message || String(err), stack: err?.stack || '', report });
    setTimeout(() => process.exit(1), 50).unref();
  });

  process.on('unhandledRejection', err => {
    const report = writeDiagnosticReport(logDir, 'unhandledRejection');
    log('error', 'unhandledRejection', { message: err?.message || String(err), stack: err?.stack || '', report });
  });

  log('info', 'process-start', { node: process.version, platform: process.platform, cwd: process.cwd() });
  return { logDir, logFile, log };
}

function applyHttpTimeouts(server, envPrefix = 'SCYZORYK') {
  const prefix = String(envPrefix || 'SCYZORYK').toUpperCase();
  const requestTimeout = Number(process.env[`${prefix}_REQUEST_TIMEOUT_MS`] || process.env.SCYZORYK_REQUEST_TIMEOUT_MS || 10 * 60 * 1000);
  const headersTimeout = Number(process.env[`${prefix}_HEADERS_TIMEOUT_MS`] || process.env.SCYZORYK_HEADERS_TIMEOUT_MS || 65 * 1000);
  const keepAliveTimeout = Number(process.env[`${prefix}_KEEPALIVE_TIMEOUT_MS`] || process.env.SCYZORYK_KEEPALIVE_TIMEOUT_MS || 5 * 1000);
  const socketTimeout = Number(process.env[`${prefix}_SOCKET_TIMEOUT_MS`] || process.env.SCYZORYK_SOCKET_TIMEOUT_MS || 10 * 60 * 1000);
  server.requestTimeout = requestTimeout;
  server.headersTimeout = Math.min(headersTimeout, requestTimeout || headersTimeout);
  server.keepAliveTimeout = keepAliveTimeout;
  server.timeout = socketTimeout;
  return server;
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function readJsonFileNoBom(filePath) {
  return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
}

function writeJsonFileNoBom(filePath, data) {
  ensureDir(path.dirname(filePath));
  const json = JSON.stringify(data, null, 2);
  // Zapis "na miejscu" moze zostawic uciety/uszkodzony plik JSON, jesli
  // proces padnie w trakcie pisania (awaria, restart, brak miejsca na
  // dysku) - kolejny odczyt tego pliku (np. przywracanie stanu zadan po
  // starcie) dostalby wtedy blad parsowania. Piszemy do pliku tymczasowego
  // obok docelowego i podmieniamy go dopiero po udanym zapisie - fs.renameSync
  // w obrebie tego samego wolumenu jest atomowe, wiec docelowy plik zawsze
  // jest albo w poprzednim, albo w nowym poprawnym stanie, nigdy w polowie.
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, json, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

function createSerialQueue(name = 'queue') {
  let tail = Promise.resolve();
  let queued = 0;
  let active = false;
  return {
    getState() { return { name, active, queued }; },
    run(task) {
      queued += 1;
      const runner = async () => {
        queued -= 1;
        active = true;
        try { return await task(); }
        finally { active = false; }
      };
      const result = tail.then(runner, runner);
      tail = result.catch(() => {});
      return result;
    },
  };
}

// Jak createSerialQueue, ale pozwala na N rownoleglych zadan zamiast
// sztywno jednego - potrzebne np. w formularze-ecodan, gdzie limit
// rownoczesnych "ciezkich" zadan (kazde odpala wlasna przegladarke
// Chromium) ma byc KONFIGUROWALNY (SCYZORYK_MAX_ECODAN_JOBS), nie zawsze
// rowny 1. setLimit() pozwala zmienic limit w locie bez restartu procesu.
function createSemaphore(limit = 1) {
  let currentLimit = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];

  function tryRun() {
    while (active < currentLimit && queue.length > 0) {
      active += 1;
      const { task, resolve, reject } = queue.shift();
      Promise.resolve().then(task).then(
        value => { active -= 1; resolve(value); tryRun(); },
        err => { active -= 1; reject(err); tryRun(); }
      );
    }
  }

  return {
    getState() { return { active, queued: queue.length, limit: currentLimit }; },
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        tryRun();
      });
    },
    setLimit(newLimit) {
      currentLimit = Math.max(1, Number(newLimit) || 1);
      tryRun();
    },
  };
}

function buildPowerShellCommand(scriptPath, args = [], options = {}) {
  const exe = options.exe || process.env.POWERSHELL_EXE || 'powershell.exe';
  const baseArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (scriptPath) return { exe, args: [...baseArgs, '-File', scriptPath, ...args] };
  // Stary silnik PowerShell (5.1) pisze do potoku (nie do konsoli) w systemowej
  // stronie kodowej, nie UTF-8 - polskie znaki (np. w nazwach drukarek) wychodza
  // uszkodzone. Wymuszamy UTF-8 na wyjsciu przed faktyczna komenda.
  const utf8Preamble = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); `;
  const patchedArgs = args.map((a, i) => (args[i - 1] === '-Command' ? utf8Preamble + a : a));
  return { exe, args: [...baseArgs, ...patchedArgs] };
}

function runPowerShell(scriptPath, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.SCYZORYK_PS_TIMEOUT_MS || 60 * 60 * 1000);
  const cwd = options.cwd || process.cwd();
  const windowsHide = options.windowsHide !== false;
  const { exe, args: psArgs } = buildPowerShellCommand(scriptPath, args, options);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(exe, psArgs, {
      cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (options.onStdout) options.onStdout(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; if (options.onStderr) options.onStderr(chunk); });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err.stdout = stripBom(stdout);
      err.stderr = stderr;
      err.durationMs = Date.now() - startedAt;
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, signal, stdout: stripBom(stdout), stderr, timedOut, durationMs: Date.now() - startedAt };
      if (timedOut || code !== 0) {
        const err = new Error(timedOut ? `PowerShell przekroczyl limit czasu ${timeoutMs} ms.` : (stderr || stdout || `PowerShell zakonczyl sie kodem ${code}.`));
        Object.assign(err, result);
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

function cleanupOldFiles(directory, maxAgeMs, options = {}) {
  const now = Date.now();
  const deleted = [];
  if (!directory || !fs.existsSync(directory)) return deleted;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        deleted.push(fullPath);
      }
    } catch (err) {
      if (options.log) options.log('warn', 'cleanup-failed', { path: fullPath, message: err?.message || String(err) });
    }
  }
  return deleted;
}

function scheduleCleanup(directories, maxAgeMs, intervalMs = 60 * 60 * 1000, options = {}) {
  const dirs = Array.isArray(directories) ? directories : [directories];
  const run = () => {
    for (const dir of dirs) cleanupOldFiles(dir, maxAgeMs, options);
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 10000).unref?.();
  return timer;
}

function sanitizeForLog(value, max = 2000) {
  const s = String(value || '');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

module.exports = {
  nowIso,
  ensureDir,
  appendJsonLine,
  setupProcessDiagnostics,
  appendCriticalLog,
  CRITICAL_LOG_PATH,
  applyHttpTimeouts,
  stripBom,
  readJsonFileNoBom,
  writeJsonFileNoBom,
  createSerialQueue,
  createSemaphore,
  runPowerShell,
  cleanupOldFiles,
  scheduleCleanup,
  sanitizeForLog,
};
