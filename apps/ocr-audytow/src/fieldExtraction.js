// Wyciaganie pol formularza - PRZEPISANE OD PODSTAW 2026-07-22 dla Google
// Document AI (poprzednia wersja byla zbudowana dla Vision - sekwencyjne
// dopasowywanie slow w plaskiej liscie `ocrWords`; po migracji na Document AI
// okazalo sie, ze ten silnik ma WLASNA, inna przemieszana kolejnosc tokenow
// na gestych formularzach, wiec "portowanie" starej logiki nie dzialalo
// dobrze - wymagaloby przestrojenia niemal kazdego pola pod nowy silnik i tak
// samo krucha logike). Zamiast tego, ekstrakcja korzysta z trzech
// ustrukturyzowanych zrodel Document AI, w tej kolejnosci:
//   1. tabele (document.pages[].tables) - dla list opcji checkboxowych
//      (material sciany/dachu/stropu itd.) - kazdy wiersz to JEDEN, juz
//      poprawnie zgrupowany string (checkbox+etykieta+wartosc razem) -
//      zweryfikowane na realnym pliku: zero przemieszania w tych wierszach.
//   2. formFields (document.pages[].formFields) - proste pary etykieta:
//      wartosc (imie i nazwisko, telefon, rok budowy...) + checkboxy, ktore
//      NIE wyszly jako tabela.
//   3. tokeny (ocrWords) - NIE sa tu juz uzywane do dopasowywania (patrz
//      textMatch.js) - zostaja tylko jako dane dla
//      bundleSplit.js/buildOcrPdf, ktore i tak potrzebuja
//      plaskiej listy slow niezaleznie od tego modulu.
//
// Zakres pol swiadomie ZAWEZONY (2026-07-22, na wyrazna prosbe wlasciciela)
// do tego, co REALNIE potrzebne: lista OZC dla pompy ciepla powietrznej
// (potwierdzona zaznaczonymi zdjeciami rzeczywistego formularza) + kolumny
// tabelek adresowych Kotly/Solary (`2/3.wzor-tabela adresowa`) - NIE caly
// dawny, wyczerpujacy zestaw ~90 kolumn zbudowany "na wszelki wypadek" pod
// Vision (strona 2 formularza Pompy ciepla poza juz wymienionymi polami,
// warianty Rzgow/Rychwal itd. - wszystko to swiadomie pominiete, wraca tylko
// jesli wlasciciel jawnie potwierdzi konkretna potrzebe).
const { findFormField, findCheckedFormFieldOption } = require('./formFieldMatch');
const { findCheckedTableRow } = require('./tableMatch');

const COMPOSITE_CONFIDENCE_CAP = 0.5; // ponizej progu 0.7 - zawsze trafia do przegladu, chyba ze rozpoznanie bylo wyjatkowo pewne
const LOW_CONFIDENCE_THRESHOLD = 0.7;

// --- Filtr sensownosci + bezpieczny wynik koncowy - engine-agnostyczne,
// przeniesione bez zmian z poprzedniej wersji (Vision) - to juz dobry,
// niezalezny od zrodla danych mechanizm bezpieczenstwa. ---------------------

// - Pola liczbowe: cyfra NIEPRZYKLEJONA do litery przed nia (odrzuca np.
//   "..m2" dla niewypelnionego pola, gdzie jedyna "cyfra" to '2' z jednostki
//   "m2"), i nie dwie osobne "gole" liczby na raz (np. "40 0" to zwykle dwa
//   kolidujace odczyty, nie jedna wartosc).
// - Pola tekstowe: stosunek samoglosek do liter - realne slowo ma naturalna
//   proporcje, przypadkowy belkot OCR ma jej brak.
const POLISH_VOWELS = /[aeiouyąęó]/gi;
function looksPlausible(text, valueKind) {
  const trimmed = (text || '').trim();
  if (!trimmed) return true; // puste to inna sprawa - needsReview i tak zadziala
  if (valueKind === 'numeric' || valueKind === 'percent') {
    if (!/(^|[^\p{L}])\d/u.test(trimmed)) return false;
    const bareNumberTokens = trimmed.split(/\s+/).filter((t) => /^\d+$/.test(t));
    if (bareNumberTokens.length >= 2) return false;
    return true;
  }
  // Imiona/nazwiska - realny artefakt zlapany 2026-07-24: OCR czasem dokleja
  // przypadkowa cyfre z sasiedztwa (numer domu, rok) do imienia/nazwiska -
  // w odroznieniu od zwyklego pola tekstowego, tu cyfra ZAWSZE jest bledem,
  // nigdy legalna czescia wartosci.
  if (valueKind === 'name' && /\d/.test(trimmed)) return false;
  const letters = trimmed.replace(/[^a-ząćęłńóśźżA-ZĄĆĘŁŃÓŚŹŻ]/g, '');
  if (letters.length < 3) return true; // zbyt krotkie by ocenic sensownie, nie blokuj
  const vowelCount = (letters.match(POLISH_VOWELS) || []).length;
  return vowelCount / letters.length >= 0.15;
}

// Procent (0-100) czasem przychodzi z OCR z doczepionym znakiem "%" albo
// przypadkowa kropka na brzegu (np. "70%", ".70", "70.") - wyciaga SAMA
// liczbe zamiast oddawac caly zlepiony tekst jako wartosc. Zwraca '' (nie
// oryginalny tekst), jesli nie da sie jednoznacznie wydzielic liczby 0-100 -
// needsReview zadziala normalnie zamiast zapisywac cos w rodzaju "70%" wprost
// do tabelki.
function cleanPercentValue(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const m = trimmed.match(/(\d{1,3})(?:[.,](\d+))?/);
  if (!m) return '';
  const num = Number(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  if (!Number.isFinite(num) || num < 0 || num > 100) return '';
  return m[2] ? `${m[1]},${m[2]}` : m[1];
}

// found:false = etykieta/checkbox NIE wystapila w ogole w tym dokumencie -
// pole strukturalnie nie dotyczy tego formularza, wiec NIE trafia do
// recznego przegladu (needsReview:false, resolved:true od razu, puste w
// Excelu) - odroznione od found:true+value:'' (etykieta istnieje, ale nic
// nie zaznaczono/nie udalo sie odczytac - TO jest prawdziwy przypadek do
// przegladu).
function toFieldResult(extracted, pageIndex, valueKind) {
  if (!extracted || !extracted.found) {
    return { value: '', confidence: null, pageIndex, labelBBox: null, valueBBox: null, needsReview: false, resolved: true };
  }
  let value = extracted.value || '';
  if (value && !looksPlausible(value, valueKind)) value = '';
  const needsReview = !value || extracted.confidence === null || extracted.confidence < LOW_CONFIDENCE_THRESHOLD;
  return {
    value,
    confidence: extracted.confidence,
    pageIndex,
    labelBBox: extracted.labelBBox || null,
    valueBBox: extracted.valueBBox || extracted.labelBBox || null,
    needsReview,
    resolved: !needsReview
  };
}

// --- Ekstrakcja pojedynczego pola z JEDNEJ strony - probuje tabele, potem
// formFields, w tej kolejnosci (patrz komentarz na gorze pliku). ------------

// UWAGA, realne odkrycie 2026-07-22: Document AI czasem NIE tworzy formField
// dla etykiety, ktora FIZYCZNIE jest na stronie (np. "Adres miejsca
// instalacji"/"Liczba osob w gospodarstwie" na realnym pliku Kazimierz
// Biskupi - nigdzie w formFields, mimo ze to normalne pole formularza) - to
// jest ROZNE od "ta etykieta strukturalnie nie wystepuje na tym wariancie
// formularza" (np. pole specyficzne dla Kotlow na dokumencie Solary). Bez
// tego rozroznienia, brak formField bylby mylnie traktowany jak "nie
// dotyczy" (found:false, cicho pomijane) zamiast "istnieje, ale nie udalo
// sie wyciagnac" (found:true+puste, do recznego przegladu) - a to WLASNIE
// prawdziwy przypadek do przegladu. Sprawdzamy wiec SUROWY tekst calej
// strony (ocrText) jako sygnal istnienia, niezaleznie od tego czy Document
// AI poprawnie sparowal formField/tabele.
// UWAGA: wiele wzorcow pol jest CELOWO zakotwiczone (^...$) do dopasowania
// CALEGO, krotkiego fieldName (np. "Brak" checkboxa) - taka kotwica jest
// bezuzyteczna przy teście istnienia na CALYM, splaszczonym tekscie strony
// (dopasowalaby tylko gdyby te 4 litery byly doslownie CALA zawartoscia
// strony). Usuwamy kotwice brzegowe przed tym testem - tu chodzi tylko o
// "czy ten ciag znakow WYSTEPUJE gdziekolwiek", nie o dokladne dopasowanie.
function flattenText(text) {
  return (text || '').replace(/\s+/g, ' ').toUpperCase();
}

function existsInPageText(page, pattern) {
  const flat = flattenText(page.ocrText);
  const source = pattern.source.replace(/^\^/, '').replace(/\$$/, '');
  return new RegExp(source, pattern.flags).test(flat);
}

// Niektore wartosci formField zawieraja wlasny naglowek sekcji jako prefiks
// (np. "I. Drzwi zewnętrzne:\n2025" zamiast samego "2025") - zweryfikowane
// na realnym pliku (Kazimierz Biskupi) - usuwa taki prefiks "X. Slowa:" na
// poczatku wartosci, jesli wystapi.
function stripHeaderPrefix(value) {
  // Sekcje formularza sa numerowane albo literami ("I. Drzwi zewnętrzne:"), albo
  // cyframi ("2. Ogólna charakterystyka budynku:") - realny blad zlapany 2026-07-23
  // (rokBudowy bledzil "2. Ogólna charakterystyka budynku: 2006" zamiast "2006"),
  // bo poprzedni wzorzec akceptowal TYLKO litere przed kropka.
  return value.replace(/^[A-ZĄĆĘŁŃÓŚŹŻ0-9]+\.\s*[\p{L}\s]+:\s*/u, '').trim();
}

// "Liczba osob mieszkajacych w budynku:" bierze wartosc SASIEDNIEGO pola
// "Telefon:" jako wlasna - zweryfikowane na DWOCH realnych plikach (Kotly,
// Solary): oba mialy identyczny wzorzec "661-465-353\nE" / "730-269323\n
// Telefon:" (numer telefonu + resztki). Document AI czasem pomyli granice
// wartosci miedzy sasiednimi polami na gestym naglowku formularza - usuwamy
// wzorzec numeru telefonu (i slowo "Telefon:" jesli zostalo), zeby nie
// pokazywac go jako (bledna) podpowiedz. Uzywane TYLKO dla pol, ktore z
// natury NIE moga byc numerem telefonu (np. liczbaOsob), nie globalnie.
function stripPhoneBleed(value) {
  return value
    .replace(/\d{3}[-.\s]?\d{3}[-.\s]?\d{3}/g, '')
    .replace(/TELEFON:?/gi, '')
    .trim();
}

// Zweryfikowane na realnych plikach (Kazimierz Biskupi, bloki 1-2, w
// odroznieniu od bloku 0 gdzie to samo pole wyszlo czysto) - Document AI
// czasem laczy CALY, gesty naglowek strony (imie i nazwisko + adres +
// telefon + e-mail) w JEDNA wartosc formField, z etykietami INNYCH pol
// wtracone w srodku tekstu (np. "...62-630 Imię i nazwisko Uczestnika
// projektu/ Właściciela: Skendelski Golińska 34..."). Obcina wartosc na
// PIERWSZYM wystapieniu ktoregokolwiek z tych znanych, "obcych" markerow -
// pomaga w wiekszosci przypadkow (gdzie prawdziwa tresc jest PRZED
// wtraceniem), choc NIE naprawia przypadkow gdzie prawdziwa tresc jest PO
// wtraceniu (tam i tak trafia do recznego przegladu, wiec nie jest to
// pogorszenie, tylko czesciowa, nie pelna poprawa).
const OTHER_LABEL_MARKERS = [/TELEFON:?/i, /E-?MAIL:?/i, /ADRES\s+MIEJSCA\s+INSTALACJI/i, /IMI[ĘE]\s+I\s+NAZWISKO/i, /POCZTOWY\)?:?/i];
function truncateAtOtherLabel(value) {
  let cut = value.length;
  for (const marker of OTHER_LABEL_MARKERS) {
    const m = value.match(marker);
    if (m && m.index < cut) cut = m.index;
  }
  return value.slice(0, cut).trim();
}

// Niektore sekcje formularza maja WLASNA, wewnetrzna etykiete WEWNATRZ wartosci
// SZERSZEGO, ogolniejszego pola - np. "4. Planowane miejsce na bufor:" na realnym
// pliku PC ma jedna, zlepiona wartosc obejmujaca zarowno opis miejsca (odrecznie
// "Kotlownia") JAK I "Wysokość pomieszczenia: 2,70m" w tym samym tekscie (Document AI
// nie wydzielilo drugiej etykiety jako osobnego formField). `extractAfterLabel` wycina
// TYLKO to, co jest PO takiej wewnetrznej etykiecie, zamiast oddawac caly zlepiony
// tekst jako wartosc. Zwraca null (nie pusty string), jesli etykieta w ogole nie
// wystapila w wartosci - odrozniane od "wystapila, ale nic po niej nie ma".
function extractAfterLabel(value, labelPattern) {
  const m = String(value || '').match(labelPattern);
  return m && m[1] ? m[1].trim() : null;
}

function extractTextField(page, def) {
  if (def.formFieldPattern) {
    const ff = findFormField(page.formFields, def.formFieldPattern, def.valuePattern);
    if (ff && ff.value) {
      let value = ff.value;
      if (def.extractAfterLabel) value = extractAfterLabel(value, def.extractAfterLabel) || '';
      if (def.stripHeaderPrefix) value = stripHeaderPrefix(value);
      if (def.stripPhoneBleed) value = stripPhoneBleed(value);
      if (def.truncateAtOtherLabel) value = truncateAtOtherLabel(value);
      if (def.valueKind === 'percent') value = cleanPercentValue(value);
      // Etykieta ZOSTALA znaleziona (ff istnieje) - jesli extractAfterLabel nie zdolal
      // wyciac nic sensownego z zlepionej wartosci (np. odreczna liczba nieczytelna dla
      // OCR), to nadal found:true+puste (do recznego przegladu), NIE found:false (co
      // znikneloby z kolejki, mimo ze pole realnie istnieje na tym dokumencie).
      return { value, confidence: ff.confidence, found: true, labelBBox: ff.labelBBox, valueBBox: ff.valueBBox };
    }
    if (ff) return { value: '', confidence: ff.confidence, found: true, labelBBox: ff.labelBBox, valueBBox: ff.valueBBox };
    if (existsInPageText(page, def.formFieldPattern)) return { value: '', confidence: null, found: true };
  }
  return { value: '', confidence: null, found: false };
}

// Pola typu "grupa checkboxow" (Wentylacja: Grawitacyjna/Mechaniczna/Odzysk)
// - kazda opcja ma wlasny wzorzec dla tabeli i/albo formFields. Zwraca samo
// `option.label` jako wartosc.
function extractCheckboxField(page, def) {
  if (def.options.some((o) => o.tablePattern)) {
    const checkedTable = findCheckedTableRow(page.tables, def.options.filter((o) => o.tablePattern).map((o) => ({ ...o, pattern: o.tablePattern })));
    if (checkedTable) {
      if (checkedTable.ambiguous) {
        return { value: `Sprzeczne odczyty: ${checkedTable.conflictLabels.join(' / ')}`, confidence: COMPOSITE_CONFIDENCE_CAP, found: true };
      }
      if (checkedTable.option) {
        return { value: checkedTable.option.label, confidence: null, found: true, valueBBox: checkedTable.bbox };
      }
    }
  }
  if (def.options.some((o) => o.formFieldPattern)) {
    const checkedFF = findCheckedFormFieldOption(page.formFields, def.options.filter((o) => o.formFieldPattern).map((o) => ({ ...o, pattern: o.formFieldPattern })), page.visualElements);
    if (checkedFF) {
      if (checkedFF.ambiguous) {
        return { value: `Sprzeczne odczyty: ${checkedFF.conflictLabels.join(' / ')}`, confidence: COMPOSITE_CONFIDENCE_CAP, found: true };
      }
      if (checkedFF.option) {
        return { value: checkedFF.option.label, confidence: checkedFF.confidence, found: true, labelBBox: checkedFF.labelBBox, valueBBox: checkedFF.valueBBox };
      }
      return { value: '', confidence: null, found: true };
    }
  }
  if (def.options.some((o) => o.formFieldPattern && existsInPageText(page, o.formFieldPattern))) return { value: '', confidence: null, found: true };
  return { value: '', confidence: null, found: false };
}

// Pola typu "material + grubosc" (Sciana zewnetrzna: Cegla dziurawka, 25cm) -
// jak extractCheckboxField, ale WARTOSC = "Etykieta, Ncm" (dolaczona liczba z
// wiersza tabeli), nie sama etykieta - format zgodny z dawnym systemem
// (uzywany przez tabelaAdresowaMapping.js/eksport).
function extractMaterialField(page, def) {
  const checkedTable = findCheckedTableRow(page.tables, def.options.map((o) => ({ ...o, pattern: o.tablePattern })));
  if (checkedTable) {
    if (checkedTable.ambiguous) {
      return { value: `Sprzeczne odczyty: ${checkedTable.conflictLabels.join(' / ')}`, confidence: COMPOSITE_CONFIDENCE_CAP, found: true };
    }
    if (checkedTable.option) {
      const value = checkedTable.numericValue ? `${checkedTable.option.label}, ${checkedTable.numericValue}cm` : checkedTable.option.label;
      return { value, confidence: null, found: true, valueBBox: checkedTable.bbox };
    }
    return { value: '', confidence: null, found: true };
  }
  if (def.options.some((o) => existsInPageText(page, o.tablePattern))) return { value: '', confidence: null, found: true };
  return { value: '', confidence: null, found: false };
}

// Pola wywnioskowane z NAGLOWKA/TYTULU strony (np. "PROTOKOL... GRUNTOWA POMPA
// CIEPLA" vs "...POWIETRZNA POMPA CIEPLA") - nie sa to formFields (Document AI
// nie paruje tytulu strony z zadna "wartoscia"), tylko zwykly tekst strony -
// stad osobne dopasowanie na splaszczonym `page.ocrText`, nie przez
// findFormField/findCheckedFormFieldOption.
//
// UWAGA (poprawiono 2026-07-24, realny problem zlapany na zywym pliku): tu
// wysoka, PRAWDZIWA pewnosc (nie null jak przy polach z tabel/checkboxow) -
// to DRUKOWANY tytul strony (nie pismo odreczne, nie gesty checkbox obok
// innych podobnych), OCR czyta go niezawodnie, a dopasowanie jest
// jednoznaczne (GRUNTOWA vs POWIETRZNA to rozlaczne, latwe do odroznienia
// slowa). confidence:null (zawsze needsReview) tutaj oznaczalo, ze to samo,
// oczywiste pytanie ("Gruntowa") trzeba bylo potwierdzac w KAZDYM adresie tej
// samej paczki z osobna - wlasciciel: "dalej musze po kilka razy zaznaczac
// np. rodzaj pompy". Skoro w calym pliku to i tak zawsze ten sam protokol
// (nikt nie miesza rodzajow pompy w jednej paczce), wysoka pewnosc pozwala
// na automatyczne rozwiazanie bez pytania za kazdym razem.
function extractTitleDerivedField(page, def) {
  const flat = flattenText(page.ocrText);
  for (const option of def.options) {
    if (option.formFieldPattern.test(flat)) return { value: option.label, confidence: 0.99, found: true };
  }
  return { value: '', confidence: null, found: false };
}

function extractField(page, def) {
  if (def.kind === 'checkbox') return extractCheckboxField(page, def);
  if (def.kind === 'material') return extractMaterialField(page, def);
  // Pole celowo BEZ zadnej automatycznej ekstrakcji - zawsze trafia do reczengo
  // przegladu (patrz komentarz przy kluczu 'demontaz' nizej: Document AI nie
  // rozroznia niezawodnie ktory z ~10 identycznych checkboxow Tak/Nie na stronie
  // do niego nalezy, wiec zamiast cicho zgadywac zla odpowiedz, uzytkownik
  // wpisuje ja sam - trafia do tabelki dokladnie jak kazde inne pole).
  if (def.kind === 'manual') return { value: '', confidence: null, found: true };
  if (def.kind === 'titleDerived') return extractTitleDerivedField(page, def);
  return extractTextField(page, def);
}

// --- Definicje pol - lista OZC (Pompa ciepla powietrzna) + kolumny tabelek
// adresowych Kotly/Solary. Klucze prefiksowane kotly*/solary* gdzie nazwa po
// polsku moglaby kolidowac z polem o innym znaczeniu w rodzinie Pompy ciepla
// (np. solaryTypKonstrukcji to zupelnie inne pytanie niz typKonstrukcji). ---

const FIELD_DEFS = [
  // --- Pompa ciepla (powietrzna) - lista OZC ---
  { key: 'imieNazwisko', columnLabel: 'Imię i nazwisko', kind: 'text', valueKind: 'name', formFieldPattern: /IMI.*NAZWISKO/, truncateAtOtherLabel: true },
  { key: 'adresInstalacji', columnLabel: 'Adres miejsca instalacji', kind: 'text', formFieldPattern: /ADRES/, truncateAtOtherLabel: true },
  // Tytul protokolu rozroznia odmiane pompy (np. "...GRUNTOWA POMPA CIEPLA" na
  // realnym pliku Kazimierz Biskupi) - zweryfikowane tylko dla wariantu
  // gruntowa; wzorzec dla "powietrzna" symetryczny, ale bez realnego pliku do
  // potwierdzenia dokladnego brzmienia - jesli sie nie zlapie, po prostu
  // trafi do recznego przegladu jak kazde inne niedopasowane pole.
  { key: 'rodzajPompy', columnLabel: 'Rodzaj pompy', kind: 'titleDerived', options: [
    { label: 'Gruntowa', formFieldPattern: /GRUNTOWA\s*POMPA\s*CIEP[LŁ]A/ },
    { label: 'Powietrzna', formFieldPattern: /POWIETRZNA\s*POMPA\s*CIEP[LŁ]A/ }
  ] },
  // Sekcja 13 "Demontaz istniejacego zrodla ciepla: Tak/Nie" - NIE da sie tego
  // niezawodnie dopasowac automatycznie (zweryfikowane 2026-07-24: goly
  // checkbox bez wlasnego tekstu etykiety w danych Document AI, ten sam
  // wzorzec Tak/Nie powtarza sie ~10x na stronie w sekcjach 14-21 - dopasowanie
  // po tekscie zlapaloby przypadkowa odpowiedz z innego pytania). `kind:
  // 'manual'` = pole ZAWSZE trafia do recznego przegladu (nigdy nie probuje
  // automatycznie zgadywac) - uzytkownik wpisuje "tak"/"nie" sam podczas
  // przegladu, wartosc trafia do tabelki dokladnie jak kazde inne pole.
  { key: 'demontaz', columnLabel: 'Demontaż', kind: 'manual' },
  { key: 'telefon', columnLabel: 'Telefon', kind: 'text', valueKind: 'numeric', formFieldPattern: /TELEFON/ },
  { key: 'rokBudowy', columnLabel: 'Rok budowy budynku', kind: 'text', valueKind: 'numeric', formFieldPattern: /ROK.*BUDOWY/, stripHeaderPrefix: true },
  { key: 'liczbaOsob', columnLabel: 'Liczba osób w gospodarstwie', kind: 'text', valueKind: 'numeric', formFieldPattern: /LICZBA.*OS[OÓ]B/, stripPhoneBleed: true },
  { key: 'powierzchnia', columnLabel: 'Powierzchnia ogrzewana', kind: 'text', valueKind: 'numeric', formFieldPattern: /POWIERZCHNIA.*OGRZEWAN/ },
  { key: 'powierzchniaDzialki', columnLabel: 'Powierzchnia działki (dolne źródło)', kind: 'text', valueKind: 'numeric', formFieldPattern: /POWIERZCHNIA.*DZIA[LŁ]KI/ },
  // Etykieta "Przybliżona data montażu:" powtarza sie 3x na stronie
  // (stolarka/drzwi zewn/drzwi garaz) - Document AI NIE zwraca formFields w
  // kolejnosci geometrycznej (zweryfikowane na realnym pliku), wiec zamiast
  // polegac na kolejnosci, `valuePattern` wybiera po tresci WARTOSCI - kazda
  // z tych 3 wartosci zawiera wlasny naglowek sekcji jako prefiks (np.
  // "I. Drzwi zewnętrzne:\n2025"), ktory potem usuwamy (stripHeaderPrefix).
  { key: 'dataMontażuDrzwiZewn', columnLabel: 'Data montażu drzwi zewnętrznych', kind: 'text', valueKind: 'numeric', formFieldPattern: /PRZYBLI[ZŻ]ONA.*DATA.*MONTA[ZŻ]U/, valuePattern: /DRZWI.*ZEWN/, stripHeaderPrefix: true },
  { key: 'udzialGrzejnikowy', columnLabel: 'Udział ogrzewania grzejnikowego (%)', kind: 'text', valueKind: 'percent', formFieldPattern: /UDZIA[LŁ].*OGRZEWANIA.*GRZEJNIKOWEGO/ },
  { key: 'udzialPlaszczyznowy', columnLabel: 'Udział ogrzewania płaszczyznowego (%)', kind: 'text', valueKind: 'percent', formFieldPattern: /UDZIA[LŁ].*OGRZEWANIA.*P[LŁ]ASZCZYZNOWEGO/ },
  { key: 'temperaturaPomieszczenia', columnLabel: 'Żądana temperatura w pomieszczeniach', kind: 'text', valueKind: 'numeric', formFieldPattern: /TEMPERATURA.*POMIESZCZENIACH/ },
  { key: 'temperaturaCwu', columnLabel: 'Żądana temperatura c.w.u.', kind: 'text', valueKind: 'numeric', formFieldPattern: /TEMPERATURA.*C\.?W\.?U/ },

  // Sekcja "4. Planowane miejsce na bufor:" - wartosc na realnym pliku (Kazimierz
  // Biskupi) zawiera zlepiony opis miejsca + "Wysokość pomieszczenia: Nm" w jednym
  // tekscie (patrz extractAfterLabel powyzej). To INNE pytanie niz solaryWysokoscKotlowni
  // (rozny formularz/rozna sekcja) - stad osobny klucz z sufiksem PC, zgodnie z
  // konwencja pliku (zobacz komentarz na gorze o prefiksach kotly*/solary*).
  { key: 'wysokoscKotlowniPC', columnLabel: 'Wysokość kotłowni (m)', kind: 'text', valueKind: 'numeric', formFieldPattern: /PLANOWANE\s*MIEJSCE\s*NA\s*BUFOR/, extractAfterLabel: /WYSOKO[SŚ][CĆ]\s*POMIESZCZENIA:?\s*\.{0,3}\s*([\d.,]+)/i },

  // Sekcja 1 "Dobrane urzadzenie wg. umowy uczestnictwa:" - 6 mozliwych mocy (kW),
  // kazda to WLASNY, odrebny formField na realnym pliku (zweryfikowane 2026-07-24) -
  // bez ryzyka niejednoznacznosci (w odroznieniu od zrodloCiepla nizej), bo kazda opcja
  // ma unikalna liczbe w etykiecie.
  { key: 'mocPompyZGminy', columnLabel: 'Moc pompy z gminy', kind: 'checkbox', valueKind: 'numeric', options: [
    { label: '7', formFieldPattern: /MOCY\s*MIN\.?\s*7[,.]?0?\s*KW/ },
    { label: '8', formFieldPattern: /MOCY\s*MIN\.?\s*8[,.]?0?\s*KW/ },
    { label: '9', formFieldPattern: /MOCY\s*MIN\.?\s*9[,.]?0?\s*KW/ },
    { label: '10', formFieldPattern: /MOCY\s*MIN\.?\s*10[,.]?0?\s*KW/ },
    { label: '12', formFieldPattern: /MOCY\s*MIN\.?\s*12[,.]?0?\s*KW/ },
    { label: '13', formFieldPattern: /MOCY\s*MIN\.?\s*13[,.]?0?\s*KW/ }
  ] },

  // Sekcja 10 "Dotychczasowy sposob podgrzewania c.w.u.:" - UWAGA, znany limit
  // (zweryfikowany na realnym pliku 2026-07-24): sekcja 11 ("...c.o.:") ma DOKLADNIE
  // TAKA SAMA liste opcji, a Document AI nie rozroznia niezawodnie ktora checkboxa
  // nalezy do ktorej sekcji (formFields nie niosa informacji o sekcji, tylko o tresci
  // etykiety) - jesli gospodarstwo ma RozNE zrodla dla c.w.u. i c.o., to pole moze
  // czasem zlapac odpowiedz z sekcji 11 zamiast 10. W praktyce oba pytania niemal
  // zawsze maja te sama odpowiedz (jedno istniejace zrodlo obsluguje oba), wiec ryzyko
  // jest niskie, ale nie zerowe - nie traktowac tego pola jako w 100% pewnego bez
  // dodatkowej weryfikacji, gdyby kiedys trzeba bylo to podniesc.
  { key: 'zrodloCiepla', columnLabel: 'Źródło ciepła', kind: 'checkbox', options: [
    { label: 'Kocioł na paliwo stałe', formFieldPattern: /KOCIO[LŁ]\s*NA\s*PALIWO\s*STA[LŁ]E/ },
    { label: 'Kocioł na biomasę', formFieldPattern: /KOCIO[LŁ]\s*NA\s*BIOMAS[EĘ]/ },
    { label: 'Kocioł na gaz/olej – jednofunkcyjny', formFieldPattern: /KOCIO[LŁ]\s*NA\s*GAZ.*JEDNOFUNKCYJNY/ },
    { label: 'Kocioł na gaz/olej – dwufunkcyjny', formFieldPattern: /KOCIO[LŁ]\s*NA\s*GAZ.*DWUFUNKCYJNY/ },
    { label: 'Podgrzewacz elektryczny/gazowy', formFieldPattern: /PODGRZEWACZ\s*ELEKTRYCZNY/ },
    { label: 'Inny', formFieldPattern: /^INNY\b/ },
    { label: 'Brak instalacji c.w.u.', formFieldPattern: /BRAK\s*INSTALACJI\s*C\.?\s*W\.?\s*U/ }
  ] },

  { key: 'wentylacja', columnLabel: 'Wentylacja', kind: 'checkbox', options: [
    { label: 'Grawitacyjna', formFieldPattern: /GRAWITACYJNA/ },
    { label: 'Mechaniczna', formFieldPattern: /MECHANICZNA/ },
    { label: 'Odzysk ciepła', formFieldPattern: /ODZYSK/ }
  ] },
  { key: 'typKonstrukcji', columnLabel: 'Typ konstrukcji', kind: 'checkbox', options: [
    { label: 'Lekka', formFieldPattern: /LEKKA/ },
    { label: 'Średnia', formFieldPattern: /[SŚ]REDNIA/ },
    { label: 'Ciężka', formFieldPattern: /CI[EĘ][ZŻ]KA/ }
  ] },
  { key: 'stopienSzczelnosci', columnLabel: 'Stopień szczelności', kind: 'checkbox', options: [
    { label: 'Niski', formFieldPattern: /NISKI/ },
    { label: 'Średni', formFieldPattern: /^[SŚ]REDNI$/ },
    { label: 'Wysoki', formFieldPattern: /WYSOKI/ }
  ] },
  { key: 'klasaOslonieciaBudynku', columnLabel: 'Klasa osłonięcia budynku', kind: 'checkbox', options: [
    { label: 'Brak', formFieldPattern: /^BRAK$/ },
    { label: 'Średnie', formFieldPattern: /[SŚ]REDNIE/ },
    { label: 'Dobre', formFieldPattern: /DOBRE/ }
  ] },
  { key: 'rodzajDachu', columnLabel: 'Rodzaj dachu', kind: 'checkbox', options: [
    { label: 'Płaski', formFieldPattern: /P[LŁ]ASKI/ },
    { label: 'Skośny', formFieldPattern: /SKO[SŚ]NY/ }
  ] },
  { key: 'pokrycieDachu', columnLabel: 'Pokrycie dachu', kind: 'checkbox', options: [
    { label: 'Blachodachówka', formFieldPattern: /BLACHODACH[OÓ]WKA/ },
    { label: 'Papa', formFieldPattern: /^PAPA$/ },
    { label: 'Dachówka ceramiczna', formFieldPattern: /DACH[OÓ]WKA.*CERAMICZNA/ },
    { label: 'Membrana', formFieldPattern: /MEMBRANA/ }
  ] },
  { key: 'ksztaltBudynku', columnLabel: 'Kształt budynku', kind: 'checkbox', options: [
    { label: 'Regularny', formFieldPattern: /^REGULARNY$/ },
    { label: 'Nieregularny', formFieldPattern: /^NIEREGULARNY$/ }
  ] },

  // Material+grubosc (tabele) - patrz extractMaterialField.
  { key: 'scianaZewnMaterial', columnLabel: 'Ściana zewnętrzna (materiał, grubość)', kind: 'material', options: [
    { label: 'Cegła ceramiczna pełna', tablePattern: /CEG[LŁ]A.*CERAMICZNA.*PE[LŁ]NA/ },
    { label: 'Cegła dziurawka', tablePattern: /CEG[LŁ]A.*DZIURAWKA/ },
    { label: 'Bloczki z betonu komórkowego', tablePattern: /BLOCZKI.*BETONU.*KOM[OÓ]RKOWEGO/ },
    { label: 'Bloczki silikatowe', tablePattern: /BLOCZKI.*SILIKATOWE/ },
    { label: 'Pustak keramzytobetonowe', tablePattern: /PUSTAK.*KERAMZYTOBETONOWE/ },
    { label: 'Drewno', tablePattern: /^DREWNO/ },
    { label: 'Żużel', tablePattern: /^[ZŻ]U[ZŻ]EL/ },
    { label: 'Inne', tablePattern: /^INNE/ }
  ] },
  { key: 'ocieplenieScianyZewn', columnLabel: 'Ocieplenie ściany zewnętrznej (materiał, grubość)', kind: 'material', options: [
    { label: 'Styropian', tablePattern: /STYROPIAN/ },
    { label: 'Wełna mineralna', tablePattern: /WE[LŁ]NA.*MINERALNA/ },
    { label: 'Pustka powietrzna', tablePattern: /PUSTKA.*POWIETRZNA/ },
    { label: 'Pianka PUR', tablePattern: /PIANKA/ },
    { label: 'Brak', tablePattern: /^BRAK/ }
  ] },
  { key: 'scianaFundamentowaMaterial', columnLabel: 'Ściana fundamentowa (materiał, grubość)', kind: 'material', options: [
    { label: 'Beton', tablePattern: /^BETON/ },
    { label: 'Żużel', tablePattern: /^[ZŻ]U[ZŻ]EL/ },
    { label: 'Cegła pełna', tablePattern: /CEG[LŁ]A.*PE[LŁ]NA/ },
    { label: 'Pustak', tablePattern: /^PUSTAK/ },
    { label: 'Kamień', tablePattern: /KAMIE[NŃ]/ },
    { label: 'Bloczek betonowy', tablePattern: /BLOCZEK.*BETONOWY/ }
  ] },
  { key: 'stropOgrzewane', columnLabel: 'Strop nad ogrzewanymi (materiał, grubość)', kind: 'material', options: [
    { label: 'Strop żelbetowy monolityczny', tablePattern: /STROP.*[ZŻ]ELBETOWY/ },
    { label: 'Strop gęsto żebrowy', tablePattern: /STROP.*G[EĘ]STO.*[ZŻ]EBROWY/ },
    { label: 'Strop drewniany', tablePattern: /STROP.*DREWNIANY/ }
  ] },
  { key: 'stropNieogrzewane', columnLabel: 'Strop nad nieogrzewanymi (materiał, grubość)', kind: 'material', options: [
    { label: 'Strop żelbetowy monolityczny', tablePattern: /STROP.*[ZŻ]ELBETOWY/ },
    { label: 'Strop gęsto żebrowy', tablePattern: /STROP.*G[EĘ]STO.*[ZŻ]EBROWY/ },
    { label: 'Strop drewniany', tablePattern: /STROP.*DREWNIANY/ }
  ] },
  // Dodane dla kolumn "Ociepl. fund."/"Ociepl. dach/strop" tabelki adresowej PC
  // (2026-07-23) - na formularzu to proste "Izolacja: [ ] Tak, grubość: __cm
  // [ ] Nie" bezposrednio pod sekcja E (Sciana fundamentowa) wzgl. "Izolacja
  // dachu: [ ] Tak, pomiedzy krokwiami/na zewnatrz, grubosc: __cm [ ] Nie" pod
  // sekcja G (Dach) - ta sama, juz sprawdzona struktura co inne pola typu
  // 'material' (opcja+liczba w tym samym wierszu/kontekscie). Ryzyko: obie
  // sekcje maja niemal identyczny uklad "Izolacja: Tak/Nie + grubosc" (strop
  // ma swoja WLASNA, podobna sekcje tuz obok) - jesli Document AI zgrupuje je
  // niejednoznacznie, pole trafi do recznego przegladu (needsReview) zamiast
  // po cichu pomylic wartosci - akceptowalne, ten sam kompromis co reszta
  // pol typu 'material' w tym pliku.
  { key: 'izolacjaScianyFundamentowej', columnLabel: 'Izolacja ściany fundamentowej (grubość)', kind: 'material', options: [
    { label: 'Tak', tablePattern: /^TAK\b/ },
    { label: 'Nie', tablePattern: /^NIE$/ }
  ] },
  { key: 'izolacjaDachu', columnLabel: 'Izolacja dachu (grubość)', kind: 'material', options: [
    { label: 'Tak', tablePattern: /^TAK\b/ },
    { label: 'Nie', tablePattern: /^NIE$/ }
  ] },

  // Ksztalt budynku / elewacje (strona "OBRYS BUDYNKU") - formField, best-effort.
  { key: 'dlugoscBudynku', columnLabel: 'Długość budynku (regularny)', kind: 'text', valueKind: 'numeric', formFieldPattern: /^D[LŁ]UGO[SŚ][CĆ]$/ },
  { key: 'szerokoscBudynku', columnLabel: 'Szerokość budynku (regularny)', kind: 'text', valueKind: 'numeric', formFieldPattern: /^SZEROKO[SŚ][CĆ]$/ },
  { key: 'dlugoscScianPolnocnej', columnLabel: 'Długość ścian od strony północnej', kind: 'text', valueKind: 'numeric', formFieldPattern: /D[LŁ]UGO[SŚ][CĆ].*P[OÓ][LŁ]NOCNEJ/ },
  { key: 'dlugoscScianPoludniowej', columnLabel: 'Długość ścian od strony południowej', kind: 'text', valueKind: 'numeric', formFieldPattern: /D[LŁ]UGO[SŚ][CĆ].*PO[LŁ]UDNIOWEJ/ },
  { key: 'dlugoscScianWschodniej', columnLabel: 'Długość ścian od strony wschodniej', kind: 'text', valueKind: 'numeric', formFieldPattern: /D[LŁ]UGO[SŚ][CĆ].*WSCHODNIEJ/ },
  { key: 'dlugoscScianZachodniej', columnLabel: 'Długość ścian od strony zachodniej', kind: 'text', valueKind: 'numeric', formFieldPattern: /D[LŁ]UGO[SŚ][CĆ].*ZACHODNIEJ/ },
  { key: 'elewacjaAPowierzchniaOkien', columnLabel: 'Elewacja A (Północna) - powierzchnia okien', kind: 'text', valueKind: 'numeric', formFieldPattern: /ELEWACJA.*A.*P[OÓ][LŁ]NOCNA/ },
  { key: 'elewacjaBPowierzchniaOkien', columnLabel: 'Elewacja B (Wschodnia) - powierzchnia okien', kind: 'text', valueKind: 'numeric', formFieldPattern: /ELEWACJA.*B.*WSCHODNIA/ },
  { key: 'elewacjaCPowierzchniaOkien', columnLabel: 'Elewacja C (Południowa) - powierzchnia okien', kind: 'text', valueKind: 'numeric', formFieldPattern: /ELEWACJA.*C.*PO[LŁ]UDNIOWA/ },
  { key: 'elewacjaDPowierzchniaOkien', columnLabel: 'Elewacja D (Zachodnia) - powierzchnia okien', kind: 'text', valueKind: 'numeric', formFieldPattern: /ELEWACJA.*D.*ZACHODNIA/ },

  // --- Kotly (Galewice) - kolumny "3.wzor-tabela adresowa KOTLY" ---
  // Zweryfikowane na realnym pliku 2026-07-22: fieldName to "10 kW\n" (nie
  // sam "10") - wzorzec musi tolerowac sufiks jednostki, nie byc scisle
  // zakonczony na cyfrze.
  { key: 'kotlyMocKotla', columnLabel: 'Moc kotła', kind: 'checkbox', options: [
    { label: '10 kW', formFieldPattern: /^10\b/ },
    { label: '15 kW', formFieldPattern: /^15\b/ },
    { label: '20 kW', formFieldPattern: /^20\b/ },
    { label: '25 kW', formFieldPattern: /^25\b/ },
    { label: '30 kW', formFieldPattern: /^30\b/ }
  ] },
  { key: 'kotlyMocIstniejacegoZrodla', columnLabel: 'Moc istniejącego źródła ciepła', kind: 'text', valueKind: 'numeric', formFieldPattern: /ISTNIEJ[AĄ]CE.*[ZŹ]R[OÓ]D[LŁ]O.*CIEP[LŁ]A.*MOC/ },
  { key: 'kotlyZasobnikCwu', columnLabel: 'Zasobnik c.w.u. (pojemność)', kind: 'text', valueKind: 'numeric', formFieldPattern: /POJEMNO[SŚ][CĆ]/ },

  // --- Solary (Galewice) - kolumny "2.wzor-tabela adresowa SOLARY" ---
  { key: 'solaryRodzajZestawu', columnLabel: 'Rodzaj zestawu', kind: 'checkbox', options: [
    { label: '2/250', formFieldPattern: /^2(\/?250)?$/ },
    { label: '3/300', formFieldPattern: /^3(\/?300)?$/ },
    { label: '4/400', formFieldPattern: /^4(\/?400)?$/ }
  ] },
  { key: 'solaryTypBudynku', columnLabel: 'Typ budynku', kind: 'checkbox', options: [
    { label: 'Bud. mieszkalny', formFieldPattern: /MIESZKALNY/ },
    { label: 'Bud. gospodarczy', formFieldPattern: /GOSPODARCZY/ }
  ] },
  { key: 'solaryTypKonstrukcji', columnLabel: 'Typ konstrukcji', kind: 'checkbox', options: [
    { label: 'Dach płaski', formFieldPattern: /^DACH.*P[LŁ]ASKI$/ },
    { label: 'Dach skośny', formFieldPattern: /^DACH.*SKO[SŚ]NY$/ },
    { label: 'Elewacja', formFieldPattern: /^ELEWACJA$/ }
  ] },
  { key: 'solaryMiejsceMontazu', columnLabel: 'Miejsce montażu', kind: 'checkbox', options: [
    { label: 'Dach płaski lub zbliżony', formFieldPattern: /DACH.*P[LŁ]ASKI.*LUB.*ZBLI[ZŻ]ONY/ },
    { label: 'Balkon, taras', formFieldPattern: /BALKON/ },
    { label: 'Dach skośny', formFieldPattern: /^DACH.*SKO[SŚ]NY/ },
    { label: 'Grunt', formFieldPattern: /^GRUNT/ },
    { label: 'Elewacja budynku, wysoko', formFieldPattern: /ELEWACJA.*BUDYNKU.*WYSOKO/ },
    { label: 'Elewacja budynku, nisko', formFieldPattern: /ELEWACJA.*BUDYNKU.*NISKO/ }
  ] },
  { key: 'solaryPokrycieDachu', columnLabel: 'Pokrycie dachu', kind: 'text', formFieldPattern: /POKRYCIE.*DACHU/ },
  { key: 'solaryWysokoscKotlowni', columnLabel: 'Wysokość kotłowni', kind: 'text', valueKind: 'numeric', formFieldPattern: /^WYS\.?\s*POM/ }
];

const COLUMN_ORDER = ['adres', ...FIELD_DEFS.map((f) => f.key)];
const COLUMN_LABELS = { adres: 'Adres' };
for (const f of FIELD_DEFS) COLUMN_LABELS[f.key] = f.columnLabel;

// Laczy strony bloku - probuje kazda strone po kolei, zwraca pierwszy
// znaleziony ("found") wynik z niepustej wartosci, w przeciwnym razie
// pierwszy "found" wynik (nawet pusty), albo not-found jesli zaden.
function extractFields(pages, block, allowedKeys = null) {
  const blockPages = pages.slice(block.startPage, block.endPage + 1).filter((p) => p.imagePath);
  const result = {};

  for (const def of FIELD_DEFS) {
    if (allowedKeys && !allowedKeys.has(def.key)) continue;
    let best = { value: '', confidence: null, found: false };
    let bestPageIndex = null;
    for (const page of blockPages) {
      const extracted = extractField(page, def);
      if (extracted.found && extracted.value) { best = extracted; bestPageIndex = page.pageIndex; break; }
      if (extracted.found && !best.found) { best = extracted; bestPageIndex = page.pageIndex; }
    }
    result[def.key] = toFieldResult(best, bestPageIndex, def.valueKind);
  }

  return result;
}

// Ponownie wyciaga JEDNO, konkretne pole (po kluczu) z JUZ przetworzonej
// "strony" (moze to byc prawdziwa strona z analyzeDocument, albo mini-strona
// zbudowana z ponownego OCR wycietego fragmentu - patrz retryFieldWithCrop w
// server.js). Zwraca ten sam ksztalt co pola w wyniku extractFields.
function extractSingleField(page, key) {
  const def = FIELD_DEFS.find((f) => f.key === key);
  if (!def) return null;
  const extracted = extractField(page, def);
  return toFieldResult(extracted, page.pageIndex ?? null, def.valueKind);
}

module.exports = { extractFields, extractSingleField, COLUMN_ORDER, COLUMN_LABELS, FIELD_DEFS, extractField, toFieldResult };
