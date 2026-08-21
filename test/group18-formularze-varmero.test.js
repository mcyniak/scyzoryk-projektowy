const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const appRoot = path.join(__dirname, '..', 'apps', 'formularze-varmero');
// import() dynamiczny na Windows wymaga URL-a file:// dla sciezek
// bezwzglednych z litera dysku (zwykly "C:\..." rzuca ERR_UNSUPPORTED_ESM_URL_SCHEME) -
// w odroznieniu od group4-ecodan.test.js, ktory uzywa sciezki wzglednej i
// dzieki temu tego nie potrzebuje.
function importSrc(...parts) {
  return import(pathToFileURL(path.join(appRoot, 'src', ...parts)).href);
}

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-varmero-'));
}

// --- rules.js -------------------------------------------------------------

test('rules.js parseOzc: odrzuca wieloznaczne wartosci (ten sam realny blad co Ecodan)', async () => {
  const { parseOzc } = await importSrc('rules.js');
  assert.equal(parseOzc('9.38').valid, true);
  assert.equal(parseOzc('9.38').ozcKw, 9.38);
  assert.equal(parseOzc('10+6').valid, false);
  assert.equal(parseOzc('7/8').valid, false);
  assert.equal(parseOzc('').present, false);
});

test('rules.js chooseHeatingType: wiekszosc grzejnikowa -> 55C, wiekszosc/rownowaga podlogowa -> 35C', async () => {
  const { chooseHeatingType } = await importSrc('rules.js');
  assert.equal(chooseHeatingType(70, 30), 'ogrzewanie średniotemperaturowe 55 ℃');
  assert.equal(chooseHeatingType(0, 100), 'ogrzewanie podłogowe 35 ℃');
  assert.equal(chooseHeatingType(50, 50), 'ogrzewanie podłogowe 35 ℃');
});

test('rules.js chooseVpmModel: dobiera najmniejszy model pokrywajacy OZC, zawsze needsConfirmation', async () => {
  const { chooseVpmModel } = await importSrc('rules.js');
  assert.equal(chooseVpmModel(9.38).model, 'VPM 9012');
  assert.equal(chooseVpmModel(24.68).model, 'VPM 9020');
  assert.equal(chooseVpmModel(5).needsConfirmation, true);
});

test('rules.js calculate: brak OZC oznacza niepoprawny wynik, nie domyslna wartosc', async () => {
  const { calculate } = await importSrc('rules.js');
  const missing = calculate({ ozc: '', radiatorsPercent: '0', floorPercent: '100' });
  assert.equal(missing.calculated.valid, false);
  assert.ok(missing.calculated.errors.length > 0);

  const ok = calculate({ ozc: '11.27', radiatorsPercent: '70', floorPercent: '30' });
  assert.equal(ok.calculated.valid, true);
  assert.equal(ok.calculated.heatingType, 'ogrzewanie średniotemperaturowe 55 ℃');
  assert.equal(ok.calculated.device.model, 'VPM 9012');
});

// --- excel.js (fixture budowany na biezaco, bez realnych danych klienta) ---
// UWAGA (2026-08-10): strefa klimatyczna/wojewodztwo BYLY wczesniej
// wyliczane z wewnetrznej tabeli gmina->strefa (gminaZones.js, usunieta) -
// wlasciciel slusznie zauwazyl, ze wymagaloby to recznego rozszerzania w
// kodzie przy kazdej nowej inwestycji. Teraz to zwykle parametry wejsciowe
// podawane raz na cala paczke (jak gminaName/postalCode), stad w testach
// nizej sa przekazywane wprost, nie "odgadywane" z nazwy gminy.

test('excel.js readTabelaAdresowa: czyta OZC/procenty ogrzewania, pomija wiersze bez OZC', async () => {
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx')); // xlsx tylko do zapisu fixture'ow testowych (bezpieczne) - patrz komentarz w group19-tworzenie-folderow.test.js
  const dir = await makeTempDir();
  const fixturePath = path.join(dir, 'fixture.xlsx');
  const rows = [
    ['LP', 'Imię i Nazwisko', 'Adres', 'Rodzaj pompy', 'Ogrzewanie grzejnikowe', 'Ogrzewanie podłogowe', 'OZC'],
    [1, 'Jan Testowy', 'Testowa 1', 'Powietrze-woda', 70, 30, '11.27'],
    ['', '', '', '', '', '', ''], // pusty wiersz W SRODKU (nie ostatni) - trafia do "uzywanego zakresu"
    // arkusza u obu bibliotek; calkowicie pusty wiersz NA SAMYM KONCU pliku
    // bywa przez read-excel-file (w odroznieniu od xlsx+aoa_to_sheet w
    // testach) traktowany jako poza zakresem danych i w ogole nie
    // zwracany - co i tak daje identyczny efekt koncowy (0 rekordow z tego
    // wiersza), tylko bez wpisu w liczniku skipped.empty.
    [2, 'Anna Bezoze', 'Testowa 2', 'Powietrze-woda', 0, 100, ''],
    [3, 'Bez Adresu', '', 'Powietrze-woda', '', '', '5']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Pompy ciepła');
  XLSX.writeFile(wb, fixturePath);

  const { readTabelaAdresowa } = await importSrc('excel.js');
  const result = await readTabelaAdresowa(fixturePath, { gminaName: 'Kamieńsk', postalCode: '97-360', zone: '3', wojewodztwo: 'Łódzkie' });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].input.name, 'Jan Testowy');
  assert.equal(result.records[0].input.ozcKw, 11.27);
  assert.equal(result.records[0].input.radiatorsPercent, 70);
  assert.equal(result.records[0].input.zone, 3);
  assert.equal(result.records[0].input.wojewodztwo, 'Łódzkie');
  assert.equal(result.skipped.missingOzc, 1);
  assert.equal(result.skipped.missingAddress, 1);
  assert.equal(result.skipped.empty, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('excel.js readTabelaAdresowa: kolumna LP obecna ale pusta w konkretnym wierszu jest pomijana (skipped.missingLp), nie podstawia cicho numeru wiersza (ten sam blad co naprawiony w tworzenie-folderow/drukarka-projekty)', async () => {
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx')); // xlsx tylko do zapisu fixture'ow testowych (bezpieczne) - patrz komentarz w group19-tworzenie-folderow.test.js
  const dir = await makeTempDir();
  const fixturePath = path.join(dir, 'fixture.xlsx');
  const rows = [
    ['LP', 'Imię i Nazwisko', 'Adres', 'Rodzaj pompy', 'Ogrzewanie grzejnikowe', 'Ogrzewanie podłogowe', 'OZC'],
    [1, 'Jan Testowy', 'Testowa 1', 'Powietrze-woda', 70, 30, '11.27'],
    ['', 'Puste LP', 'Testowa 2', 'Powietrze-woda', 70, 30, '9.5']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Pompy ciepła');
  XLSX.writeFile(wb, fixturePath);

  const { readTabelaAdresowa } = await importSrc('excel.js');
  const result = await readTabelaAdresowa(fixturePath, { zone: '3' });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].input.name, 'Jan Testowy');
  assert.equal(result.skipped.missingLp, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('excel.js readTabelaAdresowa: arkusz BEZ kolumny LP w ogole nadal dziala - fallback na numer wiersza pozostaje bezpieczny', async () => {
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx')); // xlsx tylko do zapisu fixture'ow testowych (bezpieczne) - patrz komentarz w group19-tworzenie-folderow.test.js
  const dir = await makeTempDir();
  const fixturePath = path.join(dir, 'fixture.xlsx');
  const rows = [
    ['Imię i Nazwisko', 'Adres', 'Rodzaj pompy', 'Ogrzewanie grzejnikowe', 'Ogrzewanie podłogowe', 'OZC'],
    ['Jan Testowy', 'Testowa 1', 'Powietrze-woda', 70, 30, '11.27']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Pompy ciepła');
  XLSX.writeFile(wb, fixturePath);

  const { readTabelaAdresowa } = await importSrc('excel.js');
  const result = await readTabelaAdresowa(fixturePath, { zone: '3' });

  assert.equal(result.records.length, 1);
  assert.equal(result.skipped.missingLp, 0);
  assert.equal(result.records[0].lp, '2');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('excel.js readTabelaAdresowa: kalkulator Varmero jest tylko dla pomp powietrznych - "Gruntowa" i brak/nieznana wartosc sa pomijane, NIGDY nie przechodza (realny blad zlapany w tej sesji - wszystkie 3 testowe zgloszenia na zywo mialy zly typ pompy)', async () => {
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx')); // xlsx tylko do zapisu fixture'ow testowych (bezpieczne) - patrz komentarz w group19-tworzenie-folderow.test.js
  const dir = await makeTempDir();
  const fixturePath = path.join(dir, 'fixture3.xlsx');
  const rows = [
    ['LP', 'Imię i Nazwisko', 'Adres', 'Rodzaj pompy', 'OZC'],
    [1, 'Powietrzny Testowy', 'Testowa 1', 'Powietrze-woda', '10'],
    [2, 'Gruntowy Testowy', 'Testowa 2', 'Gruntowa', '10'],
    [3, 'Bez Typu Testowy', 'Testowa 3', '', '10'],
    [4, 'Powietrzna Wariant', 'Testowa 4', 'Powietrzna', '10']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Pompy ciepła');
  XLSX.writeFile(wb, fixturePath);

  const { readTabelaAdresowa } = await importSrc('excel.js');
  const result = await readTabelaAdresowa(fixturePath, { gminaName: 'Kamieńsk', postalCode: '97-360' });

  assert.deepEqual(result.records.map(r => r.input.name), ['Powietrzny Testowy', 'Powietrzna Wariant']);
  assert.equal(result.skipped.notAirSourcePump, 2);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('excel.js readTabelaAdresowa: bez podanej strefy -> zoneKnown:false, wiersze nadal maja zone:null (nie zgaduje, nie wymyśla domyślnej strefy)', async () => {
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx')); // xlsx tylko do zapisu fixture'ow testowych (bezpieczne) - patrz komentarz w group19-tworzenie-folderow.test.js
  const dir = await makeTempDir();
  const fixturePath = path.join(dir, 'fixture2.xlsx');
  const rows = [
    ['LP', 'Imię i Nazwisko', 'Adres', 'Rodzaj pompy', 'OZC'],
    [1, 'Jan Testowy', 'Testowa 1', 'Powietrze-woda', '9.5']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Pompy ciepła');
  XLSX.writeFile(wb, fixturePath);

  const { readTabelaAdresowa } = await importSrc('excel.js');
  const result = await readTabelaAdresowa(fixturePath, {});
  assert.equal(result.zoneKnown, false);
  assert.equal(result.records[0].input.zone, null);

  const withInvalidZone = await readTabelaAdresowa(fixturePath, { zone: '9' });
  assert.equal(withInvalidZone.zoneKnown, false);

  await fsp.rm(dir, { recursive: true, force: true });
});

// --- jobs.js ----------------------------------------------------------------

test('jobs.js deriveSubmissionEmail: kazde wywolanie daje inny, unikalny adres plusowy (audyt v0.1.0 - naprawa realnego bledu dopasowania maila)', async () => {
  const { deriveSubmissionEmail } = await importSrc('jobs.js');
  const a = deriveSubmissionEmail('scyzorykprojektowy@gmail.com');
  const b = deriveSubmissionEmail('scyzorykprojektowy@gmail.com');
  assert.notEqual(a, b, 'dwa wywolania musza dac rozne adresy - to jest cala naprawa buga z tej sesji');
  assert.match(a, /^scyzorykprojektowy\+varmero-[0-9a-f]{24}@gmail\.com$/);
  assert.throws(() => deriveSubmissionEmail('bez-malpy'), /@/);
});

test('jobs.js runBatchJob: wskazany folder zapisu jest sprawdzany przy pomijaniu gotowych kart', async () => {
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx')); // xlsx tylko do zapisu fixture'ow testowych (bezpieczne) - patrz komentarz w group19-tworzenie-folderow.test.js
  const dir = await makeTempDir();
  const outputDir = path.join(dir, 'gotowe-karty');
  const fixturePath = path.join(dir, 'fixture-existing.xlsx');
  const rows = [
    ['LP', 'Imie i Nazwisko', 'Adres', 'Rodzaj pompy', 'OZC'],
    [1, 'Jan Testowy', 'Testowa 1', 'Powietrze-woda', '9.5']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Pompy ciepla');
  XLSX.writeFile(wb, fixturePath);

  const { readTabelaAdresowa } = await importSrc('excel.js');
  const { createJob, makePdfName, runBatchJob } = await importSrc('jobs.js');
  const parsed = await readTabelaAdresowa(fixturePath, { zone: '3' });
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(path.join(outputDir, makePdfName(parsed.records[0])), 'ISTNIEJACY PDF');

  const job = createJob({
    sourceFile: 'fixture-existing.xlsx',
    options: { investmentName: 'Inwestycja testowa', outputPath: outputDir, skipExisting: true, concurrency: 1 }
  });
  job.outputBase = path.join(dir, 'workspace');

  // selectedRows musi byc jawnie podane (audyt 2026-08-21: pusta/brakujaca
  // selekcja NIGDY nie oznacza "przetworz wszystko" - kazdy wiersz to
  // realne zgloszenie do zewnetrznego kalkulatora).
  await runBatchJob(job, fixturePath, { zone: '3', skipExisting: true, selectedRows: [parsed.records[0].rowNumber] });

  assert.equal(job.status, 'finished');
  assert.equal(job.pdfDir, outputDir);
  assert.equal(job.done, 1);
  assert.equal(job.ok, 0);
  assert.equal(job.skippedExisting, 1);
  assert.equal(job.results[0].skippedExisting, true);
  assert.equal(job.results[0].ok, true);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('jobs.js runBatchJob: pusta/brakujaca selectedRows NIGDY nie zglasza calej tabeli (audyt 2026-08-21, real incydent - przypadkowy start na 70 adresow)', async () => {
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx'));
  const dir = await makeTempDir();
  const fixturePath = path.join(dir, 'fixture-wielu-adresow.xlsx');
  const rows = [
    ['LP', 'Imie i Nazwisko', 'Adres', 'Rodzaj pompy', 'OZC'],
    [1, 'Jan Testowy', 'Testowa 1', 'Powietrze-woda', '9.5'],
    [2, 'Anna Testowa', 'Testowa 2', 'Powietrze-woda', '8.0']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Pompy ciepla');
  XLSX.writeFile(wb, fixturePath);

  const { createJob, runBatchJob } = await importSrc('jobs.js');
  const job = createJob({
    sourceFile: 'fixture-wielu-adresow.xlsx',
    options: { investmentName: 'Inwestycja testowa', outputPath: path.join(dir, 'gotowe-karty'), skipExisting: true, concurrency: 1 }
  });
  job.outputBase = path.join(dir, 'workspace');

  // selectedRows CELOWO pominiete - to dokladnie ksztalt bledu z incydentu.
  await runBatchJob(job, fixturePath, { zone: '3', skipExisting: true });

  assert.equal(job.total, 0, 'bez selectedRows job NIE moze przetworzyc obu adresow z pliku');
  assert.equal(job.status, 'finished');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('jobs.js pruneOldJobs: usuwa tylko STARE zakonczone zadania (>7 dni), nigdy aktywne ani niedawno zakonczone (audyt zuzycia RAM 2026-08-21)', async () => {
  const { jobs, pruneOldJobs, JOB_RETENTION_MS } = await importSrc('jobs.js');
  const staraData = new Date(Date.now() - JOB_RETENTION_MS - 60000).toISOString();
  const swiezaData = new Date().toISOString();

  jobs.set('test-stare-zakonczone', { id: 'test-stare-zakonczone', status: 'finished', finishedAt: staraData });
  jobs.set('test-swiezo-zakonczone', { id: 'test-swiezo-zakonczone', status: 'finished', finishedAt: swiezaData });
  jobs.set('test-aktywne-stare', { id: 'test-aktywne-stare', status: 'running', finishedAt: null, startedAt: staraData });

  try {
    pruneOldJobs();
    assert.equal(jobs.has('test-stare-zakonczone'), false, 'stare zakonczone zadanie powinno zostac usuniete');
    assert.equal(jobs.has('test-swiezo-zakonczone'), true, 'niedawno zakonczone zadanie musi zostac');
    assert.equal(jobs.has('test-aktywne-stare'), true, 'aktywne zadanie NIGDY nie moze zostac usuniete, niezaleznie od wieku');
  } finally {
    jobs.delete('test-stare-zakonczone');
    jobs.delete('test-swiezo-zakonczone');
    jobs.delete('test-aktywne-stare');
  }
});

// --- mailbox.js -------------------------------------------------------------

test('mailbox.js pickCardAttachment: wybiera "Varmero-podsumowanie-*.pdf" z 4 zalacznikow (dokladnie jak w realnym mailu z tej sesji)', async () => {
  const { pickCardAttachment } = await importSrc('mailbox.js');
  const attachments = [
    { filename: 'Varmero-podsumowanie-1786348226.pdf', content: Buffer.from('KARTA') },
    { filename: 'tabela-danych-technicznych-varmero-vpm-9012.pdf', content: Buffer.from('SPEC') },
    { filename: 'image001.png', content: Buffer.from('LOGO') },
    { filename: 'image002.png', content: Buffer.from('PASEK') }
  ];
  const picked = pickCardAttachment(attachments);
  assert.equal(picked.filename, 'Varmero-podsumowanie-1786348226.pdf');
  assert.equal(picked.content.toString(), 'KARTA');
  assert.equal(pickCardAttachment([{ filename: 'cos-innego.pdf' }]), undefined);
});

test('mailbox.js waitForVarmeroCard: ponawia proby i rzuca NoNewEmailError po timeout, gdy karta nie przychodzi', async () => {
  const { waitForVarmeroCard, NoNewEmailError } = await importSrc('mailbox.js');
  let connectCount = 0;
  const fakeClient = () => {
    connectCount += 1;
    return {
      connect: async () => {},
      list: async () => [{ path: 'INBOX' }, { path: '[Gmail]/Spam' }],
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => [],
      download: async () => { throw new Error('nie powinno byc wolane, gdy search() nic nie zwraca'); },
      logout: async () => {}
    };
  };
  await assert.rejects(
    () => waitForVarmeroCard({ imapConfig: {}, recipientEmail: 'test+varmero-abc123@gmail.com', timeoutMs: 900, pollIntervalMs: 250, createClient: fakeClient }),
    NoNewEmailError
  );
  assert.ok(connectCount >= 2, `oczekiwano co najmniej 2 prob polaczenia, bylo ${connectCount}`);
});

test('mailbox.js waitForVarmeroCard: przerywa oczekiwanie NATYCHMIAST (nie dopiero po pelnym timeoutcie) gdy isCancelled zwroci true (audyt 2026-08-21)', async () => {
  const { waitForVarmeroCard, CancelledWaitError } = await importSrc('mailbox.js');
  let connectCount = 0;
  const fakeClient = () => {
    connectCount += 1;
    return {
      connect: async () => {},
      list: async () => [{ path: 'INBOX' }],
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => [],
      download: async () => { throw new Error('nie powinno byc wolane'); },
      logout: async () => {}
    };
  };
  const start = Date.now();
  await assert.rejects(
    () => waitForVarmeroCard({
      imapConfig: {}, recipientEmail: 'test+varmero-abc123@gmail.com',
      // Timeout celowo dlugi (30 minut) - test musi zakonczyc sie SZYBKO
      // dzieki isCancelled, nie dzieki (nieosiagnietemu) timeoutowi.
      timeoutMs: 30 * 60 * 1000, pollIntervalMs: 20, createClient: fakeClient,
      isCancelled: () => connectCount >= 1
    }),
    CancelledWaitError
  );
  assert.ok(Date.now() - start < 5000, 'anulowanie musi przerwac oczekiwanie od razu, nie czekac na 30-minutowy timeout');
});

test('mailbox.js waitForVarmeroCard: znajduje karte w folderze Spam, gdy INBOX jest pusty (realny przypadek z tej sesji)', async () => {
  const { waitForVarmeroCard } = await importSrc('mailbox.js');
  const rawEmail = 'From: noreply@varmero.pl\r\nTo: test@example.com\r\nSubject: test\r\nContent-Type: multipart/mixed; boundary="X"\r\n\r\n--X\r\nContent-Type: text/plain\r\n\r\ntresc\r\n--X\r\nContent-Type: application/pdf; name="Varmero-podsumowanie-123.pdf"\r\nContent-Disposition: attachment; filename="Varmero-podsumowanie-123.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from('KARTA-ZE-SPAMU').toString('base64') + '\r\n--X--\r\n';

  const fakeClient = () => ({
    connect: async () => {},
    list: async () => [{ path: 'INBOX' }, { path: '[Gmail]/Spam' }],
    getMailboxLock: async (folderPath) => ({ release: () => {}, __folder: folderPath }),
    search: async function () { return this.__currentFolder === '[Gmail]/Spam' ? [7] : []; },
    download: async () => ({ content: Buffer.from(rawEmail) }),
    logout: async () => {}
  });
  // Prosty fake nie ma stanu per-folder w search() - zamiast tego symulujemy
  // to przez zamkniecie: przechwytujemy folder z getMailboxLock i ustawiamy
  // go na obiekcie klienta tuz przed kazdym search().
  const client = fakeClient();
  const originalLock = client.getMailboxLock;
  client.getMailboxLock = async (folderPath) => { client.__currentFolder = folderPath; return originalLock(folderPath); };

  const result = await waitForVarmeroCard({ imapConfig: {}, recipientEmail: 'test+varmero-abc123@gmail.com', timeoutMs: 2000, pollIntervalMs: 100, createClient: () => client });
  assert.equal(result.filename, 'Varmero-podsumowanie-123.pdf');
  assert.equal(result.buffer.toString(), 'KARTA-ZE-SPAMU');
  assert.equal(result.folder, '[Gmail]/Spam');
});
