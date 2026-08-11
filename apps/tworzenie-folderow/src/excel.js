// Czytnik tabeli adresowej dla tworzenie-folderow - wzorowany 1:1 na
// apps/formularze-varmero/src/excel.js (ten sam pakiet xlsx, ta sama
// normalizeHeader() z poprawka na polskie "l/L" pod NFD, ten sam wzorzec
// COLUMN_VARIANTS z fuzzy dopasowaniem naglowkow). Roznica: zamiast
// wybierac JEDEN arkusz, iteruje po WSZYSTKICH arkuszach i klasyfikuje
// kazdy osobno (pompy/kolektory/kotly) - jedna inwestycja moze miec
// dowolna kombinacje tych trzech typow naraz.
const XLSX = require('xlsx');

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

function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const norm = rows[i].map(normalizeHeader);
    const hasAddress = norm.includes('adres');
    const hasLpOrId = COLUMN_VARIANTS.lpOrId.some(variant => norm.includes(variant));
    if (hasAddress && hasLpOrId) return i;
  }
  return 0;
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

function readSheet(workbook, sheetName, type) {
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerRowIndex = findHeaderRowIndex(rows);
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
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const hasAnyValue = row.some(cell => String(cell ?? '').trim());
    if (!hasAnyValue) continue;

    const address = String(getCell(row, headerIndex, 'address') ?? '').trim();
    if (!address) continue;

    const lpOrIdRaw = getCell(row, headerIndex, 'lpOrId');
    const lpOrId = String(lpOrIdRaw ?? '').trim();
    // Kolumna LP/ID bywa OBECNA w naglowku, ale pusta w realnych wierszach
    // (zdarzylo sie naprawde - arkusz "Pompy ciepla" z 47 adresami, LP puste
    // w kazdym). Bez numeru nie da sie zbudowac nazwy folderu adresu
    // ("2.Kijowiec-Szyszynek 2") - taki wiersz jest CELOWO odrzucany zamiast
    // zgadywac numer, ale liczymy go, zeby zglosic czytelny blad zamiast po
    // cichu pokazac "0 pomp" (patrz readTabelaAdresowa).
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

    records.push({ lpOrId, address, gmina, pumpType });
  }

  return { type, sheetName, gminaColumnPresent, records, missingLpCount };
}

// Zwraca { sheetNames, sheets: [{ type, sheetName, gminaColumnPresent, records }] }
// - po jednym wpisie w `sheets` dla kazdego arkusza rozpoznanego jako
// pompy/kolektory/kotly (arkusze niepasujace do zadnego wzorca sa cicho
// pomijane, nie sa bledem). Czysty odczyt danych - zero dostepu do systemu
// plikow/tworzenia folderow w tym module (patrz src/folderPlan.js).
function readTabelaAdresowa(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const type = classifySheetType(sheetName);
    if (!type) continue;
    sheets.push(readSheet(workbook, sheetName, type));
  }

  const sheetsWithMissingLp = sheets.filter(s => s.missingLpCount > 0);
  if (sheetsWithMissingLp.length > 0) {
    const details = sheetsWithMissingLp
      .map(s => `arkusz "${s.sheetName}": ${s.missingLpCount} ${s.missingLpCount === 1 ? 'wiersz' : 'wierszy'} z adresem bez LP`)
      .join(', ');
    throw new Error(`Kolumna LP jest pusta w niektórych wierszach (${details}). Uzupełnij numer LP dla każdego adresu w Excelu i wgraj plik ponownie - bez niego nie da się nazwać folderu adresu.`);
  }

  return { sheetNames: workbook.SheetNames, sheets };
}

module.exports = {
  readTabelaAdresowa,
  classifySheetType,
  isAirSourcePump,
  isGroundSourcePump,
  normalizeHeader
};
