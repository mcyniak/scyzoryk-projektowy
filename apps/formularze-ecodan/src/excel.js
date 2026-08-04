import fs from 'fs/promises';
import sanitize from 'sanitize-filename';
import readExcelFile from 'read-excel-file/node';
import { parsePowerKw, parseTank, parseOzc, parseHeatingSharePercent } from './rules.js';

function formatDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  const dd = String(value.getDate()).padStart(2, '0');
  const mm = String(value.getMonth() + 1).padStart(2, '0');
  const yyyy = value.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function cellToText(value) {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(value);
  return String(value).trim();
}

async function readWorkbookSheets(filePath) {
  const result = await readExcelFile(filePath);

  // Biblioteka moze zwrocic albo liste arkuszy, albo bezposrednio
  // wiersze pierwszego arkusza. Obslugujemy oba formaty, zeby import Excela
  // byl odporny na roznice konfiguracji i wersji zaleznosci.
  if (Array.isArray(result) && result.length && !Array.isArray(result[0]) && result[0] && Array.isArray(result[0].data)) {
    return result.map((sheet, index) => ({
      name: String(sheet.sheet || sheet.name || `Arkusz ${index + 1}`),
      data: Array.isArray(sheet.data) ? sheet.data : []
    }));
  }

  return [{ name: 'Arkusz 1', data: Array.isArray(result) ? result : [] }];
}

function rowValues(row) {
  return (Array.isArray(row) ? row : []).map(cellToText);
}

const HEADER_KEYWORDS = [
  'imie', 'nazwisko', 'klient', 'inwestor', 'beneficjent',
  'adres', 'ulica', 'miejscowosc', 'kod pocztowy', 'dzialka',
  'pompa', 'typ pompy', 'rodzaj pompy', 'moc', 'ozc', 'cwu',
  'bufor', 'kotlownia', 'grzejnik', 'podlog', 'audytor', 'uwagi'
];

function headerScore(values) {
  const normalized = values.map(normalizeHeader).filter(Boolean);
  let score = 0;
  for (const value of normalized) {
    for (const keyword of HEADER_KEYWORDS) {
      const wanted = normalizeHeader(keyword);
      if (value === wanted || value.includes(wanted) || wanted.includes(value)) {
        score += wanted.length > 4 ? 2 : 1;
        break;
      }
    }
  }
  if (normalized.length >= 3) score += 1;
  return score;
}

function findHeaderRow(rawRows) {
  const inputRows = Array.isArray(rawRows) ? rawRows : [];
  let fallbackIndex = -1;
  let fallbackValues = [];
  let bestIndex = -1;
  let bestValues = [];
  let bestScore = -1;

  for (let i = 0; i < Math.min(inputRows.length, 40); i += 1) {
    const values = rowValues(inputRows[i]);
    const nonEmpty = values.filter(Boolean).length;
    if (!nonEmpty) continue;
    if (fallbackIndex < 0) {
      fallbackIndex = i;
      fallbackValues = values;
    }
    const score = headerScore(values);
    if (score > bestScore || (score === bestScore && nonEmpty > bestValues.filter(Boolean).length)) {
      bestIndex = i;
      bestValues = values;
      bestScore = score;
    }
  }

  if (bestIndex >= 0 && bestScore >= 2) return { index: bestIndex, values: bestValues, score: bestScore };
  if (fallbackIndex >= 0) return { index: fallbackIndex, values: fallbackValues, score: 0 };
  return { index: -1, values: [], score: 0 };
}

function sheetDataScore(sheet) {
  const rows = Array.isArray(sheet?.data) ? sheet.data : [];
  const header = findHeaderRow(rows);
  const nonEmptyRows = rows.filter(row => rowValues(row).some(Boolean)).length;
  const name = normalizeHeader(sheet?.name || '');
  let score = nonEmptyRows;
  if (name.includes('pompy')) score += 300;
  if (name.includes('adres')) score += 260;
  if (name.includes('dane')) score += 180;
  score += header.score * 35;
  return score;
}

function chooseBestSheet(sheets) {
  const list = Array.isArray(sheets) ? sheets.filter(sheet => Array.isArray(sheet?.data)) : [];
  if (!list.length) return { name: '', data: [] };
  return [...list].sort((a, b) => sheetDataScore(b) - sheetDataScore(a))[0];
}

function rowsToObjects(rawRows) {
  const inputRows = Array.isArray(rawRows) ? rawRows : [];
  const header = findHeaderRow(inputRows);
  if (header.index < 0) return [];

  const headers = header.values.map((value, index) => value || `Kolumna ${index + 1}`);
  const rows = [];
  for (let i = header.index + 1; i < inputRows.length; i += 1) {
    const row = Array.isArray(inputRows[i]) ? inputRows[i] : [];
    const obj = {};
    let hasData = false;
    for (let col = 0; col < headers.length; col += 1) {
      const text = cellToText(row[col]);
      obj[headers[col]] = text;
      if (text) hasData = true;
    }
    if (hasData) {
      Object.defineProperty(obj, '__excelRowNumber', { value: i + 1, enumerable: false });
      rows.push(obj);
    }
  }
  return rows;
}

export function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function getCell(row, variants) {
  const keys = Object.keys(row || {});
  const normalized = keys.map(key => ({ key, norm: normalizeHeader(key) }));

  for (const variant of variants) {
    const wanted = normalizeHeader(variant);
    const exact = normalized.find(item => item.norm === wanted);
    if (exact) return row[exact.key];
  }

  for (const variant of variants) {
    const wanted = normalizeHeader(variant);
    const partial = normalized.find(item => item.norm && (item.norm.includes(wanted) || wanted.includes(item.norm)));
    if (partial) return row[partial.key];
  }

  return '';
}

export function rowHasAnyData(row) {
  return Object.values(row || {}).some(value => String(value ?? '').trim() !== '');
}

export function rowToInput(row, globalLocation = '') {
  const remarks = [
    getCell(row, ['Uwagi do audytów', 'Uwagi do audytow', 'UWAGI', 'Uwagi']),
    getCell(row, ['Audytor'])
  ].filter(Boolean).join(' ');

  const cwuTank = String(getCell(row, [
    'Wielkość zbiornika cwu',
    'Wielkosc zbiornika cwu',
    'Wielkość zbiornika CWU',
    'Zbiornik CWU',
    'CWU'
  ]) || '');

  const mergedTank = `${cwuTank} ${/solar|rozłącz|rozlacz|rozl/i.test(remarks) ? remarks : ''}`.trim();

  return {
    name: getCell(row, ['Imię i Nazwisko', 'Imie i Nazwisko', 'Imię nazwisko', 'Klient', 'Inwestor']),
    address: getCell(row, ['Adres', 'Adres inwestycji', 'Ulica']),
    location: globalLocation || getCell(row, ['Miejscowość', 'Miejscowosc', 'Lokalizacja', 'Kod pocztowy']),
    plotNumber: getCell(row, ['Numer działki', 'Numer dzialki', 'Działka', 'Dzialka']),
    pumpType: getCell(row, ['Rodzaj pompy', 'Typ pompy']),
    ozc: getCell(row, ['OZC', 'Obciążenie cieplne', 'Obciazenie cieplne']),
    municipalityPower: getCell(row, ['Moc pompy z gminy', 'Moc z gminy', 'Moc pompy']),
    chosenPower: getCell(row, ['Moc dobrana', 'Moc dobrana (kW)', 'Dobrana moc', 'Moc dobrana pompy']),
    cwuTank: mergedTank,
    // Surowa komorka zbiornika, BEZ doklejonych uwag - do scislego
    // parsowania samej liczby litrow (patrz komentarz przy parseTank w
    // rules.js: uwagi doklejone do cwuTank moga zawierac wlasne,
    // niepowiazane liczby, np. numer dzialki).
    cwuTankRaw: cwuTank,
    buffer: getCell(row, ['Wielkość bufora', 'Wielkosc bufora', 'Bufor']),
    boilerRoomHeight: getCell(row, ['Wysokość kotłowni (m)', 'Wysokosc kotlowni (m)', 'Wysokość kotłowni', 'Wysokosc kotlowni']),
    radiatorsShare: getCell(row, ['Udział ogrzew grzejnik', 'Udzial ogrzew grzejnik', 'Udział ogrzew grzejniki %', 'Grzejniki']),
    floorShare: getCell(row, ['Udział ogrzew podłog', 'Udzial ogrzew podlog', 'Udział ogrzew podłog %', 'Podłogówka', 'Podlogowka']),
    forceSplit: /rozłącz|rozlacz|rozl/i.test(remarks) ? 'tak' : 'nie',
    sourceRemarks: remarks
  };
}

function isGroundPumpType(value) {
  return /grunt|glikol|solanka/i.test(String(value || ''));
}

function isClearlyAirPumpType(value) {
  const text = normalizeHeader(value);
  return !text || /powietrz|powietrze|p w|pw|air/.test(text);
}

export async function readExcelRecords(filePath, globalLocation = '') {
  const sheets = await readWorkbookSheets(filePath);
  const selectedSheet = chooseBestSheet(sheets);
  const rows = rowsToObjects(selectedSheet.data || []);
  const sheetNames = sheets.map(sheet => sheet.name).filter(Boolean);

  const records = [];
  const skipped = {
    empty: 0, ground: 0, unknownPumpType: 0, missingAddress: 0, missingOzc: 0,
    missingPower: 0, missingLocation: 0, missingHeatingShare: 0, missingTank: 0
  };

  rows.forEach((row, index) => {
    const excelRowNumber = row.__excelRowNumber || index + 2;
    if (!rowHasAnyData(row)) {
      skipped.empty += 1;
      return;
    }

    const input = rowToInput(row, globalLocation);
    const pumpType = String(input.pumpType || '').trim();

    if (isGroundPumpType(pumpType)) {
      skipped.ground += 1;
      return;
    }

    // Nie wyrzucamy wiersza tylko dlatego, ze kolumna typu pompy jest pusta
    // albo opisana inaczej. W poprzedniej wersji to dawalo 0 adresow mimo
    // poprawnego Excela. Taki rekord moze pozniej dostac blad doboru, ale jest
    // widoczny w UI i da sie go swiadomie wybrac/odznaczyc.
    if (pumpType && !isClearlyAirPumpType(pumpType)) {
      skipped.unknownPumpType += 1;
    }

    if (!String(input.address || '').trim()) {
      skipped.missingAddress += 1;
      return;
    }

    // OZC (obciazenie cieplne) trafia wprost do pola na stronie konfiguratora
    // Ecodan. Brak/zerowe/niejednoznaczne OZC (np. "7/8" sklejone w "78" przez
    // stary num()) nie powinno isc do automatu, bo wygeneruje pozornie
    // poprawny, ale bezwartosciowy/zmyslony raport zamiast bledu.
    const ozcParsed = parseOzc(input.ozc);
    if (!ozcParsed.valid || ozcParsed.ozc <= 0) {
      skipped.missingOzc += 1;
      return;
    }

    // Ten sam powod co przy OZC wyzej: puste/niejednoznaczne dane krytyczne
    // dla doboru nie moga po cichu isc dalej z domyslna wartoscia (6 kW,
    // Slesin, grzejniki, zbiornik 200 l) - wiersz jest widocznie pomijany
    // (patrz "skipped" w odpowiedzi /api/batch/preview) zamiast wygenerowac
    // pozornie poprawny, ale bezwartosciowy/blednie skonfigurowany raport.
    // Pelna walidacja (w tym niejednoznaczne "9/12 kW") powtarza sie jeszcze
    // raz w rules.js#calculate() jako druga linia obrony dla kazdej sciezki.
    const municipalityPowerParsed = parsePowerKw(input.municipalityPower);
    const chosenPowerParsed = parsePowerKw(input.chosenPower);
    const powerForSelection = chosenPowerParsed.kw > 0 ? chosenPowerParsed.kw : municipalityPowerParsed.kw;
    if (!municipalityPowerParsed.valid || !chosenPowerParsed.valid || powerForSelection <= 0) {
      skipped.missingPower += 1;
      return;
    }

    if (!String(input.location || '').trim()) {
      skipped.missingLocation += 1;
      return;
    }

    const radiatorsShareParsed = parseHeatingSharePercent(input.radiatorsShare, 'Udział ogrzewania grzejnikowego');
    const floorShareParsed = parseHeatingSharePercent(input.floorShare, 'Udział ogrzewania podłogowego');
    if (!radiatorsShareParsed.valid || !floorShareParsed.valid) {
      skipped.missingHeatingShare += 1;
      return;
    }
    if (radiatorsShareParsed.percent <= 0 && floorShareParsed.percent <= 0) {
      skipped.missingHeatingShare += 1;
      return;
    }

    // cwuTankRaw = surowa komorka zbiornika, bez doklejonych uwag - patrz
    // komentarz przy parseTank w rules.js (uwagi moga zawierac wlasne,
    // niepowiazane liczby, np. numer dzialki, i falszywie wygladac na
    // niejednoznaczna wartosc zbiornika, gdyby parsowac je razem).
    const tankParsed = parseTank(input.cwuTankRaw, input.cwuTank);
    if (!tankParsed.litresValid || tankParsed.litres <= 0) {
      skipped.missingTank += 1;
      return;
    }

    records.push({ rowNumber: excelRowNumber, input });
  });

  return {
    sheetName: selectedSheet.name || '',
    sheetNames,
    totalRows: rows.length,
    records,
    skipped,
    headers: rows.length ? Object.keys(rows[0]) : []
  };
}

export function makePdfName(input, rowNumber = '') {
  const safeRow = String(rowNumber || '').trim();
  const prefix = safeRow ? `${safeRow.padStart(3, '0')} - ` : '';
  const base = sanitize(`${input.name || 'Brak nazwiska'} - ${input.address || (safeRow ? `wiersz ${safeRow}` : 'raport')}`)
    .replace(/\s+/g, ' ')
    .trim();
  return `${prefix}${base || `wiersz-${safeRow || Date.now()}`}.pdf`;
}

export async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}
