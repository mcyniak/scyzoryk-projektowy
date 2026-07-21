// Dopisywanie wierszy (jeden audyt = jeden adres) do jednej wspolnej tabelki
// Excela, wskazywanej przez uzytkownika sciezka lokalna (patrz plan z
// 2026-07-21) - GENUINELE NOWA ZDOLNOSC w tym repo: `xlsx` (SheetJS) jest juz
// zaleznoscia w apps/drukarka-projekty (src/excelInvestment.js), ale TYLKO do
// odczytu (XLSX.read/sheet_to_json) - nikt dotad nigdzie w repo nie
// zapisywal/dopisywal .xlsx.
//
// SheetJS nie ma prawdziwego "append" - kazde wywolanie to read-modify-write
// calego pliku (odczyt istniejacego arkusza -> dopisanie wiersza w pamieci ->
// zapis calosci z powrotem). Akceptowalne przy realnych rozmiarach tych
// tabelek (dziesiatki/setki wierszy, nie tysiace).
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function validatePath(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('Nie podano ścieżki do pliku Excel.');
  if (!/\.xlsx$/i.test(filePath)) throw new Error('Ścieżka do tabelki musi kończyć się na .xlsx.');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) throw new Error(`Folder nie istnieje: ${dir}`);
}

// Dopisuje JEDEN wiersz do arkusza pod `filePath`. `columns` to uporzadkowana
// lista kluczy kolumn (patrz fieldExtraction.js COLUMN_ORDER/COLUMN_LABELS),
// `rowValues` to obiekt { [columnKey]: wartosc }.
function appendRow(filePath, columns, columnLabels, rowValues) {
  validatePath(filePath);
  const headerRow = columns.map((key) => columnLabels[key] || key);
  const dataRow = columns.map((key) => rowValues[key] ?? '');

  let rows;
  if (fs.existsSync(filePath)) {
    const wb = XLSX.readFile(filePath);
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('Wskazany plik Excel nie ma żadnego arkusza.');
    const sheet = wb.Sheets[sheetName];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    if (!rows.length) {
      rows = [headerRow];
    } else {
      const existingHeader = rows[0].map((c) => String(c ?? '').trim());
      const expectedHeader = headerRow.map((c) => String(c).trim());
      const matches = existingHeader.length === expectedHeader.length && existingHeader.every((c, i) => c === expectedHeader[i]);
      if (!matches) {
        throw new Error('Wskazany plik Excel ma inny układ kolumn niż oczekiwany - wybierz inny plik albo pustą tabelkę.');
      }
    }
    rows.push(dataRow);
  } else {
    rows = [headerRow, dataRow];
  }

  const newSheet = XLSX.utils.aoa_to_sheet(rows);
  const newWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newSheet, 'Audyty');
  XLSX.writeFile(newWb, filePath);
  return { rowNumber: rows.length - 1 };
}

module.exports = { appendRow, validatePath };
