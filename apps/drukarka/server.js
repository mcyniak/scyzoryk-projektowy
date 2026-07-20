const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { setupProcessDiagnostics, applyHttpTimeouts, runPowerShell, scheduleCleanup } = require("../../lib/hardening");
const printService = require("../../lib/printing");
const { ensureAnonymousSessionExpress } = require("../../lib/auth/middleware");

const app = express();
setupProcessDiagnostics("drukarka", __dirname);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.SCYZORYK_HOST || "127.0.0.1";
const MAX_FILE_MB = Number(process.env.DRUKARKA_MAX_FILE_MB || 50);
const MAX_FILES = Number(process.env.DRUKARKA_MAX_FILES || 80);
const MAX_QUEUE = Number(process.env.DRUKARKA_MAX_QUEUE || 200);

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
for (const dir of [DATA_DIR, UPLOAD_DIR]) if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
scheduleCleanup([UPLOAD_DIR], 24 * 60 * 60 * 1000, 60 * 60 * 1000);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};
app.disable("x-powered-by");
app.use((req, res, next) => { for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value); next(); });
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Scyzoryk-Request") === "1") return next();
  res.status(403).json({ ok: false, message: "Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie." });
});
app.use(express.json({ limit: "2mb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.DRUKARKA_API_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
  // Podglad, status i lista kolejki sa odpytywane czesto przez UI.
  // Nie mozna ich limitowac tak samo jak ciezkich zadan, bo po kilku minutach
  // zwyklej pracy pojawial sie falszywy komunikat "Za duzo zadan".
  skip: (req) => req.method === 'GET',
  message: { ok: false, message: 'Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.DRUKARKA_HEAVY_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za duzo ciezkich zadan w krotkim czasie. Uruchom mniejsza paczke albo odczekaj chwile.' }
});
app.use('/api', apiLimiter);

// Rejestrowany PRZED middleware sesyjnym ponizej - root server.js odpytuje
// to co ~10s jako health-check, bez ciasteczka sesji. Gdyby ta trasa lezala
// ZA ensureAnonymousSessionExpress (jak wczesniej /api/status), kazdy
// pojedynczy health-check tworzylby nowa anonimowa sesje (plik na dysku +
// wpis w sessionStates ponizej) - w praktyce tysiace martwych sesji dziennie
// z samej diagnostyki, nigdy nie uzytych przez zadnego czlowieka.
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Pracownicy NIE musza sie logowac - to tylko anonimowa izolacja danych
// roboczych miedzy przegladarkami, NIGDY nie blokuje zadania. Bez tego
// (SCYZORYK_PILOT_MODE nieustawione, tak jak dzis na Windows) kolejka
// zostaje globalna jak zawsze - jedno stanowisko, jeden uzytkownik na raz,
// zgodnie z dzisiejszym zachowaniem.
const PILOT_MODE = process.env.SCYZORYK_PILOT_MODE === '1';
if (PILOT_MODE) app.use(ensureAnonymousSessionExpress);

app.use(express.static(path.join(__dirname, "public")));

// Przycisk "Panel glowny" w gornym pasku potrzebuje znac PRAWDZIWY port
// panelu (root server.js przekazuje go jako SCYZORYK_MAIN_PORT przy
// spawnowaniu) - bez tego link byl na stale wpisany jako :3000 w JS, co
// psulo sie, gdy panel biegal na innym porcie (np. 80 w tym pilocie).
app.get("/api/panel-info", (req, res) => {
  res.json({ mainPort: Number(process.env.SCYZORYK_MAIN_PORT || 3000) });
});

// W profilu linux-pilot kazda przegladarka (sesja) ma WLASNA kolejke plikow,
// wlasny stan drukowania i wlasny status - inaczej pliki jednej osoby
// mieszalyby sie w kolejce widocznej u drugiej. Na Windows (PILOT_MODE=false,
// jak dzisiaj) zostaje jeden wspolny stan - to narzedzie bylo projektowane
// dla jednego stanowiska/jednej osoby na raz, wiec zachowanie tam sie nie
// zmienia.
// sessionId -> { state, lastActivity } - bez TTL ta Mapa rosla bez konca
// (kazdy health-check/nowa przegladarka to nowy wpis, nigdy nie usuwany do
// restartu procesu). SESSION_STATE_MAX_IDLE_MS/cleanup nizej to ogranicza.
const sessionStates = new Map();
const SESSION_STATE_MAX_IDLE_MS = 12 * 60 * 60 * 1000;
function freshState() {
  return {
    queue: [],
    printing: false,
    status: { printing: false, message: "Gotowy", current: 0, total: 0, percent: 0, done: false, error: null, warning: null }
  };
}
const globalState = freshState();
function getState(req) {
  if (!PILOT_MODE) return globalState;
  const sid = req.sessionId || 'anonim';
  if (!sessionStates.has(sid)) sessionStates.set(sid, { state: freshState(), lastActivity: Date.now() });
  const entry = sessionStates.get(sid);
  entry.lastActivity = Date.now();
  return entry.state;
}
function cleanupOldSessionStates() {
  const now = Date.now();
  for (const [sid, entry] of sessionStates.entries()) {
    if (entry.state.printing) continue; // nigdy nie usuwaj aktywnie drukujacej sesji
    if (now - entry.lastActivity > SESSION_STATE_MAX_IDLE_MS) sessionStates.delete(sid);
  }
}
if (PILOT_MODE) {
  const sessionStatesCleanupTimer = setInterval(cleanupOldSessionStates, 30 * 60 * 1000);
  sessionStatesCleanupTimer.unref?.();
}



// Node.js pozwala w surowych naglowkach HTTP tylko na znaki Latin-1. Polskie
// znaki takie jak Z, N, A, L, E, S, Z (poza o/O, ktore akurat miesci sie w
// Latin-1) wywalaly caly request bledem 400 "Invalid character in header
// content [\"Content-Disposition\"]" - to byla przyczyna "podglad nie dziala"
// dla plikow z polskimi znakami w nazwie. Budujemy naglowek zgodnie z RFC
// 6266/5987: ASCII-owy fallback w filename= (dla starych klientow) i
// poprawnie zakodowana pelna nazwa w filename*=UTF-8''...


function decodeOriginalName(name) {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = printService.safeName(decodeOriginalName(file.originalname));
    const unique = Date.now() + "_" + Math.round(Math.random() * 1e9);
    cb(null, unique + "_" + original);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const original = decodeOriginalName(file.originalname);
    const ext = path.extname(original).toLowerCase();

    if ([".pdf", ".doc", ".docx"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Dozwolone sa tylko PDF, DOC i DOCX"));
    }
  }
});



function psEscape(str) {
  return String(str).replace(/'/g, "''");
}

function runPrinterPowerShell(command) {
  return runPowerShell(null, ["-Command", command], { cwd: __dirname, timeoutMs: Number(process.env.DRUKARKA_PS_TIMEOUT_MS || 120000), windowsHide: true });
}

async function applyPrinterSides(sideMode, printerName) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "Ustawienie jednostronnie/dwustronnie jest dostepne tylko na Windows."
    };
  }

  const mode = sideMode === "two-sided" ? "TwoSidedLongEdge" : "OneSided";
  const label = sideMode === "two-sided" ? "dwustronnie" : "jednostronnie";

  const targetPrinterPs = printerName ? "'" + printerName.replace(/'/g, "''") + "'" : "$null"; const command = `
    $ErrorActionPreference = 'Stop'
    $printer = if (${targetPrinterPs}) { Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq ${targetPrinterPs} } | Select-Object -First 1 } else { Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1 }
    if (-not $printer) { throw 'Brak drukarki domyslnej.' }
    Set-PrintConfiguration -PrinterName $printer.Name -DuplexingMode ${mode}
    Write-Output ($printer.Name + '|' + '${label}')
  `;

  try {
    const result = await runPrinterPowerShell(command);
    const line = String(result.stdout || "").trim().split(/\r?\n/).pop() || "";
    const [printerName] = line.split("|");

    return {
      ok: true,
      message: printerName
        ? `Ustawiono drukarke ${printerName}: ${label}.`
        : `Ustawiono drukowanie: ${label}.`
    };
  } catch (err) {
    return {
      ok: false,
      message: `Nie udalo sie automatycznie ustawic trybu ${label}. Sterownik drukarki moze tego nie obslugiwac. Drukowanie bedzie wyslane z aktualnymi ustawieniami drukarki.`
    };
  }
}








function readHeader(filePath, length = 8) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { fs.closeSync(fd); }
}

function validateUploadedDocument(file) {
  const ext = path.extname(decodeOriginalName(file.originalname)).toLowerCase();
  const header = readHeader(file.path, 8);
  const ascii = header.toString('latin1');
  const hex = header.toString('hex').toLowerCase();
  if (ext === '.pdf' && !ascii.startsWith('%PDF-')) throw new Error(`Plik ${decodeOriginalName(file.originalname)} nie wyglada jak poprawny PDF.`);
  if (ext === '.docx' && !ascii.startsWith('PK')) throw new Error(`Plik ${decodeOriginalName(file.originalname)} nie wyglada jak poprawny DOCX.`);
  if (ext === '.doc' && !hex.startsWith('d0cf11e0')) throw new Error(`Plik ${decodeOriginalName(file.originalname)} nie wyglada jak poprawny DOC.`);
}

function cleanupFiles(items) {
  for (const item of items) {
    try {
      if (item.path && fs.existsSync(item.path)) {
        fs.unlinkSync(item.path);
      }
    } catch {}
  }
}

app.post("/api/upload", heavyJobLimiter, (req, res, next) => {
  const state = getState(req);
  if (state.printing) {
    return res.status(409).json({
      ok: false,
      message: "Trwa drukowanie. Poczekaj, az aktualne pliki zostana wyslane do kolejki drukowania."
    });
  }
  next();
}, upload.array("files", MAX_FILES), (req, res) => {
  const state = getState(req);
  try {
    if (state.queue.length + (req.files || []).length > MAX_QUEUE) {
      cleanupFiles((req.files || []).map(file => ({ path: file.path })));
      return res.status(400).json({ ok: false, message: `Za duzo plikow w kolejce. Limit: ${MAX_QUEUE}.` });
    }
    for (const file of req.files || []) validateUploadedDocument(file);
    const added = (req.files || []).map(file => {
      const originalName = decodeOriginalName(file.originalname);
      const item = { id: file.filename, originalName, filename: file.filename, path: file.path, url: `api/file/${encodeURIComponent(file.filename)}/preview`, ext: path.extname(originalName).toLowerCase() };
      state.queue.push(item);
      return item;
    });
    res.json({ ok: true, added, queue: state.queue });
  } catch (err) {
    cleanupFiles((req.files || []).map(file => ({ path: file.path })));
    res.status(400).json({ ok: false, message: err.message || "Niepoprawny plik." });
  }
});

app.get("/api/file/:id/preview", (req, res) => {
  const state = getState(req);
  const item = state.queue.find(file => file.id === req.params.id);
  if (!item || item.ext !== ".pdf" || !fs.existsSync(item.path)) return res.status(404).send("Nie znaleziono podgladu PDF.");

  // Podglad PDF jest wyswietlany w ramce wewnatrz tej samej aplikacji.
  // Globalne naglowki bezpieczenstwa blokowaly iframe (X-Frame-Options: DENY
  // oraz frame-ancestors 'none'), dlatego Chrome pokazywal szara ikonke pliku.
  // Dla samego podgladu PDF dopuszczamy osadzenie tylko z tej samej aplikacji.
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

app.get("/api/queue", (req, res) => {
  res.json({ queue: getState(req).queue });
});

app.post("/api/reorder", (req, res) => {
  const state = getState(req);
  if (state.printing) {
    return res.status(409).json({ ok: false, message: "Nie mozna zmieniac kolejnosci podczas drukowania" });
  }

  const order = req.body.order || [];
  const byId = new Map(state.queue.map(item => [item.id, item]));
  const next = [];

  for (const id of order) {
    if (byId.has(id)) {
      next.push(byId.get(id));
      byId.delete(id);
    }
  }

  for (const item of byId.values()) {
    next.push(item);
  }

  state.queue = next;
  res.json({ ok: true, queue: state.queue });
});

app.delete("/api/file/:id", (req, res) => {
  const state = getState(req);
  if (state.printing) {
    return res.status(409).json({
      ok: false,
      message: "Nie mozna usuwac podczas drukowania"
    });
  }

  const id = req.params.id;
  const found = state.queue.find(item => item.id === id);
  state.queue = state.queue.filter(item => item.id !== id);

  if (found) cleanupFiles([found]);

  res.json({ ok: true, queue: state.queue });
});

app.post("/api/clear", (req, res) => {
  const state = getState(req);
  if (state.printing) {
    return res.status(409).json({
      ok: false,
      message: "Nie mozna czyscic podczas drukowania"
    });
  }

  cleanupFiles(state.queue);
  state.queue = [];

  state.status = {
    printing: false,
    message: "Wyczyszczono",
    current: 0,
    total: 0,
    percent: 0,
    done: false,
    error: null
  };

  res.json({ ok: true, queue: state.queue });
});

app.get("/api/printers", async (req, res) => {
  try {
    const printers = await printService.listPrinters();
    res.json({ ok: true, printers });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Nie udalo sie pobrac listy drukarek.", printers: [] });
  }
});

app.get("/api/status", (req, res) => {
  res.json(getState(req).status);
});

app.post("/api/print", heavyJobLimiter, async (req, res) => {
  const state = getState(req);
  if (state.printing) {
    return res.status(409).json({
      ok: false,
      message: "Drukowanie juz trwa"
    });
  }

  // Number("cokolwiek nieliczbowego") daje NaN, a Math.max/Math.min z NaN
  // tez daje NaN - bez Number.isFinite kopie/opoznienie po niepoprawnym
  // wejsciu cicho stawaly sie NaN (np. petla "for (copy=1; copy<=NaN...)"
  // nigdy sie nie wykonuje - zero wyslanych kopii mimo odpowiedzi ok:true).
  const rawDelaySeconds = Number(req.body.delaySeconds);
  const delaySeconds = Math.max(1, Math.min(300, Number.isFinite(rawDelaySeconds) ? rawDelaySeconds : 1));

  const rawCopies = Number(req.body.copies);
  const copies = Math.max(1, Math.min(20, Number.isFinite(rawCopies) ? rawCopies : 1));

  const sideMode = req.body.sideMode === "two-sided" ? "two-sided" : "one-sided";
  const copyMode = req.body.copyMode === "set" ? "set" : "file";

  const order = Array.isArray(req.body.order) ? req.body.order : [];

  if (order.length) {
    const byId = new Map(state.queue.map(item => [item.id, item]));
    const ordered = [];

    for (const id of order) {
      if (byId.has(id)) {
        ordered.push(byId.get(id));
        byId.delete(id);
      }
    }

    for (const item of byId.values()) {
      ordered.push(item);
    }

    state.queue = ordered;
  }

  if (!state.queue.length) {
    return res.status(400).json({
      ok: false,
      message: "Brak plikow"
    });
  }

  state.printing = true;

  const itemsToPrint = [...state.queue];
  const printJobs = printService.buildPrintJobs(itemsToPrint, copies, copyMode);
  // Ile kopii KAZDEJ pozycji jeszcze zostalo do wyslania - jesli seria
  // przerwie sie w polowie (blad na jednym z plikow), pozycje ktore juz
  // zdazyly wyslac WSZYSTKIE swoje kopie do CUPS znikaja z kolejki, zeby
  // ponowne kliknięcie "Drukuj" wyslalo tylko to, co faktycznie zostalo -
  // bez tego caly zestaw wysylal sie od nowa, drukujac duplikaty juz
  // przyjetych przez drukarke plikow.
  const remainingCopies = new Map(itemsToPrint.map(item => [item.id, copies]));
  const sidesLabel = sideMode === "two-sided" ? "dwustronnie" : "jednostronnie";
  const copyLabel = copyMode === "set"
    ? "najpierw komplet, potem kolejna kopia kompletu"
    : "kopia przy kazdym pliku";

  state.status = {
    printing: true,
    message: `Start drukowania: ${copies} kop. / ${sidesLabel} / ${copyLabel}`,
    current: 0,
    total: printJobs.length,
    percent: 0,
    done: false,
    error: null,
    warning: null
  };

  res.json({ ok: true });

  let releasePrintLock = null;
  try {
    const printerName = String(req.body.printerName || "").trim();

    releasePrintLock = await printService.acquirePrintLock("drukarka", {
      printerName,
      onWaiting: () => {
        state.status.message = "W kolejce drukowania - czeka na zakonczenie druku innego uzytkownika...";
      }
    });

    let effectiveDuplex = sideMode === "two-sided";
    if (process.platform === "win32") {
      const printerSetup = await applyPrinterSides(sideMode, printerName);
      state.status.warning = printerSetup.ok ? null : printerSetup.message;
      state.status.message = printerSetup.message;
      if (printerSetup.ok) await printService.wait(800);
    } else if (sideMode === "two-sided" && printerName) {
      // Nie zakladamy, ze kazda drukarka obsluguje dwustronny wydruk -
      // sprawdzamy ZANIM cokolwiek wyslemy, zamiast udawac ze ustawienie
      // zostalo zastosowane. Ostrzezenie samo w sobie nie wystarczy - jesli
      // drukarka faktycznie nie wspiera duplexu, effectiveDuplex musi
      // realnie zmienic sie na false, inaczej i tak wysylamy "sides=two-
      // sided-..." do CUPS mimo wlasnego ostrzezenia.
      try {
        const printerOptions = await printService.getPrinterOptions(printerName);
        if (!printerOptions.duplexSupported) {
          state.status.warning = "Ta drukarka nie obsluguje druku dwustronnego - wydruk bedzie jednostronny.";
          effectiveDuplex = false;
        }
      } catch (err) {
        state.status.warning = `Nie udalo sie sprawdzic mozliwosci drukarki: ${err.message}`;
      }
    }

    for (let i = 0; i < printJobs.length; i++) {
      const job = printJobs[i];
      const item = job.item;
      const copyInfo = copies > 1 ? `, kopia ${job.copy}/${copies}` : "";

      state.status.current = i + 1;
      state.status.total = printJobs.length;
      state.status.percent = Math.round((i / printJobs.length) * 100);
      state.status.message = `Wysylam do kolejki ${i + 1}/${printJobs.length}${copyInfo}: ${item.originalName}`;

      const printResult = await printService.printFileWindows(item.path, printerName, {
        cwd: __dirname,
        logDir: DATA_DIR,
        timeoutMs: Number(process.env.DRUKARKA_PS_TIMEOUT_MS || 120000),
        copies: 1,
        duplex: effectiveDuplex
      });
      if (printResult && printResult.accepted === false) {
        state.status.warning = `Nie udalo sie potwierdzic przyjecia "${item.originalName}" przez kolejke drukowania - sprawdz, czy druk faktycznie sie odbyl.`;
      }

      remainingCopies.set(item.id, remainingCopies.get(item.id) - 1);
      state.status.percent = Math.round(((i + 1) / printJobs.length) * 100);
      state.status.message = `Dodano do kolejki ${i + 1}/${printJobs.length}${copyInfo}: ${item.originalName}`;

      // Nie czeka na fizyczne wydrukowanie.
      // Daje systemowi/drukarce czas na przyjecie zadania.
      await printService.wait(delaySeconds * 1000);
    }

    state.status.message = `✅ Wszystkie zadania wyslane do kolejki drukowania (${printJobs.length})`;
    state.status.percent = 100;
    state.status.done = true;

    // Nie usuwamy plikow natychmiast po wyslaniu do druku.
    // Acrobat/Windows potrafi jeszcze doczytywac duze PDF-y po dodaniu zadania do kolejki.
    // Natychmiastowe kasowanie uploadow moglo powodowac znikanie/anulowanie duzych zadan.
    const cleanupDelayMs = 30 * 60 * 1000;
    setTimeout(() => cleanupFiles(itemsToPrint), cleanupDelayMs).unref?.();

    // Acrobat nie jest zamykany przy kazdym pliku, bo to psulo buforowanie duzych PDF-ow.
    // Zamykamy go dopiero po calej serii i z opoznieniem, bez Stop-Process -Force.
    printService.closePdfAppsAfterBatch(__dirname, Number(process.env.DRUKARKA_CLOSE_ACROBAT_AFTER_SECONDS || 30));

    state.queue = [];
  } catch (err) {
    state.status.error = String(err.message || err);
    state.status.message = "❌ Blad drukowania: " + state.status.error;
    // Pozycje, ktore zdazyly wyslac WSZYSTKIE swoje kopie zanim wystapil
    // blad, znikaja z kolejki - zostaja tylko te jeszcze nie w pelni wyslane
    // (w tym pozycja, na ktorej wystapil blad), zeby kolejna proba drukowania
    // nie wyslala calej serii od nowa.
    state.queue = state.queue.filter(item => (remainingCopies.get(item.id) ?? 0) > 0);
  } finally {
    if (releasePrintLock) releasePrintLock();
    state.printing = false;
    state.status.printing = false;
  }
});

app.use((err, req, res, next) => {
  const message = err && err.code === 'LIMIT_FILE_SIZE'
    ? `Plik jest za duzy. Limit: ${MAX_FILE_MB} MB.`
    : err && err.code === 'LIMIT_FILE_COUNT'
      ? `Za duzo plikow. Limit: ${MAX_FILES}.`
      : (err?.message || 'Blad przesylania plikow.');
  res.status(400).json({ ok: false, message });
});

const server = app.listen(PORT, HOST, () => {
  console.log("");
  console.log("Drukarka Web dziala tylko lokalnie:");
  console.log(`http://${HOST}:${PORT}`);
  console.log("");
});
applyHttpTimeouts(server, "DRUKARKA");
