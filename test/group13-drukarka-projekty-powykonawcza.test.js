const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, degrees, StandardFonts } = require('../apps/drukarka-projekty/node_modules/pdf-lib');
const pdfStamp = require('../apps/drukarka-projekty/src/pdfStamp');
const { app, buildQueueFromGroups, prepareStampedQueue, buildQueueItem, isMergedFile } = require('../apps/drukarka-projekty/server');
const { withPrintLease } = require('../lib/printCoordinator');
const printService = require('../lib/printing');

async function countTextOccurrences(pdfBytes, needle) {
  const pdfjsUrl = 'file:///' + path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs').split(path.sep).join('/');
  const pdfjsLib = await import(pdfjsUrl);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), disableFontFace: true }).promise;
  let count = 0;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    for (const item of textContent.items) {
      if (item.str && item.str.includes(needle)) count += 1;
    }
  }
  return count;
}

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

// =====================================================================
// Audyt v1.0.8, Priorytet 1: prepareStampedQueue (dawniej
// applyPowykonawczaTransformToQueue) jest teraz operacja WSZYSTKO ALBO NIC -
// zaden blad pojedynczego pliku nie moze skoncyzc sie mieszana paczka
// (czesc ze stemplem, czesc bez), ktora mimo to idzie do druku.
// =====================================================================

test('prepareStampedQueue: kopiuje KAZDY plik (rowniez juz-scalony PDF) do NOWEGO katalogu, nigdy nie modyfikuje zrodla w miejscu', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-orig-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const originalPath = path.join(root, 'rysunek-klienta.pdf');
  await createTestPdf(originalPath);
  const originalBytesBefore = await fsp.readFile(originalPath);

  const item = buildQueueItem(originalPath, 'Rysunek');
  const fakeReq = { sid: 'test-sid-orig' };
  const result = await prepareStampedQueue(fakeReq, [item]);
  t.after(() => { if (result.opDir) fs.rmSync(result.opDir, { recursive: true, force: true }); });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // Oryginal klienta musi zostac bit-identyczny - stempel poszedl na kopii.
  const originalBytesAfter = await fsp.readFile(originalPath);
  assert.deepEqual(originalBytesAfter, originalBytesBefore);
  // Wejsciowy item (i cala wejsciowa tablica) NIE sa mutowane - to jest
  // podstawa bezpieczenstwa ponowien (P2): kazde wywolanie startuje od
  // niezmienionego source, nigdy od wyniku poprzedniej proby.
  assert.equal(item.path, originalPath);

  const resultItem = result.items[0];
  assert.notEqual(resultItem.path, originalPath);
  assert.ok(fs.existsSync(resultItem.path));
  const stampedDoc = await PDFDocument.load(await fsp.readFile(resultItem.path));
  assert.equal(stampedDoc.getPageCount(), 1);
});

test('prepareStampedQueue: blad stemplowania JEDNEGO pliku PDF blokuje CALA paczke - zaden plik nie jest gotowy do druku', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-stampfail-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const goodPath = path.join(root, 'dobry.pdf');
  const badPath = path.join(root, 'uszkodzony.pdf');
  await createTestPdf(goodPath);
  await fsp.writeFile(badPath, 'to-nie-jest-prawdziwy-pdf'); // stampAllPages rzuci przy PDFDocument.load

  const goodBytesBefore = await fsp.readFile(goodPath);
  const badBytesBefore = await fsp.readFile(badPath);

  const items = [buildQueueItem(goodPath, 'Dobry'), buildQueueItem(badPath, 'Uszkodzony')];
  const fakeReq = { sid: 'test-sid-stampfail' };
  const result = await prepareStampedQueue(fakeReq, items);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.label === 'Uszkodzony' && e.stage === 'stemplowanie'));
  // Oryginaly (OBA - takze ten, ktory sam w sobie by sie udal) zostaja
  // nietkniete, bo caly druk jest odrzucony.
  assert.deepEqual(await fsp.readFile(goodPath), goodBytesBefore);
  assert.deepEqual(await fsp.readFile(badPath), badBytesBefore);
  // Katalog roboczy tej (nieudanej) proby zostaje w calosci usuniety.
  const opDirs = fs.readdirSync(path.join(require('../lib/appPaths').getAppDataDir('drukarka-projekty'), 'data', 'powykonawcza'));
  for (const dirName of opDirs) {
    assert.ok(!dirName.includes('test-sid-stampfail'), `katalog roboczy nieudanej proby powinien zostac usuniety: ${dirName}`);
  }
});

test('prepareStampedQueue: blad konwersji JEDNEGO DOCX blokuje CALA paczke (inne pliki tez sie nie stempluja)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-docxfail-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const goodPath = path.join(root, 'dobry.pdf');
  await createTestPdf(goodPath);
  const goodBytesBefore = await fsp.readFile(goodPath);

  // ".docx", ktorego Word COM nie jest w stanie otworzyc (atrapa, nie
  // prawdziwy plik Worda) - symuluje "nie da sie otworzyc" z audytu bez
  // realnego zaleznienia od tego, czy maszyna testowa ma Worda.
  const docxPath = path.join(root, 'zly.docx');
  await fsp.writeFile(docxPath, 'to-nie-jest-prawdziwy-docx');

  const items = [buildQueueItem(goodPath, 'Dobry'), buildQueueItem(docxPath, 'Zly DOCX')];
  const fakeReq = { sid: 'test-sid-docxfail' };
  const result = await prepareStampedQueue(fakeReq, items);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.label === 'Zly DOCX' && e.stage === 'konwersja DOCX->PDF (Word)'), JSON.stringify(result.errors));
  assert.deepEqual(await fsp.readFile(goodPath), goodBytesBefore);
});

test('prepareStampedQueue: nieobslugiwany format (nie-PDF, nie-DOCX) blokuje CALA paczke z czytelnym bledem', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-other-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const goodPath = path.join(root, 'dobry.pdf');
  await createTestPdf(goodPath);
  const txtPath = path.join(root, 'notatka.txt');
  await fsp.writeFile(txtPath, 'zawartosc');

  const items = [buildQueueItem(goodPath, 'Dobry'), buildQueueItem(txtPath, 'Notatka')];
  const fakeReq = { sid: 'test-sid-format' };
  const result = await prepareStampedQueue(fakeReq, items);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.label === 'Notatka' && e.stage === 'format'));
  assert.equal(await fsp.readFile(txtPath, 'utf8'), 'zawartosc');
});

test('prepareStampedQueue: prawidlowa paczka (same PDF-y) dziala normalnie - kazdy plik ostemplowany, brak bledow', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-powyk-ok-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const pathA = path.join(root, 'a.pdf');
  const pathB = path.join(root, 'b.pdf');
  await createTestPdf(pathA);
  await createTestPdf(pathB);

  const items = [buildQueueItem(pathA, 'A'), buildQueueItem(pathB, 'B')];
  const fakeReq = { sid: 'test-sid-ok' };
  const result = await prepareStampedQueue(fakeReq, items);
  t.after(() => { if (result.opDir) fs.rmSync(result.opDir, { recursive: true, force: true }); });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  for (const resultItem of result.items) {
    assert.ok(isMergedFile(resultItem.path), 'plik roboczy powinien lezec w MERGED_DIR/POWYKONAWCZA_DIR (do sprzatania)');
    const doc = await PDFDocument.load(await fsp.readFile(resultItem.path));
    assert.equal(doc.getPageCount(), 1);
  }
});

test('drukarka-projekty: checkbox "dokumentacja powykonawcza" jest osobny od /api/wm/scan i podlaczony do /api/print, wszystko-albo-nic PRZED withPrintLease', async () => {
  const serverSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'server.js'), 'utf8');
  const html = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'public', 'index.html'), 'utf8');
  const appJsSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'public', 'app.js'), 'utf8');

  // Nazwa flagi celowo inna niz req.body.powykonawczy z /api/wm/scan (tam
  // wybiera wariant strony tytulowej WM/dok.pod - inna funkcja).
  assert.match(serverSource, /Boolean\(req\.body\?\.stampPowykonawcza\)\s*&&\s*!session\.queuePowykonawczaDone/);
  assert.match(serverSource, /const prepared = await prepareStampedQueue\(req, session\.queue\)/);
  assert.match(serverSource, /session\.queuePowykonawczaDone = true/);
  assert.match(html, /id="stampPowykonawczaCheckbox"/);
  assert.match(appJsSource, /stampPowykonawcza: \$\("stampPowykonawczaCheckbox"\)\.checked/);

  // P1: przygotowanie (prepareStampedQueue) musi nastapic PRZED withPrintLease
  // w kodzie /api/print - kolejnosc w zrodle jest tu bezposrednim dowodem,
  // ze druk nie moze ruszyc przed pelnym sukcesem przygotowania.
  const printRouteMatch = serverSource.match(/app\.post\("\/api\/print"[\s\S]*?\n\}\);/);
  assert.ok(printRouteMatch, 'nie znaleziono trasy /api/print');
  const prepareIndex = printRouteMatch[0].indexOf('prepareStampedQueue(req, session.queue)');
  const leaseIndex = printRouteMatch[0].indexOf('withPrintLease(');
  assert.ok(prepareIndex >= 0 && leaseIndex >= 0 && prepareIndex < leaseIndex, 'prepareStampedQueue musi wystapic PRZED withPrintLease w /api/print');

  // Konwersja DOCX->PDF musi uzywac nie-detached spawn (bezpieczny wobec
  // bledu Windows/Node: detached:true zawsze zglasza kod wyjscia 0).
  assert.match(serverSource, /DOCX_TO_PDF_SCRIPT/);
  assert.doesNotMatch(serverSource, /DOCX_TO_PDF_SCRIPT[\s\S]{0,400}detached:\s*true/);
});

test('drukarka-projekty: "wariant - sprawdź ręcznie" NIE jest jednoczesnie SETTLED (rozstrzygniete) i wylaczone z druku (audyt rozdz. 11, P0/P1)', async () => {
  const appJsSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'public', 'app.js'), 'utf8');

  // "wariant - sprawdź ręcznie" musi zostac w EXCLUDE_FROM_PRINT (domyslnie
  // odznaczone w kolejce druku - to poprawne), ale NIE w SETTLED - inaczej
  // banner podsumowania i licznik "do sprawdzenia" po cichu pomijaja
  // pozycje, ktora w rzeczywistosci wymaga jawnej decyzji uzytkownika, ktory
  // wariant OT/ST jest wlasciwy, i ktora bez tej decyzji nigdy nie trafi do
  // druku.
  const excludeMatch = appJsSource.match(/const EXCLUDE_FROM_PRINT = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(excludeMatch, 'nie znaleziono definicji EXCLUDE_FROM_PRINT');
  assert.match(excludeMatch[1], /"wariant - sprawdź ręcznie"/);

  const settledMatch = appJsSource.match(/const SETTLED = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(settledMatch, 'nie znaleziono definicji SETTLED');
  assert.doesNotMatch(settledMatch[1], /"wariant - sprawdź ręcznie"/);
});

// =====================================================================
// Audyt v1.0.8, Priorytet 2: ponowienie /api/print po zajetej globalnej
// blokadzie druku nie moze stemplowac paczki drugi raz.
// =====================================================================

test('drukarka-projekty: /api/print - ponowienie po zajetej globalnej blokadzie druku NIE stempluje ponownie (audyt v1.0.8 P2)', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-print-retry-dataroot-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const previousDataRoot = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  t.after(() => { if (previousDataRoot === undefined) delete process.env.SCYZORYK_DATA_ROOT; else process.env.SCYZORYK_DATA_ROOT = previousDataRoot; });

  // Zamockuj REALNY druk (SumatraPDF/Acrobat) - ten test sprawdza logike
  // stemplowania/blokady, nie prawdziwy wydruk. printService jest tym samym
  // obiektem modulu, ktorego uzywa apps/drukarka-projekty/server.js (cache
  // require Node) - podmiana metody tutaj jest widoczna tam.
  const originalPrintFileWindows = printService.printFileWindows;
  const printedPaths = [];
  printService.printFileWindows = async (filePath) => { printedPaths.push(filePath); };
  t.after(() => { printService.printFileWindows = originalPrintFileWindows; });

  const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-retry-src-'));
  t.after(() => fsp.rm(srcDir, { recursive: true, force: true }));
  const addressDir = path.join(srcDir, '1 - Test Adres');
  await fsp.mkdir(addressDir);
  const pdfPath = path.join(addressDir, 'rysunek.pdf');
  await createTestPdf(pdfPath);

  const server = app.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function call(method, urlPath, { body, cookie } = {}) {
    const headers = { 'X-Scyzoryk-Request': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
    const json = await res.json().catch(() => null);
    return { status: res.status, json, cookie: nextCookie };
  }

  // Krok 1: /api/match ustawia session.lastBaseFolder (wymagane przez
  // isPathInsideFolder w /api/queue/set) - dopasowanie samo w sobie moze
  // byc niepewne, wazny jest tylko efekt uboczny (zaakceptowany baseFolder).
  const matchRes = await call('POST', '/api/match', { body: { lpGmina: '1', baseFolder: srcDir } });
  assert.equal(matchRes.status, 200, JSON.stringify(matchRes.json));
  const cookie = matchRes.cookie;

  const setRes = await call('POST', '/api/queue/set', { body: { items: [{ fullPath: pdfPath, label: 'Rysunek' }] }, cookie });
  assert.equal(setRes.status, 200, JSON.stringify(setRes.json));

  // Krok 2: zajmij globalna blokade druku Z INNEJ "aplikacji", zanim
  // wywolamy /api/print - dokladnie scenariusz z audytu.
  let releaseLease;
  let leaseEntered;
  const entered = new Promise(resolve => { leaseEntered = resolve; });
  const holdUntilReleased = new Promise(resolve => { releaseLease = resolve; });
  const otherLeaseHolder = withPrintLease({ app: 'inna-apka' }, async () => {
    leaseEntered();
    await holdUntilReleased;
  });
  await entered;

  // Proba 1: blokada zajeta -> 409, druk NIE moze ruszyc dla zadnego pliku.
  const printAttempt1 = await call('POST', '/api/print', { body: { stampPowykonawcza: true, printerName: '' }, cookie });
  assert.equal(printAttempt1.status, 409);
  assert.equal(printAttempt1.json.code, 'PRINT_LOCK_BUSY');
  assert.equal(printedPaths.length, 0, 'nic nie mialo prawa zostac "wydrukowane" przy zajetej blokadzie');

  releaseLease();
  await otherLeaseHolder;

  // Proba 2: ta sama sesja (to samo ciasteczko), ponownie stampPowykonawcza -
  // blokada jest juz wolna, druk powinien sie powiesc, a stemplowanie NIE
  // powinno wykonac sie drugi raz (queuePowykonawczaDone z proby 1).
  const printAttempt2 = await call('POST', '/api/print', { body: { stampPowykonawcza: true, printerName: '' }, cookie });
  assert.equal(printAttempt2.status, 200, JSON.stringify(printAttempt2.json));

  // 5s okazalo sie za krotkie na wolniejszym/obciazonym runnerze CI (zlapane
  // realnie: dokladnie ten sam test przeszedl czysto na tym samym CI 2.5h
  // wczesniej, wiec to niestabilnosc czasowa asynchronicznego stemplowania,
  // nie regresja logiki) - ten sam wniosek co przy naprawie testow launchera
  // w v1.0.10-v1.0.13: rozne runnery/sandboxy maja rozna latencje nawet dla
  // operacji lokalnych, wiec zapas musi byc duzo wiekszy niz "typowy" czas.
  const deadline = Date.now() + 15000;
  while (printedPaths.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(printedPaths.length, 1, 'powinien zostac "wydrukowany" dokladnie jeden plik');

  const stampedBytes = await fsp.readFile(printedPaths[0]);
  const stampedDoc = await PDFDocument.load(stampedBytes);
  assert.equal(stampedDoc.getPageCount(), 1);
  const occurrences = await countTextOccurrences(stampedBytes, 'DOKUMENTACJA');
  assert.equal(occurrences, 1, `oczekiwano jednego stempla "DOKUMENTACJA", znaleziono ${occurrences} wystapien tekstu w PDF-ie`);
});

// =====================================================================
// Audyt rozdz. 11, P0: /api/print nie moze cicho odbudowac PUSTEJ kolejki
// z req.body.groups po zakonczonym druku (kolejka jest czyszczona po kazdym
// zakonczonym zadaniu - patrz finally w /api/print) - inaczej klikniecie
// "Drukuj" drugi raz na tej samej, nieodswiezonej karcie (frontend zawsze
// wysyla groups obok /api/print, patrz public/app.js#printBtn) drukuje cala
// paczke jeszcze raz.
// =====================================================================

test('drukarka-projekty: /api/print NIE odbudowuje pustej kolejki z groups po zakonczonym druku (audyt rozdz. 11, P0)', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-print-reprint-dataroot-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const previousDataRoot = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  t.after(() => { if (previousDataRoot === undefined) delete process.env.SCYZORYK_DATA_ROOT; else process.env.SCYZORYK_DATA_ROOT = previousDataRoot; });

  const originalPrintFileWindows = printService.printFileWindows;
  const printedPaths = [];
  printService.printFileWindows = async (filePath) => { printedPaths.push(filePath); };
  t.after(() => { printService.printFileWindows = originalPrintFileWindows; });

  const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-reprint-src-'));
  t.after(() => fsp.rm(srcDir, { recursive: true, force: true }));
  const addressDir = path.join(srcDir, '1 - Test Adres');
  await fsp.mkdir(addressDir);
  const pdfPath = path.join(addressDir, 'rysunek.pdf');
  await createTestPdf(pdfPath);

  const server = app.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function call(method, urlPath, { body, cookie } = {}) {
    const headers = { 'X-Scyzoryk-Request': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
    const json = await res.json().catch(() => null);
    return { status: res.status, json, cookie: nextCookie };
  }

  const matchRes = await call('POST', '/api/match', { body: { lpGmina: '1', baseFolder: srcDir } });
  assert.equal(matchRes.status, 200, JSON.stringify(matchRes.json));
  const cookie = matchRes.cookie;

  const setRes = await call('POST', '/api/queue/set', { body: { items: [{ fullPath: pdfPath, label: 'Rysunek' }] }, cookie });
  assert.equal(setRes.status, 200, JSON.stringify(setRes.json));

  // Pierwszy, legalny druk - musi sie powiesc i faktycznie "wydrukowac" plik.
  const printAttempt1 = await call('POST', '/api/print', { body: { printerName: '' }, cookie });
  assert.equal(printAttempt1.status, 200, JSON.stringify(printAttempt1.json));

  // Czekamy na status.done, NIE tylko na printedPaths.length - po
  // "wydrukowaniu" pliku serwer nadal czeka delaySeconds (min. 1s, patrz
  // Math.max w /api/print) i dopiero POTEM (finally) czysci session.queue i
  // session.printing. Zbyt wczesne drugie wywolanie /api/print trafiloby w
  // "Drukowanie juz trwa" (409), nie w test, ktory ten test faktycznie chce
  // sprawdzic (pusta kolejka PO zakonczeniu).
  const deadline = Date.now() + 15000;
  let done = false;
  while (!done && Date.now() < deadline) {
    const statusRes = await call('GET', '/api/status', { cookie });
    done = Boolean(statusRes.json?.done);
    if (!done) await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(done, true, 'pierwszy druk nie zakonczyl sie (status.done) w oczekiwanym czasie');
  assert.equal(printedPaths.length, 1, 'pierwszy druk powinien "wydrukowac" dokladnie jeden plik');

  // Drugie klikniecie "Drukuj" na tej samej, nieodswiezonej karcie - frontend
  // (public/app.js#printBtn) ZAWSZE wysyla groups obok /api/print, wiec
  // symulujemy dokladnie to: te sama grupa/plik co za pierwszym razem,
  // BEZ ponownego wywolania /api/queue/set (dokladnie jak przy nieodswiezonej
  // karcie z zaznaczonymi checkboxami sprzed pierwszego druku).
  const groups = [{ label: 'Test Adres', items: [{ fullPath: pdfPath, label: 'Rysunek' }] }];
  const printAttempt2 = await call('POST', '/api/print', { body: { printerName: '', groups }, cookie });

  assert.equal(printAttempt2.status, 400, 'drugie klikniecie z pusta kolejka NIE moze cicho odbudowac jej z groups i wydrukowac ponownie');
  assert.match(printAttempt2.json.message, /Kolejka jest pusta/);
  assert.equal(printedPaths.length, 1, 'plik NIE moze zostac "wydrukowany" drugi raz');
});
