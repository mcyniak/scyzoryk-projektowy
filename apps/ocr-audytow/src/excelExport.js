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
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

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
function writeFreshRows(filePath, sheetName, columns, columnLabels, rowValuesList) {
  validatePath(filePath);
  if (!sheetName) throw new Error('Nie podano nazwy arkusza.');
  const headerRow = columns.map((key) => columnLabels[key] || key);
  const dataRows = rowValuesList.map((rowValues) => columns.map((key) => rowValues[key] ?? ''));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]), sheetName);
  XLSX.writeFile(wb, filePath);
  return { rowCount: dataRows.length };
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

  await workbook.xlsx.writeFile(outputPath);
  return { rowCount: rowValuesList.length };
}

module.exports = { writeFreshRows, writeFamilyTemplateRows, validatePath };
