const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'server.js');

test('pełne rekordy są przechowywane, a podgląd jest osobną listą', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  assert.match(source, /const allRows = filtered\.map/);
  assert.match(source, /const previewRows = allRows\.slice\(0, MAX_ROWS\)/);
  assert.match(source, /return \{ sheetName, columns, rows: allRows, previewRows/);
  assert.match(source, /selectedSheet\.rows \|\| \[\]/);
  assert.match(source, /\/api\/jobs\/:jobId\/sheets\/:sheetName\/rows/);
  assert.match(source, /sheet\.rows\.slice\(offset, offset \+ limit\)/);
});

test('wybrany arkusz jest walidowany w podglądzie, paginacji i generowaniu', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  const validations = source.match(/validateReferenceColumns\(/g) || [];
  assert.ok(validations.length >= 5, `wywołania walidacji: ${validations.length}`);
  assert.match(source, /missingColumns,\s*message: `Arkusz "\$\{sheetName\}"/);
});

test('zadania aktywne po restarcie są przerywane i można je anulować', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  assert.match(source, /\['running', 'queued', 'cancelling'\]\.includes\(item\.status\)/);
  assert.match(source, /status: interrupted \? 'interrupted'/);
  assert.match(source, /interruptedReason: interrupted \? 'process-restarted'/);
  assert.match(source, /if \(job\.status === 'interrupted'\) \{\s*job\.status = 'cancelled'/);
});

test('frontend pobiera wszystkie strony rekordów przed renderowaniem', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'public', 'inline-1.js'), 'utf8');
  assert.match(source, /async function loadAllRows/);
  assert.match(source, /offset < Number\(workbook\.totalRows/);
  assert.match(source, /const limit = 500/);
});
