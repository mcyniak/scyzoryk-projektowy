// Zapisuje tabelke Excela dla JEDNEJ paczki (finalizacji) - GENUINELE NOWA
// ZDOLNOSC w tym repo: `xlsx` (SheetJS) jest juz zaleznoscia w
// apps/drukarka-projekty (src/excelInvestment.js), ale TYLKO do odczytu
// (XLSX.read/sheet_to_json) - nikt dotad nigdzie w repo nie zapisywal.
//
// Poprawiono 2026-07-23 (wlasciciel: "nie powinno dopisywac do istniejacej
// tabelki tylko tworzyc nowa i jedna dla wszystkich wyslanych adresow") -
// WCZESNIEJSZA wersja (appendRow) doczytywala istniejacy plik pod wskazana
// sciezka i DOPISYWALA wiersz, wiec przy ponownym uzyciu TEJ SAMEJ sciezki
// (a excelPathInput.value jest zapamietywane w localStorage miedzy sesjami!)
// kolejne, zupelnie niezwiazane partie adresow cicho lecialy do JEDNEGO,
// wiecznie rosnacego pliku. Teraz: KAZDE wywolanie tworzy plik OD ZERA
// (nadpisujac cokolwiek tam bylo), z JEDNYM arkuszem zawierajacym WSZYSTKIE
// adresy z TEJ JEDNEJ paczki (moze obejmowac wiele wgranych plikow i/albo
// wiele blokow-adresow w kazdym z nich - server.js zbiera wszystkie wiersze
// PRZED zapisem, zamiast zapisywac po jednym na blok).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { TABELA_FAMILIES, buildRowValues, matchColumnToFamily } = require('./tabelaAdresowaColumns');

function validatePath(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('Nie podano ścieżki do pliku Excel.');
  if (!/\.xlsx$/i.test(filePath)) throw new Error('Ścieżka do tabelki musi kończyć się na .xlsx.');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) throw new Error(`Folder nie istnieje: ${dir}`);
}

// Tworzy NOWY plik .xlsx (nadpisuje, jesli juz istnieje) z JEDNYM arkuszem
// `sheetName`, zawierajacym naglowek + jeden wiersz na kazdy element
// `rowValuesList` (kazdy to obiekt { [columnKey]: wartosc }). `columns` to
// uporzadkowana lista kluczy kolumn, `columnLabels` mapuje klucz na naglowek.
async function atomicWriteXlsx(filePath, writeTempFile) {
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  const tempPath = path.join(path.dirname(filePath), `.${baseName}-${crypto.randomUUID()}.tmp${extension}`);
  const backupPath = fs.existsSync(filePath)
    ? path.join(path.dirname(filePath), `${baseName}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}${extension}`)
    : null;
  let targetMovedToBackup = false;

  try {
    await writeTempFile(tempPath);
    const validationWorkbook = new ExcelJS.Workbook();
    await validationWorkbook.xlsx.readFile(tempPath);
    if (backupPath) {
      await fs.promises.rename(filePath, backupPath);
      targetMovedToBackup = true;
    }
    await fs.promises.rename(tempPath, filePath);
    return { backupPath };
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    if (targetMovedToBackup && backupPath && !fs.existsSync(filePath)) {
      await fs.promises.rename(backupPath, filePath).catch(() => {});
    }
    throw error;
  }
}

async function writeFreshRows(filePath, sheetName, columns, columnLabels, rowValuesList) {
  validatePath(filePath);
  if (!sheetName) throw new Error('Nie podano nazwy arkusza.');
  const headerRow = columns.map((key) => columnLabels[key] || key);
  const dataRows = rowValuesList.map((rowValues) => columns.map((key) => rowValues[key] ?? ''));

  const { backupPath } = await atomicWriteXlsx(filePath, async (tempPath) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]), sheetName);
    XLSX.writeFile(wb, tempPath);
  });
  return { rowCount: dataRows.length, backupPath };
}

// Jak writeFreshRows, ale dla rodzin z wlasnym, prawdziwym firmowym wzorem
// (patrz assets/templates/ + TABELA_FAMILIES w tabelaAdresowaColumns.js) -
// KLONUJE ten wzor zamiast budowac goly arkusz od zera, zeby wygenerowany
// plik wygladal WIZUALNIE identycznie jak wzor (czcionki/kolory naglowka/
// obramowania), nie tylko mial te same naglowki kolumn w plaskim tekscie.
//
// Uzywa `exceljs`, NIE `xlsx` (SheetJS) - zweryfikowane bezposrednio
// (2026-07-24), ze `xlsx` (community edition, jedyna darmowa wersja) przy
// odczyt-modyfikuj-zapisz ROZBIJA oryginalne indeksy stylow (rozne kolumny
// naglowka z osobnym formatowaniem w oryginale koncza jako 1-2 wspolne,
// gole style po zapisie) - realny test na prawdziwym wzorze pokazal to
// czarno na bialym w surowym XML (`xl/worksheets/sheet1.xml`). `exceljs`
// przy tym samym tescie poprawnie zachowal pogrubienie/kolor
// wypelnienia/obramowanie naglowka.
//
// `rowValuesList` to TA SAMA struktura co w writeFreshRows (klucz = ETYKIETA
// kolumny, nie fieldKey - patrz buildRowValues w tabelaAdresowaColumns.js).
// Kolejnosc kolumn brana jest z WLASNEGO naglowka wzoru (wiersz 1), nie z
// listy `columns` przekazanej przez wywolujacego - odpornosc na drobne
// niezgodnosci kolejnosci miedzy kodem a plikiem wzoru.
async function writeFamilyTemplateRows(templatePath, outputPath, sheetName, rowValuesList) {
  validatePath(outputPath);
  if (!fs.existsSync(templatePath)) throw new Error(`Nie znaleziono pliku wzoru: ${templatePath}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new Error(`Arkusz "${sheetName}" nie istnieje we wzorze ${templatePath}.`);

  const headerRow = worksheet.getRow(1);
  const columnLabels = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    columnLabels[colNumber] = String(cell.value ?? '').trim();
  });

  // Realny blad zlapany 2026-07-24 na prawdziwym wzorze PC: kolumna "Udzial ogrzew.
  // podlog." to ZYWA "shared formula" Excela (jedna komorka-mistrz z tekstem formuly +
  // wiele komorek-klonow bez wlasnego tekstu, tylko odwolanie do mistrza) - nadpisanie
  // SAMEGO mistrza gola wartoscia, zostawiajac klony z odwolaniem do juz-nieistniejacej
  // formuly, psulo zapis ("Shared Formula master must exist above and/or left of clone").
  // Zanim wpiszemy cokolwiek, "rozdzielamy" KAZDA shared-formule w calym arkuszu na
  // niezalezne, samodzielne formuly (ta sama tresc per komorka - `cell.formula` juz
  // zwraca poprawnie przetlumaczony tekst nawet dla klonow, np. wiersz 4 dostaje
  // "100-P4" mimo ze w pliku trzyma tylko odwolanie do mistrza w wierszu 3) - dzieki
  // temu kazda komorka jest juz samodzielna i mozna ja pozniej bezpiecznie nadpisac
  // (albo zostawic z dzialajaca formula) bez ryzyka zepsucia jakiejkolwiek INNEJ komorki.
  for (let col = 1; col < columnLabels.length; col++) {
    for (let r = 2; r <= worksheet.rowCount; r++) {
      const cell = worksheet.getRow(r).getCell(col);
      const v = cell.value;
      if (v && typeof v === 'object' && (v.sharedFormula || v.shareType === 'shared')) {
        cell.value = { formula: cell.formula, result: v.result };
      }
    }
  }

  rowValuesList.forEach((rowValues, i) => {
    const row = worksheet.getRow(i + 2);
    for (let col = 1; col < columnLabels.length; col++) {
      const label = columnLabels[col];
      if (!label) continue;
      const cell = row.getCell(col);
      const value = rowValues[label];
      // Formula (juz odsprzeglana z shared, patrz wyzej) zostaje NIETKNIETA, chyba ze
      // faktycznie MAMY dla niej wyliczona wartosc do wstawienia (kolumny `complementOf`
      // w tabelaAdresowaColumns.js) - wtedy nadpisujemy gola wartoscia, bo to bardziej
      // niezawodne niz poleganie na przeliczeniu formuly przy otwarciu pliku.
      if (cell.formula && (value === undefined || value === '')) continue;
      cell.value = value ?? '';
    }
    row.commit();
  });

  const { backupPath } = await atomicWriteXlsx(outputPath, (tempPath) => workbook.xlsx.writeFile(tempPath));
  return { rowCount: rowValuesList.length, backupPath };
}

// ---------------------------------------------------------------------
// Tryb "wgraj gotowa tabele" (2026-08-19, na wyrazna prosbe wlasciciela) -
// w odroznieniu od writeFamilyTemplateRows (zawsze KLONUJE wbudowany wzor w
// NOWY plik) te dwie funkcje czytaja/wypelniaja TEN SAM plik, ktory
// uzytkownik juz ma i czesciowo uzupelnil (np. "Biala tabela adresowa.xlsx").
// Naglowki uzytkownika czesto roznia sie interpunkcja/skrotem od etykiet
// wbudowanego wzoru (np. "Ocieplenie fund." vs "Ociepl. fund.") -
// dopasowywane przez matchColumnToFamily (tabelaAdresowaColumns.js), NIGDY
// zgadywane rozmyto - nierozpoznany naglowek zostaje po prostu pominiety.
// ---------------------------------------------------------------------

// Wyciaga tekstowa wartosc komorki - w tym z komorek-formul (ExcelJS zwraca
// dla nich obiekt { formula, result }, nie goly tekst/liczbe).
function cellTextValue(cell) {
  const raw = cell.value;
  if (raw == null) return '';
  if (typeof raw === 'object') {
    if ('result' in raw) return raw.result == null ? '' : String(raw.result).trim();
    if ('text' in raw) return String(raw.text).trim(); // rich text
    if ('richText' in raw) return raw.richText.map((r) => r.text).join('').trim();
    return '';
  }
  return String(raw).trim();
}

function cellIsEmpty(cell) {
  return cellTextValue(cell) === '';
}

// Wspolna dla odczytu i zapisu: dopasowuje kazda komorke wiersza naglowka
// (wiersz 1) do kolumny danej rodziny, znajduje tez kolumne "LP" (klucz
// dopasowania wiersz-audyt <-> wiersz-tabeli, ustalone z wlascicielem
// 2026-08-19 - pliki audytow sa juz nazwane numerem LP).
function locateColumns(worksheet, family) {
  const headerRow = worksheet.getRow(1);
  const columns = [];
  const unrecognizedHeaders = [];
  let lpColIndex = null;
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const headerText = cellTextValue(cell);
    if (!headerText) return;
    const def = matchColumnToFamily(headerText, family);
    if (!def) { unrecognizedHeaders.push(headerText); return; }
    columns.push({ colIndex: colNumber, def });
    if (def.label === 'LP') lpColIndex = colNumber;
  });
  return { columns, unrecognizedHeaders, lpColIndex };
}

function openFamilyWorksheet(workbook, filePath, family) {
  const definition = TABELA_FAMILIES[family];
  if (!definition) throw new Error(`Nieznana rodzina protokołu: ${family}`);
  const worksheet = workbook.getWorksheet(definition.sheetName) || workbook.worksheets[0];
  if (!worksheet) throw new Error(`Nie znaleziono żadnego arkusza w pliku: ${filePath}`);
  return worksheet;
}

// Czyta caly wgrany plik uzytkownika: ktore kolumny rozpoznalismy (i ktorych
// naglowkow NIE rozpoznalismy - do pokazania informacyjnie w UI), oraz jeden
// wiersz danych per LP (do zbudowania checklisty "czego brakuje").
async function readExistingTable(filePath, family) {
  if (!fs.existsSync(filePath)) throw new Error(`Nie znaleziono pliku: ${filePath}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = openFamilyWorksheet(workbook, filePath, family);

  const { columns, unrecognizedHeaders, lpColIndex } = locateColumns(worksheet, family);
  if (lpColIndex == null) {
    throw new Error('Nie znaleziono kolumny "LP" w pliku - nie da się dopasować wierszy do audytów.');
  }

  const rows = [];
  for (let r = 2; r <= worksheet.rowCount; r += 1) {
    const row = worksheet.getRow(r);
    const lp = cellTextValue(row.getCell(lpColIndex));
    if (!lp) continue; // pusty wiersz (np. odstep w tabeli) - pomijamy
    const values = {};
    for (const { colIndex, def } of columns) values[def.label] = cellTextValue(row.getCell(colIndex));
    rows.push({ rowNumber: r, lp, values });
  }

  return { columns, rows, unrecognizedHeaders };
}

// Wypelnia TEN SAM plik w miejscu - TYLKO puste komorki (nigdy nie nadpisuje
// juz istniejacej wartosci, w tym zywej formuly - komorka-formula ma zawsze
// niepusty `cell.value`, wiec cellIsEmpty() ja poprawnie omija). `rowsByLp`
// to Map<lp:string, fields> (fields = { fieldKey: {value,...} }, ta sama
// postac co przyjmuje buildRowValues). `allowedKeys` to Set kluczy
// FIELD_DEFS faktycznie wybranych przez uzytkownika na checkliscie - kolumna
// zostaje pominieta, jesli jej zrodlowy klucz (fieldKey/complementOf/
// deriveFromKeyword.sourceField) nie zostal wybrany, a kolumny biurowe
// (fieldKey: null bez complementOf/deriveFromKeyword) nigdy nie sa pisane
// automatem.
async function fillExistingTableRows(filePath, family, rowsByLp, allowedKeys) {
  validatePath(filePath);
  if (!TABELA_FAMILIES[family]) throw new Error(`Nieznana rodzina protokołu: ${family}`);

  const stats = { matchedRows: 0, filledCells: 0, unmatchedLp: [] };

  const { backupPath } = await atomicWriteXlsx(filePath, async (tempPath) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = openFamilyWorksheet(workbook, filePath, family);
    const { columns, lpColIndex } = locateColumns(worksheet, family);
    if (lpColIndex == null) throw new Error('Nie znaleziono kolumny "LP" w pliku.');

    const matchedLps = new Set();
    for (let r = 2; r <= worksheet.rowCount; r += 1) {
      const row = worksheet.getRow(r);
      const lp = cellTextValue(row.getCell(lpColIndex));
      if (!lp) continue;
      const fields = rowsByLp.get(lp);
      if (!fields) continue;
      matchedLps.add(lp);
      stats.matchedRows += 1;

      const rowValues = buildRowValues(family, fields);
      for (const { colIndex, def } of columns) {
        const sourceKey = def.fieldKey || def.complementOf || def.deriveFromKeyword?.sourceField;
        if (!sourceKey || !allowedKeys.has(sourceKey)) continue; // biurowa albo nie wybrana na checkliscie

        const cell = row.getCell(colIndex);
        if (!cellIsEmpty(cell)) continue; // NIGDY nie nadpisuj istniejacej danej
        const value = rowValues[def.label];
        if (value === '' || value == null) continue;
        cell.value = value;
        stats.filledCells += 1;
      }
    }

    for (const lp of rowsByLp.keys()) {
      if (!matchedLps.has(lp)) stats.unmatchedLp.push(lp);
    }

    await workbook.xlsx.writeFile(tempPath);
  });

  return { backupPath, ...stats };
}

module.exports = {
  writeFreshRows,
  writeFamilyTemplateRows,
  atomicWriteXlsx,
  validatePath,
  readExistingTable,
  fillExistingTableRows
};
