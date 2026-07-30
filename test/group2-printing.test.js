const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const printing = require('../lib/printing');
const {
  PrintLeaseBusyError,
  readLock,
  withPrintLease
} = require('../lib/printCoordinator');

function withDataRoot(tempRoot, body) {
  const previous = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = tempRoot;
  return Promise.resolve()
    .then(body)
    .finally(() => {
      if (previous === undefined) delete process.env.SCYZORYK_DATA_ROOT;
      else process.env.SCYZORYK_DATA_ROOT = previous;
    });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 3000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test('globalny lease odrzuca konkurencyjny druk i przejmuje martwy lock', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-print-lock-'));
  try {
    await withDataRoot(tempRoot, async () => {
      let releaseFirst;
      let enteredFirst;
      const entered = new Promise(resolve => { enteredFirst = resolve; });
      const hold = new Promise(resolve => { releaseFirst = resolve; });
      const first = withPrintLease({ app: 'drukarka' }, async () => {
        enteredFirst();
        await hold;
      });
      await entered;

      await assert.rejects(
        withPrintLease({ app: 'drukarka-projekty' }, async () => {}),
        error => error instanceof PrintLeaseBusyError && error.ownerMeta.app === 'drukarka'
      );
      releaseFirst();
      await first;
      assert.equal(await readLock(), null);

      const lockDir = path.join(tempRoot, 'runtime', 'printing');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'active.lock'), JSON.stringify({
        pid: 2147483647,
        token: 'martwy',
        app: 'stary-proces'
      }), 'utf8');
      await withPrintLease({ app: 'drukarka-projekty' }, async () => {});
      assert.equal(await readLock(), null);
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('drugi endpoint drukowania dostaje HTTP 409 podczas aktywnego lease', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-print-http-'));
  let releaseFirst;
  const hold = new Promise(resolve => { releaseFirst = resolve; });

  function createPrintServer(appName, shouldHold) {
    return http.createServer(async (req, res) => {
      try {
        await withPrintLease({ app: appName }, async () => {
          if (shouldHold) await hold;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch (error) {
        if (error instanceof PrintLeaseBusyError) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: error.code, owner: error.ownerMeta }));
          return;
        }
        res.writeHead(500);
        res.end();
      }
    });
  }

  try {
    await withDataRoot(tempRoot, async () => {
      const firstServer = createPrintServer('drukarka', true);
      const secondServer = createPrintServer('drukarka-projekty', false);
      const firstPort = await listen(firstServer);
      const secondPort = await listen(secondServer);

      try {
        const firstRequest = request(firstPort);
        while ((await readLock())?.app !== 'drukarka') {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const secondResponse = await request(secondPort);
        assert.equal(secondResponse.statusCode, 409);
        assert.equal(JSON.parse(secondResponse.body).code, 'PRINT_LOCK_BUSY');

        releaseFirst();
        assert.equal((await firstRequest).statusCode, 200);
      } finally {
        releaseFirst();
        await Promise.all([close(firstServer), close(secondServer)]);
      }
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('duplex jest przywracany w finally po bledzie serii', async () => {
  const commands = [];
  const runPowerShell = async (scriptPath, args) => {
    const command = args[1];
    commands.push(command);
    if (commands.length === 1) {
      return { stdout: 'Drukarka testowa|jednostronnie|TwoSidedShortEdge\r\n' };
    }
    return { stdout: 'OK\r\n' };
  };

  await assert.rejects(
    printing.withPrinterSides('one-sided', 'Drukarka testowa', async setup => {
      assert.equal(setup.previousDuplexingMode, 'TwoSidedShortEdge');
      throw new Error('blad serii');
    }, { platform: 'win32', runPowerShell }),
    /blad serii/
  );

  assert.equal(commands.length, 2);
  assert.match(commands[0], /Get-PrintConfiguration/);
  assert.match(commands[1], /TwoSidedShortEdge/);
  assert.match(commands[1], /Set-PrintConfiguration/);
});

test('skrypt nie dotyka cudzych okien i drukuje DOCX przez wlasny Word COM', () => {
  const root = path.resolve(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'lib', 'printing', 'print-file.ps1'), 'utf8');
  assert.doesNotMatch(script, /Set-PrintAppWindowsMinimized/);
  assert.doesNotMatch(script, /Get-Process\s+-Name\s+(?:Acrobat|AcroRd32|WINWORD)/i);
  assert.match(script, /New-Object -ComObject Word\.Application/);
  assert.match(script, /\$word\.ActivePrinter = \$PrinterName/);

  for (const file of ['apps/drukarka/server.js', 'apps/drukarka-projekty/server.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /withPrintLease/);
    assert.match(source, /PRINT_LOCK_BUSY/);
    assert.doesNotMatch(source, /closePdfAppsAfterBatch/);
  }
});
