// Buduje kopie ORYGINALNEGO pliku Excel, z ktorej usunieto adresy NIE
// zaznaczone przez uzytkownika w podgladzie Pipeline'u (krok 1 UI) - jedyny
// sposob na "wybranie czesci adresow" dla apek, ktore same nie maja
// wlasnego wsparcia dla zaznaczania wierszy (karty-katalogowe,
// tworzenie-folderow) i zeby uniknac zgadywania, czy WLASNE numerowanie
// wierszy tych apek (kazda parsuje plik od nowa, wlasnym kodem) pokrywa sie
// z numeracja tego modulu - zamiast tego kazda apka i tak dostaje caly
// plik, tylko z fizycznie usunietymi wierszami.
//
// Uzywa ExcelJS (juz uzywany w apps/ocr-audytow do tego samego -
// odczyt+zapis .xlsx) zamiast "xlsx"/SheetJS - patrz audyt 2026-08-20 w
// CLAUDE.md o CVE w SheetJS przy CZYTANIU spreparowanego pliku; tutaj
// zrodlo to plik juz raz wgrany przez uzytkownika w tym samym przebiegu,
// wiec ryzyko jest analogiczne do reszty apki, ale trzymamy sie jednego,
// juz zaakceptowanego w repo silnika do zapisu .xlsx.
const ExcelJS = require('exceljs');

// keepBySheet: Map<sheetName, { headerRowIndex, keepRowIndexes: number[] }>
// - indeksy 0-based, DOKLADNIE tej samej konwencji co
// lib/investmentAddressTable.js#readSheet (rowIndex na kazdym rekordzie,
// headerRowIndex na kazdym arkuszu) - i to samo `rows` (0-based) co
// read-excel-file zwraca. Arkusze NIEwymienione w keepBySheet zostaja
// skopiowane bez zadnej zmiany (np. inne, nierozpoznane zakladki w pliku).
async function buildFilteredWorkbookFile({ sourcePath, outputPath, keepBySheet }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);

  for (const [sheetName, { headerRowIndex, keepRowIndexes }] of keepBySheet.entries()) {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) continue;
    const keep = new Set(keepRowIndexes);
    // Od najnizszego wiersza w gore - spliceRows dziala na BIEZACYCH numerach
    // wierszy arkusza, wiec usuwanie od gory przesuneloby numeracje
    // wszystkich ponizej i popsulo dalsze porownania z `keep`.
    for (let i = worksheet.rowCount - 1; i > headerRowIndex; i -= 1) {
      if (!keep.has(i)) worksheet.spliceRows(i + 1, 1);
    }
  }

  await workbook.xlsx.writeFile(outputPath);
}

module.exports = { buildFilteredWorkbookFile };
