const rateLimitLib = require("express-rate-limit");
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require("express");
const path = require("path");
const fs = require("fs");
const { setupProcessDiagnostics, applyHttpTimeouts } = require("../../lib/hardening");
const { getAppDataDir } = require("../../lib/appPaths");
const builder = require("./src/protokolBuilder");

const app = express();
const APP_DATA_ROOT = getAppDataDir("protokoly");
setupProcessDiagnostics("protokoly", APP_DATA_ROOT);
const PORT = Number(process.env.PORT || 3014);
const HOST = process.env.SCYZORYK_HOST || "127.0.0.1";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://scyzoryk.localhost:3000 http://127.0.0.1:3000; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};
app.disable("x-powered-by");
app.use((req, res, next) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); next(); });
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Scyzoryk-Request") === "1") return next();
  res.status(403).json({ ok: false, message: "Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie." });
});
app.use(express.json({ limit: "256kb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PROTOKOLY_API_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
  // Podglad PDF-a (skanowanie + skladanie kilku zdjec) potrafi trwac kilka
  // sekund i UI moze go wywolac wielokrotnie przy przegladaniu kolejnych
  // adresow - ten sam wzorzec co w apps/nazywarka-skanow/server.js.
  skip: (req) => req.method === "GET",
  message: { ok: false, message: "Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie." }
});
app.use("/api", apiLimiter);

app.use("/shared", express.static(path.join(__dirname, "..", "..", "shared-styles")));
app.use(express.static(path.join(__dirname, "public")));

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

function resolveAddressFolder(baseFolder, folderName) {
  if (!baseFolder || !folderName) throw new Error("Brak folderu bazowego albo nazwy folderu adresu.");
  const folderPath = path.join(baseFolder, folderName);
  if (!isPathInsideFolder(folderPath, baseFolder)) throw new Error("Niepoprawna nazwa folderu adresu.");
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`Folder adresu nie istnieje: ${folderPath}`);
  }
  return folderPath;
}

app.get("/api/health", (req, res) => res.json({ ok: true, name: "protokoly" }));

// Parsuje reczne poprawki obrotu z query/body ({ "0": 180, "2": 90, ... },
// indeks zgodny z kolejnoscia findProtocolPhotos/#api/photos) - JSON.parse
// moze rzucic na zle sformowanym wejsciu, wiec traktujemy to jako "brak
// poprawek" zamiast wywalac cale zadanie.
function parseRotations(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const deg = Number(v);
      if (Number.isFinite(deg) && deg % 90 === 0) out[k] = ((deg % 360) + 360) % 360;
    }
    return out;
  } catch (_) {
    return {};
  }
}

// Lekki listing pojedynczych zdjec protokolu (bez przetwarzania obrazow) -
// UI buduje z tego pasek miniatur w podgladzie, zeby uzytkownik mogl reczne
// poprawic obrot pojedynczego zdjecia PRZED zlozeniem calego PDF-a.
app.get("/api/photos", (req, res) => {
  try {
    const baseFolder = String(req.query.baseFolder || "").trim();
    const folderName = String(req.query.folderName || "").trim();
    const folderPath = resolveAddressFolder(baseFolder, folderName);
    const photos = builder.findProtocolPhotos(folderPath);
    res.json({ ok: true, photos: photos.map((p, index) => ({ index, fileName: path.basename(p.path) })) });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie odczytac zdjec." });
  }
});

// Zwraca POJEDYNCZE przetworzone zdjecie (ten sam pipeline co w PDF-ie) jako
// JPEG - miniatura w UI do podgladu efektu recznego obrotu bez budowania
// calego PDF-a od nowa przy kazdym kliknieciu.
app.get("/api/photo-thumb", async (req, res) => {
  try {
    const baseFolder = String(req.query.baseFolder || "").trim();
    const folderName = String(req.query.folderName || "").trim();
    const index = Number(req.query.index);
    const rotateDeg = Number(req.query.rotate) || 0;
    const folderPath = resolveAddressFolder(baseFolder, folderName);
    const photos = builder.findProtocolPhotos(folderPath);
    if (!Number.isInteger(index) || index < 0 || index >= photos.length) {
      return res.status(404).json({ ok: false, message: "Nie znaleziono zdjecia o tym indeksie." });
    }
    const img = await builder.processPhoto(photos[index].path, { manualRotateDeg: rotateDeg });
    const jpegBuffer = await img.getBuffer("image/jpeg", { quality: 70 });
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(jpegBuffer);
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie zbudowac miniatury." });
  }
});

// Skanuje folder bazowy (tak samo jak drukarka-projekty) i dla kazdego
// adresu zwraca liczbe znalezionych zdjec protokolu - bez przetwarzania
// obrazow (szybkie, tylko listowanie plikow), zeby UI moglo od razu pokazac
// pelna liste adresow.
app.post("/api/scan", (req, res) => {
  const baseFolder = String(req.body?.baseFolder || "").trim();
  if (!baseFolder) return res.status(400).json({ ok: false, message: "Podaj folder bazowy." });

  let folderNames;
  try {
    folderNames = builder.listAddressFolders(baseFolder);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message || "Nie udalo sie odczytac folderu bazowego." });
  }

  const results = folderNames.map(folderName => {
    const folderPath = path.join(baseFolder, folderName);
    let photos = [];
    let error = null;
    try {
      photos = builder.findProtocolPhotos(folderPath);
    } catch (err) {
      error = err.message || String(err);
    }
    // Audyt na zywo 2026-08-13: bez tego sprawdzenia "juz zapisane" istnialo
    // TYLKO w pamieci przegladarki (do najblizszego odswiezenia/nowego
    // skanu) - ponowny skan tego samego folderu bazowego wygladal identycznie
    // jak za pierwszym razem, wiec "Zapisz wszystkie" bez ostrzezenia
    // nadpisywalo/dublowalo prace juz zrobiona. Sprawdzamy TERAZ realny stan
    // na dysku (dokladnie ta sama sciezka, ktora wyliczylby /api/save), nie
        // tylko stan sesji.
    let existingPath = null;
    if (photos.length) {
      const saveDir = builder.targetSaveDir(folderPath, photos);
      const candidate = path.join(saveDir, builder.outputFileName(folderName));
      if (fs.existsSync(candidate)) existingPath = candidate;
    }
    return {
      folderName,
      adres: builder.addressFromFolderName(folderName),
      photoCount: photos.length,
      error,
      existingPath
    };
  });

  res.json({ ok: true, baseFolder, results });
});

// Buduje PDF z automatycznie wykrytych zdjec protokolu i zwraca go WPROST
// jako podglad (application/pdf, inline) - NIC nie zapisuje na dysku. Dopiero
// /api/save robi zapis, po tym jak uzytkownik zobaczy podglad.
app.get("/api/preview", async (req, res) => {
  try {
    const baseFolder = String(req.query.baseFolder || "").trim();
    const folderName = String(req.query.folderName || "").trim();
    const folderPath = resolveAddressFolder(baseFolder, folderName);
    const photos = builder.findProtocolPhotos(folderPath);
    if (!photos.length) return res.status(404).json({ ok: false, message: "Nie znaleziono zdjec protokolu w tym folderze." });

    const rotations = parseRotations(req.query.rotations);
    const pdfBytes = await builder.buildProtocolPdf(photos.map(p => p.path), rotations);

    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "no-store");
    res.send(pdfBytes);
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie zbudowac podgladu." });
  }
});

// Buduje PDF od nowa (ten sam pipeline co /api/preview) i zapisuje go na
// dysku, w TYM SAMYM podfolderze, w ktorym faktycznie znaleziono zdjecia
// (patrz targetSaveDir - nie zaklada z gory konwencji nazwy "-pdf").
app.post("/api/save", async (req, res) => {
  try {
    const baseFolder = String(req.body?.baseFolder || "").trim();
    const folderName = String(req.body?.folderName || "").trim();
    const folderPath = resolveAddressFolder(baseFolder, folderName);
    const photos = builder.findProtocolPhotos(folderPath);
    if (!photos.length) return res.status(404).json({ ok: false, message: "Nie znaleziono zdjec protokolu w tym folderze." });

    const rotations = parseRotations(req.body?.rotations);
    const pdfBytes = await builder.buildProtocolPdf(photos.map(p => p.path), rotations);
    const saveDir = builder.targetSaveDir(folderPath, photos);
    const fileName = builder.outputFileName(folderName);
    const savePath = path.join(saveDir, fileName);

    if (!isPathInsideFolder(savePath, folderPath)) {
      return res.status(400).json({ ok: false, message: "Niepoprawna sciezka zapisu." });
    }
    // photoFailures (patrz buildProtocolPdf) - pojedyncze nieczytelne zdjecie
    // nie przerywa zapisu, ale uzytkownik musi wiedziec, ze PDF nie zawiera
    // wszystkich stron.
    const skippedPhotos = (pdfBytes.photoFailures || []).map(f => path.basename(f.path));

    fs.writeFileSync(savePath, pdfBytes);
    res.json({ ok: true, savedPath: savePath, pageCount: photos.length - skippedPhotos.length, skippedPhotos });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || "Nie udalo sie zapisac pliku." });
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ ok: false, message: err?.message || "Blad." });
});

// require.main === module: uruchomienie serwera TYLKO gdy plik jest startowany
// bezposrednio (node server.js), nie gdy jest wymagany przez testy.
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log("");
    console.log("Protokoly (skanowanie zdjec do PDF) dziala tylko lokalnie:");
    console.log(`http://${HOST}:${PORT}`);
    console.log("");
  });
  applyHttpTimeouts(server, "PROTOKOLY");
}

module.exports = { app, isPathInsideFolder, resolveAddressFolder };
