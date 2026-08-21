// Klasyfikacja arkuszy/wierszy tabeli adresowej, wspoldzielona miedzy
// apps/tworzenie-folderow (oryginalny wlasciciel tego kodu) i apps/pipeline
// (Faza 1 planu "Pipeline inwestycji", audyt 2026-08-20 - potrzebuje
// dokladnie tego samego rozpoznawania arkuszy/typow pompy do wykrycia, co
// mozna zrobic dla wgranej tabeli, PRZED odpaleniem jakiegokolwiek kroku).
// Wydzielone z apps/tworzenie-folderow/src/excel.js - zero zmiany
// zachowania tam, ten plik dostaje wywolanie z JUZ ODCZYTANYMI arkuszami
// (patrz buildTabelaAdresowa nizej).
//
// CELOWO bez zaleznosci npm (zaden `require()` poza wbudowanymi modulami
// Node) - `lib/` w tym repo nie ma wlasnego package.json/node_modules
// (root `package.json` nie ma sekcji "dependencies" w ogole), wiec modul
// tutaj nie moze zalezec od "read-excel-file" tak jak apps/*/src/excel.js
// moga (kazda apka ma wlasne node_modules). Faktyczny odczyt pliku
// (`readXlsxFile(...)`) zostaje w KAZDYM apkowym src/excel.js - ten modul
// dostaje juz gotowy wynik `readXlsxFile(path, { getSheets: true })`.

// UWAGA: polskie "l"/"L" (l z kreska) NIE rozklada sie pod NFD tak jak
// a/e/c/n/s/z/z (patrz CLAUDE.md, ten sam pulapka co w dokumenty-seryjne i
// formularze-varmero) - bez jawnej podmiany PRZED normalize('NFD'),
// "podlogowe"/"kotly" koncza jako "pod ogowe"/"kot y" i nigdy nie pasuja do
// zadnego wariantu naglowka/arkusza.
function normalizeHeader(value) {
  return String(value || '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const COLUMN_VARIANTS = {
  // Dokladnie jedna z tych dwoch kolumn jest zawsze obecna (LP albo ID),
  // nigdy obie naraz - patrz specyfikacja od wlasciciela.
  lpOrId: ['lp', 'l p', 'id'],
  address: ['adres'],
  gmina: ['gmina'],
  pumpType: ['rodzaj pompy']
};

// Ktory arkusz odpowiada ktoremu typowi folderu - dopasowanie po nazwie
// arkusza, nie po pozycji (arkusze byly widziane w roznej kolejnosci w
// realnych plikach tej firmy).
const SHEET_TYPE_PATTERNS = [
  ['pompy', /pomp/i],
  ['kolektory', /solar|kolektor/i],
  ['kotly', /kot[lł]/i]
];

// Kalkulator/dobor pomp rozroznia gruntowe i powietrzne - te same wzorce co
// apps/formularze-varmero/src/excel.js (juz zweryfikowane na realnych
// plikach tej samej firmy).
const AIR_SOURCE_PATTERN = /powietrz/i;
const GROUND_SOURCE_PATTERN = /grunt/i;

function isAirSourcePump(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  if (GROUND_SOURCE_PATTERN.test(value)) return false;
  return AIR_SOURCE_PATTERN.test(value);
}

function isGroundSourcePump(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  return GROUND_SOURCE_PATTERN.test(value);
}

function classifySheetType(sheetName) {
  const name = String(sheetName || '');
  for (const [type, pattern] of SHEET_TYPE_PATTERNS) {
    if (pattern.test(name)) return type;
  }
  return null;
}

function buildHeaderIndex(headerRow) {
  const map = new Map();
  headerRow.forEach((cell, idx) => {
    const norm = normalizeHeader(cell);
    if (norm && !map.has(norm)) map.set(norm, idx);
  });
  return map;
}

// Zwraca -1, jesli ZADEN z pierwszych 20 wierszy nie ma rozpoznawalnych
// kolumn adresu i LP/ID (audyt 2026-08-21) - wczesniej cichy fallback na
// wiersz 0 sprawial, ze caly arkusz cicho liczyl 0 rekordow (bo naglowek
// bledny -> getCell nigdy nic nie znajduje), bez zadnego bledu/ostrzezenia,
// w odroznieniu od sasiedniego przypadku "brak LP w wierszu", ktory
// deliberatnie rzuca czytelny blad zamiast cicho zanizac liczby.
function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const headerIndex = buildHeaderIndex(rows[i]);
    if (hasColumn(headerIndex, 'address') && hasColumn(headerIndex, 'lpOrId')) return i;
  }
  return -1;
}

function getCell(row, headerIndex, field) {
  const variants = COLUMN_VARIANTS[field] || [];
  for (const variant of variants) {
    const idx = headerIndex.get(variant);
    if (idx !== undefined) return row[idx];
  }
  for (const [header, idx] of headerIndex) {
    for (const variant of variants) {
      if (header.includes(variant) || variant.includes(header)) return row[idx];
    }
  }
  return undefined;
}

function hasColumn(headerIndex, field) {
  const variants = COLUMN_VARIANTS[field] || [];
  for (const variant of variants) {
    if (headerIndex.has(variant)) return true;
  }
  for (const [header] of headerIndex) {
    for (const variant of variants) {
      if (header.includes(variant) || variant.includes(header)) return true;
    }
  }
  return false;
}

function readSheet(rows, sheetName, type) {
  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) {
    // Zwracamy PUSTY wynik z jawna flaga bledu - buildTabelaAdresowa zamienia
    // to na czytelny, twardy blad (ten sam wzorzec co missingLpCount ponizej),
    // zamiast po cichu liczyc ten arkusz jako "0 rekordow".
    return { type, sheetName, gminaColumnPresent: false, records: [], missingLpCount: 0, missingAddressCount: 0, headerRowIndex: -1, headerNotFound: true };
  }
  const headerRow = rows[headerRowIndex] || [];
  const headerIndex = buildHeaderIndex(headerRow);
  // Obecnosc kolumny "Gmina" SAMA W SOBIE jest sygnalem "wiecej niz jedna
  // gmina w tej inwestycji" - potwierdzone przez wlasciciela wprost
  // ("kolumna gmina jest w tabeli adresowej tylko jak jest wiecej niz jedna
  // gmina"). Brak kolumny = jedna gmina, bez dodatkowego poziomu folderow -
  // NIE liczymy tu unikalnych wartosci jako fallback, sama obecnosc wystarcza.
  const gminaColumnPresent = hasColumn(headerIndex, 'gmina');

  const records = [];
  let missingLpCount = 0;
  let missingAddressCount = 0;
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const hasAnyValue = row.some(cell => String(cell ?? '').trim());
    if (!hasAnyValue) continue;

    const address = String(getCell(row, headerIndex, 'address') ?? '').trim();
    // Symetryczne do brakujacego LP ponizej (audyt 2026-08-21) - wczesniej
    // wiersz z danymi, ale pustym Adresem, po prostu znikal bez sladu (zero
    // licznika, zero ostrzezenia), w odroznieniu od brakujacego LP, ktory juz
    // rzuca czytelny blad zamiast cicho zanizac liczby.
    if (!address) { missingAddressCount += 1; continue; }

    const lpOrIdRaw = getCell(row, headerIndex, 'lpOrId');
    const lpOrId = String(lpOrIdRaw ?? '').trim();
    // Kolumna LP/ID bywa OBECNA w naglowku, ale pusta w realnych wierszach
    // (zdarzylo sie naprawde - arkusz "Pompy ciepla" z 47 adresami, LP puste
    // w kazdym). Bez numeru nie da sie zbudowac nazwy folderu adresu
    // ("2.Kijowiec-Szyszynek 2") - taki wiersz jest CELOWO odrzucany zamiast
    // zgadywac numer, ale liczymy go, zeby zglosic czytelny blad zamiast po
    // cichu pokazac "0 pomp" (patrz buildTabelaAdresowa).
    if (!lpOrId) { missingLpCount += 1; continue; }

    const gmina = gminaColumnPresent ? String(getCell(row, headerIndex, 'gmina') ?? '').trim() : '';

    let pumpType = null;
    if (type === 'pompy') {
      const pumpTypeRaw = getCell(row, headerIndex, 'pumpType');
      if (isGroundSourcePump(pumpTypeRaw)) pumpType = 'grunt';
      else if (isAirSourcePump(pumpTypeRaw)) pumpType = 'powietrzna';
      // Nierozpoznany/pusty rodzaj pompy: pumpType zostaje null - wiersz
      // jest odczytany, ale nie trafi ani do PC Grunt, ani do PC powietrzne
      // (nigdy nie zgadujemy typu pompy).
    }

    // rowIndex: pozycja w oryginalnym `rows` (nie w `records`) - potrzebna
    // pozniej do zbudowania przefiltrowanej kopii arkusza (patrz
    // buildFilteredSheetRows) dla apek, ktore same nie umieja zawezac po
    // adresie (karty-katalogowe, tworzenie-folderow).
    records.push({ lpOrId, address, gmina, pumpType, rowIndex: i });
  }

  return { type, sheetName, gminaColumnPresent, records, missingLpCount, missingAddressCount, headerRowIndex };
}

// wszystkieArkusze: wynik JUZ WYKONANEGO `readXlsxFile(path, { getSheets: true })`
// (wywolujacy robi faktyczny odczyt pliku - patrz komentarz na gorze pliku).
// Zwraca { sheetNames, sheets: [{ type, sheetName, gminaColumnPresent, records }] }
// - po jednym wpisie w `sheets` dla kazdego arkusza rozpoznanego jako
// pompy/kolektory/kotly (arkusze niepasujace do zadnego wzorca sa cicho
// pomijane, nie sa bledem).
function buildTabelaAdresowa(wszystkieArkusze) {
  const sheetNames = wszystkieArkusze.map(arkusz => arkusz.sheet);
  const sheets = [];
  for (const arkusz of wszystkieArkusze) {
    const type = classifySheetType(arkusz.sheet);
    if (!type) continue;
    sheets.push(readSheet(arkusz.data, arkusz.sheet, type));
  }

  // Audyt 2026-08-21: naglowek nierozpoznany w pierwszych 20 wierszach
  // (headerNotFound) rzuca TWARDY blad - bez tego caly arkusz cicho liczylby
  // 0 rekordow, bez zadnego sladu w podsumowaniu.
  const sheetsBezNaglowka = sheets.filter(s => s.headerNotFound);
  if (sheetsBezNaglowka.length > 0) {
    const nazwy = sheetsBezNaglowka.map(s => `"${s.sheetName}"`).join(', ');
    throw new Error(`Nie znaleziono wiersza nagłówka (z kolumnami Adres i LP/ID) w pierwszych 20 wierszach arkusza: ${nazwy}. Sprawdź, czy nagłówek nie jest niżej niż zwykle, i wgraj plik ponownie.`);
  }

  const sheetsWithMissingLp = sheets.filter(s => s.missingLpCount > 0);
  if (sheetsWithMissingLp.length > 0) {
    const details = sheetsWithMissingLp
      .map(s => `arkusz "${s.sheetName}": ${s.missingLpCount} ${s.missingLpCount === 1 ? 'wiersz' : 'wierszy'} z adresem bez LP`)
      .join(', ');
    throw new Error(`Kolumna LP jest pusta w niektórych wierszach (${details}). Uzupełnij numer LP dla każdego adresu w Excelu i wgraj plik ponownie - bez niego nie da się nazwać folderu adresu.`);
  }

  // Symetryczne do brakujacego LP powyzej (audyt 2026-08-21) - wiersz z
  // danymi, ale pustym Adresem, wczesniej znikal bez sladu.
  const sheetsWithMissingAddress = sheets.filter(s => s.missingAddressCount > 0);
  if (sheetsWithMissingAddress.length > 0) {
    const details = sheetsWithMissingAddress
      .map(s => `arkusz "${s.sheetName}": ${s.missingAddressCount} ${s.missingAddressCount === 1 ? 'wiersz' : 'wierszy'} bez adresu`)
      .join(', ');
    throw new Error(`Kolumna Adres jest pusta w niektórych wierszach (${details}). Uzupełnij adres dla każdego wiersza w Excelu i wgraj plik ponownie.`);
  }

  return { sheetNames, sheets };
}

module.exports = {
  buildTabelaAdresowa,
  classifySheetType,
  isAirSourcePump,
  isGroundSourcePump,
  normalizeHeader
};
