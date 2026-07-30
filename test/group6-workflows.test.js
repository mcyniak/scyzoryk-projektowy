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
  isTemporaryFile
} = require('../apps/drukarka-projekty/src/folderMatch');
const { isAffirmativeFlag } = require('../lib/businessFlags');

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
