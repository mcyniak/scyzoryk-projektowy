const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  scanFilesRecursive,
  classifyFiles,
  extractAttachmentsList,
  compareAttachmentNumbers,
  isTemporaryFile,
  findAddressFolder,
  addressTokens,
  filenameMatchesOwnAddress
} = require('../apps/drukarka-projekty/src/folderMatch');
const { isTruthyMark } = require('../apps/drukarka-projekty/src/excelInvestment');
const { buildQueueFromGroups } = require('../apps/drukarka-projekty/server');
const { isAffirmativeFlag } = require('../lib/businessFlags');
const { normalizeDate } = require('../apps/wnioski-powykonawcze/src/dateValidation');
const { app: wmApp, isPathInsideFolder: wmIsPathInsideFolder } = require('../apps/wnioski-powykonawcze/server');
const { PDFDocument } = require('../apps/drukarka-projekty/node_modules/pdf-lib');

async function createTestPdf(filePath) {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  await fsp.writeFile(filePath, await doc.save());
}

test('skanowanie folderu działa rekurencyjnie i respektuje limit głębokości', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-scan-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const expected = ['a.pdf'];
  await fsp.writeFile(path.join(root, 'a.pdf'), '');
  let current = root;
  for (let depth = 1; depth <= 10; depth += 1) {
    current = path.join(current, `sub${depth}`);
    await fsp.mkdir(current);
    await fsp.writeFile(path.join(current, `${depth}.pdf`), '');
    if (depth <= 8) expected.push(path.join(...Array.from({ length: depth }, (_, i) => `sub${i + 1}`), `${depth}.pdf`));
  }
  assert.deepEqual(scanFilesRecursive(root).sort(), expected.sort());
});

test('duplikaty są rozstrzygane tylko w tym samym podfolderze', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-dupes-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'PDF'));
  await fsp.mkdir(path.join(root, 'DOCX'));
  await fsp.writeFile(path.join(root, 'PDF', 'rysunek.pdf'), '');
  await fsp.writeFile(path.join(root, 'DOCX', 'rysunek.docx'), '');
  await fsp.writeFile(path.join(root, 'lokalny.pdf'), '');
  await fsp.writeFile(path.join(root, 'lokalny.docx'), '');
  const result = classifyFiles(root);
  assert.ok(result.printable.includes(path.join('PDF', 'rysunek.pdf')));
  assert.ok(result.printable.includes(path.join('DOCX', 'rysunek.docx')));
  assert.ok(result.printable.includes('lokalny.pdf'));
  assert.ok(result.droppedDuplicates.includes('lokalny.docx'));
});

test('numery załączników zachowują segmenty i sortują się naturalnie', () => {
  const items = extractAttachmentsList('Załącznik nr 1.1: Rysunek A\nZałącznik nr 1.2: Rysunek B');
  assert.deepEqual(items.map(item => item.num), ['1.1', '1.2']);
  assert.deepEqual(['10', '2', '1.1', '1', '10.1', '1.2'].sort(compareAttachmentNumbers), ['1', '1.1', '1.2', '2', '10', '10.1']);
});

test('pliki tymczasowe są ignorowane, a flagi rezygnacji są jednoznaczne', async (t) => {
  assert.equal(isTemporaryFile('~$dokument.docx'), true);
  assert.equal(isTemporaryFile('Thumbs.db'), true);
  assert.equal(isTemporaryFile('normalny_plik.docx'), false);
  for (const value of ['TAK', 'tak', 'X', '1', '+']) assert.equal(isAffirmativeFlag(value), true);
  for (const value of ['NIE', '0', '-', 'brak', '', undefined, 'cos dziwnego']) assert.equal(isAffirmativeFlag(value), false);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-temp-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, '~$dokument.docx'), '');
  await fsp.writeFile(path.join(root, 'normalny.pdf'), '');
  const result = classifyFiles(root);
  assert.deepEqual(result.ignoredTemporary, ['~$dokument.docx']);
  assert.ok(!result.printable.includes('~$dokument.docx'));
});

test('niepewne pozycje wymagają ręcznego zaznaczenia w UI', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'public', 'app.js'), 'utf8');
  assert.match(source, /"dopasowanie po kolejności - sprawdź"/);
  assert.match(source, /"niedopasowane"/);
  assert.match(source, /class="order-print-checkbox"/);
  assert.match(source, /item\.includeInPrint = checkbox\.checked/);
});

test('wnioski powykonawcze: normalizeDate odrzuca nieistniejące daty kalendarzowe (audyt v1.0.4, P1-7)', () => {
  // Wczesniej walidacja sprawdzala tylko KSZTALT cyfr, wiec te trzy przechodzily
  // bez bledu (JS Date po cichu "koryguje" 31.02 -> 03.03 itp.) - teraz musza
  // zostac odrzucone jako nieistniejace daty.
  for (const bad of ['31.02.2026', '99.99.2026', '2026-15-73', '2026-02-30', '32.01.2026', '00.01.2026', '01.00.2026']) {
    assert.throws(() => normalizeDate(bad), /Nieprawidłowa data/, `powinno odrzucic: ${bad}`);
  }
  assert.equal(normalizeDate('15.02.2026'), '15.02.2026');
  assert.equal(normalizeDate('2026-02-15'), '15.02.2026');
  assert.equal(normalizeDate('29.02.2024'), '29.02.2024'); // 2024 to rok przestepny - 29 lutego istnieje
  assert.throws(() => normalizeDate('29.02.2026'), /Nieprawidłowa data/); // 2026 NIE jest przestepny
  assert.equal(normalizeDate('02.2026'), '02.2026');
  assert.throws(() => normalizeDate('13.2026'), /Nieprawidłowa data/);
});

test('wnioski powykonawcze używają szybkiego modelu zadaniowego z anulowaniem', async () => {
  const server = await fsp.readFile(path.join(__dirname, '..', 'apps', 'wnioski-powykonawcze', 'server.js'), 'utf8');
  const frontend = await fsp.readFile(path.join(__dirname, '..', 'apps', 'wnioski-powykonawcze', 'public', 'inline-1.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/jobs'/);
  assert.match(server, /res\.status\(202\)\.json\(\{ ok: true, jobId, status: 'queued' \}\)/);
  assert.match(server, /app\.get\('\/api\/jobs\/:id'/);
  assert.match(server, /app\.post\('\/api\/jobs\/:id\/cancel'/);
  assert.match(server, /job\.child\?\.kill\(\)/);
  assert.match(server, /status: interrupted \? 'interrupted'/);
  assert.doesNotMatch(server, /app\.post\('\/api\/convert'/);
  assert.match(frontend, /setInterval\(pollManualJob/);
  assert.match(frontend, /res\.status === 404/);
});

test('wnioski powykonawcze: isPathInsideFolder odrzuca sciezki spoza folderu, akceptuje sciezki wewnatrz (audyt rozdz. 13, P0/P1)', () => {
  const root = path.join('C:', 'Projekty', 'Zarnow');
  assert.equal(wmIsPathInsideFolder(path.join(root, '41', 'WM Pompa.docx'), root), true);
  assert.equal(wmIsPathInsideFolder(root, root), true);
  assert.equal(wmIsPathInsideFolder(path.join('C:', 'Projekty', 'ZarnowInny', 'plik.docx'), root), false, 'prefiks folderu bez separatora nie moze przejsc');
  assert.equal(wmIsPathInsideFolder(path.join('C:', 'Windows', 'System32', 'cmd.exe'), root), false);
  assert.equal(wmIsPathInsideFolder('', root), false);
  assert.equal(wmIsPathInsideFolder(root, ''), false);
});

test('wnioski powykonawcze: /api/wm-folder/convert odrzuca sourcePath/folderPath spoza przeskanowanego folderu, nawet z prawidlowym scanToken (audyt rozdz. 13, P0/P1)', async (t) => {
  const scannedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-wm-scan-'));
  t.after(() => fsp.rm(scannedRoot, { recursive: true, force: true }));
  const categoryDir = path.join(scannedRoot, '41 - Zarnow');
  await fsp.mkdir(categoryDir);
  await fsp.writeFile(path.join(categoryDir, 'WM Pompa ciepla.docx'), 'tresc');

  const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-wm-outside-'));
  t.after(() => fsp.rm(outsideRoot, { recursive: true, force: true }));
  const outsideDocx = path.join(outsideRoot, 'inny-plik.docx');
  await fsp.writeFile(outsideDocx, 'tresc');

  const server = wmApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function post(urlPath, body) {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
      body: JSON.stringify(body)
    });
    return { status: res.status, json: await res.json() };
  }

  // Brak scanToken (albo nieprawidlowy) - konwersja musi byc odrzucona,
  // zanim w ogole spojrzy na sourcePath/folderPath.
  const noToken = await post('/api/wm-folder/convert', {
    items: [{ sourcePath: outsideDocx, folderPath: outsideRoot, category: 'x' }],
    date: '2026-01-15'
  });
  assert.equal(noToken.status, 400);
  assert.match(noToken.json.message, /Sesja skanowania/);

  const scan = await post('/api/wm-folder/scan', { folderPath: scannedRoot });
  assert.equal(scan.status, 200);
  assert.ok(scan.json.scanToken, 'scan musi zwrocic scanToken');

  // Prawidlowy scanToken, ale sourcePath/folderPath spoza scannedRoot -
  // dokladnie scenariusz z audytu: klient podmienia sciezki w ciele
  // zadania na dowolny plik/folder na dysku.
  const outsideAttempt = await post('/api/wm-folder/convert', {
    items: [{ sourcePath: outsideDocx, folderPath: outsideRoot, category: 'x' }],
    date: '2026-01-15',
    scanToken: scan.json.scanToken
  });
  assert.equal(outsideAttempt.status, 400);
  assert.match(outsideAttempt.json.message, /poza przeskanowanym folderem/);
  assert.ok(!fs.existsSync(path.join(outsideRoot, 'WM dok.pod Pompa ciepla.pdf')), 'nic nie moglo zostac zapisane poza przeskanowanym folderem');

  // Mieszany atak: sourcePath prawidlowy (wewnatrz scannedRoot), ale
  // folderPath (miejsce zapisu PDF-a) podmieniony na folder spoza -
  // tez musi zostac odrzucony.
  const mixedAttempt = await post('/api/wm-folder/convert', {
    items: [{ sourcePath: path.join(categoryDir, 'WM Pompa ciepla.docx'), folderPath: outsideRoot, category: 'x' }],
    date: '2026-01-15',
    scanToken: scan.json.scanToken
  });
  assert.equal(mixedAttempt.status, 400);
  assert.match(mixedAttempt.json.message, /poza przeskanowanym folderem/);
});

test('wnioski powykonawcze: frontend zapamietuje scanToken ze skanu i wysyla go przy konwersji (audyt rozdz. 13, P0/P1)', async () => {
  const frontend = await fsp.readFile(path.join(__dirname, '..', 'apps', 'wnioski-powykonawcze', 'public', 'inline-1.js'), 'utf8');
  assert.match(frontend, /wmScanToken\s*=\s*data\.scanToken/);
  assert.match(frontend, /scanToken:\s*wmScanToken/);
});

test('drukarka-projekty: isTruthyMark (audyt P1-4) uzywa bialej listy zamiast wykluczac prawie wszystko', () => {
  for (const value of ['tak', 'x', 'X', '+', '1', '15.03.2026', '2026-03-15', 5, 3.5]) {
    assert.equal(isTruthyMark(value), true, `powinno byc "odebrane": ${value}`);
  }
  for (const value of ['', '0', 'nie', 'NIE', '-', null, undefined]) {
    assert.equal(isTruthyMark(value), false, `powinno byc "nieodebrane": ${value}`);
  }
  // Literowki/nierozpoznane teksty NIE moga byc cicho traktowane jako
  // "odebrane" - inaczej caly wiersz znika z listy kandydatow bez sladu.
  for (const value of ['brak', 'n/d', 'costam']) {
    assert.equal(isTruthyMark(value), false, `nierozpoznana wartosc nie powinna wykluczac wiersza: ${value}`);
  }
});

test('drukarka-projekty: dopasowanie folderu po LP musi sprawdzic adres (audyt P0-6b)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-lp-conflict-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // Dwie rozne inwestycje moga uzywac tego samego numeru LP (numeracja od
  // nowa w kazdej) - tu obie maja LP "41", ale rozne adresy.
  await fsp.mkdir(path.join(root, '41 - Zarnow, ul. Spacerowa'));
  const { matches, allFolders } = findAddressFolder(root, '41');
  assert.deepEqual(matches, ['41 - Zarnow, ul. Spacerowa']);
  assert.ok(allFolders.includes('41 - Zarnow, ul. Spacerowa'));

  const folderName = matches[0];

  // Adres z Excela zgodny z folderem - nie powinno byc konfliktu.
  const matchingTokens = addressTokens('Zarnow, ul. Spacerowa');
  assert.ok(matchingTokens.length > 0);
  assert.equal(filenameMatchesOwnAddress(folderName, matchingTokens), true);

  // Adres z Excela NIEZGODNY z folderem (inna inwestycja, ten sam numer LP) -
  // matchOneAddress w server.js musi to wykryc i zwrocic ok:false zamiast
  // cicho podpiac zly folder pod zly adres.
  const mismatchTokens = addressTokens('Kolektory, ul. Polna 7');
  assert.ok(mismatchTokens.length > 0);
  assert.equal(filenameMatchesOwnAddress(folderName, mismatchTokens), false);
});

test('drukarka-projekty: matchOneAddress w server.js blokuje niezgodny adres i pamieta ostatni folder per plik (audyt P0-6a/b)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'drukarka-projekty', 'server.js'), 'utf8');

  // P0-6b: kontrola adresu zaraz po ustaleniu folderName, przed dalszym
  // przetwarzaniem, z uzyciem gotowych funkcji z folderMatch.js.
  assert.match(source, /addressHint\?\.adres/);
  assert.match(source, /folderMatch\.addressTokens\(addressHint\.adres\)/);
  assert.match(source, /folderMatch\.filenameMatchesOwnAddress\(folderName, tokens\)/);
  assert.match(source, /mozliwy konflikt numeracji miedzy inwestycjami/);

  // P0-6a: klucz pamieci ostatniego folderu juz nie jest sama nazwa zakladki -
  // musi laczyc identyfikator pliku (fileKey) z nazwa zakladki, z tolerancja
  // wsteczna (fallback na sama nazwe zakladki, gdy fileKey nie zostal
  // przeslany).
  assert.match(source, /function lastFolderKey\(fileKey, sheetName\)/);
  assert.match(source, /\$\{key\}::\$\{sheetName\}/);
  assert.match(source, /return key \? `\$\{key\}::\$\{sheetName\}` : sheetName;/);
  assert.match(source, /computeFileKey\(req\.file\.buffer\)/);
  assert.match(source, /crypto\.createHash\("sha256"\)/);
  assert.match(source, /saveLastFolder\(lastFolderKey\(fileKey, sheetName\), baseFolder\)/);
});

test('drukarka-projekty: buildQueueFromGroups zachowuje przeplot PDF/DOCX/PDF zamiast grupowac (audyt P1-3)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-queue-order-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const pdf1 = path.join(root, '1-tytul.pdf');
  const docx = path.join(root, '2-opis.docx');
  const pdf2 = path.join(root, '3-rysunek.pdf');
  await createTestPdf(pdf1);
  await fsp.writeFile(docx, 'atrapa docx');
  await createTestPdf(pdf2);

  const fakeReq = { session: { lastBaseFolder: root }, sid: 'test-sid' };
  const groups = [{ label: 'Adres testowy', items: [{ fullPath: pdf1 }, { fullPath: docx }, { fullPath: pdf2 }] }];

  const { built, missing } = await buildQueueFromGroups(fakeReq, groups);
  assert.deepEqual(missing, []);
  // Wczesniej: oba PDF-y trafialyby do JEDNEGO polaczonego pliku, a DOCX
  // zostalby dopisany na koniec (2 pozycje, zla kolejnosc: PDF+PDF, DOCX).
  // Teraz: PDF/DOCX/PDF nie sa sasiadujace jako PDF-y, wiec zaden nie jest
  // scalany - 3 pozycje, w oryginalnej kolejnosci.
  assert.equal(built.length, 3);
  assert.equal(built[0].path, pdf1);
  assert.equal(built[1].path, docx);
  assert.equal(built[2].path, pdf2);

  // Kontrolne sprawdzenie, ze SASIADUJACE PDF-y nadal sie scalaja (nie
  // zepsulismy tego przy okazji naprawy przeplotu).
  const pdfA = path.join(root, '4-a.pdf');
  const pdfB = path.join(root, '5-b.pdf');
  await createTestPdf(pdfA);
  await createTestPdf(pdfB);
  const groups2 = [{ label: 'Adres testowy 2', items: [{ fullPath: pdfA }, { fullPath: pdfB }, { fullPath: docx }] }];
  const { built: built2 } = await buildQueueFromGroups(fakeReq, groups2);
  assert.equal(built2.length, 2);
  assert.notEqual(built2[0].path, pdfA);
  assert.notEqual(built2[0].path, pdfB);
  assert.match(built2[0].path, /\.pdf$/);
  assert.equal(built2[1].path, docx);
});
