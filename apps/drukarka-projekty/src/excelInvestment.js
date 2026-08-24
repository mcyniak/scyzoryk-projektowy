// Audyt 2026-08-20: "xlsx" (SheetJS 0.18.5) zamieniony na "read-excel-file" -
// CVE-2023-30533 (prototype pollution przy CZYTANIU spreparowanego arkusza)
// i CVE-2024-22363 (ReDoS), obie bez naprawionej wersji w rejestrze npm.
// Ten sam parser, ktory juz bezpiecznie dziala w karty-katalogowe/
// dokumenty-seryjne/tworzenie-folderow/formularze-varmero.
const readXlsxFile = require("read-excel-file/node");
const AdmZip = require("adm-zip");
const { isAffirmativeFlag } = require("../../../lib/businessFlags");
const { toAsciiSafe } = require("../../../lib/diacritics");

// read-excel-file NIE gwarantuje kolejnosci arkuszy zgodnej z prawdziwym
// xl/workbook.xml (zweryfikowane empirycznie w tej samej sesji na pliku
// eksportowanym z Google Sheets - dokumenty-seryjne#getSheetOrderFromWorkbookXml,
// ten sam mechanizm) - dla tego narzedzia kolejnosc MA znaczenie, bo
// uzytkownik wybiera zakladke z listy w UI, ktora powinna odzwierciedlac
// prawdziwa kolejnosc kart w Excelu. Czyta prawdziwa kolejnosc bezposrednio
// z xl/workbook.xml (ten sam plik jest zarowno .xlsx jak i zwykle .zip) i
// przestawia wynik read-excel-file, zeby dopasowac. Nigdy nie rzuca -
// nieudany odczyt zostawia oryginalna kolejnosc z read-excel-file
// (zdegradowane, ale wciaz uzywalne zachowanie zamiast twardego bledu).
function reorderSheetsByWorkbookXml(buffer, sheets) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("xl/workbook.xml");
    if (!entry) return sheets;
    const xml = zip.readAsText(entry, "utf8");
    const prawdziwaKolejnosc = [];
    const sheetTagRe = /<sheet\b[^>]*\/>/g;
    let m;
    while ((m = sheetTagRe.exec(xml))) {
      const nameMatch = m[0].match(/name="([^"]*)"/);
      if (nameMatch) prawdziwaKolejnosc.push(nameMatch[1]);
    }
    if (!prawdziwaKolejnosc.length) return sheets;
    const byName = new Map(sheets.map(s => [s.sheet, s]));
    const posortowane = prawdziwaKolejnosc.map(name => byName.get(name)).filter(Boolean);
    // Kazda nazwa z read-excel-file, ktorej z jakiegos powodu nie ma w
    // odczytanym xl/workbook.xml (nie powinno sie zdarzyc, ale bezpieczny
    // fallback) - dokladamy na koniec, zeby zaden arkusz nie zniknal.
    for (const s of sheets) if (!posortowane.includes(s)) posortowane.push(s);
    return posortowane;
  } catch (_) {
    return sheets;
  }
}

// Przechowujemy ostatnio wgrany arkusz w pamięci procesu - to lokalne,
// jednoosobowe narzędzie, więc nie potrzeba pełnej sesyjności. Wpisy nigdy
// nie byly usuwane, wiec pamiec rosla bez ograniczen przy kazdym kolejnym
// wgranym pliku przez cały czas dzialania serwera - czyscimy je po TTL,
// tym samym wzorcem co scheduleCleanup w lib/hardening.js.
//
// Audyt zuzycia RAM 2026-08-21: samo TTL nie wystarczylo - w ciagu jednego
// dnia pracy (TTL bylo 12h) moglo sie uzbierac kilkanascie w pelni
// sparsowanych arkuszy naraz, po jednym na kazdy wgrany plik. Skrocone TTL
// (1h - to narzedzie od otwarcia pliku do zlecenia druku dziala w minutach,
// nie godzinach) PLUS twardy limit liczby jednoczesnie trzymanych
// workbookow (LRU po ostatnim uzyciu, nie tylko po utworzeniu) - w typowej
// pracy trzeba tylko ostatnio otwartego pliku, wiec 3 to bezpieczny zapas
// gdyby uzytkownik mial otwarte kilka kart naraz.
const WORKBOOK_TTL_MS = 60 * 60 * 1000;
const MAX_WORKBOOKS = 3;
const workbooks = new Map(); // token -> { sheets, createdAt: number, lastAccessedAt: number }
let counter = 0;

function nextToken() {
  counter += 1;
  return `wb_${Date.now()}_${counter}`;
}

function cleanupOldWorkbooks() {
  const now = Date.now();
  for (const [token, entry] of workbooks.entries()) {
    if (now - entry.lastAccessedAt > WORKBOOK_TTL_MS) workbooks.delete(token);
  }
}
const cleanupTimer = setInterval(cleanupOldWorkbooks, 15 * 60 * 1000);
cleanupTimer.unref?.();

function evictLeastRecentlyUsedIfOverCapacity() {
  while (workbooks.size >= MAX_WORKBOOKS) {
    let oldestToken = null;
    let oldestAt = Infinity;
    for (const [token, entry] of workbooks.entries()) {
      if (entry.lastAccessedAt < oldestAt) { oldestAt = entry.lastAccessedAt; oldestToken = token; }
    }
    if (oldestToken == null) break;
    workbooks.delete(oldestToken);
  }
}

async function loadWorkbookFromBuffer(buffer) {
  cleanupOldWorkbooks();
  evictLeastRecentlyUsedIfOverCapacity();
  const surowe = await readXlsxFile(buffer, { getSheets: true }); // [{sheet, data}, ...]
  const sheets = reorderSheetsByWorkbookXml(buffer, surowe);
  const token = nextToken();
  workbooks.set(token, { sheets, createdAt: Date.now(), lastAccessedAt: Date.now() });
  return { token, sheets: sheets.map(s => s.sheet) };
}

function getWorkbook(token) {
  const entry = workbooks.get(token);
  if (!entry || Date.now() - entry.lastAccessedAt > WORKBOOK_TTL_MS) {
    workbooks.delete(token);
    throw new Error("Nie znaleziono wgranego arkusza (token wygasł). Wgraj plik ponownie.");
  }
  entry.lastAccessedAt = Date.now();
  return entry.sheets;
}

function normalizeHeader(text) {
  return toAsciiSafe(String(text || "").toLowerCase())
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


// Probuje po kolei kilka wariantow naglowka dla TEGO SAMEGO pojecia (numer
// identyfikujacy wiersz/projekt, uzywany dalej do dopasowania folderu klienta).
// Sprawdzone na WSZYSTKICH prawdziwych tabelach adresowych w uzyciu (Kamiensk,
// Maslowice, Paradyz Zarnow, Rychwal, Strzalkowo, Tuliszkow, Lowicz, Slesin) -
// zakladki "Solary"/"Kotly" najczesciej nazywaja te kolumne "LP gmina", ale
// zakladka "Pompy"/"Pompy ciepla" w TYM SAMYM pliku bardzo czesto uzywa po
// prostu samego "LP" (bez "gmina"), a Paradyz Zarnow akurat "ID projektu" -
// to zawsze ten sam numer porzadkowy, tylko inna nazwa naglowka w innej
// zakladce tego samego pliku. Kolejnosc ma znaczenie - probujemy NAJPIERW
// bardziej precyzyjny wariant "lp gmina", zeby na zakladkach majacych OBIE
// kolumny ("LP" i osobno "LP gmina" obok siebie) nie zlapac tej niewlasciwej.
function findColumnAny(headerRow, variantsList, mustNotInclude = []) {
  for (const mustIncludeAll of variantsList) {
    const col = findColumn(headerRow, mustIncludeAll, mustNotInclude);
    if (col !== -1) return col;
  }
  return -1;
}

// Skrajny przypadek zaobserwowany w jednej z prawdziwych tabel (Kamiensk,
// zakladka "Pompy ciepla"): kolumna z numerem porzadkowym w ogole nie ma
// nazwy w naglowku (pusty/spacja tekst) - wtedy dopasowanie po slowach
// kluczowych nigdy nie zadziala, bo nie ma czego dopasowac. Jedyny sygnal to
// SAME DANE: pierwsza kolumna, ktora w wierszach z danymi konsekwentnie
// zawiera liczby calkowite (1, 2, 3, ...). Uzywamy tego wylacznie jako
// ostatecznosci, gdy zaden nazwany wariant nic nie znalazl.
function looksLikeUnlabeledIdColumn(rows, colIdx, sampleSize = 15) {
  let checked = 0;
  let numericCount = 0;
  for (let r = 1; r < rows.length && checked < sampleSize; r += 1) {
    const value = rows[r]?.[colIdx];
    if (value === null || value === undefined || value === "") continue;
    checked += 1;
    const isInteger = typeof value === "number"
      ? Number.isInteger(value)
      : /^\d+$/.test(String(value).trim());
    if (isInteger) numericCount += 1;
  }
  return checked > 0 && numericCount === checked;
}

// Wczesniej KAZDA wartosc niebedaca pusta/"0"/"nie"/"-" byla cicho traktowana
// jako "odebrane" (audyt P1-4) - literowka typu "brak"/"n/d"/losowy tekst
// wykluczala caly wiersz z listy kandydatow bez sladu dla uzytkownika. Teraz
// dzialamy odwrotnie: biala lista rozpoznanych wartosci "odebrane" (tak/x/+/1,
// liczba dodatnia, data DD.MM.RRRR albo RRRR-MM-DD). Wszystko inne (w tym
// nierozpoznane literowki) NIE liczy sie jako odebrane - bezpieczniejszy blad,
// bo wiersz zostaje na liscie kandydatow zamiast zniknac po cichu.
function isTruthyMark(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "number") return value > 0;
  const s = String(value).trim().toLowerCase();
  if (!s) return false;
  if (s === "tak" || s === "x" || s === "+" || s === "1") return true;
  if (/^\d+([.,]\d+)?$/.test(s)) {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) && n > 0;
  }
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) return true; // DD.MM.RRRR
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return true; // RRRR-MM-DD
  return false;
}

function isRezygnacja(value) {
  return isAffirmativeFlag(value);
}

// Zwraca liste kandydatow (bez zaznaczonego odbioru i bez rezygnacji),
// posortowana po LP gmina rosnaco. Kazdy wpis ma tez surowy numer wiersza
// arkusza (do ewentualnej pozniejszej edycji recznej przez Piotrka).
function listCandidates(token, sheetName) {
  const sheets = getWorkbook(token);
  const arkusz = sheets.find(s => s.sheet === sheetName);
  if (!arkusz) throw new Error(`Nie znaleziono zakladki "${sheetName}" w arkuszu.`);

  const rows = arkusz.data;
  if (!rows.length) return { candidates: [], columnsFound: {} };

  const header = rows[0];
  let colLpGmina = findColumnAny(header, [["lp", "gmina"], ["id", "projekt"], ["lp"]]);
  if (colLpGmina === -1 && looksLikeUnlabeledIdColumn(rows, 0)) {
    // Naglowek pierwszej kolumny jest pusty (patrz looksLikeUnlabeledIdColumn),
    // ale dane w niej wygladaja jak numer porzadkowy - uzywamy jej zamiast
    // konczyc bledem "nie znaleziono kolumn".
    colLpGmina = 0;
  }
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
  // Wiersz z wypelnionym adresem, ale bez numeru LP gmina (albo odwrotnie) jest
  // odrzucany - bez numeru nie da sie go dopasowac do folderu klienta. Wczesniej
  // taki wiersz po prostu znikal z listy kandydatow bez sladu (ten sam blad co
  // pusta kolumna LP w tworzenie-folderow) - teraz liczymy te przypadki i
  // zwracamy w skippedRows, zeby uzytkownik zobaczyl ostrzezenie zamiast
  // domyslac sie, czemu brakuje adresu na liscie.
  let missingLpGmina = 0;
  let missingAdres = 0;
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    const adres = colAdres >= 0 ? row[colAdres] : null;
    const lpGmina = colLpGmina >= 0 ? row[colLpGmina] : null;
    const hasAdres = !(adres === null || adres === undefined || String(adres).trim() === "");
    const hasLpGmina = !(lpGmina === null || lpGmina === undefined || String(lpGmina).trim() === "");
    if (!hasAdres && !hasLpGmina) continue;
    if (hasAdres && !hasLpGmina) { missingLpGmina += 1; continue; }
    if (!hasAdres && hasLpGmina) { missingAdres += 1; continue; }

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

  // Number("cos niecliczbowego") daje NaN, a komparator zwracajacy NaN ma
  // niezdefiniowane zachowanie w Array.sort (kolejnosc staje sie
  // nieprzewidywalna) - dla "ID projektu"-stylowych kolumn (patrz komentarz
  // przy findColumnAny), ktore czasem sa alfanumeryczne, spadamy na
  // porownanie tekstowe zamiast milczaco psuc caly sort.
  candidates.sort((a, b) => {
    const na = Number(a.lpGmina);
    const nb = Number(b.lpGmina);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.lpGmina).localeCompare(String(b.lpGmina), "pl", { numeric: true });
  });
  return { candidates, columnsFound, skippedRows: { missingLpGmina, missingAdres } };
}

module.exports = { loadWorkbookFromBuffer, listCandidates, isTruthyMark, MAX_WORKBOOKS };
