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

// --- Osobna tabela dokumentow seryjnych: filtracja do zaznaczonych adresow ---
// Potwierdzone na realnych danych (2026-08-24, folder "wzor"): kolumna ID w
// osobnej tabeli zawiera te same wartosci co LP/ID w glownej tabeli TEJ SAMEJ
// inwestycji (Kazimierz Biskupi 16/16 trafien, Slesin 4/4). Arkusze osobnej
// tabeli to MOCE ("8kW", warianty "12kW ROZ 300"). Wiersze bez pary w glownej
// tabeli (np. wzor nowszy niz tabela adresowa - Rychwal mial 7 takich) sa
// POMIJANE i raportowane, nigdy cicho generowane.
async function zbierzLpZGlownejTabeli(excelPath) {
  const wszystkieArkusze = await readXlsxFile(excelPath, { getSheets: true });
  const { sheets } = buildTabelaAdresowa(wszystkieArkusze);
  const lp = new Set();
  for (const sheet of sheets) {
    for (const rec of sheet.records) {
      const wartosc = String(rec.lpOrId ?? '').trim();
      if (wartosc) lp.add(wartosc);
    }
  }
  return lp;
}

// Zwraca { outputPath, dopasowano, pominieteId: [], pusteArkusze: [] }.
// Konwencja indeksow identyczna jak w zbudujExcelWgSelekcji (rowIndex 0-based
// na wierszach z naglowkiem, przekazywane dalej do filteredWorkbook).
async function przefiltrujOsobnaTabele({ sourcePath, outputPath, zaznaczoneLp }) {
  const arkusze = await readXlsxFile(sourcePath, { getSheets: true });
  const keepBySheet = new Map();
  let dopasowano = 0;
  const pominieteId = [];
  const pusteArkusze = [];
  for (const arkusz of arkusze) {
    const nazwa = arkusz.sheet;
    const rows = Array.isArray(arkusz.data) ? arkusz.data : [];
    let headerRowIndex = -1;
    let idColIndex = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
      const vals = rows[i] || [];
      const idx = vals.findIndex(v => /^(id|uid|lp)$/i.test(String(v ?? '').trim()));
      if (idx !== -1) { headerRowIndex = i; idColIndex = idx; break; }
    }
    if (headerRowIndex === -1) continue;
    const keep = [];
    for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const id = String(row[idColIndex] ?? '').trim();
      if (!id) continue;
      if (zaznaczoneLp.has(id)) { keep.push(i); dopasowano += 1; }
      else pominieteId.push(id);
    }
    if (!keep.length) pusteArkusze.push(nazwa);
    else keepBySheet.set(nazwa, { headerRowIndex, keepRowIndexes: keep });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await buildFilteredWorkbookFile({ sourcePath, outputPath, keepBySheet });
  return { outputPath, dopasowano, pominieteId, pusteArkusze };
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
    let excelPathDlaDokSeryjnych = input[excelPole] || input.excelPath;
    const krokNazwa = `dokumenty-seryjne-${typ}`;
    const dsStagingDir = path.join(stagingDir, 'dokumenty-seryjne', typ);
    store.upsertKrok(runId, krokNazwa, { status: 'w-toku' });
    try {
      // Osobna tabela: filtrujemy ja do zaznaczonych adresow z kroku 1
      // (dopasowanie po kolumnie ID == LP/ID glownej tabeli). Zadane na zywo
      // 2026-08-24 - bez tego generowaly sie WSZYSTKIE wiersze osobnej tabeli,
      // nawet te odznaczone/nieobecne w glownej. Glowna tabela nie wymaga
      // filtracji - input.excelPath jest juz przefiltrowana.
      const czesciKomunikatu = [];
      if (input[excelPole]) {
        const zaznaczoneLp = await zbierzLpZGlownejTabeli(input.excelPath);
        const wynikFiltracji = await przefiltrujOsobnaTabele({
          sourcePath: excelPathDlaDokSeryjnych,
          outputPath: path.join(stagingDir, 'dokumenty-seryjne', `${typ}-tabela-przefiltrowana.xlsx`),
          zaznaczoneLp,
        });
        if (!wynikFiltracji.dopasowano) {
          throw new Error(
            'Osobna tabela nie ma żadnego wiersza pasującego do zaznaczonych adresów ' +
            '(kolumna ID osobnej tabeli musi zawierać LP/ID z głównej tabeli tej samej inwestycji).'
          );
        }
        excelPathDlaDokSeryjnych = wynikFiltracji.outputPath;
        czesciKomunikatu.push(`osobna tabela: dopasowano ${wynikFiltracji.dopasowano} wierszy` +
          (wynikFiltracji.pominieteId.length ? `, pominięto ID: ${wynikFiltracji.pominieteId.join(', ')}` : ''));
      }
      const wynikDokSeryjne = await krokDokumentySeryjne({
        baseUrl: apps.dokumentySeryjne, excelPath: excelPathDlaDokSeryjnych, templatePaths: input[templatesPole], stagingDir: dsStagingDir,
        onProgress: job => store.upsertKrok(runId, krokNazwa, { status: 'w-toku', ...odczytajPostep(job) })
      });
      if (wynikDokSeryjne.pominieteArkusze.length) {
        czesciKomunikatu.push(`arkusze tabeli bez szablonu (pominięte): ${wynikDokSeryjne.pominieteArkusze.join(', ')}`);
      }
      if (wynikDokSeryjne.pominieteMoce.length) {
        czesciKomunikatu.push(`szablony bez arkusza w tabeli (pominięte): ${wynikDokSeryjne.pominieteMoce.join(', ')}`);
      }
      if (czesciKomunikatu.length) {
        store.upsertKrok(runId, krokNazwa, { komunikat: czesciKomunikatu.join('; ') });
      }
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
  przefiltrujOsobnaTabele,
  zbierzLpZGlownejTabeli,
  makeRunsStore,
  wykonajPrzebieg,
  collectDobory,
  przerwijPrzebieg,
  isAirSourcePump
};
