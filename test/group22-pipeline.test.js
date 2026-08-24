// Testy nowej apki Pipeline inwestycji: analiza tabeli adresowej (reuzywa
// lib/investmentAddressTable.js, ten sam wzorzec fixture co
// test/group19-tworzenie-folderow.test.js), trwalosc przebiegow na dysku, i
// pollJob z childAppClient.js na zamockowanym fetch (sukces/blad/timeout).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('../apps/ocr-audytow/node_modules/xlsx');
const readXlsxFile = require('../apps/pipeline/node_modules/read-excel-file/node');
const { analyzujTabeleAdresowa, zbudujExcelWgSelekcji, przefiltrujOsobnaTabele, zbierzLpZGlownejTabeli, makeRunsStore, wykonajPrzebieg, przerwijPrzebieg } = require('../apps/pipeline/src/runs');
const { pollJob, getJson, ensureChildAppRunning, PORT_TO_PANEL_SLUG } = require('../apps/pipeline/src/childAppClient');

async function napiszArkusze(sheets) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-xlsx-'));
  const file = path.join(dir, 'dane.xlsx');
  const wb = XLSX.utils.book_new();
  for (const [sheetName, rows] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, file);
  return { dir, file };
}

// =====================================================================
// analyzujTabeleAdresowa (src/runs.js)
// =====================================================================

test('analyzujTabeleAdresowa: liczy adresy per typ instalacji na podstawie arkuszy, tak jak UI ma pokazywac dostepne kroki', async (t) => {
  const HEADER_POMPY = ['LP', 'Adres', 'Rodzaj pompy'];
  const HEADER_KOLEKTORY = ['ID', 'Adres'];
  const HEADER_KOTLY = ['LP', 'Adres'];
  const { dir, file } = await napiszArkusze([
    ['Pompy', [HEADER_POMPY, ['1', 'Testowa 1', 'Gruntowa'], ['2', 'Testowa 2', 'Powietrze-woda'], ['3', 'Testowa 3', 'Powietrze-woda'], ['4', 'Testowa 4', 'nieznany typ']]],
    ['Solary Paradyż', [HEADER_KOLEKTORY, ['10', 'Kolektorowa 1'], ['11', 'Kolektorowa 2']]],
    ['Kotły', [HEADER_KOTLY, ['20', 'Kotlowa 1']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const wynik = await analyzujTabeleAdresowa(file);
  assert.deepEqual(wynik.podsumowanie, {
    pompyPowietrzne: 2,
    pompyGrunt: 1,
    pompyNieznane: 1,
    kolektory: 2,
    kotly: 1
  });
  assert.equal(wynik.sheets.length, 3);
  assert.deepEqual(wynik.sheetNames.sort(), ['Kotły', 'Pompy', 'Solary Paradyż'].sort());
});

test('analyzujTabeleAdresowa: arkusz bez rozpoznanego typu (np. "Notatki") jest po cichu pomijany, nie liczy sie do zadnej kategorii', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Notatki', [['cos innego, nie tabela adresowa']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const wynik = await analyzujTabeleAdresowa(file);
  assert.equal(wynik.sheets.length, 0);
  assert.deepEqual(wynik.podsumowanie, { pompyPowietrzne: 0, pompyGrunt: 0, pompyNieznane: 0, kolektory: 0, kotly: 0 });
});

// =====================================================================
// makeRunsStore (src/runs.js) - trwalosc na dysku
// =====================================================================

test('makeRunsStore: create/get/update dzialaja w pamieci i zapisuja sie na dysk (runs.json)', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-runs-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const store = makeRunsStore({ dataDir });
  const run = store.create({ excelPath: 'x.xlsx' });
  assert.equal(run.status, 'running');
  assert.ok(run.id);

  store.upsertKrok(run.id, 'test-krok', { status: 'skonczony' });
  const zaktualizowany = store.get(run.id);
  assert.equal(zaktualizowany.kroki.length, 1);
  assert.equal(zaktualizowany.kroki[0].nazwa, 'test-krok');

  const zawartoscPliku = JSON.parse(await fsp.readFile(path.join(dataDir, 'runs.json'), 'utf8'));
  assert.equal(zawartoscPliku.runs.length, 1);
  assert.equal(zawartoscPliku.runs[0].id, run.id);
});

test('makeRunsStore: upsertKrok aktualizuje TEN SAM wpis w miejscu (np. przy zywym postepie pollowania), nie dubluje go przy kazdym wywolaniu', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-runs-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const store = makeRunsStore({ dataDir });
  const run = store.create({});
  store.upsertKrok(run.id, 'dobor-myEcodan', { status: 'w-toku', procent: 10 });
  store.upsertKrok(run.id, 'dobor-myEcodan', { status: 'w-toku', procent: 40 });
  store.upsertKrok(run.id, 'dobor-myEcodan', { status: 'skonczony', procent: 100 });

  const zaktualizowany = store.get(run.id);
  assert.equal(zaktualizowany.kroki.length, 1, 'trzy wywolania tej samej nazwy kroku daja JEDEN wpis, nie trzy');
  assert.equal(zaktualizowany.kroki[0].status, 'skonczony');
  assert.equal(zaktualizowany.kroki[0].procent, 100);
});

// =====================================================================
// zbudujExcelWgSelekcji (src/runs.js) - filtrowanie adresow do wybranego
// podzbioru dla apek bez wlasnego wsparcia zaznaczania wierszy
// =====================================================================

test('zbudujExcelWgSelekcji: bez selekcji (albo pusty obiekt) zwraca oryginalna sciezke bez kopiowania', async (t) => {
  const { dir, file } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'A'], ['2', 'B']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const wynikBrak = await zbudujExcelWgSelekcji({ sourcePath: file, outputPath: path.join(dir, 'out.xlsx'), selection: null });
  assert.equal(wynikBrak, file);
  const wynikPusty = await zbudujExcelWgSelekcji({ sourcePath: file, outputPath: path.join(dir, 'out.xlsx'), selection: {} });
  assert.equal(wynikPusty, file);
});

test('zbudujExcelWgSelekcji: selekcja rowna calemu zbiorowi (nic nie odznaczono) tez zwraca oryginal, bez zbednej pracy', async (t) => {
  const { dir, file } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'A'], ['2', 'B']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const wynik = await zbudujExcelWgSelekcji({ sourcePath: file, outputPath: path.join(dir, 'out.xlsx'), selection: { Pompy: [1, 2] } });
  assert.equal(wynik, file);
});

test('zbudujExcelWgSelekcji: prawdziwe zawezenie buduje nowy plik z TYLKO zaznaczonymi adresami, naglowek zostaje', async (t) => {
  const { dir, file } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'Testowa 1'], ['2', 'Testowa 2'], ['3', 'Testowa 3']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const outputPath = path.join(dir, 'out.xlsx');
  const wynik = await zbudujExcelWgSelekcji({ sourcePath: file, outputPath, selection: { Pompy: [2] } });
  assert.equal(wynik, outputPath);

  const przefiltrowane = await readXlsxFile(outputPath, { getSheets: true });
  const wiersze = przefiltrowane.find(a => a.sheet === 'Pompy').data;
  assert.deepEqual(wiersze, [['LP', 'Adres'], ['2', 'Testowa 2']]);
});

// =====================================================================
// przefiltrujOsobnaTabele / zbierzLpZGlownejTabeli (src/runs.js) -
// osobna tabela dokumentow seryjnych zawezana do zaznaczonych adresow
// (zadane na zywo 2026-08-24; ID w wzorze = LP/ID glownej tabeli tej
// samej inwestycji - potwierdzone na realnych danych Kazimierz/Slesin)
// =====================================================================

test('przefiltrujOsobnaTabele: zostawia tylko wiersze z ID nalezacym do zaznaczonych LP, raportuje pominiete i puste arkusze', async (t) => {
  // Arkusze = moce ("8kW", "10kW ROZ 300" - pusty), kolumny jak w realnym wzorze
  const { dir, file } = await napiszArkusze([
    ['8kW', [['ID', 'Adres', 'Beneficjent'], ['1', 'Testowa 1', 'A Kowalski'], ['2', 'Testowa 2', 'B Nowak'], ['99', 'Testowa 99', 'Z Obcy']]],
    // arkusz mocy z naglowkiem, ale bez zadnego wiersza danych
    ['10kW ROZ 300', [['ID', 'Adres', 'Beneficjent']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const wynik = await przefiltrujOsobnaTabele({
    sourcePath: file,
    outputPath: path.join(dir, 'przefiltrowana.xlsx'),
    zaznaczoneLp: new Set(['1']) // uzytkownik zaznaczyl tylko LP 1
  });
  assert.equal(wynik.dopasowano, 1);
  assert.deepEqual(wynik.pominieteId.sort(), ['2', '99']);
  assert.deepEqual(wynik.pusteArkusze, ['10kW ROZ 300']);

  const arkusze = await readXlsxFile(wynik.outputPath, { getSheets: true });
  const osiem = arkusze.find(a => a.sheet === '8kW').data;
  assert.deepEqual(osiem, [['ID', 'Adres', 'Beneficjent'], ['1', 'Testowa 1', 'A Kowalski']]);
});

test('przefiltrujOsobnaTabele: zero dopasowan raportuje dopasowano=0 (wywolujacy rzuca wtedy blad - osobna tabela z innej inwestycji)', async (t) => {
  const { dir, file } = await napiszArkusze([['8kW', [['ID', 'Adres', 'Beneficjent'], ['500', 'Obca 1', 'X Y']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const wynik = await przefiltrujOsobnaTabele({
    sourcePath: file,
    outputPath: path.join(dir, 'out.xlsx'),
    zaznaczoneLp: new Set(['1', '2'])
  });
  assert.equal(wynik.dopasowano, 0);
  assert.deepEqual(wynik.pominieteId, ['500']);
});

test('zbierzLpZGlownejTabeli: zbiera LP/ID ze wszystkich rozpoznanych arkuszy glownej tabeli', async (t) => {
  const HEADER_POMPY = ['LP', 'Adres', 'Rodzaj pompy'];
  const HEADER_KOLEKTORY = ['ID', 'Adres'];
  const { dir, file } = await napiszArkusze([
    ['Pompy ciepła', [HEADER_POMPY, ['1', 'Testowa 1', 'Powietrze-woda'], ['2', 'Testowa 2', 'Gruntowa']]],
    ['Solary', [HEADER_KOLEKTORY, ['10', 'Kolektorowa 1'], ['11', 'Kolektorowa 2']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const lp = await zbierzLpZGlownejTabeli(file);
  assert.deepEqual([...lp].sort(), ['1', '10', '11', '2']);
});

test('makeRunsStore: restore() wczytuje przebiegi z poprzedniej sesji, oznacza przerwany "running" jako "przerwany-restartem" (patrz Ryzyko trwalosci stanu w planie)', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-runs-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const pierwszy = makeRunsStore({ dataDir });
  const run = pierwszy.create({ excelPath: 'x.xlsx' });
  const drugiRunDokonczony = pierwszy.create({ excelPath: 'y.xlsx' });
  pierwszy.update(drugiRunDokonczony.id, r => { r.status = 'skonczony'; });

  // Symulacja restartu procesu - nowy store czyta ten sam dataDir.
  const drugi = makeRunsStore({ dataDir });
  const przywroconyPrzerwany = drugi.get(run.id);
  const przywroconyDokonczony = drugi.get(drugiRunDokonczony.id);

  assert.equal(przywroconyPrzerwany.status, 'przerwany-restartem', 'run ktory byl "running" w momencie zapisu nigdy sam sie nie dokonczy po restarcie');
  assert.equal(przywroconyDokonczony.status, 'skonczony', 'run juz dokonczony przed restartem zostaje bez zmian');
});

// =====================================================================
// pollJob (src/childAppClient.js) - na zamockowanym fetch
// =====================================================================

test('pollJob: zwraca job od razu po pierwszym "done", bez zbednego czekania', async (t) => {
  const oryginalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, job: { status: 'done', wynik: 42 } }) });
  t.after(() => { global.fetch = oryginalFetch; });

  const job = await pollJob({ statusUrl: 'http://localhost/status', isDone: j => j.status === 'done', isError: j => j.status === 'error', intervalMs: 10 });
  assert.equal(job.wynik, 42);
});

test('pollJob: rzuca czytelny blad, gdy status jest "error"', async (t) => {
  const oryginalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, job: { status: 'error', errorMessage: 'Cos nie wyszlo' } }) });
  t.after(() => { global.fetch = oryginalFetch; });

  await assert.rejects(
    pollJob({ statusUrl: 'http://localhost/status', isDone: j => j.status === 'done', isError: j => j.status === 'error', intervalMs: 10 }),
    /Cos nie wyszlo/
  );
});

test('pollJob: przekracza limit czasu, gdy status nigdy nie dochodzi do konca', async (t) => {
  const oryginalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, job: { status: 'running' } }) });
  t.after(() => { global.fetch = oryginalFetch; });

  await assert.rejects(
    pollJob({ statusUrl: 'http://localhost/status', isDone: j => j.status === 'done', isError: j => j.status === 'error', intervalMs: 10, timeoutMs: 30 }),
    /limit czasu/
  );
});

test('getJson: odpowiedz 2xx BEZ "ok:true" (cialo puste/niepoprawne/nieoczekiwany ksztalt) jest bledem, nie cichym sukcesem (audyt 2026-08-21)', async (t) => {
  const oryginalFetch = global.fetch;
  t.after(() => { global.fetch = oryginalFetch; });

  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(getJson('http://localhost/status'));

  global.fetch = async () => ({ ok: true, json: async () => { throw new Error('nie-json'); } });
  await assert.rejects(getJson('http://localhost/status'));

  global.fetch = async () => ({ ok: true, json: async () => ({ status: 'jakis-inny-ksztalt-bez-ok' }) });
  await assert.rejects(getJson('http://localhost/status'));
});

// Audyt zuzycia RAM 2026-08-21 (lazy-start): apki-dzieci juz nie startuja
// automatycznie przy starcie Scyzoryka - Pipeline musi wiec samo poprosic
// panel o start konkretnej apki PRZED jej prawdziwym wywolaniem, inaczej
// pierwszy krok dla apki, ktorej nikt nigdy recznie nie otworzyl, dostalby
// "connection refused".
test('childAppClient ensureChildAppRunning: prosi panel o start znanej apki i czeka az bedzie running, no-op dla nieznanego portu', async (t) => {
  const oryginalFetch = global.fetch;
  t.after(() => { global.fetch = oryginalFetch; });

  const calls = [];
  let apiAppsCallCount = 0;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/start')) return { ok: true, json: async () => ({ ok: true }) };
    if (String(url).endsWith('/api/apps')) {
      apiAppsCallCount += 1;
      // Symuluje apke, ktora staje sie gotowa dopiero przy DRUGIM sprawdzeniu.
      return { ok: true, json: async () => ({ ok: true, apps: [{ slug: 'karty-katalogowe', running: apiAppsCallCount >= 2 }] }) };
    }
    throw new Error(`nieoczekiwane wywolanie fetch: ${url}`);
  };

  await ensureChildAppRunning('http://127.0.0.1:59999/api/run');
  assert.equal(calls.length, 0, 'nieznany port (spoza rejestru apek Scyzoryka) nie powinien w ogole pytac panelu');

  await ensureChildAppRunning('http://127.0.0.1:3006/api/run');
  assert.ok(calls.some(u => u.includes('/api/apps/karty-katalogowe/start')), 'powinien zawolac start dla karty-katalogowe (port 3006)');
  assert.ok(apiAppsCallCount >= 2, 'powinien odpytywac /api/apps az apka bedzie running');

  const wywolaniaPrzed = calls.length;
  await ensureChildAppRunning('http://127.0.0.1:3006/api/status/123');
  assert.equal(calls.length, wywolaniaPrzed, 'druga apka o tym samym slug (ten sam port) nie powinna ponownie pytac panelu - cache');
});

test('childAppClient: PORT_TO_PANEL_SLUG zawiera wszystkie apki-dzieci, ktore Pipeline faktycznie woloa (bez formularze-ecodan/varmero i pieczatki-pdf tez sa tu na wszelki wypadek)', () => {
  for (const slug of ['karty-katalogowe', 'tworzenie-folderow', 'dokumenty-seryjne', 'formularze-ecodan', 'formularze-varmero']) {
    assert.ok(Object.values(PORT_TO_PANEL_SLUG).includes(slug), `brakuje "${slug}" w mapie port->slug`);
  }
});

// =====================================================================
// wykonajPrzebieg (src/runs.js) - orkiestracja krokow, na zamockowanym fetch
// =====================================================================

test('wykonajPrzebieg: audyty dzialaja NIEZALEZNIE per typ (Solary/Pompy) - audyt 2026-08-21, zgloszenie wlasciciela "jak wrzuci sie tabele gdzie sa i pompy i kolektory to nie moge wybrac ktore z nich chce zrobic"', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-run-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const { dir, file: excelPath } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'A']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const wywolania = [];
  const oryginalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = opts?.body;
    const typ = body && typeof body.get === 'function' ? body.get('typ') : null;
    const rootPath = body && typeof body.get === 'function' ? body.get('rootPath') : null;
    wywolania.push({ typ, rootPath });
    return { ok: true, json: async () => ({ ok: true, jobId: 'x', podsumowanie: {}, wyniki: [] }) };
  };
  t.after(() => { global.fetch = oryginalFetch; });

  const store = makeRunsStore({ dataDir });
  // Uzytkownik zaznaczyl audyty TYLKO dla Pomp, mimo ze podal sciezki dla
  // OBU typow (rootPathSolary tez wypelniony) - przed poprawka audyty
  // ignorowaly ten wybor i szly do obu rootow, gdy tylko sciezka byla
  // niepusta.
  const run = store.create({
    excelPath,
    rootPathSolary: 'C:/solary',
    rootPathPompy: 'C:/pompy',
    audytyPath: 'C:/audyty',
    kroki: { audytySolary: false, audytyPompy: true, dokSeryjneSolary: false, dokSeryjnePompy: false, solary: false, pompy: false, tworzenieFolderow: false },
    generatory: {}
  });

  await wykonajPrzebieg(store, run.id, { przypisywanie: 'http://child' });

  const wywolaniaAudyty = wywolania.filter(w => w.typ === 'audyty');
  assert.equal(wywolaniaAudyty.length, 1, 'tylko JEDNO wywolanie typu audyty - dla Pomp, nie dla Solary');
  assert.equal(wywolaniaAudyty[0].rootPath, 'C:/pompy');
});

test('wykonajPrzebieg: dokumenty seryjne wysylaja WLASNA, oddzielna tabele Excel (nie glowna tabele adresowa) i biora szablony z folderu wzor wyliczonego z rootPathPompy (audyt 2026-08-21, zgloszenie wlasciciela)', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-run-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const { dir, file: excelPath } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'A']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { dir: dokSeryjneDir, file: dokSeryjneExcelPompy } = await napiszArkusze([['Beneficjenci', [['ID', 'Adres', 'Beneficjent'], ['1', 'A', 'Jan Kowalski']]]]);
  t.after(() => fsp.rm(dokSeryjneDir, { recursive: true, force: true }));

  // Struktura folderow jak w karty-katalogowe: rootPathPompy/PC powietrzne/wzor
  // (patrz lib/wzorFolderResolve.js#znajdzFolderyPomp) - potwierdzone przez
  // wlasciciela ze to TEN SAM folder "wzor", w ktorym siedza tez szablony
  // Word dla dokumentow seryjnych.
  const rootPathPompy = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-root-'));
  t.after(() => fsp.rm(rootPathPompy, { recursive: true, force: true }));
  const wzorDir = path.join(rootPathPompy, 'PC powietrzne', 'wzór');
  await fsp.mkdir(wzorDir, { recursive: true });
  await fsp.writeFile(path.join(wzorDir, 'szablon.docx'), 'x');

  const AdmZip = require('../apps/pipeline/node_modules/adm-zip');
  const pustyZipBuffer = new AdmZip().toBuffer();

  const wywolaneUploadEcxelName = [];
  const wywolaneGeneraty = [];
  const oryginalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/upload')) {
      const excelBlob = opts.body.get('excel');
      wywolaneUploadEcxelName.push(excelBlob.name);
      return { ok: true, json: async () => ({
        ok: true, jobId: 'job-1',
        // Realny ksztalt odpowiedzi /api/upload dokumentow-seryjnych
        workbook: { sheetNames: ['Beneficjenci'] },
        templateGroups: [{ name: 'PT', hasVariants: false, variants: { Beneficjenci: {} }, single: null }]
      }) };
    }
    if (u.includes('/api/generate/')) {
      wywolaneGeneraty.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (u.includes('/api/job/')) return { ok: true, json: async () => ({ ok: true, status: 'done', result: { created: [] } }) };
    if (u.includes('/api/download/')) return { ok: true, arrayBuffer: async () => pustyZipBuffer.buffer.slice(pustyZipBuffer.byteOffset, pustyZipBuffer.byteOffset + pustyZipBuffer.byteLength) };
    if (u.includes('/api/run')) return { ok: true, json: async () => ({ ok: true, jobId: 'x', podsumowanie: {}, wyniki: [] }) };
    throw new Error('nieoczekiwane wywolanie: ' + u);
  };
  t.after(() => { global.fetch = oryginalFetch; });

  const store = makeRunsStore({ dataDir });
  const run = store.create({
    excelPath,
    rootPathPompy,
    dokSeryjneExcelPompy,
    dokSeryjneTemplatesPompy: [path.join(wzorDir, 'szablon.docx')],
    kroki: { dokSeryjnePompy: true, dokSeryjneSolary: false, audytySolary: false, audytyPompy: false, solary: false, pompy: false, tworzenieFolderow: false },
    generatory: {}
  });

  await wykonajPrzebieg(store, run.id, { przypisywanie: 'http://child', dokumentySeryjne: 'http://ds' });

  assert.equal(wywolaneUploadEcxelName.length, 1, 'dokladnie jedno wgranie do dokumentow seryjnych');
  assert.ok(wywolaneUploadEcxelName[0].endsWith('tabela-przefiltrowana.xlsx'), 'wgrany plik to PRZEFILTROWANA osobna tabela (tylko zaznaczone adresy)');
  assert.deepEqual(wywolaneGeneraty.map(g => g.sheetName), ['Beneficjenci'], 'generate idzie na arkusz z powiazania szablonu');

  const zaktualizowany = store.get(run.id);
  const krokDs = zaktualizowany.kroki.find(k => k.nazwa === 'dokumenty-seryjne-pompy');
  assert.equal(krokDs?.status, 'skonczony');
  assert.ok(krokDs?.komunikat?.includes('dopasowano 1'), `komunikat raportuje filtracje: ${krokDs?.komunikat}`);
});

test('wykonajPrzebieg: dokumenty seryjne BEZ wskazanej osobnej tabeli spadaja na glowna tabele adresowa (audyt 2026-08-21 - dla niektorych inwestycji glowna tabela juz wystarcza, user sam wybiera per typ w UI)', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-run-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const { dir, file: excelPath } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'A']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const rootPathPompy = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-root-'));
  t.after(() => fsp.rm(rootPathPompy, { recursive: true, force: true }));
  const wzorDir = path.join(rootPathPompy, 'PC powietrzne', 'wzór');
  await fsp.mkdir(wzorDir, { recursive: true });
  await fsp.writeFile(path.join(wzorDir, 'szablon.docx'), 'x');

  const AdmZip = require('../apps/pipeline/node_modules/adm-zip');
  const pustyZipBuffer = new AdmZip().toBuffer();

  const wywolaneUploadEcxelName = [];
  const wywolaneGeneraty = [];
  const oryginalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/upload')) {
      wywolaneUploadEcxelName.push(opts.body.get('excel').name);
      return { ok: true, json: async () => ({
        ok: true, jobId: 'job-1',
        workbook: { sheetNames: ['Pompy'] },
        templateGroups: [{ name: 'DS', hasVariants: false, variants: { Pompy: {} }, single: null }]
      }) };
    }
    if (u.includes('/api/generate/')) {
      wywolaneGeneraty.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (u.includes('/api/job/')) return { ok: true, json: async () => ({ ok: true, status: 'done', result: { created: [] } }) };
    if (u.includes('/api/download/')) return { ok: true, arrayBuffer: async () => pustyZipBuffer.buffer.slice(pustyZipBuffer.byteOffset, pustyZipBuffer.byteOffset + pustyZipBuffer.byteLength) };
    if (u.includes('/api/run')) return { ok: true, json: async () => ({ ok: true, jobId: 'x', podsumowanie: {}, wyniki: [] }) };
    throw new Error('nieoczekiwane wywolanie: ' + u);
  };
  t.after(() => { global.fetch = oryginalFetch; });

  const store = makeRunsStore({ dataDir });
  const run = store.create({
    excelPath,
    rootPathPompy,
    // dokSeryjneExcelPompy CELOWO pominiete - user wybral "uzyj glownej tabeli".
    dokSeryjneTemplatesPompy: [path.join(wzorDir, 'szablon.docx')],
    kroki: { dokSeryjnePompy: true, dokSeryjneSolary: false, audytySolary: false, audytyPompy: false, solary: false, pompy: false, tworzenieFolderow: false },
    generatory: {}
  });

  await wykonajPrzebieg(store, run.id, { przypisywanie: 'http://child', dokumentySeryjne: 'http://ds' });

  assert.equal(wywolaneUploadEcxelName[0], path.basename(excelPath), 'bez osobnej tabeli, wgrana zostaje GLOWNA tabela adresowa');
  assert.deepEqual(wywolaneGeneraty.map(g => g.sheetName), ['Pompy'], 'generate idzie na arkusz z powiazania szablonu');
  assert.equal(store.get(run.id).kroki.find(k => k.nazwa === 'dokumenty-seryjne-pompy')?.status, 'skonczony');
});

// Zadane na zywo 2026-08-24: arkusze tabeli wzorowej to MOCE - generowanie
// idzie petla per moc (generate czysci outputDir, wiec ZIP musi zejsc miedzy
// iteracjami), a arkusz/moc bez szablonu jest pomijana z raportem.
test('krokDokumentySeryjne: petla po mocach (arkusz x szablon), ZIP po kazdej mocy, pominieta moc raportowana', async (t) => {
  const { dir, file } = await napiszArkusze([['szablon.docx', [['x']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const templatePath = path.join(dir, 'szablon.docx');
  await fsp.writeFile(templatePath, 'x');

  const AdmZip = require('../apps/pipeline/node_modules/adm-zip');
  const pustyZipBuffer = new AdmZip().toBuffer();
  const generaty = [];
  const pobraniaZip = [];
  const oryginalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/upload')) {
      return { ok: true, json: async () => ({
        ok: true, jobId: 'job-multi',
        workbook: { sheetNames: ['8kW', '10kW', '12kW'] },
        templateGroups: [
          { name: 'A', hasVariants: false, variants: { '8kW': {}, '10kW': {}, '20kW': {} }, single: null }
        ]
      }) };
    }
    if (u.includes('/api/generate/')) {
      generaty.push(JSON.parse(opts.body).sheetName);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (u.includes('/api/job/')) return { ok: true, json: async () => ({ ok: true, status: 'done', result: { created: [{ file: 'a.pdf' }] } }) };
    if (u.includes('/api/download/')) { pobraniaZip.push(String(u)); return { ok: true, arrayBuffer: async () => pustyZipBuffer.buffer.slice(pustyZipBuffer.byteOffset, pustyZipBuffer.byteOffset + pustyZipBuffer.byteLength) }; }
    throw new Error('nieoczekiwane wywolanie: ' + u);
  };
  t.after(() => { global.fetch = oryginalFetch; });

  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-ds-multi-'));
  t.after(() => fsp.rm(stagingDir, { recursive: true, force: true }));

  const { krokDokumentySeryjne } = require('../apps/pipeline/src/steps');
  const wynik = await krokDokumentySeryjne({
    baseUrl: 'http://ds',
    excelPath: file,
    templatePaths: [templatePath],
    stagingDir
  });

  assert.deepEqual(generaty, ['8kW', '10kW'], 'generate dla KAZDEJ mocy z para arkusz+szablon, w kolejnosci arkuszy');
  assert.equal(pobraniaZip.length, 2, 'ZIP pobrany PO kazdej mocy (zanim nastepna skasuje outputDir)');
  assert.deepEqual(wynik.moce, ['8kW', '10kW']);
  assert.deepEqual(wynik.pominieteArkusze, ['12kW'], 'arkusz tabeli bez szablonu -> pominiety');
  assert.deepEqual(wynik.pominieteMoce, ['20kW'], 'szablon bez arkusza w tabeli -> pominiety');
  assert.ok(fs.existsSync(path.join(stagingDir, '8kW')) && fs.existsSync(path.join(stagingDir, '10kW')), 'wyniki rozpakowane do osobnych podfolderow per moc');
  assert.equal(wynik.plikiRazem, 2);
});

test('krokDokumentySeryjne: status "interrupted" (restart apki w trakcie) konczy pollowanie bledem, nie zawieszeniem', async (t) => {
  const { dir, file } = await napiszArkusze([['szablon.docx', [['x']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const templatePath = path.join(dir, 'szablon.docx');
  await fsp.writeFile(templatePath, 'x');

  const oryginalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/upload')) return { ok: true, json: async () => ({ ok: true, jobId: 'job-i', workbook: { sheetNames: ['8kW'] }, templateGroups: [{ name: 'A', hasVariants: false, variants: { '8kW': {} }, single: null }] }) };
    if (u.includes('/api/generate/')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('/api/job/')) return { ok: true, json: async () => ({ ok: true, status: 'interrupted' }) };
    throw new Error('nieoczekiwane wywolanie: ' + u);
  };
  t.after(() => { global.fetch = oryginalFetch; });

  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-ds-int-'));
  t.after(() => fsp.rm(stagingDir, { recursive: true, force: true }));

  const { krokDokumentySeryjne } = require('../apps/pipeline/src/steps');
  await assert.rejects(
    krokDokumentySeryjne({ baseUrl: 'http://ds', excelPath: file, templatePaths: [templatePath], stagingDir }),
    /Zadanie zakonczylo sie bledem/
  );
});

// =====================================================================
// "Przerwij przebieg" - audyt 2026-08-21, real incydent (przypadkowy start
// dla 70 adresow, brak przycisku przerwania w UI)
// =====================================================================

test('wykonajPrzebieg: jobId generatora jest zapisywany do stanu przebiegu NATYCHMIAST po starcie, jeszcze W TRAKCIE pollowania - nie dopiero po calym zgloszeniu', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-run-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const { dir, file: excelPath } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'A']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const store = makeRunsStore({ dataDir });
  const run = store.create({
    excelPath,
    kroki: {},
    generatory: { myEcodan: true },
    opcjeDoboru: { myEcodan: {} }
  });

  let sprawdzeniaWTrakcie = 0;
  let jobIdWidocznyWTrakciePollowania = false;
  const oryginalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/batch/start')) return { ok: true, json: async () => ({ ok: true, jobId: 'job-real-70-adresow' }) };
    if (u.includes('/api/batch/status/')) {
      sprawdzeniaWTrakcie += 1;
      // Sprawdzamy TU, W TRAKCIE pollowania (przed "finished") - dokladnie
      // ten moment, w ktorym real incydent nie mial jak anulowac zgloszenia,
      // bo store.get(runId).generatory.myEcodan.jobId byl jeszcze pusty.
      if (store.get(run.id).generatory.myEcodan?.jobId === 'job-real-70-adresow') jobIdWidocznyWTrakciePollowania = true;
      const gotowy = sprawdzeniaWTrakcie >= 2;
      return { ok: true, json: async () => ({ ok: true, job: { status: gotowy ? 'finished' : 'running', done: gotowy ? 70 : 8, total: 70 } }) };
    }
    throw new Error('nieoczekiwane wywolanie: ' + u);
  };
  t.after(() => { global.fetch = oryginalFetch; });

  await wykonajPrzebieg(store, run.id, { myEcodan: 'http://ecodan' });

  assert.ok(sprawdzeniaWTrakcie >= 2, 'polling faktycznie zapytal wiecej niz raz');
  assert.ok(jobIdWidocznyWTrakciePollowania, 'jobId musi byc widoczny w stanie przebiegu JUZ W TRAKCIE pollowania, nie dopiero po zakonczeniu');
});

test('przerwijPrzebieg: anuluje aktywny job generatora przez jego wlasne /api/batch/cancel i oznacza przebieg jako przerwany', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-run-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const wywolaneAnulowania = [];
  const oryginalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/batch/cancel/')) {
      wywolaneAnulowania.push(u);
      return { ok: true, json: async () => ({ ok: true, status: 'cancelled' }) };
    }
    throw new Error('nieoczekiwane wywolanie: ' + u);
  };
  t.after(() => { global.fetch = oryginalFetch; });

  const store = makeRunsStore({ dataDir });
  const run = store.create({ excelPath: 'x.xlsx', generatory: { myEcodan: true } });
  store.update(run.id, r => { r.generatory.myEcodan = { jobId: 'job-real-70-adresow', baseUrl: 'http://ecodan', status: 'w-toku' }; });
  store.upsertKrok(run.id, 'dobor-myEcodan', { status: 'w-toku', procent: 18 });

  const { wyniki } = await przerwijPrzebieg(store, run.id, {});

  assert.equal(wywolaneAnulowania.length, 1);
  assert.ok(wywolaneAnulowania[0].includes('job-real-70-adresow'));
  assert.equal(wyniki[0].status, 'przerwano');

  const zaktualizowany = store.get(run.id);
  assert.equal(zaktualizowany.status, 'przerwany');
  assert.equal(zaktualizowany.przerwany, true);
  assert.equal(zaktualizowany.generatory.myEcodan.status, 'przerwany');
  assert.equal(zaktualizowany.kroki.find(k => k.nazwa === 'dobor-myEcodan')?.status, 'przerwany');
});

test('przerwijPrzebieg: bez aktywnego joba generatora (np. jeszcze przed startem) po prostu oznacza przebieg jako przerwany, bez wywolywania cancel', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-run-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const oryginalFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('nie powinno byc zadnego wywolania fetch: ' + url); };
  t.after(() => { global.fetch = oryginalFetch; });

  const store = makeRunsStore({ dataDir });
  const run = store.create({ excelPath: 'x.xlsx', generatory: {} });

  const { wyniki } = await przerwijPrzebieg(store, run.id, {});

  assert.equal(wyniki.length, 0);
  assert.equal(store.get(run.id).status, 'przerwany');
});

test('wykonajPrzebieg: przerwanie W TRAKCIE zgloszenia myEcodan zatrzymuje przebieg PRZED odpaleniem Varmero (audyt 2026-08-21 - luka w pierwszej wersji przycisku "Przerwij")', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-run-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const { dir, file: excelPath } = await napiszArkusze([['Pompy', [['LP', 'Adres'], ['1', 'A']]]]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const { przerwijPrzebieg } = require('../apps/pipeline/src/runs');
  const store = makeRunsStore({ dataDir });
  const run = store.create({
    excelPath,
    kroki: {},
    generatory: { myEcodan: true, varmero: true },
    opcjeDoboru: { myEcodan: {}, varmero: {} }
  });

  let varmeroWywolane = false;
  let sprawdzeniaMyEcodan = 0;
  const oryginalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('http://varmero/')) { varmeroWywolane = true; return { ok: true, json: async () => ({ ok: true, jobId: 'job-varmero' }) }; }
    if (u.includes('/api/batch/start')) return { ok: true, json: async () => ({ ok: true, jobId: 'job-myecodan' }) };
    if (u.includes('/api/batch/status/')) {
      sprawdzeniaMyEcodan += 1;
      if (sprawdzeniaMyEcodan === 1) {
        // Uzytkownik klika "Przerwij" DOKLADNIE w trakcie oczekiwania na
        // myEcodan - real sekwencja z incydentu 2026-08-21.
        await przerwijPrzebieg(store, run.id, { myEcodan: 'http://ecodan' });
        return { ok: true, json: async () => ({ ok: true, job: { status: 'running', done: 8, total: 64 } }) };
      }
      return { ok: true, json: async () => ({ ok: true, job: { status: 'cancelled' } }) };
    }
    if (u.includes('/api/batch/cancel/')) return { ok: true, json: async () => ({ ok: true, status: 'cancelled' }) };
    throw new Error('nieoczekiwane wywolanie: ' + u);
  };
  t.after(() => { global.fetch = oryginalFetch; });

  await wykonajPrzebieg(store, run.id, { myEcodan: 'http://ecodan', varmero: 'http://varmero/x' });

  assert.equal(varmeroWywolane, false, 'Varmero NIGDY nie powinien byc odpalony po przerwaniu w trakcie myEcodan');
  assert.equal(store.get(run.id).status, 'przerwany');
});
