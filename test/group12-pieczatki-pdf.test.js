// Testy stemplowania PDF (audyt v1.0.4, P1-5 i P1-6):
// - P1-5: dwa pliki o identycznej oryginalnej nazwie w jednej paczce juz nie
//   nadpisuja siebie nawzajem w wyniku.
// - P1-6: niepoprawny/pusty zakres "wybrane strony" jest bledem, nie cichym
//   sukcesem bez zadnej ostemplowanej strony.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, degrees } = require('../apps/pieczatki-pdf/node_modules/pdf-lib');
const { stampPdf, uniqueOutputPath, normalizeStampOptions, drawPreparedStampOnPage, prepareStamp } = require('../apps/pieczatki-pdf/server');

async function createTestPdf(filePath, pageCount = 2) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([300, 400]);
  await fsp.writeFile(filePath, await doc.save());
}

function textStamp(overrides = {}) {
  return normalizeStampOptions({ stampText: 'PIECZATKA', pageMode: 'all', ...overrides }, 0);
}

test('uniqueOutputPath: kolizja nazw dostaje licznik (2), (3)...', async (t) => {
  const jobDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pieczatki-unique-'));
  t.after(() => fsp.rm(jobDir, { recursive: true, force: true }));

  const first = uniqueOutputPath(jobDir, 'a.pdf');
  assert.equal(first, path.join(jobDir, 'a.pdf'));
  await fsp.writeFile(first, 'x');

  const second = uniqueOutputPath(jobDir, 'a.pdf');
  assert.equal(second, path.join(jobDir, 'a (2).pdf'));
  await fsp.writeFile(second, 'x');

  const third = uniqueOutputPath(jobDir, 'a.pdf');
  assert.equal(third, path.join(jobDir, 'a (3).pdf'));
});

test('stampPdf: dwa pliki o tej samej oryginalnej nazwie w jednej paczce nie nadpisuja sie (audyt P1-5)', async (t) => {
  const uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pieczatki-upload-'));
  const jobDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pieczatki-job-'));
  t.after(async () => {
    await fsp.rm(uploadDir, { recursive: true, force: true });
    await fsp.rm(jobDir, { recursive: true, force: true });
  });

  const pdfA = path.join(uploadDir, 'pierwszy-plik.pdf');
  const pdfB = path.join(uploadDir, 'drugi-plik.pdf');
  await createTestPdf(pdfA, 1);
  await createTestPdf(pdfB, 3);

  const stamps = [textStamp()];
  // Oba pliki maja RÓZNA tresc, ale IDENTYCZNA oryginalna nazwe zgloszona przez
  // przegladarke - to dokladnie scenariusz z audytu (dwa foldery, ta sama nazwa).
  const outA = await stampPdf({ path: pdfA, originalname: 'raport.pdf' }, stamps, jobDir);
  const outB = await stampPdf({ path: pdfB, originalname: 'raport.pdf' }, stamps, jobDir);

  assert.notEqual(outA, outB);
  const docA = await PDFDocument.load(await fsp.readFile(outA));
  const docB = await PDFDocument.load(await fsp.readFile(outB));
  assert.equal(docA.getPageCount(), 1);
  assert.equal(docB.getPageCount(), 3);
});

test('stampPdf: niepoprawny zakres "wybrane strony" rzuca blad zamiast cicho ostemplowac zero stron (audyt P1-6)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pieczatki-badrange-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, 'wejscie.pdf');
  await createTestPdf(pdfPath, 2);

  const stamps = [textStamp({ pageMode: 'custom', customPages: 'x,y,z' })];
  await assert.rejects(
    () => stampPdf({ path: pdfPath, originalname: 'test.pdf' }, stamps, dir),
    /wybrane strony/
  );
});

test('stampPdf: pusty string "wybrane strony" tez rzuca blad (nie tylko calkiem bledny format)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pieczatki-emptyrange-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, 'wejscie.pdf');
  await createTestPdf(pdfPath, 2);

  const stamps = [textStamp({ pageMode: 'custom', customPages: '' })];
  await assert.rejects(
    () => stampPdf({ path: pdfPath, originalname: 'test.pdf' }, stamps, dir),
    /wybrane strony/
  );
});

test('stampPdf: poprawny zakres nadal dziala normalnie (brak regresji)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pieczatki-ok-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, 'wejscie.pdf');
  await createTestPdf(pdfPath, 5);

  const stamps = [textStamp({ pageMode: 'custom', customPages: '1,3-4' })];
  const outPath = await stampPdf({ path: pdfPath, originalname: 'test.pdf' }, stamps, dir);
  const outDoc = await PDFDocument.load(await fsp.readFile(outPath));
  assert.equal(outDoc.getPageCount(), 5);
});

test('drawPreparedStampOnPage: kotwica KAZDEJ linii tekstu stempla zostaje w granicach strony, nawet gdy strona jest obrocona o 90/270 st.', async (t) => {
  // Ten sam blad co byl w apps/drukarka-projekty/src/pdfStamp.js (naprawiony
  // 2026-08-04): centrowanie kazdej linii w poziomie ("Math.max(4,
  // (stampWidth - textWidth) / 2)") dodawalo offset PROSTO do juz-
  // zmapowanego mapped.x/mapped.y w przestrzeni PDF-a, zamiast policzyc
  // pozycje w ukladzie WIZUALNYM i zmapowac na koniec. Dla stron bez rotacji
  // dzialalo to przypadkiem, ale dla stron obroconych przesuwalo stempel w
  // niewlasciwym kierunku (przy 90/270 st. nawet na inna os) - zweryfikowane
  // na realnym pliku (rysunek PDF, strona obrocona 270 st.): pozycja tekstu
  // przed napraw byla wyraznie inna (i mniej dokladna wzgledem yPct/xPct) niz
  // po naprawie.
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.setRotation(degrees(rotation));
    // Tekst musi byc WYRAZNIE wezszy niz stampWidth (30% strony), inaczej
    // offset centrowania jest znikomo maly i test nie odrozni buga od
    // naprawy (patrz realny przypadek z krotkim "TEST" w oryginalnym repro).
    const preparedStamp = await prepareStamp(doc, { text: 'TEST' });
    const opts = normalizeStampOptions({ stampText: 'TEST', xPct: 60, yPct: 80, widthPct: 30, heightPct: 10, fontSize: 20 }, 0);

    const calls = [];
    const originalDrawText = page.drawText.bind(page);
    page.drawText = (text, options) => { calls.push({ text, x: options.x, y: options.y }); return originalDrawText(text, options); };

    drawPreparedStampOnPage(page, preparedStamp, opts);

    assert.ok(calls.length >= 1, `rotacja ${rotation}: powinna byc przynajmniej jedna linia tekstu`);
    for (const call of calls) {
      assert.ok(call.x >= -1 && call.x <= 596, `rotacja ${rotation}: x=${call.x} poza [0,595] dla "${call.text}"`);
      assert.ok(call.y >= -1 && call.y <= 843, `rotacja ${rotation}: y=${call.y} poza [0,842] dla "${call.text}"`);
    }
  }
});
