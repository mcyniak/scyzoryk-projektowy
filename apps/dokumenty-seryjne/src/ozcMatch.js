const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

// Nazwy folderow z danymi OZC/audytami sa bardzo niejednolite miedzy
// inwestycjami (OZC, Audyty, AUDYTY, "Audyty montazowe", "RZGOW OZC",
// "nowe ozc"...), ale zawsze zawieraja jedno z tych dwoch slow.
const OZC_FOLDER_RE = /ozc|audyt/i;
const MAX_DEPTH = 6;
// Powyzej tej liczby plikow/podfolderow w jednym katalogu przestajemy
// wchodzic glebiej (folder projektowy z rysunkami/zdjeciami moze miec
// tysiace plikow - to nie ma prawa byc folder OZC, szkoda czasu na skan).
const MAX_ENTRIES_TO_DESCEND = 2000;
// Ponizej tylu znakow wyciagnietego tekstu uznajemy plik za nieczytelny
// (skan bez warstwy tekstowej) - w praktyce takie pliki daja 0 albo kilka
// znakow (same znaki nowej linii), a prawdziwy dokument OZC ma ich tysiace.
const MIN_READABLE_TEXT_LENGTH = 200;

function findCandidateOzcFolders(investmentRoot, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = fs.readdirSync(investmentRoot, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  if (entries.length > MAX_ENTRIES_TO_DESCEND) return [];

  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(investmentRoot, e.name);
    if (OZC_FOLDER_RE.test(e.name)) {
      found.push(full);
      continue; // nie schodzimy dalej w glab juz znalezionego folderu OZC
    }
    found.push(...findCandidateOzcFolders(full, depth + 1));
  }
  return found;
}

// Polskie znaki diakrytyczne NIE sa tu usuwane celowo - zarowno nazwy
// folderow na dysku jak i adresy z Excela sa pisane normalnie po polsku
// (nie ASCII), wiec porownanie po prostu male litery + ujednolicone
// separatory jest bezpieczniejsze niz zgadywanie transliteracji.
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function leadingId(name) {
  const m = String(name || '').match(/^(\d+)[.\-_ ]/);
  return m ? m[1] : null;
}

// Nazwy plikow OZC widziane w praktyce koncza sie znacznikiem czasu
// przeliczenia (np. "OZC_Adamow 11A ... Zarnow_20260220_135458.docx") -
// gdy ta sama osoba/adres ma dokument przeliczony wiecej niz raz (rewizja),
// oba pliki maja identyczna nazwe bazowa i rozny tylko ten znacznik. W takim
// wypadku bezpiecznie jest wziac NAJNOWSZY, zamiast uznawac to za
// niejednoznacznosc - to nie sa dwa rozne dokumenty, tylko dwie wersje tego
// samego przeliczenia.
function baseNameAndTimestamp(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const m = base.match(/^(.*?)_(\d{8})(?:_(\d{6}))?$/);
  if (!m) return { key: base, timestamp: '' };
  return { key: m[1], timestamp: `${m[2]}${m[3] || ''}` };
}

// Rekurencyjnie zbiera wszystkie pliki .docx/.pdf pod danym folderem
// (nazwa pliku + nazwy folderow nadrzednych czesto niosa numer/adres, wiec
// dopasowanie sprawdza cala relatywna sciezke, nie tylko sama nazwe pliku).
function collectCandidateFiles(rootFolder, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = fs.readdirSync(rootFolder, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  if (entries.length > MAX_ENTRIES_TO_DESCEND) return [];

  const files = [];
  for (const e of entries) {
    const full = path.join(rootFolder, e.name);
    if (e.isDirectory()) {
      files.push(...collectCandidateFiles(full, depth + 1));
    } else if (/\.(docx|pdf)$/i.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

// Znajduje pliki OZC/audytu pasujace do wiersza po ID (numer na poczatku
// nazwy pliku albo nadrzednego folderu) i/albo po tekscie adresu gdziekolwiek
// w sciezce. Zwraca liste kandydatow (moze byc pusta, jeden, albo wiecej -
// ostateczne rozstrzygniecie miedzy kilkoma robi getOzcDataForRow na
// podstawie tego, ktory z nich da sie w ogole odczytac).
//
// WAZNE: gdy dopasowanie po ID daje dokladnie jeden plik, NIE zwracamy go
// od razu - to samo w sobie nie znaczy, ze jest lepszy niz dopasowanie po
// adresie (np. skan bez warstwy tekstu moze miec unikalny numer w nazwie,
// podczas gdy prawdziwe, czytelne dane leza w INNYM pliku nazwanym samym
// adresem, bez numeru - dokladnie taki przypadek zdarza sie naprawde, gdy
// ten sam klient ma i stary skan w "Audyty", i nowe cyfrowe przeliczenie w
// "OZC_WORD"). Dlatego laczymy oba dopasowania w jedna pule kandydatow i
// dopiero getOzcDataForRow wybiera na podstawie tego, ktory da sie odczytac.
function findOzcFileCandidates(ozcFolders, { id, address }) {
  const allFiles = [];
  for (const folder of ozcFolders) allFiles.push(...collectCandidateFiles(folder));
  if (!allFiles.length) return [];

  const idStr = id != null ? String(id).trim() : '';
  const normAddress = normalizeForMatch(address);

  const byId = idStr
    ? allFiles.filter(f => f.split(path.sep).some(seg => leadingId(seg) === idStr))
    : [];
  const byAddress = normAddress
    ? allFiles.filter(f => normalizeForMatch(f).includes(normAddress))
    : [];

  if (byId.length && byAddress.length) return [...new Set([...byId, ...byAddress])];
  if (byAddress.length) return byAddress;
  if (byId.length) return byId;
  return [];
}

// Wyciaga tekst z docx (mammoth) albo pdf (pdf-parse). Zwraca '' dla
// zeskanowanych/nieczytelnych plikow zamiast rzucac wyjatek - to jest
// oczekiwany, normalny wynik dla czesci inwestycji (patrz MIN_READABLE_TEXT_LENGTH).
async function extractRawText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || '';
    }
    if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      const result = await pdfParse(buf);
      return result.text || '';
    }
  } catch (_) {
    return '';
  }
  return '';
}

// Dokumenty OZC widziane w praktyce (Slesin, Zarnow/OZC_WORD) maja stala
// strukture tabeli "Etykieta:" / "Wartosc" - albo na osobnych liniach (docx
// wyciagniety przez mammoth, komorki tabeli jedna po drugiej), albo na jednej
// linii "Etykieta: Wartosc" (pdf-parse spłaszcza wiersz tabeli do jednej linii).
// Ten sam ksztalt danych, jaki juz dzis zwraca Get-RecordValue z wiersza
// Excela - dzieki temu mozna go dolozyc jako dodatkowe wlasciwosci rekordu
// bez zadnych zmian w mailmerge-to-pdf.ps1.
function parseLabelValuePairs(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const pairs = {};
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^([^:]{2,60}):\s*(\S.*)$/);
    if (inline) {
      pairs[inline[1].trim()] = inline[2].trim();
      continue;
    }
    const labelOnly = lines[i].match(/^([^:]{2,60}):$/);
    if (labelOnly && lines[i + 1] && !/:$/.test(lines[i + 1])) {
      pairs[labelOnly[1].trim()] = lines[i + 1];
    }
  }
  return pairs;
}

// Glowna funkcja: dla jednego wiersza (id + adres) znajduje dokument
// OZC/audytu i zwraca pary etykieta->wartosc, albo null gdy nie da sie
// bezpiecznie ustalic jednego, czytelnego dokumentu (brak dopasowania,
// kilka jednakowo czytelnych kandydatow, albo tylko skany bez tekstu).
async function getOzcDataForRow(ozcFolders, { id, address }) {
  const candidates = findOzcFileCandidates(ozcFolders, { id, address });
  if (!candidates.length) return null;

  if (candidates.length === 1) {
    const text = await extractRawText(candidates[0]);
    if (text.trim().length < MIN_READABLE_TEXT_LENGTH) return null;
    return parseLabelValuePairs(text);
  }

  // Kilku kandydatow (np. ten sam adres ma i skan w "Audyty", i wersje
  // cyfrowa w "OZC_WORD") - probujemy kazdego i bierzemy TYLKO jesli
  // dokladnie jeden okazuje sie czytelny. Gdy czytelnych jest kilka - to
  // prawdziwa niejednoznacznosc (np. dwie rozne sciezki dokumentacji dla
  // tego samego klienta), nie zgadujemy - chyba ze to po prostu kilka
  // rewizji tego samego przeliczenia (patrz baseNameAndTimestamp), wtedy
  // bierzemy najnowsza.
  const readable = [];
  for (const file of candidates) {
    const text = await extractRawText(file);
    if (text.trim().length >= MIN_READABLE_TEXT_LENGTH) readable.push({ file, text, ...baseNameAndTimestamp(file) });
  }
  if (!readable.length) return null;
  if (readable.length === 1) return parseLabelValuePairs(readable[0].text);

  const distinctKeys = new Set(readable.map(r => r.key));
  if (distinctKeys.size !== 1) return null;
  readable.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return parseLabelValuePairs(readable[0].text);
}

module.exports = {
  findCandidateOzcFolders,
  findOzcFileCandidates,
  getOzcDataForRow,
  extractRawText,
  parseLabelValuePairs,
  collectCandidateFiles,
  normalizeForMatch,
  leadingId,
  OZC_FOLDER_RE
};
