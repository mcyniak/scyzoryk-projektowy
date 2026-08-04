const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, degrees, StandardFonts } = require('../apps/drukarka-projekty/node_modules/pdf-lib');
const pdfStamp = require('../apps/drukarka-projekty/src/pdfStamp');
const { buildQueueFromGroups, applyPowykonawczaTransformToQueue, buildQueueItem } = require('../apps/drukarka-projekty/server');

async function createTestPdf(filePath, { rotate } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  if (rotate) page.setRotation(degrees(rotate));
  await fsp.writeFile(filePath, await doc.save());
}

test('pdfStamp: visualPageSize zamienia szerokosc/wysokosc tylko dla obrotu 90/270 (strony rysunkow "bokiem")', () => {
  const page90 = { getRotation: () => ({ angle: 90 }), getWidth: () => 300, getHeight: () => 400 };
  const page0 = { getRotation: () => ({ angle: 0 }), getWidth: () => 300, getHeight: () => 400 };
  const page270 = { getRotation: () => ({ angle: 270 }), getWidth: () => 300, getHeight: () => 400 };
  assert.deepEqual(pdfStamp.visualPageSize(page0), { width: 300, height: 400, rotation: 0, pageWidth: 300, pageHeight: 400 });
  assert.deepEqual(pdfStamp.visualPageSize(page90), { width: 400, height: 300, rotation: 90, pageWidth: 300, pageHeight: 400 });
  assert.deepEqual(pdfStamp.visualPageSize(page270), { width: 400, height: 300, rotation: 270, pageWidth: 300, pageHeight: 400 });
});

test('pdfStamp: mapVisualBottomLeftToPdf odwzorowuje prawy gorny rog "wizualny" na wlasciwy rog PDF-a niezaleznie od obrotu', () => {
  // Strona "bokiem" (90 st.) - stempel majacy wyladowac w prawym-gornym rogu
  // WIDOKU musi trafic w rog PDF-a wyliczony wzgledem obrotu, nie w naiwny
  // (szerokosc, wysokosc) nieobroconej strony.
  const page90 = { getRotation: () => ({ angle: 90 }), getWidth: () => 300, getHeight: () => 400 };
  const mapped = pdfStamp.mapVisualBottomLeftToPdf(page90, 0, 0);
  assert.deepEqual(mapped, { x: 300, y: 0, rotation: 90 });

  const page0 = { getRotation: () => ({ angle: 0 }), getWidth: () => 300, getHeight: () => 400 };
  assert.deepEqual(pdfStamp.mapVisualBottomLeftToPdf(page0, 10, 20), { x: 10, y: 20, rotation: 0 });
});

test('pdfStamp: drawStampOnPage trzyma kotwice KAZDEJ linii tekstu w granicach strony, nawet gdy strona jest obrocona o 90/270 st.', async (t) => {
  // Realny blad zlapany na prawdziwym rysunku PDF (270 st.): wyliczanie
  // pozycji kazdej linii centrowalo tekst dodajac offset PROSTO do juz-
  // zmapowanego mapped.x/mapped.y w przestrzeni PDF-a. Dla stron bez rotacji
  // to dziala (przestrzen wizualna == przestrzen PDF-a), ale dla stron
  // obroconych "prawo"/"dol" w widoku wizualnym NIE sa tym samym co +x/-y w
  // PDF-ie - offset szedl w zlym kierunku i przy szerszym tekscie wypychal
  // caly stempel poza widoczna strone (niewidoczny, mimo poprawnej pozycji
  // samego boxu). Test trzyma prawdziwy rozmiar strony A4 (595x842), na
  // ktorym blad byl zaobserwowany.
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.setRotation(degrees(rotation));
    const font = await doc.embedFont(StandardFonts.HelveticaBold);

    const calls = [];
    const originalDrawText = page.drawText.bind(page);
    page.drawText = (text, options) => { calls.push({ text, x: options.x, y: options.y }); return originalDrawText(text, options); };

    pdfStamp.drawStampOnPage(page, font);

    assert.equal(calls.length, 2, `rotacja ${rotation}: powinny byc 2 linie tekstu`);
    for (const call of calls) {
      assert.ok(call.x >= 0 && call.x <= 595, `rotacja ${rotation}: x=${call.x} poza [0,595] dla "${call.text}"`);
      assert.ok(call.y >= 0 && call.y <= 842, `rotacja ${rotation}: y=${call.y} poza [0,842] dla "${call.text}"`);
    }
  }
});

test('pdfStamp: stampAllPages ostemplowuje kazda strone (rowna i obrocona o 90) bez zmiany liczby/rozmiaru stron', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-stamp-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const filePath = path.join(root, 'test.pdf');
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const rotated = doc.addPage([300, 400]);
  rotated.setRotation(degrees(90));
  await fsp.writeFile(filePath, await doc.save());
  const beforeSize = (await fsp.stat(filePath)).size;

  await pdfStamp.stampAllPages(filePath);

  const afterBytes = await fsp.readFile(filePath);
  const afterDoc = await PDFDocument.load(afterBytes);
  assert.equal(afterDoc.getPageCount(), 2);
  assert.equal(afterDoc.getPage(0).getRotation().angle, 0);
  assert.equal(afterDoc.getPage(1).getRotation().angle, 90);
  assert.equal(afterDoc.getPage(0).getWidth(), 300);
  assert.equal(afterDoc.getPage(0).getHeight(), 400);
  // Stempel dopisuje font + operatory tekstu - plik musi wiec urosnac.
  assert.ok(afterBytes.length > beforeSize, 'plik po stemplowaniu powinien byc wiekszy (dodany font/tekst)');
});

test('drukarka-projekty: applyPowykonawczaTransformToQueue kopiuje oryginal klienta przed stemplowaniem, nigdy nie modyfikuje go w miejscu', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-orig-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const originalPath = path.join(root, 'rysunek-klienta.pdf');
  await createTestPdf(originalPath);
  const originalBytesBefore = await fsp.readFile(originalPath);

  const item = buildQueueItem(originalPath, 'Rysunek');
  const fakeReq = { sid: 'test-sid-orig' };
  await applyPowykonawczaTransformToQueue(fakeReq, [item]);

  // Oryginal klienta musi zostac bit-identyczny - stempel poszedl na kopii.
  const originalBytesAfter = await fsp.readFile(originalPath);
  assert.deepEqual(originalBytesAfter, originalBytesBefore);

  assert.notEqual(item.path, originalPath);
  assert.equal(path.basename(path.dirname(item.path)), 'powykonawcza');
  assert.ok(fs.existsSync(item.path));
  const stampedDoc = await PDFDocument.load(await fsp.readFile(item.path));
  assert.equal(stampedDoc.getPageCount(), 1);
});

test('drukarka-projekty: applyPowykonawczaTransformToQueue stempluje juz-scalone PDF-y w miejscu (sciezka sie nie zmienia)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-merged-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const pdfA = path.join(root, 'a.pdf');
  const pdfB = path.join(root, 'b.pdf');
  await createTestPdf(pdfA);
  await createTestPdf(pdfB);

  const fakeReq = { session: { lastBaseFolder: root }, sid: 'test-sid-merged' };
  const groups = [{ label: 'Adres', items: [{ fullPath: pdfA }, { fullPath: pdfB }] }];
  const { built } = await buildQueueFromGroups(fakeReq, groups);
  assert.equal(built.length, 1);
  assert.equal(path.basename(path.dirname(built[0].path)), 'merged');
  const mergedPathBefore = built[0].path;

  await applyPowykonawczaTransformToQueue(fakeReq, built);

  // Plik scalony jest juz tymczasowy - stemplowanie w miejscu, bez kolejnej kopii.
  assert.equal(built[0].path, mergedPathBefore);
  const stampedDoc = await PDFDocument.load(await fsp.readFile(built[0].path));
  assert.equal(stampedDoc.getPageCount(), 2);
});

test('drukarka-projekty: applyPowykonawczaTransformToQueue nie dotyka plikow, ktorych nie da sie ostemplowac (nie-PDF, nie-DOCX)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-other-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const txtPath = path.join(root, 'notatka.txt');
  await fsp.writeFile(txtPath, 'zawartosc');
  const item = buildQueueItem(txtPath, 'Notatka');
  const fakeReq = { sid: 'test-sid-other' };
  await applyPowykonawczaTransformToQueue(fakeReq, [item]);

  assert.equal(item.path, txtPath);
  assert.equal(await fsp.readFile(txtPath, 'utf8'), 'zawartosc');
});

test('drukarka-projekty: checkbox "dokumentacja powykonawcza" jest osobny od /api/wm/scan i podlaczony do /api/print', async () => {
  const server = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'server.js'), 'utf8');
  const html = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'public', 'index.html'), 'utf8');
  const app = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'public', 'app.js'), 'utf8');

  // Nazwa flagi celowo inna niz req.body.powykonawczy z /api/wm/scan (tam
  // wybiera wariant strony tytulowej WM/dok.pod - inna funkcja).
  assert.match(server, /Boolean\(req\.body\?\.stampPowykonawcza\)/);
  assert.match(server, /await applyPowykonawczaTransformToQueue\(req, session\.queue\)/);
  assert.match(html, /id="stampPowykonawczaCheckbox"/);
  assert.match(app, /stampPowykonawcza: \$\("stampPowykonawczaCheckbox"\)\.checked/);

  // Konwersja DOCX->PDF musi uzywac nie-detached spawn (bezpieczny wobec
  // bledu Windows/Node: detached:true zawsze zglasza kod wyjscia 0).
  assert.match(server, /DOCX_TO_PDF_SCRIPT/);
  assert.doesNotMatch(server, /DOCX_TO_PDF_SCRIPT[\s\S]{0,400}detached:\s*true/);
});
