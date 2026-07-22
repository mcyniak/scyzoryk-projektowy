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

// Dopisuje JEDEN wiersz do arkusza `sheetName` w pliku pod `filePath`. `columns`
// to uporzadkowana lista kluczy kolumn, `columnLabels` mapuje klucz na naglowek,
// `rowValues` to obiekt { [columnKey]: wartosc }.
//
// Realne pliki wlasciciela to JEDEN workbook z KILKOMA arkuszami (Pompy ciepła/
// Solary/Kotly) - poprzednia wersja tej funkcji zawsze budowala CALKOWICIE NOWY
// workbook z jednym arkuszem "Audyty" i nadpisywala nim caly plik, co
// SKASOWALOBY pozostale arkusze przy dopisywaniu do ktoregokolwiek z nich.
// Teraz: gdy plik istnieje, wczytujemy caly workbook i modyfikujemy/dodajemy
// TYLKO wskazany arkusz, zapisujac z powrotem WSZYSTKIE arkusze.
function appendRow(filePath, sheetName, columns, columnLabels, rowValues) {
  validatePath(filePath);
  if (!sheetName) throw new Error('Nie podano nazwy arkusza do dopisania wiersza.');
  const headerRow = columns.map((key) => columnLabels[key] || key);
  const dataRow = columns.map((key) => rowValues[key] ?? '');

  let wb;
  let targetSheetName;
  if (fs.existsSync(filePath)) {
    wb = XLSX.readFile(filePath);
    targetSheetName = wb.SheetNames.find((n) => n.toLowerCase() === sheetName.toLowerCase());
  } else {
    wb = XLSX.utils.book_new();
  }

  let rows;
  if (targetSheetName) {
    const sheet = wb.Sheets[targetSheetName];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    if (!rows.length) {
      rows = [headerRow];
    } else {
      const existingHeader = rows[0].map((c) => String(c ?? '').trim());
      const expectedHeader = headerRow.map((c) => String(c).trim());
      const matches = existingHeader.length === expectedHeader.length && existingHeader.every((c, i) => c === expectedHeader[i]);
      if (!matches) {
        throw new Error(`Arkusz "${sheetName}" we wskazanym pliku ma inny układ kolumn niż oczekiwany - wybierz inny plik/arkusz.`);
      }
    }
    rows.push(dataRow);
    wb.Sheets[targetSheetName] = XLSX.utils.aoa_to_sheet(rows);
  } else {
    // Arkusz o tej nazwie jeszcze nie istnieje w pliku - dodajemy go, nie
    // ruszajac zadnego z istniejacych arkuszy.
    rows = [headerRow, dataRow];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }

  XLSX.writeFile(wb, filePath);
  return { rowNumber: rows.length - 1 };
}

module.exports = { appendRow, validatePath };
