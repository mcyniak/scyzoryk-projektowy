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
