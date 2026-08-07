const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('../apps/drukarka-projekty/node_modules/pdf-lib');
const { buildSaveAsPdfOutputs, buildQueueFromGroups, buildQueueItem, SAVE_AS_PDF_OUTPUT_DIR } = require('../apps/drukarka-projekty/server');

async function createTestPdf(filePath, pageCount = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([300, 400]);
  await fsp.writeFile(filePath, await doc.save());
}

// =====================================================================
// "Zapisz jako PDF" (patrz /api/print, SAVE_AS_PDF_SENTINEL) - w
// przeciwienstwie do buildQueueFromGroups (laczy tylko SASIADUJACE PDF-y w
// obrebie jednej grupy, bo tam liczy sie duplex fizycznej drukarki),
// buildSaveAsPdfOutputs ma scalic CALA kolejke w jeden plik NA ADRES.
// =====================================================================

test('buildSaveAsPdfOutputs: laczy wszystkie pliki jednego adresu (tej samej etykiety) w jeden PDF, z suma stron', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-saveaspdf-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(SAVE_AS_PDF_OUTPUT_DIR, { recursive: true, force: true }).catch(() => {}));

  const pdfA = path.join(root, 'a.pdf');
  const pdfB = path.join(root, 'b.pdf');
  await createTestPdf(pdfA, 2);
  await createTestPdf(pdfB, 3);

  const queue = [
    buildQueueItem(pdfA, '1 - ul. Testowa 1'),
    buildQueueItem(pdfB, '1 - ul. Testowa 1')
  ];

  const fakeReq = { sid: 'test-sid-saveaspdf-1' };
  const result = await buildSaveAsPdfOutputs(fakeReq, queue);

  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].label, '1 - ul. Testowa 1');
  assert.ok(fs.existsSync(result.outputs[0].path));
  assert.ok(path.resolve(result.outputs[0].path).startsWith(path.resolve(SAVE_AS_PDF_OUTPUT_DIR)));

  const merged = await PDFDocument.load(await fsp.readFile(result.outputs[0].path));
  // Zaden pusty odstep miedzy plikami tego samego adresu nie jest dodawany
  // (to nie jest fizyczny druk/duplex) - suma stron = 2 + 3, bez dopelnien.
  assert.equal(merged.getPageCount(), 5);
});

test('buildSaveAsPdfOutputs: NIE-sasiadujace pozycje o roznej etykiecie tworza osobne pliki, w kolejnosci grup', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-saveaspdf-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(SAVE_AS_PDF_OUTPUT_DIR, { recursive: true, force: true }).catch(() => {}));

  const pdfA = path.join(root, 'a.pdf');
  const pdfB = path.join(root, 'b.pdf');
  await createTestPdf(pdfA, 1);
  await createTestPdf(pdfB, 1);

  const queue = [
    buildQueueItem(pdfA, 'Adres 1'),
    buildQueueItem(pdfB, 'Adres 2')
  ];

  const fakeReq = { sid: 'test-sid-saveaspdf-2' };
  const result = await buildSaveAsPdfOutputs(fakeReq, queue);

  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 2);
  assert.deepEqual(result.outputs.map(o => o.label), ['Adres 1', 'Adres 2']);
});

test('buildSaveAsPdfOutputs: dwie grupy o identycznej etykiecie NIE nadpisuja sie nawzajem (unikalna nazwa pliku)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-saveaspdf-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(SAVE_AS_PDF_OUTPUT_DIR, { recursive: true, force: true }).catch(() => {}));

  const pdfA = path.join(root, 'a.pdf');
  const pdfB = path.join(root, 'b.pdf');
  await createTestPdf(pdfA, 1);
  await createTestPdf(pdfB, 1);

  // Dwie grupy z tym samym adresem, przedzielone innym adresem - realny
  // przypadek, gdyby ten sam adres zostal dodany do kolejki dwa razy osobno.
  const queue = [
    buildQueueItem(pdfA, 'Adres X'),
    buildQueueItem(pdfB, 'Adres Y'),
    { ...buildQueueItem(pdfA, 'Adres X'), id: 'inny-id' }
  ];

  const fakeReq = { sid: 'test-sid-saveaspdf-3' };
  const result = await buildSaveAsPdfOutputs(fakeReq, queue);

  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 3);
  const paths = result.outputs.map(o => path.basename(o.path));
  assert.equal(new Set(paths).size, 3, `nazwy plikow powinny byc unikalne, dostalem: ${paths.join(', ')}`);
  assert.ok(paths.some(p => p.includes('(2)')), 'druga grupa "Adres X" powinna dostac sufiks (2)');
});

test('buildSaveAsPdfOutputs: dokumenty jednego adresu z ROZNYMI wlasnymi etykietami (np. "adres > karta katalogowa") nadal ladują w JEDNYM pliku (real bug zlapany live-testem: grupowanie musi isc po groupLabel z buildQueueFromGroups, nie po etykiecie pojedynczego dokumentu)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-saveaspdf-real-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(SAVE_AS_PDF_OUTPUT_DIR, { recursive: true, force: true }).catch(() => {}));

  const pdfA = path.join(root, 'a.pdf');
  const pdfB = path.join(root, 'b.pdf');
  await createTestPdf(pdfA, 1);
  await createTestPdf(pdfB, 1);

  // Naprawde tak jak buduje to public/app.js#buildPendingGroups: kazdy
  // dokument w grupie ma WLASNA, unikalna etykiete (adres + nazwa dokumentu),
  // rozna od group.label (samego adresu).
  const groups = [{
    label: '1 - ul. Testowa 1',
    items: [
      { fullPath: pdfA, label: '1 - ul. Testowa 1 › karta katalogowa' },
      { fullPath: pdfB, label: '1 - ul. Testowa 1 › zgoda' }
    ]
  }];

  const fakeReq = { sid: 'test-sid-saveaspdf-real', session: { lastBaseFolder: root } };
  const { built, missing } = await buildQueueFromGroups(fakeReq, groups);
  assert.equal(missing.length, 0);
  // Sasiadujace PDF-y sa juz scalone przez buildQueueFromGroups (run.length >= 2)
  // w JEDEN queue item - ale to i tak musi niesc groupLabel = "1 - ul. Testowa 1".
  assert.equal(built.length, 1);
  assert.equal(built[0].groupLabel, '1 - ul. Testowa 1');

  const result = await buildSaveAsPdfOutputs(fakeReq, built);
  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].label, '1 - ul. Testowa 1');
});

test('buildSaveAsPdfOutputs: niedozwolone znaki w etykiecie adresu nie tworza nieprawidlowej nazwy pliku', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-saveaspdf-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(SAVE_AS_PDF_OUTPUT_DIR, { recursive: true, force: true }).catch(() => {}));

  const pdfA = path.join(root, 'a.pdf');
  await createTestPdf(pdfA, 1);

  const queue = [buildQueueItem(pdfA, 'ul. Dluga/Krzywa: 5 "obok" * sklepu')];
  const fakeReq = { sid: 'test-sid-saveaspdf-4' };
  const result = await buildSaveAsPdfOutputs(fakeReq, queue);

  assert.equal(result.ok, true);
  const fileName = path.basename(result.outputs[0].path);
  assert.doesNotMatch(fileName, /[<>:"/\\|?*]/, `nazwa pliku "${fileName}" zawiera niedozwolony znak systemu plikow`);
});
