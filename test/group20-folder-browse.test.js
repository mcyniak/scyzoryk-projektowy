// Testy lib/folderBrowse.js - przegladarka folderow w stronie, uzywana
// przez apps/tworzenie-folderow, apps/drukarka-projekty, apps/karty-katalogowe
// (zamiast recznego wpisywania sciezki, po nieudanych probach prawdziwego
// natywnego okna Windows - patrz komentarz w samym module).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { listDrives, browseFolder } = require('../lib/folderBrowse');

test('listDrives: znajduje przynajmniej dysk, na ktorym stoi repo (nigdy pusta lista na Windows)', () => {
  const drives = listDrives();
  assert.ok(Array.isArray(drives));
  assert.ok(drives.length > 0);
  const repoDrive = path.parse(__dirname).root.toUpperCase();
  assert.ok(drives.some(d => d.toUpperCase() === repoDrive), `oczekiwano dysku repo (${repoDrive}) na liscie: ${drives.join(', ')}`);
});

test('browseFolder: bez podanej sciezki zwraca liste dyskow jako entries', () => {
  const result = browseFolder();
  assert.equal(result.path, null);
  assert.equal(result.parent, null);
  assert.ok(result.entries.length > 0);
  assert.ok(result.entries.every(e => /^[A-Za-z]:\\$/.test(e.path)));
});

test('browseFolder: listuje TYLKO podfoldery (nie pliki), posortowane', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'Zeta'));
  fs.mkdirSync(path.join(dir, 'Alfa'));
  fs.writeFileSync(path.join(dir, 'plik.txt'), 'x');

  const result = browseFolder(dir);
  assert.deepEqual(result.entries.map(e => e.name), ['Alfa', 'Zeta']);
});

test('browseFolder: sortowanie naturalne/numeryczne (2 przed 10, jak w prawdziwych folderach adresow)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  for (const name of ['10.Zabno', '2.Kijowiec-Szyszynek 2', '1.Adamow', '11.Zorawina']) {
    fs.mkdirSync(path.join(dir, name));
  }

  const result = browseFolder(dir);
  assert.deepEqual(result.entries.map(e => e.name), ['1.Adamow', '2.Kijowiec-Szyszynek 2', '10.Zabno', '11.Zorawina']);
});

test('browseFolder: parent jest null w korzeniu dysku, ustawiony w innym miejscu', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const sub = path.join(dir, 'Podfolder');
  fs.mkdirSync(sub);

  const resultSub = browseFolder(sub);
  assert.equal(resultSub.parent, dir);

  const driveRoot = path.parse(dir).root;
  const resultRoot = browseFolder(driveRoot);
  assert.equal(resultRoot.parent, null);
});

test('browseFolder: czytelny blad na nieistniejacej sciezce (nie 500 bez wyjasnienia)', () => {
  assert.throws(() => browseFolder('C:\\na-pewno-nie-istnieje-xyz-123'), /nie istnieje/);
});

test('browseFolder: czytelny blad, gdy sciezka wskazuje na plik, nie folder', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plik.txt');
  fs.writeFileSync(file, 'x');

  assert.throws(() => browseFolder(file), /to nie jest folder/i);
});

// =====================================================================
// Audyt 2026-08-19 (ocr-audytow, "wgraj gotowa tabele"): rozszerzenie o
// wybor KONKRETNEGO pliku (nie tylko folderu), na wyrazna prosbe
// wlasciciela - "brakuje mi tego eksploratora co w innych aplikacjach".
// =====================================================================

test('browseFolder: bez options.fileExtensions zachowanie DOKLADNIE jak dotad (zero regresji dla istniejacych apek)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'Folder'));
  fs.writeFileSync(path.join(dir, 'dane.xlsx'), 'x');

  const result = browseFolder(dir);
  assert.deepEqual(result.entries.map((e) => e.name), ['Folder']);
});

test('browseFolder: z options.fileExtensions listuje TEZ pasujace pliki (oznaczone isFile:true), inne rozszerzenia pomijane, wielkosc liter rozszerzenia bez znaczenia', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'Podfolder'));
  fs.writeFileSync(path.join(dir, 'aaa-tabela.xlsx'), 'x');
  fs.writeFileSync(path.join(dir, 'notatki.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'zzz-TABELA.XLSX'), 'x');

  const result = browseFolder(dir, { fileExtensions: ['.xlsx'] });
  const names = result.entries.map((e) => e.name);
  assert.ok(names.includes('Podfolder'));
  assert.ok(names.includes('aaa-tabela.xlsx'));
  assert.ok(names.includes('zzz-TABELA.XLSX'));
  assert.ok(!names.includes('notatki.txt'), 'plik z innym rozszerzeniem nie moze sie pojawic');
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries.find((e) => e.name === 'Podfolder').isFile, false);
  assert.equal(result.entries.find((e) => e.name === 'aaa-tabela.xlsx').isFile, true);
});
