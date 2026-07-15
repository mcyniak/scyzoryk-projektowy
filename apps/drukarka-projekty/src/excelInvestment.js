const XLSX = require("xlsx");

// Przechowujemy ostatnio wgrany arkusz w pamięci procesu - to lokalne,
// jednoosobowe narzędzie, więc nie potrzeba pełnej sesyjności. Wpisy nigdy
// nie byly usuwane, wiec pamiec rosla bez ograniczen przy kazdym kolejnym
// wgranym pliku przez cały czas dzialania serwera - czyscimy je po TTL,
// tym samym wzorcem co scheduleCleanup w lib/hardening.js.
const WORKBOOK_TTL_MS = 12 * 60 * 60 * 1000;
const workbooks = new Map(); // token -> { wb: XLSX.WorkBook, createdAt: number }
let counter = 0;

function nextToken() {
  counter += 1;
  return `wb_${Date.now()}_${counter}`;
}

function cleanupOldWorkbooks() {
  const now = Date.now();
  for (const [token, entry] of workbooks.entries()) {
    if (now - entry.createdAt > WORKBOOK_TTL_MS) workbooks.delete(token);
  }
}
const cleanupTimer = setInterval(cleanupOldWorkbooks, 60 * 60 * 1000);
cleanupTimer.unref?.();

function loadWorkbookFromBuffer(buffer) {
  cleanupOldWorkbooks();
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const token = nextToken();
  workbooks.set(token, { wb, createdAt: Date.now() });
  return { token, sheets: wb.SheetNames };
}

function getWorkbook(token) {
  const entry = workbooks.get(token);
  if (!entry || Date.now() - entry.createdAt > WORKBOOK_TTL_MS) {
    workbooks.delete(token);
    throw new Error("Nie znaleziono wgranego arkusza (token wygasł). Wgraj plik ponownie.");
  }
  return entry.wb;
}

function normalizeHeader(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Szuka kolumny po dopasowaniu znormalizowanego naglowka. `mustInclude` to
// lista slow kluczowych ktore MUSZA wystapic w naglowku (wszystkie), zeby
// odroznic np. "lp gmina" od samego "lp" albo "gmina".
function findColumn(headerRow, mustIncludeAll, mustNotInclude = []) {
  for (let col = 0; col < headerRow.length; col += 1) {
    const norm = normalizeHeader(headerRow[col]);
    if (!norm) continue;
    const hasAll = mustIncludeAll.every(kw => norm.includes(kw));
    const hasNone = mustNotInclude.every(kw => !norm.includes(kw));
    if (hasAll && hasNone) return col;
  }
  return -1;
}

function isTruthyMark(value) {
  if (value === null || value === undefined || value === "") return false;
  const s = String(value).trim().toLowerCase();
  if (s === "0" || s === "nie" || s === "-") return false;
  return true; // liczba, "+", "x", "tak", data itp. - traktujemy jako zaznaczone
}

function isRezygnacja(value) {
  if (value === null || value === undefined || value === "") return false;
  const s = String(value).trim().toLowerCase();
  return s === "tak" || s === "x" || s === "+" || s === "rezygnacja";
}

// Zwraca liste kandydatow (bez zaznaczonego odbioru i bez rezygnacji),
// posortowana po LP gmina rosnaco. Kazdy wpis ma tez surowy numer wiersza
// arkusza (do ewentualnej pozniejszej edycji recznej przez Piotrka).
function listCandidates(token, sheetName) {
  const wb = getWorkbook(token);
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Nie znaleziono zakladki "${sheetName}" w arkuszu.`);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  if (!rows.length) return { candidates: [], columnsFound: {} };

  const header = rows[0];
  const colLpGmina = findColumn(header, ["lp", "gmina"]);
  const colOdbior = findColumn(header, ["odbior"]);
  const colRezygnacja = findColumn(header, ["rezygnacj"]);
  const colGmina = findColumn(header, ["gmina"], ["lp"]);
  const colImie = findColumn(header, ["imi"]);
  const colAdres = findColumn(header, ["adres"], ["kod", "email", "e mail"]);
  const colUid = findColumn(header, ["uid"]);

  const columnsFound = {
    lpGmina: colLpGmina, odbior: colOdbior, rezygnacja: colRezygnacja,
    gmina: colGmina, imie: colImie, adres: colAdres, uid: colUid
  };

  if (colLpGmina === -1 || colAdres === -1) {
    const err = new Error('Nie udało się znaleźć w tej zakładce kolumn "LP gmina" i "Adres". Sprawdź czy to właściwa zakładka.');
    err.columnsFound = columnsFound;
    throw err;
  }

  const candidates = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    const adres = colAdres >= 0 ? row[colAdres] : null;
    const lpGmina = colLpGmina >= 0 ? row[colLpGmina] : null;
    if (adres === null || adres === undefined || String(adres).trim() === "") continue;
    if (lpGmina === null || lpGmina === undefined || String(lpGmina).trim() === "") continue;

    const odbior = colOdbior >= 0 ? row[colOdbior] : null;
    const rezygnacja = colRezygnacja >= 0 ? row[colRezygnacja] : null;
    if (isTruthyMark(odbior)) continue;
    if (isRezygnacja(rezygnacja)) continue;

    candidates.push({
      rowNumber: r + 1,
      lpGmina: typeof lpGmina === "number" ? lpGmina : String(lpGmina).trim(),
      gmina: colGmina >= 0 ? row[colGmina] : null,
      imie: colImie >= 0 ? row[colImie] : null,
      adres: String(adres).trim(),
      uid: colUid >= 0 ? row[colUid] : null
    });
  }

  candidates.sort((a, b) => Number(a.lpGmina) - Number(b.lpGmina));
  return { candidates, columnsFound };
}

module.exports = { loadWorkbookFromBuffer, listCandidates };
