const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('../apps/ocr-audytow/node_modules/pdf-lib');
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

test('warstwa tekstowa jest wykrywana osobno dla każdej strony', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, 'mixed-text.pdf');
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const textPage = document.addPage([600, 800]);
  textPage.drawText(Array(80).fill('tekst').join(' '), { x: 20, y: 700, size: 8, font, maxWidth: 550 });
  document.addPage([600, 800]);
  await fsp.writeFile(pdfPath, await document.save());

  const { checkTextLayerByPage } = require('../apps/ocr-audytow/src/textLayerCheck');
  const pages = await checkTextLayerByPage(pdfPath);
  assert.deepEqual(pages.map((page) => page.hasTextLayer), [true, false]);
});

test('mieszany PDF wywołuje OCR raz i składa wszystkie trzy strony we właściwej kolejności', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const sourcePdfPath = path.join(dir, 'source.pdf');
  const imagePath = path.join(dir, 'page-002.png');
  const workDir = path.join(dir, 'work');
  const outputPath = path.join(dir, 'final.pdf');
  await createPdf(sourcePdfPath, 3);
  await fsp.writeFile(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  ));

  const textCheckPath = require.resolve('../apps/ocr-audytow/src/textLayerCheck');
  const extractorPath = require.resolve('../apps/ocr-audytow/src/pdfImageExtractor');
  const enginePath = require.resolve('../apps/ocr-audytow/src/documentAiEngine');
  const pipelinePath = require.resolve('../apps/ocr-audytow/src/ocrPipeline');
  const originalCache = new Map([textCheckPath, extractorPath, enginePath, pipelinePath].map((key) => [key, require.cache[key]]));
  let ocrCalls = 0;
  require.cache[textCheckPath] = {
    id: textCheckPath,
    filename: textCheckPath,
    loaded: true,
    exports: {
      checkTextLayerByPage: async () => [
        { pageIndex: 0, hasTextLayer: true, textLength: 500 },
        { pageIndex: 1, hasTextLayer: false, textLength: 0 },
        { pageIndex: 2, hasTextLayer: true, textLength: 500 }
      ]
    }
  };
  require.cache[extractorPath] = {
    id: extractorPath,
    filename: extractorPath,
    loaded: true,
    exports: {
      extractPageImages: async () => ({
        pageCount: 3,
        pages: [
          { pageIndex: 0, imagePath: null, width: 400, height: 600, dpi: 72 },
          { pageIndex: 1, imagePath, width: 1, height: 1, dpi: 72 },
          { pageIndex: 2, imagePath: null, width: 420, height: 620, dpi: 72 }
        ]
      })
    }
  };
  require.cache[enginePath] = {
    id: enginePath,
    filename: enginePath,
    loaded: true,
    exports: {
      isConfigured: () => true,
      ocrImage: async () => {
        ocrCalls += 1;
        return { text: '', words: [], formFields: [], tables: [], visualElements: [] };
      }
    }
  };
  delete require.cache[pipelinePath];
  t.after(() => {
    for (const [key, value] of originalCache) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  });

  const { analyzeDocument, finalizeSplit } = require(pipelinePath);
  const result = await analyzeDocument({ sourcePdfPath, workDir });
  assert.equal(ocrCalls, 1);
  assert.deepEqual(result.pages.map((page) => page.ocrOutputIndex), [null, 0, null]);
  await finalizeSplit({
    sourcePdfPath,
    ocrPdfPath: result.ocrPdfPath,
    pages: result.pages,
    blocks: [{ startPage: 0, endPage: 2 }],
    outPaths: [outputPath]
  });
  const finalDocument = await PDFDocument.load(await fsp.readFile(outputPath));
  assert.equal(finalDocument.getPageCount(), 3);
});

test('uszkodzony obraz strony OCR: finalny dokument dostaje oryginalna strone, nie biala (audyt v1.0.4, P0-7)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const sourcePdfPath = path.join(dir, 'source.pdf');
  const goodImagePath = path.join(dir, 'good.png');
  const corruptImagePath = path.join(dir, 'corrupt.png');
  const workDir = path.join(dir, 'work');
  const outputPath = path.join(dir, 'final.pdf');
  // Strona 0: 400x600, strona 1: 410x610 (patrz createPdf) - realne, rozne od
  // rozmiaru "mockowanego" obrazu OCR ponizej, zeby dalo sie jednoznacznie
  // sprawdzic, ktora strona trafila do finalnego pliku.
  await createPdf(sourcePdfPath, 2);
  await fsp.writeFile(goodImagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  ));
  // Naglowek PNG jest tu celowo uszkodzony (losowe bajty) - pdf-lib's
  // embedPng() musi sie na tym wywalic, symulujac realny przypadek z
  // 2026-07-22 (fizycznie uszkodzone dane obrazu na jednej stronie pliku).
  await fsp.writeFile(corruptImagePath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));

  const textCheckPath = require.resolve('../apps/ocr-audytow/src/textLayerCheck');
  const extractorPath = require.resolve('../apps/ocr-audytow/src/pdfImageExtractor');
  const enginePath = require.resolve('../apps/ocr-audytow/src/documentAiEngine');
  const pipelinePath = require.resolve('../apps/ocr-audytow/src/ocrPipeline');
  const originalCache = new Map([textCheckPath, extractorPath, enginePath, pipelinePath].map((key) => [key, require.cache[key]]));
  require.cache[textCheckPath] = {
    id: textCheckPath, filename: textCheckPath, loaded: true,
    exports: { checkTextLayerByPage: async () => [
      { pageIndex: 0, hasTextLayer: false, textLength: 0 },
      { pageIndex: 1, hasTextLayer: false, textLength: 0 }
    ] }
  };
  require.cache[extractorPath] = {
    id: extractorPath, filename: extractorPath, loaded: true,
    exports: { extractPageImages: async () => ({
      pageCount: 2,
      pages: [
        { pageIndex: 0, imagePath: goodImagePath, width: 999, height: 999, dpi: 72 },
        { pageIndex: 1, imagePath: corruptImagePath, width: 999, height: 999, dpi: 72 }
      ]
    }) }
  };
  require.cache[enginePath] = {
    id: enginePath, filename: enginePath, loaded: true,
    exports: {
      isConfigured: () => true,
      ocrImage: async () => ({ text: '', words: [], formFields: [], tables: [], visualElements: [] })
    }
  };
  delete require.cache[pipelinePath];
  t.after(() => {
    for (const [key, value] of originalCache) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  });

  const { analyzeDocument, finalizeSplit } = require(pipelinePath);
  const result = await analyzeDocument({ sourcePdfPath, workDir });

  // Strona 0 (obraz OK) zachowuje przypisany ocrOutputIndex; strona 1 (obraz
  // uszkodzony) MUSI zostac cofnieta na null, zeby finalizeSplit nie wciagnal
  // bialej strony z ocrDoc.
  assert.equal(result.pages[0].ocrOutputIndex, 0);
  assert.equal(result.pages[1].ocrOutputIndex, null);
  assert.ok(result.warnings.some((w) => /nie udalo sie osadzic obrazu/.test(w)));

  await finalizeSplit({
    sourcePdfPath,
    ocrPdfPath: result.ocrPdfPath,
    pages: result.pages,
    blocks: [{ startPage: 0, endPage: 1 }],
    outPaths: [outputPath]
  });

  const finalDocument = await PDFDocument.load(await fsp.readFile(outputPath));
  assert.equal(finalDocument.getPageCount(), 2);
  // Strona 1 w finalnym dokumencie musi miec wymiary ORYGINALNEJ strony
  // zrodlowej (410x610, patrz createPdf), NIE wymiary "mockowanego" obrazu
  // OCR (999x999) - to potwierdza, ze zostal skopiowany oryginal, a nie
  // biala strona z ocrDoc.
  const secondPage = finalDocument.getPages()[1];
  assert.equal(secondPage.getWidth(), 410);
  assert.equal(secondPage.getHeight(), 610);
});

test('dedupeOutPaths: identyczna etykieta dwoch blokow nie nadpisuje pliku (audyt v1.0.4, OCR ustalenie 7)', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { dedupeOutPaths } = require('../apps/ocr-audytow/server');

  const paths = [
    path.join(dir, 'audyt - Kowalski (OCR).pdf'),
    path.join(dir, 'audyt - Kowalski (OCR).pdf'),
    path.join(dir, 'audyt - Kowalski (OCR).pdf')
  ];
  const deduped = dedupeOutPaths(paths);
  assert.equal(new Set(deduped).size, 3, 'wszystkie sciezki musza byc unikalne');
  assert.equal(deduped[0], paths[0]);
  assert.equal(deduped[1], path.join(dir, 'audyt - Kowalski (OCR) (2).pdf'));
  assert.equal(deduped[2], path.join(dir, 'audyt - Kowalski (OCR) (3).pdf'));

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

test('globalny semafor OCR nie przekracza pięciu równoległych zadań', async () => {
  const { runWithGlobalOcrLimit } = require('../apps/ocr-audytow/src/ocrPipeline');
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 20 }, () => runWithGlobalOcrLimit(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  })));
  assert.ok(maximum <= 5, `maksymalna równoległość: ${maximum}`);
});

test('limit paczki jest sprawdzany przed rozpoczęciem płatnego OCR', () => {
  const { validateOcrBatchInspections } = require('../apps/ocr-audytow/src/ocrLimits');
  let paidOcrCalls = 0;
  assert.throws(() => {
    validateOcrBatchInspections([
      {
        originalName: 'za-duzy.pdf',
        inspection: {
          pageCount: 61,
          pages: Array.from({ length: 61 }, (_, pageIndex) => ({ pageIndex, hasTextLayer: false }))
        }
      }
    ], { maxPagesPerFile: 60, maxTotalPages: 300 });
    paidOcrCalls += 1;
  }, /Limit jednego pliku/);
  assert.equal(paidOcrCalls, 0);
});

test('puste pole pozostaje nierozstrzygnięte, a MIME wynika z formatu obrazu', () => {
  const { toFieldResult } = require('../apps/ocr-audytow/src/fieldExtraction');
  const { resolveMimeType } = require('../apps/ocr-audytow/src/documentAiEngine');
  assert.deepEqual(
    { needsReview: toFieldResult(null, 0, 'text').needsReview, resolved: toFieldResult(null, 0, 'text').resolved },
    { needsReview: true, resolved: false }
  );
  assert.equal(resolveMimeType('scan.jpg'), 'image/jpeg');
  assert.equal(resolveMimeType('scan.png'), 'image/png');
  assert.equal(resolveMimeType('scan.tiff'), 'image/tiff');
  assert.throws(() => resolveMimeType('scan.jp2'), /nie obsluguje/);
});

test('niejednoznaczne dopasowanie wzoru nie wybiera pierwszego pliku', () => {
  const { matchTemplate } = require('../apps/ocr-audytow/src/templateEngine');
  const pages = [{ ocrText: 'GMINA TESTOWA PROTOKOL' }];
  const block = { startPage: 0, endPage: 0 };
  const templates = [
    { id: 'a', headerPattern: 'GMINA TESTOWA' },
    { id: 'b', headerPattern: 'GMINA TESTOWA' }
  ];
  assert.equal(matchTemplate(pages, block, templates), null);
});

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

test('klient używa wspólnej walidacji odpowiedzi przed zmianą kolejki', async () => {
  const source = await fsp.readFile(path.join(appRoot, 'public', 'app.js'), 'utf8');
  assert.match(source, /await apiJson\('\/api\/ocr\/resolve-field'/);
  assert.match(source, /item\.field\.resolved = true;\s+queuePos \+= 1;/);
  assert.doesNotMatch(source, /await fetch\('\/api\/ocr\/resolve-field'/);
  assert.match(source, /EXCEL_ALREADY_EXISTS/);
});

// =====================================================================
// Ekran "OCR zablokowany" - reczne wgranie klucza zamiast wbudowanego w
// instalator sekretu (audyt rozdz. 22: nie wymaga prywatnego repo, dziala
// per-komputer, przezywa aktualizacje - patrz lib/ocrConfigMigration.js).
// =====================================================================

test('POST /api/ocr/setup-credentials: poprawny klucz odblokowuje OCR, /api/health od razu widzi zmiane', async (t) => {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousOcrEnv = ['OCR_DOCAI_KEY_FILE', 'OCR_DOCAI_PROJECT_ID', 'OCR_DOCAI_LOCATION', 'OCR_DOCAI_PROCESSOR_ID']
    .map(key => [key, process.env[key]]);
  const localAppData = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-ocr-http-'));
  process.env.LOCALAPPDATA = localAppData;
  // Srodowisko ma pierwszenstwo przed plikiem uzytkownika (patrz kolejnosc w
  // documentAiEngine.js#getConfiguration) - musimy je wyczyscic, zeby ten
  // test faktycznie sprawdzal sciezke z pliku, ktora testujemy, a nie
  // przypadkowo zaliczal dzieki (byc moze niepelnym) zmiennym z otoczenia.
  for (const [key] of previousOcrEnv) delete process.env[key];
  // documentAiEngine.js oblicza USER_CONFIG_PATH RAZ, jako stala modulu, przy
  // pierwszym require() - nie na nowo przy kazdym wywolaniu. Ten modul mogl
  // juz zostac zaladowany wczesniej w tym samym procesie testow (np. przez
  // test "resolveMimeType" wyzej) z PRAWDZIWYM LOCALAPPDATA sprzed override -
  // trzeba wyczyscic cache obu modulow, zeby swiezy require() faktycznie
  // przeliczyl sciezke z NOWYM process.env.LOCALAPPDATA ustawionym powyzej.
  delete require.cache[require.resolve('../apps/ocr-audytow/server')];
  delete require.cache[require.resolve('../apps/ocr-audytow/src/documentAiEngine')];
  t.after(() => {
    process.env.LOCALAPPDATA = previousLocalAppData;
    for (const [key, value] of previousOcrEnv) { if (value !== undefined) process.env[key] = value; }
    delete require.cache[require.resolve('../apps/ocr-audytow/server')];
    delete require.cache[require.resolve('../apps/ocr-audytow/src/documentAiEngine')];
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

  const fakeKey = { type: 'service_account', project_id: 'test-projekt-http', client_email: 'a@b.iam.gserviceaccount.com', private_key: 'FAKE-NIE-PRAWDZIWY-KLUCZ' };
  const formData = new FormData();
  formData.append('keyFile', new Blob([JSON.stringify(fakeKey)], { type: 'application/json' }), 'service-account.json');
  formData.append('location', 'eu');
  formData.append('processorId', 'proc999');

  const res = await fetch(`http://127.0.0.1:${port}/api/ocr/setup-credentials`, {
    method: 'POST',
    headers: { 'X-Scyzoryk-Request': '1' },
    body: formData
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(data, { ok: true, projectId: 'test-projekt-http', location: 'eu', processorId: 'proc999' });

  const after = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(after.ocrConfigured, true, 'juz uruchomiony proces musi widziec nowa konfiguracje bez restartu (czytana z dysku przy kazdym wywolaniu)');
});

test('POST /api/ocr/setup-credentials: bez naglowka X-Scyzoryk-Request dostaje 403 (ta sama ochrona co reszta mutujacych tras)', async (t) => {
  const { app: ocrApp } = require('../apps/ocr-audytow/server');
  const server = ocrApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${port}/api/ocr/setup-credentials`, { method: 'POST' });
  assert.equal(res.status, 403);
});
