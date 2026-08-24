// Pipeline inwestycji - odpala po kolei wybrane, juz istniejace narzedzia
// (Tworzenie folderow, Dokumenty seryjne, Przypisywanie plikow do folderow,
// Dobory myEcodan/Varmero) dla jednej inwestycji, przez ich wlasne HTTP API -
// tak jak dzis robi to przegladarka, tylko automatycznie i po kolei. Zero
// importu kodu innych apek (patrz plan "Pipeline inwestycji", Faza 1).
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { setupProcessDiagnostics, scheduleCleanup } = require('../../lib/hardening');
const { getAppDataDir } = require('../../lib/appPaths');
const { browseFolder } = require('../../lib/folderBrowse');
const { applySecurityHeaders, applyMutationGuard } = require('../../lib/localRequestSecurity');
const { analyzujTabeleAdresowa, zbudujExcelWgSelekcji, makeRunsStore, wykonajPrzebieg, collectDobory, przerwijPrzebieg } = require('./src/runs');

const APP_VERSION = require('./package.json').version;
const app = express();
const PORT = Number(process.env.PORT || 3015);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const APP_DATA_ROOT = getAppDataDir('pipeline');
setupProcessDiagnostics('pipeline', APP_DATA_ROOT);

const UPLOAD_DIR = path.join(APP_DATA_ROOT, 'uploads');
const RUNS_DIR = path.join(APP_DATA_ROOT, 'runs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });
scheduleCleanup([UPLOAD_DIR], 24 * 60 * 60 * 1000, 60 * 60 * 1000);
// Foldery robocze przebiegow ("staging" - pobrane dobory, wygenerowane
// dokumenty seryjne) musza przetrwac znacznie dluzej niz zwykle uploady, bo
// "collect-dobory" moze byc kliknietym godziny/dni pozniej (Varmero czeka
// realnie na maila) - 7 dni zamiast standardowych 24h.
scheduleCleanup([RUNS_DIR], 7 * 24 * 60 * 60 * 1000, 6 * 60 * 60 * 1000);

// Adresy innych apek - dokladnie te same porty co w root server.js.
const CHILD_APPS = {
  tworzenieFolderow: `http://127.0.0.1:${Number(process.env.TWORZENIE_FOLDEROW_PORT || 3013)}`,
  przypisywanie: `http://127.0.0.1:${Number(process.env.KARTY_PORT || 3006)}`,
  dokumentySeryjne: `http://127.0.0.1:${Number(process.env.SERYJNE_PORT || 3004)}`,
  myEcodan: `http://127.0.0.1:${Number(process.env.FORMULARZE_PORT || 3003)}`,
  varmero: `http://127.0.0.1:${Number(process.env.FORMULARZE_VARMERO_PORT || 3012)}`
};

applySecurityHeaders(app, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://scyzoryk.localhost:3000 http://127.0.0.1:3000; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
applyMutationGuard(app, (req, res) => res.status(403).json({ ok: false, error: 'Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie.' }));
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PIPELINE_API_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET',
  message: { ok: false, error: 'Za dużo żądań w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.' }
});
app.use('/api', apiLimiter);
app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
app.use(express.static(path.join(ROOT, 'public')));

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

const xlsxFileFilter = (req, file, cb) => {
  const originalName = decodeOriginalName(String(file.originalname || ''));
  if (/\.xlsx$/i.test(originalName)) return cb(null, true);
  if (/\.gsheet$/i.test(originalName)) {
    return cb(new Error('Wybrano plik .gsheet, czyli skrót do Google Sheets. Pobierz arkusz jako Microsoft Excel (.xlsx) i wybierz pobrany plik.'));
  }
  cb(new Error('Dozwolone są tylko prawdziwe pliki Excel .xlsx. Jeśli masz .xls, zapisz go w Excelu jako .xlsx.'));
};

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fieldNestingDepth: 2 },
  fileFilter: xlsxFileFilter
});

// /api/pipeline/start przyjmuje az 3 pliki xlsx (glowna tabela adresowa +
// osobne tabele do dokumentow seryjnych per typ, audyt 2026-08-21) oraz
// wybrane przez uzytkownika szablony .docx dla Dokumentow seryjnych (audyt
// 2026-08-24 - wczesniej pipeline sam czytal CALY folder "wzor", wbrew
// ustaleniu z wlascicielem, ze narzedzie ma dzialac na wybranych plikach,
// nie na calym folderze) - filtr rozstrzyga po nazwie pola, nie jednym
// wspolnym rozszerzeniu.
const templatesFileFilter = (req, file, cb) => {
  if (/^dokSeryjneTemplates/.test(file.fieldname)) {
    const originalName = decodeOriginalName(String(file.originalname || ''));
    if (/\.docx$/i.test(originalName)) return cb(null, true);
    return cb(new Error('Szablony dla Dokumentów seryjnych muszą być plikami .docx.'));
  }
  return xlsxFileFilter(req, file, cb);
};

const uploadWieloplikowy = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024, files: 23, fieldNestingDepth: 2 },
  fileFilter: templatesFileFilter
});

async function validateXlsxFile(file) {
  const original = String(file?.originalname || 'plik.xlsx');
  if (!/\.xlsx$/i.test(original)) throw new Error('Dozwolone są tylko pliki .xlsx. Pliki .xls zapisz najpierw jako .xlsx.');
  const fh = await fsp.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buffer, 0, 4, 0);
    if (bytesRead < 4 || buffer.toString('latin1', 0, 4) !== 'PK\x03\x04') {
      throw new Error('Plik nie wygląda jak poprawny XLSX. Sprawdź, czy to nie jest skrót .gsheet albo stary plik .xls.');
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

function parseJsonField(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function withUpload(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, error => {
      if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
      next();
    });
  };
}

function withUploadFields(fields) {
  return (req, res, next) => {
    uploadWieloplikowy.fields(fields)(req, res, error => {
      if (error) return res.status(400).json({ ok: false, error: String(error?.message || error) });
      next();
    });
  };
}

const runsStore = makeRunsStore({ dataDir: RUNS_DIR, log: (...args) => console.error(...args) });

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'pipeline', version: APP_VERSION });
});

app.get('/api/version', (req, res) => {
  res.json({ ok: true, version: APP_VERSION });
});

app.get('/api/browse-folder', (req, res) => {
  try {
    const result = browseFolder(req.query.path);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// Krok 1 UI: wgraj tabele adresowa, dowiedz sie jakie typy instalacji
// faktycznie wystepuja - zeby pokazac tylko sensowne kroki (patrz plan,
// "Zakres MVP" pkt 1-2).
app.post('/api/pipeline/analyze', withUpload('excel'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  try {
    await validateXlsxFile(req.file);
    const analiza = await analyzujTabeleAdresowa(req.file.path);
    res.json({ ok: true, ...analiza });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  } finally {
    if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
  }
});

app.get('/api/pipeline/list', (req, res) => {
  res.json({ ok: true, runs: runsStore.list ? runsStore.list() : [] });
});

app.delete('/api/pipeline/runs', (req, res) => {
  runsStore.removeAll();
  res.json({ ok: true });
});

app.delete('/api/pipeline/:runId', (req, res) => {
  runsStore.remove(req.params.runId);
  res.json({ ok: true });
});

app.get('/api/pipeline/status/:runId', (req, res) => {
  const run = runsStore.get(req.params.runId);
  if (!run) return res.status(404).json({ ok: false, error: 'Nie znaleziono przebiegu o tym identyfikatorze.' });
  res.json({ ok: true, run });
});

// Krok 3 UI: zatwierdzenie wyboru krokow -> start przebiegu. Pliki Excel sa
// KOPIOWANE do wlasnego folderu roboczego przebiegu (nie zostaja w
// tymczasowym UPLOAD_DIR), zeby przetrwaly do czasu, gdy uzytkownik wroci
// pozniej po "collect-dobory" (patrz "Ryzyka i decyzje projektowe" w planie).
//
// dokSeryjneExcelSolary/dokSeryjneExcelPompy: OSOBNE tabele Excel do
// dokumentow seryjnych, INNE niz glowna tabela adresowa (audyt 2026-08-21,
// zgloszenie wlasciciela - dokumenty seryjne potrzebuja wlasnej tabeli z
// danymi typu "Beneficjent", ktorych nie ma w glownej tabeli adresowej; ta
// tabela siedzi w tym samym folderze "wzor", co karty katalogowe - stad
// folder wzoru jest WYLICZANY z rootPathSolary/rootPathPompy, nie podawany
// osobno, patrz lib/wzorFolderResolve.js).
app.post('/api/pipeline/start', withUploadFields([
  { name: 'excel', maxCount: 1 },
  { name: 'dokSeryjneExcelSolary', maxCount: 1 },
  { name: 'dokSeryjneExcelPompy', maxCount: 1 },
  { name: 'dokSeryjneTemplatesSolary', maxCount: 20 },
  { name: 'dokSeryjneTemplatesPompy', maxCount: 20 }
]), async (req, res) => {
  const excelFile = req.files?.excel?.[0];
  const dokSeryjneExcelSolaryFile = req.files?.dokSeryjneExcelSolary?.[0] || null;
  const dokSeryjneExcelPompyFile = req.files?.dokSeryjneExcelPompy?.[0] || null;
  const dokSeryjneTemplatesSolaryFiles = req.files?.dokSeryjneTemplatesSolary || [];
  const dokSeryjneTemplatesPompyFiles = req.files?.dokSeryjneTemplatesPompy || [];
  if (!excelFile) return res.status(400).json({ ok: false, error: 'Nie przesłano pliku Excel.' });
  try {
    await validateXlsxFile(excelFile);
    if (dokSeryjneExcelSolaryFile) await validateXlsxFile(dokSeryjneExcelSolaryFile);
    if (dokSeryjneExcelPompyFile) await validateXlsxFile(dokSeryjneExcelPompyFile);

    const kroki = parseJsonField(req.body.kroki, {});
    const generatory = parseJsonField(req.body.generatory, {});
    const opcjeDoboru = parseJsonField(req.body.opcjeDoboru, {});

    const investmentFolder = String(req.body.investmentFolder || '').trim() || null;
    const rootPathSolary = String(req.body.rootPathSolary || '').trim() || null;
    const rootPathPompy = String(req.body.rootPathPompy || '').trim() || null;
    const audytyPath = String(req.body.audytyPath || '').trim() || null;

    const ETYKIETY_POL_SCIEZEK = {
      rootPathSolary: 'Główny folder Solary/Kolektory',
      rootPathPompy: 'Główny folder inwestycji (Pompy)',
      audytyPath: 'Folder z gotowymi audytami',
      investmentFolder: 'Folder inwestycji'
    };
    for (const [pole, wartosc] of [['rootPathSolary', rootPathSolary], ['rootPathPompy', rootPathPompy], ['audytyPath', audytyPath], ['investmentFolder', investmentFolder]]) {
      if (wartosc && !fs.existsSync(wartosc)) {
        throw new Error(`Podana ścieżka dla pola "${ETYKIETY_POL_SCIEZEK[pole] || pole}" nie istnieje: ${wartosc}`);
      }
    }

    const selection = parseJsonField(req.body.selection, null);
    // Audyt 2026-08-21 (real incydent - przypadkowy start na 70 adresow):
    // brakujaca/zla selekcja NIGDY nie moze po cichu oznaczac "przetworz
    // wszystkie adresy" - prawdziwy frontend ZAWSZE wysyla pelna selekcje
    // (domyslnie wszystko zaznaczone po wczytaniu podgladu), wiec jej brak
    // tutaj oznacza zepsute/pominiete zadanie, nie "brak filtrowania".
    if (selection === null || typeof selection !== 'object') {
      throw new Error('Brak selekcji adresów. Odśwież stronę, wgraj tabelę ponownie i spróbuj jeszcze raz.');
    }

    const run = runsStore.create({});
    const runStagingDir = path.join(runsStore.stagingRoot, run.id);
    await fsp.mkdir(runStagingDir, { recursive: true });
    const uploadedPath = path.join(runStagingDir, 'tabela-adresowa-wgrana.xlsx');
    await fsp.copyFile(excelFile.path, uploadedPath);
    // Jesli uzytkownik odznaczyl w podgladzie (krok 1 UI) czesc adresow,
    // KAZDY kolejny krok pipeline'u dostaje juz TYLKO ta przefiltrowana
    // kopie zamiast oryginalu - patrz src/runs.js#zbudujExcelWgSelekcji
    // (jedyny sposob na "wybor czesci adresow" dla apek bez wlasnego
    // wsparcia dla zaznaczania wierszy, np. karty-katalogowe).
    const excelPath = await zbudujExcelWgSelekcji({ sourcePath: uploadedPath, outputPath: path.join(runStagingDir, 'tabela-adresowa.xlsx'), selection });

    let dokSeryjneExcelSolary = null;
    if (dokSeryjneExcelSolaryFile) {
      dokSeryjneExcelSolary = path.join(runStagingDir, 'dokumenty-seryjne-solary.xlsx');
      await fsp.copyFile(dokSeryjneExcelSolaryFile.path, dokSeryjneExcelSolary);
    }
    let dokSeryjneExcelPompy = null;
    if (dokSeryjneExcelPompyFile) {
      dokSeryjneExcelPompy = path.join(runStagingDir, 'dokumenty-seryjne-pompy.xlsx');
      await fsp.copyFile(dokSeryjneExcelPompyFile.path, dokSeryjneExcelPompy);
    }

    // Szablony .docx wybrane przez uzytkownika (nie caly folder "wzor" -
    // audyt 2026-08-24) - kopiowane do wlasnego folderu roboczego przebiegu
    // z tego samego powodu co pliki Excel wyzej.
    async function skopiujSzablony(pliki, podfolder) {
      const dir = path.join(runStagingDir, podfolder);
      await fsp.mkdir(dir, { recursive: true });
      const sciezki = [];
      for (const plik of pliki) {
        const docelowa = path.join(dir, decodeOriginalName(plik.originalname));
        await fsp.copyFile(plik.path, docelowa);
        sciezki.push(docelowa);
      }
      return sciezki;
    }
    const dokSeryjneTemplatesSolary = await skopiujSzablony(dokSeryjneTemplatesSolaryFiles, 'szablony-solary');
    const dokSeryjneTemplatesPompy = await skopiujSzablony(dokSeryjneTemplatesPompyFiles, 'szablony-pompy');

    runsStore.update(run.id, r => {
      r.input = { excelPath, investmentFolder, rootPathSolary, rootPathPompy, audytyPath, dokSeryjneExcelSolary, dokSeryjneExcelPompy, dokSeryjneTemplatesSolary, dokSeryjneTemplatesPompy, kroki, generatory, opcjeDoboru };
    });

    res.json({ ok: true, runId: run.id });

    // Fire-and-forget, ten sam wzorzec co formularze-varmero/formularze-ecodan -
    // odpowiedz HTTP nie czeka na caly przebieg (moze trwac dlugo, zwlaszcza
    // gdy uruchomiony jest Dobor Varmero).
    setImmediate(() => {
      wykonajPrzebieg(runsStore, run.id, CHILD_APPS).catch(err => {
        runsStore.update(run.id, r => { r.status = 'blad'; r.bladOgolny = String(err?.message || err); });
      });
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  } finally {
    if (excelFile?.path) fsp.unlink(excelFile.path).catch(() => {});
    if (dokSeryjneExcelSolaryFile?.path) fsp.unlink(dokSeryjneExcelSolaryFile.path).catch(() => {});
    if (dokSeryjneExcelPompyFile?.path) fsp.unlink(dokSeryjneExcelPompyFile.path).catch(() => {});
    for (const plik of [...dokSeryjneTemplatesSolaryFiles, ...dokSeryjneTemplatesPompyFiles]) {
      if (plik?.path) fsp.unlink(plik.path).catch(() => {});
    }
  }
});

// Osobny, wielokrotnie ponownie-wywolywalny krok (patrz plan) - uzytkownik
// wraca pozniej (godziny/dni) i sprawdza, co z Doborow myEcodan/Varmero juz
// jest gotowe, bez ponownego odpalania calego przebiegu.
app.post('/api/pipeline/:runId/collect-dobory', async (req, res) => {
  try {
    const wynik = await collectDobory(runsStore, req.params.runId, CHILD_APPS);
    res.json({ ok: true, ...wynik });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// "Przerwij przebieg" - anuluje aktywne joby generatorow (myEcodan/Varmero,
// przez ich wlasne /api/batch/cancel) i zatrzymuje kolejne kroki. Audyt
// 2026-08-21: real incydent, brak tego przycisku zmusil do recznego
// szukania jobId przez API child-apki, zeby zatrzymac przypadkowy start dla
// 70 adresow.
app.post('/api/pipeline/:runId/cancel', async (req, res) => {
  try {
    const wynik = await przerwijPrzebieg(runsStore, req.params.runId, CHILD_APPS);
    res.json({ ok: true, ...wynik });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`pipeline (${APP_VERSION}) nasłuchuje na http://${HOST}:${PORT}`);
});
