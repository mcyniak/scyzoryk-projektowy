const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { setupProcessDiagnostics, applyHttpTimeouts, scheduleCleanup } = require("../../lib/hardening");
const { getAppDataDir } = require("../../lib/appPaths");
const printService = require("../../lib/printing");
const { withPrintLease, PrintLeaseBusyError } = require("../../lib/printCoordinator");
const pdfMerge = require("./src/pdfMerge");

const app = express();
const APP_DATA_ROOT = getAppDataDir("drukarka");
setupProcessDiagnostics("drukarka", APP_DATA_ROOT);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.SCYZORYK_HOST || "127.0.0.1";
const MAX_FILE_MB = Number(process.env.DRUKARKA_MAX_FILE_MB || 50);
const MAX_FILES = Number(process.env.DRUKARKA_MAX_FILES || 80);
const MAX_QUEUE = Number(process.env.DRUKARKA_MAX_QUEUE || 200);

const DATA_DIR = path.join(APP_DATA_ROOT, "data");
const UPLOAD_DIR = path.join(APP_DATA_ROOT, "uploads");
const MERGED_DIR = path.join(DATA_DIR, "merged");
for (const dir of [DATA_DIR, UPLOAD_DIR, MERGED_DIR]) if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
scheduleCleanup([UPLOAD_DIR, MERGED_DIR], 24 * 60 * 60 * 1000, 60 * 60 * 1000);

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

app.use('/shared', express.static(path.join(__dirname, '..', '..', 'shared-styles')));
app.use(express.static(path.join(__dirname, "public")));

let queue = [];
let printing = false;

let status = {
  printing: false,
  message: "Gotowy",
  current: 0,
  total: 0,
  percent: 0,
  done: false,
  error: null
};



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



// Ustawianie jednostronnie/dwustronnie (applyPrinterSides) zyje teraz w
// ../../lib/printing.js - potrzebuje go tez apps/drukarka-projekty, wiec nie
// ma sensu trzymac dwoch kopii tej samej logiki PowerShell.








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

// Laczy kolejne (sasiadujace w kolejce) pliki PDF w jeden przed wyslaniem do
// druku - mniej osobnych zadan druku = szybciej i bez przerw miedzy plikami.
// DOC/DOCX nie da sie polaczyc bez konwersji do PDF (ktorej ta apka nie robi),
// wiec zostaja jako osobne zadania na swoim miejscu w kolejnosci.
async function buildMergedPrintItems(items, options = {}) {
  const { padOddPagesForDuplex = false } = options;
  const result = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].ext === ".pdf") {
      const run = [];
      while (i < items.length && items[i].ext === ".pdf") { run.push(items[i]); i += 1; }
      if (run.length >= 2) {
        const mergedPath = path.join(MERGED_DIR, `${Date.now()}_${Math.round(Math.random() * 1e9)}_polaczone.pdf`);
        await pdfMerge.mergePdfs(run.map(r => r.path), mergedPath, { padOddPagesExceptLast: padOddPagesForDuplex });
        result.push({ ...run[0], path: mergedPath, originalName: `Połączony PDF (${run.length} plików).pdf`, merged: true });
      } else {
        result.push(run[0]);
      }
    } else {
      result.push(items[i]);
      i += 1;
    }
  }
  return result;
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
  if (printing) {
    return res.status(409).json({
      ok: false,
      message: "Trwa drukowanie. Poczekaj, az aktualne pliki zostana wyslane do kolejki drukowania."
    });
  }
  next();
}, upload.array("files", MAX_FILES), (req, res) => {
  try {
    if (queue.length + (req.files || []).length > MAX_QUEUE) {
      cleanupFiles((req.files || []).map(file => ({ path: file.path })));
      return res.status(400).json({ ok: false, message: `Za duzo plikow w kolejce. Limit: ${MAX_QUEUE}.` });
    }
    for (const file of req.files || []) validateUploadedDocument(file);
    const added = (req.files || []).map(file => {
      const originalName = decodeOriginalName(file.originalname);
      const item = { id: file.filename, originalName, filename: file.filename, path: file.path, url: `/api/file/${encodeURIComponent(file.filename)}/preview`, ext: path.extname(originalName).toLowerCase() };
      queue.push(item);
      return item;
    });
    res.json({ ok: true, added, queue });
  } catch (err) {
    cleanupFiles((req.files || []).map(file => ({ path: file.path })));
    res.status(400).json({ ok: false, message: err.message || "Niepoprawny plik." });
  }
});

app.get("/api/file/:id/preview", (req, res) => {
  const item = queue.find(file => file.id === req.params.id);
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
  res.json({ queue });
});

app.post("/api/reorder", (req, res) => {
  if (printing) {
    return res.status(409).json({ ok: false, message: "Nie mozna zmieniac kolejnosci podczas drukowania" });
  }

  const order = req.body.order || [];
  const byId = new Map(queue.map(item => [item.id, item]));
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

  queue = next;
  res.json({ ok: true, queue });
});

app.delete("/api/file/:id", (req, res) => {
  if (printing) {
    return res.status(409).json({
      ok: false,
      message: "Nie mozna usuwac podczas drukowania"
    });
  }

  const id = req.params.id;
  const found = queue.find(item => item.id === id);
  queue = queue.filter(item => item.id !== id);

  if (found) cleanupFiles([found]);

  res.json({ ok: true, queue });
});

app.post("/api/clear", (req, res) => {
  if (printing) {
    return res.status(409).json({
      ok: false,
      message: "Nie mozna czyscic podczas drukowania"
    });
  }

  cleanupFiles(queue);
  queue = [];

  status = {
    printing: false,
    message: "Wyczyszczono",
    current: 0,
    total: 0,
    percent: 0,
    done: false,
    error: null
  };

  res.json({ ok: true, queue });
});

app.get("/api/printers", async (req, res) => {
  try {
    const printers = await printService.listPrinters();
    res.json({ ok: true, printers });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Nie udalo sie pobrac listy drukarek.", printers: [] });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, name: "drukarka", version: require("./package.json").version });
});

app.get("/api/status", (req, res) => {
  res.json(status);
});

app.post("/api/print", heavyJobLimiter, async (req, res) => {
  if (printing) {
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
  const printerName = String(req.body.printerName || "").trim();
  const order = Array.isArray(req.body.order) ? req.body.order : [];

  if (order.length) {
    const byId = new Map(queue.map(item => [item.id, item]));
    const ordered = [];

    for (const id of order) {
      if (byId.has(id)) {
        ordered.push(byId.get(id));
        byId.delete(id);
      }
    }

    for (const item of byId.values()) ordered.push(item);
    queue = ordered;
  }

  if (!queue.length) {
    return res.status(400).json({ ok: false, message: "Brak plikow" });
  }

  try {
    await withPrintLease({ app: "drukarka", sessionId: req.sessionID || null, printerName }, async () => {
      printing = true;

      const originalItems = [...queue];
      const sidesLabel = sideMode === "two-sided" ? "dwustronnie" : "jednostronnie";
      const copyLabel = copyMode === "set"
        ? "najpierw komplet, potem kolejna kopia kompletu"
        : "kopia przy kazdym pliku";

      status = {
        printing: true,
        message: `Start drukowania: ${copies} kop. / ${sidesLabel} / ${copyLabel}`,
        current: 0,
        total: originalItems.length,
        percent: 0,
        done: false,
        error: null,
        warning: null
      };

      let itemsToPrint = originalItems;
      try {
        res.json({ ok: true });

        // Laczenie PDF-ow ZMIENIA znaczenie "kopia przy kazdym pliku" (A,A,B,B) w
        // "najpierw caly komplet" (A,B,A,B), bo po polaczeniu jest juz tylko jeden
        // "plik" do powielenia - wiec laczymy tylko gdy to nie zmienia wyboru
        // uzytkownika: albo jest tylko 1 kopia (kolejnosc kopii wtedy bez
        // znaczenia), albo uzytkownik i tak wybral "najpierw komplet" (copyMode
        // "set"), gdzie laczenie daje dokladnie to samo zachowanie co bez laczenia.
        const mergeChangesCopySemantics = copies > 1 && copyMode === "file";
        if (!mergeChangesCopySemantics && originalItems.filter(it => it.ext === ".pdf").length >= 2) {
          status.message = "Łączę sąsiadujące PDF-y w jeden plik, żeby drukować szybciej...";
          try {
            itemsToPrint = await buildMergedPrintItems(originalItems, { padOddPagesForDuplex: sideMode === "two-sided" });
          } catch (mergeErr) {
            itemsToPrint = originalItems;
            status.warning = "Nie udało się połączyć PDF-ów w jeden plik - drukuję pojedynczo.";
          }
        }

        const printJobs = printService.buildPrintJobs(itemsToPrint, copies, copyMode);
        status.total = printJobs.length;

        await printService.withPrinterSides(sideMode, printerName, async printerSetup => {
          status.warning = printerSetup.ok ? status.warning : printerSetup.message;
          status.message = printerSetup.message;
          if (printerSetup.ok) await printService.wait(800);

          for (let i = 0; i < printJobs.length; i++) {
            const job = printJobs[i];
            const item = job.item;
            const copyInfo = copies > 1 ? `, kopia ${job.copy}/${copies}` : "";

            status.current = i + 1;
            status.total = printJobs.length;
            status.percent = Math.round((i / printJobs.length) * 100);
            status.message = `Wysylam do kolejki ${i + 1}/${printJobs.length}${copyInfo}: ${item.originalName}`;

            await printService.printFileWindows(item.path, printerName, {
              cwd: __dirname,
              logDir: DATA_DIR,
              timeoutMs: Number(process.env.DRUKARKA_PS_TIMEOUT_MS || 120000)
            });

            status.percent = Math.round(((i + 1) / printJobs.length) * 100);
            status.message = `Dodano do kolejki ${i + 1}/${printJobs.length}${copyInfo}: ${item.originalName}`;

            // Nie czeka na fizyczne wydrukowanie.
            // Daje Windowsowi / Acrobatowi / Wordowi czas na przyjecie zadania.
            await printService.wait(delaySeconds * 1000);
          }
        });

        status.message = `✅ Wszystkie zadania wyslane do kolejki drukowania (${printJobs.length})`;
        status.percent = 100;
        status.done = true;
      } catch (err) {
        status.error = String(err.message || err);
        status.message = "❌ Blad drukowania: " + status.error;
      } finally {
        // Kolejka i sprzatanie plikow ida TUTAJ (nie tylko na sciezce sukcesu) -
        // bez tego blad w polowie serii zostawial stara kolejke w pamieci, wiec
        // ponowne kliknieccie "drukuj" potrafilo wyslac do druku po raz drugi
        // pliki, ktore juz sie realnie wydrukowaly przed bledem.
        queue = [];
        // Nie usuwamy plikow natychmiast po wyslaniu do druku.
        // Acrobat/Windows potrafi jeszcze doczytywac duze PDF-y po dodaniu zadania do kolejki.
        // Natychmiastowe kasowanie uploadow moglo powodowac znikanie/anulowanie duzych zadan.
        const cleanupDelayMs = 30 * 60 * 1000;
        setTimeout(() => {
          cleanupFiles(originalItems);
          cleanupFiles(itemsToPrint.filter(it => it.merged));
        }, cleanupDelayMs).unref?.();
        printing = false;
        status.printing = false;
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
    status.error = String(err.message || err);
    status.message = "❌ Blad drukowania: " + status.error;
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
