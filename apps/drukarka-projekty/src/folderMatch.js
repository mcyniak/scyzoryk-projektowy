const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

const PRINTABLE_EXT = new Set([".pdf", ".docx", ".doc"]);
const OT_PATTERN = /^(ot[_\- ]|opis[_\- ]?techniczn)/i;
const TITLE_PATTERN = /^(st[_\- ]|strona[_\- ]?tytu[łl]owa)/i;

// Kolektory czesto nazywaja pliki "ST_..."/"OT_..." (skrot na poczatku), ale
// niektore foldery (np. Łowicz) numeruja pliki w kolejnosci "1. Strona
// tytulowa.pdf", "2. Opis techniczny ...pdf" - numer i kropka na poczatku
// nazwy przeszkadzaja dopasowaniu do wzorcow powyzej, wiec usuwamy taki
// prefiks przed testowaniem.
function stripNumericPrefix(name) {
  return name.replace(/^\d+[.\-_ ]+\s*/, "");
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ANNOTATION_WORDS = new Set(["zmiana", "adresu", "adrsu", "adres", "stary", "nowy", "poprzedni", "obecnie", "wczesniej"]);

function addressTokens(adres) {
  return normalize(adres)
    .split(" ")
    .filter(t => (t.length > 1 || /^\d$/.test(t)) && t !== "ul" && t !== "nr" && !ANNOTATION_WORDS.has(t));
}

function filenameMatchesAddress(filename, tokens) {
  if (!tokens.length) return false;
  const fNorm = normalize(filename);
  return tokens.every(t => {
    const re = new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`);
    return re.test(fNorm);
  });
}

function filenameMatchesOwnAddress(filename, tokens) {
  if (!tokens.length) return false;
  const fNorm = normalize(filename);
  function tokenMatches(t) {
    const isNumberLike = /^\d/.test(t);
    let re;
    if (isNumberLike) re = new RegExp(`(^|[^a-z0-9])${t.replace(/[a-z]+$/, "")}[a-z]?([^a-z0-9]|$)`);
    else if (t === "kol" || t === "kolonia") re = /(^|[^a-z0-9])kol(onia)?([^a-z0-9]|$)/;
    else re = new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`);
    return re.test(fNorm);
  }
  const numberTokens = tokens.filter(t => /^\d/.test(t));
  const nameTokens = tokens.filter(t => !/^\d/.test(t));
  if (numberTokens.length && !numberTokens.some(tokenMatches)) return false;
  if (nameTokens.length) {
    const matchedNameCount = nameTokens.filter(tokenMatches).length;
    const required = nameTokens.length <= 1 ? nameTokens.length : (nameTokens.length === 2 ? 1 : Math.max(2, Math.ceil(nameTokens.length * 0.6)));
    if (matchedNameCount < required) return false;
  }
  return true;
}

// lpGmina pochodzi z wgranego arkusza Excel - nie ufamy jej wprost jako
// gotowemu fragmentowi regexu (bez tego np. komorka z "(a+)+" trafiajaca do
// new RegExp() bylaby wstrzyknieciem/potencjalnym ReDoS-em).
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Realny przypadek 2026-08-14 (Kazimierz Biskupi): baseFolder bywa folderem
// "kategorii" (np. "Projekty"), a faktyczne foldery adresow siedza dopiero w
// jego podfolderach ("Wyslane do gminy", "Gotowe do druku"...) - bez
// przeszukania podfolderow uzytkownik musial recznie wskazywac kazdy
// podfolder kategorii z osobna. Szukamy wiec numeru LP takze w podfolderach,
// do ograniczonej glebokosci (typowo 1-2 poziomy kategorii, nie cale drzewo
// projektu).
const ADDRESS_FOLDER_SEARCH_MAX_DEPTH = Number(process.env.DRUKARKA_PROJEKTY_ADDRESS_SEARCH_DEPTH || 3);

function findAddressFolder(baseFolder, lpGmina) {
  if (!fs.existsSync(baseFolder) || !fs.statSync(baseFolder).isDirectory()) {
    throw new Error(`Folder bazowy nie istnieje: ${baseFolder}`);
  }
  const lpStr = String(lpGmina).trim();
  const re = new RegExp(`^${escapeRegExp(lpStr)}(?!\\d)`);
  const matches = [];
  const allFolders = [];

  function walk(currentPath, relPath, depth) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true }).filter(e => e.isDirectory());
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      const rel = relPath ? path.join(relPath, entry.name) : entry.name;
      allFolders.push(rel);
      if (re.test(entry.name.trim())) {
        matches.push(rel);
      } else if (depth < ADDRESS_FOLDER_SEARCH_MAX_DEPTH) {
        walk(path.join(currentPath, entry.name), rel, depth + 1);
      }
    }
  }

  walk(baseFolder, "", 0);
  return { matches, allFolders };
}

// Skanuje pliki BEZPOSREDNIO w folderze adresu ORAZ jeden poziom w glab
// podfolderow (czesto dokumenty siedza w podfolderze np. "PDF" zamiast
// bezposrednio w folderze adresu). Zwraca sciezki wzgledne wobec folderPath
// (moga zawierac segment podfolderu, np. "PDF\Opis_techniczny.pdf").
const MAX_SCAN_DEPTH = Number(process.env.DRUKARKA_PROJEKTY_MAX_SCAN_DEPTH || 8);
const TEMP_FILE_PATTERNS = [/^~\$/, /\.tmp$/i, /\.temp$/i, /\.lock$/i, /^Thumbs\.db$/i, /^desktop\.ini$/i];

function isTemporaryFile(fileName) {
  const base = path.basename(fileName);
  return TEMP_FILE_PATTERNS.some(re => re.test(base));
}

// Audyt na zywo 2026-08-13: prawdziwy przypadek na Google Drive
// ("G:\Dyski wspoldzielone\...") - odczyt PODFOLDERU (depth>0) zawiodl
// chwilowo (dokladnie przyczyna juz przewidziana w komentarzu przy
// scanFilesRecursive ponizej), zostal cicho potraktowany jako "podfolder
// pusty" bez zadnej proby ponowienia, a dopasowanie po cichu spadlo na
// pliki robocze (DWG/BAK/TIF) lezace luzem w folderze adresu. Ponawiamy
// TYLKO nieudany odczyt (rzadka sciezka), zanim faktycznie uznamy podfolder
// za nieczytelny.
const NESTED_READ_RETRY_ATTEMPTS = Number(process.env.DRUKARKA_PROJEKTY_NESTED_READ_RETRIES || 2);
const NESTED_READ_RETRY_DELAY_MS = Number(process.env.DRUKARKA_PROJEKTY_NESTED_READ_RETRY_DELAY_MS || 400);

// Brak Atomics.wait na glownym watku (Node rzuca wyjatkiem poza Workerem), a
// zamiana scanFilesRecursive/classifyFiles na async pociagnelaby za soba
// wszystkie miejsca ktore wolaja je synchronicznie, m.in.
// test-sorting-regression.js - zwykle zajete-czekanie jest tu swiadomym
// kompromisem: uruchamia sie WYLACZNIE po juz-nieudanej probie odczytu
// podfolderu (rzadka sciezka), nigdy w typowym biegu.
function blockingSleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* busy-wait */ }
}

function readDirWithRetry(currentPath, depth) {
  const maxAttempts = depth === 0 ? 1 : 1 + NESTED_READ_RETRY_ATTEMPTS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) blockingSleep(NESTED_READ_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// Priorytet dla podfolderu z dokumentami PDF (np. "<adres>-pdf") nad plikami
// luzem w folderze adresu albo w innych podfolderach - real case 2026-08-13:
// prawdziwe dokumenty czesto siedza w takim podfolderze, a w folderze
// adresu leza tylko pliki robocze (DWG/BAK/TIF) o podobnych nazwach, ktore
// bez tego priorytetu potrafily wygrac w .find()-ach klasyfikacji ponizej.
// Array.prototype.sort jest stabilny (gwarancja specyfikacji od ES2019),
// wiec w obrebie tej samej rangi kolejnosc naturalnego przechodzenia
// katalogu jest zachowana.
function pdfSubfolderRank(relPath) {
  const dir = path.dirname(relPath);
  if (dir === '.') return 1;
  return /pdf/i.test(dir.split(path.sep)[0]) ? 0 : 1;
}

function scanFilesRecursive(folderPath) {
  const results = [];
  const warnings = [];
  function walk(currentPath, relativePath, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readDirWithRetry(currentPath, depth);
    } catch (err) {
      // Folder adresu sam w sobie nieczytelny (np. chwilowy problem sieciowego
      // dysku Google Drive, blokada uprawnien) - odrozniamy to od "folder
      // pusty". Bez tego rozroznienia caly komplet dokumentow wygladal jak
      // "BRAK PLIKU" dla kazdej pozycji, sugerujac ze pliki naprawde nie
      // istnieja, zamiast ze po prostu nie udalo sie ich odczytac. Zagniezdzone
      // podfoldery (depth>0) zostaja tolerowane PO probach ponowien powyzej -
      // pojedynczy dalej-nieczytelny podfolder nie powinien blokowac calego
      // dopasowania adresu, ale zglaszamy to jako ostrzezenie zamiast cicho
      // udawac ze byl pusty.
      if (depth === 0) {
        throw new Error(`Nie udało się odczytać folderu "${currentPath}": ${err.message || err}`);
      }
      warnings.push(`Podfolder "${relativePath}" nie został odczytany mimo ponowień (${err.message || err}) - pominięty, mógł zawierać pliki. Spróbuj dopasować ten adres jeszcze raz.`);
      return;
    }
    for (const entry of entries) {
      const entryFull = path.join(currentPath, entry.name);
      const entryRel = relativePath ? path.join(relativePath, entry.name) : entry.name;
      // Dirent.isSymbolicLink() obejmuje standardowe symlinki i junctiony widziane
      // przez Node. Nietypowe reparse points sterowników mogą wymagać osobnego API.
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) {
        results.push(entryRel);
      } else if (entry.isDirectory()) {
        walk(entryFull, entryRel, depth + 1);
      }
    }
  }
  walk(folderPath, '', 0);
  results.sort((a, b) => pdfSubfolderRank(a) - pdfSubfolderRank(b));
  // Audyt na zywo 2026-08-13 (zlapane przez CI, test/group6-workflows.test.js):
  // scanFilesRecursive jest publicznie eksportowana i mial zewnetrzny test
  // wywolujacy .sort() bezposrednio na wyniku ORAZ inny porownujacy go przez
  // assert.deepStrictEqual, oba zakladajace ZWYKLA tablice. Zamiast lamac ten
  // kontrakt (zwracanie {files, warnings}), doczepiamy warnings jako
  // NIEENUMEROWALNA wlasciwosc NA tablicy - .sort()/.filter()/.map()/.length
  // dzialaja dokladnie jak wczesniej, deepStrictEqual jej nie widzi (patrzy
  // tylko na wlasne enumerowalne wlasciwosci), a classifyFiles ponizej i tak
  // moze ja odczytac przez zwykly dostep do wlasciwosci.
  Object.defineProperty(results, 'warnings', { value: warnings, enumerable: false });
  return results;
}

function classifyFiles(folderPath) {
  const allEntries = scanFilesRecursive(folderPath);
  const warnings = allEntries.warnings || [];
  const ignoredTemporary = allEntries.filter(isTemporaryFile);
  const entries = allEntries.filter(name => !isTemporaryFile(name));

  const printableRaw = entries.filter(name => PRINTABLE_EXT.has(path.extname(name).toLowerCase()));
  const skipped = entries.filter(name => !PRINTABLE_EXT.has(path.extname(name).toLowerCase()));

  const techDescDocxForExtraction = printableRaw.find(n => OT_PATTERN.test(stripNumericPrefix(path.basename(n))) && n.toLowerCase().endsWith(".docx"));

  const byBaseName = new Map();
  for (const name of printableRaw) {
    const ext = path.extname(name).toLowerCase();
    const dir = path.dirname(name);
    const base = path.basename(name, ext).toLowerCase();
    const key = `${normalize(dir)}|${base}`;
    if (!byBaseName.has(key)) byBaseName.set(key, []);
    byBaseName.get(key).push(name);
  }
  const printable = [];
  const droppedDuplicates = [];
  for (const names of byBaseName.values()) {
    if (names.length === 1) { printable.push(names[0]); continue; }
    const pdfVersion = names.find(n => n.toLowerCase().endsWith(".pdf"));
    const keep = pdfVersion || names[0];
    printable.push(keep);
    for (const n of names) { if (n !== keep) droppedDuplicates.push(n); }
  }

  let titlePage = printable.find(n => TITLE_PATTERN.test(stripNumericPrefix(path.basename(n))) && n.toLowerCase().endsWith(".pdf"))
    || printable.find(n => TITLE_PATTERN.test(stripNumericPrefix(path.basename(n))));

  let techDescPdf = printable.find(n => OT_PATTERN.test(stripNumericPrefix(path.basename(n))) && n.toLowerCase().endsWith(".pdf"));
  let techDescDocx = techDescDocxForExtraction;

  const drawingLike = printable.filter(n => /^\d+_[a-ząćęłńóśźż]_/i.test(path.basename(n)) && n.toLowerCase().endsWith(".pdf"));

  const otStVariants = printable.filter(n =>
    (OT_PATTERN.test(stripNumericPrefix(path.basename(n))) || TITLE_PATTERN.test(stripNumericPrefix(path.basename(n)))) &&
    n !== titlePage && n !== techDescPdf && n !== techDescDocx
  );

  const usedSoFar = new Set([titlePage, techDescPdf, ...drawingLike, ...otStVariants].filter(Boolean));
  if (printable.includes(techDescDocx)) usedSoFar.add(techDescDocx);
  const pool = printable.filter(n => !usedSoFar.has(n));

  return { printable, skipped, ignoredTemporary, droppedDuplicates, titlePage, techDescPdf, techDescDocx, drawingLike, otStVariants, pool, warnings };
}

async function extractText(folderPath, techDescDocx, techDescPdf) {
  if (techDescDocx) {
    const buffer = fs.readFileSync(path.join(folderPath, techDescDocx));
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  if (techDescPdf) {
    const buffer = fs.readFileSync(path.join(folderPath, techDescPdf));
    const result = await pdfParse(buffer);
    return result.text || "";
  }
  return "";
}

async function detectByContent(folderPath, classified) {
  const pool = [...classified.pool];
  const stillPool = [];
  const extraDrawings = [];
  let protokolFile = null;
  for (const fileName of pool) {
    if (!fileName.toLowerCase().endsWith(".pdf")) { stillPool.push(fileName); continue; }
    let text = "";
    try {
      const buffer = fs.readFileSync(path.join(folderPath, fileName));
      const result = await pdfParse(buffer, { max: 2 });
      text = normalize((result.text || "").slice(0, 3000));
    } catch (_) { stillPool.push(fileName); continue; }
    if (text.length < 20) { stillPool.push(fileName); continue; }
    if (!protokolFile && text.includes("protokol uzgodnien projektowych")) { protokolFile = fileName; continue; }
    if (text.includes("tytul rysunku") || text.includes("nr rysunku")) { extraDrawings.push(fileName); continue; }
    stillPool.push(fileName);
  }
  return { ...classified, pool: stillPool, drawingLike: [...classified.drawingLike, ...extraDrawings], protokolFileByContent: protokolFile };
}

function extractAttachmentsList(text) {
  // Kolektory pisza pelne "Załącznik nr 1: Nazwa" w jednej linii. Pompy
  // ciepla / kotly czesto pisza skrocone "Zał. nr 1" w tabeli (Nr zalacznika
  // | Nazwa rysunku), gdzie numer i nazwa sa w OSOBNYCH akapitach ekstrakcji
  // (mammoth/pdf-parse rozbijaja komorki tabeli na osobne linie) - stąd
  // "(?:[ąa]cznik|\\.)" (pelne slowo ALBO sama kropka po skrocie) i "\\s+"
  // (ktore juz samo w sobie obejmuje znaki nowej linii) laczace numer z
  // nazwa nawet gdy dzieli je pusta linia.
  const re = /Za[łl](?:[ąa]cznik|\.)\s*nr\.?\s*(\d+(?:\.\d+)*)[.:]?\s+([^\n\r]+)/gi;
  const items = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = m[1];
    const name = m[2].trim().replace(/\s{2,}/g, " ");
    if (name.length > 0 && name.length < 200) items.push({ num, name });
  }
  const seen = new Set();
  const deduped = items.filter(it => {
    const key = it.num + "|" + normalize(it.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => compareAttachmentNumbers(a.num, b.num));
  const seenNum = new Set();
  const numbered = deduped.filter(it => {
    if (seenNum.has(it.num)) return false;
    seenNum.add(it.num);
    return true;
  });
  if (numbered.length) return numbered;

  // Niektore szablony (np. kotly na biomase) nie numeruja zalacznikow wcale -
  // maja tylko naglowek "SPIS ZALACZNIKOW:" a pod nim po prostu nazwy, po
  // jednej w linii, az do kolejnego naglowka (linia WIELKIMI LITERAMI). W
  // takim przypadku numerujemy je sami wg kolejnosci wystapienia.
  const headerMatch = /SPIS\s+ZA[ŁL][ĄA]CZNIK[ÓO]W\s*:?/i.exec(text);
  if (!headerMatch) return [];
  const afterHeader = text.slice(headerMatch.index + headerMatch[0].length);
  const lines = afterHeader.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fallback = [];
  for (const line of lines) {
    const isHeading = /^[A-ZĄĆĘŁŃÓŚŹŻ0-9][A-ZĄĆĘŁŃÓŚŹŻ0-9 .:/-]{3,}$/.test(line) && line === line.toUpperCase();
    if (isHeading) break;
    if (line.length > 0 && line.length < 200) fallback.push({ num: String(fallback.length + 1), name: line.replace(/\.$/, "") });
  }
  return fallback;
}

function compareAttachmentNumbers(a, b) {
  const segA = String(a).split('.').map(Number);
  const segB = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(segA.length, segB.length); i++) {
    const diff = (segA[i] ?? 0) - (segB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const KEYWORD_MAP = [
  [["bioz"], ["bioz"]],
  [["symulacj"], ["symulacj"]],
  [["protok", "uzgodni"], ["protok"]],
  [["kolektor", "slonecznego"], ["kolektor"]],
  [["zasobnik", "solarnego"], ["zasobnik"]],
  // "grupa" (nie "grup") bylo bledem tego samego rodzaju co historyczny
  // "pompa"/"pompy" - prawdziwy tekst zalacznikow uzywa odmiany ("grupy
  // pompowej"), ktora nie zawiera literalnie "grupa" jako podciagu. Reszta
  // KEYWORD_MAP juz konsekwentnie uzywa golych rdzeni z tego samego powodu.
  [["grup", "pompow"], ["grupa", "pomp"]],
  [["sterownik"], ["sterownik", "regulator"]],
  [["bilans"], ["ozc", "bilans", "zapotrzebowani"]],
  [["dobor"], ["dobor", "doboru"]],
  [["bufor"], ["bufor"]],
  [["pomp", "ciepla"], ["pomp"]],
  // "kociol" byl tu wpisany dwa razy (kopiuj-wklej) - usuniete jako martwy
  // duplikat. Jesli w praktyce ten wyzwalacz zacznie za rzadko trafiac,
  // brakuje tu prawdopodobnie drugiego, innego slowa kluczowego - nie zgaduje
  // go tutaj bez realnego przykladu dokumentu ktory by tego wymagal.
  [["kocio"], ["kociol"]],
  [["kotl", "biomas"], ["katalogowa"]]
];

// Wyzwalacz z wieloma slowami wymaga WSZYSTKICH z nich (np. ["kolektor",
// "slonecznego"] nie powinno lapac samego "kolektor" bez "slonecznego") -
// "|| triggers.some(...)" bylo tu bledem: skoro .every() bycie prawda i tak
// zawsze implikuje .some() bycie prawda, caly warunek zawsze i tak sprowadzal
// sie do samego .some() (dopasowanie po KTORYMKOLWIEK slowie), co dla
// wieloslownych wyzwalaczy bylo szersze niz zamierzone.
function guessKeywordsForAttachment(name) {
  const norm = normalize(name);
  for (const [triggers, keywords] of KEYWORD_MAP) {
    if (triggers.every(t => norm.includes(t))) return keywords;
  }
  const words = norm.split(" ").filter(w => w.length > 3);
  words.sort((a, b) => b.length - a.length);
  return words.slice(0, 1);
}

function buildOrder(classified, attachmentsList, addressHint) {
  const order = [];
  const pool = [...classified.pool];
  const myTokens = addressTokens(addressHint && addressHint.adres);
  const otherAddressList = ((addressHint && addressHint.otherAddresses) || []).filter(Boolean);

  const excludedForeign = [];
  for (let i = pool.length - 1; i >= 0; i -= 1) {
    const matchedOther = otherAddressList.find(other => {
      const otherTokens = addressTokens(other);
      const isSubsetOfOwn = otherTokens.length && otherTokens.every(t => myTokens.includes(t));
      if (isSubsetOfOwn) return false;
      return filenameMatchesAddress(pool[i], otherTokens);
    });
    if (matchedOther) { excludedForeign.push({ file: pool[i], matchedOtherAddress: matchedOther }); pool.splice(i, 1); }
  }

  function takeAllFromPool(matchFn) {
    const found = [];
    for (let i = pool.length - 1; i >= 0; i -= 1) { if (matchFn(pool[i])) { found.unshift(pool[i]); pool.splice(i, 1); } }
    return found;
  }
  function takeFromPool(keywords) { return takeAllFromPool(f => keywords.some(kw => normalize(f).includes(kw))); }

  // Grupuje po "core" nazwy (bez rozszerzenia i bez ewentualnego doklejonego
  // znacznika czasu zapisu _RRRRMMDD_GGMMSS) - patrz komentarz przy uzyciu
  // ponizej w petli zalacznikow.
  const TRAILING_TIMESTAMP_RE = /_\d{8}_\d{6}$/;
  function coreDocumentName(fileName) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    return normalize(base.replace(TRAILING_TIMESTAMP_RE, ""));
  }
  function dedupeSameDocumentDifferentFormat(files) {
    const byCore = new Map();
    for (const f of files) {
      const key = coreDocumentName(f);
      if (!byCore.has(key)) byCore.set(key, []);
      byCore.get(key).push(f);
    }
    const keep = [];
    const extras = [];
    for (const group of byCore.values()) {
      if (group.length === 1) { keep.push(group[0]); continue; }
      const pdfVersion = group.find(n => n.toLowerCase().endsWith(".pdf"));
      const winner = pdfVersion || group[0];
      keep.push(winner);
      for (const n of group) { if (n !== winner) extras.push(n); }
    }
    return { keep, extras };
  }
  // Audyt na zywo 2026-08-13 (Kazimierz Biskupi, Ul. Reja 5, Posada): to jest
  // AWARYJNY fallback dla protokolu (patrz uzycie ponizej), wiec musi byc
  // waski. Prawdziwe pliki protokolu sa w praktyce nazwane SAMYM adresem
  // (np. "Żarnów Spacerowa.pdf" - patrz przypiety test regresyjny), ale w
  // tym samym folderze inne dokumenty (np. "Przedmiar robót - Ul. Reja 5,
  // Posada.pdf") TEZ zawieraja adres w nazwie, jako sufiks przy wlasciwej
  // tresciowej nazwie. Dawna wersja brala KAZDY plik pasujacy do adresu,
  // wiec gdy w folderze faktycznie nie bylo protokolu, po cichu porywala
  // pierwszy z brzegu inny dokument i podpisywala go jako protokol - a
  // prawdziwy dokument (tu: Przedmiar robot) wychodzil potem jako "BRAK
  // PLIKU", bo byl juz zajety. Teraz bierzemy TYLKO pliki, ktorych nazwa (po
  // odjeciu tokenow adresu) nie zostawia zadnych innych sensownych slow -
  // jesli takiego pliku nie ma, zwracamy pusto (protokol poprawnie wychodzi
  // jako brak), zamiast zgadywac. Trzecia linia w petli zalacznikow ponizej
  // (generyczny takeFromPool po slowach kluczowych, w tym "protok" z
  // KEYWORD_MAP) nadal lapie prawdziwe pliki protokolu z dodatkowymi
  // slowami w nazwie (np. "Protokol uzgodnien - Zarnow.pdf").
  function takeAllAddressNamedFiles() {
    if (!myTokens.length) return [];
    return takeAllFromPool(f => {
      if (!filenameMatchesOwnAddress(f, myTokens)) return false;
      const base = path.basename(f, path.extname(f));
      const leftoverWords = normalize(base).split(" ").filter(w => w && !myTokens.includes(w));
      return leftoverWords.length === 0;
    });
  }

  let protokolByContent = classified.protokolFileByContent || null;

  // Kazdy z ponizszych 3 elementow jest WYMAGANY - jesli go brakuje,
  // dodajemy jawny wpis "BRAK PLIKU" zamiast po prostu go pomijac. Bez
  // tego brakujacy plik byl NIEWIDOCZNY w wyniku (nic sie nie dodawalo),
  // co przy braku innych niepewnych pozycji dawalo falszywe "komplet".
  if (classified.titlePage) {
    order.push({ file: classified.titlePage, label: "Strona tytułowa", confidence: "pewne" });
  } else {
    order.push({ file: null, label: "Strona tytułowa (BRAK PLIKU - dodaj ręcznie)", confidence: "brak" });
  }

  const otFile = classified.techDescPdf || classified.techDescDocx;
  if (otFile) {
    order.push({ file: otFile, label: "Opis techniczny", confidence: "pewne" });
  } else {
    order.push({ file: null, label: "Opis techniczny (BRAK PLIKU - dodaj ręcznie)", confidence: "brak" });
  }
  if (otFile && (!attachmentsList || attachmentsList.length === 0)) {
    order.push({ file: null, label: "Nie znaleziono listy załączników w Opisie technicznym - sprawdź ręcznie (może mieć inny format)", confidence: "brak" });
  }

  for (const variant of classified.otStVariants || []) {
    order.push({ file: variant, label: "Dodatkowy wariant Opisu/Strony tytułowej - NIE trafia do druku, sprawdź który jest właściwy", confidence: "wariant - sprawdź ręcznie" });
  }

  if (classified.drawingLike.length) {
    for (const d of classified.drawingLike) order.push({ file: d, label: "Rysunek / dokumentacja rysunkowa", confidence: "pewne" });
  } else {
    order.push({ file: null, label: "Rysunek / dokumentacja rysunkowa (BRAK PLIKU - dodaj ręcznie)", confidence: "brak" });
  }

  const unmatchedAttachments = [];
  const satisfiedKeywordSets = [];
  const duplicateFiles = [];
  for (const att of attachmentsList) {
    const isProtokolLike = /protok|uzgodni/i.test(att.name);
    const keywords = guessKeywordsForAttachment(att.name);
    let foundFiles = [];
    let confidence = "słowo kluczowe";
    if (isProtokolLike && protokolByContent) { foundFiles = [protokolByContent]; confidence = "pewne"; protokolByContent = null; }
    if (!foundFiles.length && isProtokolLike) { foundFiles = takeAllAddressNamedFiles(); confidence = "pewne"; }
    if (!foundFiles.length) { foundFiles = takeFromPool(keywords); }
    if (foundFiles.length > 1) {
      // Audyt na zywo 2026-08-13 (Bilans cieplny, Reja 5): takeFromPool celowo
      // zbiera WSZYSTKIE dopasowania (kilka prawdziwie roznych plikow moze
      // pasowac do jednego zalacznika, np. strony rysunku) - ale to samo
      // zrodlowe zdjecie/dokument bywa dostepne w dwoch formatach z jednego
      // eksportu (np. "OZC_....pdf" i "OZC..._20260730_143045.docx", gdzie
      // docx to po prostu ten sam plik z doklejonym znacznikiem czasu
      // zapisu), co bez tej deduplikacji dawalo DWA osobne wpisy tego samego
      // zalacznika zamiast jednego. Ten sam "core" nazwy (bez rozszerzenia i
      // bez ewentualnego sufiksu _RRRRMMDD_GGMMSS) -> jeden wpis, preferuj PDF.
      const deduped = dedupeSameDocumentDifferentFormat(foundFiles);
      foundFiles = deduped.keep;
      duplicateFiles.push(...deduped.extras);
    }
    if (foundFiles.length) {
      satisfiedKeywordSets.push(isProtokolLike ? ["protok"] : keywords);
      foundFiles.forEach((file, idx) => {
        const suffix = foundFiles.length > 1 ? ` (${idx + 1}/${foundFiles.length})` : "";
        order.push({ file, label: `Załącznik nr ${att.num}: ${att.name}${suffix}`, confidence });
      });
    } else {
      unmatchedAttachments.push(att);
    }
  }

  for (let i = pool.length - 1; i >= 0; i -= 1) {
    const leftoverNorm = normalize(pool[i]);
    const isDuplicateOfSatisfied = satisfiedKeywordSets.some(kws => kws.some(kw => leftoverNorm.includes(kw)));
    if (isDuplicateOfSatisfied) { duplicateFiles.push(pool[i]); pool.splice(i, 1); }
  }

  for (const att of unmatchedAttachments) {
    if (!pool.length) {
      order.push({ file: null, label: `Załącznik nr ${att.num}: ${att.name} (BRAK PLIKU - dodaj ręcznie)`, confidence: "brak" });
      continue;
    }
    const found = pool.shift();
    order.push({ file: found, label: `Załącznik nr ${att.num}: ${att.name}`, confidence: "dopasowanie po kolejności - sprawdź" });
  }

  for (const dup of duplicateFiles) {
    order.push({ file: dup, label: "Dodatkowy plik pasujący do już wypełnionego załącznika - NIE trafia do druku, sprawdź który jest właściwy", confidence: "wariant - sprawdź ręcznie" });
  }
  for (const leftover of pool) {
    order.push({ file: leftover, label: "Niedopasowany plik - sprawdź ręcznie", confidence: "niedopasowane" });
  }
  for (const ex of excludedForeign) {
    order.push({ file: ex.file, label: `Plik wygląda na dokument innego adresu (${ex.matchedOtherAddress}) - pominięty, nie trafi do druku`, confidence: "obcy adres - pominięte" });
  }

  return order;
}

module.exports = {
  findAddressFolder,
  scanFilesRecursive,
  classifyFiles,
  detectByContent,
  extractText,
  extractAttachmentsList,
  compareAttachmentNumbers,
  isTemporaryFile,
  buildOrder,
  normalize,
  addressTokens,
  filenameMatchesOwnAddress
};
