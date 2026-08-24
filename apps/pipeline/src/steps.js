// Pojedyncze kroki pipeline'u - kazdy jest cienkim klientem HTTP jednej
// istniejacej apki, wolanym dokladnie tak, jak dzis robi to przegladarka
// (patrz src/childAppClient.js). Zero importu kodu innych apek.
const fs = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');
const { postMultipart, getJson, pollJob } = require('./childAppClient');

// --- Tworzenie folderow (prosty, jednorazowy krok) ---
// POST /api/create: multipart "excel" + pole "investmentFolder" (JUZ
// ISTNIEJACY folder inwestycji, ktory apka wypelnia strukture podfolderow -
// wbrew wczesniejszemu zalozeniu planu, sciezka NIE jest czytana z
// zawartosci pliku, trzeba ja podac wprost, zweryfikowane w
// apps/tworzenie-folderow/server.js#readPlanFromUpload) ->
// { ok, investmentFolder, created, alreadyExisted, rejected }.
async function krokTworzenieFolderow({ baseUrl, excelPath, investmentFolder }) {
  return postMultipart(`${baseUrl}/api/create`, { excel: { filePath: excelPath }, investmentFolder });
}

// --- Przypisywanie plikow do folderow (karty-katalogowe, prosty krok, ale
// wolany WIELOKROTNIE - raz na typ). doboryPath/audytyPath/dokumentySeryjnePath
// to SCIEZKI LOKALNE (nie zip) - pipeline i wszystkie apki dzialaja na tej
// samej maszynie, wiec pakowanie z powrotem w zip przed wgraniem byloby
// zbedna praca (patrz "Ryzyka i decyzje projektowe" w planie).
async function krokPrzypisywanie({ baseUrl, excelPath, rootPath, typ, sheetName, dryRun = false, dodatekPath = null, dodatekPole = null }) {
  const fields = { excel: { filePath: excelPath }, rootPath, typ, dryRun: String(dryRun) };
  if (sheetName) fields.sheetName = sheetName;
  if (dodatekPath && dodatekPole) fields[dodatekPole] = dodatekPath;
  return postMultipart(`${baseUrl}/api/run`, fields);
}

// --- Dokumenty seryjne (job-based: upload -> generate -> poll -> download zip) ---
// excelPath: tabela Excel OSOBNA od glownej tabeli adresowej pipeline'u -
// dokumenty seryjne potrzebuja wlasnych kolumn (np. "Beneficjent"), ktorych
// glowna tabela adresowa nie ma (audyt 2026-08-21). templatePaths: KONKRETNE
// pliki .docx WYBRANE PRZEZ UZYTKOWNIKA w UI pipeline'u (audyt 2026-08-24 -
// wczesniej ta funkcja sama czytala caly folder "wzor" przez fs.readdir, co
// bylo niezgodne z ustaleniem, ze dokumenty seryjne dzialaja na wybranych
// plikach, nie na calym folderze - patrz ten sam multi-file input, co w
// samej apce dokumenty-seryjne). Kazdy z nich idzie jako osobny "templates"
// wpis multipart.
//
// sheetName: OPCJONALNE - jesli podane, jedno konkretne wywolanie generuje
// TYLKO dla jednego arkusza tej tabeli; jesli pominiete, dokumenty seryjne
// same wybiora swoj domyslny arkusz (typowy przypadek, gdy kazdy typ
// Solary/Pompy ma juz WLASNY, osobny plik Excel - patrz src/runs.js).
// Zweryfikowane w apps/dokumenty-seryjne/server.js#/api/generate - kazde
// wywolanie tego endpointu CZYSCI caly folder wyjsciowy joba PRZED
// generowaniem (celowa ochrona z wczesniejszego audytu, zeby nie mieszac
// wynikow miedzy proba), wiec DWA wywolania generate na TYM SAMYM jobId dla
// dwoch roznych arkuszy tej samej tabeli skasowalyby sobie wzajemnie wyniki
// - kazdy taki arkusz potrzebowalby WLASNEGO uploadu+jobId.
// Zadane na zywo 2026-08-24 (plan zatwierdzony przez wlasciciela): arkusze
// tabeli wzorowej to MOCE ("8kW", warianty "12kW ROZ 300"), szablony .docx
// maja powiazania mail-merge z konkretnymi arkuszami-mocami. Jedno wywolanie
// /api/generate obsluguje DOKLADNIE jeden arkusz, a kazde nastepne CZYSCI
// outputDir joba - dlatego generujemy PETLA po mocach: generate -> poll ->
// pobranie ZIP -> nastepna moc. Moc bez szablonu (ani szablon bez arkusza w
// tabeli) jest pomijana z zapisem w komunikacie kroku, nie bledem.
async function krokDokumentySeryjne({ baseUrl, excelPath, templatePaths, stagingDir, onProgress = () => {} }) {
  if (!templatePaths?.length) throw new Error('Nie wybrano żadnego szablonu .docx dla Dokumentów seryjnych.');

  const form = new FormData();
  form.append('excel', new Blob([await fs.readFile(excelPath)]), path.basename(excelPath));
  for (const templatePath of templatePaths) {
    form.append('templates', new Blob([await fs.readFile(templatePath)]), path.basename(templatePath));
  }
  const uploadRes = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || uploadData.ok === false) throw new Error(uploadData.message || 'Wgranie do Dokumentow seryjnych nie powiodlo sie.');
  const jobId = uploadData.jobId;

  // Moce do roboty = arkusze wgranej tabeli, dla ktorych ISTNIEJE szablon
  // (powiazanie mail-merge z tym arkuszem). Arkusz tabeli bez szablonu ani
  // szablon bez arkusza niczego nie wygeneruje - raportujemy to jako
  // pominiete, a nie blad (typowe: wzor ma moc, ktorej jeszcze nie ma
  // w tabeli adresowej albo odwrotnie).
  const arkuszeTabeli = uploadData.workbook?.sheetNames || [];
  const moceSzablonow = new Set();
  for (const grupa of uploadData.templateGroups || []) {
    for (const klucz of Object.keys(grupa.variants || {})) moceSzablonow.add(klucz);
  }
  const moce = arkuszeTabeli.filter(a => moceSzablonow.has(a));
  const pominieteArkusze = arkuszeTabeli.filter(a => !moceSzablonow.has(a));
  const pominieteMoce = [...moceSzablonow].filter(m => !arkuszeTabeli.includes(m));
  if (!moce.length) {
    throw new Error(
      `Żaden szablon nie jest powiązany z arkuszami tej tabeli. ` +
      `Arkusze tabeli: ${arkuszeTabeli.join(', ') || 'brak'}. ` +
      `Arkusze z powiązań szablonów: ${[...moceSzablonow].join(', ') || 'brak'}.`
    );
  }

  let plikiRazem = 0;
  let ostatniJob = null;
  for (const moc of moce) {
    const generateRes = await fetch(`${baseUrl}/api/generate/${jobId}`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ sheetName: moc }) });
    const generateData = await generateRes.json();
    if (!generateRes.ok || generateData.ok === false) throw new Error(generateData.message || `Uruchomienie generowania dla mocy ${moc} nie powiodlo sie.`);

    const job = await pollJob({
      statusUrl: `${baseUrl}/api/job/${jobId}`,
      isDone: j => j.status === 'done',
      // 'interrupted' = apka dokumenty-seryjne przeszla restart w trakcie -
      // bez tego polling wisialby do timeoutu (zadane na zywo 2026-08-24).
      isError: j => j.status === 'error' || j.status === 'cancelled' || j.status === 'interrupted',
      timeoutMs: 60 * 60 * 1000, // tyle co wewnetrzny timeout Worda w tej apce
      onTick: onProgress
    });
    ostatniJob = job;

    // Kazde generate czysci outputDir joba - ZIP musi zejsc PRZED nastepna
    // moca, inaczej kolejna iteracja skasuje wyniki poprzedniej.
    const zipRes = await fetch(`${baseUrl}/api/download/${jobId}/zip`);
    if (!zipRes.ok) throw new Error(`Pobranie gotowych dokumentów seryjnych (moc ${moc}) nie powiodło się.`);
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    const cel = path.join(stagingDir, moc);
    await fs.mkdir(cel, { recursive: true });
    new AdmZip(zipBuffer).extractAllTo(cel, true);
    plikiRazem += job.result?.created?.length || 0;
  }

  return { jobId, job: ostatniJob, stagingDir, moce, pominieteArkusze, pominieteMoce, plikiRazem };
}

// --- Dobory myEcodan / Dobory Varmero (job-based, ALE z "outputPath" -
// wyniki (PDF-y z przedrostkiem "Dob_") ladujat sie WPROST w stagingDir w
// czasie rzeczywistym, kazdy w momencie gotowosci - zero pobierania zip,
// zero ryzyka TTL. Patrz apps/formularze-varmero/src/telemetry.js#resolvePdfDir
// i apps/formularze-ecodan (ten sam wzorzec "options.outputPath"). ---
// onJobStarted: wywolane OD RAZU po starcie, zanim polling czeka na
// ukonczenie - inaczej jobId bylby znany caller-owi dopiero PO calym
// zgloszeniu (minuty/godziny dla Varmero), przez co nie dalby sie anulowac
// w trakcie (real incydent 2026-08-21 - przypadkowy start na 70 adresow,
// trzeba bylo szukac jobId recznie przez API zamiast przez Pipeline, bo run
// state jeszcze go nie mial).
async function krokDoboryBatch({ baseUrl, excelPath, stagingDir, dodatkoweOpcje = {}, onJobStarted = () => {}, onProgress = () => {} }) {
  await fs.mkdir(stagingDir, { recursive: true });
  // selectAll='true' - zadane na zywo 2026-08-24: audyt apek formularzy
  // (2026-08-21) zablokowal pusta selectedRows ("nie zgaduj wszystkiego"),
  // co zablokowalo tez pipeline. Tu plik jest juz przefiltrowany przez
  // selekcje uzytkownika z kroku 1 (zbudujExcelWgSelekcji), a krok "Dobor"
  // uzytkownik zaznacza recznie - "wszystkie wiersze pliku" = jego intencja.
  const fields = { excel: { filePath: excelPath }, outputPath: stagingDir, skipExisting: 'true', selectAll: 'true', ...dodatkoweOpcje };
  const startData = await postMultipart(`${baseUrl}/api/batch/start`, fields);
  const jobId = startData.jobId;
  onJobStarted(jobId);

  const job = await pollJob({
    statusUrl: `${baseUrl}/api/batch/status/${jobId}`,
    isDone: j => j.status === 'finished' || j.status === 'finished-with-errors',
    isError: j => j.status === 'fatal-error' || j.status === 'cancelled',
    intervalMs: 5000,
    timeoutMs: 6 * 60 * 60 * 1000, // Varmero czeka realnie na maila - do 6h, patrz plan.
    onTick: onProgress
  });

  return { jobId, job, stagingDir };
}

// --- Sprawdzenie statusu bez czekania (do krokDoboryBatch#collect-dobory,
// odpalane WIELOKROTNIE pozniej, bez ponownego zgloszenia) ---
async function sprawdzStatusBatch({ baseUrl, jobId }) {
  const data = await getJson(`${baseUrl}/api/batch/status/${jobId}`);
  return data.job || data;
}

// --- Przerwanie juz zgloszonego zadania myEcodan/Varmero - "Przerwij
// przebieg" w UI (audyt 2026-08-21, real incydent: przypadkowy start dla 70
// adresow). Woluje ten sam endpoint co przycisk anulowania w standalone
// apkach myEcodan/Varmero. ---
async function anulujBatch({ baseUrl, jobId }) {
  const res = await fetch(`${baseUrl}/api/batch/cancel/${jobId}`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || data.error || 'Nie udalo sie anulowac zadania.');
  return data;
}

module.exports = {
  krokTworzenieFolderow,
  krokPrzypisywanie,
  anulujBatch,
  krokDokumentySeryjne,
  krokDoboryBatch,
  sprawdzStatusBatch
};
