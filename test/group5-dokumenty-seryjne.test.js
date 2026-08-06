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

test('anulowanie zatrzymuje CALA paczke szablonow, nie tylko biezacy proces (audyt v1.0.4, P1-2)', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  // /api/cancel/:jobId musi ustawiac flage sprawdzana przez petle wielo-
  // szablonowa - samo job.child.kill() zabijalo tylko AKTUALNY proces
  // PowerShell, a petla i tak ruszala z kolejnym szablonem w paczce.
  assert.match(source, /job\.cancelRequested = true;/);
  const cancelRoute = source.match(/app\.post\('\/api\/cancel\/:jobId'[\s\S]*?\n\}\);/);
  assert.ok(cancelRoute, 'nie znaleziono trasy /api/cancel/:jobId');
  assert.match(cancelRoute[0], /job\.cancelRequested = true;/);

  const loopFn = source.match(/async function runMultiTemplateGeneration[\s\S]*?\n\}/);
  assert.ok(loopFn, 'nie znaleziono runMultiTemplateGeneration');
  // Sprawdzenie flagi musi byc W SRODKU petli (przed kazdym kolejnym
  // szablonem), nie tylko raz przed jej rozpoczeciem.
  assert.match(loopFn[0], /for \(let i = 0; i < tasks\.length; i \+= 1\) \{\s*\n\s*\/\/[\s\S]*?if \(job\.cancelRequested\)/);
  assert.match(loopFn[0], /cancelledEarly = true/);
  assert.match(loopFn[0], /job\.status = cancelledEarly \? 'cancelled'/);
});

test('generate: kazde uruchomienie czysci poprzedni katalog wyjsciowy PO walidacji, przed faktycznym startem (audyt rozdz. 12, P0/P1)', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  const generateRoute = source.match(/app\.post\('\/api\/generate\/:jobId'[\s\S]*?\n\}\);/);
  assert.ok(generateRoute, "nie znaleziono trasy /api/generate/:jobId");
  const body = generateRoute[0];

  // Czyszczenie musi istniec i uzywac rm z recursive/force (nie zwykle
  // unlink - job.outputDir moze zawierac podkatalogi, np. logi debug).
  assert.match(body, /for \(const entry of await fsp\.readdir\(job\.outputDir\)\.catch\(\(\) => \[\]\)\) \{/);
  assert.match(body, /fsp\.rm\(path\.join\(job\.outputDir, entry\), \{ recursive: true, force: true \}\)/);

  // Kolejnosc w zrodle jest bezposrednim dowodem: walidacje (brakujace
  // kolumny, brak zadan) MUSZA wystapic PRZED czyszczeniem - nieudana proba
  // (np. zle dobrany arkusz) nie moze skasowac wynikow poprzedniego, udanego
  // uruchomienia. Czyszczenie z kolei MUSI wystapic PRZED wordQueue.run -
  // inaczej nowe pliki tworzone przez biezace uruchomienie zostalyby same
  // skasowane zaraz po powstaniu.
  const missingColumnsIndex = body.indexOf('missingColumns.length) {');
  const tasksLengthIndex = body.indexOf('!tasks.length) return');
  const cleanupIndex = body.indexOf('for (const entry of await fsp.readdir(job.outputDir)');
  const wordQueueRunIndex = body.indexOf('wordQueue.run(() => runMultiTemplateGeneration');
  assert.ok(missingColumnsIndex >= 0 && tasksLengthIndex >= 0 && cleanupIndex >= 0 && wordQueueRunIndex >= 0);
  assert.ok(missingColumnsIndex < cleanupIndex, 'walidacja kolumn musi byc przed czyszczeniem');
  assert.ok(tasksLengthIndex < cleanupIndex, 'walidacja zadan musi byc przed czyszczeniem');
  assert.ok(cleanupIndex < wordQueueRunIndex, 'czyszczenie musi byc przed faktycznym startem generowania');

  // job.result tez musi zostac wyzerowany - inaczej stary wynik (odnoszacy
  // sie do wlasnie skasowanych plikow) zostalby pokazany az do zakonczenia
  // nowego uruchomienia.
  assert.match(body, /job\.result = null;[\s\S]{0,40}job\.status = 'queued';/);
});

test('frontend pobiera wszystkie strony rekordów przed renderowaniem', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'public', 'inline-1.js'), 'utf8');
  assert.match(source, /async function loadAllRows/);
  assert.match(source, /offset < Number\(workbook\.totalRows/);
  assert.match(source, /const limit = 500/);
});
