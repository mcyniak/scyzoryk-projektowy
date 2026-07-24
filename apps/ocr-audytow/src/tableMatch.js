// Dopasowywanie do tabel Document AI (document.pages[].tables[]) - trzecie
// (obok tabel/formFields), a w praktyce CZESTO NAJLEPSZE zrodlo dla list
// opcji checkboxowych (material sciany/dachu/stropu itd.) - kazdy wiersz
// tabeli to JEDEN, juz poprawnie zgrupowany string (checkbox+etykieta+
// wartosc razem, we wlasciwej kolejnosci), zweryfikowane na realnym pliku
// (Kazimierz Biskupi) - "☑ Cegła dziurawka, grubość: 25 .cm" w JEDNYM
// wierszu, zero przemieszania w odroznieniu od plaskiej listy tokenow.
//
// UWAGA - zweryfikowane na realnych plikach 2026-07-22: NIE kazda sekcja
// formularza wychodzi jako tabela (Kotly'ego "Moc kotla" nie wyszlo wcale;
// Solary'ego sekcja 7/8 wyszla jako tabela, ale ze sklejonymi wieloma
// pytaniami w jednym wierszu) - to jedno z KILKU probowanych zrodel
// (fieldExtraction.js probuje tabele -> formFields -> tokeny po kolei), nie
// uniwersalne rozwiazanie samo w sobie.
const { CHECKBOX_CHECKED, CHECKBOX_UNCHECKED, verticesToRect } = require('./textMatch');

// Odpowiednik dla grup opcji material/checkbox rozlozonych na WIELE wierszy
// jednej tabeli (np. "material sciany zewnetrznej: Cegla/Bloczki/Pustak/...").
// Kazda opcja ma wlasny `pattern` (dopasowywany do calego tekstu wiersza).
// Sprawdza "zaznaczone" przez (1) glif ☑ w wierszu, (2) gdy ANI ☑ ANI ☐ nie
// wystapilo w wierszu, ale wiersz zawiera PRAWDZIWA, wypelniona liczbe -
// zweryfikowane na realnym pliku (Kazimierz Biskupi): "Wełna mineralna,
// grubość: 10 cm" nie mial ZADNEGO glifu checkboxa w OCR (Document AI go nie
// wykryl), ale mial realna, odrecznie wpisana wartosc "10" - podczas gdy
// wszystkie INNE opcje w tej samej liscie byly jednoznacznie niezaznaczone
// (☐, bez wartosci) - to samo w sobie jest silnym sygnalem, ze TA opcja
// zostala wybrana. Zwraca ten sam ksztalt co findCheckedFormFieldOption
// (option/ambiguous/rowText/numericValue) dla spojnosci w fieldExtraction.js.
function findCheckedTableRow(tables, options) {
  let anyOptionTextFound = false;
  const checkedMatches = [];
  for (const option of options) {
    for (const table of tables || []) {
      let matchedRow = null;
      for (const row of table.rows || []) {
        if (option.pattern.test(row.text.toUpperCase())) { matchedRow = row; break; }
      }
      if (!matchedRow) continue;
      anyOptionTextFound = true;
      const numMatch = matchedRow.text.match(/(^|[^\p{L}])(\d+[.,]?\d*)/u);
      const hasRealValue = Boolean(numMatch);
      let checked = CHECKBOX_CHECKED.test(matchedRow.text);
      if (!checked && !CHECKBOX_UNCHECKED.test(matchedRow.text) && hasRealValue) checked = true;
      if (checked) {
        checkedMatches.push({ option, row: matchedRow, numericValue: numMatch ? numMatch[2] : null });
        break;
      }
    }
  }
  if (checkedMatches.length === 1) {
    const m = checkedMatches[0];
    return { option: m.option, numericValue: m.numericValue, bbox: verticesToRect(m.row.bbox) };
  }
  if (checkedMatches.length > 1) {
    return { option: null, ambiguous: true, conflictLabels: checkedMatches.map((m) => m.option.label) };
  }
  return anyOptionTextFound ? { option: null } : null;
}

module.exports = { findCheckedTableRow };
