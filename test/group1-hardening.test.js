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
