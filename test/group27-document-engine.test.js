// lib/documentEngine.js po migracji Word COM -> Open XML: wybor renderera PDF
// (ONLYOFFICE x2t zamiast Syncfusion), sprzatanie plikow tymczasowych silnika
// i podpiecie wszystkich dawnych skryptow Word COM pod silnik (Wnioski
// powykonawcze, DOCX->PDF w drukarkach, Dokumenty seryjne, podglad Kreatora).
// Testy integracyjne z prawdziwym Scyzoryk.DocumentEngine.exe + x2t.exe
// uruchamiaja sie tylko tam, gdzie oba sa (Windows dev/CI po
// build-document-engine.ps1 + fetch-onlyoffice-x2t.ps1) - inaczej skip.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const documentEngine = require('../lib/documentEngine');
const AdmZip = require('../apps/dokumenty-seryjne/node_modules/adm-zip');

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

async function makeFakeOnlyOfficeDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-oo-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Pliki w working tree maja CRLF (core.autocrlf) - regexy nizej pisane pod \n.
async function readSrc(...parts) {
  return (await fsp.readFile(path.join(ROOT, ...parts), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function writeMinimalDocx(filePath, paragraphs) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>', 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>', 'utf8'));
  const body = paragraphs.map(p => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`).join('');
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:sectPr/></w:body></w:document>`, 'utf8'));
  zip.writeZip(filePath);
}

// --- Renderer PDF: ONLYOFFICE x2t / Word (bez Syncfusion) ------------------

test('documentEngine: brak jakichkolwiek sladow Syncfusion (klucz licencji usuniety razem z rendererem)', async () => {
  assert.equal(documentEngine.resolveSyncfusionLicenseKey, undefined);
  const src = await readSrc('lib', 'documentEngine.js');
  assert.doesNotMatch(src, /syncfusion/i);
  const input = withEnv({ SCYZORYK_PDF_RENDERER: 'word' }, () => documentEngine.pdfRendererInput());
  assert.deepEqual(Object.keys(input).sort(), ['onlyOfficeDir', 'pdfRenderer']);
});

test('resolveOnlyOfficeDir: SCYZORYK_ONLYOFFICE_DIR z x2t.exe wygrywa; katalog bez x2t.exe jest pomijany', async (t) => {
  const dir = await makeFakeOnlyOfficeDir(t);
  const withoutX2t = withEnv({ SCYZORYK_ONLYOFFICE_DIR: dir }, () => documentEngine.resolveOnlyOfficeDir());
  assert.notEqual(withoutX2t, path.resolve(dir));
  await fsp.writeFile(path.join(dir, 'x2t.exe'), '');
  const resolved = withEnv({ SCYZORYK_ONLYOFFICE_DIR: dir }, () => documentEngine.resolveOnlyOfficeDir());
  assert.equal(resolved, path.resolve(dir));
});

test('getPdfRendererMode: onlyoffice gdy jest x2t, SCYZORYK_PDF_RENDERER wymusza word/onlyoffice, smieci ignorowane', async (t) => {
  const dir = await makeFakeOnlyOfficeDir(t);
  await fsp.writeFile(path.join(dir, 'x2t.exe'), '');
  withEnv({ SCYZORYK_ONLYOFFICE_DIR: dir, SCYZORYK_PDF_RENDERER: undefined }, () => {
    assert.equal(documentEngine.getPdfRendererMode(), 'onlyoffice');
    assert.equal(documentEngine.engineUsesWord(), false);
    assert.deepEqual(documentEngine.pdfRendererInput(), { pdfRenderer: 'onlyoffice', onlyOfficeDir: path.resolve(dir) });
  });
  withEnv({ SCYZORYK_ONLYOFFICE_DIR: dir, SCYZORYK_PDF_RENDERER: ' Word ' }, () => {
    assert.equal(documentEngine.getPdfRendererMode(), 'word');
    assert.equal(documentEngine.engineUsesWord(), true);
  });
  withEnv({ SCYZORYK_ONLYOFFICE_DIR: dir, SCYZORYK_PDF_RENDERER: 'syncfusion' }, () => {
    // Dawna wartosc nie istnieje - zachowanie domyslne (auto), nie wyjatek.
    assert.equal(documentEngine.getPdfRendererMode(), 'onlyoffice');
  });
  withEnv({ SCYZORYK_PDF_RENDERER: 'onlyoffice' }, () => {
    assert.equal(documentEngine.getPdfRendererMode(), 'onlyoffice');
  });
});

// --- Sprzatanie plikow tymczasowych silnika ---------------------------------

test('cleanupStaleEngineTempFiles: usuwa tylko STARE pozostalosci silnika, nie swieze i nie cudze pliki', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-tmpsweep-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  const old = new Date(now - 7 * 60 * 60 * 1000);
  const oldFiles = [
    'docengine-in-mail-merge-1234-0123456789ab.json',
    'docengine-out-render-pdf-99-abcdefabcdef.json',
    'scyzoryk_pdf_0123456789abcdef0123456789abcdef.docx',
  ];
  for (const name of oldFiles) {
    await fsp.writeFile(path.join(dir, name), '{}');
    await fsp.utimes(path.join(dir, name), old, old);
  }
  const workDir = path.join(dir, 'scyzoryk_x2t_0123456789abcdef0123456789abcdef');
  await fsp.mkdir(path.join(workDir, 'tmp'), { recursive: true });
  await fsp.writeFile(path.join(workDir, 'in.docx'), 'x');
  await fsp.utimes(workDir, old, old);
  const fresh = 'docengine-in-convert-wm-1-aaaaaaaaaaaa.json';
  await fsp.writeFile(path.join(dir, fresh), '{}');
  const foreign = 'cudzy-plik.json';
  await fsp.writeFile(path.join(dir, foreign), '{}');
  await fsp.utimes(path.join(dir, foreign), old, old);

  const removed = documentEngine.cleanupStaleEngineTempFiles({ dir, now });
  assert.deepEqual(removed.sort(), [...oldFiles, path.basename(workDir)].sort());
  const left = (await fsp.readdir(dir)).sort();
  assert.deepEqual(left, [foreign, fresh].sort());
  assert.deepEqual(documentEngine.cleanupStaleEngineTempFiles({ dir: path.join(dir, 'nie-istnieje') }), []);
});

// --- lib/printing.js: DOCX->PDF przez silnik ---------------------------------

test('printing.convertDocxBatchToPdf: deleguje do documentEngine.renderDocxBatchToPdf, zwraca results bez zmian ksztaltu', async (t) => {
  const printing = require('../lib/printing');
  const original = { render: documentEngine.renderDocxBatchToPdf, usesWord: documentEngine.engineUsesWord };
  t.after(() => { documentEngine.renderDocxBatchToPdf = original.render; documentEngine.engineUsesWord = original.usesWord; });
  documentEngine.engineUsesWord = () => false;
  const calls = [];
  documentEngine.renderDocxBatchToPdf = async (files, options) => {
    calls.push({ files, options });
    return { ok: true, renderer: 'onlyoffice', results: files.map(f => ({ ok: true, input: f.inputPath, output: f.outputPath })) };
  };

  assert.deepEqual(await printing.convertDocxBatchToPdf('C:\\op', []), []);
  assert.equal(calls.length, 0, 'pusta paczka nie uruchamia silnika');

  const files = [{ inputPath: 'C:\\op\\Łódź.docx', outputPath: 'C:\\op\\Łódź.pdf', extra: 'ignorowane' }];
  const results = await printing.convertDocxBatchToPdf('C:\\op', files, { timeoutMs: 1234 });
  assert.deepEqual(results, [{ ok: true, input: 'C:\\op\\Łódź.docx', output: 'C:\\op\\Łódź.pdf' }]);
  assert.deepEqual(calls[0].files, [{ inputPath: 'C:\\op\\Łódź.docx', outputPath: 'C:\\op\\Łódź.pdf' }]);
  assert.equal(calls[0].options.timeoutMs, 1234);
});

test('printing.convertDocxBatchToPdf: blad silnika i limit czasu daja czytelne komunikaty', async (t) => {
  const printing = require('../lib/printing');
  const original = { render: documentEngine.renderDocxBatchToPdf, usesWord: documentEngine.engineUsesWord };
  t.after(() => { documentEngine.renderDocxBatchToPdf = original.render; documentEngine.engineUsesWord = original.usesWord; });
  documentEngine.engineUsesWord = () => false;
  const files = [{ inputPath: 'a.docx', outputPath: 'a.pdf' }];

  documentEngine.renderDocxBatchToPdf = async () => ({ ok: false, message: 'Nieoczekiwany blad silnika dokumentow: X' });
  await assert.rejects(printing.convertDocxBatchToPdf('op', files), /Nieoczekiwany blad silnika dokumentow: X/);

  documentEngine.renderDocxBatchToPdf = async () => { throw new Error('Silnik dokumentow (render-pdf) przekroczyl limit czasu 120000 ms.'); };
  await assert.rejects(printing.convertDocxBatchToPdf('op', files, { timeoutMs: 120000 }), /Przekroczono limit czasu konwersji DOCX->PDF \(2 min\)/);
});

// --- Podpiecie apek pod silnik (statycznie - bez Worda w CI) ----------------

test('stare skrypty Word COM usuniete i nigdzie nie wolane (mailmerge-to-pdf, convert-wm, docx-to-pdf, Kreator scan/build/test-word-com, wordSmartTemplate)', async () => {
  const removed = [
    'apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1',
    'apps/wnioski-powykonawcze/scripts/convert-wm.ps1',
    'lib/printing/docx-to-pdf.ps1',
    'apps/kreator-wzorow/scripts/build-template.ps1',
    'apps/kreator-wzorow/scripts/scan-template.ps1',
    'apps/kreator-wzorow/scripts/test-word-com.ps1',
    'lib/wordSmartTemplate.ps1',
  ];
  for (const rel of removed) assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `${rel} powinien byc usuniety`);

  const sources = [
    'apps/dokumenty-seryjne/server.js',
    'apps/dokumenty-seryjne/src/folderRoutes.js',
    'apps/wnioski-powykonawcze/server.js',
    'apps/kreator-wzorow/server.js',
    'lib/printing.js',
  ];
  for (const rel of sources) {
    const src = await readSrc(rel);
    assert.doesNotMatch(src, /spawn\((?:'|")powershell\.exe/, `${rel} nie powinien uruchamiac powershell.exe do dokumentow`);
    assert.doesNotMatch(src, /(?:PS_SCRIPT|DOCX_TO_PDF_SCRIPT|DOKUMENTY_SERYJNE_MAILMERGE_SCRIPT)\b/, `${rel}: stala starego skryptu`);
    assert.doesNotMatch(src, /getDocumentEngineMode|SCYZORYK_DOKUMENTY_ENGINE/, `${rel}: przelacznik awaryjny na Worda juz nie istnieje`);
  }
  const pkg = JSON.parse(await readSrc('package.json'));
  assert.equal(pkg.scripts['test:kreator-word'], undefined, 'skrypt npm dla usunietego test-word-com.ps1');
});

test('wnioski-powykonawcze: runConvertScript idzie przez documentEngine.convertWniosekMaterialowy, job.child = proces silnika (Przerwij dziala)', async () => {
  const src = await readSrc('apps', 'wnioski-powykonawcze', 'server.js');
  const fn = src.match(/async function runConvertScript\([\s\S]*?\n\}\n/);
  assert.ok(fn, 'nie znaleziono runConvertScript');
  assert.match(fn[0], /documentEngine\.convertWniosekMaterialowy\(input,/);
  assert.match(fn[0], /onSpawn: child => \{ if \(job\) job\.child = child; \}/);
  assert.match(fn[0], /writeJsonFileNoBom\(outputJson, output\)/);
  assert.match(fn[0], /documentEngine\.engineUsesWord\(\)/);
  assert.match(fn[0], /withWordAutomationLease\(/);
});

test('dokumenty-seryjne: generowanie tylko przez silnik, komunikaty bez "PowerShell", pliki JSON silnika sprzatane przy close/error', async () => {
  const src = await readSrc('apps', 'dokumenty-seryjne', 'server.js');
  const gen = src.match(/const runGeneration = \(\) => new Promise\([\s\S]*?\n  \}\);\n  \}\);\n/);
  assert.ok(gen, 'nie znaleziono runGeneration');
  assert.match(gen[0], /documentEngine\.spawnMailMerge\(engineInput/);
  assert.doesNotMatch(gen[0], /PowerShell/);
  assert.match(gen[0], /Zatrzymuję silnik dokumentów/);
  assert.match(gen[0], /Nie udało się uruchomić silnika dokumentów/);
  assert.equal((gen[0].match(/engineCleanup\(\);/g) || []).length, 2, 'cleanup w close i w error');
  assert.match(src, /imageManifestPath: job\.imageManifestPath && fs\.existsSync\(job\.imageManifestPath\)/);
  assert.match(src, /const needsWordLease = documentEngine\.engineUsesWord\(\);/);

  const folder = await readSrc('apps', 'dokumenty-seryjne', 'src', 'folderRoutes.js');
  assert.match(folder, /documentEngine\.runEngineCommand\("mail-merge", \{\s*\.\.\.documentEngine\.pdfRendererInput\(\),/);
});

test('kreator-wzorow: podglad idzie przez silnik (mail-merge, smartTemplateMode) bez galezi Word COM', async () => {
  const src = await readSrc('apps', 'kreator-wzorow', 'server.js');
  assert.match(src, /documentEngine\.runEngineCommand\('mail-merge', \{\s*\.\.\.documentEngine\.pdfRendererInput\(\),/);
  assert.match(src, /smartTemplateMode: true,/);
  assert.doesNotMatch(src, /mailmerge-to-pdf\.ps1'\)/);
  assert.doesNotMatch(src, /runPowerShell/);
});

test('instalator: tools\\onlyoffice trafia do stagingu (bez indeksu czcionek z maszyny budujacej), tylko wariant full, wersja w runtime-fingerprint', async (t) => {
  const build = await readSrc('scripts', 'build-installer.ps1');
  assert.match(build, /Join-Path \$Root 'tools\\onlyoffice'/);
  assert.match(build, /Join-Path \$stagingDir 'onlyoffice'/);
  assert.match(build, /fetch-onlyoffice-x2t\.ps1/);
  assert.match(build, /sdkjs\\common\\AllFonts\.js/);
  // Konwerter musi byc w stagingu PRZED policzeniem fingerprintu.
  assert.ok(build.indexOf("Join-Path $stagingDir 'onlyoffice'") < build.indexOf("'scripts\\generate-runtime-fingerprint.js'"));

  const iss = await readSrc('installer', 'scyzoryk.iss');
  assert.match(iss, /Excludes: "[^"]*\\onlyoffice\\\*"/);
  // Ten sam blok #if ... #endif co node-runtime (wariant pelny).
  const runtimeLine = iss.indexOf('Source: "{#StagingDir}\\node-runtime\\*"');
  assert.ok(runtimeLine > 0);
  const blockStart = iss.lastIndexOf('#if BuildVariant == "full"', runtimeLine);
  const blockEnd = iss.indexOf('#endif', runtimeLine);
  assert.match(iss.slice(blockStart, blockEnd), /Source: "\{#StagingDir\}\\onlyoffice\\\*"; DestDir: "\{app\}\\onlyoffice"/);

  const { computeRuntimeFingerprint } = require('../scripts/generate-runtime-fingerprint');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-fp-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'apps', 'a'), { recursive: true });
  await fsp.writeFile(path.join(root, 'apps', 'a', 'package-lock.json'), '{}');
  const withoutOo = computeRuntimeFingerprint('v24.0.0', root);
  await fsp.mkdir(path.join(root, 'onlyoffice'));
  await fsp.writeFile(path.join(root, 'onlyoffice', 'WERSJA.txt'), '\uFEFFONLYOFFICE DocumentBuilder v9.4.0\r\n');
  const v94 = computeRuntimeFingerprint('v24.0.0', root);
  await fsp.writeFile(path.join(root, 'onlyoffice', 'WERSJA.txt'), 'ONLYOFFICE DocumentBuilder v9.5.0');
  const v95 = computeRuntimeFingerprint('v24.0.0', root);
  assert.notEqual(withoutOo, v94);
  assert.notEqual(v94, v95);
});

// --- Integracja z prawdziwym silnikiem + x2t (tylko gdzie sa) ---------------

const canRunRealEngine = process.platform === 'win32' && documentEngine.isEngineAvailable() && Boolean(documentEngine.resolveOnlyOfficeDir());

test('integracja: render-pdf przez ONLYOFFICE x2t, polskie znaki w folderze i nazwie pliku', { skip: !canRunRealEngine && 'brak Scyzoryk.DocumentEngine.exe albo tools/onlyoffice (x2t)', timeout: 5 * 60 * 1000 }, async (t) => {
  const dir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-render-')), 'Zażółć gęślą jaźń');
  t.after(() => fsp.rm(path.dirname(dir), { recursive: true, force: true }));
  await fsp.mkdir(dir, { recursive: true });
  const docx = path.join(dir, 'Łódź ul. Świętokrzyska 1.docx');
  writeMinimalDocx(docx, ['Dokumentacja powykonawcza', 'Zażółć gęślą jaźń - ĄĆĘŁŃÓŚŹŻ']);
  const pdf = path.join(dir, 'wynik', 'Łódź ul. Świętokrzyska 1.pdf');

  const output = await documentEngine.renderDocxBatchToPdf([{ inputPath: docx, outputPath: pdf }], { timeoutMs: 4 * 60 * 1000 });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(output.renderer, 'onlyoffice');
  assert.equal(output.results[0].ok, true, JSON.stringify(output.results));
  const head = (await fsp.readFile(pdf)).subarray(0, 5).toString('latin1');
  assert.equal(head, '%PDF-');
});

test('integracja: convert-wm (Wnioski powykonawcze) bez Worda - DOCX i PDF obok siebie', { skip: !canRunRealEngine && 'brak Scyzoryk.DocumentEngine.exe albo tools/onlyoffice (x2t)', timeout: 5 * 60 * 1000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-wm-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'WM pompa ciepła.docx');
  writeMinimalDocx(input, ['Wniosek o zatwierdzenie Materiałów / Urządzeń', 'Kraków, dn. 12.03.2025', 'ZATWIERDZAM / ZATWIERDZAM z UWAGAMI / ODRZUCAM*', 'Podpis']);
  const pdfPath = path.join(dir, 'WM dok.pod pompa ciepła.pdf');
  const docxPath = path.join(dir, 'WM dok.pod pompa ciepła.docx');
  let spawned = null;
  const output = await documentEngine.convertWniosekMaterialowy(
    { dateText: '30.09.2026', saveDocx: true, visibleWord: false, files: [{ inputPath: input, originalName: 'WM pompa ciepła.docx', pdfPath, docxPath }] },
    { timeoutMs: 4 * 60 * 1000, onSpawn: child => { spawned = child; } }
  );
  assert.ok(spawned && typeof spawned.kill === 'function', 'onSpawn dostaje proces silnika (do anulowania)');
  assert.equal(output.ok, true, JSON.stringify(output));
  const item = output.results[0];
  assert.equal(item.ok, true, JSON.stringify(item));
  assert.equal(item.deletedSection, true);
  assert.deepEqual(item.dateReplacements, [{ from: '12.03.2025', to: '30.09.2026' }]);
  assert.ok(fs.existsSync(pdfPath) && fs.existsSync(docxPath));
  const xml = new AdmZip(docxPath).readAsText('word/document.xml');
  assert.match(xml, /Dokumentacja Powykonawcza/);
  assert.doesNotMatch(xml, /ZATWIERDZAM/);
});
