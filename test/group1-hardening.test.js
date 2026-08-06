const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');

const { acquireSingleInstanceLock } = require('../lib/singleInstanceLock');
const {
  FAILURE_WINDOW_MS,
  MAX_FAILURES_IN_WINDOW,
  recordChildFailure
} = require('../lib/childRestartPolicy');

test('blokada pojedynczej instancji odrzuca drugi proces i przejmuje osierocony lock', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-lock-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tempRoot;

  try {
    const first = acquireSingleInstanceLock();
    assert.equal(first.acquired, true);

    const second = acquireSingleInstanceLock();
    assert.equal(second.acquired, false);
    assert.equal(second.existingPid, process.pid);
    first.release();

    const lockDir = path.join(tempRoot, 'ScyzorykProjektowy', 'Data', 'runtime');
    const lockFile = path.join(lockDir, 'panel.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483647, token: 'stary' }));

    const afterStale = acquireSingleInstanceLock();
    assert.equal(afterStale.acquired, true);
    afterStale.release();
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('blokada pojedynczej instancji: zywy PID przejety przez inny proces (recydywa 2026-08-06) jest wciaz uznany za osierocony po utracie heartbeatu', async () => {
  // Realny incydent: po restarcie Windows przydzielil PID martwego
  // wlasciciela locka zupelnie innemu, dzialajacemu procesowi
  // (msedgewebview2.exe) - "PID zyje" wygladalo na prawde, wiec launcher w
  // kolko odmawial startu mimo ze nic faktycznie nie dzialalo. Symulujemy to
  // tutaj realnym, dzialajacym procesem podszywajacym sie pod stary lock ze
  // starym (nieodswiezanym) heartbeatem.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-lock-pidreuse-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tempRoot;
  let impostor;

  try {
    impostor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise(resolve => impostor.once('spawn', resolve));

    const lockDir = path.join(tempRoot, 'ScyzorykProjektowy', 'Data', 'runtime');
    const lockFile = path.join(lockDir, 'panel.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const staleHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: impostor.pid,
      token: 'stary-wlasciciel-juz-nie-zyje',
      startedAt: staleHeartbeat,
      heartbeatAt: staleHeartbeat
    }));

    const result = acquireSingleInstanceLock();
    assert.equal(result.acquired, true);
    result.release();
  } finally {
    if (impostor) impostor.kill();
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('blokada pojedynczej instancji: pusty (w trakcie zapisu) lock NIE jest cicho przejmowany (audyt rozdz. 28, P1)', () => {
  // claim() tworzy pusty plik przez 'wx', a dopiero POTEM zapisuje tresc
  // (tmp+rename) - miedzy tymi dwoma krokami inny proces moze zobaczyc
  // istniejacy, ale pusty plik. Symulujemy dokladnie ten moment recznie -
  // bez ponowien z retry w readLockSync taki plik wygladalby jak "brak
  // locka" i zostalby cicho skasowany/przejety w trakcie, gdy prawdziwy
  // wlasciciel wlasnie konczy start.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-lock-empty-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tempRoot;

  try {
    const lockDir = path.join(tempRoot, 'ScyzorykProjektowy', 'Data', 'runtime');
    const lockFile = path.join(lockDir, 'panel.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockFile, '');

    const result = acquireSingleInstanceLock();
    assert.equal(result.acquired, false, 'pusty lock nie moze byc cicho przejety - moze byc w trakcie zapisu przez prawdziwego wlasciciela');
    assert.equal(result.unreadable, true);
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('circuit breaker otwiera sie po pieciu awariach w oknie dziesieciu minut', () => {
  const meta = { failureTimestamps: [], circuitOpen: false, circuitReason: null };
  const startedAt = Date.now();

  for (let i = 0; i < MAX_FAILURES_IN_WINDOW - 1; i++) {
    assert.equal(recordChildFailure(meta, startedAt + i), false);
  }
  assert.equal(recordChildFailure(meta, startedAt + MAX_FAILURES_IN_WINDOW), true);
  assert.equal(meta.circuitOpen, true);
  assert.match(meta.circuitReason, /5 awarii/);

  const freshMeta = {
    failureTimestamps: [startedAt - FAILURE_WINDOW_MS - 1],
    circuitOpen: false,
    circuitReason: null
  };
  assert.equal(recordChildFailure(freshMeta, startedAt), false);
  assert.deepEqual(freshMeta.failureTimestamps, [startedAt]);
});

test('nieobsluzone odrzucenie zapisuje raport i konczy proces kodem 1', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-rejection-'));
  const childFile = path.join(__dirname, 'fixtures', 'unhandled-rejection-child.js');

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [childFile, tempRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('exit', code => resolve({ code, stderr }));
    });

    assert.equal(result.code, 1, result.stderr);
    const logsDir = path.join(tempRoot, 'logs');
    const files = fs.readdirSync(logsDir);
    assert.ok(files.some(file => /^node-report-.*-unhandledRejection\.json$/.test(file)));

    const log = fs.readFileSync(path.join(logsDir, 'unhandled-rejection-test.jsonl'), 'utf8');
    assert.match(log, /"event":"unhandledRejection"/);
    assert.match(log, /"level":"fatal"/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Realny blad zlapany na produkcji (2026-08): panel glowny odpytuje /api/health
// KAZDEJ apki co 10s (public/inline-1.js w korzeniu) - to ~90 zadan/15min z
// samego tylko panelu, w kazdej otwartej karcie przegladarki. apiLimiter
// "generic" (max 60/15min) bez wylaczenia GET wyczerpuje sie na samym
// health-checku i apka na zawsze wyglada w panelu jak "nie dziala" (429),
// mimo ze proces jest zdrowy. Kazda apka musi albo wylaczac GET z limitu,
// albo miec limit swiadomie podniesiony ponad ten ruch.
test('kazda apka wylacza GET z ogolnego limitu zadan API albo ma limit swiadomie podniesiony (regresja panelowego 429)', () => {
  const MIN_SAFE_MAX_WITHOUT_SKIP = 90; // panel sam generuje ~90 GET/15min na apke
  const appsDir = path.join(__dirname, '..', 'apps');
  const appNames = fs.readdirSync(appsDir).filter(name => fs.existsSync(path.join(appsDir, name, 'server.js')));
  const problems = [];

  for (const name of appNames) {
    const source = fs.readFileSync(path.join(appsDir, name, 'server.js'), 'utf8');
    const match = source.match(/const apiLimiter = rateLimit\(\{[\s\S]*?\n\}\);/);
    if (!match) continue; // apka bez ogolnego limitera na /api (nic do sprawdzenia)
    const block = match[0];
    const hasGetSkip = /skip:\s*\(req\)\s*=>\s*req\.method === ['"]GET['"]/.test(block);
    if (hasGetSkip) continue;

    const maxMatch = block.match(/max:\s*Number\(process\.env\.\w+\s*\|\|\s*(\d+)\)/);
    const defaultMax = maxMatch ? Number(maxMatch[1]) : 0;
    if (defaultMax < MIN_SAFE_MAX_WITHOUT_SKIP) {
      problems.push(`${name}: apiLimiter max=${defaultMax} bez skip GET (potrzeba >= ${MIN_SAFE_MAX_WITHOUT_SKIP} albo skip GET)`);
    }
  }

  assert.deepEqual(problems, []);
});
