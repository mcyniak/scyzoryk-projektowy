// Testy systemu aktualizacji przez GitHub Releases: SemVer, dopasowanie
// wydania/assetow, pobieranie+SHA-256, maszyna stanow, bezpieczenstwo API
// tras panelu oraz migracja konfiguracji OCR. Zero prawdziwych polaczen do
// api.github.com - wszystkie testy sieciowe uzywaja lokalnego mock-serwera
// HTTP na loopbacku (patrz startMockServer nizej).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const {
  parseVersion, isValidVersion, compareVersions, isNewerVersion, toPlainVersion
} = require('../lib/updateVersion');
const { assetFileName, findExactAsset, fetchLatestRelease } = require('../lib/updateGithub');
const { downloadText, downloadToPartialFile, parseSha256File } = require('../lib/updateDownload');
const { createUpdateService, cleanupUpdatesDir } = require('../lib/updateService');
const { migrateOcrConfigIfNeeded, isCompleteConfig, userConfigPath } = require('../lib/ocrConfigMigration');

function withEnvironment(values, body) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise(r => server.close(r)) }));
  });
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// =====================================================================
// Wersjonowanie (lib/updateVersion.js)
// =====================================================================

test('SemVer: 1.0.1 jest nowsza niz 1.0.0', () => {
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
});

test('SemVer: 1.10.0 jest nowsza niz 1.9.0 (porownanie numeryczne, nie tekstowe)', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
  assert.equal(compareVersions('1.10.0', '1.9.0') > 0, true);
});

test('SemVer: 2.0.0 jest nowsza niz 1.99.99', () => {
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
});

test('SemVer: wersje rowne nie sa "nowsza"', () => {
  assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('SemVer: lokalna wersja wyzsza od wydania nigdy nie jest traktowana jako aktualizacja (brak downgrade)', () => {
  assert.equal(isNewerVersion('1.0.0', '1.2.0'), false);
});

test('SemVer: prefiks "v" jest akceptowany i tozsamy z wersja bez prefiksu', () => {
  const withPrefix = parseVersion('v1.2.0');
  const withoutPrefix = parseVersion('1.2.0');
  assert.deepEqual({ major: withPrefix.major, minor: withPrefix.minor, patch: withPrefix.patch }, { major: withoutPrefix.major, minor: withoutPrefix.minor, patch: withoutPrefix.patch });
  assert.equal(isNewerVersion('v2.0.0', '1.9.9'), true);
  assert.equal(toPlainVersion('v1.2.0'), '1.2.0');
});

test('SemVer: niepoprawny format jest odrzucany, nie cichy fallback', () => {
  assert.equal(isValidVersion('1.2'), false);
  assert.equal(isValidVersion('1.2.3-beta'), false);
  assert.equal(isValidVersion('abc'), false);
  assert.equal(isValidVersion(''), false);
  assert.throws(() => compareVersions('1.2.3', 'abc'));
  assert.throws(() => compareVersions('abc', '1.2.3'));
});

// =====================================================================
// Release + dopasowanie assetow (lib/updateGithub.js)
// =====================================================================

test('assetFileName generuje dokladny wzorzec nazwy instalatora', () => {
  assert.equal(assetFileName('1.2.0'), 'ScyzorykProjektowy-Setup-1.2.0.exe');
  assert.equal(assetFileName('v1.2.0'), 'ScyzorykProjektowy-Setup-1.2.0.exe');
});

test('findExactAsset: blad przy braku i przy wielu dopasowaniach', () => {
  const assets = [{ name: 'a.exe' }, { name: 'a.exe' }, { name: 'b.exe' }];
  assert.throws(() => findExactAsset(assets, 'c.exe'), /Nie znaleziono/);
  assert.throws(() => findExactAsset(assets, 'a.exe'), /Znaleziono 2/);
  assert.equal(findExactAsset(assets, 'b.exe').name, 'b.exe');
});

test('fetchLatestRelease: poprawnie odczytuje wersje i dopasowuje assety po nazwie', async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url === '/repos/o/r/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        tag_name: 'v3.4.5', name: 'Scyzoryk 3.4.5', body: 'Opis.', published_at: '2026-01-01T00:00:00Z',
        draft: false, prerelease: false,
        assets: [
          { name: 'ScyzorykProjektowy-Setup-3.4.5.exe', browser_download_url: 'http://x/exe', size: 10 },
          { name: 'ScyzorykProjektowy-Setup-3.4.5.exe.sha256', browser_download_url: 'http://x/sha', size: 5 }
        ]
      }));
    }
    res.writeHead(404); res.end();
  });
  try {
    const release = await fetchLatestRelease('o/r', { apiBaseUrl: `http://127.0.0.1:${mock.port}` });
    assert.equal(release.version, '3.4.5');
    assert.equal(release.installerAsset.name, 'ScyzorykProjektowy-Setup-3.4.5.exe');
    assert.equal(release.shaAsset.name, 'ScyzorykProjektowy-Setup-3.4.5.exe.sha256');
    assert.equal(typeof release.notes, 'string');
  } finally {
    await mock.close();
  }
});

test('fetchLatestRelease: blad gdy brakuje instalatora dla wersji z taga', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] }));
  });
  try {
    await assert.rejects(fetchLatestRelease('o/r', { apiBaseUrl: `http://127.0.0.1:${mock.port}` }), /Nie znaleziono/);
  } finally {
    await mock.close();
  }
});

test('fetchLatestRelease: blad gdy jest kilka assetow o tej samej nazwie (niejednoznaczne wydanie)', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: 'v1.0.0', draft: false, prerelease: false,
      assets: [
        { name: 'ScyzorykProjektowy-Setup-1.0.0.exe', browser_download_url: 'http://x/1' },
        { name: 'ScyzorykProjektowy-Setup-1.0.0.exe', browser_download_url: 'http://x/2' },
        { name: 'ScyzorykProjektowy-Setup-1.0.0.exe.sha256', browser_download_url: 'http://x/3' }
      ]
    }));
  });
  try {
    await assert.rejects(fetchLatestRelease('o/r', { apiBaseUrl: `http://127.0.0.1:${mock.port}` }), /Znaleziono 2/);
  } finally {
    await mock.close();
  }
});

test('fetchLatestRelease: ignoruje draft i prerelease (traktuje jak brak wydania)', async () => {
  for (const flags of [{ draft: true, prerelease: false }, { draft: false, prerelease: true }]) {
    const mock = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v1.0.0', assets: [], ...flags }));
    });
    try {
      const release = await fetchLatestRelease('o/r', { apiBaseUrl: `http://127.0.0.1:${mock.port}` });
      assert.equal(release, null);
    } finally {
      await mock.close();
    }
  }
});

test('fetchLatestRelease: opis wydania jest zwracany jako zwykly tekst (string), nigdy jako sparsowany HTML/obiekt', async () => {
  const dangerous = '<img src=x onerror="alert(1)"> & "cytat"';
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: 'v1.0.1', draft: false, prerelease: false, body: dangerous,
      assets: [
        { name: 'ScyzorykProjektowy-Setup-1.0.1.exe', browser_download_url: 'http://x/1' },
        { name: 'ScyzorykProjektowy-Setup-1.0.1.exe.sha256', browser_download_url: 'http://x/2' }
      ]
    }));
  });
  try {
    const release = await fetchLatestRelease('o/r', { apiBaseUrl: `http://127.0.0.1:${mock.port}` });
    assert.equal(release.notes, dangerous); // string 1:1, zero interpretacji/HTML-parsowania
    assert.equal(typeof release.notes, 'string');
  } finally {
    await mock.close();
  }
});

// =====================================================================
// Pobieranie i SHA-256 (lib/updateDownload.js)
// =====================================================================

test('parseSha256File: poprawny format, niezgodna nazwa pliku i zly format sa odpowiednio obslugiwane', () => {
  const hex = 'a'.repeat(64);
  assert.equal(parseSha256File(`${hex}  plik.exe\n`, 'plik.exe'), hex);
  assert.equal(parseSha256File(`${hex} *plik.exe`, 'plik.exe'), hex);
  assert.throws(() => parseSha256File(`${hex}  inny.exe`, 'plik.exe'), /inny plik/);
  assert.throws(() => parseSha256File('nie-jest-suma', 'plik.exe'), /nieprawidlowy format/i);
});

test('downloadToPartialFile: poprawne pobranie, poprawna suma SHA-256, atomowa zmiana nazwy przez wywolujacego', async () => {
  const bytes = crypto.randomBytes(50000);
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Length': String(bytes.length) });
    res.end(bytes);
  });
  const dir = tempDir('scz-dl-');
  try {
    const dest = path.join(dir, 'plik.exe');
    const progressCalls = [];
    const result = await downloadToPartialFile(`http://127.0.0.1:${mock.port}/x`, dest, {
      onProgress: p => progressCalls.push(p)
    });
    assert.equal(result.sha256, sha256Hex(bytes));
    assert.equal(result.bytes, bytes.length);
    assert.equal(fs.existsSync(result.partialPath), true);
    assert.equal(fs.existsSync(dest), false); // NIE zmieniona nazwa - to robi wywolujacy
    assert.ok(progressCalls.length > 0);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToPartialFile: obsluguje przekierowanie HTTP', async () => {
  const bytes = Buffer.from('zawartosc-po-przekierowaniu');
  const mock = await startMockServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/final' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Length': String(bytes.length) });
    res.end(bytes);
  });
  const dir = tempDir('scz-dl-redirect-');
  try {
    const dest = path.join(dir, 'plik.exe');
    const result = await downloadToPartialFile(`http://127.0.0.1:${mock.port}/redirect`, dest, {});
    assert.equal(result.sha256, sha256Hex(bytes));
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToPartialFile: przekroczenie limitu przekierowan konczy sie bledem', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(302, { Location: req.url }); // przekierowuje do siebie w kolko
    res.end();
  });
  const dir = tempDir('scz-dl-loop-');
  try {
    const dest = path.join(dir, 'plik.exe');
    await assert.rejects(
      downloadToPartialFile(`http://127.0.0.1:${mock.port}/x`, dest, { maxRedirects: 2 }),
      /przekierowan/i
    );
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToPartialFile: przerwane pobieranie usuwa ".partial" i rzuca blad', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '100000' });
    res.write(Buffer.alloc(1000));
    setTimeout(() => res.destroy(), 30); // przerywamy w polowie
  });
  const dir = tempDir('scz-dl-interrupted-');
  try {
    const dest = path.join(dir, 'plik.exe');
    await assert.rejects(downloadToPartialFile(`http://127.0.0.1:${mock.port}/x`, dest, {}));
    assert.equal(fs.existsSync(`${dest}.partial`), false);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToPartialFile: deklarowany rozmiar wiekszy niz limit jest odrzucany bez pobierania', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '999999999' });
    res.end(Buffer.alloc(10));
  });
  const dir = tempDir('scz-dl-toobig-');
  try {
    const dest = path.join(dir, 'plik.exe');
    await assert.rejects(downloadToPartialFile(`http://127.0.0.1:${mock.port}/x`, dest, { maxBytes: 1000 }), /limit/i);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadText: pobiera maly plik tekstowy (suma .sha256) w calosci', async () => {
  const mock = await startMockServer((req, res) => { res.writeHead(200); res.end('abc  plik.exe\n'); });
  try {
    const text = await downloadText(`http://127.0.0.1:${mock.port}/x`);
    assert.equal(text, 'abc  plik.exe\n');
  } finally {
    await mock.close();
  }
});

test('Blokada polaczen innych niz HTTPS (poza wyjatkiem loopback do testow)', async () => {
  await assert.rejects(downloadText('http://example.com/plik.sha256'), /HTTPS/);
});

// =====================================================================
// Maszyna stanow / orkiestracja (lib/updateService.js) - z prawdziwym
// mockiem HTTP dla check, ale z WSTRZYKNIETYM spawnUpdaterProcess, zeby
// zaden test nigdy nie odpalal prawdziwego PowerShella/instalatora.
// =====================================================================

function buildFakeRelease(version, installerBytes) {
  const installerName = assetFileName(version);
  return {
    version, tagName: `v${version}`, name: `Scyzoryk ${version}`, notes: 'Opis testowy.', publishedAt: '2026-01-01T00:00:00Z',
    installerAsset: { name: installerName, url: `fake://installer/${version}`, sizeBytes: installerBytes.length },
    shaAsset: { name: `${installerName}.sha256`, url: `fake://sha/${version}` }
  };
}

function makeTestService(overrides = {}) {
  const updateRoot = tempDir('scz-svc-');
  const spawned = [];
  const deps = {
    fetchLatestRelease: overrides.fetchLatestRelease || (async () => null),
    downloadText: overrides.downloadText,
    downloadToPartialFile: overrides.downloadToPartialFile,
    parseSha256File: overrides.parseSha256File,
    spawnUpdaterProcess: (invocation) => { spawned.push(invocation); return null; },
    // Domyslnie "wystartowal natychmiast" - testy skupione na innych etapach
    // (pobieranie/weryfikacja) nie powinny czekac na realny fs-check/delay.
    // Testy tej konkretnej weryfikacji podstawiaja wlasna wersje nizej.
    confirmUpdaterStarted: overrides.confirmUpdaterStarted || (async () => true)
  };
  const service = createUpdateService({
    rootDir: overrides.rootDir || path.join(__dirname, '..'),
    getInstalledVersion: () => ({ version: overrides.currentVersion || '1.0.0' }),
    repo: 'o/r',
    updateRoot,
    enabled: overrides.enabled !== false,
    port: 3000,
    log: () => {},
    deps
  });
  return { service, updateRoot, spawned };
}

test('updateService: wykrywa dostepna nowsza wersje i nie pokazuje downgrade', async () => {
  const bytes = Buffer.from('x');
  const release = buildFakeRelease('2.0.0', bytes);
  const { service } = makeTestService({
    currentVersion: '1.0.0',
    fetchLatestRelease: async () => release
  });
  const result = await service.checkForUpdate();
  assert.equal(result.ok, true);
  const status = service.getStatusPayload();
  assert.equal(status.state, 'available');
  assert.equal(status.available, true);
  assert.equal(status.latestVersion, '2.0.0');
});

test('updateService: lokalna wersja rowna albo wyzsza od wydania - stan up-to-date, brak downgrade', async () => {
  const release = buildFakeRelease('1.0.0', Buffer.from('x'));
  const { service } = makeTestService({ currentVersion: '1.5.0', fetchLatestRelease: async () => release });
  await service.checkForUpdate();
  const status = service.getStatusPayload();
  assert.equal(status.state, 'up-to-date');
  assert.equal(status.available, false);
});

test('updateService: cale pobieranie -> weryfikacja SHA-256 -> "ready" -> "installing" (spawn TYLKO zarejestrowany, nie odpalony naprawde)', async () => {
  const bytes = crypto.randomBytes(20000);
  const hash = sha256Hex(bytes);
  const release = buildFakeRelease('9.9.9', bytes);
  const rootDir = tempDir('scz-svc-root-');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'Scyzoryk.exe'), '# test');

  const { service, updateRoot, spawned } = makeTestService({
    rootDir,
    currentVersion: '1.0.0',
    fetchLatestRelease: async () => release,
    downloadText: async () => `${hash}  ${release.installerAsset.name}`,
    parseSha256File: (text) => text.split(/\s+/)[0],
    downloadToPartialFile: async (url, dest, opts) => {
      opts.onProgress({ downloadedBytes: bytes.length, totalBytes: bytes.length });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.partial`, bytes);
      return { bytes: bytes.length, sha256: hash, partialPath: `${dest}.partial` };
    }
  });

  await service.checkForUpdate();
  const install = service.startInstall();
  assert.equal(install.started, true);
  assert.equal(install.statusCode, 202);
  await install.flowPromise;

  const status = service.getStatusPayload();
  assert.equal(status.state, 'installing');
  assert.equal(status.percent, 100);
  assert.equal(spawned.length, 1);
  // Kopia juz zainstalowanego Scyzoryk.exe (nie PowerShell) - patrz
  // buildUpdaterInvocation() w lib/updateService.js.
  assert.match(spawned[0].exe, /Scyzoryk\.exe$/i);
  assert.equal(spawned[0].args[0], '--apply-update');
  assert.ok(spawned[0].args.includes('9.9.9'));

  const installedExe = path.join(updateRoot, '9.9.9', release.installerAsset.name);
  assert.equal(fs.existsSync(installedExe), true);
  assert.equal(fs.readFileSync(installedExe).equals(bytes), true);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('updateService: niezgodna suma SHA-256 - instalator jest odrzucony, nic nie jest odpalane', async () => {
  const bytes = crypto.randomBytes(5000);
  const release = buildFakeRelease('3.0.0', bytes);
  const rootDir = tempDir('scz-svc-root2-');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'Scyzoryk.exe'), '# test');

  const { service, spawned } = makeTestService({
    rootDir,
    currentVersion: '1.0.0',
    fetchLatestRelease: async () => release,
    downloadText: async () => `${'0'.repeat(64)}  ${release.installerAsset.name}`, // suma zla z rozmyslu
    parseSha256File: (text) => text.split(/\s+/)[0],
    downloadToPartialFile: async (url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.partial`, bytes);
      return { bytes: bytes.length, sha256: sha256Hex(bytes), partialPath: `${dest}.partial` };
    }
  });

  await service.checkForUpdate();
  const install = service.startInstall();
  await install.flowPromise;

  const status = service.getStatusPayload();
  assert.equal(status.state, 'error');
  assert.match(status.error, /suma kontrolna/i);
  assert.equal(spawned.length, 0);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('updateService: dwa rownoczesne kliknieca "zainstaluj" nie odpalaja dwoch pobierania', async () => {
  const release = buildFakeRelease('4.0.0', Buffer.from('x'.repeat(1000)));
  let downloadStarts = 0;
  let resolveDownload;
  const { service } = makeTestService({
    currentVersion: '1.0.0',
    fetchLatestRelease: async () => release,
    downloadText: async () => 'a'.repeat(64) + '  ' + release.installerAsset.name,
    parseSha256File: (text) => text.split(/\s+/)[0],
    downloadToPartialFile: async () => {
      downloadStarts += 1;
      await new Promise(r => { resolveDownload = r; });
      return { bytes: 1, sha256: 'a'.repeat(64), partialPath: '/nope' };
    }
  });
  await service.checkForUpdate();
  const first = service.startInstall();
  const second = service.startInstall();
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.statusCode, 409);
  // Pobieranie (mock) rusza asynchronicznie w tle (bez await w startInstall) -
  // czekamy, az faktycznie wejdzie w downloadToPartialFile, zanim je "odblokujemy".
  while (downloadStarts === 0) await new Promise(r => setImmediate(r));
  resolveDownload();
  await first.flowPromise.catch(() => {});
  assert.equal(downloadStarts, 1);
});

test('updateService: sprawdzenie aktualizacji nigdy nie blokuje (zwraca Promise, nie throw synchronicznie)', () => {
  const { service } = makeTestService({ fetchLatestRelease: async () => { throw new Error('brak internetu'); } });
  assert.doesNotThrow(() => { const p = service.checkForUpdate(); p.catch(() => {}); });
});

test('updateService: instalacja jest odrzucona, gdy nie ma wykrytej dostepnej wersji', () => {
  const { service } = makeTestService({});
  const result = service.startInstall();
  assert.equal(result.started, false);
  assert.equal(result.statusCode, 409);
});

test('updateService: aktualizacja jest zablokowana, gdy trwa drukowanie (audyt v1.0.4, P0-8)', async () => {
  const previousDataRoot = process.env.SCYZORYK_DATA_ROOT;
  const dataRoot = tempDir('scz-print-lock-');
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  try {
    const lockDir = path.join(dataRoot, 'runtime', 'printing');
    fs.mkdirSync(lockDir, { recursive: true });
    // process.pid tego samego (testowego) procesu - z definicji "zywy" PID,
    // wiec isPrintingActive() musi go rozpoznac jako aktywna blokade.
    fs.writeFileSync(path.join(lockDir, 'active.lock'), JSON.stringify({ pid: process.pid, app: 'drukarka' }));

    const bytes = Buffer.from('x');
    const release = buildFakeRelease('9.9.9', bytes);
    const { service } = makeTestService({ currentVersion: '1.0.0', fetchLatestRelease: async () => release });
    await service.checkForUpdate();

    const result = service.startInstall();
    assert.equal(result.started, false);
    assert.equal(result.statusCode, 409);
    assert.match(result.message, /drukowanie/);
  } finally {
    if (previousDataRoot === undefined) delete process.env.SCYZORYK_DATA_ROOT;
    else process.env.SCYZORYK_DATA_ROOT = previousDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('updateService: brak blokady druku (albo osierocony lock z martwym PID) nie przeszkadza w instalacji', async () => {
  const previousDataRoot = process.env.SCYZORYK_DATA_ROOT;
  const dataRoot = tempDir('scz-print-lock-dead-');
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  try {
    const lockDir = path.join(dataRoot, 'runtime', 'printing');
    fs.mkdirSync(lockDir, { recursive: true });
    // PID prawie na pewno juz nieuzywany - symuluje osierocona blokade po
    // awarii procesu, ktora nie powinna blokowac niczego.
    fs.writeFileSync(path.join(lockDir, 'active.lock'), JSON.stringify({ pid: 2147483647, app: 'drukarka' }));

    const bytes = crypto.randomBytes(2000);
    const hash = sha256Hex(bytes);
    const release = buildFakeRelease('9.9.9', bytes);
    const rootDir = tempDir('scz-print-lock-root-');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'Scyzoryk.exe'), '# test');

    const { service } = makeTestService({
      rootDir,
      currentVersion: '1.0.0',
      fetchLatestRelease: async () => release,
      downloadText: async () => `${hash}  ${release.installerAsset.name}`,
      parseSha256File: (text) => text.split(/\s+/)[0],
      downloadToPartialFile: async (url, dest, opts) => {
        opts.onProgress({ downloadedBytes: bytes.length, totalBytes: bytes.length });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(`${dest}.partial`, bytes);
        return { bytes: bytes.length, sha256: hash, partialPath: `${dest}.partial` };
      }
    });
    await service.checkForUpdate();
    const install = service.startInstall();
    assert.equal(install.started, true);
    await install.flowPromise;
    assert.equal(service.getStatusPayload().state, 'installing');
    fs.rmSync(rootDir, { recursive: true, force: true });
  } finally {
    if (previousDataRoot === undefined) delete process.env.SCYZORYK_DATA_ROOT;
    else process.env.SCYZORYK_DATA_ROOT = previousDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('updateService: wylaczony (enabled: false) nigdy nie sprawdza i nigdy nie instaluje', async () => {
  const { service } = makeTestService({ enabled: false, fetchLatestRelease: async () => { throw new Error('nie powinno byc wywolane'); } });
  const checkResult = await service.checkForUpdate();
  assert.equal(checkResult.ok, false);
  assert.equal(service.getStatusPayload().state, 'disabled');
  const installResult = service.startInstall();
  assert.equal(installResult.started, false);
});

// Real bug znaleziony na produkcyjnej maszynie (2026-08-03): uzytkownik
// kliknal "zainstaluj", pobieranie+weryfikacja przeszly, ale sam proces
// aktualizatora nigdy nie ruszyl (cichy blad odpalenia). Po restarcie
// (recznym, przez uzytkownika) panel po prostu wracal do czystego stanu
// "dostepna aktualizacja X" bez ZADNEJ wzmianki, ze cos juz probowano -
// wygladalo jak zero postepu. Te dwa testy pilnuja odczytu stanu z dysku
// przy starcie createUpdateService (patrz sekcja "Cache ostatniego
// poprawnego sprawdzenia" w lib/updateService.js).
test('updateService: restart po nieudanej/przerwanej instalacji pokazuje blad zamiast cichego powrotu do "dostepna"', () => {
  const updateRoot = tempDir('scz-svc-restart-fail-');
  fs.writeFileSync(path.join(updateRoot, 'state.json'), JSON.stringify({
    enabled: true,
    state: 'installing',
    available: true,
    latestVersion: '2.0.0',
    releaseName: 'Scyzoryk 2.0.0',
    releaseNotes: 'Opis.',
    publishedAt: '2026-01-01T00:00:00Z',
    lastCheckedAt: '2026-01-01T00:00:00Z'
  }));
  const service = createUpdateService({
    rootDir: path.join(__dirname, '..'),
    getInstalledVersion: () => ({ version: '1.0.0' }), // nadal stara - instalacja sie NIE udala
    repo: 'o/r',
    updateRoot,
    port: 3000,
    log: () => {},
    deps: { fetchLatestRelease: async () => null, spawnUpdaterProcess: () => null }
  });
  const status = service.getStatusPayload();
  assert.equal(status.state, 'error');
  assert.match(status.error, /2\.0\.0/);
  assert.match(status.error, /1\.0\.0/);
  fs.rmSync(updateRoot, { recursive: true, force: true });
});

test('updateService: restart PO udanej instalacji rozpoznaje sukces, mimo ze ostatni zapisany stan to "installing"', () => {
  const updateRoot = tempDir('scz-svc-restart-ok-');
  fs.writeFileSync(path.join(updateRoot, 'state.json'), JSON.stringify({
    enabled: true,
    state: 'installing',
    available: true,
    latestVersion: '2.0.0',
    lastCheckedAt: '2026-01-01T00:00:00Z'
  }));
  const service = createUpdateService({
    rootDir: path.join(__dirname, '..'),
    getInstalledVersion: () => ({ version: '2.0.0' }), // dogonila latestVersion - sukces
    repo: 'o/r',
    updateRoot,
    port: 3000,
    log: () => {},
    deps: { fetchLatestRelease: async () => null, spawnUpdaterProcess: () => null }
  });
  const status = service.getStatusPayload();
  assert.equal(status.state, 'idle');
  assert.equal(status.available, false);
  assert.equal(status.error, null);
  fs.rmSync(updateRoot, { recursive: true, force: true });
});

test('updateService: restart, gdy ostatni stan to zwykle "available" (nigdy nie kliknieto instaluj) - bez fałszywego bledu', () => {
  const updateRoot = tempDir('scz-svc-restart-idle-');
  fs.writeFileSync(path.join(updateRoot, 'state.json'), JSON.stringify({
    enabled: true,
    state: 'available',
    available: true,
    latestVersion: '2.0.0',
    lastCheckedAt: '2026-01-01T00:00:00Z'
  }));
  const service = createUpdateService({
    rootDir: path.join(__dirname, '..'),
    getInstalledVersion: () => ({ version: '1.0.0' }),
    repo: 'o/r',
    updateRoot,
    port: 3000,
    log: () => {},
    deps: { fetchLatestRelease: async () => null, spawnUpdaterProcess: () => null }
  });
  const status = service.getStatusPayload();
  assert.equal(status.state, 'available');
  assert.equal(status.error, null);
  fs.rmSync(updateRoot, { recursive: true, force: true });
});

// Audyt v1.0.4/P0-8, kontynuacja (zlapane REALNIE na produkcji 2026-08-04,
// trzeci raz): spawn() z {detached:true} na Windows zawsze zglasza kod
// wyjscia 0 w zdarzeniu 'exit', niezaleznie od realnego wyniku procesu -
// zweryfikowane bezposrednio testem na tej samej maszynie (skrypt kończący
// sie kodem 7 byl widziany jako kod 0). Nasluch na 'exit' z ta logika NIGDY
// nie mogl wiec wykryc realnej awarii na Windows - zastapiony sprawdzeniem
// nowego pliku logu na dysku (deps.confirmUpdaterStarted).
function makeInstallableService({ confirmUpdaterStarted, spawnUpdaterProcess }) {
  const bytes = crypto.randomBytes(2000);
  const hash = sha256Hex(bytes);
  const release = buildFakeRelease('5.0.0', bytes);
  const rootDir = tempDir('scz-svc-root-confirm-');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'Scyzoryk.exe'), '# test');
  const updateRoot = tempDir('scz-svc-root-confirm2-');

  const service = createUpdateService({
    rootDir,
    getInstalledVersion: () => ({ version: '1.0.0' }),
    repo: 'o/r',
    updateRoot,
    log: () => {},
    deps: {
      fetchLatestRelease: async () => release,
      downloadText: async () => `${hash}  ${release.installerAsset.name}`,
      parseSha256File: (text) => text.split(/\s+/)[0],
      downloadToPartialFile: async (url, dest, opts) => {
        opts.onProgress({ downloadedBytes: bytes.length, totalBytes: bytes.length });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(`${dest}.partial`, bytes);
        return { bytes: bytes.length, sha256: hash, partialPath: `${dest}.partial` };
      },
      spawnUpdaterProcess: spawnUpdaterProcess || (() => null),
      confirmUpdaterStarted
    }
  });
  return { service, rootDir, updateRoot };
}

test('updateService: proces aktualizatora "startuje" (spawn bez bledu), ale nigdy nie tworzy logu - wykryte jako blad', async () => {
  // Kod wyjscia 0 z detached procesu (patrz komentarz wyzej) wyglada
  // identycznie na "sukces" i na "padl natychmiast" - dlatego confirmUpdaterStarted
  // (a nie 'exit') jest tu jedynym wiarygodnym sygnalem.
  const { service, rootDir, updateRoot } = makeInstallableService({
    confirmUpdaterStarted: async () => false // brak nowego logu = nie ruszylo
  });

  await service.checkForUpdate();
  const install = service.startInstall();
  await install.flowPromise;

  const status = service.getStatusPayload();
  assert.equal(status.state, 'error');
  assert.match(status.error, /nie uruchomil sie/);
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(updateRoot, { recursive: true, force: true });
});

test('updateService: potwierdzony start aktualizatora (log sie pojawil) NIE generuje falszywego bledu', async () => {
  const { service, rootDir, updateRoot } = makeInstallableService({
    confirmUpdaterStarted: async () => true // log sie pojawil - naprawde ruszylo
  });

  await service.checkForUpdate();
  const install = service.startInstall();
  await install.flowPromise;

  const status = service.getStatusPayload();
  assert.equal(status.state, 'installing');
  assert.equal(status.error, null);
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(updateRoot, { recursive: true, force: true });
});

test('updateService: realConfirmUpdaterStarted (implementacja produkcyjna) rozpoznaje nowy log, a stary/brakujacy log odrzuca', async () => {
  const { realConfirmUpdaterStarted } = require('../lib/updateService');
  const dir = tempDir('scz-confirm-real-');
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Brak jakiegokolwiek logu.
  assert.equal(await realConfirmUpdaterStarted({ updateRoot: dir, sinceMs: Date.now(), waitMs: 10 }), false);

  // Stary log (starszy niz "sinceMs") - to np. log z POPRZEDNIEJ, juz
  // zakonczonej aktualizacji, nie dowod ze TA aktualizacja ruszyla.
  const staleLogPath = path.join(logsDir, 'update-stale.log');
  fs.writeFileSync(staleLogPath, 'stary log');
  const sinceMs = Date.now() + 200;
  assert.equal(await realConfirmUpdaterStarted({ updateRoot: dir, sinceMs, waitMs: 10 }), false);

  // Nowy log (mtime >= sinceMs) - to jest realny dowod, ze proces
  // aktualizatora zaczal dzialac.
  await new Promise(r => setTimeout(r, 250));
  fs.writeFileSync(path.join(logsDir, 'update-fresh.log'), 'nowy log');
  assert.equal(await realConfirmUpdaterStarted({ updateRoot: dir, sinceMs, waitMs: 10 }), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupUpdatesDir: zachowuje najwyzej 2 najnowsze wersje i usuwa pliki .partial', () => {
  const dir = tempDir('scz-cleanup-');
  try {
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '2.0.0']) {
      fs.mkdirSync(path.join(dir, v), { recursive: true });
      fs.writeFileSync(path.join(dir, v, 'plik.exe'), 'x');
    }
    fs.writeFileSync(path.join(dir, '2.0.0', 'plik.exe.partial'), 'x');
    cleanupUpdatesDir(dir);
    const remaining = fs.readdirSync(dir).sort();
    assert.deepEqual(remaining, ['1.2.0', '2.0.0']);
    assert.equal(fs.existsSync(path.join(dir, '2.0.0', 'plik.exe.partial')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// Bezpieczenstwo tras panelu (server.js) - prawdziwy proces, prawdziwe
// zadania HTTP, bez uruchamiania osmiu aplikacji-dzieci.
// =====================================================================

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: options.path, method: options.method || 'GET', headers: options.headers || {}, timeout: 5000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForPanel(port, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Panel zakonczyl sie kodem ${child.exitCode}.`);
    try {
      const res = await request(port, { path: '/api/health' });
      if (res.statusCode === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Panel nie uruchomil sie w wymaganym czasie.');
}

test('trasy /api/update/* - bezpieczenstwo i kontrakt', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-update-routes-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const panelPort = probe.address().port;
  await new Promise(r => probe.close(r));

  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(panelPort),
      LOCALAPPDATA: tempRoot,
      SCYZORYK_SKIP_AUTO_INSTALL: '1',
      SCYZORYK_SKIP_CHILD_START: '1',
      SCYZORYK_SKIP_DATA_MIGRATION: '1',
      SCYZORYK_UPDATE_ENABLED: '0' // testy tras nie potrzebuja prawdziwego sprawdzania
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await waitForPanel(panelPort, child);

  // GET nigdy nie uruchamia instalacji - tylko odczyt stanu, bez sieci.
  const statusRes = await request(panelPort, { path: '/api/update/status' });
  assert.equal(statusRes.statusCode, 200);
  const status = JSON.parse(statusRes.body);
  assert.equal(status.enabled, false);
  assert.equal(status.state, 'disabled');
  // Zaden wrazliwy szczegol (sciezki, URL-e) nie trafia do frontendu.
  assert.equal(JSON.stringify(status).includes('C:\\'), false);
  assert.equal(JSON.stringify(status).includes('github.com'), false);

  // GET na endpoint instalujacy jest odrzucany (405), nie uruchamia niczego.
  const getInstall = await request(panelPort, { path: '/api/update/install' });
  assert.equal(getInstall.statusCode, 405);

  // POST bez wymaganego naglowka jest odrzucany.
  const noHeader = await request(panelPort, { path: '/api/update/install', method: 'POST' });
  assert.equal(noHeader.statusCode, 403);

  // POST z obcym Originem jest odrzucany, mimo poprawnego naglowka.
  const foreignOrigin = await request(panelPort, {
    path: '/api/update/install', method: 'POST',
    headers: { 'X-Scyzoryk-Request': '1', Origin: 'https://zlosliwa-strona.example' }
  });
  assert.equal(foreignOrigin.statusCode, 403);

  // Poprawny lokalny Origin + naglowek dziala (choc aktualizacje sa
  // wylaczone w tym tescie, wiec konczy sie 409 "nie ma czego instalowac",
  // NIE 403/500 - to potwierdza, ze przeszlo przez ochrone do logiki biznesowej).
  const localOrigin = await request(panelPort, {
    path: '/api/update/install', method: 'POST',
    headers: { 'X-Scyzoryk-Request': '1', Origin: `http://127.0.0.1:${panelPort}` }
  });
  assert.equal(localOrigin.statusCode, 409);

  // Przegladarka nie moze przekazac wlasnego URL-a/wersji/komendy - cialo
  // zadania jest calkowicie ignorowane, wynik jest identyczny z/bez niego.
  const withMaliciousBody = await request(panelPort, {
    path: '/api/update/install', method: 'POST',
    headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://zla.example/evil.exe', version: '0.0.0', command: 'calc.exe' })
  });
  assert.equal(withMaliciousBody.statusCode, 409); // ta sama odpowiedz co bez ciala - tresc byla ignorowana

  // /api/health zwraca wersje dzialajacej aplikacji.
  const health = JSON.parse((await request(panelPort, { path: '/api/health' })).body);
  assert.equal(typeof health.version, 'string');
  assert.ok(isValidVersion(health.version));
});

// =====================================================================
// Migracja konfiguracji OCR (lib/ocrConfigMigration.js)
// =====================================================================

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

test('OCR: migruje kompletna wbudowana konfiguracje do profilu uzytkownika', () => {
  // Uzywamy sciezki z polskimi znakami i spacja w LOCALAPPDATA, zeby
  // potwierdzic ze migracja dziala z takimi sciezkami (wymaganie testowe).
  const localAppData = tempDir('sciezka z polskimi znakami zażółć gęślą jaźń ');
  const appRoot = tempDir('scz-ocr-app-');
  withEnvironment({ LOCALAPPDATA: localAppData }, () => {
    const configDir = path.join(appRoot, 'apps', 'ocr-audytow', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'service-account.json'), JSON.stringify({ type: 'service_account', client_email: 'a@b.iam', private_key: 'TAJNY-KLUCZ-NIE-LOGOWAC' }), 'utf8');
    writeJson(path.join(configDir, 'document-ai.json'), { projectId: 'proj', location: 'eu', processorId: 'proc123', keyFile: 'service-account.json' });

    const logs = [];
    const result = migrateOcrConfigIfNeeded(appRoot, { log: (level, event, data) => logs.push({ level, event, data }) });
    assert.equal(result.migrated, true);

    const userPath = userConfigPath();
    assert.equal(fs.existsSync(userPath), true);
    const userConfig = JSON.parse(fs.readFileSync(userPath, 'utf8'));
    assert.equal(userConfig.projectId, 'proj');
    assert.equal(userConfig.processorId, 'proc123');
    assert.equal(userConfig.keyFile, 'service-account.json');
    assert.equal(isCompleteConfig(userConfig, path.dirname(userPath)), true);

    // Wbudowana kopia zostala usunieta PO potwierdzeniu skopiowania.
    assert.equal(fs.existsSync(configDir), false);

    // Nigdy nie logujemy TRESCI klucza.
    const serialized = JSON.stringify(logs);
    assert.equal(serialized.includes('TAJNY-KLUCZ-NIE-LOGOWAC'), false);
  });
  fs.rmSync(localAppData, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
});

test('OCR: nie nadpisuje juz istniejacej, kompletnej konfiguracji uzytkownika', () => {
  const localAppData = tempDir('scz-ocr-user-');
  const appRoot = tempDir('scz-ocr-app2-');
  withEnvironment({ LOCALAPPDATA: localAppData }, () => {
    const userDir = path.join(localAppData, 'Scyzoryk');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'service-account.json'), JSON.stringify({ type: 'service_account', client_email: 'x@y.iam', private_key: 'RECZNIE-SKONFIGUROWANY' }), 'utf8');
    writeJson(path.join(userDir, 'ocr-document-ai.json'), { projectId: 'reczny-projekt', location: 'eu', processorId: 'recznyproc', keyFile: 'service-account.json' });

    const configDir = path.join(appRoot, 'apps', 'ocr-audytow', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'service-account.json'), JSON.stringify({ type: 'service_account', client_email: 'a@b.iam', private_key: 'WBUDOWANY' }), 'utf8');
    writeJson(path.join(configDir, 'document-ai.json'), { projectId: 'wbudowany-projekt', location: 'eu', processorId: 'wbudowanyproc', keyFile: 'service-account.json' });

    const result = migrateOcrConfigIfNeeded(appRoot, {});
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'user-config-already-complete');

    const userConfig = JSON.parse(fs.readFileSync(path.join(userDir, 'ocr-document-ai.json'), 'utf8'));
    assert.equal(userConfig.projectId, 'reczny-projekt'); // NIE nadpisane
  });
  fs.rmSync(localAppData, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
});

test('OCR: migracja jest idempotentna (drugie wywolanie nie robi nic i nie rzuca)', () => {
  const localAppData = tempDir('scz-ocr-idem-');
  const appRoot = tempDir('scz-ocr-app3-');
  withEnvironment({ LOCALAPPDATA: localAppData }, () => {
    const configDir = path.join(appRoot, 'apps', 'ocr-audytow', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'service-account.json'), JSON.stringify({ type: 'service_account', client_email: 'a@b.iam', private_key: 'K' }), 'utf8');
    writeJson(path.join(configDir, 'document-ai.json'), { projectId: 'p', location: 'eu', processorId: 'pr', keyFile: 'service-account.json' });

    const first = migrateOcrConfigIfNeeded(appRoot, {});
    assert.equal(first.migrated, true);
    const second = migrateOcrConfigIfNeeded(appRoot, {});
    assert.equal(second.migrated, false);
    assert.equal(second.reason, 'user-config-already-complete');
  });
  fs.rmSync(localAppData, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
});

test('OCR: niekompletna wbudowana konfiguracja nie jest migrowana', () => {
  const localAppData = tempDir('scz-ocr-incomplete-');
  const appRoot = tempDir('scz-ocr-app4-');
  withEnvironment({ LOCALAPPDATA: localAppData }, () => {
    const configDir = path.join(appRoot, 'apps', 'ocr-audytow', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    // Brak service-account.json - keyFile wskazuje na nieistniejacy plik.
    writeJson(path.join(configDir, 'document-ai.json'), { projectId: 'p', location: 'eu', processorId: 'pr', keyFile: 'service-account.json' });

    const result = migrateOcrConfigIfNeeded(appRoot, {});
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'bundled-config-incomplete');
    assert.equal(fs.existsSync(userConfigPath()), false);
  });
  fs.rmSync(localAppData, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
});

test('OCR: brak wbudowanej konfiguracji w ogole (zwykla instalacja) - brak migracji, brak bledu', () => {
  const localAppData = tempDir('scz-ocr-none-');
  const appRoot = tempDir('scz-ocr-app5-');
  withEnvironment({ LOCALAPPDATA: localAppData }, () => {
    const result = migrateOcrConfigIfNeeded(appRoot, {});
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'no-bundled-config');
  });
  fs.rmSync(localAppData, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
});

// =====================================================================
// Statyczne sprawdzenie bezpieczenstwa workflow (zero sekretu OCR w
// publicznym workflow, blokada widocznosci repo w wewnetrznym workflow)
// =====================================================================

test('workflow publicznego wydania nigdy nie uzywa sekretu OCR', async () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release-public-installer.yml'), 'utf8');
  // Sprawdzamy faktyczne UZYCIE sekretu (odwolanie do GitHub Actions Secret
  // albo przekazanie go jako env: kroku), nie samo wystapienie nazwy w
  // komentarzu wyjasniajacym - stad wzorce ponizej, a nie goly string.
  assert.doesNotMatch(workflow, /secrets\.OCR_DOCAI_CREDENTIALS_B64/);
  assert.doesNotMatch(workflow, /OCR_DOCAI_CREDENTIALS_B64:\s*\$\{\{/);
  // service-account.json/document-ai.json moga byc wspominane WYLACZNIE w
  // kontekscie sprawdzania ich NIEOBECNOSCI (krok weryfikujacy), nie
  // tworzenia/kopiowania.
  assert.doesNotMatch(workflow, /Add-OcrConfigurationToStaging/);
  assert.match(workflow, /forbidden/i);
  assert.match(workflow, /tag Git.*nie zgadza sie z package\.json/i);
  assert.match(workflow, /permissions:\s*\n\s*contents: write/);
});

test('wewnetrzny workflow z OCR blokuje sie na publicznym repozytorium PRZED uzyciem sekretu', async () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'build-ready-installer.yml'), 'utf8');
  const guardIndex = workflow.indexOf('Sprawdz, ze repozytorium jest prywatne');
  const secretIndex = workflow.indexOf('Sprawdz sekret OCR');
  assert.ok(guardIndex >= 0, 'Brak kroku sprawdzajacego widocznosc repozytorium.');
  assert.ok(guardIndex < secretIndex, 'Sprawdzenie widocznosci repo musi isc PRZED jakimkolwiek uzyciem sekretu.');
  assert.match(workflow, /\.private/);
  assert.match(workflow, /throw ".*nie jest prywatne/i);
});

test('update-ui.js: pasek nie reloaduje strony, jesli po restarcie dziala inna wersja niz oczekiwana (audyt v1.0.4, P0-8)', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'update-ui.js'), 'utf8');
  // Wczesniej jedynym kryterium sukcesu bylo "res.ok" z /api/health - nie
  // sprawdzalo, KTORA wersja faktycznie odpowiedziala. Restart mogl przywrocic
  // stara wersje (np. instalator po cichu pominal zablokowany plik), a pasek
  // i tak pokazywalby 100% i przeladowywal strone.
  assert.match(source, /async function waitForRestart\(expectedVersion\)/);
  assert.match(source, /runningVersion = \(await res\.json\(\)\)\.version/);
  assert.match(source, /expectedVersion && runningVersion && runningVersion !== expectedVersion/);
  const waitForRestartFn = source.match(/async function waitForRestart\(expectedVersion\) \{[\s\S]*?\n  \}/);
  assert.ok(waitForRestartFn, 'nie znaleziono waitForRestart');
  assert.match(waitForRestartFn[0], /resetInstallControls\(\);\s*\n\s*return;/);
  // expectedVersion musi byc przekazywane od momentu kliknięcia "zainstaluj",
  // nie zgadywane pozniej.
  assert.match(source, /const expectedVersion = lastStatus \? lastStatus\.latestVersion : null;/);
  assert.match(source, /trackProgressUntilServerStops\(expectedVersion\)/);
});
