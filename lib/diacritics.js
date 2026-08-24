// Wspolna transliteracja tekstu do ASCII - uzywana wszedzie tam, gdzie
// z nazwy pliku/naglowka musza zniknac polskie znaki diakrytyczne.
//
// KLUCZOWY szczegol: "l" (U+0142) NIE rozklada sie pod normalizacja
// Unicode NFD/NFKD tak jak ą/ę/ć/ń/ś/ź/ż (te znikaja same po usunieciu
// znakow laczących), dlatego trzeba ja zamienic JAWNIE, PRZED normalize().
// Bez tego "Działka" wychodzilo jako "dzia_ka"/"dzia ka" zamiast "dzialka".
// To jest ten sam wzorzec, ktory dziala w apps/drukarka-projekty/src/folderMatch.js.
function toAsciiSafe(value) {
  return String(value || '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

module.exports = { toAsciiSafe };
