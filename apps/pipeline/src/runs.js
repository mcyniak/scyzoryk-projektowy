// Silnik przebiegow pipeline'u - jeden "run" = jedna proba automatyzacji
// calej inwestycji. Stan trwa na dysku (nie tylko w pamieci procesu), zeby
// przetrwac restart serwera w trakcie dlugiego oczekiwania na Dobor Varmero
// (patrz "Ryzyka i decyzje projektowe" w planie "Pipeline inwestycji").
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const readXlsxFile = require('read-excel-file/node');
const { buildTabelaAdresowa, isAirSourcePump } = require('../../../lib/investmentAddressTable');
const { buildFilteredWorkbookFile } = require('./filteredWorkbook');
const { krokTworzenieFolderow, krokPrzypisywanie, krokDokumentySeryjne, krokDoboryBatch, sprawdzStatusBatch, anulujBatch } = require('./steps');

function nowIso() { return new Date().toISOString(); }

// --- Analiza tabeli adresowej (krok 1 UI - PRZED wyborem, jakie narzedzia pokazac) ---
async function analyzujTabeleAdresowa(excelPath) {
  const wszystkieArkusze = await readXlsxFile(excelPath, { getSheets: true });
  const { sheetNames, sheets } = buildTabelaAdresowa(wszystkieArkusze);

  const podsumowanie = { pompyPowietrzne: 0, pompyGrunt: 0, pompyNieznane: 0, kolektory: 0, kotly: 0 };
  for (const sheet of sheets) {
    if (sheet.type === 'pompy') {
      for (const rec of sheet.records) {
        if (rec.pumpType === 'powietrzna') podsumowanie.pompyPowietrzne += 1;
        else if (rec.pumpType === 'grunt') podsumowanie.pompyGrunt += 1;
        else podsumowanie.pompyNieznane += 1;
      }
    } else if (sheet.type === 'kolektory') {
      podsumowanie.kolektory += sheet.records.length;
    } else if (sheet.type === 'kotly') {
      podsumowanie.kotly += sheet.records.length;
    }
  }

  return { sheetNames, sheets, podsumowanie };
}

// Buduje kopie pliku Excel zawierajaca TYLKO adresy zaznaczone przez
// uzytkownika w podgladzie (krok 1 UI) - jedyny sposob na "wybranie czesci
// adresow" dla apek bez wlasnego wsparcia dla zaznaczania wierszy (patrz
// src/filteredWorkbook.js). selection: { [sheetName]: number[] } (rowIndex
// do ZACHOWANIA) - brak wpisu dla arkusza = zachowaj wszystkie jego wiersze
// bez zmian. Zwraca oryginalna sciezke bez zadnej kopii, jesli selection nie
// zawezaja niczego (typowy przypadek - unikamy zbednej pracy ExcelJS).
async function zbudujExcelWgSelekcji({ sourcePath, outputPath, selection }) {
  if (!selection || Object.keys(selection).length === 0) return sourcePath;

  const wszystkieArkusze = await readXlsxFile(sourcePath, { getSheets: true });
  const { sheets } = buildTabelaAdresowa(wszystkieArkusze);

  const keepBySheet = new Map();
  let czyCokolwiekZawezono = false;
  for (const sheet of sheets) {
    const wybrane = selection[sheet.sheetName];
    if (!Array.isArray(wybrane)) continue;
    const wszystkieIndeksy = sheet.records.map(r => r.rowIndex);
    const wybranyZbior = new Set(wybrane.map(Number));
    const czyPelnyZbior = wszystkieIndeksy.length === wybranyZbior.size && wszystkieIndeksy.every(i => wybranyZbior.has(i));
    if (czyPelnyZbior) continue;
    czyCokolwiekZawezono = true;
    keepBySheet.set(sheet.sheetName, { headerRowIndex: sheet.headerRowIndex, keepRowIndexes: [...wybranyZbior] });
  }

  if (!czyCokolwiekZawezono) return sourcePath;

  await buildFilteredWorkbookFile({ sourcePath, outputPath, keepBySheet });
  return outputPath;
}

function makeRunsStore({ dataDir, log = () => {} }) {
  const runs = new Map();
  const RUNS_INDEX = path.join(dataDir, 'runs.json');

  function persist() {
    try {
      const items = [...runs.values()];
      fsSync.mkdirSync(dataDir, { recursive: true });
      fsSync.writeFileSync(RUNS_INDEX, JSON.stringify({ savedAt: nowIso(), runs: items }, null, 2), 'utf8');
    } catch (err) {
      log('[pipeline-runs-index]', err?.message || err);
    }
  }

  function restore() {
    try {
      if (!fsSync.existsSync(RUNS_INDEX)) return;
      const data = JSON.parse(fsSync.readFileSync(RUNS_INDEX, 'utf8'));
      for (const run of data.runs || []) {
        if (!run?.id) continue;
        // Przebieg przerwany restartem serwera w trakcie "running" nigdy nie
        // dokonczy sam siebie (nic go juz nie odpala) - oznaczamy jawnie
        // zamiast zostawiac mylace "running" na zawsze.
        if (run.status === 'running') { run.status = 'przerwany-restartem'; }
        runs.set(run.id, run);
      }
    } catch (err) {
      log('[pipeline-runs-restore]', err?.message || err);
    }
  }

  restore();

  function create(input) {
    const id = crypto.randomUUID();
    const run = {
      id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'running',
      input,
      kroki: [],
      generatory: {},
      raport: null
    };
    runs.set(id, run);
    persist();
    return run;
  }

  function get(id) { return runs.get(id) || null; }

  function update(id, fn) {
    const run = runs.get(id);
    if (!run) return null;
    fn(run);
    run.updatedAt = nowIso();
    persist();
    return run;
  }

  // Doda krok o danej nazwie przy pierwszym wywolaniu, potem tylko
  // aktualizuje ten sam wpis w miejscu - uzywane zarowno do zapisania
  // koncowego wyniku, jak i do zywego postepu w trakcie pollowania joba
  // (patrz onProgress w wykonajPrzebieg), zeby UI mogl pokazac prawdziwy
  // pasek postepu zamiast tylko "w toku".
  function upsertKrok(id, nazwa, patch) {
    return update(id, run => {
      let krok = run.kroki.find(k => k.nazwa === nazwa);
      if (!krok) { krok = { nazwa, startedAt: nowIso() }; run.kroki.push(krok); }
      Object.assign(krok, patch);
    });
  }

  function list() {
    return [...runs.values()]
      .map(r => ({ id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt, status: r.status }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // Usuwanie z historii (audyt 2026-08-24: wlasciciel nie mial jak schowac
  // starych przebiegow z listy "Wczesniej rozpoczete przebiegi") - kasuje
  // tez folder roboczy tego runId (pobrane dobory, wygenerowane dokumenty).
  function remove(id) {
    runs.delete(id);
    persist();
    fsSync.rm(path.join(dataDir, id), { recursive: true, force: true }, () => {});
  }

  function removeAll() {
    for (const id of runs.keys()) remove(id);
  }

  return { create, get, update, upsertKrok, list, remove, removeAll, stagingRoot: dataDir };
}

// Postep z joba dokumentow seryjnych ({phase,percent,message} - patrz
// setProgress w apps/dokumenty-seryjne/server.js) albo z joba
// myEcodan/Varmero (done/total - patrz apps/formularze-{ecodan,varmero}).
// Zwraca zawsze ten sam ksztalt {procent, wiadomosc}, zeby UI nie musialo
// znac roznic miedzy apkami.
function odczytajPostep(job) {
  if (!job) return { procent: null, wiadomosc: null };
  if (job.progress && typeof job.progress.percent === 'number') {
    return { procent: job.progress.percent, wiadomosc: job.progress.message || null };
  }
  if (typeof job.total === 'number' && job.total > 0) {
    return { procent: Math.round((Number(job.done || 0) / job.total) * 100), wiadomosc: `${job.done || 0}/${job.total}` };
  }
  return { procent: null, wiadomosc: null };
}

// Uruchamia wybrane kroki NIEZALEZNE od doborow (Faza 1 planu - generatory
// startuja NAJPIERW i NIE sa tu czekane, wszystko inne dzieje sie od razu
// potem w tym samym przebiegu). Kazdy krok jest calkowicie niezalezny -
// blad jednego nigdy nie blokuje pozostalych (ta sama filozofia co
// dopasujISkopiujDodatek w karty-katalogowe).
async function wykonajPrzebieg(store, runId, apps) {
  const run = store.get(runId);
  if (!run) throw new Error('Nie znaleziono przebiegu.');
  const { input } = run;
  const stagingDir = path.join(store.stagingRoot, runId);
  await fs.mkdir(stagingDir, { recursive: true });

  // 1) Start generatorow - NIE czekamy na ukonczenie tutaj (patrz collect-dobory).
  // Sprawdzamy "przerwany" PRZED KAZDA iteracja (nie tylko raz przed calym
  // krokiem) - audyt 2026-08-21, real luka znaleziona w tym samym audycie,
  // ktory doprowadzil do dodania samego przycisku "Przerwij": bez tego
  // sprawdzenia TU, przerwanie w trakcie zgloszenia myEcodan i tak
  // pozwolaloby odpalic sie kolejnemu generatorowi (Varmero) zaraz potem,
  // bo petla po prostu szlaby dalej do nastepnej iteracji.
  for (const gen of ['myEcodan', 'varmero']) {
    if (store.get(runId)?.przerwany) return store.get(runId);
    if (!input.generatory?.[gen]) continue;
    const baseUrl = apps[gen];
    const genStagingDir = path.join(stagingDir, gen);
    store.upsertKrok(runId, `dobor-${gen}`, { status: 'w-toku' });
    try {
      await krokDoboryBatch({
        baseUrl, excelPath: input.excelPath, stagingDir: genStagingDir, dodatkoweOpcje: input.opcjeDoboru?.[gen] || {},
        // Zapisujemy jobId NATYCHMIAST po starcie, NIE po calym zgloszeniu
        // (ktore dla Varmero moze trwac godziny) - inaczej "Przerwij
        // przebieg" nie mialby czego anulowac przez cala dlugosc zgloszenia
        // (real incydent 2026-08-21).
        onJobStarted: jobId => store.update(runId, r => { r.generatory[gen] = { jobId, baseUrl, stagingDir: genStagingDir, status: 'w-toku' }; }),
        onProgress: job => store.upsertKrok(runId, `dobor-${gen}`, { status: 'w-toku', ...odczytajPostep(job) })
      });
      // Nie nadpisuj statusu "przerwany" (ustawionego przez przerwijPrzebieg
      // w miedzyczasie) wynikiem udanego zgloszenia - ten sam wyscig, ktory
      // sciezka bledu ponizej juz swiadomie unika.
      store.update(runId, r => { if (r.generatory[gen] && r.generatory[gen].status !== 'przerwany') r.generatory[gen].status = 'zgloszono'; });
      if (store.get(runId)?.generatory?.[gen]?.status !== 'przerwany') {
        store.upsertKrok(runId, `dobor-${gen}`, { status: 'zgloszono', komunikat: 'Zgloszono do kalkulatora - sprawdz pozniej przyciskiem "Sprawdz i rozloz gotowe dobory".' });
      }
    } catch (err) {
      store.update(runId, r => { if (!r.generatory[gen] || r.generatory[gen].status !== 'przerwany') r.generatory[gen] = { ...(r.generatory[gen] || {}), status: 'blad', komunikat: String(err?.message || err) }; });
      if (store.get(runId)?.generatory?.[gen]?.status !== 'przerwany') {
        store.upsertKrok(runId, `dobor-${gen}`, { status: 'blad', komunikat: String(err?.message || err) });
      }
    }
  }

  // 2) Tworzenie folderow (opcjonalne, bezpieczne do powtarzania).
  if (store.get(runId)?.przerwany) return store.get(runId);
  if (input.kroki?.tworzenieFolderow && input.investmentFolder) {
    store.upsertKrok(runId, 'tworzenie-folderow', { status: 'w-toku' });
    try {
      const wynik = await krokTworzenieFolderow({ baseUrl: apps.tworzenieFolderow, excelPath: input.excelPath, investmentFolder: input.investmentFolder });
      store.upsertKrok(runId, 'tworzenie-folderow', { status: 'skonczony', wynik });
    } catch (err) {
      store.upsertKrok(runId, 'tworzenie-folderow', { status: 'blad', komunikat: String(err?.message || err) });
    }
  }

  // 3) Karty katalogowe (Solary/Pompy) - kazdy wymaga wlasnej sciezki roota
  // (rozny ksztalt, patrz plan).
  for (const [typ, rootPole] of [['solary', 'rootPathSolary'], ['pompy', 'rootPathPompy']]) {
    if (store.get(runId)?.przerwany) return store.get(runId);
    if (!input.kroki?.[typ] || !input[rootPole]) continue;
    store.upsertKrok(runId, `karty-${typ}`, { status: 'w-toku' });
    try {
      const wynik = await krokPrzypisywanie({ baseUrl: apps.przypisywanie, excelPath: input.excelPath, rootPath: input[rootPole], typ });
      store.upsertKrok(runId, `karty-${typ}`, { status: 'skonczony', wynik });
    } catch (err) {
      store.upsertKrok(runId, `karty-${typ}`, { status: 'blad', komunikat: String(err?.message || err) });
    }
  }

  // 4) Audyty (plik zrodlowy podany przez uzytkownika, nie generowany) -
  // KAZDY typ (Solary/Pompy) ma swoj wlasny checkbox (audyty{Typ}) - w
  // odroznieniu od Faza 0, gdzie to bylo jedno wspolne "audyty" dla obu
  // naraz, co uniemozliwialo zrobienie tego TYLKO dla jednego typu (audyt
  // 2026-08-21, zgloszenie wlasciciela: "nie moge wybrac ktore z nich
  // chce zrobic").
  for (const [typ, rootPole, checkboxNazwa] of [['solary', 'rootPathSolary', 'audytySolary'], ['pompy', 'rootPathPompy', 'audytyPompy']]) {
    if (store.get(runId)?.przerwany) return store.get(runId);
    if (!input.kroki?.[checkboxNazwa] || !input.audytyPath || !input[rootPole]) continue;
    store.upsertKrok(runId, `audyty-${typ}`, { status: 'w-toku' });
    try {
      const wynik = await krokPrzypisywanie({ baseUrl: apps.przypisywanie, excelPath: input.excelPath, rootPath: input[rootPole], typ: 'audyty', dodatekPath: input.audytyPath, dodatekPole: 'audytyPath' });
      store.upsertKrok(runId, `audyty-${typ}`, { status: 'skonczony', wynik });
    } catch (err) {
      store.upsertKrok(runId, `audyty-${typ}`, { status: 'blad', komunikat: String(err?.message || err) });
    }
  }

  // 5) Dokumenty seryjne - jak audyty, KAZDY typ ma swoj wlasny checkbox.
  // Szablony .docx sa te, ktore uzytkownik SAM wybral w UI (audyt
  // 2026-08-24 - wczesniej folder wzoru byl WYLICZANY automatycznie z
  // rootPathSolary/rootPathPompy i caly jego zawartosc szla do generowania,
  // co bylo niezgodne z ustaleniem, ze narzedzie dziala na wybranych plikach,
  // nie na calym folderze). Tabela Excel do mail-merge MOZE byc OSOBNA
  // (input.dokSeryjneExcel{Typ}, wgrana osobno w /api/pipeline/start), bo
  // glowna tabela adresowa czasem nie ma kolumn typu "Beneficjent", ktorych
  // dokumenty seryjne wymagaja - ALE nie zawsze: wlasciciel potwierdzil, ze
  // dla niektorych inwestycji glowna tabela adresowa juz ma taka kolumne i
  // spokojnie wystarcza, wiec uzytkownik SAM wybiera w UI, ktorej tabeli
  // uzyc per typ (Solary/Pompy) - brak wgranego pliku = uzyj glownej tabeli
  // adresowej (juz przefiltrowanej wg selekcji adresow, patrz wyzej).
  for (const [typ, rootPole, checkboxNazwa, excelPole, templatesPole] of [
    ['solary', 'rootPathSolary', 'dokSeryjneSolary', 'dokSeryjneExcelSolary', 'dokSeryjneTemplatesSolary'],
    ['pompy', 'rootPathPompy', 'dokSeryjnePompy', 'dokSeryjneExcelPompy', 'dokSeryjneTemplatesPompy']
  ]) {
    if (store.get(runId)?.przerwany) return store.get(runId);
    if (!input.kroki?.[checkboxNazwa] || !input[rootPole]) continue;
    const excelPathDlaDokSeryjnych = input[excelPole] || input.excelPath;
    const krokNazwa = `dokumenty-seryjne-${typ}`;
    const dsStagingDir = path.join(stagingDir, 'dokumenty-seryjne', typ);
    store.upsertKrok(runId, krokNazwa, { status: 'w-toku' });
    try {
      await krokDokumentySeryjne({
        baseUrl: apps.dokumentySeryjne, excelPath: excelPathDlaDokSeryjnych, templatePaths: input[templatesPole], stagingDir: dsStagingDir,
        onProgress: job => store.upsertKrok(runId, krokNazwa, { status: 'w-toku', ...odczytajPostep(job) })
      });
      const wynikRozdziel = await krokPrzypisywanie({ baseUrl: apps.przypisywanie, excelPath: input.excelPath, rootPath: input[rootPole], typ: 'dokumenty-seryjne', dodatekPath: dsStagingDir, dodatekPole: 'dokumentySeryjnePath' });
      store.upsertKrok(runId, krokNazwa, { status: 'skonczony', wynik: wynikRozdziel });
    } catch (err) {
      store.upsertKrok(runId, krokNazwa, { status: 'blad', komunikat: String(err?.message || err) });
    }
  }

  const jakisGeneratorUzyty = Object.values(input.generatory || {}).some(Boolean);
  store.update(runId, r => { if (!r.przerwany) r.status = jakisGeneratorUzyty ? 'oczekuje-doborow' : 'skonczony'; });
  return store.get(runId);
}

// "Przerwij przebieg" - anuluje wszystkie jeszcze aktywne joby generatorow
// (myEcodan/Varmero, przez ich wlasne /api/batch/cancel) i ustawia flage,
// ktora zatrzymuje kolejne kroki wykonajPrzebieg (sprawdzana miedzy krokami,
// patrz wyzej) - juz TRWAJACY pojedynczy krok synchroniczny (np. jedno
// wywolanie karty-katalogowe) dokonczy sie, ale zaden NOWY juz sie nie
// odpali. Audyt 2026-08-21: real incydent, przypadkowy start dla 70
// adresow, brak jakiegokolwiek przycisku przerwania w UI - trzeba bylo
// szukac jobId recznie przez API child-apki.
async function przerwijPrzebieg(store, runId, apps) {
  const run = store.get(runId);
  if (!run) throw new Error('Nie znaleziono przebiegu.');

  const wyniki = [];
  for (const gen of ['myEcodan', 'varmero']) {
    const stan = run.generatory[gen];
    if (!stan?.jobId || !['w-toku', 'zgloszono'].includes(stan.status)) continue;
    try {
      await anulujBatch({ baseUrl: stan.baseUrl, jobId: stan.jobId });
      store.update(runId, r => { r.generatory[gen].status = 'przerwany'; });
      store.upsertKrok(runId, `dobor-${gen}`, { status: 'przerwany', komunikat: 'Przerwano na żądanie użytkownika.' });
      wyniki.push({ generator: gen, status: 'przerwano' });
    } catch (err) {
      wyniki.push({ generator: gen, status: 'blad-przerwania', komunikat: String(err?.message || err) });
    }
  }

  store.update(runId, r => {
    r.przerwany = true;
    r.status = 'przerwany';
    for (const krok of r.kroki) {
      if (krok.status === 'w-toku') { krok.status = 'przerwany'; krok.komunikat = 'Przerwano na żądanie użytkownika.'; }
    }
  });

  return { run: store.get(runId), wyniki };
}

// Wielokrotnie ponownie-wywolywalny - sprawdza status jobow generatorow
// zapisanych przy starcie, dla gotowych pobiera i rozdziela przez dodatek
// "dobory" (dziala dla Solary/Pomp powietrzna, patrz Faza 0). Nie wymaga
// ponownego zgloszenia do generatora - tylko odczytuje juz zapisany stan.
// Rozdziela na rootPath odpowiadajacy temu, co user faktycznie zaznaczyl
// (solary/pompy) - dobory z definicji dotycza wylacznie pomp powietrznych,
// ale plik z Dob_ moze teoretycznie trafic i do Solary root, jesli user tak
// skonfigurowal (rzadki przypadek - nie ograniczamy sztucznie).
async function collectDobory(store, runId, apps) {
  const run = store.get(runId);
  if (!run) throw new Error('Nie znaleziono przebiegu.');
  const wynikiKroku = [];
  const rooty = [run.input.rootPathSolary, run.input.rootPathPompy].filter(Boolean);

  for (const gen of ['myEcodan', 'varmero']) {
    const stan = run.generatory[gen];
    if (!stan || ['blad', 'rozdzielono', 'przerwany'].includes(stan.status)) continue;
    const job = await sprawdzStatusBatch({ baseUrl: stan.baseUrl, jobId: stan.jobId });
    store.upsertKrok(runId, `dobor-${gen}`, { status: 'w-toku', ...odczytajPostep(job) });
    const gotowy = job.status === 'finished' || job.status === 'finished-with-errors';
    const bladJoba = job.status === 'fatal-error' || job.status === 'cancelled';
    if (bladJoba) {
      const komunikat = job.errorMessage || job.fatalReason || 'Zadanie zakonczylo sie bledem.';
      store.update(runId, r => { r.generatory[gen].status = 'blad'; r.generatory[gen].komunikat = komunikat; });
      store.upsertKrok(runId, `dobor-${gen}`, { status: 'blad', komunikat });
      continue;
    }
    if (!gotowy) {
      wynikiKroku.push({ generator: gen, status: 'oczekujace' });
      continue;
    }
    const wyniki = [];
    for (const rootPath of rooty) {
      wyniki.push({ rootPath, ...await krokPrzypisywanie({ baseUrl: apps.przypisywanie, excelPath: run.input.excelPath, rootPath, typ: 'dobory', dodatekPath: stan.stagingDir, dodatekPole: 'doboryPath' }) });
    }
    store.update(runId, r => { r.generatory[gen].status = 'rozdzielono'; });
    store.upsertKrok(runId, `dobor-${gen}`, { status: 'skonczony', wynik: wyniki });
    wynikiKroku.push({ generator: gen, status: 'rozdzielono', wynik: wyniki });
  }

  const wszystkoGotowe = ['myEcodan', 'varmero'].every(gen => !run.input.generatory?.[gen] || ['rozdzielono', 'blad', 'przerwany'].includes(store.get(runId).generatory[gen]?.status));
  store.update(runId, r => { if (!r.przerwany) r.status = wszystkoGotowe ? 'skonczony' : 'oczekuje-doborow'; });

  return { run: store.get(runId), wynikiKroku };
}

module.exports = {
  analyzujTabeleAdresowa,
  zbudujExcelWgSelekcji,
  makeRunsStore,
  wykonajPrzebieg,
  collectDobory,
  przerwijPrzebieg,
  isAirSourcePump
};
