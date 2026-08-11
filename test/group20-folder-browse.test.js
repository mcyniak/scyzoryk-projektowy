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
