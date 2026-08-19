// Testy nowego narzedzia nazywarka-skanow (plan: zmiana nazwy zeskanowanych
// PDF-ow w miejscu na sieciowym udziale, bez uploadu/kopiowania/OCR).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  isPathInsideFolder,
  listPdfFiles,
  sanitizeBaseName,
  stripRedundantExtension
} = require('../apps/nazywarka-skanow/server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function call(port, method, urlPath, { body, cookie } = {}) {
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
  let json = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) json = await res.json().catch(() => null);
  return { status: res.status, json, cookie: nextCookie, res };
}

test('isPathInsideFolder: blokuje wyjscie poza wskazany folder', () => {
  assert.equal(isPathInsideFolder('C:\\skan\\a.pdf', 'C:\\skan'), true);
  assert.equal(isPathInsideFolder('C:\\skan-inny\\a.pdf', 'C:\\skan'), false);
  assert.equal(isPathInsideFolder('C:\\skan\\..\\inny\\a.pdf', 'C:\\skan'), false);
  assert.equal(isPathInsideFolder(null, 'C:\\skan'), false);
});

test('listPdfFiles: tylko PDF, sortowanie naturalne (polskie znaki, liczby)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-nazywarka-list-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'skan10.pdf'), '');
  await fsp.writeFile(path.join(dir, 'skan2.pdf'), '');
  await fsp.writeFile(path.join(dir, 'Żarnów.pdf'), '');
  await fsp.writeFile(path.join(dir, 'nie_pdf.jpg'), '');
  await fsp.mkdir(path.join(dir, 'podfolder.pdf'));
  const names = listPdfFiles(dir);
  assert.deepEqual(names, ['skan2.pdf', 'skan10.pdf', 'Żarnów.pdf']);
});

test('sanitizeBaseName: odrzuca windowsowe znaki niedozwolone, nazwy zarezerwowane, koncowe kropki/spacje', () => {
  assert.equal(sanitizeBaseName('Kowalski, ul. Polna 5').ok, true);
  assert.equal(sanitizeBaseName('Kowalski, ul. Polna 5.2').ok, true, 'kropka w srodku nazwy musi zostac');
  for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
    assert.equal(sanitizeBaseName(bad).ok, false, `powinno odrzucic: ${bad}`);
  }
  assert.equal(sanitizeBaseName('a/b').ok, false);
  assert.equal(sanitizeBaseName('a\\b').ok, false);
  assert.equal(sanitizeBaseName('CON').ok, false);
  assert.equal(sanitizeBaseName('con').ok, false);
  assert.equal(sanitizeBaseName('LPT1').ok, false);
  assert.equal(sanitizeBaseName('nazwa.').ok, false, 'Windows nie obsluguje pliku konczacego sie kropka');
  // Incydentalna spacja na koncu (z wpisywania/wklejania) jest zwyklym
  // przycinaniem inputu, nie "obcinaniem znaczacych znakow" - trimowana jest
  // PRZED sprawdzeniem koncowki, wiec nie jest to blad uzytkownika.
  const trimmedSpace = sanitizeBaseName('nazwa ');
  assert.equal(trimmedSpace.ok, true);
  assert.equal(trimmedSpace.value, 'nazwa');
  assert.equal(sanitizeBaseName('').ok, false);
  assert.equal(sanitizeBaseName('   ').ok, false);
});

test('stripRedundantExtension: usuwa dokladnie jeden koncowy duplikat rozszerzenia, nie dotyka kropek w srodku', () => {
  assert.equal(stripRedundantExtension('Kowalski.pdf', '.pdf'), 'Kowalski');
  assert.equal(stripRedundantExtension('Kowalski.PDF', '.pdf'), 'Kowalski');
  assert.equal(stripRedundantExtension('Kowalski 5.2', '.pdf'), 'Kowalski 5.2');
  assert.equal(stripRedundantExtension('Kowalski', '.pdf'), 'Kowalski');
});

test('nazywarka-skanow: pelny przebieg folder->lista->podglad->rename->weryfikacja->cofniecie i poprawka', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  const port = await listen(server);
  t.after(() => close(server));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-nazywarka-flow-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'IMG_0001.pdf'), '%PDF-atrapa-1');
  await fsp.writeFile(path.join(dir, 'IMG_0002.pdf'), '%PDF-atrapa-2');
  await fsp.writeFile(path.join(dir, 'IMG_0003.pdf'), '%PDF-atrapa-3');

  const open = await call(port, 'POST', '/api/open-folder', { body: { folderPath: dir } });
  assert.equal(open.status, 200);
  assert.equal(open.json.ok, true);
  assert.equal(open.json.total, 3);
  assert.equal(open.json.currentIndex, 0);
  const cookie = open.cookie;

  // Podglad pierwszego pliku - realne bajty PDF-a wracaja z serwera.
  const preview = await call(port, 'GET', '/api/preview/0', { cookie });
  assert.equal(preview.status, 200);
  const previewBody = await preview.res.text();
  assert.equal(previewBody, '%PDF-atrapa-1');

  // Zmiana nazwy pierwszego pliku - w miejscu, rozszerzenie zachowane,
  // przechodzi na kolejny plik automatycznie.
  const rename1 = await call(port, 'POST', '/api/rename', { body: { newName: 'Kowalski, ul. Polna 5' }, cookie });
  assert.equal(rename1.status, 200);
  assert.equal(rename1.json.currentIndex, 1);
  assert.equal(rename1.json.files[0].currentName, 'Kowalski, ul. Polna 5.pdf');
  assert.equal(rename1.json.files[0].renamed, true);
  assert.ok(fs.existsSync(path.join(dir, 'Kowalski, ul. Polna 5.pdf')), 'plik musi istniec pod nowa nazwa na dysku');
  assert.ok(!fs.existsSync(path.join(dir, 'IMG_0001.pdf')), 'stara nazwa nie moze juz istniec');

  // Cofniecie sie do juz zmienionego pliku i POPRAWIENIE nazwy (wymog planu:
  // musi dac sie cofnac i poprawic zle nazwany plik nawet po zmianie).
  const back = await call(port, 'POST', '/api/prev', { cookie });
  assert.equal(back.json.currentIndex, 0);
  const previewAfterRename = await call(port, 'GET', '/api/preview/0', { cookie });
  assert.equal(previewAfterRename.status, 200, 'podglad musi znalezc plik pod JUZ ZMIENIONA nazwa');

  const rename1Fix = await call(port, 'POST', '/api/rename', { body: { newName: 'Kowalski, ul. Polna 5A' }, cookie });
  assert.equal(rename1Fix.status, 200);
  assert.equal(rename1Fix.json.files[0].currentName, 'Kowalski, ul. Polna 5A.pdf');
  assert.ok(fs.existsSync(path.join(dir, 'Kowalski, ul. Polna 5A.pdf')));
  assert.ok(!fs.existsSync(path.join(dir, 'Kowalski, ul. Polna 5.pdf')), 'poprzednia (pierwsza) zmieniona nazwa nie moze zostac osierocona na dysku');
});

test('nazywarka-skanow: konflikt nazwy jest twardym bledem - NIGDY cichym nadpisaniem ani auto-numerowaniem', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  const port = await listen(server);
  t.after(() => close(server));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-nazywarka-konflikt-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'a.pdf'), '%PDF-a');
  await fsp.writeFile(path.join(dir, 'b.pdf'), '%PDF-b');
  await fsp.writeFile(path.join(dir, 'zajete.pdf'), '%PDF-zajete');

  const open = await call(port, 'POST', '/api/open-folder', { body: { folderPath: dir } });
  const cookie = open.cookie;
  // Kolejnosc alfabetyczna: a.pdf, b.pdf, zajete.pdf -> currentIndex 0 = a.pdf
  const rename = await call(port, 'POST', '/api/rename', { body: { newName: 'zajete' }, cookie });
  assert.equal(rename.status, 409);
  assert.match(rename.json.message, /juz istnieje/);
  // Zaden plik nie mogl zostac cicho nadpisany ani dostac numeru (2)/(3).
  assert.ok(fs.existsSync(path.join(dir, 'a.pdf')), 'oryginalny plik zostaje nietkniety po odrzuceniu');
  assert.equal(fs.readFileSync(path.join(dir, 'zajete.pdf'), 'utf8'), '%PDF-zajete', 'istniejacy plik nie zostal nadpisany');
  assert.ok(!fs.existsSync(path.join(dir, 'zajete (2).pdf')), 'brak cichego auto-numerowania');
});

// =====================================================================
// Audyt 2026-08-19: przyspieszenie ladowania podgladow (skanowane PDF-y
// bywaja duze) - podglad dostaje teraz Cache-Control pozwalajacy
// przegladarce go zacache'owac (zamiast "no-store"), zeby prefetch
// sasiednich plikow w app.js mial jakikolwiek sens. previewToken w URL-u
// gwarantuje, ze otwarcie NOWEGO folderu nigdy nie odczyta z cache
// podgladu z folderu POPRZEDNIEGO pod tym samym numerem indeksu.
// =====================================================================

test('nazywarka-skanow: previewToken jest inny przy kazdym otwarciu folderu, podglad jest cache-owalny (nie "no-store")', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  const port = await listen(server);
  t.after(() => close(server));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-nazywarka-token-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'a.pdf'), '%PDF-a');

  const open1 = await call(port, 'POST', '/api/open-folder', { body: { folderPath: dir } });
  assert.ok(open1.json.previewToken, 'otwarcie folderu musi wygenerowac token podgladu');
  const cookie = open1.cookie;

  const preview = await call(port, 'GET', `/api/preview/0?t=${open1.json.previewToken}`, { cookie });
  assert.equal(preview.status, 200);
  assert.notEqual(preview.res.headers.get('cache-control'), 'no-store', 'podglad musi byc cache-owalny, zeby prefetch mial sens');
  assert.match(preview.res.headers.get('cache-control') || '', /max-age/);

  // Ponowne otwarcie TEGO SAMEGO folderu (np. po restarcie pracy) musi dac
  // INNY token - to on chroni przed pokazaniem starego, zcache'owanego
  // podgladu spod tego samego URL-a przy nastepnym otwarciu.
  const open2 = await call(port, 'POST', '/api/open-folder', { body: { folderPath: dir }, cookie });
  assert.ok(open2.json.previewToken, 'ponowne otwarcie tez musi miec token');
  assert.notEqual(open2.json.previewToken, open1.json.previewToken, 'kazde otwarcie folderu musi dostac swiezy token');
});

test('nazywarka-skanow: rozszerzenia nie da sie zmienic, nawet jesli uzytkownik je wpisze', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  const port = await listen(server);
  t.after(() => close(server));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-nazywarka-ext-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'skan.pdf'), '%PDF-skan');

  const open = await call(port, 'POST', '/api/open-folder', { body: { folderPath: dir } });
  const cookie = open.cookie;
  const rename = await call(port, 'POST', '/api/rename', { body: { newName: 'Nowak.docx' }, cookie });
  assert.equal(rename.status, 200);
  // ".docx" w tym co wpisal uzytkownik trafia do nazwy bazowej jako zwykly
  // tekst (nie jest to znane rozszerzenie ZRODLOWEGO pliku), a prawdziwe
  // rozszerzenie (.pdf) i tak zostaje doklejone na koniec.
  assert.equal(rename.json.files[0].currentName, 'Nowak.docx.pdf');
  assert.ok(fs.existsSync(path.join(dir, 'Nowak.docx.pdf')));
});
