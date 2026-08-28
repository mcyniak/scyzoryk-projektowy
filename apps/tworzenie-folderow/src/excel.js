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

// Drugi tryb ("same foldery z adresow"): lekki odczyt WSZYSTKICH arkuszy
// jako list adresow - bez klasyfikacji pompy/kolektory/kotly. W kazdym
// arkuszu szukamy wiersza naglowka (pierwsze 10 wierszy) z komorka "Adres"
// i zbieramy wartosci tej kolumny. Arkusz bez naglowka "Adres" dostaje
// headerFound=false (UI nie pozwoli go wybrac).
async function readAddressSheets(filePath) {
  const wszystkieArkusze = await readXlsxFile(filePath, { getSheets: true });
  return wszystkieArkusze.map((arkusz) => {
    const sheetName = String(arkusz.sheet || '').trim();
    const rows = Array.isArray(arkusz.data) ? arkusz.data.filter(r => Array.isArray(r)) : [];
    let headerIdx = -1;
    let addrCol = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const idx = rows[i].findIndex(c => typeof c === 'string' && c.trim().toLowerCase() === 'adres');
      if (idx >= 0) { headerIdx = i; addrCol = idx; break; }
    }
    const addresses = [];
    if (addrCol >= 0) {
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const value = rows[i][addrCol];
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text) addresses.push(text);
      }
    }
    return { sheetName, addresses, headerFound: addrCol >= 0 };
  });
}

module.exports = {
  readTabelaAdresowa,
  readAddressSheets,
  classifySheetType,
  isAirSourcePump,
  isGroundSourcePump,
  normalizeHeader
};
