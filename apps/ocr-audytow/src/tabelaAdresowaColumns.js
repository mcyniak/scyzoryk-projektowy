// Mapowanie wyciagnietych pol (fieldExtraction.js) na REALNE naglowki kolumn z
// wzorcow wlasciciela ("1/2/3.wzor-tabela adresowa {PC,SOLARY,KOTLY}.xlsx") - 2026-07-23.
//
// Eksport (2026-07-24, patrz excelExport.js#writeFamilyTemplateRows) KLONUJE prawdziwy
// wzor (assets/templates/*.xlsx - puste struktury, bez danych klientow, bezpieczne w
// repo) i wpisuje wartosci w jego wlasne komorki - wygenerowany plik wyglada wizualnie
// jak wzor (czcionki/kolory/obramowania), nie jest juz osobnym golym plikiem do recznego
// przepisywania. `label` sluzy jednoczesnie jako klucz kolumny I naglowek - musi byc
// IDENTYCZNY tekst jak w `templateFile` (writeFamilyTemplateRows dopasowuje po tresci
// naglowka wzoru, nie po pozycji), zeby wartosci trafily w wlasciwa kolumne.
//
// `fieldKey: null` = kolumna biurowa/przypisywana przez gmine PO audycie (LP, REZYGNACJA,
// numer protokolu, Numer dzialki, Rodzaj/Model/Moc dobrana pompy, Audyt/Zdjecia/Rys./PT/
// Uwagi itp.) - NIE pochodzi z protokolu audytu, zostaje pusta do recznego uzupelnienia.
// Wyjatek "Demontaz" (PC) - TECHNICZNIE jest na protokole (sekcja 13, Tak/Nie), ale
// zweryfikowane bezposrednio na realnym pliku (2026-07-24): to pole to goly checkbox
// "Tak"/"Nie" bez zadnego wlasnego tekstu etykiety w danych z Document AI, a ten sam
// wzorzec "Tak"/"Nie" powtarza sie ~10x na tej samej stronie (sekcje 14-21) - dopasowanie
// po samym tekscie checkboxa cicho zlapaloby PRZYPADKOWA odpowiedz z innego pytania.
// Zostawione null celowo (bezpieczniej recznie, niz cicho zle) - do naprawy dopiero przez
// dopasowanie pozycyjne (najblizszy checkbox geometrycznie do slowa "Demontaz"), nie
// zrobione jeszcze.
// `fieldKey: '__adres'` = specjalny klucz rozwiazywany przez wolajacego (server.js) na
// etykiete bloku (ta sama wartosc co kolumna "adres" w dotychczasowym, ogolnym eksporcie),
// NIE na OCR'owane `adresInstalacji` - etykieta bloku jest kontrolowana przez uzytkownika
// (krok 2 przegladu), wiec bardziej niezawodna niz czesto "zlepione" pole z formularza.

const path = require('path');
const TEMPLATES_DIR = path.join(__dirname, '..', 'assets', 'templates');

const TABELA_FAMILIES = {
  pc: {
    sheetName: 'Pompy ciepła',
    templateFile: path.join(TEMPLATES_DIR, 'wzor-tabela-adresowa-pc.xlsx'),
    columns: [
      { label: 'LP', fieldKey: null },
      { label: 'REZYGNACJA', fieldKey: null },
      { label: 'Imię i Nazwisko', fieldKey: 'imieNazwisko' },
      { label: 'Adres', fieldKey: '__adres' },
      { label: 'Numer telefonu', fieldKey: 'telefon' },
      { label: 'Obręb', fieldKey: null },
      { label: 'Numer działki', fieldKey: null },
      { label: 'Rodzaj pompy', fieldKey: 'rodzajPompy' },
      { label: 'Moc pompy z gminy', fieldKey: 'mocPompyZGminy' },
      { label: 'Model pompy', fieldKey: null },
      { label: 'Moc dobrana', fieldKey: null },
      { label: 'Ilość odwiertów', fieldKey: null },
      { label: 'Wysokość kotłowni (m)', fieldKey: 'wysokoscKotlowniPC' },
      { label: 'Źródło ciepła', fieldKey: 'zrodloCiepla' },
      { label: 'Demontaż', fieldKey: 'demontaz' },
      { label: 'Udział ogrzew. grzejnik.', fieldKey: 'udzialGrzejnikowy' },
      // Zywa formula w prawdziwym wzorze (=100-P{wiersz}, patrz excelExport.js) -
      // Excel sam to policzy z kolumny obok, nie pytamy o to osobno (i tak
      // zostalby zignorowane przy zapisie, zeby nie zepsuc formuly).
      { label: 'Udział ogrzew. podłog.', fieldKey: null },
      { label: 'Rok budowy', fieldKey: 'rokBudowy' },
      { label: 'Powierzchnia', fieldKey: 'powierzchnia' },
      { label: 'Ociepl. fund.', fieldKey: 'izolacjaScianyFundamentowej' },
      { label: 'Ociepl. ścian', fieldKey: 'ocieplenieScianyZewn' },
      { label: 'Ociepl. dach/strop', fieldKey: 'izolacjaDachu' },
      { label: 'Audyt', fieldKey: null },
      { label: 'Zdjęcia', fieldKey: null },
      { label: 'OZC', fieldKey: null },
      { label: 'Audytor', fieldKey: null },
      { label: 'Rys.', fieldKey: null },
      { label: 'PT', fieldKey: null },
      { label: 'Druk PT', fieldKey: null },
      { label: 'Uwagi do audytów', fieldKey: null },
      { label: 'UWAGI', fieldKey: null }
    ]
  },
  solary: {
    sheetName: 'Solary',
    templateFile: path.join(TEMPLATES_DIR, 'wzor-tabela-adresowa-solary.xlsx'),
    columns: [
      { label: 'LP', fieldKey: null },
      { label: 'REZYGNACJA', fieldKey: null },
      { label: 'Nr prot. uzgod. montaż.', fieldKey: null },
      { label: 'Imię i Nazwisko', fieldKey: 'imieNazwisko' },
      { label: 'Adres', fieldKey: '__adres' },
      { label: 'Numer telefonu', fieldKey: 'telefon' },
      { label: 'Numer działki', fieldKey: null },
      { label: 'Rodzaj zestawu', fieldKey: 'solaryRodzajZestawu' },
      { label: 'Typ budynku', fieldKey: 'solaryTypBudynku' },
      { label: 'Typ konstrukcji', fieldKey: 'solaryTypKonstrukcji' },
      { label: 'Miejsce montażu', fieldKey: 'solaryMiejsceMontazu' },
      { label: 'Pokrycie dachu', fieldKey: 'solaryPokrycieDachu' },
      { label: 'Rok  budowy', fieldKey: 'rokBudowy' },
      { label: 'Liczba mieszkańców', fieldKey: 'liczbaOsob' },
      { label: 'Wysokość kotłowni', fieldKey: 'solaryWysokoscKotlowni' },
      { label: 'Audyt', fieldKey: null },
      { label: 'Zdjęcia', fieldKey: null },
      { label: 'Rys.', fieldKey: null },
      { label: 'PT', fieldKey: null },
      { label: 'Druk PT', fieldKey: null },
      { label: 'Uwagi z audytów', fieldKey: null },
      { label: 'Uwagi', fieldKey: null }
    ]
  },
  kotly: {
    sheetName: 'Kotły',
    templateFile: path.join(TEMPLATES_DIR, 'wzor-tabela-adresowa-kotly.xlsx'),
    columns: [
      { label: 'LP', fieldKey: null },
      { label: 'REZYGNACJA', fieldKey: null },
      { label: 'Nr prot. uzgod. montaż.', fieldKey: null },
      { label: 'Imię i Nazwisko', fieldKey: 'imieNazwisko' },
      { label: 'Adres', fieldKey: '__adres' },
      { label: 'Numer telefonu', fieldKey: 'telefon' },
      { label: 'Numer działki', fieldKey: null },
      { label: 'Moc istniejącego kotła', fieldKey: 'kotlyMocIstniejacegoZrodla' },
      { label: 'Rok budowy', fieldKey: 'rokBudowy' },
      { label: 'Powierzchnia', fieldKey: 'powierzchnia' },
      { label: 'Liczba mieszkańców', fieldKey: 'liczbaOsob' },
      { label: 'Moc kotła', fieldKey: 'kotlyMocKotla' },
      { label: 'Zasobnik c.w.u.', fieldKey: 'kotlyZasobnikCwu' },
      { label: 'Audyt', fieldKey: null },
      { label: 'Zdjęcia', fieldKey: null },
      { label: 'Rys.', fieldKey: null },
      { label: 'PT', fieldKey: null },
      { label: 'Druk PT', fieldKey: null },
      { label: 'Uwagi z audytów', fieldKey: null },
      { label: 'Uwagi', fieldKey: null }
    ]
  }
};

function buildRowValues(family, fields, addressLabel) {
  const def = TABELA_FAMILIES[family];
  if (!def) throw new Error(`Nieznana rodzina protokołu: ${family}`);
  const rowValues = {};
  for (const col of def.columns) {
    if (col.fieldKey === null) rowValues[col.label] = '';
    else if (col.fieldKey === '__adres') rowValues[col.label] = addressLabel || '';
    else rowValues[col.label] = fields[col.fieldKey]?.value || '';
  }
  return rowValues;
}

// Zbior kluczy FIELD_DEFS faktycznie potrzebnych tej rodzinie (bez '__adres' -
// to nie klucz FIELD_DEFS, rozwiazywany osobno przez buildRowValues) - uzywane
// do zawezenia ekstrakcji/przegladu TYLKO do pol, ktore realnie trafiaja do
// tabelki adresowej tej rodziny (patrz plan "wybor rodziny przed ekstrakcja",
// 2026-07-23 - wlasciciel: "np. ladowalismy takie rzeczy jak rodzaj dachu"
// [pole spoza zakresu tabelki adresowej PC, zbedne przy tym celu]).
function allowedKeysForFamily(family) {
  const def = TABELA_FAMILIES[family];
  if (!def) return null;
  return new Set(def.columns.map((c) => c.fieldKey).filter((k) => k && k !== '__adres'));
}

module.exports = { TABELA_FAMILIES, buildRowValues, allowedKeysForFamily };
