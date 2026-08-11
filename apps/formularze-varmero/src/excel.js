// Czytnik tabeli adresowej - wzorowany na
// apps/formularze-ecodan/src/excel.js (fuzzy dopasowanie naglowkow po
// nazwanych wariantach, liczniki pominietych wierszy per przyczyna). Uzywa
// `xlsx`, nie `read-excel-file` jak Ecodan - ten sam pakiet, ktorego uzywaja
// juz inne apki w repo czytajace dokladnie ten format tabeli adresowej
// (drukarka-projekty, ocr-audytow).
//
// Potwierdzone na dwoch realnych plikach (Kamiensk, Zagorow): naglowki
// bywaja rozne miedzy inwestycjami (np. "OZC" kontra brak tej kolumny w
// ogole, "Ogrzewanie grzejnikowe/podlogowe" jako osobne kolumny procentowe) -
// stad dopasowanie po liscie akceptowanych wariantow nazwy, nie po sztywnej
// pozycji/nazwie.
import XLSX from 'xlsx';
import { calculate } from './rules.js';

// UWAGA: polskie "ł"/"Ł" NIE rozkladaja sie pod NFD tak jak
// a/e/c/n/s/z/z (patrz CLAUDE.md - ten sam pulapka co w dokumenty-seryjne) -
// bez jawnej podmiany na "l"/"L" PRZED normalize('NFD'), "podłogowe" konczy
// jako "pod ogowe" (ł usuwane jako nieznany znak) i nigdy nie pasuje do
// zadnego wariantu naglowka - realny blad zlapany podczas testu na pliku
// Zagorow (kolumna "Ogrzewanie podłogowe" nie byla w ogole odczytywana).
function normalizeHeader(value) {
  return String(value || '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(new RegExp('[̀-ͯ]', 'g'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const COLUMN_VARIANTS = {
  lp: ['lp', 'l p'],
  name: ['imie i nazwisko', 'imie nazwisko', 'klient', 'beneficjent'],
  address: ['adres'],
  ozc: ['ozc'],
  radiatorsPercent: ['ogrzewanie grzejnikowe', 'udzial ogrzew grzejnik', 'udzial ogrzewania grzejnikowego'],
  floorPercent: ['ogrzewanie podlogowe', 'udzial ogrzew podlog', 'udzial ogrzewania plaszczyznowego'],
  pumpType: ['rodzaj pompy']
};

// Kalkulator Varmero (VPM) jest WYLACZNIE dla pomp powietrznych
// (powietrze-woda) - potwierdzone: kazdy wynik ma "Punkt biwalentny", ktory
// dotyczy tylko pomp powietrznych (gruntowe maja stabilna temperature
// dolnego zrodla caly rok, nie tracą mocy w mrozie tak jak powietrzne, wiec
// nie maja tego pojecia). Realny plik (Zagorow) ma dwie wartosci w kolumnie
// "Rodzaj pompy": "Gruntowa" i "Powietrze-woda" - tylko ta druga (i warianty
// typu "Powietrzna") moga isc do tego narzedzia. Brak/nieznana wartosc =
// pomijamy, NIE domyslamy sie ze to powietrzna.
const AIR_SOURCE_PATTERN = /powietrz/i;
const GROUND_SOURCE_PATTERN = /grunt/i;

function isAirSourcePump(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  if (GROUND_SOURCE_PATTERN.test(value)) return false;
  return AIR_SOURCE_PATTERN.test(value);
}

function getCell(row, headerIndex, field) {
  const variants = COLUMN_VARIANTS[field] || [];
  for (const variant of variants) {
    const idx = headerIndex.get(variant);
    if (idx !== undefined) return row[idx];
  }
  // Dopasowanie czesciowe (w kazda strone) jako fallback - dopiero gdy zaden
  // wariant nie trafil dokladnie.
  for (const [header, idx] of headerIndex) {
    for (const variant of variants) {
      if (header.includes(variant) || variant.includes(header)) return row[idx];
    }
  }
  return undefined;
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
    if (norm.includes('adres') && (norm.includes('imie i nazwisko') || norm.includes('lp'))) return i;
  }
  return 0;
}

function chooseSheet(workbook) {
  const preferred = workbook.SheetNames.find(name => /pomp/i.test(name));
  return preferred || workbook.SheetNames[0];
}

// Zwraca { sheetName, records: [{rowNumber, lp, input, calculated}], skipped: {...}, headers }.
// `gminaName`/`postalCode`/`zone`/`wojewodztwo` sa parametrami calej paczki
// (nie per wiersz) - potwierdzone na realnych plikach: zaden z nich nie
// wystepuje w tabeli adresowej w ogole, dotycza calej inwestycji naraz.
//
// `zone`/`wojewodztwo` to ZWYKLE parametry wejsciowe podawane RECZNIE przez
// osobe uruchamiajaca paczke (jak gminaName/postalCode), NIE wyliczane z
// jakiejs wewnetrznej tabeli gmina->strefa - wlasciciel slusznie zauwazyl
// (2026-08-10), ze taka tabela wymagalaby recznego rozszerzania w kodzie
// przy kazdej nowej inwestycji, podczas gdy strefe/wojewodztwo i tak trzeba
// znac raz, na cala paczke - prostszy i bardziej niezawodny jest zwykly
// input, ten sam wzorzec co reszta parametrow batcha.
export function readTabelaAdresowa(filePath, { gminaName, postalCode, zone, wojewodztwo } = {}) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = chooseSheet(workbook);
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerRowIndex = findHeaderRowIndex(rows);
  const headerRow = rows[headerRowIndex];
  const headerIndex = buildHeaderIndex(headerRow);

  const zoneNumber = Number(zone);
  const zoneKnown = Number.isInteger(zoneNumber) && zoneNumber >= 1 && zoneNumber <= 5;

  const skipped = {
    empty: 0,
    missingAddress: 0,
    notAirSourcePump: 0,
    missingOzc: 0,
    invalidOzc: 0,
    missingLp: 0,
    duplicateLp: 0
  };

  const records = [];
  const seenLp = new Set();

  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNumber = i + 1;
    const hasAnyValue = row.some(cell => String(cell ?? '').trim());
    if (!hasAnyValue) { skipped.empty += 1; continue; }

    const address = String(getCell(row, headerIndex, 'address') ?? '').trim();
    if (!address) { skipped.missingAddress += 1; continue; }

    const pumpTypeRaw = getCell(row, headerIndex, 'pumpType');
    if (!isAirSourcePump(pumpTypeRaw)) { skipped.notAirSourcePump += 1; continue; }

    // getCell zwraca undefined gdy arkusz W OGOLE nie ma kolumny LP (bezpieczny
    // fallback na numer wiersza), ale '' gdy kolumna JEST, tylko ta konkretna
    // komorka jest pusta - w tym drugim przypadku wczesniej cicho podstawialismy
    // numer wiersza zamiast prawdziwego LP, co pokazywalo uzytkownikowi w
    // podgladzie (inline-1.js) numer niezgodny z tym, co naprawde jest w Excelu.
    // Ten sam wzorzec co juz naprawiony w formularze-ecodan/src/excel.js.
    const lpRaw = getCell(row, headerIndex, 'lp');
    if (lpRaw !== undefined && String(lpRaw).trim() === '') { skipped.missingLp += 1; continue; }
    const lp = lpRaw !== undefined ? String(lpRaw).trim() : String(rowNumber);
    if (seenLp.has(lp)) { skipped.duplicateLp += 1; continue; }
    seenLp.add(lp);

    const name = String(getCell(row, headerIndex, 'name') ?? '').trim();
    const ozcRaw = getCell(row, headerIndex, 'ozc');
    const radiatorsRaw = getCell(row, headerIndex, 'radiatorsPercent');
    const floorRaw = getCell(row, headerIndex, 'floorPercent');

    const result = calculate({ ozc: ozcRaw, radiatorsPercent: radiatorsRaw, floorPercent: floorRaw });
    if (!result.calculated.valid) {
      if (String(ozcRaw ?? '').trim() === '') skipped.missingOzc += 1;
      else skipped.invalidOzc += 1;
      continue;
    }

    records.push({
      rowNumber,
      lp,
      input: {
        name,
        address,
        pumpType: String(pumpTypeRaw || '').trim(),
        ozcKw: result.input.ozcKw,
        radiatorsPercent: result.input.radiatorsPercent,
        floorPercent: result.input.floorPercent,
        postalCode: postalCode || '',
        gminaName: gminaName || '',
        zone: zoneKnown ? zoneNumber : null,
        wojewodztwo: wojewodztwo || ''
      },
      calculated: result.calculated
    });
  }

  return {
    sheetName,
    sheetNames: workbook.SheetNames,
    totalRows: rows.length - headerRowIndex - 1,
    records,
    skipped,
    headers: headerRow,
    zoneKnown
  };
}
