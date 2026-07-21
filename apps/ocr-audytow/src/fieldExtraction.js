// Wyciaganie pojedynczych pol formularza (rok budowy, powierzchnia, materialy,
// itd.) z JUZ rozpoznanego tekstu (kazda strona bloku ma juz `ocrWords` -
// patrz analyzeDocument w ocrPipeline.js) - budowane 2026-07-21 na prosbe
// wlasciciela: chce jedna tabelke Excela, jeden wiersz na adres, ze
// WSZYSTKIMI polami z formularza.
//
// Zakres: rodzina szablonow "PROTOKOL UZGODNIEN MONTAZOWYCH" (11/13
// testowanych inwestycji) + wariant Rzgow/Wilczyn (dodatkowe pola o
// instalacji c.o./srednicach rur). Trzecia rodzina szablonow (kotly na
// pellet, Paradyz Zarnow) NIE MA jeszcze wzorcow etykiet - jej pola po
// prostu nigdy sie nie znajda i zawsze traktowana beda jako "do uzupelnienia
// recznie", co jest bezpiecznym (nie cichym) zachowaniem.
//
// ETAP 6 (2026-07-21): rozszerzone o DRUGA strone formularza (bufor,
// instalacja elektryczna, dotychczasowe zrodlo cwu/co, materialy rur,
// grzejniki, obiegi/zawory mieszajace, temperatury docelowe, rodzaj gleby,
// powierzchnia dzialki, kolizje z uzbrojeniem, prace ziemne) - odkryte przez
// porownanie z autorytatywnymi szablonami DOCX
// ("Forma do Audytow PC Gruntowe.docx" itp.) i potwierdzone na realnym
// skanie (Kazimierz Biskupi, strona 2), ktora ma te pola gesto wypelnione.
// Trzecia strona formularza (szkic obrysu budynku/elewacji/kotlowni) to
// rysunek techniczny, nie tekst - swiadomie POMINIETA, nie da sie sensownie
// zmapowac na jedna komorke Excela.
//
// Technika (ta sama co juz sprawdzona w bundleSplit.js's looksLikeBlockHeader
// - dopasowanie SEKWENCJI slow w bliskim sasiedztwie, nie "gdziekolwiek na
// stronie"): kazde pole ma `labelPatterns` (lista wyrazen regularnych w
// kolejnosci, CALA drukowana etykieta az do dwukropka - zweryfikowane na
// realnym pliku, ze krotsze/czesciowe wzorce "wciagaja" reszte etykiety jako
// falszywa wartosc, np. "Liczba osob" bez "w gospodarstwie" lapalo
// "w gospodarstwie" jako odpowiedz). Po znalezieniu etykiety, wartosc to
// slowa lezace na tej samej linii (podobny zakres Y) na prawo od konca
// etykiety, w tej samej "polowie" strony co etykieta (zeby nie wpasc przez
// szpalte do sasiedniej kolumny formularza), az do napotkania poczatku
// etykiety INNEGO znanego pola albo zbyt duzej przerwy poziomej.
//
// Pola zagniezdzone w sekcjach (np. "Ilosc:"/"Wymiary:"/"Przyblizona data
// montazu:" powtarzaja sie identycznie pod "Stolarka okienna", "Drzwi
// zewnetrzne" I "Drzwi garazowe") uzywaja SECTION_HEADERS do ograniczenia
// wyszukiwania sub-etykiety do slow miedzy poczatkiem danej sekcji a
// poczatkiem NASTEPNEJ sekcji (patrz findSectionRange) - bez tego
// wyszukiwanie "Ilosc:" znajdowaloby zawsze PIERWSZE wystapienie na stronie,
// niezaleznie od sekcji.
//
// To jest CELOWO konserwatywne - lepiej zwrocic pusto/niepewnie (trafi do
// recznego przegladu w UI) niz zgarnac smieci z sasiedniego pola. Pola
// zlozone (material+grubosc, checkboxy) maja z gory ograniczona pewnosc
// (patrz COMPOSITE_CONFIDENCE_CAP) - ich ekstrakcja jest z natury mniej
// pewna niz proste "etykieta: wartosc" w jednej linii, wiec czesciej beda
// trafialy do recznego przegladu, co jest pozadanym zachowaniem, nie bugiem.

const ADJACENCY_WINDOW = 2;
const SAME_LINE_TOLERANCE = 0.55; // wielokrotnosc wysokosci slowa etykiety - zweryfikowane na realnym pliku: sasiednie wiersze formularza sa oddalone o ~40px przy wysokosci slowa ~38px, wiec tolerancja musi byc ponizej ~0.5x zeby ich nie mieszac
const MAX_VALUE_WORDS = 8;
const COMPOSITE_CONFIDENCE_CAP = 0.5; // ponizej progu 0.7 - zawsze trafia do przegladu, chyba ze rozpoznanie bylo wyjatkowo pewne
const LOW_CONFIDENCE_THRESHOLD = 0.7;
const CHECKBOX_CHECKED = /[☑☒✓✔]/;

function bbox(word) {
  const xs = word.vertices.map((v) => v.x);
  const ys = word.vertices.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function unionBBox(words) {
  const boxes = words.map(bbox);
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxY: Math.max(...boxes.map((b) => b.maxY))
  };
}

// Szuka sekwencji `patterns` (wyrazenia regularne) wsrod `words` zaczynajac
// od `fromIdx` - kazdy kolejny wzorzec moze pominac do ADJACENCY_WINDOW obcych
// slow. Zwraca liste indeksow dopasowanych slow (dlugosc = patterns.length)
// albo null.
function matchSequenceFrom(words, patterns, fromIdx) {
  let cursor = fromIdx;
  const matched = [];
  for (const pattern of patterns) {
    let found = -1;
    for (let j = cursor; j <= Math.min(cursor + ADJACENCY_WINDOW, words.length - 1); j++) {
      if (pattern.test(words[j].text.toUpperCase())) { found = j; break; }
    }
    if (found === -1) return null;
    matched.push(found);
    cursor = found + 1;
  }
  return matched;
}

// Szuka PIERWSZEGO (od `fromIdx`) wystapienia sekwencji `patterns` wsrod
// `words`. Zwraca { indices } albo null.
function findLabel(words, patterns, fromIdx = 0) {
  for (let i = fromIdx; i < words.length; i++) {
    if (!patterns[0].test(words[i].text.toUpperCase())) continue;
    const matched = matchSequenceFrom(words, patterns, i);
    if (matched) return { indices: matched };
  }
  return null;
}

// UWAGA: musi sprawdzic, ze slowo NA `idx` samo jest PIERWSZYM slowem
// etykiety - nie ze etykieta zaczyna sie "gdzies niedaleko idx" (bez tego
// warunku matchSequenceFrom's wlasne okno tolerancji ADJACENCY_WINDOW
// pozwalalo dopasowac etykiete zaczynajaca sie 1-2 slowa PO idx, co dawalo
// falszywe alarmy - realny przypadek na tym samym pliku: "2006" (wartosc
// pola "Rok budowy budynku") siedzialo w tablicy `words` tuz przed
// "Powierzchnia ogrzewana budynku:" - zupelnie inne pole, geometrycznie
// gdzie indziej na stronie, ale blisko w KOLEJNOSCI ODCZYTU - bez tego
// warunku "2006" bylo mylnie odrzucane jako "poczatek innej etykiety").
function startsAnyLabel(words, idx, allLabelPatterns) {
  return allLabelPatterns.some((patterns) => patterns[0].test(words[idx].text.toUpperCase()) && matchSequenceFrom(words, patterns, idx) !== null);
}

// UWAGA - realne odkrycie na prawdziwym pliku: Vision NIE gwarantuje, ze
// slowo geometrycznie zaraz obok etykiety (ta sama linia, na prawo) jest tez
// zaraz obok niej w KOLEJNOSCI ODCZYTU (tablicy `words`). Zweryfikowane na
// polu "Rok budowy budynku:" - odreczne "2006" bylo geometrycznie idealnie
// na tej samej linii co etykieta (y niemal identyczne, x zaraz po koncu
// etykiety), ale ~70 pozycji dalej w tablicy `ocrWords`, bo Vision grupuje
// slowa w bloki/akapity ktore na gestym formularzu (checkboxy + odreczne
// wpisy przeplecione z drukiem) nie zawsze odpowiadaja czystej kolejnosci
// gora-dol/lewo-prawo. Pierwsza wersja tej funkcji szukala tylko w oknie
// +40 pozycji w tablicy OD etykiety - to ja przegapialo. Poprawka: szukamy
// PO GEOMETRII w calej liscie slow strony (ta sama linia Y, na prawo od
// etykiety, w tej samej polowie strony), nie po sasiedztwie w tablicy -
// dopiero znalezione kandydaty ukladamy od lewej do prawej wedlug
// wspolrzednej X, zeby odtworzyc prawdziwa kolejnosc czytania W TEJ LINII.
function collectValueWords(words, labelEndIdx, labelBBox, pageWidth, allLabelPatterns) {
  const labelHeight = labelBBox.maxY - labelBBox.minY || 20;
  const labelMidY = (labelBBox.minY + labelBBox.maxY) / 2;
  const labelIsLeftHalf = labelBBox.minX < pageWidth / 2;
  const maxX = labelIsLeftHalf ? pageWidth * 0.56 : pageWidth;
  const minXAllowed = labelIsLeftHalf ? 0 : pageWidth * 0.44;

  const candidates = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const b = bbox(w);
    const midY = (b.minY + b.maxY) / 2;
    if (Math.abs(midY - labelMidY) > labelHeight * SAME_LINE_TOLERANCE) continue;
    if (b.minX < labelBBox.maxX - labelHeight * 0.3) continue; // musi byc na prawo od etykiety (z mala tolerancja)
    if (b.maxX > maxX || b.minX < minXAllowed) continue;
    candidates.push({ idx: i, word: w, b });
  }
  candidates.sort((a, b) => a.b.minX - b.b.minX);

  const collected = [];
  let prevMaxX = labelBBox.maxX;
  for (const c of candidates) {
    if (collected.length >= MAX_VALUE_WORDS) break;
    if (c.b.minX - prevMaxX > labelHeight * 6) break;
    if (allLabelPatterns.length && startsAnyLabel(words, c.idx, allLabelPatterns)) break;
    // Strona 2 ma kazde pytanie poprzedzone numerem porzadkowym ("23.",
    // "24." itd, patrz numeracja w tresci skanu) - taki sam token czasem
    // trafia geometrycznie zaraz PO wartosci poprzedniego pola (bo to
    // numer NASTEPNEGO pytania), wiec trzeba go pominac tak samo jak
    // interpunkcje, inaczej dolacza sie do wartosci poprzedniego pola.
    if (/^[.\-_:()]+$/.test(c.word.text) || /^\d{1,2}\.$/.test(c.word.text)) { prevMaxX = c.b.maxX; continue; }
    collected.push(c.word);
    prevMaxX = c.b.maxX;
  }
  return collected;
}

function wordConfidence(words) {
  const withConf = words.filter((w) => typeof w.confidence === 'number');
  if (!withConf.length) return null;
  return withConf.reduce((sum, w) => sum + w.confidence, 0) / withConf.length;
}

// Znajduje, ktora z `options` (lista {label, patterns}) jest zaznaczona -
// szuka symbolu zaznaczonego checkboxa w slowie dopasowanym albo w slowie
// bezposrednio PRZED nim (Vision zwraca np. "☑Grawitacyjna" jako jedno
// slowo, albo oddzielnie "☑" + "Grawitacyjna" - oba warianty widziane na
// realnych plikach w tej sesji).
// Zwraca null TYLKO gdy zaden tekst opcji nie wystapil ANI RAZU w zakresie -
// czyli to pytanie strukturalnie nie istnieje w tym dokumencie (np. pole
// specyficzne dla innego wariantu formularza). Gdy tekst opcji zostal
// znaleziony, ale zaden checkbox nie byl zaznaczony, zwraca { option: null }
// - odroznienie kluczowe dla toFieldResult (patrz nizej): "pytania tu nie ma"
// (nie proponuj do recznego przegladu) vs "pytanie jest, ale nic nie
// zaznaczono/nie udalo sie odczytac" (prawdziwy przypadek do przegladu).
function findCheckedOption(words, options, rangeStart = 0, rangeEnd) {
  const end = rangeEnd ?? words.length;
  let anyOptionTextFound = false;
  for (const option of options) {
    let searchFrom = rangeStart;
    while (searchFrom < end) {
      const label = findLabel(words.slice(0, end), option.patterns, searchFrom);
      if (!label) break;
      anyOptionTextFound = true;
      const firstIdx = label.indices[0];
      const candidates = [words[firstIdx].text, firstIdx > 0 ? words[firstIdx - 1].text : ''];
      if (candidates.some((t) => CHECKBOX_CHECKED.test(t))) {
        return { option, words: label.indices.map((idx) => words[idx]) };
      }
      searchFrom = firstIdx + 1;
    }
  }
  return anyOptionTextFound ? { option: null } : null;
}

// Grupuje slowa w "linie" po zblizonym Y-srodku (tolerancja = wysokosc
// slowa), posortowane wewnatrz linii po X - potrzebne dla dlugich opcji
// checkboxowych typu "☒ Gruntowa pompa ciepła o mocy min. 7,0 kW", gdzie
// znacznik zaznaczenia jest daleko (w slowach) od czesci odrozniajacej
// opcje (liczby mocy) - findCheckedOption samo nie wystarcza.
function groupIntoLines(words, rangeStart, rangeEnd) {
  const slice = words.slice(rangeStart, rangeEnd).map((w, i) => ({ w, idx: rangeStart + i, b: bbox(w) }));
  const lines = [];
  for (const item of slice) {
    const midY = (item.b.minY + item.b.maxY) / 2;
    const h = item.b.maxY - item.b.minY || 20;
    let line = lines.find((l) => Math.abs(l.midY - midY) < h * 0.7);
    if (!line) { line = { midY, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  for (const line of lines) line.items.sort((a, b) => a.b.minX - b.b.minX);
  return lines;
}

// Szuka linii (patrz groupIntoLines) w [rangeStart,rangeEnd) ktorej PIERWSZE
// slowo niesie znacznik zaznaczonego checkboxa I ktora pasuje do
// `contentPattern` (np. /KW/) - zwraca cala linie jako wartosc.
function findCheckedLine(words, rangeStart, rangeEnd, contentPattern) {
  const lines = groupIntoLines(words, rangeStart, rangeEnd);
  for (const line of lines) {
    if (!line.items.length) continue;
    const first = line.items[0].w.text;
    if (!CHECKBOX_CHECKED.test(first)) continue;
    const text = line.items.map((it) => it.w.text).join(' ');
    if (!contentPattern.test(text.toUpperCase())) continue;
    return { text: text.replace(CHECKBOX_CHECKED, '').trim(), words: line.items.map((it) => it.w) };
  }
  return null;
}

// --- Sekcje (do ograniczania wyszukiwania powtarzalnych pod-etykiet typu
// "Ilosc:"/"Wymiary:"/"Przyblizona data montazu:" do wlasciwego naglowka
// sekcji - dopasowanie po tresci naglowka, NIE po literze/numerze sekcji,
// bo ta sama sekcja bywa oznaczona rozna litera w roznych szablonach
// formularzy (np. "H. Drzwi zewnetrzne" w jednym, "I. Drzwi zewnetrzne" w
// innym) - zweryfikowane na realnych plikach z roznych inwestycji.
const SECTION_HEADERS = [
  { key: 'urzadzenie', patterns: [/DOBRANE/, /URZ[AĄ]DZENIE/] },
  { key: 'charakterystykaBudynku', patterns: [/OG[OÓ]LNA/, /CHARAKTERYSTYKA/, /BUDYNKU/] },
  { key: 'scianaZewn', patterns: [/[SŚ]CIANA/, /ZEWN[EĘ]TRZNA/] },
  { key: 'ocieplenie', patterns: [/OCIEPLENIE/, /[SŚ]CIANY/] },
  { key: 'scianaFundamentowa', patterns: [/[SŚ]CIANA/, /FUNDAMENTOWA/] },
  { key: 'stropOgrzewane', patterns: [/STROP/, /NAD/, /OGRZEWANYMI/] },
  { key: 'stropNieogrzewane', patterns: [/STROP/, /NAD/, /NIEOGRZEWANYMI/] },
  { key: 'dach', patterns: [/^DACH/] },
  { key: 'stolarka', patterns: [/STOLARKA/, /OKIENNA/] },
  { key: 'drzwiZewn', patterns: [/DRZWI/, /ZEWN[EĘ]TRZNE/] },
  { key: 'drzwiGaraz', patterns: [/DRZWI/, /GARA[ZŻ]OWE/] },
  { key: 'instalacjaCo', patterns: [/INSTALACJA/, /C\.?O/] },
  { key: 'instalacjaWody', patterns: [/INSTALACJA/, /WODY/] },
  // Strona 2 formularza (bufor/elektryka/instalacja grzewcza/grunt) - dodane
  // 2026-07-21 po analizie realnych wzorow DOCX, patrz komentarz na gorze
  // pliku ("ETAP 6 - strona 2").
  { key: 'bufor', patterns: [/PLANOWANE/, /MIEJSCE/, /NA/, /BUFOR/] },
  { key: 'zasobnikSection', patterns: [/PLANOWANE/, /MIEJSCE/, /NA/, /ZASOBNIK/] },
  { key: 'elektrykaSection', patterns: [/TYP/, /INSTALACJI/, /ELEKTRYCZNEJ/] },
  { key: 'instalacjaCoRodzajSection', patterns: [/RODZAJ/, /ISTNIEJ[AĄ]CEJ/, /INSTALACJI/, /C\.?O/] },
  { key: 'sposobCwu', patterns: [/DOTYCHCZASOWY/, /SPOS[OÓ]B/, /PODGRZEWANIA/, /C\.?W\.?U/] },
  { key: 'sposobCo', patterns: [/DOTYCHCZASOWY/, /SPOS[OÓ]B/, /PODGRZEWANIA/, /C\.?O/] },
  { key: 'instalacjaWodyCieplej', patterns: [/INSTALACJA/, /WODY/, /CIEP[LŁ]EJ/] },
  { key: 'instalacjaCoTyp', patterns: [/TYP/, /INSTALACJI/, /C\.?O/] },
  { key: 'zaworyMieszajace', patterns: [/RODZAJ/, /ISTNIEJ[AĄ]CYCH/, /ZAWOR[OÓ]W/] },
  { key: 'gleba', patterns: [/RODZAJ/, /GLEBY/] },
  { key: 'kolizje', patterns: [/KOLIZJE/] },
  { key: 'koniec', patterns: [/JAKO/, /OSOBA/, /UPOWA[ZŻ]NIONA/] }
];

// Znajduje wszystkie poczatki sekcji na stronie, posortowane wg pozycji w
// tekscie - uzywane do wyznaczenia "dokad siega" dana sekcja (do poczatku
// nastepnej).
function findAllSectionStarts(words) {
  const found = [];
  for (const section of SECTION_HEADERS) {
    let from = 0;
    const label = findLabel(words, section.patterns, from);
    if (label) found.push({ key: section.key, start: label.indices[0], end: Math.max(...label.indices) });
  }
  return found.sort((a, b) => a.start - b.start);
}

// Zwraca [rangeStart, rangeEnd) - slowa nalezace do sekcji `sectionKey` (od
// konca jej naglowka do poczatku nastepnej sekcji na stronie, albo do konca
// listy slow).
function findSectionRange(words, sectionStarts, sectionKey) {
  const idx = sectionStarts.findIndex((s) => s.key === sectionKey);
  if (idx === -1) return null;
  const start = sectionStarts[idx].end + 1;
  const end = idx + 1 < sectionStarts.length ? sectionStarts[idx + 1].start : words.length;
  return { start, end };
}

// --- Pola bez sekcji (etykieta jednoznaczna na calej stronie) ----------

const SIMPLE_FIELDS = [
  { key: 'imieNazwisko', columnLabel: 'Imię i nazwisko', labelPatterns: [/IMI/, /NAZWISKO/, /UCZESTNIKA/, /PROJEKTU|W[LŁ]A[SŚ]CICIELA/] },
  { key: 'telefon', columnLabel: 'Telefon', labelPatterns: [/TELEFON/] },
  { key: 'email', columnLabel: 'E-mail', labelPatterns: [/E-?MAIL/] },
  { key: 'dataProtokolu', columnLabel: 'Data sporządzenia protokołu', labelPatterns: [/SPORZ/, /DNIA/] },
  { key: 'rokBudowy', columnLabel: 'Rok budowy budynku', labelPatterns: [/ROK/, /BUDOWY/, /BUDYNKU/] },
  { key: 'liczbaOsob', columnLabel: 'Liczba osób w gospodarstwie', labelPatterns: [/LICZBA/, /OS[OÓ]B/, /GOSPODARSTWIE/] },
  { key: 'powierzchnia', columnLabel: 'Powierzchnia ogrzewana', labelPatterns: [/POWIERZCHNIA/, /OGRZEWAN/, /BUDYNKU/] },
  { key: 'iloscKondygnacji', columnLabel: 'Ilość kondygnacji', labelPatterns: [/ILO[SŚ][CĆ]/, /KONDYGNACJI/] },
  { key: 'wysokoscPiwnica', columnLabel: 'Wysokość - piwnica', labelPatterns: [/PIWNIC/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/] },
  { key: 'wysokoscParter', columnLabel: 'Wysokość - parter', labelPatterns: [/PARTER/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/] },
  { key: 'wysokoscPietro', columnLabel: 'Wysokość - piętro', labelPatterns: [/PI[EĘ]TRO/, /ILO[SŚ][CĆ]/] },
  { key: 'wysokoscPoddasze', columnLabel: 'Wysokość - poddasze', labelPatterns: [/PODDASZE/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/] },
  { key: 'wysokoscStrych', columnLabel: 'Wysokość - strych', labelPatterns: [/STRYCH/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/] },
  { key: 'katDachuPlaski', columnLabel: 'Kąt dachu (płaski)', labelPatterns: [/P[LŁ]ASKI/, /K[AĄ]T/, /DACHU/] },
  { key: 'katDachuSkosny', columnLabel: 'Kąt dachu (skośny)', labelPatterns: [/SKO[SŚ]NY/, /K[AĄ]T/, /DACHU/] },
  // Strona 2 - pola tekstowe/numeryczne bez checkboxow
  { key: 'miejsceBufor', columnLabel: 'Planowane miejsce na bufor', labelPatterns: [/PLANOWANE/, /MIEJSCE/, /NA/, /BUFOR/] },
  { key: 'wysokoscPomieszczeniaBufor', columnLabel: 'Wysokość pomieszczenia (bufor)', labelPatterns: [/WYSOKO[SŚ][CĆ]/, /POMIESZCZENIA/] },
  { key: 'opisPodlogiBufor', columnLabel: 'Opis podłogi w pomieszczeniu', labelPatterns: [/OPIS/, /POD[LŁ]OGI/, /W/, /POMIESZCZENIU/] },
  { key: 'odlegloscPompyOdBufora', columnLabel: 'Odległość pompy ciepła od bufora', labelPatterns: [/ODLEG[LŁ]O[SŚ][CĆ]/, /POMPY/, /CIEP[LŁ]A/, /OD/, /BUFORA/] },
  { key: 'szerokoscPrzewezenia', columnLabel: 'Szerokość przewężenia', labelPatterns: [/SZEROKO[SŚ][CĆ]/, /PRZEW[EĘ][ZŻ]ENIA/, /DROGA/, /WNIESIENIA/, /URZ[AĄ]DZE[NŃ]/] },
  { key: 'mocPrzylacza', columnLabel: 'Przyznana moc przyłącza elektrycznego', labelPatterns: [/PRZYZNANA/, /MOC/, /PRZY[LŁ][AĄ]CZA/, /ELEKTRYCZNEGO/] },
  { key: 'zabezpieczenieGlowne', columnLabel: 'Zabezpieczenie elektryczne główne', labelPatterns: [/ZABEZPIECZENIE/, /ELEKTRYCZNE/, /G[LŁ][OÓ]WNE/] },
  { key: 'zuzycieObecnegoPaliwa', columnLabel: 'Roczne zużycie obecnego paliwa', labelPatterns: [/ROCZNE/, /ZU[ZŻ]YCIE/, /OBECNEGO/, /PALIWA/] },
  { key: 'iloscObiegowGrzewczych', columnLabel: 'Ilość wydzielonych obiegów grzewczych', labelPatterns: [/ILO[SŚ][CĆ]/, /WYDZIELONYCH/, /OBIEG[OÓ]W/] },
  { key: 'iloscZaworowMieszajacych', columnLabel: 'Ilość obiegów z zaworami mieszającymi', labelPatterns: [/ILO[SŚ][CĆ]/, /OBIEG[OÓ]W/, /C\.?O/, /WYPOSA[ZŻ]ONYCH/] },
  { key: 'udzialGrzejnikowy', columnLabel: 'Udział ogrzewania grzejnikowego (%)', labelPatterns: [/UDZIA[LŁ]/, /OGRZEWANIA/, /GRZEJNIKOWEGO/] },
  { key: 'udzialPlaszczyznowy', columnLabel: 'Udział ogrzewania płaszczyznowego (%)', labelPatterns: [/UDZIA[LŁ]/, /OGRZEWANIA/, /P[LŁ]ASZCZYZNOWEGO/] },
  { key: 'temperaturaPomieszczenia', columnLabel: 'Żądana temperatura w pomieszczeniach', labelPatterns: [/[ZŻ][AĄ]DANA/, /TEMPERATURA/, /W/, /POMIESZCZENIACH/] },
  { key: 'temperaturaCwu', columnLabel: 'Żądana temperatura c.w.u.', labelPatterns: [/[ZŻ][AĄ]DANA/, /TEMPERATURA/, /C\.?W\.?U/] },
  { key: 'powierzchniaDzialki', columnLabel: 'Powierzchnia działki (dolne źródło)', labelPatterns: [/POWIERZCHNIA/, /DZIA[LŁ]KI/] }
];

// --- Pola zagniezdzone w sekcjach (ta sama pod-etykieta powtarza sie w
// kilku sekcjach, dlatego wymagaja ograniczenia zakresu) ----------------

const SECTION_SUBFIELDS = [
  { key: 'dataMontażuOkien', columnLabel: 'Data montażu stolarki okiennej', sectionKey: 'stolarka', labelPatterns: [/PRZYBLI[ZŻ]ONA/, /DATA/, /MONTA[ZŻ]U/] },
  { key: 'wymiaryDrzwiZewn', columnLabel: 'Wymiary drzwi zewnętrznych', sectionKey: 'drzwiZewn', labelPatterns: [/WYMIARY/] },
  { key: 'dataMontażuDrzwiZewn', columnLabel: 'Data montażu drzwi zewnętrznych', sectionKey: 'drzwiZewn', labelPatterns: [/PRZYBLI[ZŻ]ONA/, /DATA/, /MONTA[ZŻ]U/] },
  { key: 'iloscDrzwiZewn', columnLabel: 'Ilość drzwi zewnętrznych', sectionKey: 'drzwiZewn', labelPatterns: [/ILO[SŚ][CĆ]/] },
  { key: 'wymiaryDrzwiGaraz', columnLabel: 'Wymiary drzwi garażowych', sectionKey: 'drzwiGaraz', labelPatterns: [/WYMIARY/] },
  { key: 'dataMontażuDrzwiGaraz', columnLabel: 'Data montażu drzwi garażowych', sectionKey: 'drzwiGaraz', labelPatterns: [/PRZYBLI[ZŻ]ONA/, /DATA/, /MONTA[ZŻ]U/] },
  { key: 'iloscDrzwiGaraz', columnLabel: 'Ilość drzwi garażowych', sectionKey: 'drzwiGaraz', labelPatterns: [/ILO[SŚ][CĆ]/] },
  // Dodane po porownaniu z prawdziwym cyfrowym raportem "Ustalenia
  // montazowe" (rodzina B, ktorej audytow firma sie pozbywa, ale ktora
  // pokazuje pelen zestaw pol biznesowych do Excela) - "Grubosc izolacji
  // dachu" jest tez na papierowym formularzu ("Izolacja dachu: Tak...,
  // grubosc: ...cm"), po prostu nie zostalo dodane w ETAP5/6.
  { key: 'grubIzolacjiDachu', columnLabel: 'Grubość izolacji dachu', sectionKey: 'dach', labelPatterns: [/GRUBO[SŚ][CĆ]/] }
];

const CHECKBOX_FIELDS = [
  {
    key: 'wentylacja', columnLabel: 'Wentylacja',
    options: [
      { label: 'Grawitacyjna', patterns: [/GRAWITACYJNA/] },
      { label: 'Mechaniczna', patterns: [/MECHANICZNA/] },
      { label: 'Odzysk ciepła', patterns: [/ODZYSK/] }
    ]
  },
  {
    key: 'typKonstrukcji', columnLabel: 'Typ konstrukcji',
    options: [
      { label: 'Lekka', patterns: [/LEKKA/] },
      { label: 'Średnia', patterns: [/[SŚ]REDNIA/] },
      { label: 'Ciężka', patterns: [/CI[EĘ][ZŻ]KA/] }
    ]
  },
  {
    key: 'stopienSzczelnosci', columnLabel: 'Stopień szczelności',
    options: [
      { label: 'Niski', patterns: [/NISKI/] },
      { label: 'Średni', patterns: [/[SŚ]REDNI\b/] },
      { label: 'Wysoki', patterns: [/WYSOKI/] }
    ]
  },
  {
    key: 'klasaOslonieciaBudynku', columnLabel: 'Klasa osłonięcia budynku',
    options: [
      { label: 'Brak', patterns: [/BRAK/] },
      { label: 'Średnie', patterns: [/[SŚ]REDNIE/] },
      { label: 'Dobre', patterns: [/DOBRE/] }
    ]
  },
  {
    key: 'rodzajDachu', columnLabel: 'Rodzaj dachu',
    options: [
      { label: 'Płaski', patterns: [/P[LŁ]ASKI/] },
      { label: 'Skośny', patterns: [/SKO[SŚ]NY/] }
    ]
  },
  {
    key: 'pokrycieDachu', columnLabel: 'Pokrycie dachu',
    options: [
      { label: 'Blachodachówka', patterns: [/BLACHODACH/] },
      { label: 'Dachówka ceramiczna', patterns: [/DACH[OÓ]WKA/] },
      { label: 'Papa', patterns: [/PAPA/] },
      { label: 'Membrana', patterns: [/MEMBRANA/] }
    ]
  },
  {
    key: 'typOkien', columnLabel: 'Typ okien',
    options: [
      { label: 'Jednoszybowe', patterns: [/JEDNOSZYBOWE/] },
      { label: 'Dwuszybowe', patterns: [/DWUSZYBOWE/] },
      { label: 'Trzyszybowe', patterns: [/TRZYSZYBOWE/] }
    ]
  },
  {
    key: 'materialOkien', columnLabel: 'Materiał okien',
    options: [
      { label: 'Plastik', patterns: [/PLASTIK/] },
      { label: 'Drewno', patterns: [/DREWNO/] },
      { label: 'Aluminium', patterns: [/ALUMINIUM/] }
    ]
  },
  {
    key: 'materialDrzwiZewn', columnLabel: 'Materiał drzwi zewnętrznych',
    options: [
      { label: 'Plastik', patterns: [/PLASTIK/] },
      { label: 'Drewno', patterns: [/DREWNO/] },
      // Zakotwiczone do calego slowa (nie samo /STAL/) - "STAL" jest
      // podciagiem "STALOWE" (grzejniki, strona 2), bez tego kotwiczenia
      // zaznaczony checkbox przy "Stalowe" grzejniki falszywie pasowalby
      // tez jako material drzwi.
      { label: 'Stal', patterns: [/^STAL$/] }
    ]
  },
  // Strona 2 - grupy checkboxow bez potrzeby zawezania do sekcji (tresc
  // opcji jednoznaczna na calej stronie)
  {
    key: 'typInstalacjiCo', columnLabel: 'Typ instalacji c.o.',
    options: [
      { label: 'Grzejnikowa', patterns: [/GRZEJNIKOWA/] },
      { label: 'Płaszczyznowa', patterns: [/P[LŁ]ASZCZYZNOWA/] },
      { label: 'Mieszana', patterns: [/MIESZANA/] }
    ]
  },
  {
    key: 'rodzajGrzejnikow', columnLabel: 'Rodzaj grzejników',
    options: [
      { label: 'Aluminiowe', patterns: [/ALUMINIOWE/] },
      { label: 'Żeliwne', patterns: [/[ZŻ]ELIWNE/] },
      { label: 'Stalowe', patterns: [/STALOWE/] }
    ]
  },
  {
    key: 'rodzajGleby', columnLabel: 'Rodzaj gleby (sondy pionowe)',
    options: [
      { label: 'Sucha piaszczysta', patterns: [/SUCHA/, /PIASZCZYSTA/] },
      { label: 'Wilgotna piaszczysta', patterns: [/WILGOTNA/, /PIASZCZYSTA/] },
      { label: 'Sucha gliniasta', patterns: [/SUCHA/, /GLINIASTA/] },
      { label: 'Wilgotna gliniasta', patterns: [/WILGOTNA/, /GLINIASTA/] },
      { label: 'Przewodząca wody gruntowe', patterns: [/PRZEWODZ[AĄ]CA/] }
    ]
  }
];

// Strona 2 - pola wyboru "na tej samej linii co etykieta" (np. "Gniazdo
// elektryczne: [ ]Tak [x]Nie") - w odroznieniu od CHECKBOX_FIELDS (ktore
// szuka opcji GDZIEKOLWIEK na stronie po samej tresci opcji), te pola maja
// zbyt ogolna tresc opcji (Tak/Nie powtarza sie dziesiatki razy na stronie
// 2), wiec musza byc zakotwiczone do KONKRETNEGO wystapienia etykiety -
// reuzywa wiec collectValueWords (ta sama mechanika co SIMPLE_FIELDS: szuka
// tylko na tej samej linii, na prawo od TEJ etykiety), a nie
// findCheckedOption (ktore przeszukuje cala/zakresowa strone).
const INLINE_CHOICE_FIELDS = [
  { key: 'gniazdoElektryczne', columnLabel: 'Gniazdo elektryczne', labelPatterns: [/GNIAZDO/, /ELEKTRYCZNE/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'dostepInternet', columnLabel: 'Dostęp do internetu (bufor)', labelPatterns: [/DOST[EĘ]P/, /DO/, /INTERNETU/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'typInstalacjiElektrycznej', columnLabel: 'Typ instalacji elektrycznej', labelPatterns: [/TYP/, /INSTALACJI/, /ELEKTRYCZNEJ/], choices: [{ label: '3-fazowa', pattern: /3-?FAZOWA/ }, { label: '1-fazowa', pattern: /1-?FAZOWA/ }, { label: 'Brak', pattern: /BRAK/ }] },
  { key: 'zasobnikCwu', columnLabel: 'Miejsce na zasobnik c.w.u.', labelPatterns: [/PLANOWANE/, /MIEJSCE/, /NA/, /ZASOBNIK/], choices: [{ label: 'Takie samo jak bufor', pattern: /TAKIE/ }, { label: 'Inne', pattern: /INNE/ }] },
  { key: 'rodzajInstalacjiCoOtwZamk', columnLabel: 'Rodzaj instalacji c.o. (otwarta/zamknięta)', labelPatterns: [/RODZAJ/, /ISTNIEJ[AĄ]CEJ/, /INSTALACJI/, /C\.?O/], choices: [{ label: 'Układ otwarty', pattern: /OTWARTY/ }, { label: 'Układ zamknięty', pattern: /ZAMKNI[EĘ]TY/ }] },
  { key: 'demontazZrodla', columnLabel: 'Demontaż istniejącego źródła ciepła', labelPatterns: [/DEMONTA[ZŻ]/, /ISTNIEJ[AĄ]CEGO/, /[ZŹ]R[OÓ]D[LŁ]A/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'instalacjaSolarna', columnLabel: 'Istniejąca instalacja solarna', labelPatterns: [/ISTNIEJ[AĄ]CA/, /INSTALACJA/, /SOLARNA/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'cyrkulacjaCwu', columnLabel: 'Cyrkulacja c.w.u.', labelPatterns: [/CYRKULACJA/, /C\.?W\.?U/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'pompaCyrkulacji', columnLabel: 'Pompa cyrkulacji c.w.u.', labelPatterns: [/POMPA/, /CYRKULACJI/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'kratkaOdplywowa', columnLabel: 'Kratka odpływowa', labelPatterns: [/KRATKA/, /ODP[LŁ]YWOWA/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'reduktorWody', columnLabel: 'Reduktor na wodzie zimnej', labelPatterns: [/REDUKTOR/, /NA/, /WODZIE/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'demontazKostki', columnLabel: 'Demontaż kostki brukowej (prace ziemne)', labelPatterns: [/DEMONTA[ZŻ]/, /KOSTKI/, /BRUKOWEJ/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'usuniecieDrzew', columnLabel: 'Usunięcie drzew/krzewów (prace ziemne)', labelPatterns: [/USUNI[EĘ]CIE/, /DRZEW/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] }
];

// Strona 2 - pole wielokrotnego wyboru (kolizje z uzbrojeniem podziemnym) -
// w odroznieniu od CHECKBOX_FIELDS/findCheckedOption (zwraca PIERWSZA
// zaznaczona opcje), tu moze byc zaznaczonych kilka na raz.
const MULTI_CHECKBOX_FIELDS = [
  {
    key: 'kolizjeUzbrojenie', columnLabel: 'Kolizje z uzbrojeniem podziemnym', sectionKey: 'kolizje',
    options: [
      { label: 'Wodociągowa', patterns: [/WODOCI[AĄ]GOWA/] },
      { label: 'Kanalizacyjna', patterns: [/\bKANALIZACYJNA\b/] },
      { label: 'Ciepłownicza', patterns: [/CIEP[LŁ]OWNICZA/] },
      { label: 'Gazowa', patterns: [/GAZOWA\b/] },
      { label: 'Elektryczna', patterns: [/ELEKTRYCZNA\b/] },
      { label: 'Kanalizacja deszczowa', patterns: [/DESZCZOWA/] },
      { label: 'Korona drzew', patterns: [/KORONA/] }
    ]
  }
];

// Pola typu "zaznaczona linia z liczba mocy w kW" - checkbox jest na
// POCZATKU dlugiej linii, daleko (w slowach) od liczby ktora odrozniaja
// opcje, wiec findCheckedOption (patrzy tylko 1 slowo wstecz) nie
// wystarcza - potrzebne grupowanie w linie (findCheckedLine).
const CHECKED_LINE_FIELDS = [
  { key: 'urzadzenie', columnLabel: 'Typ i moc dobranego urządzenia', sectionKey: 'urzadzenie', contentPattern: /KW/ },
  // Strona 2 - listy dlugich opcji (kociol na paliwo stale/biomase/gaz/...)
  // - contentPattern permisywny (kazda niepusta linia), bo dyskryminacja
  // dzieje sie juz przez sectionKey (zakres slow ograniczony do wlasciwej
  // sekcji c.w.u. vs c.o.), nie przez tresc linii.
  { key: 'sposobCwu', columnLabel: 'Dotychczasowy sposób podgrzewania c.w.u.', sectionKey: 'sposobCwu', contentPattern: /./ },
  { key: 'sposobCo', columnLabel: 'Dotychczasowy sposób podgrzewania c.o.', sectionKey: 'sposobCo', contentPattern: /./ }
];

// Pola "material + grubosc" - najbardziej niepewna kategoria, celowo z
// ograniczona pewnoscia (COMPOSITE_CONFIDENCE_CAP), bo lączą dwa niezalezne
// odczyty (ktory checkbox + jaka liczba obok).
const MATERIAL_FIELDS = [
  {
    key: 'scianaZewnMaterial', columnLabel: 'Ściana zewnętrzna (materiał, grubość)', sectionKey: 'scianaZewn',
    options: [
      { label: 'Cegła ceramiczna pełna', patterns: [/CEG[LŁ]A/, /CERAMICZNA/] },
      { label: 'Cegła dziurawka', patterns: [/CEG[LŁ]A/, /DZIURAWKA/] },
      { label: 'Bloczki z betonu komórkowego', patterns: [/BLOCZKI/, /BETON/] },
      { label: 'Bloczki silikatowe', patterns: [/BLOCZKI/, /SILIKATOWE/] },
      { label: 'Pustak keramzytobetonowe', patterns: [/PUSTAK/] },
      { label: 'Drewno', patterns: [/DREWNO/] }
    ]
  },
  {
    key: 'ocieplenieScianyZewn', columnLabel: 'Ocieplenie ściany zewnętrznej (materiał, grubość)', sectionKey: 'ocieplenie',
    options: [
      { label: 'Styropian', patterns: [/STYROPIAN/] },
      { label: 'Wełna mineralna', patterns: [/WE[LŁ]NA/] },
      { label: 'Pustka powietrzna', patterns: [/PUSTKA/] },
      { label: 'Pianka PUR', patterns: [/PIANKA/] }
    ]
  },
  // Sekcja 'scianaFundamentowa' juz istniala w SECTION_HEADERS od ETAP5, ale
  // zaden field jej nie uzywal - prawdziwy przeoczony field, odkryty przy
  // porownaniu z cyfrowym raportem "Ustalenia montazowe" (patrz komentarz
  // przy grubIzolacjiDachu wyzej).
  {
    key: 'scianaFundamentowaMaterial', columnLabel: 'Ściana fundamentowa (materiał, grubość)', sectionKey: 'scianaFundamentowa',
    options: [
      { label: 'Beton', patterns: [/^BETON$/] },
      { label: 'Żużel', patterns: [/[ZŻ]U[ZŻ]EL/] },
      { label: 'Cegła pełna', patterns: [/CEG[LŁ]A/, /PE[LŁ]NA/] },
      { label: 'Pustak', patterns: [/PUSTAK/] },
      { label: 'Kamień', patterns: [/KAMIE[NŃ]/] },
      { label: 'Bloczek betonowy', patterns: [/BLOCZEK/] }
    ]
  },
  {
    key: 'stropOgrzewane', columnLabel: 'Strop nad ogrzewanymi (materiał, grubość)', sectionKey: 'stropOgrzewane',
    options: [
      { label: 'Strop żelbetowy monolityczny', patterns: [/STROP/, /[ZŻ]ELBETOWY/] },
      { label: 'Strop gęsto żebrowy', patterns: [/STROP/, /G[EĘ]STO/] },
      { label: 'Strop drewniany', patterns: [/STROP/, /DREWNIANY/] }
    ]
  },
  {
    key: 'stropNieogrzewane', columnLabel: 'Strop nad nieogrzewanymi (materiał, grubość)', sectionKey: 'stropNieogrzewane',
    options: [
      { label: 'Strop żelbetowy monolityczny', patterns: [/STROP/, /[ZŻ]ELBETOWY/] },
      { label: 'Strop gęsto żebrowy', patterns: [/STROP/, /G[EĘ]STO/] },
      { label: 'Strop drewniany', patterns: [/STROP/, /DREWNIANY/] }
    ]
  },
  // Strona 2 - rodzaj rur instalacji (c.o./wody zimnej/wody cieplej maja
  // identyczna trojke opcji "Rury miedziane / Rury ocynkowane-stalowe /
  // Rury z tworzywa PP", wiec kazda MUSI byc zawezona do wlasciwej sekcji,
  // inaczej wszystkie trzy zwracalyby ta sama, pierwsza znaleziona opcje.
  // Zastepuje dawne pole specyficzne dla Rzgowa/Wilczyna (wzorce etykiet
  // tam byly inne slowoformy - "stalowych"/"miedzianych" - rozszerzone tu
  // do rdzenia slowa, zeby pasowaly do obu wariantow jednym polem).
  {
    key: 'instalacjaCoRury', columnLabel: 'Instalacja c.o. - rodzaj rur', sectionKey: 'instalacjaCo',
    options: [
      { label: 'Miedziane', patterns: [/RURY/, /MIEDZIAN/] },
      { label: 'Ocynkowane / stalowe', patterns: [/RURY/, /OCYNKOWAN/] },
      { label: 'Z tworzywa PP', patterns: [/RURY/, /TWORZYWA/] }
    ]
  },
  {
    key: 'instalacjaWodyZimnejRury', columnLabel: 'Instalacja wody zimnej - rodzaj rur', sectionKey: 'instalacjaWody',
    options: [
      { label: 'Miedziane', patterns: [/RURY/, /MIEDZIAN/] },
      { label: 'Ocynkowane / stalowe', patterns: [/RURY/, /OCYNKOWAN/] },
      { label: 'Z tworzywa PP', patterns: [/RURY/, /TWORZYWA/] }
    ]
  },
  {
    key: 'instalacjaWodyCieplejRury', columnLabel: 'Instalacja wody ciepłej - rodzaj rur', sectionKey: 'instalacjaWodyCieplej',
    options: [
      { label: 'Miedziane', patterns: [/RURY/, /MIEDZIAN/] },
      { label: 'Ocynkowane / stalowe', patterns: [/RURY/, /OCYNKOWAN/] },
      { label: 'Z tworzywa PP', patterns: [/RURY/, /TWORZYWA/] }
    ]
  },
  {
    key: 'zaworyMieszajaceRodzaj', columnLabel: 'Rodzaj zaworów mieszających (ilość)', sectionKey: 'zaworyMieszajace',
    options: [
      { label: 'Termostatyczne', patterns: [/TERMOSTATYCZNE/] },
      { label: 'Z siłownikiem', patterns: [/SI[LŁ]OWNIKIEM/] }
    ]
  }
];

// Pola specyficzne dla wariantu Rzgow/Wilczyn - puste dla wiekszosci
// pozostalych inwestycji, co jest oczekiwane (jeden uniwersalny zestaw
// kolumn, patrz plan).
const RZGOW_SIMPLE_FIELDS = [
  { key: 'istniejaceZrodloCiepla', columnLabel: 'Istniejące źródło ciepła', labelPatterns: [/ISTNIEJ[AĄ]CE/, /[ZŹ]R[OÓ]D[LŁ]O/, /CIEP[LŁ]A/] }
];

const ALL_LABEL_PATTERNS = SIMPLE_FIELDS.map((f) => f.labelPatterns);

const COLUMN_ORDER = [
  'adres',
  ...SIMPLE_FIELDS.map((f) => f.key),
  ...SECTION_SUBFIELDS.map((f) => f.key),
  ...CHECKED_LINE_FIELDS.map((f) => f.key),
  ...CHECKBOX_FIELDS.map((f) => f.key),
  ...INLINE_CHOICE_FIELDS.map((f) => f.key),
  ...MULTI_CHECKBOX_FIELDS.map((f) => f.key),
  ...MATERIAL_FIELDS.map((f) => f.key),
  ...RZGOW_SIMPLE_FIELDS.map((f) => f.key)
];
const COLUMN_LABELS = { adres: 'Adres' };
for (const f of [...SIMPLE_FIELDS, ...SECTION_SUBFIELDS, ...CHECKED_LINE_FIELDS, ...CHECKBOX_FIELDS, ...INLINE_CHOICE_FIELDS, ...MULTI_CHECKBOX_FIELDS, ...MATERIAL_FIELDS, ...RZGOW_SIMPLE_FIELDS]) {
  COLUMN_LABELS[f.key] = f.columnLabel;
}

function extractSimpleField(words, def, pageWidth, rangeStart = 0, rangeEnd) {
  const label = findLabel(words.slice(0, rangeEnd), def.labelPatterns, rangeStart);
  if (!label) return { value: '', confidence: null, found: false };
  const labelWords = label.indices.map((idx) => words[idx]);
  const labelBBox = unionBBox(labelWords);
  const valueWords = collectValueWords(words, Math.max(...label.indices) + 1, labelBBox, pageWidth, ALL_LABEL_PATTERNS);
  if (!valueWords.length) return { value: '', confidence: null, found: true, labelBBox };
  return {
    value: valueWords.map((w) => w.text).join(' ').trim(),
    confidence: wordConfidence(valueWords),
    found: true,
    labelBBox,
    valueBBox: unionBBox(valueWords)
  };
}

function extractCheckboxField(words, def, rangeStart = 0, rangeEnd) {
  const checked = findCheckedOption(words, def.options, rangeStart, rangeEnd);
  if (!checked) return { value: '', confidence: null, found: false };
  if (!checked.option) return { value: '', confidence: null, found: true };
  return {
    value: checked.option.label,
    confidence: wordConfidence(checked.words),
    found: true,
    labelBBox: unionBBox(checked.words),
    valueBBox: unionBBox(checked.words)
  };
}

// UWAGA: ta funkcja jest wywolywana WYLACZNIE po tym, jak petla w
// extractFields juz potwierdzila, ze sekcja `def.sectionKey` istnieje na
// stronie (inaczej zwraca found:false wczesniej, przed wywolaniem tej
// funkcji) - wiec brak dopasowanej linii tutaj oznacza "pytanie istnieje w
// dokumencie, ale nic nie zaznaczono/nie udalo sie odczytac", NIE "tego
// pytania tu nie ma" - stad found:true, nie false.
function extractCheckedLineField(words, def, rangeStart, rangeEnd) {
  const found = findCheckedLine(words, rangeStart, rangeEnd, def.contentPattern);
  if (!found) return { value: '', confidence: null, found: true };
  return {
    value: found.text,
    confidence: Math.min(wordConfidence(found.words) ?? 1, COMPOSITE_CONFIDENCE_CAP),
    found: true,
    labelBBox: unionBBox(found.words),
    valueBBox: unionBBox(found.words)
  };
}

function extractMaterialField(words, def, rangeStart, rangeEnd) {
  const checked = findCheckedOption(words, def.options, rangeStart, rangeEnd);
  if (!checked) return { value: '', confidence: null, found: false };
  if (!checked.option) return { value: '', confidence: null, found: true };
  const optionBBox = unionBBox(checked.words);
  const numberWords = collectValueWords(words, Math.max(...checked.words.map((w) => words.indexOf(w))) + 1, optionBBox, Infinity, []);
  const numeric = numberWords.find((w) => /\d/.test(w.text));
  const value = numeric ? `${checked.option.label}, ${numeric.text}` : checked.option.label;
  const conf = Math.min(wordConfidence(checked.words) ?? 1, COMPOSITE_CONFIDENCE_CAP);
  return { value, confidence: conf, found: true, labelBBox: optionBBox, valueBBox: numeric ? bbox(numeric) : optionBBox };
}

// Jak extractSimpleField, ale zamiast zwracac caly zebrany tekst, szuka
// wsrod zebranych slow tokenu odpowiadajacego jednej z `def.choices` I
// niosacego znacznik zaznaczenia (na sobie albo na poprzednim slowie) -
// patrz komentarz przy INLINE_CHOICE_FIELDS.
function extractInlineChoiceField(words, def, pageWidth, rangeStart = 0, rangeEnd) {
  const label = findLabel(words.slice(0, rangeEnd), def.labelPatterns, rangeStart);
  if (!label) return { value: '', confidence: null, found: false };
  const labelWords = label.indices.map((idx) => words[idx]);
  const labelBBox = unionBBox(labelWords);
  const valueWords = collectValueWords(words, Math.max(...label.indices) + 1, labelBBox, pageWidth, ALL_LABEL_PATTERNS);
  for (let i = 0; i < valueWords.length; i++) {
    const text = valueWords[i].text.toUpperCase();
    const prevText = i > 0 ? valueWords[i - 1].text : '';
    if (!CHECKBOX_CHECKED.test(text) && !CHECKBOX_CHECKED.test(prevText)) continue;
    const choice = def.choices.find((c) => c.pattern.test(text));
    if (!choice) continue;
    return {
      value: choice.label,
      confidence: Math.min(wordConfidence([valueWords[i]]) ?? 1, COMPOSITE_CONFIDENCE_CAP),
      found: true,
      labelBBox,
      valueBBox: bbox(valueWords[i])
    };
  }
  return { value: '', confidence: null, found: true, labelBBox };
}

// Jak findCheckedOption, ale zwraca WSZYSTKIE zaznaczone opcje, nie tylko
// pierwsza - potrzebne dla pol wielokrotnego wyboru (np. kolizje z
// uzbrojeniem podziemnym, gdzie moze byc zaznaczonych kilka na raz).
function findAllCheckedOptions(words, options, rangeStart = 0, rangeEnd) {
  const end = rangeEnd ?? words.length;
  const found = [];
  for (const option of options) {
    let searchFrom = rangeStart;
    while (searchFrom < end) {
      const label = findLabel(words.slice(0, end), option.patterns, searchFrom);
      if (!label) break;
      const firstIdx = label.indices[0];
      const candidates = [words[firstIdx].text, firstIdx > 0 ? words[firstIdx - 1].text : ''];
      if (candidates.some((t) => CHECKBOX_CHECKED.test(t))) {
        found.push({ option, words: label.indices.map((idx) => words[idx]) });
        break;
      }
      searchFrom = firstIdx + 1;
    }
  }
  return found;
}

// Jak extractCheckedLineField - wywolywana tylko gdy sekcja juz potwierdzona
// istniejaca (patrz komentarz tam) - brak zaznaczonych opcji tutaj oznacza
// "pytanie jest, nic nie zaznaczono", nie "pytania tu nie ma".
function extractMultiCheckboxField(words, def, rangeStart, rangeEnd) {
  const found = findAllCheckedOptions(words, def.options, rangeStart, rangeEnd);
  if (!found.length) return { value: '', confidence: null, found: true };
  const allWords = found.flatMap((f) => f.words);
  return {
    value: found.map((f) => f.option.label).join(', '),
    confidence: Math.min(wordConfidence(allWords) ?? 1, COMPOSITE_CONFIDENCE_CAP),
    found: true,
    labelBBox: unionBBox(allWords),
    valueBBox: unionBBox(allWords)
  };
}

// found:false znaczy "ta etykieta/checkbox/sekcja NIE wystapila ANI RAZU w
// calym dokumencie" - to pole strukturalnie nie dotyczy TEGO KONKRETNEGO
// formularza (np. pole specyficzne dla wariantu Rzgow na dokumencie z innej
// gminy, albo cala sekcja z drugiej strony formularza ktorej dany szablon
// nie ma) - uzytkownik i tak nie ma czego przepisac ze skanu, wiec NIE
// trafia do kolejki recznego przegladu (needsReview:false, resolved:true od
// razu, puste w Excelu) - odroznione od found:true+value:'' (etykieta
// istnieje, ale nic nie zaznaczono/nie udalo sie odczytac - TO juz jest
// prawdziwy przypadek do przegladu). Wlasciciel zglosil realny problem
// 2026-07-21: 200 pol do recznego uzupelnienia przy tescie 4-adresowej
// paczki, z czego znaczna czesc to byly pola nieistniejace w konkretnym
// dokumencie (nie prawdziwe braki) - to rozroznienie jest bezposrednia
// odpowiedzia na ten problem.
function toFieldResult(extracted, pageIndex) {
  if (!extracted.found) {
    return { value: '', confidence: null, pageIndex, labelBBox: null, valueBBox: null, needsReview: false, resolved: true };
  }
  const needsReview = !extracted.value || extracted.confidence === null || extracted.confidence < LOW_CONFIDENCE_THRESHOLD;
  return {
    value: extracted.value || '',
    confidence: extracted.confidence,
    pageIndex,
    labelBBox: extracted.labelBBox || null,
    valueBBox: extracted.valueBBox || extracted.labelBBox || null,
    needsReview,
    resolved: !needsReview
  };
}

// Laczy slowa wszystkich stron bloku - fieldExtraction dziala na
// POJEDYNCZEJ stronie na raz (realne formularze nie rozdzielaja jednego
// pola na dwie strony), probujac kazda strone bloku po kolei.
function extractFields(pages, block) {
  const blockPages = pages.slice(block.startPage, block.endPage + 1).filter((p) => p.imagePath && p.ocrWords);
  const result = {};

  const perPageSections = new Map();
  for (const page of blockPages) perPageSections.set(page.pageIndex, findAllSectionStarts(page.ocrWords));

  function tryEachPage(fn) {
    let best = { value: '', confidence: null, found: false };
    let bestPageIndex = null;
    for (const page of blockPages) {
      const extracted = fn(page);
      if (extracted.found && extracted.value) return toFieldResult(extracted, page.pageIndex);
      if (extracted.found && !best.found) { best = extracted; bestPageIndex = page.pageIndex; }
    }
    return toFieldResult(best, bestPageIndex);
  }

  for (const def of SIMPLE_FIELDS) {
    result[def.key] = tryEachPage((page) => extractSimpleField(page.ocrWords, def, page.width));
  }

  for (const def of SECTION_SUBFIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey);
      if (!range) return { value: '', confidence: null, found: false };
      return extractSimpleField(page.ocrWords, def, page.width, range.start, range.end);
    });
  }

  for (const def of CHECKED_LINE_FIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey);
      if (!range) return { value: '', confidence: null, found: false };
      return extractCheckedLineField(page.ocrWords, def, range.start, range.end);
    });
  }

  for (const def of CHECKBOX_FIELDS) {
    result[def.key] = tryEachPage((page) => extractCheckboxField(page.ocrWords, def));
  }

  for (const def of INLINE_CHOICE_FIELDS) {
    result[def.key] = tryEachPage((page) => extractInlineChoiceField(page.ocrWords, def, page.width));
  }

  for (const def of MULTI_CHECKBOX_FIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = def.sectionKey ? findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey) : null;
      if (def.sectionKey && !range) return { value: '', confidence: null, found: false };
      return extractMultiCheckboxField(page.ocrWords, def, range?.start, range?.end);
    });
  }

  for (const def of MATERIAL_FIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = def.sectionKey ? findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey) : null;
      if (def.sectionKey && !range) return { value: '', confidence: null, found: false };
      return extractMaterialField(page.ocrWords, def, range?.start, range?.end);
    });
  }

  for (const def of RZGOW_SIMPLE_FIELDS) {
    result[def.key] = tryEachPage((page) => extractSimpleField(page.ocrWords, def, page.width));
  }

  return result;
}

module.exports = { extractFields, COLUMN_ORDER, COLUMN_LABELS, LOW_CONFIDENCE_THRESHOLD };
