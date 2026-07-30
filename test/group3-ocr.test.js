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
