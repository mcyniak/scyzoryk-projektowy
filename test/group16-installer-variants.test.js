const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { computeRuntimeFingerprint, listAppDirs } = require('../scripts/generate-runtime-fingerprint');

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
