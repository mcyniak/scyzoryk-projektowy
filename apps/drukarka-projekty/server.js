const rateLimitLib = require("express-rate-limit");
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { setupProcessDiagnostics, applyHttpTimeouts, readJsonFileNoBom, writeJsonFileNoBom } = require("../../lib/hardening");
const { getAppDataDir } = require("../../lib/appPaths");
const { sessionMiddleware } = require("./lib/sessionStore");
const excelInvestment = require("./src/excelInvestment");
const folderMatch = require("./src/folderMatch");
const wmFolder = require("./src/wmFolder");
const printService = require("../../lib/printing");
const { withPrintLease, PrintLeaseBusyError } = require("../../lib/printCoordinator");
const pdfMerge = require("./src/pdfMerge");
const pdfStamp = require("./src/pdfStamp");

const app = express();
const APP_DATA_ROOT = getAppDataDir("drukarka-projekty");
setupProcessDiagnostics("drukarka-projekty", APP_DATA_ROOT);
const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.SCYZORYK_HOST || "127.0.0.1";
// Brak takiego limitu bylo niespojnoscia wobec apps/drukarka (MAX_QUEUE=200) -
// skan WM potrafi realnie zwrocic 100+ pozycji z jednego folderu.
const MAX_QUEUE = Number(process.env.DRUKARKA_PROJEKTY_MAX_QUEUE || 500);
const DATA_DIR = path.join(APP_DATA_ROOT, "data");
const LAST_FOLDERS_FILE = path.join(DATA_DIR, "ostatnie-foldery.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};
app.disable("x-powered-by");
app.use((req, res, next) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); next(); });
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Scyzoryk-Request") === "1") return next();
  res.status(403).json({ ok: false, message: "Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie." });
});
app.use(express.json({ limit: "2mb" }));

app.use(sessionMiddleware(() => ({
  queue: [],
  printing: false,
  lastBaseFolder: null,
  status: { printing: false, message: "Gotowy", current: 0, total: 0, percent: 0, done: false, error: null }
}), (expiredSessionData) => {
  // Sesja wygasa niezaleznie od tego, czy ktos zdazyl kliknac "drukuj" - bez
  // tego polaczone PDF-y porzuconej sesji czekaly az do niezaleznego,
  // znacznie luzniej powiazanego sweep'a scheduleCleanup nad calym MERGED_DIR.
  cleanupSessionMergedFiles(expiredSessionData);
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.DRUKARKA_PROJEKTY_API_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET",
  message: { ok: false, message: "Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie." }
});
app.use("/api", apiLimiter);
app.use('/shared', express.static(path.join(__dirname, '..', '..', 'shared-styles')));
app.use(express.static(path.join(__dirname, "public")));

const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function readLastFolders() {
  try {
    if (fs.existsSync(LAST_FOLDERS_FILE)) return readJsonFileNoBom(LAST_FOLDERS_FILE);
  } catch (_) {}
  return {};
}
// Audyt P0-6a: klucz byl WYLACZNIE nazwa zakladki Excela (np. "Pompy") - jesli
// uzytkownik wgral dwie ROZNE inwestycje, obie z zakladka o tej samej nazwie,
// druga inwestycja dostawala podpowiedziany folder bazowy z PIERWSZEJ (zly
// folder). Teraz klucz to hash zawartosci wgranego pliku + nazwa zakladki -
// dwie rozne inwestycje (rozna zawartosc pliku) nigdy nie dziela klucza, nawet
// przy identycznej nazwie zakladki. `fileKey` jest opcjonalny (przekazywany z
// frontendu od tej zmiany) - jesli go brak (stary klient/cache przegladarki),
// spadamy na sama nazwe zakladki jak dawniej, zeby nic sie nie wywalilo.
function lastFolderKey(fileKey, sheetName) {
  const key = String(fileKey || "").trim();
  return key ? `${key}::${sheetName}` : sheetName;
}
function saveLastFolder(key, folderPath) {
  try {
    const data = readLastFolders();
    data[key] = folderPath;
    writeJsonFileNoBom(LAST_FOLDERS_FILE, data);
  } catch (_) {}
}
function computeFileKey(buffer) {
  try {
    return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 20);
  } catch (_) {
    return "";
  }
}

function decodeOriginalName(name) {
  try { return Buffer.from(name, "latin1").toString("utf8"); } catch { return name; }
}

app.get("/api/printers", async (req, res) => {
  try {
    const printers = await printService.listPrinters();
    res.json({ ok: true, printers });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Nie udalo sie pobrac listy drukarek.", printers: [] });
  }
});

app.post("/api/excel/upload", excelUpload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Brak pliku." });
    const { token, sheets } = excelInvestment.loadWorkbookFromBuffer(req.file.buffer);
    // fileKey identyfikuje TRESC wgranego pliku (hash), nie sesje uploadu -
    // patrz komentarz przy lastFolderKey powyzej. Token z loadWorkbookFromBuffer
    // jest per-upload/ulotny (wygasa z workbookiem), wiec nie nadaje sie jako
    // trwaly klucz pamieci ostatniego folderu.
    const fileKey = computeFileKey(req.file.buffer);
    res.json({ ok: true, token, sheets, fileKey, fileName: decodeOriginalName(req.file.originalname) });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie odczytac pliku Excel." });
  }
});

app.get("/api/excel/:token/sheets/:sheetName/candidates", (req, res) => {
  try {
    const { candidates, columnsFound } = excelInvestment.listCandidates(req.params.token, req.params.sheetName);
    const lastFolders = readLastFolders();
    const fileKey = String(req.query.fileKey || "").trim();
    // Fallback na sama nazwe zakladki (klucz sprzed tej poprawki) - jesli nic
    // nie ma pod kombinowanym kluczem, sprobuj starego, zeby wpisy zapisane
    // przed ta zmiana nie znikaly bez powodu.
    const lastFolder = lastFolders[lastFolderKey(fileKey, req.params.sheetName)] || lastFolders[req.params.sheetName] || "";
    res.json({ ok: true, candidates, columnsFound, lastFolder });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie odczytac zakladki.", columnsFound: err.columnsFound });
  }
});

app.post("/api/wm/scan", async (req, res) => {
  const folderPath = String(req.body?.folderPath || "").trim();
  const powykonawczy = !!req.body?.powykonawczy;
  if (!folderPath) return res.status(400).json({ ok: false, message: "Podaj sciezke folderu z wnioskami materialowymi (WM)." });
  let stat;
  try { stat = fs.statSync(folderPath); } catch (_) { stat = null; }
  if (!stat || !stat.isDirectory()) {
    return res.status(400).json({ ok: false, message: "Nie znaleziono folderu: " + folderPath });
  }
  try {
    // Ten sam mechanizm ograniczenia sciezek co przy dopasowaniu adresu -
    // /api/queue/set zaakceptuje potem tylko pliki lezace w tym folderze.
    req.session.lastBaseFolder = folderPath;
    const result = await wmFolder.scanWmFolder(folderPath, { powykonawczy });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie przeskanowac folderu WM." });
  }
});

async function matchOneAddress(baseFolder, lpGmina, addressHint) {
  const { matches, allFolders } = folderMatch.findAddressFolder(baseFolder, lpGmina);
  if (matches.length === 0) {
    return { ok: false, message: `Nie znaleziono folderu zaczynajacego sie od numeru "${lpGmina}".`, allFolders };
  }
  if (matches.length > 1) {
    return { ok: false, message: `Znaleziono wiecej niz jeden pasujacy folder dla numeru "${lpGmina}".`, matches };
  }

  const folderName = matches[0];
  // Audyt P0-6b: dopasowanie po LP sprawdzalo WYLACZNIE numer na poczatku
  // nazwy folderu - addressHint (adres z Excela) byl odczytany, ale nigdy nie
  // porownywany z folderName. Dwie rozne inwestycje moga miec ten sam numer
  // LP (numeracja zaczyna sie od nowa w kazdej), wiec bez tej kontroli
  // dopasowanie moglo cicho podpiac zupelnie inny adres. Jesli nie mamy adresu
  // z Excela (addressHint.adres puste) - nie ma z czym porownac, zachowujemy
  // dotychczasowe zachowanie (nie blokujemy).
  if (addressHint?.adres) {
    const tokens = folderMatch.addressTokens(addressHint.adres);
    if (tokens.length && !folderMatch.filenameMatchesOwnAddress(folderName, tokens)) {
      return {
        ok: false,
        message: `Znaleziono folder "${folderName}" dla numeru "${lpGmina}", ale jego nazwa nie pasuje do adresu "${addressHint.adres}" - mozliwy konflikt numeracji miedzy inwestycjami. Sprawdz recznie.`,
        folderName,
        allFolders
      };
    }
  }
  const folderPath = path.join(baseFolder, folderName);
  const classifiedRaw = folderMatch.classifyFiles(folderPath);
  const classified = await folderMatch.detectByContent(folderPath, classifiedRaw);

  let attachmentsList = [];
  try {
    const otText = await folderMatch.extractText(folderPath, classified.techDescDocx, classified.techDescPdf);
    attachmentsList = folderMatch.extractAttachmentsList(otText);
  } catch (err) {}

  const order = folderMatch.buildOrder(classified, attachmentsList, addressHint);
  const orderWithPaths = order.map((entry, idx) => ({
    position: idx + 1,
    fileName: entry.file,
    fullPath: entry.file ? path.join(folderPath, entry.file) : null,
    label: entry.label,
    confidence: entry.confidence
  }));

  const missingCount = orderWithPaths.filter(o => !o.fileName).length;
  return { ok: true, folderName, folderPath, attachmentsFound: attachmentsList, order: orderWithPaths, missingCount };
}

app.post("/api/match", async (req, res) => {
  const { sheetName, lpGmina, baseFolder, adres, gmina, fileKey } = req.body || {};
  if (!lpGmina || !baseFolder) {
    return res.status(400).json({ ok: false, message: "Brak numeru LP gmina albo folderu bazowego." });
  }
  try {
    if (sheetName) saveLastFolder(lastFolderKey(fileKey, sheetName), baseFolder);
    req.session.lastBaseFolder = baseFolder;
    const result = await matchOneAddress(baseFolder, lpGmina, { adres, gmina });
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie dopasowac folderu." });
  }
});

app.post("/api/match-batch", async (req, res) => {
  const { sheetName, baseFolder, candidates, allAddresses, fileKey } = req.body || {};
  if (!baseFolder || !Array.isArray(candidates) || !candidates.length) {
    return res.status(400).json({ ok: false, message: "Brak folderu bazowego albo listy adresow." });
  }
  if (sheetName) saveLastFolder(lastFolderKey(fileKey, sheetName), baseFolder);
  req.session.lastBaseFolder = baseFolder;

  const results = new Array(candidates.length);
  const CONCURRENCY = 3;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < candidates.length) {
      const idx = nextIndex++;
      const c = candidates[idx];
      try {
        const otherAddresses = (Array.isArray(allAddresses) ? allAddresses : [])
          .filter(a => a !== c.adres);
        const r = await matchOneAddress(baseFolder, c.lpGmina, { adres: c.adres, gmina: c.gmina, otherAddresses });
        results[idx] = { lpGmina: c.lpGmina, adres: c.adres, imie: c.imie, ...r };
      } catch (err) {
        results[idx] = { lpGmina: c.lpGmina, adres: c.adres, imie: c.imie, ok: false, message: err.message || "Blad." };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

  const foldersFound = results.filter(r => r.ok).length;
  const foldersMissing = results.filter(r => !r.ok).length;
  const filesUnresolved = results.filter(r => r.ok).reduce((sum, r) => sum + (r.missingCount || 0), 0);

  res.json({
    ok: true,
    results,
    summary: { totalRequested: candidates.length, foldersFound, foldersMissing, filesUnresolved }
  });
});

function buildQueueItem(fullPath, label) {
  const safePath = String(fullPath || "").trim();
  const originalName = path.basename(safePath) || "plik";
  const id = Buffer.from(safePath || originalName).toString("base64url");
  return {
    id,
    originalName,
    label: label || "",
    path: safePath,
    url: `/api/file/${encodeURIComponent(id)}/preview`,
    ext: path.extname(originalName).toLowerCase()
  };
}

function isPathInsideFolder(filePath, folderPath) {
  if (!filePath || !folderPath) return false;
  try {
    const resolved = path.resolve(String(filePath)).toLowerCase();
    const resolvedFolder = path.resolve(String(folderPath)).toLowerCase();
    return resolved === resolvedFolder || resolved.startsWith(resolvedFolder + path.sep);
  } catch (_) {
    return false;
  }
}

function isMergedFile(filePath) {
  if (!filePath) return false;
  const normalized = path.resolve(String(filePath)).toLowerCase();
  // Obejmuje takze POWYKONAWCZA_DIR - kopie/konwersje PDF wytworzone przez
  // tryb "dokumentacja powykonawcza" sa rownie tymczasowe jak polaczone PDF-y
  // z MERGED_DIR i maja dzielic te sama sciezke czyszczenia
  // (cleanupSessionMergedFiles / cleanupPrintedMergedFilesLater nizej).
  return [MERGED_DIR, POWYKONAWCZA_DIR].some(dir => {
    const normalizedDir = path.resolve(dir).toLowerCase();
    return normalized === normalizedDir || normalized.startsWith(normalizedDir + path.sep);
  });
}

function removeMergedFile(filePath) {
  if (!isMergedFile(filePath)) return false;
  try {
    fs.rmSync(path.resolve(filePath), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function cleanupSessionMergedFiles(session) {
  if (!session || !Array.isArray(session.queue)) return;
  const remaining = [];
  for (const item of session.queue) {
    if (isMergedFile(item.path)) {
      removeMergedFile(item.path);
      continue;
    }
    remaining.push(item);
  }
  session.queue = remaining;
}

function cleanupPrintedMergedFilesLater(items, session) {
  // Polaczone PDF-y sa plikami tymczasowymi. Nie wolno ich kasowac od razu po
  // wywolaniu Acrobata, bo Acrobat/Windows spooler potrafi jeszcze czytac plik
  // po tym, jak skrypt druku juz zwrocil OK. Kasowanie od razu powodowalo, ze
  // polaczone PDF-y nie trafialy do kolejki albo zadanie znikalo.
  const delayMs = Number(process.env.DRUKARKA_PROJEKTY_MERGED_CLEANUP_AFTER_MS || (30 * 60 * 1000));
  const toRemove = (items || []).map(item => item && item.path).filter(isMergedFile);
  if (!toRemove.length) return;
  const timer = setTimeout(() => {
    for (const filePath of toRemove) removeMergedFile(filePath);
    if (session && Array.isArray(session.queue)) {
      session.queue = session.queue.filter(item => !toRemove.includes(item.path));
    }
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
}

async function buildQueueFromGroups(req, groups) {
  const built = [];
  const missing = [];
  for (const group of groups) {
    const items = Array.isArray(group.items) ? group.items : [];
    const resolved = [];
    for (const it of items) {
      const fullPath = String(it?.fullPath || "").trim();
      if (!fullPath) { missing.push(it?.fullPath || null); continue; }
      // fullPath jest danymi od klienta (przegladarka odsyla z powrotem to, co
      // dostala z /api/match*) - nie ufamy mu wprost, musi lezec wewnatrz
      // folderu bazowego z ostatniego dopasowania tej sesji. Bez tego dowolny
      // POST na ten endpoint mogl polaczyc/dodac do kolejki dowolny plik
      // dostepny dla konta serwera.
      if (!isPathInsideFolder(fullPath, req.session.lastBaseFolder)) { missing.push(fullPath); continue; }
      if (!fs.existsSync(fullPath)) {
        missing.push(fullPath);
        continue;
      }
      resolved.push({ ...it, fullPath, isPdf: fullPath.toLowerCase().endsWith(".pdf") });
    }

    // Audyt P1-3: wczesniej WSZYSTKIE PDF-y z grupy byly zbierane do jednej
    // listy i scalane razem, a kazdy plik nie-PDF dopisywany dopiero PO tym
    // polaczonym PDF-ie - to gubilo zamierzona kolejnosc (np. PDF, DOCX, PDF
    // stawalo sie PDF+PDF, DOCX). Teraz scalane sa TYLKO SASIADUJACE (w
    // oryginalnej kolejnosci z folderMatch.buildOrder) fragmenty PDF, a plik
    // nie-PDF przerywa taki fragment i zostaje na swoim miejscu w kolejnosci.
    let i = 0;
    while (i < resolved.length) {
      if (!resolved[i].isPdf) {
        built.push(buildQueueItem(resolved[i].fullPath, resolved[i].label || group.label || ""));
        i += 1;
        continue;
      }
      const runStart = i;
      while (i < resolved.length && resolved[i].isPdf) i += 1;
      const run = resolved.slice(runStart, i);
      if (run.length >= 2) {
        const safeLabel = String(group.label || "adres").replace(/[<>:"/\\|?*]/g, "_").slice(0, 80);
        const outPath = path.join(MERGED_DIR, `${req.sid}_${Date.now()}_${runStart}_${safeLabel}.pdf`);
        await pdfMerge.mergePdfs(run.map(r => r.fullPath), outPath);
        built.push(buildQueueItem(outPath, group.label || ""));
      } else {
        built.push(buildQueueItem(run[0].fullPath, run[0].label || group.label || ""));
      }
    }
  }
  return { built, missing };
}

const MERGED_DIR = path.join(DATA_DIR, "merged");
if (!fs.existsSync(MERGED_DIR)) fs.mkdirSync(MERGED_DIR, { recursive: true });
// Pliki robocze trybu "Drukuj jako dokumentacje powykonawcza" (kopie
// oryginalnych PDF-ow do ostemplowania, DOCX przekonwertowane do PDF) -
// tymczasowe jak MERGED_DIR, dlatego wspoldziela sprzatanie (isMergedFile
// wyzej sprawdza oba katalogi).
const POWYKONAWCZA_DIR = path.join(DATA_DIR, "powykonawcza");
if (!fs.existsSync(POWYKONAWCZA_DIR)) fs.mkdirSync(POWYKONAWCZA_DIR, { recursive: true });
const DOCX_TO_PDF_SCRIPT = path.join(__dirname, "scripts", "docx-to-pdf.ps1");
{
  const { scheduleCleanup } = require("../../lib/hardening");
  scheduleCleanup([MERGED_DIR, POWYKONAWCZA_DIR], 6 * 60 * 60 * 1000, 60 * 60 * 1000);
}

function powykonawczaTempPath(req, idx, originalFullPath, forceExt) {
  const base = path.basename(String(originalFullPath || "plik"));
  const ext = forceExt || path.extname(base) || ".pdf";
  const nameNoExt = base.slice(0, base.length - path.extname(base).length).replace(/[<>:"/\\|?*]/g, "_").slice(0, 80);
  return path.join(POWYKONAWCZA_DIR, `${req.sid}_${Date.now()}_${idx}_${nameNoExt}${ext}`);
}

// Konwertuje paczke plikow DOCX do PDF przez jedna sesje Word COM
// (scripts/docx-to-pdf.ps1) - identyczny, sprawdzony wzorzec nie-detached
// spawn co apps/wnioski-powykonawcze/server.js:runConvertScript (bezpieczny
// wobec bledu Windows/Node opisanego w run-update.ps1: detached:true zawsze
// zglasza kod wyjscia 0 niezaleznie od rzeczywistego wyniku - tu w ogole nie
// uzywamy detached, wiec problem nie dotyczy tego wywolania).
async function convertDocxBatchToPdf(files) {
  if (!files.length) return [];
  const stamp = `${process.pid}_${Date.now()}`;
  const inputJson = path.join(POWYKONAWCZA_DIR, `docx-to-pdf-in-${stamp}.json`);
  const outputJson = path.join(POWYKONAWCZA_DIR, `docx-to-pdf-out-${stamp}.json`);
  writeJsonFileNoBom(inputJson, { files });
  // Ponizej domyslnego HTTP requestTimeout serwera (10 min, lib/hardening.js)
  // - inaczej zerwanie polaczenia przez serwer wygladaloby jak zawieszenie,
  // zamiast czytelnego bledu "Przekroczono limit czasu..." nizej.
  const timeoutMs = Number(process.env.DRUKARKA_PROJEKTY_DOCX_TIMEOUT_MS || 5 * 60 * 1000);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DOCX_TO_PDF_SCRIPT,
        "-InputJson", inputJson, "-OutputJson", outputJson
      ], { cwd: __dirname, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        reject(new Error(`Przekroczono limit czasu konwersji DOCX->PDF (${Math.round(timeoutMs / 60000)} min).`));
      }, timeoutMs);
      timer.unref();
      child.on("error", err => { clearTimeout(timer); reject(err); });
      child.on("close", code => {
        clearTimeout(timer);
        if (code === 0 || fs.existsSync(outputJson)) return resolve();
        reject(new Error(stderr.trim() || `PowerShell (docx-to-pdf) zakonczyl sie kodem ${code}.`));
      });
    });
    const output = readJsonFileNoBom(outputJson);
    if (!output || output.ok !== true || !Array.isArray(output.results)) {
      throw new Error((output && output.error) || "Konwersja DOCX->PDF nie zwrocila wynikow.");
    }
    return output.results;
  } finally {
    try { fs.rmSync(inputJson, { force: true }); } catch (_) {}
    try { fs.rmSync(outputJson, { force: true }); } catch (_) {}
  }
}

// Przygotowuje kolejke do druku jako "dokumentacja powykonawcza" - wolane w
// /api/print, TUZ PRZED drukiem, na juz-zbudowanej session.queue (checkbox
// zyje na kroku "Drukuj", PO tym jak kolejka/scalanie PDF-ow juz powstalo w
// buildQueueFromGroups, wiec transformacja dziala na finalnych pozycjach
// kolejki, nie na surowych grupach). Kazda pozycja konczy jako WLASNA kopia w
// POWYKONAWCZA_DIR (nigdy oryginal klienta z folderu bazowego, ale juz-scalone
// PDF-y z MERGED_DIR sa same tymczasowe, wiec stemplowane w miejscu bez
// dodatkowej kopii), DOCX->PDF w jednej wspolnej sesji Word (szybciej niz
// osobna sesja na plik), a potem kazda strona kazdego pliku dostaje stempel
// przez pdfStamp.stampAllPages. Mutuje elementy queueItems w miejscu
// (item.path/item.ext) - session.queue trzyma te same obiekty, wiec
// printService i cleanupPrintedMergedFilesLater nizej widza juz nowe sciezki.
async function applyPowykonawczaTransformToQueue(req, queueItems) {
  if (!queueItems.length) return;

  const docxJobs = [];
  const toStamp = [];
  let idx = 0;
  for (const item of queueItems) {
    idx += 1;
    const itemPath = String(item.path || "");
    if (itemPath.toLowerCase().endsWith(".pdf")) {
      if (isMergedFile(itemPath)) {
        toStamp.push(item);
      } else {
        const destPath = powykonawczaTempPath(req, idx, itemPath, ".pdf");
        fs.copyFileSync(itemPath, destPath);
        item.path = destPath;
        toStamp.push(item);
      }
    } else if (itemPath.toLowerCase().endsWith(".docx")) {
      const destPath = powykonawczaTempPath(req, idx, itemPath, ".pdf");
      docxJobs.push({ inputPath: itemPath, outputPath: destPath, item });
    }
    // Inne typy (nie PDF, nie DOCX) nie da sie ostemplowac - zostaja bez
    // zmian, ida do druku jak zwykle.
  }

  if (docxJobs.length) {
    let results = [];
    try {
      results = await convertDocxBatchToPdf(docxJobs.map(j => ({ inputPath: j.inputPath, outputPath: j.outputPath })));
    } catch (err) {
      console.error("[drukarka-projekty] Konwersja DOCX->PDF (dokumentacja powykonawcza) nie powiodla sie:", err.message || err);
    }
    const byInput = new Map(results.map(r => [r.input, r]));
    for (const job of docxJobs) {
      const result = byInput.get(job.inputPath);
      if (result && result.ok && fs.existsSync(job.outputPath)) {
        job.item.path = job.outputPath;
        job.item.ext = ".pdf";
        toStamp.push(job.item);
      }
      // Jesli konwersja tego pliku sie nie powiodla, pozycja zostaje przy
      // oryginalnej sciezce .docx (bez stempla) - wole niekompletnie
      // ostemplowany pakiet niz calkowicie pominiety plik.
    }
  }

  for (const item of toStamp) {
    try {
      await pdfStamp.stampAllPages(item.path);
    } catch (err) {
      console.error("[drukarka-projekty] Stemplowanie 'DOKUMENTACJA POWYKONAWCZA' nie powiodlo sie dla", item.path, "-", err.message || err);
    }
  }
}

function normalizeSessionPrinting(session) {
  if (!session || typeof session !== "object") return;
  if (session.printing && session.status && session.status.printing !== true) {
    session.printing = false;
  }
  if (!session.printing && session.status && session.status.printing === true) {
    session.status.printing = false;
  }
}

app.post("/api/queue/set-merged", async (req, res) => {
  normalizeSessionPrinting(req.session);
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
  if (req.session.printing) return res.status(409).json({ ok: false, message: "Trwa drukowanie." });
  if (!groups.length) return res.status(400).json({ ok: false, message: "Brak grup do polaczenia." });

  cleanupSessionMergedFiles(req.session);
  let built = [];
  let missing = [];
  try {
    ({ built, missing } = await buildQueueFromGroups(req, groups));
  } catch (err) {
    return res.status(400).json({ ok: false, message: "Nie udalo sie polaczyc PDF-ow: " + (err.message || err) });
  }

  if (!built.length) {
    return res.status(400).json({ ok: false, message: "Nie utworzono żadnych pozycji w kolejce. Brak plików do dodania.", missing });
  }
  if (built.length > MAX_QUEUE) {
    return res.status(400).json({ ok: false, message: `Za duzo pozycji w kolejce (${built.length}). Limit: ${MAX_QUEUE}. Podziel na mniejsze paczki.` });
  }
  req.session.queue = built;
  res.json({ ok: true, queue: req.session.queue });
});

app.post("/api/queue/set", (req, res) => {
  normalizeSessionPrinting(req.session);
  cleanupSessionMergedFiles(req.session);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (req.session.printing) return res.status(409).json({ ok: false, message: "Trwa drukowanie." });

  const missing = [];
  const built = [];
  for (const it of items) {
    if (!it.fullPath) continue;
    // Patrz komentarz w buildQueueFromGroups - to samo ograniczenie do
    // ostatnio przeszukanego folderu tej sesji.
    if (!isPathInsideFolder(it.fullPath, req.session.lastBaseFolder)) { missing.push(it.fullPath); continue; }
    if (!fs.existsSync(it.fullPath)) { missing.push(it.fullPath); continue; }
    built.push(buildQueueItem(it.fullPath, it.label));
  }
  if (missing.length) {
    return res.status(400).json({ ok: false, message: "Niektore pliki nie istnieja na dysku.", missing });
  }
  if (built.length > MAX_QUEUE) {
    return res.status(400).json({ ok: false, message: `Za duzo pozycji w kolejce (${built.length}). Limit: ${MAX_QUEUE}. Podziel na mniejsze paczki.` });
  }
  req.session.queue = built;
  res.json({ ok: true, queue: req.session.queue });
});

app.get("/api/queue", (req, res) => res.json({ queue: req.session.queue }));

app.post("/api/queue/reorder", (req, res) => {
  normalizeSessionPrinting(req.session);
  if (req.session.printing) return res.status(409).json({ ok: false, message: "Nie mozna zmieniac kolejnosci podczas drukowania" });
  const order = req.body.order || [];
  const byId = new Map(req.session.queue.map(item => [item.id, item]));
  const next = [];
  for (const id of order) { if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); } }
  for (const item of byId.values()) next.push(item);
  req.session.queue = next;
  res.json({ ok: true, queue: req.session.queue });
});

app.delete("/api/queue/:id", (req, res) => {
  normalizeSessionPrinting(req.session);
  if (req.session.printing) return res.status(409).json({ ok: false, message: "Nie mozna usuwac podczas drukowania" });
  const removed = req.session.queue.find(item => item.id === req.params.id);
  if (removed) removeMergedFile(removed.path);
  req.session.queue = req.session.queue.filter(item => item.id !== req.params.id);
  res.json({ ok: true, queue: req.session.queue });
});

app.post("/api/queue/clear", (req, res) => {
  normalizeSessionPrinting(req.session);
  if (req.session.printing) return res.status(409).json({ ok: false, message: "Nie mozna czyscic podczas drukowania" });
  cleanupSessionMergedFiles(req.session);
  req.session.queue = [];
  res.json({ ok: true, queue: req.session.queue });
});

app.get("/api/preview-by-path", (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== "string") return res.status(400).send("Brak sciezki.");
  // Nie ufamy sciezce podanej przez klienta wprost - musi lezec wewnatrz
  // folderu bazowego, ktorego ta sama sesja przegladarki uzyla ostatnio do
  // wyszukiwania (/api/match, /api/match-batch). Bez tego dowolny request do
  // tego endpointu mogl posluzyc do odczytania dowolnego PDF-a dostepnego dla
  // konta, na ktorym dziala serwer.
  if (!isPathInsideFolder(filePath, req.session.lastBaseFolder)) {
    return res.status(403).send("Podglad dostepny tylko dla plikow z ostatnio przeszukanego folderu.");
  }
  if (!fs.existsSync(filePath)) return res.status(404).send("Nie znaleziono pliku.");
  if (path.extname(filePath).toLowerCase() !== ".pdf") return res.status(415).send("Podglad dostepny tylko dla PDF.");

  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", printService.contentDispositionHeader("inline", path.basename(filePath)));
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.resolve(filePath));
});

app.get("/api/file/:id/preview", (req, res) => {
  const item = req.session.queue.find(f => f.id === req.params.id);
  if (!item || !fs.existsSync(item.path)) return res.status(404).send("Nie znaleziono podgladu.");
  if (item.ext !== ".pdf") return res.status(415).send("Podglad dostepny tylko dla PDF. Ten plik otworz z Eksploratora.");

  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", printService.contentDispositionHeader("inline", item.originalName));
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.resolve(item.path));
});

app.get("/api/health", (req, res) => res.json({ ok: true, name: "drukarka-projekty", version: require("./package.json").version }));
app.get("/api/status", (req, res) => res.json(req.session.status));

app.post("/api/print", async (req, res) => {
  const session = req.session;
  normalizeSessionPrinting(session);
  if (session.printing) return res.status(409).json({ ok: false, message: "Drukowanie juz trwa" });
  if (!Array.isArray(session.queue) || !session.queue.length) {
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
    if (!groups.length) {
      return res.status(400).json({ ok: false, message: "Kolejka jest pusta. Najpierw dodaj pliki do kolejki." });
    }
    try {
      const { built, missing } = await buildQueueFromGroups(req, groups);
      if (!built.length) return res.status(400).json({ ok: false, message: "Nie utworzono żadnych pozycji w kolejce. Brak plików do dodania.", missing });
      session.queue = built;
    } catch (err) {
      return res.status(400).json({ ok: false, message: "Nie udalo sie utworzyc kolejki przed drukiem: " + (err.message || err) });
    }
  }

  // Patrz analogiczny komentarz w apps/drukarka/server.js - bez
  // Number.isFinite niepoprawne (nieliczbowe) wejscie cicho dawalo NaN i
  // zero wyslanych kopii mimo odpowiedzi ok:true.
  const rawDelaySeconds = Number(req.body.delaySeconds);
  const delaySeconds = Math.max(1, Math.min(300, Number.isFinite(rawDelaySeconds) ? rawDelaySeconds : 1));
  const rawCopies = Number(req.body.copies);
  const copies = Math.max(1, Math.min(20, Number.isFinite(rawCopies) ? rawCopies : 1));
  const copyMode = req.body.copyMode === "set" ? "set" : "file";
  const printerName = String(req.body.printerName || "").trim();
  const sideMode = req.body.sideMode === "one-sided" ? "one-sided" : "two-sided";

  const order = Array.isArray(req.body.order) ? req.body.order : [];
  if (order.length) {
    const byId = new Map(session.queue.map(item => [item.id, item]));
    const ordered = [];
    for (const id of order) { if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); } }
    for (const item of byId.values()) ordered.push(item);
    session.queue = ordered;
  }

  if (!session.queue.length) return res.status(400).json({ ok: false, message: "Brak plikow w kolejce" });

  // Checkbox "Drukuj jako dokumentacje powykonawcza" zyje na tym kroku (PO
  // zbudowaniu kolejki), dlatego transformacja dziala na juz-gotowych
  // pozycjach session.queue, a nie na surowych grupach w buildQueueFromGroups.
  if (Boolean(req.body?.stampPowykonawcza)) {
    try {
      await applyPowykonawczaTransformToQueue(req, session.queue);
    } catch (err) {
      return res.status(400).json({ ok: false, message: "Nie udalo sie przygotowac dokumentacji powykonawczej: " + (err.message || err) });
    }
  }

  try {
    await withPrintLease({ app: "drukarka-projekty", sessionId: req.sessionID || null, printerName }, async () => {
      session.printing = true;
      const itemsToPrint = [...session.queue];
      const printJobs = printService.buildPrintJobs(itemsToPrint, copies, copyMode);
      const printerLabel = printerName ? ` na drukarke "${printerName}"` : "";

      session.status = {
        printing: true,
        message: `Start drukowania: ${copies} kop.${printerLabel}`,
        current: 0,
        total: printJobs.length,
        percent: 0,
        done: false,
        error: null
      };

      try {
        res.json({ ok: true });

        // Bez tego wybor "Jednostronnie/Dwustronnie" w UI byl czystą dekoracją -
        // serwer nigdy nie czytal ani nie stosowal sideMode, wiec druk zawsze
        // wychodzil z takim ustawieniem duplexu, jakie akurat mial fizycznie
        // ustawione sterownik drukarki (patrz audyt: prawdziwy, zywy blad).
        await printService.withPrinterSides(sideMode, printerName, async printerSetup => {
          if (!printerSetup.ok) session.status.message = printerSetup.message;
          if (printerSetup.ok) await printService.wait(800);

          for (let i = 0; i < printJobs.length; i++) {
            const job = printJobs[i];
            const item = job.item;
            session.status.current = i + 1;
            session.status.total = printJobs.length;
            session.status.percent = Math.round((i / printJobs.length) * 100);
            session.status.message = `Wysylam do kolejki ${i + 1}/${printJobs.length}: ${item.label ? item.label + " - " : ""}${item.originalName}`;

            await printService.printFileWindows(item.path, printerName, {
              cwd: __dirname,
              logDir: DATA_DIR,
              timeoutMs: Number(process.env.DRUKARKA_PROJEKTY_PS_TIMEOUT_MS || 120000)
            });

            session.status.percent = Math.round(((i + 1) / printJobs.length) * 100);
            await printService.wait(delaySeconds * 1000);
          }
        });

        session.status.message = `✅ Wszystkie zadania wyslane do kolejki drukowania (${printJobs.length})`;
        session.status.percent = 100;
        session.status.done = true;
      } catch (err) {
        session.status.error = String(err.message || err);
        session.status.message = "❌ Blad drukowania: " + session.status.error;
      } finally {
        // Kolejka NIE czyscila sie nigdy po druku (ani tu, ani we froncie) - drugi
        // klik DRUKUJ po prostu wysylal cala kolejke jeszcze raz. Czyscimy JEJ
        // referencje w pamieci zawsze (sukces i blad), tak jak juz robi
        // apps/drukarka, zeby przypadkowy powtorny klik nie powielal fizycznego
        // wydruku. Same PLIKI polaczonych PDF-ow NIE sa kasowane od razu tutaj -
        // to robi ponizsze cleanupPrintedMergedFilesLater, z opoznieniem (patrz
        // jego komentarz: Acrobat/Windows potrafi jeszcze czytac plik tuz po
        // wyslaniu do druku).
        session.queue = [];
        cleanupPrintedMergedFilesLater(itemsToPrint, session);
        session.printing = false;
        session.status.printing = false;
      }
    });
  } catch (err) {
    if (err instanceof PrintLeaseBusyError) {
      return res.status(409).json({
        ok: false,
        code: "PRINT_LOCK_BUSY",
        message: err.message,
        owner: err.ownerMeta
      });
    }
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, message: err.message || "Nie udalo sie rozpoczac drukowania." });
    }
    session.status.error = String(err.message || err);
    session.status.message = "❌ Blad drukowania: " + session.status.error;
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ ok: false, message: err?.message || "Blad." });
});

// require.main === module: uruchomienie serwera TYLKO gdy plik jest startowany
// bezposrednio (node server.js), nie gdy jest wymagany przez testy (test/*.test.js
// wymaga buildQueueFromGroups ponizej i nie powinien przy tym bindowac portu).
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log("");
    console.log("Drukarka Projekty dziala tylko lokalnie:");
    console.log(`http://${HOST}:${PORT}`);
    console.log("");
  });
  applyHttpTimeouts(server, "DRUKARKA_PROJEKTY");
}

module.exports = { buildQueueFromGroups, applyPowykonawczaTransformToQueue, buildQueueItem };
