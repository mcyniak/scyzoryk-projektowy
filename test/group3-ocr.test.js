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
// Audyt 2026-08-19 (na wyrazna prosbe wlasciciela): tryb "wgraj gotowa
// tabele adresowa" - dopasowanie naglowkow (dokladne + jawne aliasy),
// nowa kolumna licza "kolektory" (deriveFromKeyword) i wypelnianie TEGO
// SAMEGO pliku w miejscu (tylko puste komorki, LP jako klucz dopasowania).
// =====================================================================

async function buildOwnerStyleTable(dir, rows) {
  // Naglowki DOKLADNIE takie, jakie wlasciciel podal na czacie (2026-08-19) -
  // czesc to jawne aliasy (np. "Udział ogrzew grzejnik" bez kropki), reszta
  // (Miejscowosc, Numer obrebu, Adres zam. inny niz inwestycji) to celowo
  // nierozpoznane/biurowe naglowki.
  const header = [
    'LP', 'REZYGNACJA', 'Imię i Nazwisko', 'Adres', 'Miejscowość', 'Numer działki',
    'Numer obrębu', 'Nazwa obrębu', 'Nr telefonu', 'Adres zam. inny niż inwestycji',
    'Moc pompy z gminy', 'Model pompy', 'Wysokość kotłowni (m)', 'kolektory',
    'Źródło ciepła', 'Demontaż', 'Udział ogrzew grzejnik', 'Udział ogrzew podłog',
    'Liczba mieszkańców', 'Rok budowy', 'Powierzchnia', 'Ocieplenie fund.',
    'Ocieplenie ścian', 'Ocieplenie dach/strop', 'Audyt', 'Zdjęcia', 'Obliczenia',
    'RYS', 'PT', 'Druk', 'Uwagi do audytów', 'UWAGI'
  ];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Pompy ciepła');
  sheet.addRow(header);
  for (const row of rows) sheet.addRow(header.map((h) => row[h] ?? ''));
  const filePath = path.join(dir, 'Biała tabela adresowa.xlsx');
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

test('normalizeHeader/matchColumnToFamily: dokladne dopasowanie i jawne aliasy, nierozpoznany naglowek -> null (nigdy nie zgadywane)', () => {
  const { normalizeHeader, matchColumnToFamily } = require('../apps/ocr-audytow/src/tabelaAdresowaColumns');
  assert.equal(normalizeHeader('  Ociepl. fund.  '), 'ociepl. fund');
  assert.equal(matchColumnToFamily('Ociepl. fund.', 'pc').fieldKey, 'izolacjaScianyFundamentowej');
  assert.equal(matchColumnToFamily('Ocieplenie fund.', 'pc').fieldKey, 'izolacjaScianyFundamentowej', 'jawny alias musi dzialac');
  assert.equal(matchColumnToFamily('Nr telefonu', 'pc').fieldKey, 'telefon');
  assert.equal(matchColumnToFamily('Udział ogrzew grzejnik', 'pc').fieldKey, 'udzialGrzejnikowy');
  assert.equal(matchColumnToFamily('kolektory', 'pc').label, 'kolektory');
  assert.equal(matchColumnToFamily('Miejscowość', 'pc'), null, 'nierozpoznany naglowek - nigdy nie zgadywany');
  assert.equal(matchColumnToFamily('cokolwiek losowego', 'pc'), null);
});

test('allowedKeysForFamily("pc"): zawiera Liczba mieszkańców (liczbaOsob) i zrodlowy klucz kolumny "kolektory" (zrodloCieplaInnyOpis)', () => {
  const { allowedKeysForFamily } = require('../apps/ocr-audytow/src/tabelaAdresowaColumns');
  const keys = allowedKeysForFamily('pc');
  assert.ok(keys.has('liczbaOsob'));
  assert.ok(keys.has('zrodloCieplaInnyOpis'));
  assert.ok(!keys.has('kolektory'), 'kolektory samo nie jest fieldKey - to liczona kolumna');
});

test('buildRowValues: kolumna "kolektory" (deriveFromKeyword) - "Inny" + dopisek "kolektor" -> tak, inny dopisek/pusto -> nie', () => {
  const { buildRowValues } = require('../apps/ocr-audytow/src/tabelaAdresowaColumns');
  const zKolektorem = buildRowValues('pc', { zrodloCieplaInnyOpis: { value: 'kolektor słoneczny na dachu' } });
  assert.equal(zKolektorem['kolektory'], 'tak');
  const innyDopisek = buildRowValues('pc', { zrodloCieplaInnyOpis: { value: 'piec akumulacyjny' } });
  assert.equal(innyDopisek['kolektory'], 'nie');
  const pusto = buildRowValues('pc', {});
  assert.equal(pusto['kolektory'], 'nie');
});

test('readExistingTable: czyta realny plik uzytkownika (naglowki z aliasami + nierozpoznane) - rozpoznaje kolumny po LP, zlicza wiersze', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { readExistingTable } = require('../apps/ocr-audytow/src/excelExport');

  const filePath = await buildOwnerStyleTable(dir, [
    { LP: 12, Adres: 'Kwiatowa 5', 'Imię i Nazwisko': 'Jan Kowalski', 'Rok budowy': '1998' },
    { LP: 13, Adres: 'Polna 2' } // Rok budowy puste - "brakujace"
  ]);

  const { rows, columns, unrecognizedHeaders } = await readExistingTable(filePath, 'pc');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.lp), ['12', '13']);
  assert.equal(rows[0].values['Rok budowy'], '1998');
  assert.equal(rows[1].values['Rok budowy'], '');
  assert.ok(columns.some((c) => c.def.fieldKey === 'rokBudowy'));
  assert.ok(unrecognizedHeaders.includes('Miejscowość'), 'biurowe/nieznane naglowki zglaszane, nie zgadywane');
});

test('fillExistingTableRows: wypelnia TYLKO puste komorki, nigdy nie nadpisuje juz istniejacych danych, zglasza niedopasowane LP', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { readExistingTable, fillExistingTableRows } = require('../apps/ocr-audytow/src/excelExport');

  const filePath = await buildOwnerStyleTable(dir, [
    { LP: 12, Adres: 'Kwiatowa 5' }, // Rok budowy puste -> ma dostac wartosc
    { LP: 13, Adres: 'Polna 2', 'Rok budowy': '2005' } // JUZ wypelnione -> ma zostac nietkniete
  ]);

  // Symulacja checklisty, na ktorej uzytkownik odznaczyl wszystko oprocz
  // "Rok budowy" - reszta kolumn (w tym "kolektory") ma zostac calkowicie
  // pominieta, nawet jesli technicznie dalaby sie policzyc.
  const allowedKeys = new Set(['rokBudowy']);
  const rowsByLp = new Map([
    ['12', { rokBudowy: { value: '1998' } }],
    ['13', { rokBudowy: { value: '2020' } }], // nie powinno nadpisac istniejacego '2005'
    ['99', { rokBudowy: { value: '2010' } }] // brak takiego LP w pliku
  ]);

  const result = await fillExistingTableRows(filePath, 'pc', rowsByLp, allowedKeys);
  assert.equal(result.matchedRows, 2);
  assert.equal(result.filledCells, 1);
  assert.deepEqual(result.unmatchedLp, ['99']);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));

  const { rows } = await readExistingTable(filePath, 'pc');
  assert.equal(rows.find((r) => r.lp === '12').values['Rok budowy'], '1998');
  assert.equal(rows.find((r) => r.lp === '13').values['Rok budowy'], '2005', 'istniejaca wartosc NIGDY nie moze zostac nadpisana');
});

test('POST /api/ocr/inspect-table: zwraca liste pol z licznikiem brakow (pre-zaznaczenie checklisty) i nierozpoznane naglowki', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = await buildOwnerStyleTable(dir, [
    { LP: 12, Adres: 'Kwiatowa 5', 'Rok budowy': '1998' },
    { LP: 13, Adres: 'Polna 2' } // Rok budowy puste
  ]);

  const { app: ocrApp } = require('../apps/ocr-audytow/server');
  const server = ocrApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${port}/api/ocr/inspect-table`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
    body: JSON.stringify({ excelPath: filePath, family: 'pc' })
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.rowCount, 2);
  const rokBudowy = data.fields.find((f) => f.fieldKey === 'rokBudowy');
  assert.equal(rokBudowy.missingCount, 1);
  assert.equal(rokBudowy.totalRows, 2);
  assert.ok(data.unrecognizedHeaders.includes('Miejscowość'));
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
