// Czytnik tabeli adresowej dla tworzenie-folderow. Odczyt pliku
// (`read-excel-file`) zostaje tutaj (kazda apka ma wlasne node_modules), ale
// klasyfikacja arkuszy/wierszy jest wspoldzielona z apps/pipeline przez
// lib/investmentAddressTable.js (wydzielone 2026-08-20, Faza 1 planu
// "Pipeline inwestycji" - zero zmiany zachowania tutaj, ten sam kod co
// wczesniej, tylko rozdzielony na "odczyt pliku" i "klasyfikacja" tak, zeby
// klasyfikacja mogla zyc bez zaleznosci npm w lib/, patrz komentarz tam).
//
// Audyt 2026-08-20: zamieniono "xlsx" (SheetJS 0.18.5, CVE-2023-30533
// prototype pollution + CVE-2024-22363 ReDoS przy CZYTANIU spreparowanego
// arkusza, bez naprawionej wersji w rejestrze npm) na "read-excel-file" -
// ten sam parser, ktory juz bezpiecznie dziala w karty-katalogowe i
// dokumenty-seryjne. Odczyt jest ASYNC (Promise).
const readXlsxFile = require('read-excel-file/node');
const {
  buildTabelaAdresowa,
  classifySheetType,
  isAirSourcePump,
  isGroundSourcePump,
  normalizeHeader
} = require('../../../lib/investmentAddressTable');

async function readTabelaAdresowa(filePath) {
  const wszystkieArkusze = await readXlsxFile(filePath, { getSheets: true });
  return buildTabelaAdresowa(wszystkieArkusze);
}

module.exports = {
  readTabelaAdresowa,
  classifySheetType,
  isAirSourcePump,
  isGroundSourcePump,
  normalizeHeader
};
