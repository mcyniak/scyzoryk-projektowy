const rateLimitLib = require("express-rate-limit");
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require("express");
const path = require("path");
const fs = require("fs");
const { setupProcessDiagnostics, applyHttpTimeouts } = require("../../lib/hardening");
const { getAppDataDir } = require("../../lib/appPaths");
const { contentDispositionHeader } = require("../../lib/printing");
const { sessionMiddleware } = require("./lib/sessionStore");

const app = express();
const APP_DATA_ROOT = getAppDataDir("nazywarka-skanow");
setupProcessDiagnostics("nazywarka-skanow", APP_DATA_ROOT);
const PORT = Number(process.env.PORT || 3007);
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
  max: Number(process.env.NAZYWARKA_API_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
  // Podglad PDF-a i odczyt biezacego stanu sesji sa odpytywane czesto przez
  // UI (kazde przejscie do kolejnego pliku) - patrz analogiczny komentarz w
  // apps/drukarka/server.js. Bez tego zwykla praca przez kilkanascie plikow
  // moglaby trafic w falszywy "Za duzo zadan".
  skip: (req) => req.method === "GET",
  message: { ok: false, message: "Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie." }
});
app.use("/api", apiLimiter);

app.use("/shared", express.static(path.join(__dirname, "..", "..", "shared-styles")));
app.use(express.static(path.join(__dirname, "public")));

app.use(sessionMiddleware(() => ({ folderPath: null, files: [], currentIndex: 0 })));

// Windows-zabronione znaki w nazwie pliku + znaki kontrolne. Kropka NIE jest
// tu zabroniona (zakaz w CLAUDE.md przeciwko obcinaniu kropek z poprawnych
// nazw) - kropki w srodku nazwy (np. "5.2") maja zostac tak jak uzytkownik
// je wpisal.
const ILLEGAL_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

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

function listPdfFiles(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const names = entries.filter(e => e.isFile() && /\.pdf$/i.test(e.name)).map(e => e.name);
  names.sort((a, b) => a.localeCompare(b, "pl", { numeric: true, sensitivity: "base" }));
  return names;
}

// Uzytkownik wpisuje TYLKO nazwe bazowa (bez rozszerzenia - UI pokazuje
// ".pdf" jako stala koncowke obok pola). Serwer zawsze sam dokleja
// prawdziwe rozszerzenie oryginalnego pliku, wiec nie da sie go zmienic -
// zgodnie z ustalonym planem. Jesli ktos z przyzwyczajenia wpisal juz
// rozszerzenie na koncu (np. "Kowalski.pdf"), usuwamy TYLKO ten jeden,
// dokladnie pasujacy sufiks, zeby nie wyszlo "Kowalski.pdf.pdf" - to nie
// jest "obcinanie kropek z poprawnej nazwy" (weto w CLAUDE.md), tylko
// usuniecie zbednego duplikatu rozszerzenia, ktore i tak zostanie dodane
// ponownie ponizej.
function stripRedundantExtension(rawBaseName, ext) {
  if (!ext) return rawBaseName;
  const lower = rawBaseName.toLowerCase();
  const extLower = ext.toLowerCase();
  if (lower.endsWith(extLower) && rawBaseName.length > ext.length) {
    return rawBaseName.slice(0, rawBaseName.length - ext.length);
  }
  return rawBaseName;
}

function sanitizeBaseName(raw) {
  // trim() usuwa incydentalna spacje na poczatku/koncu (z wpisywania/
  // wklejania) - to zwykle przycinanie inputu, nie "obcinanie znaczacych
  // znakow" (weto w CLAUDE.md dotyczy kropek w SRODKU nazwy, ktore zostaja
  // nietkniete). Dlatego koncowa spacja nigdy nie dotrze do sprawdzenia
  // ponizej - jedynym prawdziwym twardym bledem zwiazanym z koncem nazwy
  // jest kropka (Windows naprawde nie pozwala na plik konczacy sie kropka).
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, message: "Podaj nazwe pliku." };
  if (trimmed === "." || trimmed === "..") return { ok: false, message: "Niepoprawna nazwa pliku." };
  if (trimmed.includes("/") || trimmed.includes("\\")) return { ok: false, message: "Nazwa nie moze zawierac separatorow sciezki (/ \\)." };
  if (ILLEGAL_CHARS_RE.test(trimmed)) return { ok: false, message: 'Nazwa zawiera niedozwolone znaki (< > : " | ? *).' };
  if (RESERVED_NAMES_RE.test(trimmed)) return { ok: false, message: "Ta nazwa jest zarezerwowana przez system Windows - wybierz inna." };
  if (trimmed.endsWith(".")) return { ok: false, message: "Nazwa nie moze konczyc sie kropka (Windows tego nie obsluguje)." };
  return { ok: true, value: trimmed };
}

function sessionSummary(session) {
  return {
    folderPath: session.folderPath,
    total: session.files.length,
    currentIndex: session.currentIndex,
    files: session.files.map((f, i) => ({ index: i, originalName: f.originalName, currentName: f.currentName, renamed: f.renamed }))
  };
}

app.get("/api/health", (req, res) => res.json({ ok: true, name: "nazywarka-skanow" }));

app.post("/api/open-folder", (req, res) => {
  const folderPath = String(req.body?.folderPath || "").trim();
  if (!folderPath) return res.status(400).json({ ok: false, message: "Podaj sciezke folderu." });

  let stat;
  try {
    stat = fs.statSync(folderPath);
  } catch (err) {
    const reason = err.code === "ENOENT" ? "nie znaleziono takiej sciezki." : (err.message || String(err));
    return res.status(400).json({ ok: false, message: `Nie mozna otworzyc folderu: ${reason}` });
  }
  if (!stat.isDirectory()) return res.status(400).json({ ok: false, message: "Podana sciezka nie jest folderem." });

  let names;
  try {
    names = listPdfFiles(folderPath);
  } catch (err) {
    return res.status(400).json({ ok: false, message: `Nie udalo sie odczytac zawartosci folderu: ${err.message || err}` });
  }

  req.session.folderPath = folderPath;
  req.session.files = names.map(name => ({ originalName: name, currentName: name, renamed: false }));
  req.session.currentIndex = 0;
  res.json({ ok: true, ...sessionSummary(req.session) });
});

app.get("/api/state", (req, res) => {
  if (!req.session.folderPath) return res.status(404).json({ ok: false, message: "Folder nie zostal jeszcze otwarty." });
  res.json({ ok: true, ...sessionSummary(req.session) });
});

app.post("/api/goto", (req, res) => {
  if (!req.session.folderPath) return res.status(400).json({ ok: false, message: "Folder nie zostal otwarty." });
  const idx = Number(req.body?.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= req.session.files.length) {
    return res.status(400).json({ ok: false, message: "Niepoprawny numer pliku." });
  }
  req.session.currentIndex = idx;
  res.json({ ok: true, ...sessionSummary(req.session) });
});

app.post("/api/next", (req, res) => {
  if (!req.session.folderPath) return res.status(400).json({ ok: false, message: "Folder nie zostal otwarty." });
  req.session.currentIndex = Math.min(req.session.currentIndex + 1, Math.max(0, req.session.files.length - 1));
  res.json({ ok: true, ...sessionSummary(req.session) });
});

app.post("/api/prev", (req, res) => {
  if (!req.session.folderPath) return res.status(400).json({ ok: false, message: "Folder nie zostal otwarty." });
  req.session.currentIndex = Math.max(req.session.currentIndex - 1, 0);
  res.json({ ok: true, ...sessionSummary(req.session) });
});

app.get("/api/preview/:index", (req, res) => {
  if (!req.session.folderPath) return res.status(404).send("Folder nie zostal otwarty.");
  const idx = Number(req.params.index);
  const entry = req.session.files[idx];
  if (!entry) return res.status(404).send("Nie znaleziono pliku.");

  const filePath = path.join(req.session.folderPath, entry.currentName);
  // Sciezka jest budowana z nazwy juz obecnej w sesji (zapisanej przy
  // /api/open-folder albo po udanym rename), nie z surowego wejscia
  // klienta - ale sprawdzamy containment mimo to, tak jak analogiczny
  // /api/preview-by-path w apps/drukarka-projekty/server.js, na wypadek
  // gdyby index odwolywal sie do wpisu spoza otwartego folderu.
  if (!isPathInsideFolder(filePath, req.session.folderPath) || !fs.existsSync(filePath)) {
    return res.status(404).send("Nie znaleziono pliku.");
  }

  // Podglad PDF jest wyswietlany w ramce wewnatrz tej samej aplikacji - patrz
  // identyczny komentarz w apps/drukarka/server.js.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDispositionHeader("inline", entry.currentName));
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.resolve(filePath));
});

app.post("/api/rename", (req, res) => {
  if (!req.session.folderPath) return res.status(400).json({ ok: false, message: "Folder nie zostal otwarty." });
  const entry = req.session.files[req.session.currentIndex];
  if (!entry) return res.status(400).json({ ok: false, message: "Brak biezacego pliku do zmiany nazwy." });

  const ext = path.extname(entry.currentName);
  const rawBase = stripRedundantExtension(String(req.body?.newName || ""), ext);
  const check = sanitizeBaseName(rawBase);
  if (!check.ok) return res.status(400).json(check);

  const newName = `${check.value}${ext}`;
  const oldPath = path.join(req.session.folderPath, entry.currentName);
  const newPath = path.join(req.session.folderPath, newName);

  if (!isPathInsideFolder(oldPath, req.session.folderPath) || !isPathInsideFolder(newPath, req.session.folderPath)) {
    return res.status(400).json({ ok: false, message: "Niepoprawna sciezka pliku." });
  }
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ ok: false, message: "Plik zrodlowy juz nie istnieje na dysku - otworz folder ponownie." });
  }

  if (newName !== entry.currentName) {
    // Konflikt sprawdzamy tylko gdy nazwa REALNIE sie zmienia (nie tylko
    // wielkoscia liter) - inaczej zmiana samej wielkosci liter (np. "skan.pdf"
    // -> "Skan.pdf") falszywie wygladalaby jak kolizja z samym soba, bo
    // Windows jest case-insensitive.
    if (newName.toLowerCase() !== entry.currentName.toLowerCase() && fs.existsSync(newPath)) {
      return res.status(409).json({ ok: false, message: `Plik "${newName}" juz istnieje w tym folderze - sprawdz nazwe jeszcze raz.` });
    }
    try {
      fs.renameSync(oldPath, newPath);
    } catch (err) {
      return res.status(500).json({ ok: false, message: `Nie udalo sie zmienic nazwy: ${err.message || err}` });
    }
    entry.currentName = newName;
    entry.renamed = true;
  }

  if (req.session.currentIndex < req.session.files.length - 1) req.session.currentIndex += 1;
  res.json({ ok: true, ...sessionSummary(req.session) });
});

app.use((err, req, res, next) => {
  res.status(400).json({ ok: false, message: err?.message || "Blad." });
});

// require.main === module: uruchomienie serwera TYLKO gdy plik jest startowany
// bezposrednio (node server.js), nie gdy jest wymagany przez testy.
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log("");
    console.log("Nazywarka skanow dziala tylko lokalnie:");
    console.log(`http://${HOST}:${PORT}`);
    console.log("");
  });
  applyHttpTimeouts(server, "NAZYWARKA_SKANOW");
}

module.exports = { app, isPathInsideFolder, listPdfFiles, sanitizeBaseName, stripRedundantExtension };
