const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { computeRuntimeFingerprint, listAppDirs } = require('../scripts/generate-runtime-fingerprint');
const { assetFileName, updateAssetFileName } = require('../lib/updateGithub');
const { createUpdateService } = require('../lib/updateService');

function makeFakeRoot(apps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-fingerprint-'));
  const appsDir = path.join(root, 'apps');
  fs.mkdirSync(appsDir, { recursive: true });
  for (const [name, lockContent] of Object.entries(apps)) {
    const appDir = path.join(appsDir, name);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package-lock.json'), lockContent, 'utf8');
  }
  return root;
}

test('computeRuntimeFingerprint: deterministyczny dla tych samych wejsc', () => {
  const root = makeFakeRoot({ a: '{"lockfileVersion":3}', b: '{"lockfileVersion":3}' });
  try {
    const first = computeRuntimeFingerprint('20.18.1', root);
    const second = computeRuntimeFingerprint('20.18.1', root);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computeRuntimeFingerprint: zmiana wersji Node zmienia fingerprint', () => {
  const root = makeFakeRoot({ a: '{"lockfileVersion":3}' });
  try {
    const v1 = computeRuntimeFingerprint('20.18.1', root);
    const v2 = computeRuntimeFingerprint('20.18.2', root);
    assert.notEqual(v1, v2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computeRuntimeFingerprint: zmiana JEDNEGO package-lock.json zmienia caly fingerprint', () => {
  const root = makeFakeRoot({ a: '{"lockfileVersion":3}', b: '{"lockfileVersion":3}' });
  try {
    const before = computeRuntimeFingerprint('20.18.1', root);
    fs.writeFileSync(path.join(root, 'apps', 'b', 'package-lock.json'), '{"lockfileVersion":3,"extra":true}', 'utf8');
    const after = computeRuntimeFingerprint('20.18.1', root);
    assert.notEqual(before, after);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computeRuntimeFingerprint: kolejnosc odczytu katalogow apps/ nie wplywa na wynik (posortowane)', () => {
  const rootA = makeFakeRoot({ zzz: '{"v":1}', aaa: '{"v":2}' });
  const rootB = makeFakeRoot({ aaa: '{"v":2}', zzz: '{"v":1}' });
  try {
    assert.equal(computeRuntimeFingerprint('20.18.1', rootA), computeRuntimeFingerprint('20.18.1', rootB));
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('computeRuntimeFingerprint: brakujacy package-lock.json dla ktorejkolwiek apki jest twardym bledem, nie cichym pominieciem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-fingerprint-missing-'));
  const appsDir = path.join(root, 'apps');
  fs.mkdirSync(path.join(appsDir, 'bez-locka'), { recursive: true });
  try {
    assert.throws(() => computeRuntimeFingerprint('20.18.1', root), /package-lock\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listAppDirs: zwraca wylacznie katalogi, posortowane', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-fingerprint-listdirs-'));
  const appsDir = path.join(root, 'apps');
  fs.mkdirSync(path.join(appsDir, 'b-app'), { recursive: true });
  fs.mkdirSync(path.join(appsDir, 'a-app'), { recursive: true });
  fs.writeFileSync(path.join(appsDir, 'not-a-dir.txt'), 'x', 'utf8');
  try {
    assert.deepEqual(listAppDirs(root), ['a-app', 'b-app']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('realny projekt: fingerprint da sie policzyc dla wszystkich obecnych apps/*/package-lock.json', () => {
  // Nie mockowany test na prawdziwym repo - lapie sytuacje, w ktorej ktos
  // doda nowa apke bez package-lock.json i zepsuje build instalatora dopiero
  // w CI, zamiast lokalnie.
  const fingerprint = computeRuntimeFingerprint('20.18.1');
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
});

// =====================================================================
// lib/updateService.js: wybor miedzy pelnym instalatorem a maleńkim
// wariantem aktualizacyjnym (chooseInstallerAssets, wewnetrzna funkcja -
// testowana pośrednio przez publiczne API, tak jak reszta updateService w
// test/group10-updater.test.js).
// =====================================================================

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tempRootWithLauncher(fingerprint) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scz-variant-root-'));
  fs.writeFileSync(path.join(rootDir, 'Scyzoryk.exe'), '# test');
  if (fingerprint !== undefined) {
    fs.writeFileSync(path.join(rootDir, 'runtime-fingerprint.txt'), `${fingerprint}\n`, 'utf8');
  }
  return rootDir;
}

// Release z pelnym KOMPLETEM assetow (full + update + fingerprint) - to co
// scripts/build-installer.ps1 + workflow release'owe faktycznie publikuja
// od 2026-08-06.
function buildFullFakeRelease(version, { fullBytes, updateBytes, remoteFingerprint }) {
  const fullName = assetFileName(version);
  const updateName = updateAssetFileName(version);
  return {
    version, tagName: `v${version}`, name: `Scyzoryk ${version}`, notes: '', publishedAt: '2026-01-01T00:00:00Z',
    installerAsset: { name: fullName, url: `fake://full/${version}`, sizeBytes: fullBytes.length },
    shaAsset: { name: `${fullName}.sha256`, url: `fake://full-sha/${version}` },
    updateInstallerAsset: { name: updateName, url: `fake://update/${version}`, sizeBytes: updateBytes.length },
    updateShaAsset: { name: `${updateName}.sha256`, url: `fake://update-sha/${version}` },
    runtimeFingerprintAsset: { name: 'runtime-fingerprint.txt', url: `fake://fingerprint/${version}` }
  };
}

// downloadText/downloadToPartialFile/parseSha256File wspolne dla ponizszych
// testow - branchuja po URL-u, tak jak realny serwer obslugujacy rozne
// assety pod roznymi adresami.
function makeVariantDeps({ fullBytes, updateBytes, remoteFingerprint, fingerprintShouldFail = false }) {
  const fullHash = sha256Hex(fullBytes);
  const updateHash = sha256Hex(updateBytes);
  return {
    downloadText: async (url) => {
      if (url.startsWith('fake://fingerprint/')) {
        if (fingerprintShouldFail) throw new Error('siec padla podczas sprawdzania fingerprinta');
        return remoteFingerprint;
      }
      if (url.startsWith('fake://full-sha/')) return `${fullHash}  ignorowane-w-tescie`;
      if (url.startsWith('fake://update-sha/')) return `${updateHash}  ignorowane-w-tescie`;
      throw new Error(`nieoczekiwany URL w downloadText: ${url}`);
    },
    parseSha256File: (text) => text.split(/\s+/)[0],
    downloadToPartialFile: async (url, dest, opts) => {
      const bytes = url.startsWith('fake://full/') ? fullBytes : updateBytes;
      opts.onProgress({ downloadedBytes: bytes.length, totalBytes: bytes.length });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.partial`, bytes);
      return { bytes: bytes.length, sha256: sha256Hex(bytes), partialPath: `${dest}.partial` };
    }
  };
}

function makeVariantTestService({ rootDir, currentVersion, release, deps }) {
  const updateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scz-variant-svc-'));
  const spawned = [];
  const service = createUpdateService({
    rootDir,
    getInstalledVersion: () => ({ version: currentVersion }),
    repo: 'o/r',
    updateRoot,
    enabled: true,
    log: () => {},
    deps: {
      fetchLatestRelease: async () => release,
      spawnUpdaterProcess: (invocation) => { spawned.push(invocation); return null; },
      confirmUpdaterStarted: async () => true,
      ...deps
    }
  });
  return { service, updateRoot, spawned };
}

test('chooseInstallerAssets: fingerprint lokalny zgadza sie ze zdalnym -> pobiera MALY wariant aktualizacyjny', async () => {
  const fingerprint = 'a'.repeat(64);
  const fullBytes = crypto.randomBytes(50000);
  const updateBytes = crypto.randomBytes(2000); // znaczaco mniejszy - to jest cala racja bytu
  const release = buildFullFakeRelease('2.0.0', { fullBytes, updateBytes, remoteFingerprint: fingerprint });
  const rootDir = tempRootWithLauncher(fingerprint);
  try {
    const { service, updateRoot } = makeVariantTestService({
      rootDir, currentVersion: '1.0.0', release,
      deps: makeVariantDeps({ fullBytes, updateBytes, remoteFingerprint: fingerprint })
    });
    await service.checkForUpdate();
    const install = service.startInstall();
    await install.flowPromise;

    const updateAssetName = updateAssetFileName('2.0.0');
    const fullAssetName = assetFileName('2.0.0');
    assert.equal(fs.existsSync(path.join(updateRoot, '2.0.0', updateAssetName)), true);
    assert.equal(fs.existsSync(path.join(updateRoot, '2.0.0', fullAssetName)), false);
    assert.equal(fs.readFileSync(path.join(updateRoot, '2.0.0', updateAssetName)).length, updateBytes.length);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('chooseInstallerAssets: fingerprint lokalny NIE zgadza sie ze zdalnym (zmienil sie runtime) -> pobiera PELNY instalator', async () => {
  const fullBytes = crypto.randomBytes(50000);
  const updateBytes = crypto.randomBytes(2000);
  const release = buildFullFakeRelease('2.0.0', { fullBytes, updateBytes, remoteFingerprint: 'b'.repeat(64) });
  const rootDir = tempRootWithLauncher('a'.repeat(64)); // rozny od remoteFingerprint powyzej
  try {
    const { service, updateRoot } = makeVariantTestService({
      rootDir, currentVersion: '1.0.0', release,
      deps: makeVariantDeps({ fullBytes, updateBytes, remoteFingerprint: 'b'.repeat(64) })
    });
    await service.checkForUpdate();
    const install = service.startInstall();
    await install.flowPromise;

    assert.equal(fs.existsSync(path.join(updateRoot, '2.0.0', assetFileName('2.0.0'))), true);
    assert.equal(fs.existsSync(path.join(updateRoot, '2.0.0', updateAssetFileName('2.0.0'))), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('chooseInstallerAssets: brak lokalnego runtime-fingerprint.txt (instalacja sprzed tej funkcji) -> pobiera PELNY instalator', async () => {
  const fullBytes = crypto.randomBytes(50000);
  const updateBytes = crypto.randomBytes(2000);
  const release = buildFullFakeRelease('2.0.0', { fullBytes, updateBytes, remoteFingerprint: 'a'.repeat(64) });
  const rootDir = tempRootWithLauncher(undefined); // brak runtime-fingerprint.txt w ogole
  try {
    const { service, updateRoot } = makeVariantTestService({
      rootDir, currentVersion: '1.0.0', release,
      deps: makeVariantDeps({ fullBytes, updateBytes, remoteFingerprint: 'a'.repeat(64) })
    });
    await service.checkForUpdate();
    const install = service.startInstall();
    await install.flowPromise;

    assert.equal(fs.existsSync(path.join(updateRoot, '2.0.0', assetFileName('2.0.0'))), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('chooseInstallerAssets: wydanie bez wariantu update/fingerprint (starsze wydanie) -> pobiera PELNY instalator', async () => {
  // To jest DOKLADNIE ksztalt release'u sprzed audytu 2026-08-06 - musi dalej
  // dzialac dla uzytkownikow, ktorzy trafia na taki tag (np. rollback).
  const bytes = crypto.randomBytes(20000);
  const hash = sha256Hex(bytes);
  const fullName = assetFileName('2.0.0');
  const release = {
    version: '2.0.0', tagName: 'v2.0.0', name: 'Scyzoryk 2.0.0', notes: '', publishedAt: '2026-01-01T00:00:00Z',
    installerAsset: { name: fullName, url: 'fake://full/2.0.0', sizeBytes: bytes.length },
    shaAsset: { name: `${fullName}.sha256`, url: 'fake://full-sha/2.0.0' },
    updateInstallerAsset: null,
    updateShaAsset: null,
    runtimeFingerprintAsset: null
  };
  const rootDir = tempRootWithLauncher('a'.repeat(64));
  try {
    const { service, updateRoot } = makeVariantTestService({
      rootDir, currentVersion: '1.0.0', release,
      deps: {
        downloadText: async () => `${hash}  ${fullName}`,
        parseSha256File: (text) => text.split(/\s+/)[0],
        downloadToPartialFile: async (url, dest, opts) => {
          opts.onProgress({ downloadedBytes: bytes.length, totalBytes: bytes.length });
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(`${dest}.partial`, bytes);
          return { bytes: bytes.length, sha256: hash, partialPath: `${dest}.partial` };
        }
      }
    });
    await service.checkForUpdate();
    const install = service.startInstall();
    await install.flowPromise;

    assert.equal(fs.existsSync(path.join(updateRoot, '2.0.0', fullName)), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('chooseInstallerAssets: blad sieci przy sprawdzaniu fingerprinta -> bezpiecznie pobiera PELNY instalator, nie rzuca', async () => {
  const fullBytes = crypto.randomBytes(50000);
  const updateBytes = crypto.randomBytes(2000);
  const release = buildFullFakeRelease('2.0.0', { fullBytes, updateBytes, remoteFingerprint: 'a'.repeat(64) });
  const rootDir = tempRootWithLauncher('a'.repeat(64));
  try {
    const { service, updateRoot } = makeVariantTestService({
      rootDir, currentVersion: '1.0.0', release,
      deps: makeVariantDeps({ fullBytes, updateBytes, remoteFingerprint: 'a'.repeat(64), fingerprintShouldFail: true })
    });
    await service.checkForUpdate();
    const install = service.startInstall();
    await install.flowPromise;

    const status = service.getStatusPayload();
    assert.equal(status.state, 'installing'); // nie "error" - upadek sprawdzenia fingerprinta nie psuje calej aktualizacji
    assert.equal(fs.existsSync(path.join(updateRoot, '2.0.0', assetFileName('2.0.0'))), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
