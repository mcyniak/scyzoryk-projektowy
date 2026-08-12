const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('../apps/ocr-audytow/node_modules/pdf-lib');
const ExcelJS = require('../apps/ocr-audytow/node_modules/exceljs');

const appRoot = path.join(__dirname, '..', 'apps', 'ocr-audytow');

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-group3-'));
}

async function createPdf(filePath, pageCount = 3) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([400 + index * 10, 600 + index * 10]);
  }
  await fsp.writeFile(filePath, await document.save());
}

// =====================================================================
// ocrPipeline.js - od 2026-08-12 (migracja Document AI -> Gemini, patrz
// pamiec projektu) juz NIE robi wlasnego OCR-u per strona - tylko liczy
// strony, generuje miniatury i pyta geminiFieldEngine.js o propozycje
// podzialu na bloki. finalizeSplit to teraz zwykle kopiowanie zakresu
// stron oryginalu (pdf-lib copyPages), bez posredniego "ocrDoc".
// =====================================================================

test('finalizeSplit kopiuje poprawny zakres stron oryginalu do kazdego pliku wyjsciowego', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const sourcePdfPath = path.join(dir, 'source.pdf');
  const outputA = path.join(dir, 'blok-a.pdf');
  const outputB = path.join(dir, 'blok-b.pdf');
  await createPdf(sourcePdfPath, 5);

  const { finalizeSplit } = require('../apps/ocr-audytow/src/ocrPipeline');
  await finalizeSplit({
    sourcePdfPath,
    blocks: [{ startPage: 0, endPage: 2 }, { startPage: 3, endPage: 4 }],
    outPaths: [outputA, outputB]
  });

  const docA = await PDFDocument.load(await fsp.readFile(outputA));
  const docB = await PDFDocument.load(await fsp.readFile(outputB));
  assert.equal(docA.getPageCount(), 3);
  assert.equal(docB.getPageCount(), 2);
  // Strona 0 zrodla jest 400x600, strona 3 jest 430x630 (patrz createPdf) -
  // sprawdza, ze pocieto WLASCIWY zakres, nie np. od poczatku za kazdym razem.
  assert.equal(docA.getPages()[0].getWidth(), 400);
  assert.equal(docB.getPages()[0].getWidth(), 430);
});

test('inspectDocument zwraca poprawna liczbe stron', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const sourcePdfPath = path.join(dir, 'source.pdf');
  await createPdf(sourcePdfPath, 4);

  const { inspectDocument } = require('../apps/ocr-audytow/src/ocrPipeline');
  const result = await inspectDocument(sourcePdfPath);
  assert.equal(result.pageCount, 4);
});

test('dedupeOutPaths: identyczna etykieta dwoch blokow nie nadpisuje pliku (audyt v1.0.4, OCR ustalenie 7)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { dedupeOutPaths } = require('../apps/ocr-audytow/server');

  const paths = [
    path.join(dir, 'audyt - Kowalski.pdf'),
    path.join(dir, 'audyt - Kowalski.pdf'),
    path.join(dir, 'audyt - Kowalski.pdf')
  ];
  const deduped = dedupeOutPaths(paths);
  assert.equal(new Set(deduped).size, 3, 'wszystkie sciezki musza byc unikalne');
  assert.equal(deduped[0], paths[0]);
  assert.equal(deduped[1], path.join(dir, 'audyt - Kowalski (2).pdf'));
  assert.equal(deduped[2], path.join(dir, 'audyt - Kowalski (3).pdf'));

  // Rozne etykiety nie powinny dostawac zadnego sufiksu.
  const distinct = dedupeOutPaths([path.join(dir, 'a.pdf'), path.join(dir, 'b.pdf')]);
  assert.deepEqual(distinct, [path.join(dir, 'a.pdf'), path.join(dir, 'b.pdf')]);
});

test('validateBlocks: pelne pokrycie bez luk przechodzi bez bledu (zero regresji dla normalnego frontendu)', () => {
  const { validateBlocks } = require('../apps/ocr-audytow/server');
  const cleaned = validateBlocks(
    [
      { startPage: 0, endPage: 2, label: 'Adres 1' },
      { startPage: 3, endPage: 5, label: 'Adres 2' },
      { startPage: 6, endPage: 7, label: 'Adres 3' }
    ],
    8
  );
  assert.equal(cleaned.length, 3);
  assert.equal(cleaned[0].startPage, 0);
  assert.equal(cleaned[cleaned.length - 1].endPage, 7);
});

test('validateBlocks: pojedynczy blok obejmujacy caly dokument przechodzi', () => {
  const { validateBlocks } = require('../apps/ocr-audytow/server');
  const cleaned = validateBlocks([{ startPage: 0, endPage: 4, label: 'Caly dokument' }], 5);
  assert.equal(cleaned.length, 1);
});

test('validateBlocks: luka miedzy blokami jest odrzucana z komunikatem wskazujacym zgubione strony (audyt rozdz. 17, P0)', () => {
  const { validateBlocks } = require('../apps/ocr-audytow/server');
  assert.throws(
    () => validateBlocks(
      [
        { startPage: 0, endPage: 2, label: 'Adres 1' },
        { startPage: 5, endPage: 7, label: 'Adres 2' }
      ],
      8
    ),
    /luke miedzy strona 3 a 6/
  );
});

test('validateBlocks: podzial nie zaczynajacy sie od strony 1 albo nie konczacy na ostatniej stronie jest odrzucany (audyt rozdz. 17, P0)', () => {
  const { validateBlocks } = require('../apps/ocr-audytow/server');
  // Brakuje poczatku dokumentu (strona 1 zgubiona).
  assert.throws(
    () => validateBlocks([{ startPage: 1, endPage: 4, label: 'Adres 1' }], 5),
    /nie pokrywa calego dokumentu/
  );
  // Brakuje konca dokumentu (ostatnia strona zgubiona).
  assert.throws(
    () => validateBlocks([{ startPage: 0, endPage: 3, label: 'Adres 1' }], 5),
    /nie pokrywa calego dokumentu/
  );
});

test('limit paczki jest sprawdzany przed rozpoczeciem platnego rozpoznawania', () => {
  const { validateOcrBatchInspections } = require('../apps/ocr-audytow/src/ocrLimits');
  let calls = 0;
  assert.throws(() => {
    validateOcrBatchInspections([
      { originalName: 'za-duzy.pdf', inspection: { pageCount: 61 } }
    ], { maxPagesPerFile: 60, maxTotalPages: 300 });
    calls += 1;
  }, /Limit jednego pliku/);
  assert.equal(calls, 0);
});

// =====================================================================
// src/fieldExtraction.js - od 2026-08-12 to juz TYLKO schemat pol
// (FIELD_DEFS/COLUMN_*) + budowa wyniku z needsReview na podstawie
// deterministycznej walidacji (bez wlasnego, geometrycznego dopasowania -
// to robi teraz Gemini, patrz src/geminiFieldEngine.js).
// =====================================================================

test('toFieldResult: pusta/null wartosc zawsze trafia do recznego przegladu', () => {
  const { toFieldResult } = require('../apps/ocr-audytow/src/fieldExtraction');
  const def = { key: 'imieNazwisko', columnLabel: 'Imię i nazwisko', kind: 'text' };
  assert.deepEqual(
    { value: toFieldResult(null, def).value, needsReview: toFieldResult(null, def).needsReview, resolved: toFieldResult(null, def).resolved },
    { value: '', needsReview: true, resolved: false }
  );
});

test('toFieldResult: checkbox z wartoscia spoza dozwolonej listy trafia do przegladu (lapie halucynacje modelu)', () => {
  const { toFieldResult } = require('../apps/ocr-audytow/src/fieldExtraction');
  const def = { key: 'typKonstrukcji', columnLabel: 'Typ konstrukcji', kind: 'checkbox', options: [{ label: 'Lekka' }, { label: 'Średnia' }, { label: 'Ciężka' }] };
  assert.equal(toFieldResult('Ciężka', def).needsReview, false);
  assert.equal(toFieldResult('Bardzo ciężka', def).needsReview, true);
});

test('toFieldResult: pole numeryczne bez zadnej cyfry trafia do przegladu', () => {
  const { toFieldResult } = require('../apps/ocr-audytow/src/fieldExtraction');
  const def = { key: 'rokBudowy', columnLabel: 'Rok budowy budynku', kind: 'text', valueKind: 'numeric' };
  assert.equal(toFieldResult('1950', def).needsReview, false);
  assert.equal(toFieldResult('brak danych', def).needsReview, true);
});

test('buildFieldsFromExtraction: pole typu manual (demontaz) zawsze trafia do recznego przegladu, nigdy nie jest wysylane do Gemini', () => {
  const { buildFieldsFromExtraction, filterExtractableFields } = require('../apps/ocr-audytow/src/fieldExtraction');
  const extractable = filterExtractableFields();
  assert.ok(!extractable.some((f) => f.key === 'demontaz'), 'demontaz nie moze trafic do schematu wysylanego do Gemini');

  const result = buildFieldsFromExtraction({ imieNazwisko: 'Jan Kowalski' });
  assert.equal(result.demontaz.needsReview, true);
  assert.equal(result.demontaz.resolved, false);
  assert.equal(result.imieNazwisko.value, 'Jan Kowalski');
  assert.equal(result.imieNazwisko.needsReview, false);
});

test('buildFieldsFromExtraction: allowedKeys zawęża wynik do podanych kluczy (rodzina protokolu)', () => {
  const { buildFieldsFromExtraction } = require('../apps/ocr-audytow/src/fieldExtraction');
  const allowed = new Set(['imieNazwisko', 'rokBudowy']);
  const result = buildFieldsFromExtraction({ imieNazwisko: 'Jan Kowalski', rokBudowy: '1950', adresInstalacji: 'nie powinno sie pojawic' }, allowed);
  assert.deepEqual(Object.keys(result).sort(), ['imieNazwisko', 'rokBudowy']);
});

// =====================================================================
// src/geminiFieldEngine.js - konfiguracja (klucz API) i budowa
// schematu/promptu wysylanego do Gemini.
// =====================================================================

test('geminiFieldEngine: isConfigured czyta klucz z pliku uzytkownika (%LOCALAPPDATA%/Scyzoryk/gemini-api-key.json)', async (t) => {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousEnvKey = process.env.GEMINI_API_KEY;
  const localAppData = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-gemini-cfg-'));
  process.env.LOCALAPPDATA = localAppData;
  delete process.env.GEMINI_API_KEY;
  const enginePath = require.resolve('../apps/ocr-audytow/src/geminiFieldEngine');
  delete require.cache[enginePath];
  t.after(() => {
    process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousEnvKey !== undefined) process.env.GEMINI_API_KEY = previousEnvKey; else delete process.env.GEMINI_API_KEY;
    delete require.cache[enginePath];
    return fsp.rm(localAppData, { recursive: true, force: true });
  });

  const { isConfigured, saveUserApiKey } = require(enginePath);
  assert.equal(isConfigured(), false);
  saveUserApiKey('test-klucz-abc123');
  assert.equal(isConfigured(), true);
});

test('geminiFieldEngine: saveUserApiKey odrzuca pusty klucz', async (t) => {
  const localAppData = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-gemini-cfg-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  const enginePath = require.resolve('../apps/ocr-audytow/src/geminiFieldEngine');
  delete require.cache[enginePath];
  t.after(() => {
    process.env.LOCALAPPDATA = previousLocalAppData;
    delete require.cache[enginePath];
    return fsp.rm(localAppData, { recursive: true, force: true });
  });
  const { saveUserApiKey } = require(enginePath);
  assert.throws(() => saveUserApiKey(''), /Podaj klucz/);
  assert.throws(() => saveUserApiKey('   '), /Podaj klucz/);
});

// =====================================================================
// eksport rodzinny (src/tabelaAdresowaColumns.js, src/excelExport.js) -
// niezalezne od silnika ekstrakcji, bez zmian.
// =====================================================================

test('eksport rodzinny zachowuje wzór i przy nadpisaniu tworzy kopię', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { TABELA_FAMILIES, buildRowValues } = require('../apps/ocr-audytow/src/tabelaAdresowaColumns');
  const { writeFamilyTemplateRows } = require('../apps/ocr-audytow/src/excelExport');
  const definition = TABELA_FAMILIES.pc;
  const outputPath = path.join(dir, 'wynik.xlsx');
  await fsp.copyFile(definition.templateFile, outputPath);

  const row = buildRowValues('pc', {
    imieNazwisko: { value: 'Jan Kowalski' },
    udzialGrzejnikowy: { value: '35' }
  });
  const result = await writeFamilyTemplateRows(definition.templateFile, outputPath, definition.sheetName, [row]);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));

  const source = new ExcelJS.Workbook();
  const written = new ExcelJS.Workbook();
  await source.xlsx.readFile(definition.templateFile);
  await written.xlsx.readFile(outputPath);
  const sourceSheet = source.getWorksheet(definition.sheetName);
  const writtenSheet = written.getWorksheet(definition.sheetName);
  assert.deepEqual(
    writtenSheet.getRow(1).values,
    sourceSheet.getRow(1).values
  );
  assert.deepEqual(writtenSheet.getRow(1).getCell(1).style, sourceSheet.getRow(1).getCell(1).style);
  const headers = writtenSheet.getRow(1).values;
  assert.equal(writtenSheet.getRow(2).getCell(headers.indexOf('Imię i Nazwisko')).value, 'Jan Kowalski');
  assert.equal(writtenSheet.getRow(2).getCell(headers.indexOf('Udział ogrzew. podłog.')).value, '65');
});

// =====================================================================
// Frontend (public/app.js) - sprawdza uzycie wspolnego apiJson() (z
// obsluga bledow/kodow) zamiast surowego fetch() dla mutujacych zadan,
// oraz ze zapis pola faktycznie idzie przez /api/ocr/resolve-field.
// =====================================================================

test('klient zapisuje reczne poprawki pol przez wspolna walidacje odpowiedzi (apiJson), nie surowy fetch', async () => {
  const source = await fsp.readFile(path.join(appRoot, 'public', 'app.js'), 'utf8');
  assert.match(source, /await apiJson\('\/api\/ocr\/resolve-field'/);
  assert.match(source, /field\.needsReview = false;/);
  assert.doesNotMatch(source, /await fetch\('\/api\/ocr\/resolve-field'/);
  assert.match(source, /EXCEL_ALREADY_EXISTS/);
});

// =====================================================================
// Ekran "OCR zablokowany" - reczne wpisanie klucza API Gemini (zamiast
// pliku service-account.json + 3 zmiennych Document AI).
// =====================================================================

test('POST /api/ocr/setup-api-key: poprawny klucz odblokowuje OCR, /api/health od razu widzi zmiane', async (t) => {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousEnvKey = process.env.GEMINI_API_KEY;
  const localAppData = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-ocr-http-'));
  process.env.LOCALAPPDATA = localAppData;
  delete process.env.GEMINI_API_KEY;
  // geminiFieldEngine.js oblicza USER_CONFIG_PATH RAZ, jako stala modulu, przy
  // pierwszym require() - trzeba wyczyscic cache, zeby swiezy require()
  // faktycznie przeliczyl sciezke z NOWYM process.env.LOCALAPPDATA.
  delete require.cache[require.resolve('../apps/ocr-audytow/server')];
  delete require.cache[require.resolve('../apps/ocr-audytow/src/geminiFieldEngine')];
  t.after(() => {
    process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousEnvKey !== undefined) process.env.GEMINI_API_KEY = previousEnvKey; else delete process.env.GEMINI_API_KEY;
    delete require.cache[require.resolve('../apps/ocr-audytow/server')];
    delete require.cache[require.resolve('../apps/ocr-audytow/src/geminiFieldEngine')];
    return fsp.rm(localAppData, { recursive: true, force: true });
  });

  const { app: ocrApp } = require('../apps/ocr-audytow/server');

  const server = ocrApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const before = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(before.ocrConfigured, false);

  const res = await fetch(`http://127.0.0.1:${port}/api/ocr/setup-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
    body: JSON.stringify({ apiKey: 'test-klucz-abc123' })
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);

  const after = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(after.ocrConfigured, true, 'juz uruchomiony proces musi widziec nowa konfiguracje bez restartu (czytana z dysku przy kazdym wywolaniu)');
});

test('POST /api/ocr/setup-api-key: bez naglowka X-Scyzoryk-Request dostaje 403 (ta sama ochrona co reszta mutujacych tras)', async (t) => {
  const { app: ocrApp } = require('../apps/ocr-audytow/server');
  const server = ocrApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${port}/api/ocr/setup-api-key`, { method: 'POST' });
  assert.equal(res.status, 403);
});
