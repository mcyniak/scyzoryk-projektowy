// Poprawki po przegladzie UX (2026-09-29, czesc 2): archiwum zapisow
// "Zapisz jako PDF", zadanie w tle dla trybu folderu we Wnioskach, lista
// plikow w Pieczatkach i wznowienie OCR po odswiezeniu strony.
'use strict';
// Izolacja katalogu danych (audyt 2026-10-20): bez tego ten plik pisal do PRAWDZIWEGO
// katalogu danych ScyzorykProjektowy w %LOCALAPPDATA% uzytkownika (blokady druku, "Zapisane PDF").
if (!process.env.SCYZORYK_DATA_ROOT) {
  const isolated = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'scyzoryk-test-data-'));
  process.env.SCYZORYK_DATA_ROOT = isolated;
  process.on('exit', () => { try { require('node:fs').rmSync(isolated, { recursive: true, force: true }); } catch (_) { /* najlepszy wysilek */ } });
}


const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('Zapisz jako PDF: poprzednie zapisy trafiaja do archiwum (max 5 zestawow)', () => {
  const { archivePreviousSaveAsPdf, PREVIOUS_SAVES_DIR } = require('../lib/printing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scyz-archiwum-'));
  try {
    assert.equal(archivePreviousSaveAsPdf(dir), null, 'pusty folder - nic do archiwizacji');
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(path.join(dir, `plik${i}.pdf`), 'x');
      const to = archivePreviousSaveAsPdf(dir, { now: new Date(2026, 8, 29, 10, 0, i) });
      assert.ok(fs.existsSync(path.join(to, `plik${i}.pdf`)));
    }
    assert.deepEqual(fs.readdirSync(dir), [PREVIOUS_SAVES_DIR]);
    const sets = fs.readdirSync(path.join(dir, PREVIOUS_SAVES_DIR)).sort();
    assert.equal(sets.length, 5);
    assert.equal(sets[0], '2026-09-29 10.00.02', 'najstarsze zestawy usuniete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const app of ['drukarka', 'drukarka-projekty']) {
    assert.match(read('apps', app, 'server.js'), /archivePreviousSaveAsPdf\(SAVE_AS_PDF_OUTPUT_DIR\)/, app);
  }
});

test('Wnioski: tryb folderu dziala w tle z postepem, przerwaniem i wznowieniem', () => {
  const server = read('apps', 'wnioski-powykonawcze', 'server.js');
  assert.match(server, /status\(202\)/);
  assert.match(server, /app\.get\('\/api\/wm-folder\/jobs\/:id'/);
  assert.match(server, /app\.post\('\/api\/wm-folder\/jobs\/:id\/cancel'/);
  const client = read('apps', 'wnioski-powykonawcze', 'public', 'inline-1.js');
  assert.match(client, /wnioski\.wmFolderJob/);
  assert.match(client, /Przerwij/);
});

test('Pieczatki: pliki mozna dokladac partiami i usuwac pojedynczo', () => {
  const app = read('apps', 'pieczatki-pdf', 'public', 'app.js');
  assert.match(app, /function addPdfFiles/);
  assert.match(app, /function removePdfFile/);
  assert.match(app, /pdfPreviewRemove/);
  assert.match(app, /getPdfFiles\(\)/);
});

test('OCR: odczyt wraca po odswiezeniu strony (sessionStorage + GET /api/ocr/analysis/:id)', () => {
  const server = read('apps', 'ocr-audytow', 'server.js');
  assert.match(server, /app\.get\('\/api\/ocr\/analysis\/:analysisId'/);
  assert.match(server, /thumbnails: result\.thumbnails/);
  const app = read('apps', 'ocr-audytow', 'public', 'app.js');
  assert.match(app, /const OCR_SESSION_KEY = 'ocr\.session'/);
  assert.match(app, /checkOcrConfigured\(\)\.then\(resumeOcrSession\)/);
  // sesja kasowana przy "Wyczysc", "Anuluj" i po zapisie wynikow
  assert.ok((app.match(/clearOcrSession\(\);/g) || []).length >= 3);
});
