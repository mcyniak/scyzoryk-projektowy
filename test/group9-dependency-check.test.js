const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hasDependencies, readDeclaredDependencies } = require('../lib/dependencyCheck');

test('package.json jest źródłem prawdy dla zależności aplikacji', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-deps-package-'));
  try {
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
      dependencies: {
        'pdfjs-dist': '4.8.69',
        '@google-cloud/documentai': '^9.6.2'
      }
    }), 'utf8');

    fs.mkdirSync(path.join(appDir, 'node_modules', 'pdfjs-dist'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'node_modules', '@google-cloud', 'documentai'), { recursive: true });

    assert.deepEqual(
      readDeclaredDependencies(appDir).sort(),
      ['@google-cloud/documentai', 'pdfjs-dist']
    );

    // Celowo przekazujemy starą, błędną listę z pdf-parse. Checker ma użyć
    // aktualnego package.json i nie uruchamiać ponownej instalacji bez końca.
    assert.equal(hasDependencies(appDir, ['pdf-parse']), true);

    fs.rmSync(path.join(appDir, 'node_modules', 'pdfjs-dist'), { recursive: true, force: true });
    assert.equal(hasDependencies(appDir, ['pdf-parse']), false);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('hasDependencies wykrywa rozjazd wersji z package-lock.json (audyt v1.0.4, P1-8)', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-deps-version-'));
  try {
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
      dependencies: { 'pdf-lib': '^1.17.1' }
    }), 'utf8');
    fs.writeFileSync(path.join(appDir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/pdf-lib': { version: '1.17.1' } }
    }), 'utf8');

    const depDir = path.join(appDir, 'node_modules', 'pdf-lib');
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({ name: 'pdf-lib', version: '1.10.0' }), 'utf8');

    // Folder istnieje, ale zainstalowana wersja (1.10.0) nie zgadza sie z
    // przypieta w lockfile (1.17.1) - to NIE moze byc uznane za "OK", bo
    // stary node_modules przetrwal aktualizacje, ktora podbila zaleznosc.
    assert.equal(hasDependencies(appDir, ['pdf-lib']), false);

    // Po realnym doinstalowaniu wlasciwej wersji - znowu "OK".
    fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({ name: 'pdf-lib', version: '1.17.1' }), 'utf8');
    assert.equal(hasDependencies(appDir, ['pdf-lib']), true);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('hasDependencies bez package-lock.json (albo bez wpisu danej zaleznosci) nie blokuje na braku info o wersji', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-deps-nolock-'));
  try {
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
      dependencies: { 'express': '^4.0.0' }
    }), 'utf8');
    const depDir = path.join(appDir, 'node_modules', 'express');
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({ name: 'express', version: '4.0.0' }), 'utf8');

    // Brak package-lock.json w ogole - nie ma z czym porownac, zostaje
    // dotychczasowe zachowanie (sama obecnosc folderu wystarcza).
    assert.equal(hasDependencies(appDir, ['express']), true);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('bez package.json checker nadal obsługuje jawnie przekazaną listę', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-deps-explicit-'));
  try {
    fs.mkdirSync(path.join(appDir, 'node_modules', 'express'), { recursive: true });
    assert.equal(hasDependencies(appDir, ['express']), true);
    assert.equal(hasDependencies(appDir, ['express', 'multer']), false);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
