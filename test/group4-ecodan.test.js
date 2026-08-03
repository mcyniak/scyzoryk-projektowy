const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('../apps/formularze-ecodan/node_modules/pdf-lib');

async function createPdf(filePath, pageCount) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([300, 400]);
  await fsp.writeFile(filePath, await document.save());
}

test('Ecodan zachowuje najwyżej pierwsze trzy strony', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-ecodan-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { keepFirstPdfPages } = await import('../apps/formularze-ecodan/src/pdfTrim.js');

  for (const inputPages of [1, 2, 3, 4, 5, 10]) {
    const filePath = path.join(dir, `${inputPages}.pdf`);
    await createPdf(filePath, inputPages);
    const result = await keepFirstPdfPages(filePath);
    const written = await PDFDocument.load(await fsp.readFile(filePath));
    assert.equal(written.getPageCount(), Math.min(inputPages, 3));
    assert.equal(result.keptPages, Math.min(inputPages, 3));
  }
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.includes('.backup-')), []);
});

test('pominiecie istniejacego raportu Ecodan nie modyfikuje/przycina pliku (audyt v1.0.4, P1-1)', async () => {
  // "Pomiń istniejące" ma oznaczać dosłownie brak jakichkolwiek zmian w pliku -
  // wcześniej ta gałąź otwierała i PRZYCINAŁA istniejący PDF do pierwszych 3
  // stron nawet gdy plik nie pochodził ze świeżego pobrania z Ecodana (mógł to
  // być ręcznie umieszczony/starszy raport). Ten test pilnuje, żeby ta gałąź
  // nigdy więcej nie wołała keepFirstPdfPages ani nie zwracała trimmedExisting.
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'formularze-ecodan', 'src', 'jobs.js'), 'utf8');
  const skipBranch = source.match(/if \(options\.skipExisting && await pathExists\(desiredPath\)\) \{[\s\S]*?\n  \}/);
  assert.ok(skipBranch, 'nie znaleziono gałęzi options.skipExisting w jobs.js');
  assert.doesNotMatch(skipBranch[0], /keepFirstPdfPages/);
  assert.match(skipBranch[0], /skippedExisting: true/);
  assert.doesNotMatch(source, /skippedExisting: true,\s*trimmedExisting: pdfTrim\.trimmed/);
});

// =====================================================================
// Walidacja danych wejsciowych (audyt v1.0.4, P0-2): puste/niejednoznaczne
// dane krytyczne dla doboru NIE moga po cichu isc dalej z domyslna wartoscia
// (6 kW, Slesin, grzejniki, zbiornik 200 l) - musza zablokowac operacje.
// =====================================================================

const validInput = {
  name: 'Jan Testowy', address: 'Testowa 1', location: '62-561 Ślesin',
  ozc: '7,8', municipalityPower: '9 kW', chosenPower: '',
  radiatorsShare: '60', floorShare: '40', cwuTank: '200 l', boilerRoomHeight: '2.2'
};

test('calculate(): kompletne dane sa poprawne, bez bledow blokujacych', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate(validInput);
  assert.equal(result.calculated.valid, true);
  assert.deepEqual(result.calculated.errors, []);
  assert.equal(result.calculated.selectedPowerKw, 10);
});

test('calculate(): pusta moc NIE wybiera juz cicho 6 kW, tylko blokuje', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, municipalityPower: '', chosenPower: '' });
  assert.equal(result.calculated.valid, false);
  assert.equal(result.calculated.selectedPowerKw, null);
  assert.ok(result.calculated.errors.some(e => /Brak mocy/.test(e)));
});

test('calculate(): niejednoznaczna moc "9/12 kW" jest odrzucana, nie sklejana w 912', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, municipalityPower: '9/12 kW', chosenPower: '' });
  assert.equal(result.calculated.valid, false);
  assert.equal(result.input.municipalityPower, 0);
  assert.ok(result.calculated.errors.some(e => /Nie rozumiem wartości "Moc pompy z gminy"/.test(e)));
});

test('calculate(): niejednoznaczna moc "10+6 kW" jest odrzucana, nie sklejana w 106', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, municipalityPower: '10+6 kW', chosenPower: '' });
  assert.equal(result.calculated.valid, false);
  assert.equal(result.input.municipalityPower, 0);
});

test('calculate(): brak lokalizacji blokuje, bez cichego fallbacku do Slesina', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, location: '' });
  assert.equal(result.calculated.valid, false);
  assert.ok(result.calculated.errors.some(e => /Brak lokalizacji/.test(e)));
});

test('calculate(): brak udzialu ogrzewania blokuje, zamiast cicho wybrac grzejniki (0 >= 0)', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, radiatorsShare: '', floorShare: '' });
  assert.equal(result.calculated.valid, false);
  assert.ok(result.calculated.errors.some(e => /udziału ogrzewania/.test(e)));
});

test('calculate(): brak zbiornika CWU blokuje, zamiast cicho przyjac 200 l', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, cwuTank: '' });
  assert.equal(result.calculated.valid, false);
  assert.ok(result.calculated.errors.some(e => /zbiornika CWU/.test(e)));
});

test('calculate(): brak wysokosci kotlowni NIE blokuje, ale daje widoczne ostrzezenie (wczesniej: cisza)', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, boilerRoomHeight: '' });
  assert.equal(result.calculated.valid, true);
  assert.ok(result.calculated.reasons.some(r => /Wysokość kotłowni nieznana/.test(r)));
});

test('calculate(): brak OZC blokuje (obrona w glab takze dla pojedynczego rekordu)', async () => {
  const { calculate } = await import('../apps/formularze-ecodan/src/rules.js');
  const result = calculate({ ...validInput, ozc: '' });
  assert.equal(result.calculated.valid, false);
  assert.ok(result.calculated.errors.some(e => /Brak OZC/.test(e)));
});

test('runAutomationInSession/runAutomation odmawiaja uruchomienia automatyzacji dla zablokowanych danych', async () => {
  const { runAutomation, runAutomationInSession } = await import('../apps/formularze-ecodan/src/jobs.js');
  const invalidInput = { ...validInput, municipalityPower: '', chosenPower: '' };

  const single = await runAutomation(invalidInput);
  assert.equal(single.ok, false);
  assert.equal(single.blocked, true);
  assert.match(single.error, /Brak mocy/);

  // Sesja jest tu tylko atrapa - blokada musi zadzialac ZANIM cokolwiek dotknie
  // strony/przegladarki, wiec fikcyjny obiekt session nigdy nie zostanie uzyty.
  const fakeSession = { page: null };
  const batch = await runAutomationInSession(invalidInput, fakeSession, os.tmpdir(), {});
  assert.equal(batch.ok, false);
  assert.equal(batch.blocked, true);
});

test('readExcelRecords: wiersze z brakujacymi danymi krytycznymi sa pomijane, nie generowane z domyslnymi wartosciami', async () => {
  const { rowToInput } = await import('../apps/formularze-ecodan/src/excel.js');
  // rowToInput samo w sobie nie odrzuca wierszy (to robi readExcelRecords po
  // odczycie calego arkusza) - tutaj sprawdzamy, ze surowe dane wejsciowe
  // faktycznie docieraja bez podmiany na wartosci domyslne przed walidacja.
  const row = { 'Adres': 'Testowa 5', 'OZC': '5', 'Moc pompy z gminy': '' };
  const input = rowToInput(row, '');
  assert.equal(input.municipalityPower, '');
  assert.equal(input.location, '');
});

test('indeks zadań i frontend obsługują restart oraz ostrzeżenie ścieżki', async () => {
  const jobsSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'formularze-ecodan', 'src', 'jobs.js'), 'utf8');
  const uiSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'formularze-ecodan', 'public', 'inline-1.js'), 'utf8');
  assert.match(jobsSource, /status: interrupted \? 'interrupted'/);
  assert.match(jobsSource, /interruptedReason: interrupted \? 'process-restarted'/);
  assert.match(jobsSource, /crypto\.randomUUID\(\)\}\.tmp/);
  assert.match(uiSource, /res\.status === 404/);
  assert.match(uiSource, /job\.status === 'interrupted'/);
  assert.match(uiSource, /job\.outputPathWarning/);
});
