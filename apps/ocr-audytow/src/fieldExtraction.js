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
// Niezaznaczony checkbox - UWAGA: celowo NIE laczymy tego z CHECKBOX_CHECKED
// w jeden "glif checkboxa" do zatrzymywania collectValueWords, bo
// extractInlineChoiceField WYMAGA, zeby zaznaczone "☑Tak"/"☒Nie" nadal
// przechodzily przez collectValueWords (to jest jego jedyny sygnal). Tylko
// NIEzaznaczony checkbox jest bezpieczny jako uniwersalna granica - to
// zawsze "nastepna, nieistotna opcja", nigdy czesc prawdziwej wartosci
// (realny bug zlapany 2026-07-22: "grubosc: 8 cm ☐Nie" dolaczalo "Nie" do
// wartosci jako smiec, bo nic wczesniej nie zatrzymywalo zbierania na
// niezaznaczonym checkboxie).
const CHECKBOX_UNCHECKED = /[☐□]/;

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
function collectValueWordsAtTolerance(words, labelEndIdx, labelBBox, pageWidth, allLabelPatterns, tolerance, gapMultiplier = 6) {
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
    if (Math.abs(midY - labelMidY) > labelHeight * tolerance) continue;
    if (b.minX < labelBBox.maxX - labelHeight * 0.3) continue; // musi byc na prawo od etykiety (z mala tolerancja)
    if (b.maxX > maxX || b.minX < minXAllowed) continue;
    candidates.push({ idx: i, word: w, b });
  }
  candidates.sort((a, b) => a.b.minX - b.b.minX);

  const collected = [];
  let prevMaxX = labelBBox.maxX;
  for (const c of candidates) {
    if (collected.length >= MAX_VALUE_WORDS) break;
    if (c.b.minX - prevMaxX > labelHeight * gapMultiplier) break;
    if (allLabelPatterns.length && startsAnyLabel(words, c.idx, allLabelPatterns)) break;
    // Niezaznaczony checkbox = poczatek NASTEPNEJ, nieistotnej opcji (np.
    // "grubosc: 8 cm ☐Nie") - break, nie continue, bo wszystko po tym
    // punkcie nalezy juz do czegos innego.
    if (CHECKBOX_UNCHECKED.test(c.word.text)) break;
    // Strona 2 ma kazde pytanie poprzedzone numerem porzadkowym ("23.",
    // "24." itd, patrz numeracja w tresci skanu) - taki sam token czasem
    // trafia geometrycznie zaraz PO wartosci poprzedniego pola (bo to
    // numer NASTEPNEGO pytania), wiec trzeba go pominac tak samo jak
    // interpunkcje, inaczej dolacza sie do wartosci poprzedniego pola.
    if (/^[.\-_:()]+$/.test(c.word.text) || /^\d{1,2}\.$/.test(c.word.text)) { prevMaxX = c.b.maxX; continue; }
    // Odreczny znak stopnia (°) bywa odczytany przez Vision jako osobny,
    // "obcy" token (np. cudzyslow/prim/diereza), nie jako literalne "°" -
    // to jest zawsze smiec dolaczony do liczby, nigdy sama wartosc (realny
    // przypadek zlapany 2026-07-22: "40°" -> "40 ¨ 0" - pomijamy, nie
    // zaliczamy do wartosci).
    if (/^[¨´`'"′″#^]+$/.test(c.word.text)) { prevMaxX = c.b.maxX; continue; }
    collected.push(c.word);
    prevMaxX = c.b.maxX;
  }
  return collected;
}

// Znajduje WSZYSTKIE wystapienia WSZYSTKICH znanych etykiet na stronie
// (SIMPLE_FIELDS + SECTION_SUBFIELDS - patrz ALL_LABEL_PATTERNS) - nie tylko
// tej jednej, ktorej aktualnie szukamy.
// Podstawa "strefowego" wyszukiwania wartosci (patrz
// collectValueWordsInZone) - pomysl wlasciciela 2026-07-22: zamiast zgadywac
// stala tolerancje wokol WLASNEJ etykiety pola, wyznaczamy PRAWDZIWA granice
// strefy odpowiedzi na podstawie pozycji SASIEDNICH, znanych pytan (ktore i
// tak juz niezawodnie znajdujemy) - dokladnie tak jakbysmy znali uklad
// czystego wzoru formularza, tylko wyprowadzone z tego, co juz i tak wiemy,
// bez osobnego rejestru/wyrownywania skanu do referencyjnego wzoru.
function findAllKnownLabelPositions(words) {
  const positions = [];
  // Oprocz ALL_LABEL_PATTERNS (etykiety pol) dolaczamy tez wzorce OPCJI
  // checkboxowych (CHECKBOX_FIELDS) - same opcje ("10 kW", "25 kW" itd.) nie
  // sa "etykietami pol" (nie maja wlasnej wartosci do zebrania), ale ich
  // POZYCJA na stronie musi ograniczac strefe INNYCH pol - inaczej strefowe
  // wyszukiwanie (patrz collectValueWordsInZone) rozciaga sie az do
  // najblizszego wiersza checkboxow i zbiera go jako smiec. Realny przypadek
  // zlapany 2026-07-22 (formularz Kotly): "Liczba osob mieszkajacych w
  // budynku:" zbieralo "30 kW" z zupelnie innego pytania ("1. Moc kotla"),
  // bo zaden ZNANY LABEL nie ograniczal strefy od dolu w tej samej kolumnie.
  // Dodane TYLKO tutaj (nie do ALL_LABEL_PATTERNS uzywanego jako stop-slowo
  // przy iteracji) - celowo minimalny, izolowany zasieg zmiany, zeby nie
  // ryzykowac regresji w juz sprawdzonym mechanizmie stop-slow dla rodziny
  // Pompy ciepla.
  const patternSources = [...ALL_LABEL_PATTERNS, ...CHECKBOX_FIELDS.flatMap((f) => f.options.map((o) => o.patterns))];
  for (const patterns of patternSources) {
    let from = 0;
    while (from < words.length) {
      const label = findLabel(words, patterns, from);
      if (!label) break;
      positions.push(unionBBox(label.indices.map((idx) => words[idx])));
      from = Math.max(...label.indices) + 1;
    }
  }
  return positions;
}

// Druga proba (po nieudanej pierwszej, waskiej) - zamiast sztywnej
// wielokrotnosci wysokosci etykiety, strefa odpowiedzi to CALA przestrzen
// miedzy NAJBLIZSZYM znanym pytaniem NAD (w tej samej kolumnie) a
// NAJBLIZSZYM znanym pytaniem POD (w tej samej kolumnie), dodatkowo
// zawezona z prawej strony przez najblizsze znane pytanie W TYM SAMYM
// WIERSZU (przypadek "2 pytania w jednym gestym wierszu formularza", np.
// "13. Cyrkulacja..." + "14. Pompa cyrkulacji..."). Odpowiedz znaleziona
// GDZIEKOLWIEK w tej strefie (nad linia WLASNEJ etykiety LUB pod nia) jest
// bezpieczna, bo fizycznie nie moze przekroczyc granicy z sasiednim, juz
// rozpoznanym pytaniem - w odroznieniu od dwoch wczesniejszych,
// wycofanych prob (sztywna tolerancja * 3 w obie strony), ktore nie mialy
// zadnej takiej naturalnej granicy i zlepialy sasiednie odpowiedzi.
function collectValueWordsInZone(words, labelBBox, allLabelPositions, allLabelPatterns) {
  const labelHeight = labelBBox.maxY - labelBBox.minY || 20;
  const columnTolerance = labelHeight * 4;
  let zoneTop = labelBBox.minY - labelHeight * 0.6;
  let zoneBottom = labelBBox.maxY + labelHeight * 2.5; // konserwatywny domyslny limit, gdy brak sasiada ponizej
  let zoneRight = Infinity;
  for (const pos of allLabelPositions) {
    const sameColumn = pos.minX <= labelBBox.maxX + columnTolerance && pos.maxX >= labelBBox.minX - columnTolerance;
    if (sameColumn && pos.minY > labelBBox.maxY && pos.minY < zoneBottom) zoneBottom = pos.minY - 2;
    if (sameColumn && pos.maxY < labelBBox.minY && pos.maxY > zoneTop) zoneTop = pos.maxY + 2;
    const sameRow = pos.minY < labelBBox.maxY && pos.maxY > labelBBox.minY;
    if (sameRow && pos.minX > labelBBox.maxX && pos.minX < zoneRight) zoneRight = pos.minX - 2;
  }

  const candidates = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const b = bbox(w);
    const midY = (b.minY + b.maxY) / 2;
    if (midY < zoneTop || midY > zoneBottom) continue;
    if (b.minX < labelBBox.maxX - labelHeight * 0.3) continue; // musi byc na prawo od etykiety
    if (b.maxX > zoneRight) continue;
    candidates.push({ idx: i, word: w, b });
  }
  candidates.sort((a, b) => a.b.minY - b.b.minY || a.b.minX - b.b.minX);

  const collected = [];
  for (const c of candidates) {
    if (collected.length >= MAX_VALUE_WORDS) break;
    if (allLabelPatterns.length && startsAnyLabel(words, c.idx, allLabelPatterns)) break;
    if (CHECKBOX_UNCHECKED.test(c.word.text)) continue;
    if (/^[.\-_:()]+$/.test(c.word.text) || /^\d{1,2}\.$/.test(c.word.text)) continue;
    if (/^[¨´`'"′″#^]+$/.test(c.word.text)) continue;
    collected.push(c.word);
  }
  return collected;
}

// PRZETESTOWANE i WYCOFANE 2026-07-22: probowano tu drugiego, szerszego
// przebiegu (3x tolerancja) gdy pierwszy nic nie znajdzie, majac pomoc w
// przypadkach jak odreczna odpowiedz zapisana jako obliczenie
// ("5 x 15 = 75m2"). Realny test na kilkunastu audytach pokazal, ze (a) nie
// naprawilo to zgloszonego przypadku, (b) wprowadzilo NOWY, gorszy problem -
// szerszy przebieg zaczal dolaczac tekst z SASIEDNICH, niesledzonych
// etykiet (np. "kod pocztowy" z etykiety adresu zamiast prawdziwego imienia
// i nazwiska) - te etykiety nie sa w ALL_LABEL_PATTERNS (bo pole "adres" w
// ogole nie jest sledzone), wiec nic ich nie zatrzymywalo. Bezpieczniej
// zostawic pole puste (do recznego przegladu) niz zgarnac tekst z innego
// pytania - stad tylko jeden, sciasniony przebieg.
// PRZETESTOWANE i WYCOFANE PONOWNIE 2026-07-22: druga, szersza proba (w obie
// strony) zostala przywrocona z rozszerzona stop-lista (patrz
// UNTRACKED_LABEL_PATTERNS) po zaobserwowaniu, ze odreczne odpowiedzi na tym
// formularzu nie trzymaja sie konsekwentnie jednej strony wzgledem etykiety
// ("40"/kąt dachu i "kotłownia"/bufor sa NAD linia, ale "2000"/data montażu
// drzwi jest POD linia). Rozszerzona stop-lista naprawila TEN konkretny
// stary problem (drukowany tekst "kod pocztowy" juz nie wchodzi jako
// wartosc imienia i nazwiska), ALE realny test na tym samym pliku pokazal
// NOWY, gorszy problem: szerszy przebieg zaczyna zlepiac ODRECZNA
// odpowiedz JEDNEGO pola z ODRECZNA odpowiedzia SASIEDNIEGO pola (np.
// "kotłownia" (bufor) + "beton" (opis podlogi, inne pole) w jedna wartosc
// "kottownia beton") - stop-lista pomaga tylko przy DRUKOWANYM tekscie,
// nie chroni przed zlepieniem dwoch ODRECZNYCH odpowiedzi, ktorych nie da
// sie odroznic samym slownikiem. To silniejszy dowod, ze geometryczne
// poszerzanie okna Y w OBIE strony ma twardy sufit dla tego konkretnego,
// bardzo gestego formularza - potrzeba innej techniki (np. grupowania
// Vision na poziomie akapitu/bloku, nie pojedynczych slow), nie kolejnej
// poprawki tolerancji. Zostawione jako jeden, sciasniony przebieg -
// bezpieczniejsze niz zgadywanie.
function collectValueWords(words, labelEndIdx, labelBBox, pageWidth, allLabelPatterns, gapMultiplier) {
  return collectValueWordsAtTolerance(words, labelEndIdx, labelBBox, pageWidth, allLabelPatterns, SAME_LINE_TOLERANCE, gapMultiplier);
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
// Na tym formularzu kazda grupa checkboxow (options) jest z definicji
// wyborem JEDNEJ opcji - zauwazone przez wlasciciela 2026-07-22 na
// przegladzie realnych audytow ("do kazdego podpunktu jest zaznaczony tylko
// jeden checkbox"). To daje uzyteczna kontrole poprawnosci: jesli program
// wykryje WIECEJ niz jeden zaznaczony checkbox w tej samej grupie, to
// zawsze sygnal bledu (OCR pomylil odczyt niezaznaczonego checkboxa, albo
// naprawde sa dwa zaznaczenia na skanie) - NIE nalezy po cichu brac
// pierwszego znalezionego, tak jak wczesniej, bo to moze byc zly wybor.
// Taki przypadek jest zwracany jako `ambiguous:true` - wywolujacy powinien
// to zawsze traktowac jako niepewne (do recznego przegladu), nigdy jako
// zaufana wartosc.
// Fallback dla dokumentow o SILNIE przemieszanej kolejnosci slow w tablicy
// Vision (zaobserwowane 2026-07-22 na formularzu "PROTOKÓŁ UZGODNIEŃ
// PROJEKTOWYCH" - kotly/solary, woj. lodzkie) - tam odrecznie wpisane
// odpowiedzi INNYCH pol fizycznie wciskaja sie miedzy checkbox a jego
// wlasna etykiete w tablicy Vision, np. "☐ 20 kW STRIPS 12/24 Wymiary : 25
// KW 30 kW" - prawdziwy zaznaczony glif dla "25" jest o kilkanascie pozycji
// dalej niz words[firstIdx-1] (zwykly, tablicowy sasiad), wiec standardowe
// sprawdzenie array-adjacency nigdy go nie znajduje. Szukamy zamiast tego
// NAJBLIZSZEGO GEOMETRYCZNIE glifu checkboxa (ta sama linia, na lewo od
// etykiety) - to dziala niezaleznie od pozycji w tablicy, bo bazuje na
// realnych wspolrzednych ze skanu. Uzywane TYLKO jako fallback, gdy
// bezposredni sasiad w tablicy nie jest ANI zaznaczonym ANI niezaznaczonym
// checkboxem (a wiec array-adjacency nie daje zadnej odpowiedzi) - nie
// nadpisuje przypadkow, gdzie array-adjacency juz poprawnie dziala (rodzina
// Pompy ciepla), minimalizujac ryzyko regresji.
function findNearbyCheckboxGeometric(words, targetIdx) {
  const targetBox = bbox(words[targetIdx]);
  const targetHeight = targetBox.maxY - targetBox.minY || 20;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < words.length; i++) {
    if (i === targetIdx) continue;
    const text = words[i].text;
    const checked = CHECKBOX_CHECKED.test(text);
    const unchecked = CHECKBOX_UNCHECKED.test(text);
    if (!checked && !unchecked) continue;
    const b = bbox(words[i]);
    const sameLine = Math.abs((b.minY + b.maxY) / 2 - (targetBox.minY + targetBox.maxY) / 2) < targetHeight * 0.5;
    if (!sameLine) continue;
    if (b.minX > targetBox.minX) continue; // checkbox zawsze na lewo od wlasnej etykiety
    const dist = targetBox.minX - b.maxX;
    // Promien celowo ciasny (kilka szerokosci wlasnego slowa) - szerszy
    // promien (probowany pierwotnie, targetHeight*15) lapal checkboxy z
    // INNYCH, nie powiazanych wierszy/pytan gdzie wlasciwy glif byl po
    // prostu nieobecny w OCR, dajac falszywe (pewne siebie) trafienia
    // zamiast poprawnego "nic w poblizu" - zlapane na realnym pliku Solary
    // 2026-07-22 (falszywie "zaznaczone" 3/300 obok naprawde zaznaczonego
    // 2/250).
    if (dist < 0 || dist > targetHeight * 4) continue;
    if (dist < bestDist) { bestDist = dist; best = checked; }
  }
  return best; // true (zaznaczony) / false (niezaznaczony) / null (nic w poblizu)
}

function findCheckedOption(words, options, rangeStart = 0, rangeEnd) {
  const end = rangeEnd ?? words.length;
  let anyOptionTextFound = false;
  const checkedMatches = [];
  // Sledzi status KAZDEJ znalezionej opcji (nie tylko zaznaczonych) - patrz
  // "wnioskowanie przez eliminacje" ponizej.
  const seenOptions = [];
  for (const option of options) {
    let searchFrom = rangeStart;
    while (searchFrom < end) {
      const label = findLabel(words.slice(0, end), option.patterns, searchFrom);
      if (!label) break;
      anyOptionTextFound = true;
      const firstIdx = label.indices[0];
      const candidates = [words[firstIdx].text, firstIdx > 0 ? words[firstIdx - 1].text : ''];
      let status = candidates.some((t) => CHECKBOX_CHECKED.test(t)) ? 'checked'
        : candidates.some((t) => CHECKBOX_UNCHECKED.test(t)) ? 'unchecked'
        : null;
      if (status === null) {
        // Ani zaznaczony ani niezaznaczony glif w bezposrednim sasiedztwie
        // tablicowym - realny znacznik jest gdzies indziej w silnie
        // przemieszanej tablicy, sprobuj geometrycznie.
        const geo = findNearbyCheckboxGeometric(words, firstIdx);
        status = geo === true ? 'checked' : geo === false ? 'unchecked' : 'unknown';
      }
      seenOptions.push({ option, status, words: label.indices.map((idx) => words[idx]) });
      if (status === 'checked') {
        checkedMatches.push({ option, words: label.indices.map((idx) => words[idx]) });
        break; // ta opcja juz znaleziona zaznaczona - nie szukaj JEJ kolejnych wystapien
      }
      searchFrom = firstIdx + 1;
    }
  }
  if (checkedMatches.length === 1) return checkedMatches[0];
  if (checkedMatches.length > 1) {
    return {
      option: null,
      ambiguous: true,
      conflictLabels: checkedMatches.map((m) => m.option.label),
      words: checkedMatches.flatMap((m) => m.words)
    };
  }
  // Wnioskowanie przez eliminacje - zaobserwowane 2026-07-22 na realnym
  // formularzu Solary: dla kilku pytan Vision NIE wykrywa checkboxa
  // PRZY zaznaczonej opcji w ogole (prawdopodobnie odreczny "check"
  // rysowany przez/na obrysie kwadratu jest trudniejszy do wysegmentowania
  // niz czysty pusty kwadrat "☐"), a jednoczesnie POPRAWNIE wykrywa
  // niezaznaczone kwadraty przy WSZYSTKICH pozostalych opcjach. Jesli
  // dokladnie JEDNA opcja wypadla jako 'unknown' (brak jakiegokolwiek
  // glifu w poblizu) a WSZYSTKIE INNE znalezione opcje sa jednoznacznie
  // 'unchecked', ta jedna to niemal na pewno prawdziwa odpowiedz - ale
  // pewnosc jest capowana nizej (patrz wywolujacy: extractCheckboxField),
  // bo to wnioskowanie, nie bezposrednia obserwacja.
  const unknownOnes = seenOptions.filter((s) => s.status === 'unknown');
  const uncheckedOnes = seenOptions.filter((s) => s.status === 'unchecked');
  if (unknownOnes.length === 1 && uncheckedOnes.length === seenOptions.length - 1 && seenOptions.length > 1) {
    return { option: unknownOnes[0].option, words: unknownOnes[0].words, inferredByElimination: true };
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

// Dzieli JEDNA "linie" (patrz groupIntoLines, juz posortowana po X) na
// osobne klastry, gdy miedzy sasiednimi slowami jest duza przerwa w X -
// wiele checkboxowych opcji na tym formularzu jest wydrukowanych PO DWIE w
// jednym wierszu tabeli (dwie niezalezne kolumny, ta sama wysokosc Y) - bez
// tego podzialu findCheckedLine zwracal CALY wiersz jako jedna wartosc,
// doklejajac tekst SASIEDNIEJ, niezaznaczonej opcji do zaznaczonej (realny
// bug zlapany 2026-07-22: "Kocioł na paliwo stałe" (zaznaczone) zlepione z
// "Kocioł na gaz olej - jednofunkcyjny (z osobnym zasobnikiem c.w.u." -
// obie opcje wydrukowane w tym samym wierszu formularza).
function splitLineIntoClusters(items) {
  const clusters = [];
  let current = [];
  let prevMaxX = null;
  for (const item of items) {
    const h = item.b.maxY - item.b.minY || 20;
    if (prevMaxX !== null && item.b.minX - prevMaxX > h * 4) {
      clusters.push(current);
      current = [];
    }
    current.push(item);
    prevMaxX = item.b.maxX;
  }
  if (current.length) clusters.push(current);
  return clusters;
}

// Szuka linii (patrz groupIntoLines) w [rangeStart,rangeEnd), a w niej
// KLASTRA (patrz splitLineIntoClusters) ktorego PIERWSZE slowo niesie
// znacznik zaznaczonego checkboxa I ktory pasuje do `contentPattern`
// (np. /KW/) - zwraca TYLKO ten klaster jako wartosc, nie cala linie.
function findCheckedLine(words, rangeStart, rangeEnd, contentPattern) {
  const lines = groupIntoLines(words, rangeStart, rangeEnd);
  for (const line of lines) {
    if (!line.items.length) continue;
    for (const cluster of splitLineIntoClusters(line.items)) {
      if (!cluster.length) continue;
      const first = cluster[0].w.text;
      if (!CHECKBOX_CHECKED.test(first)) continue;
      const text = cluster.map((it) => it.w.text).join(' ');
      if (!contentPattern.test(text.toUpperCase())) continue;
      return { text: text.replace(CHECKBOX_CHECKED, '').trim(), words: cluster.map((it) => it.w) };
    }
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
  // Sekcje z wariantu formularza uzywanego w gminie Rychwal (2026-07-22) -
  // te podpunkty NIE wystepuja w referencyjnym wzor.pdf (Kazimierz Biskupi),
  // ale sa czescia tej samej rodziny "GRUNTOWA POMPA CIEPLA" - inna gmina,
  // ten sam tytul protokolu, dodatkowe/przestawione podpunkty.
  { key: 'podlogaGruncie', patterns: [/POD[LŁ]OGA/, /NA/, /GRUNCIE/] },
  { key: 'klinkier', patterns: [/KLINKIEREM/] },
  { key: 'lokalizacjaIzolacjiSection', patterns: [/LOKALIZACJA/, /IZOLACJI/] },
  { key: 'scianaWielowarstwowaSection', patterns: [/[SŚ]CIANA/, /WIELOWARSTWOWA/] },
  // Strona "OBRYS BUDYNKU, SZKICE ELEWACJI I KOTŁOWNI" - do 2026-07-22
  // uwazana za czysty rysunek techniczny i celowo pomijana (patrz ETAP6),
  // ale zawiera realne, drukowane pola do wypelnienia (ksztalt budynku +
  // powierzchnia okien kazdej elewacji), potrzebne do OZC (wlasciciel
  // przeslal zaznaczone zdjecia formularza 2026-07-22). Dwie odrebne,
  // scisle (^...$) dopasowane sekcje - "Regularny"/"Nieregularny" - zeby
  // "Dlugosc:"/"Szerokosc:" (Regularny) nigdy nie pomylily sie z "Dlugosc
  // scian od strony..." (Nieregularny), ktore stoi fizycznie obok w
  // sasiedniej kolumnie tego samego wiersza.
  { key: 'ksztaltRegularnySection', patterns: [/^REGULARNY$/] },
  { key: 'ksztaltNieregularnySection', patterns: [/^NIEREGULARNY$/] },
  // Sekcje formularza "PROTOKÓŁ UZGODNIEŃ PROJEKTOWYCH" (kotly/solary) -
  // patrz komentarz przy nowych CHECKBOX_FIELDS ponizej.
  { key: 'kotlyZasobnikSection', patterns: [/ISTNIEJ[AĄ]CY/, /ZASOBNIK/] },
  { key: 'solaryZasobnikSection', patterns: [/PLANOWANE/, /MIEJSCE/, /MONTA[ZŻ]U/, /ZASOBNIKA/] },
  { key: 'solaryZestawSection', patterns: [/RODZAJ/, /ZESTAWU/] },
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
  // Etykieta na formularzu to "Imię i Nazwisko Uczestnika projektu/
  // Właściciela:" - CALA fraza, obie czesci ("projektu" ORAZ "Właściciela",
  // nie "albo") musza byc w labelPatterns, inaczej wzorzec konczy sie
  // przedwczesnie i "/ Właściciela" (koniec WLASNEJ etykiety) zostaje
  // zebrane jako wartosc zamiast prawdziwego imienia i nazwiska - realny,
  // powszechny bug zlapany 2026-07-22 przy przegladzie kilkunastu realnych
  // audytow (imieNazwisko wychodzilo jako "/ Właściciela" w KAZDYM pliku).
  { key: 'imieNazwisko', columnLabel: 'Imię i nazwisko', labelPatterns: [/IMI/, /NAZWISKO/, /UCZESTNIKA/, /PROJEKTU/, /W[LŁ]A[SŚ]CICIELA/] },
  { key: 'telefon', columnLabel: 'Telefon', labelPatterns: [/TELEFON/], valueKind: 'numeric' },
  { key: 'email', columnLabel: 'E-mail', labelPatterns: [/E-?MAIL/] },
  { key: 'dataProtokolu', columnLabel: 'Data sporządzenia protokołu', labelPatterns: [/SPORZ/, /DNIA/], valueKind: 'numeric' },
  { key: 'rokBudowy', columnLabel: 'Rok budowy budynku', labelPatterns: [/ROK/, /BUDOWY/, /BUDYNKU/], valueKind: 'numeric' },
  // Rozszerzone 2026-07-22 o wariant "Liczba osób mieszkających w budynku"
  // (rodzina formularzy Kotly/Solary, woj. lodzkie) obok istniejacego
  // "Liczba osob w gospodarstwie" (rodzina Pompy ciepla) - bezpieczne, bo
  // KAZDY realny dokument ma TYLKO JEDNO z tych dwoch slow w tej pozycji
  // (w odroznieniu od buga imieNazwisko z tej sesji, gdzie oba slowa
  // wystepowaly RAZEM w jednej etykiecie i trzeba bylo wymagac obu).
  { key: 'liczbaOsob', columnLabel: 'Liczba osób w gospodarstwie', labelPatterns: [/LICZBA/, /OS[OÓ]B/, /GOSPODARSTWIE|BUDYNKU/], valueKind: 'numeric' },
  { key: 'powierzchnia', columnLabel: 'Powierzchnia ogrzewana', labelPatterns: [/POWIERZCHNIA/, /OGRZEWAN/, /BUDYNKU/], valueKind: 'numeric' },
  { key: 'iloscKondygnacji', columnLabel: 'Ilość kondygnacji', labelPatterns: [/ILO[SŚ][CĆ]/, /KONDYGNACJI/], valueKind: 'numeric' },
  // checkboxGated:true - te pola sa "przyklejone" do WLASNEGO checkboxa
  // (pierwsze slowo etykiety = nazwa opcji, ktora ma wlasny checkbox tuz
  // przed soba, np. "☒Skośny (orientacyjny kąt dachu): 40°" vs
  // "☐Płaski (orientacyjny kąt dachu): ....") - jesli TA KONKRETNA opcja nie
  // jest zaznaczona, pole jest z definicji nie dotyczace tego dokumentu
  // (nie "puste do sprawdzenia"), patrz komentarz przy extractSimpleField.
  // Zgloszone przez wlasciciela 2026-07-22 na przykladzie kata dachu -
  // dotyczy tez wysokosci kondygnacji (Piwnica/Parter/Pietro/Poddasze/
  // Strych to niezalezne od siebie "zaznacz wszystkie ktore dotycza" pola,
  // nie jeden wybor).
  { key: 'wysokoscPiwnica', columnLabel: 'Wysokość - piwnica', labelPatterns: [/PIWNIC/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/], checkboxGated: true, valueKind: 'numeric' },
  { key: 'wysokoscParter', columnLabel: 'Wysokość - parter', labelPatterns: [/PARTER/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/], checkboxGated: true, valueKind: 'numeric' },
  { key: 'wysokoscPietro', columnLabel: 'Wysokość - piętro', labelPatterns: [/PI[EĘ]TRO/, /ILO[SŚ][CĆ]/], checkboxGated: true, valueKind: 'numeric' },
  { key: 'wysokoscPoddasze', columnLabel: 'Wysokość - poddasze', labelPatterns: [/PODDASZE/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/], checkboxGated: true, valueKind: 'numeric' },
  { key: 'wysokoscStrych', columnLabel: 'Wysokość - strych', labelPatterns: [/STRYCH/, /[SŚ]R/, /WYSOKO[SŚ][CĆ]/], checkboxGated: true, valueKind: 'numeric' },
  { key: 'katDachuPlaski', columnLabel: 'Kąt dachu (płaski)', labelPatterns: [/P[LŁ]ASKI/, /K[AĄ]T/, /DACHU/], checkboxGated: true, valueKind: 'numeric' },
  { key: 'katDachuSkosny', columnLabel: 'Kąt dachu (skośny)', labelPatterns: [/SKO[SŚ]NY/, /K[AĄ]T/, /DACHU/], checkboxGated: true, valueKind: 'numeric' },
  // Strona 2 - pola tekstowe/numeryczne bez checkboxow
  { key: 'miejsceBufor', columnLabel: 'Planowane miejsce na bufor', labelPatterns: [/PLANOWANE/, /MIEJSCE/, /NA/, /BUFOR/] },
  { key: 'wysokoscPomieszczeniaBufor', columnLabel: 'Wysokość pomieszczenia (bufor)', labelPatterns: [/WYSOKO[SŚ][CĆ]/, /POMIESZCZENIA/], valueKind: 'numeric' },
  { key: 'opisPodlogiBufor', columnLabel: 'Opis podłogi w pomieszczeniu', labelPatterns: [/OPIS/, /POD[LŁ]OGI/, /W/, /POMIESZCZENIU/] },
  { key: 'odlegloscPompyOdBufora', columnLabel: 'Odległość pompy ciepła od bufora', labelPatterns: [/ODLEG[LŁ]O[SŚ][CĆ]/, /POMPY/, /CIEP[LŁ]A/, /OD/, /BUFORA/], valueKind: 'numeric' },
  { key: 'szerokoscPrzewezenia', columnLabel: 'Szerokość przewężenia', labelPatterns: [/SZEROKO[SŚ][CĆ]/, /PRZEW[EĘ][ZŻ]ENIA/, /DROGA/, /WNIESIENIA/, /URZ[AĄ]DZE[NŃ]/], valueKind: 'numeric' },
  { key: 'mocPrzylacza', columnLabel: 'Przyznana moc przyłącza elektrycznego', labelPatterns: [/PRZYZNANA/, /MOC/, /PRZY[LŁ][AĄ]CZA/, /ELEKTRYCZNEGO/], valueKind: 'numeric' },
  { key: 'zabezpieczenieGlowne', columnLabel: 'Zabezpieczenie elektryczne główne', labelPatterns: [/ZABEZPIECZENIE/, /ELEKTRYCZNE/, /G[LŁ][OÓ]WNE/], valueKind: 'numeric' },
  { key: 'zuzycieObecnegoPaliwa', columnLabel: 'Roczne zużycie obecnego paliwa', labelPatterns: [/ROCZNE/, /ZU[ZŻ]YCIE/, /OBECNEGO/, /PALIWA/], valueKind: 'numeric' },
  { key: 'iloscObiegowGrzewczych', columnLabel: 'Ilość wydzielonych obiegów grzewczych', labelPatterns: [/ILO[SŚ][CĆ]/, /WYDZIELONYCH/, /OBIEG[OÓ]W/], valueKind: 'numeric' },
  { key: 'iloscZaworowMieszajacych', columnLabel: 'Ilość obiegów z zaworami mieszającymi', labelPatterns: [/ILO[SŚ][CĆ]/, /OBIEG[OÓ]W/, /C\.?O/, /WYPOSA[ZŻ]ONYCH/], valueKind: 'numeric' },
  { key: 'udzialGrzejnikowy', columnLabel: 'Udział ogrzewania grzejnikowego (%)', labelPatterns: [/UDZIA[LŁ]/, /OGRZEWANIA/, /GRZEJNIKOWEGO/], valueKind: 'numeric' },
  { key: 'udzialPlaszczyznowy', columnLabel: 'Udział ogrzewania płaszczyznowego (%)', labelPatterns: [/UDZIA[LŁ]/, /OGRZEWANIA/, /P[LŁ]ASZCZYZNOWEGO/], valueKind: 'numeric' },
  { key: 'temperaturaPomieszczenia', columnLabel: 'Żądana temperatura w pomieszczeniach', labelPatterns: [/[ZŻ][AĄ]DANA/, /TEMPERATURA/, /W/, /POMIESZCZENIACH/], valueKind: 'numeric' },
  { key: 'temperaturaCwu', columnLabel: 'Żądana temperatura c.w.u.', labelPatterns: [/[ZŻ][AĄ]DANA/, /TEMPERATURA/, /C\.?W\.?U/], valueKind: 'numeric' },
  { key: 'powierzchniaDzialki', columnLabel: 'Powierzchnia działki (dolne źródło)', labelPatterns: [/POWIERZCHNIA/, /DZIA[LŁ]KI/], valueKind: 'numeric' },
  // Strona "OBRYS BUDYNKU..." (patrz komentarz przy SECTION_HEADERS) -
  // powierzchnia okien kazdej z 4 elewacji, potrzebne do OZC. Kazda
  // etykieta jest jednoznaczna (litera+kierunek), wiec bez sectionKey.
  { key: 'elewacjaAPowierzchniaOkien', columnLabel: 'Elewacja A (Północna) - powierzchnia okien', labelPatterns: [/ELEWACJA/, /^A$/, /P[OÓ][LŁ]NOCNA/, /POWIERZCHNIA/, /OKIEN/], valueKind: 'numeric' },
  { key: 'elewacjaBPowierzchniaOkien', columnLabel: 'Elewacja B (Wschodnia) - powierzchnia okien', labelPatterns: [/ELEWACJA/, /^B$/, /WSCHODNIA/, /POWIERZCHNIA/, /OKIEN/], valueKind: 'numeric' },
  { key: 'elewacjaCPowierzchniaOkien', columnLabel: 'Elewacja C (Południowa) - powierzchnia okien', labelPatterns: [/ELEWACJA/, /^C$/, /PO[LŁ]UDNIOWA/, /POWIERZCHNIA/, /OKIEN/], valueKind: 'numeric' },
  { key: 'elewacjaDPowierzchniaOkien', columnLabel: 'Elewacja D (Zachodnia) - powierzchnia okien', labelPatterns: [/ELEWACJA/, /^D$/, /ZACHODNIA/, /POWIERZCHNIA/, /OKIEN/], valueKind: 'numeric' },
  // Wczesniej TYLKO wpis w UNTRACKED_LABEL_PATTERNS (celowo niewyciagane, uzywane
  // jedynie jako stop-granica dla imieNazwisko) - teraz prawdziwe pole, bo do
  // tabelki adresowej trzeba rozbic adres na "Adres"/"Miejscowosc" (patrz
  // tabelaAdresowaMapping.js). Etykieta pelnej dlugosci (rodzina Pompy ciepla:
  // "Adres miejsca instalacji (ulica, nr budynku/lokalu, kod pocztowy):") -
  // wymaga WSZYSTKICH trzech slow (nie samego "ADRES"), inaczej "miejsca
  // instalacji (...)" zostaloby zebrane jako (bledna) wartosc - dokladnie ten
  // sam blad, ktoremu ten wpis pierwotnie mial zapobiegac jako stop-lista.
  { key: 'adresInstalacji', columnLabel: 'Adres miejsca instalacji', labelPatterns: [/ADRES/, /MIEJSCA/, /INSTALACJI/] },
  // UWAGA: swiadomie NIE dodajemy analogicznego pola dla krotkiej etykiety
  // "Adres:" (rodzina Kotly/Solary) - probowane 2026-07-22, ale kazdy
  // wystarczajaco krotki/generyczny wzorzec zaczynajacy sie od samego slowa
  // "Adres" ryzykuje zlapanie TEJ SAMEJ pozycji co dluzsza etykieta Pompy
  // ciepla powyzej (ktora TEZ zaczyna sie od "Adres") i zebranie jej reszty
  // ("miejsca instalacji...") jako smiecia. Zamiast tego adres dla Kotly/
  // Solary bierzemy z istniejacej etykiety bloku/nazwy pliku (addressLabel w
  // server.js) - i tak juz uzywanej jako fallback dla kolumny "adres" - patrz
  // tabelaAdresowaMapping.js's splitAddress().
  // Rodzina "PROTOKÓŁ UZGODNIEŃ PROJEKTOWYCH" (Kotly/Solary) - patrz komentarz
  // przy nowych CHECKBOX_FIELDS.
  { key: 'kotlyMocIstniejacegoZrodla', columnLabel: 'Moc istniejącego źródła ciepła', labelPatterns: [/ISTNIEJ[AĄ]CE/, /[ZŹ]R[OÓ]D[LŁ]O/, /CIEP[LŁ]A/, /MOC/], valueKind: 'numeric' },
  { key: 'solaryPokrycieDachu', columnLabel: 'Pokrycie dachu', labelPatterns: [/POKRYCIE/, /DACHU/] }
];

// --- Pola zagniezdzone w sekcjach (ta sama pod-etykieta powtarza sie w
// kilku sekcjach, dlatego wymagaja ograniczenia zakresu) ----------------

const SECTION_SUBFIELDS = [
  { key: 'dataMontażuOkien', columnLabel: 'Data montażu stolarki okiennej', sectionKey: 'stolarka', labelPatterns: [/PRZYBLI[ZŻ]ONA/, /DATA/, /MONTA[ZŻ]U/], valueKind: 'numeric' },
  { key: 'wymiaryDrzwiZewn', columnLabel: 'Wymiary drzwi zewnętrznych', sectionKey: 'drzwiZewn', labelPatterns: [/WYMIARY/], valueKind: 'numeric' },
  { key: 'dataMontażuDrzwiZewn', columnLabel: 'Data montażu drzwi zewnętrznych', sectionKey: 'drzwiZewn', labelPatterns: [/PRZYBLI[ZŻ]ONA/, /DATA/, /MONTA[ZŻ]U/], valueKind: 'numeric' },
  { key: 'iloscDrzwiZewn', columnLabel: 'Ilość drzwi zewnętrznych', sectionKey: 'drzwiZewn', labelPatterns: [/ILO[SŚ][CĆ]/], valueKind: 'numeric' },
  { key: 'wymiaryDrzwiGaraz', columnLabel: 'Wymiary drzwi garażowych', sectionKey: 'drzwiGaraz', labelPatterns: [/WYMIARY/], valueKind: 'numeric' },
  { key: 'dataMontażuDrzwiGaraz', columnLabel: 'Data montażu drzwi garażowych', sectionKey: 'drzwiGaraz', labelPatterns: [/PRZYBLI[ZŻ]ONA/, /DATA/, /MONTA[ZŻ]U/], valueKind: 'numeric' },
  { key: 'iloscDrzwiGaraz', columnLabel: 'Ilość drzwi garażowych', sectionKey: 'drzwiGaraz', labelPatterns: [/ILO[SŚ][CĆ]/], valueKind: 'numeric' },
  // Dodane po porownaniu z prawdziwym cyfrowym raportem "Ustalenia
  // montazowe" (rodzina B, ktorej audytow firma sie pozbywa, ale ktora
  // pokazuje pelen zestaw pol biznesowych do Excela) - "Grubosc izolacji
  // dachu" jest tez na papierowym formularzu ("Izolacja dachu: Tak...,
  // grubosc: ...cm"), po prostu nie zostalo dodane w ETAP5/6.
  // checkboxAnchorPattern - "Izolacja dachu: Tak, ..., grubosc: ...cm / Nie"
  // - grubosc dotyczy WYLACZNIE gdy "Tak" jest zaznaczone (jedyna para
  // Tak/Nie w calej sekcji 'dach', wiec bezpieczne szukac w calym zakresie
  // sekcji bez dodatkowego zawezania). Zgloszone przez wlasciciela
  // 2026-07-22 na przykladzie identycznego wzorca (kat dachu) - to samo
  // dotyczy tego pola, tylko przeoczone przy pierwszym dodaniu w ETAP6.
  { key: 'grubIzolacjiDachu', columnLabel: 'Grubość izolacji dachu', sectionKey: 'dach', labelPatterns: [/GRUBO[SŚ][CĆ]/], checkboxAnchorPattern: /^TAK,?$/, valueKind: 'numeric' },
  // Ta sama logika co grubIzolacjiDachu - "Izolacja: Tak, grubość...cm Nie"
  // w sekcji sciany fundamentowej, przeoczone razem z materialem tej
  // sciany przy pierwszym przejrzeniu.
  { key: 'grubIzolacjiFundamentowej', columnLabel: 'Grubość izolacji ściany fundamentowej', sectionKey: 'scianaFundamentowa', labelPatterns: [/GRUBO[SŚ][CĆ]/], checkboxAnchorPattern: /^TAK,?$/, valueKind: 'numeric' },
  // Wariant Rychwal - "Czy zewn. powierzchnia ściany pokryta jest
  // klinkierem: Tak, grubość: ...cm / Nie" - wlasna sekcja 'klinkier'
  // zakotwiczona na samym slowie "klinkierem" (patrz SECTION_HEADERS).
  { key: 'grubKlinkieru', columnLabel: 'Grubość okładziny klinkierowej', sectionKey: 'klinkier', labelPatterns: [/GRUBO[SŚ][CĆ]/], checkboxAnchorPattern: /^TAK,?$/, valueKind: 'numeric' },
  // Kazdy z tych 6 dotyczy tylko JEDNEJ z dwoch wykluczajacych sie opcji
  // (Regularny/Nieregularny) - patrz komentarz przy SECTION_HEADERS. NIE
  // sa checkboxGated (auditor moze zostawic pole puste nawet gdy ta opcja
  // jest zaznaczona) - jesli druga opcja zostala wybrana, te pola po
  // prostu wychodza puste (found:true, needsReview:true) tak jak kazde
  // inne nieuzupelnione pole - drobny, zaakceptowany koszt (2 dodatkowe
  // pola do potwierdzenia "Brak w oryginale" w polowie przypadkow), nie
  // wart dodatkowej zlozonosci gating-u na wlasny checkbox oddalony o linie.
  { key: 'dlugoscBudynku', columnLabel: 'Długość budynku (regularny)', sectionKey: 'ksztaltRegularnySection', labelPatterns: [/^D[LŁ]UGO[SŚ][CĆ]$/], valueKind: 'numeric' },
  { key: 'szerokoscBudynku', columnLabel: 'Szerokość budynku (regularny)', sectionKey: 'ksztaltRegularnySection', labelPatterns: [/SZEROKO[SŚ][CĆ]/], valueKind: 'numeric' },
  { key: 'dlugoscScianPolnocnej', columnLabel: 'Długość ścian od strony północnej', sectionKey: 'ksztaltNieregularnySection', labelPatterns: [/D[LŁ]UGO[SŚ][CĆ]/, /[SŚ]CIAN/, /OD/, /STRONY/, /P[OÓ][LŁ]NOCNEJ/], valueKind: 'numeric' },
  { key: 'dlugoscScianPoludniowej', columnLabel: 'Długość ścian od strony południowej', sectionKey: 'ksztaltNieregularnySection', labelPatterns: [/D[LŁ]UGO[SŚ][CĆ]/, /[SŚ]CIAN/, /OD/, /STRONY/, /PO[LŁ]UDNIOWEJ/], valueKind: 'numeric' },
  { key: 'dlugoscScianWschodniej', columnLabel: 'Długość ścian od strony wschodniej', sectionKey: 'ksztaltNieregularnySection', labelPatterns: [/D[LŁ]UGO[SŚ][CĆ]/, /[SŚ]CIAN/, /OD/, /STRONY/, /WSCHODNIEJ/], valueKind: 'numeric' },
  { key: 'dlugoscScianZachodniej', columnLabel: 'Długość ścian od strony zachodniej', sectionKey: 'ksztaltNieregularnySection', labelPatterns: [/D[LŁ]UGO[SŚ][CĆ]/, /[SŚ]CIAN/, /OD/, /STRONY/, /ZACHODNIEJ/], valueKind: 'numeric' },
  // Rodzina "PROTOKÓŁ UZGODNIEŃ PROJEKTOWYCH" (Kotly/Solary) - patrz komentarz
  // przy CHECKBOX_FIELDS. Ten sam sprawdzony wzorzec co grubIzolacjiFundamentowej/
  // grubIzolacjiDachu - checkboxAnchorPattern zamiast checkboxGated, bo checkbox
  // ("Tak"/"Kotłownia") jest kilka slow PRZED wlasna etykieta pola ("pojemność"/
  // "Wys. pom."), nie bezposrednio przed nia.
  { key: 'kotlyZasobnikCwu', columnLabel: 'Zasobnik c.w.u. (pojemność)', sectionKey: 'kotlyZasobnikSection', labelPatterns: [/POJEMNO[SŚ][CĆ]/], checkboxAnchorPattern: /^TAK,?$/, valueKind: 'numeric' },
  { key: 'solaryWysokoscKotlowni', columnLabel: 'Wysokość kotłowni', sectionKey: 'solaryZasobnikSection', labelPatterns: [/WYS/, /POM/], checkboxAnchorPattern: /^KOT[LŁ]OWNIA$/, valueKind: 'numeric' }
];

const CHECKBOX_FIELDS = [
  {
    key: 'ksztaltBudynku', columnLabel: 'Kształt budynku',
    options: [
      { label: 'Regularny', patterns: [/^REGULARNY$/] },
      { label: 'Nieregularny', patterns: [/^NIEREGULARNY$/] }
    ]
  },
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
  },
  // Wariant Rychwal (2026-07-22, zgloszone na realnym pliku "Dabroszyn
  // 38A.pdf") - nie wystepuja w referencyjnym wzor.pdf (Kazimierz Biskupi),
  // ale sa czescia tej samej rodziny "GRUNTOWA POMPA CIEPLA", inna wersja
  // formularza. UWAGA: te 3 pola byly najpierw zbudowane jako
  // INLINE_CHOICE_FIELDS (zakotwiczone do WLASNEJ etykiety w TEJ SAMEJ
  // linii), ale na realnym ukladzie tego wariantu naglowek pytania
  // ("Lokalizacja izolacji:"/"Ściana wielowarstwowa:") i same checkboxy sa
  // na SASIEDNICH liniach (naglowek, potem checkboxy pod nim), nie w jednej
  // linii - stad przeniesione tutaj (CHECKBOX_FIELDS + sectionKey), gdzie
  // wyszukiwanie dziala w calym zakresie sekcji, nie tylko na jednej linii.
  {
    key: 'lokalizacjaIzolacjiSciany', columnLabel: 'Lokalizacja izolacji ściany zewn.', sectionKey: 'lokalizacjaIzolacjiSection',
    options: [
      // Sekwencja MUSI zaczynac sie od "Na" (nie samo /ZEWN[AĄ]TRZ/) -
      // checkbox jest przed "Na", nie przed "zewnątrz" - ten sam bug co
      // przy "Warstwa betonu chudego" (patrz komentarz w
      // MULTI_MATERIAL_FIELDS) - miejsce startu sekwencji wyznacza, przy
      // ktorym slowie sprawdzany jest znacznik zaznaczenia.
      { label: 'Na zewnątrz', patterns: [/^NA$/, /ZEWN[AĄ]TRZ/] },
      { label: 'Wewnątrz', patterns: [/WEWN[AĄ]TRZ/] }
    ]
  },
  {
    key: 'scianaWielowarstwowa', columnLabel: 'Ściana wielowarstwowa', sectionKey: 'scianaWielowarstwowaSection',
    options: [
      { label: 'Tak', patterns: [/^TAK$/] },
      { label: 'Nie', patterns: [/^NIE$/] }
    ]
  },
  {
    key: 'klinkier', columnLabel: 'Zewn. powierzchnia pokryta klinkierem', sectionKey: 'klinkier',
    options: [
      { label: 'Tak', patterns: [/^TAK$/] },
      { label: 'Nie', patterns: [/^NIE$/] }
    ]
  },
  // Przeniesione z INLINE_CHOICE_FIELDS - naglowek "Planowane miejsce na
  // zasobnik c.w.u.:" i same checkboxy sa na SASIEDNICH liniach (naglowek,
  // potem opcje pod nim), nie w jednej linii - ten sam bug jak przy
  // lokalizacjaIzolacjiSciany/scianaWielowarstwowa/klinkier (patrz komentarz
  // tam) - reuzywa juz istniejacej sekcji 'zasobnikSection'.
  {
    key: 'zasobnikCwu', columnLabel: 'Miejsce na zasobnik c.w.u.', sectionKey: 'zasobnikSection',
    options: [
      { label: 'Takie samo jak bufor', patterns: [/TAKIE/] },
      { label: 'Inne', patterns: [/^INNE$/] }
    ]
  },
  // Przeniesione z INLINE_CHOICE_FIELDS - "Typ instalacji elektrycznej w
  // pomieszczeniu montazu pompy ciepla:" (naglowek) i "3-fazowa/1-fazowa/
  // Brak" (checkboxy) sa na SASIEDNICH liniach, ten sam bug jak przy
  // zasobnikCwu/lokalizacjaIzolacjiSciany. Bezpieczne mimo szerokiej sekcji
  // 'elektrykaSection' (zawiera tez gniazdoElektryczne/dostepInternet) bo
  // opcje "3-fazowa"/"1-fazowa"/"Brak" sa unikalne, nie generyczne Tak/Nie
  // jak w tamtych dwoch polach.
  {
    key: 'typInstalacjiElektrycznej', columnLabel: 'Typ instalacji elektrycznej', sectionKey: 'elektrykaSection',
    options: [
      { label: '3-fazowa', patterns: [/^3$/, /FAZOWA/] },
      { label: '1-fazowa', patterns: [/^1$/, /FAZOWA/] },
      { label: 'Brak', patterns: [/^BRAK$/] }
    ]
  },
  // --- Rodzina "PROTOKÓŁ UZGODNIEŃ PROJEKTOWYCH" (woj. łódzkie/Galewice) -
  // CALKOWICIE inny formularz niz "PROTOKÓŁ UZGODNIEŃ MONTAŻOWYCH" (Kazimierz
  // Biskupi) uzywany dla reszty pol powyzej - osobny dla kotlow na pellet i
  // osobny dla kolektorow slonecznych, zweryfikowane na realnych plikach
  // 2026-07-22 (Galewice, "kocioł"/"kolektor"). Klucze prefiksowane
  // kotly*/solary* zeby nie kolidowac z istniejacymi kluczami o podobnie
  // brzmiacej polskiej etykiecie ale INNYM znaczeniu (np. typKonstrukcji
  // powyzej to Lekka/Srednia/Ciezka dla pomp ciepla, solaryTypKonstrukcji to
  // zupelnie inne pytanie o Dach plaski/skosny/Elewacje).
  {
    key: 'kotlyMocKotla', columnLabel: 'Moc kotła',
    options: [
      { label: '10 kW', patterns: [/^10$/, /KW/] },
      { label: '15 kW', patterns: [/^15$/, /KW/] },
      { label: '20 kW', patterns: [/^20$/, /KW/] },
      { label: '25 kW', patterns: [/^25$/, /KW/] },
      { label: '30 kW', patterns: [/^30$/, /KW/] }
    ]
  },
  {
    // Zweryfikowane na realnym pliku 2026-07-22: Vision tokenizuje ten
    // wiersz niespojnie - zaznaczony checkbox bywa ZLEPIONY z pierwsza
    // cyfra w JEDEN token ("☑2", nie osobne "☑"+"2"), a caly numer bywa
    // ALBO rozbity ("2","/","250") ALBO jednym tokenem ("3/300"). Jeden
    // wzorzec na opcje (nie dwa) - wymaganie DRUGIEGO oddzielnego slowa na
    // "250"/"300"/"400" zawodzi wlasnie wtedy, gdy caly numer jest jednym
    // tokenem (nic juz nie zostaje do dopasowania drugim wzorcem). Zakres
    // ograniczony do sectionKey (patrz SECTION_HEADERS), zeby goly "2"/"3"/
    // "4" nie zlapal czegos innego wczesniej na stronie.
    key: 'solaryRodzajZestawu', columnLabel: 'Rodzaj zestawu', sectionKey: 'solaryZestawSection',
    options: [
      { label: '2/250', patterns: [/^[☑☒✓✔☐□]?2(\/?250)?$/] },
      { label: '3/300', patterns: [/^[☑☒✓✔☐□]?3(\/?300)?$/] },
      { label: '4/400', patterns: [/^[☑☒✓✔☐□]?4(\/?400)?$/] }
    ]
  },
  {
    key: 'solaryTypBudynku', columnLabel: 'Typ budynku',
    options: [
      { label: 'Bud. mieszkalny', patterns: [/^BUD$|^BUD\.?$/, /MIESZKALNY/] },
      { label: 'Bud. gospodarczy', patterns: [/^BUD$|^BUD\.?$/, /GOSPODARCZY/] }
    ]
  },
  {
    key: 'solaryTypKonstrukcji', columnLabel: 'Typ konstrukcji',
    options: [
      { label: 'Dach płaski', patterns: [/^DACH$/, /P[LŁ]ASKI/] },
      { label: 'Dach skośny', patterns: [/^DACH$/, /SKO[SŚ]NY/] },
      { label: 'Elewacja', patterns: [/^ELEWACJA$/] }
    ]
  },
  {
    key: 'solaryMiejsceMontazu', columnLabel: 'Miejsce montażu',
    options: [
      { label: 'Dach płaski lub zbliżony', patterns: [/^DACH$/, /P[LŁ]ASKI/, /LUB/, /ZBLI[ZŻ]ONY/] },
      { label: 'Balkon, taras', patterns: [/^BALKON$/] },
      { label: 'Dach skośny', patterns: [/^DACH$/, /SKO[SŚ]NY/] },
      { label: 'Grunt', patterns: [/^GRUNT$/] },
      { label: 'Elewacja budynku, wysoko', patterns: [/^ELEWACJA$/, /BUDYNKU/, /WYSOKO/] },
      { label: 'Elewacja budynku, nisko', patterns: [/^ELEWACJA$/, /BUDYNKU/, /NISKO/] }
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
  { key: 'rodzajInstalacjiCoOtwZamk', columnLabel: 'Rodzaj instalacji c.o. (otwarta/zamknięta)', labelPatterns: [/RODZAJ/, /ISTNIEJ[AĄ]CEJ/, /INSTALACJI/, /C\.?O/], choices: [{ label: 'Układ otwarty', pattern: /OTWARTY/ }, { label: 'Układ zamknięty', pattern: /ZAMKNI[EĘ]TY/ }] },
  { key: 'demontazZrodla', columnLabel: 'Demontaż istniejącego źródła ciepła', labelPatterns: [/DEMONTA[ZŻ]/, /ISTNIEJ[AĄ]CEGO/, /[ZŹ]R[OÓ]D[LŁ]A/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'instalacjaSolarna', columnLabel: 'Istniejąca instalacja solarna', labelPatterns: [/ISTNIEJ[AĄ]CA/, /INSTALACJA/, /SOLARNA/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'cyrkulacjaCwu', columnLabel: 'Cyrkulacja c.w.u.', labelPatterns: [/CYRKULACJA/, /C\.?W\.?U/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'pompaCyrkulacji', columnLabel: 'Pompa cyrkulacji c.w.u.', labelPatterns: [/POMPA/, /CYRKULACJI/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'kratkaOdplywowa', columnLabel: 'Kratka odpływowa', labelPatterns: [/KRATKA/, /ODP[LŁ]YWOWA/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'reduktorWody', columnLabel: 'Reduktor na wodzie zimnej', labelPatterns: [/REDUKTOR/, /NA/, /WODZIE/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'demontazKostki', columnLabel: 'Demontaż kostki brukowej (prace ziemne)', labelPatterns: [/DEMONTA[ZŻ]/, /KOSTKI/, /BRUKOWEJ/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'usuniecieDrzew', columnLabel: 'Usunięcie drzew/krzewów (prace ziemne)', labelPatterns: [/USUNI[EĘ]CIE/, /DRZEW/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  // "Izolacja: Tak/Nie" (bez wlasnej wartosci - sam material jest osobnym
  // MATERIAL_FIELD ponizej, zaleznym od tego Tak) - wymaga sectionKey, bo
  // etykieta "Izolacja:" powtarza sie w kilku sekcjach na stronie
  // (sciana fundamentowa, strop ogrzewane, strop nieogrzewane, dach).
  { key: 'izolacjaStropOgrzewane', columnLabel: 'Izolacja stropu nad ogrzewanymi', sectionKey: 'stropOgrzewane', labelPatterns: [/IZOLACJA/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] },
  { key: 'izolacjaStropNieogrzewane', columnLabel: 'Izolacja stropu nad nieogrzewanymi', sectionKey: 'stropNieogrzewane', labelPatterns: [/IZOLACJA/], choices: [{ label: 'Tak', pattern: /TAK/ }, { label: 'Nie', pattern: /NIE/ }] }
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
      // Musi zaczynac sie od "Kanalizacja" (checkbox jest przed tym slowem),
      // nie samo /DESZCZOWA/ - ten sam bug jak przy "Warstwa betonu
      // chudego"/"Z siłownikiem" (patrz komentarze przy tych polach).
      { label: 'Kanalizacja deszczowa', patterns: [/^KANALIZACJA$/, /DESZCZOWA/] },
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
      { label: 'Bloczek betonowy', patterns: [/BLOCZEK/] },
      // Wariant Rychwal - inny zestaw opcji niz Kazimierz Biskupi ("Taki
      // sam jak sciany zewn." / "Inny: <odrecznie>") - freeText:true bo
      // wartosc po "Inny:" to slowo (np. "bloczek"), nie liczba.
      { label: 'Taki sam jak ściana zewnętrzna', patterns: [/TAKI/, /SAM/] },
      { label: 'Inny', patterns: [/^INNY$/], freeText: true }
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
  // Materiał izolacji stropu - ma sens TYLKO gdy izolacjaStropOgrzewane/
  // Nieogrzewane (powyzej, INLINE_CHOICE_FIELDS) = Tak, stad
  // checkboxAnchorPattern (ta sama sekcja - jedyna para Tak/Nie w niej).
  {
    key: 'materialIzolacjiStropOgrzewane', columnLabel: 'Materiał izolacji stropu nad ogrzewanymi', sectionKey: 'stropOgrzewane', checkboxAnchorPattern: /^TAK$/,
    options: [
      { label: 'Styropian', patterns: [/STYROPIAN/] },
      { label: 'Wełna', patterns: [/WE[LŁ]NA/] },
      { label: 'Pianka', patterns: [/PIANKA/] }
    ]
  },
  {
    key: 'materialIzolacjiStropNieogrzewane', columnLabel: 'Materiał izolacji stropu nad nieogrzewanymi', sectionKey: 'stropNieogrzewane', checkboxAnchorPattern: /^TAK$/,
    options: [
      { label: 'Styropian', patterns: [/STYROPIAN/] },
      { label: 'Wełna', patterns: [/WE[LŁ]NA/] },
      { label: 'Pianka', patterns: [/PIANKA/] }
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
      // Musi zaczynac sie od "Z" (checkbox jest przed tym slowem), nie
      // samo /SI[LŁ]OWNIKIEM/ - ten sam bug jak przy "Kanalizacja
      // deszczowa" powyzej.
      { label: 'Z siłownikiem', patterns: [/^Z$/, /SI[LŁ]OWNIKIEM/] }
    ]
  }
];

// "F. Podloga na gruncie (konstrukcja) - zaznaczyc wystepujace warstwy" -
// wielokrotny wybor (moze byc kilka warstw naraz), kazda z wlasna gruboscia
// - przeoczone przy pierwszym przejrzeniu formularza, dodane 2026-07-22 po
// prosbie wlasciciela o przejrzenie wszystkich checkboxow w wzor.pdf.
const MULTI_MATERIAL_FIELDS = [
  {
    key: 'podlogaGruncie', columnLabel: 'Podłoga na gruncie (warstwy, grubość)', sectionKey: 'podlogaGruncie',
    options: [
      { label: 'Wylewka betonowa', patterns: [/WYLEWKA/] },
      { label: 'Izolacja', patterns: [/^IZOLACJA/] },
      // UWAGA: musi zaczynac sie od /WARSTWA/, nie /BETONU/ - checkbox jest
      // PRZED "Warstwa", nie przed "betonu" - patterns[0] wyznacza pozycje
      // od ktorej sprawdzany jest znacznik zaznaczenia (1 slowo wstecz),
      // wiec zle miejsce startu = szukanie checkboxa przy zlym slowie
      // (realny bug zlapany 2026-07-22 testem symulujacym realny skan).
      { label: 'Warstwa betonu chudego', patterns: [/WARSTWA/, /BETONU/, /CHUDEGO/] }
    ]
  }
];

// Pola specyficzne dla wariantu Rzgow/Wilczyn - puste dla wiekszosci
// pozostalych inwestycji, co jest oczekiwane (jeden uniwersalny zestaw
// kolumn, patrz plan).
const RZGOW_SIMPLE_FIELDS = [
  { key: 'istniejaceZrodloCiepla', columnLabel: 'Istniejące źródło ciepła', labelPatterns: [/ISTNIEJ[AĄ]CE/, /[ZŹ]R[OÓ]D[LŁ]O/, /CIEP[LŁ]A/] }
];

// Etykiety, ktore NIE sa samodzielnymi polami do wyciagniecia (nikt ich nie
// zbiera do Excela), ale musza byc rozpoznawane jako stop-granica dla
// collectValueWords - inaczej wartosc SASIEDNIEGO pola "przeciekaloby" w ich
// strone. Formularz Kotly/Solary (woj. lodzkie, dodany 2026-07-22) ma DWA
// takie przypadki, oba zlapane na realnych plikach: "rodzaj kotła:" to
// KONTYNUACJA etykiety "2. Istniejące źródło ciepła moc: ... kW rodzaj
// kotła: ..." (drugi blank w tym samym punkcie, ktorego nie wyciagamy do
// Excela) - bez tego wpisu kotlyMocIstniejacegoZrodla zbiera "185 kW rodzaj
// kotła" zamiast samego "185". Naglowek sekcji 8 (SECTION_HEADERS'
// solaryZasobnikSection) NIE wchodzi automatycznie do ALL_LABEL_PATTERNS
// (tylko SIMPLE_FIELDS/SECTION_SUBFIELDS wchodza), wiec solaryPokrycieDachu
// (punkt 7, tuz nad punktem 8) przeciekalo w "montażu zasobnika solarnego".
const UNTRACKED_LABEL_PATTERNS = [
  [/RODZAJ/, /KOT[LŁ]A/],
  [/PLANOWANE/, /MIEJSCE/, /MONTA[ZŻ]U/, /ZASOBNIKA/],
  // "(podać jakie)" - parentetyczna instrukcja PO wolnym miejscu na
  // odpowiedz przy solaryPokrycieDachu (punkt 7) - bez tego jako granicy,
  // odpowiedz przeciekala az do tych slow.
  [/PODA[CĆ]/, /JAKIE/],
  // "1. Moc kotła:" (naglowek sekcji z checkboxami 10-30 kW) - bez tego jako
  // granicy, "Liczba osob mieszkajacych w budynku" (linia tuz nad tym
  // naglowkiem na tym formularzu) potrafila zebrac fragment tej linii
  // checkboxow ("30 kW") jako wlasna wartosc.
  [/^MOC$/, /KOT[LŁ]A/]
];

const ALL_LABEL_PATTERNS = [
  ...SIMPLE_FIELDS.map((f) => f.labelPatterns),
  ...SECTION_SUBFIELDS.map((f) => f.labelPatterns),
  ...UNTRACKED_LABEL_PATTERNS
];

const COLUMN_ORDER = [
  'adres',
  ...SIMPLE_FIELDS.map((f) => f.key),
  ...SECTION_SUBFIELDS.map((f) => f.key),
  ...CHECKED_LINE_FIELDS.map((f) => f.key),
  ...CHECKBOX_FIELDS.map((f) => f.key),
  ...INLINE_CHOICE_FIELDS.map((f) => f.key),
  ...MULTI_CHECKBOX_FIELDS.map((f) => f.key),
  ...MATERIAL_FIELDS.map((f) => f.key),
  ...MULTI_MATERIAL_FIELDS.map((f) => f.key),
  ...RZGOW_SIMPLE_FIELDS.map((f) => f.key)
];
const COLUMN_LABELS = { adres: 'Adres' };
for (const f of [...SIMPLE_FIELDS, ...SECTION_SUBFIELDS, ...CHECKED_LINE_FIELDS, ...CHECKBOX_FIELDS, ...INLINE_CHOICE_FIELDS, ...MULTI_CHECKBOX_FIELDS, ...MATERIAL_FIELDS, ...MULTI_MATERIAL_FIELDS, ...RZGOW_SIMPLE_FIELDS]) {
  COLUMN_LABELS[f.key] = f.columnLabel;
}

function extractSimpleField(words, def, pageWidth, rangeStart = 0, rangeEnd, labelPositions) {
  const label = findLabel(words.slice(0, rangeEnd), def.labelPatterns, rangeStart);
  if (!label) return { value: '', confidence: null, found: false };
  // checkboxGated: pierwsze slowo etykiety to nazwa wlasnej opcji checkboxa
  // (np. "Piwnica"/"Skośny") - jesli TA konkretna opcja nie jest zaznaczona,
  // pole nie dotyczy tego dokumentu (found:false), a NIE "puste do
  // przegladu" - inaczej program pyta o wysokosc piwnicy nawet gdy budynek
  // nie ma piwnicy. Patrz komentarz przy SIMPLE_FIELDS.
  if (def.checkboxGated) {
    const firstIdx = label.indices[0];
    const marker = [words[firstIdx].text, firstIdx > 0 ? words[firstIdx - 1].text : ''];
    if (!marker.some((t) => CHECKBOX_CHECKED.test(t))) return { value: '', confidence: null, found: false };
  }
  // checkboxAnchorPattern: dla pol gdzie checkbox NIE jest na pierwszym
  // slowie wlasnej etykiety (np. "Izolacja dachu: |  Tak, pomiedzy
  // krokwiami/na zewnatrz*, grubosc: ...cm |  Nie" - etykieta pola to
  // "grubosc", ale checkbox do sprawdzenia jest na slowie "Tak" kilka slow
  // wczesniej, za daleko na prosty firstIdx-1 lookback).
  // UWAGA: szuka TYLKO do pozycji WLASNEJ etykiety (nie calej sekcji) i
  // bierze PIERWSZE (najblizsze) wystapienie wzorca, NIE "jakiekolwiek
  // zaznaczone w calej sekcji" - realny bug zlapany 2026-07-22 na
  // "Ściana fundamentowa": sekcja ta zawiera TAKZE nastepne, niezwiazane
  // pytanie "Ściana wielowarstwowa: Tak/Nie" - stara wersja skanowala cala
  // sekcje i "przeskakiwala" przez prawidlowe (ale niezaznaczone) "Tak" tuz
  // przed etykieta "grubosc", zamiast tego lapiac PRZYPADKOWO zaznaczone
  // "Tak" z tego zupelnie innego pytania kilkanascie slow dalej.
  if (def.checkboxAnchorPattern) {
    const searchEnd = Math.min(rangeEnd ?? words.length, Math.max(...label.indices));
    let anchorFound = false;
    let anchorChecked = false;
    for (let i = rangeStart; i < searchEnd; i++) {
      if (!def.checkboxAnchorPattern.test(words[i].text.toUpperCase())) continue;
      const marker = [words[i].text, i > 0 ? words[i - 1].text : ''];
      anchorFound = true;
      anchorChecked = marker.some((t) => CHECKBOX_CHECKED.test(t));
      break;
    }
    if (!anchorFound || !anchorChecked) return { value: '', confidence: null, found: false };
  }
  const labelWords = label.indices.map((idx) => words[idx]);
  const labelBBox = unionBBox(labelWords);
  let valueWords = collectValueWords(words, Math.max(...label.indices) + 1, labelBBox, pageWidth, ALL_LABEL_PATTERNS);
  // Druga proba - "strefowa" (patrz collectValueWordsInZone) - TYLKO gdy
  // pierwsza, wasko-liniowa proba nic nie znalazla. Pomysl wlasciciela
  // 2026-07-22: wyznacz strefe odpowiedzi na podstawie sasiednich, juz
  // znanych pytan, zamiast zgadywac tolerancje - lapie odpowiedzi napisane
  // nad LUB pod linia wlasnej etykiety, bez ryzyka zlepienia z sasiednim
  // polem (bo strefa jest naturalnie ograniczona przez NAJBLIZSZE INNE
  // znane pytanie, nie przez sztywna wielokrotnosc wysokosci).
  if (!valueWords.length && labelPositions) {
    valueWords = collectValueWordsInZone(words, labelBBox, labelPositions, ALL_LABEL_PATTERNS);
  }
  // extractSimpleField jest zawsze uzywana dla pol liczbowych/tekstowych
  // (nazwa, telefon, data, liczba, grubosc...) - nigdy dla prawdziwej
  // odpowiedzi Tak/Nie (te ida przez INLINE_CHOICE_FIELDS/CHECKBOX_FIELDS),
  // wiec bare "Tak"/"Nie" na KONCU zebranej wartosci jest zawsze smieciem z
  // geometrycznie sasiadujacej, ale niepowiazanej nastepnej opcji checkboxa
  // (Vision'owy word-order nie jest kolejnoscia czytania - patrz komentarz
  // przy collectValueWords) - realny przypadek zlapany 2026-07-22:
  // "grubosc: 8 cm Nie" (bare "Nie", bez wlasnego glifu checkboxa, wiec
  // CHECKBOX_UNCHECKED go nie zlapal).
  while (valueWords.length && /^(TAK|NIE)$/.test(valueWords[valueWords.length - 1].text.toUpperCase())) {
    valueWords = valueWords.slice(0, -1);
  }
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
  if (checked.ambiguous) {
    // Pokazujemy oba sprzeczne odczyty w wartosci (zamiast pustego pola) -
    // uzytkownik od razu widzi NA CZYM polega problem przy przegladzie,
    // a COMPOSITE_CONFIDENCE_CAP gwarantuje, ze to zawsze trafia do
    // recznego sprawdzenia, nigdy nie zostanie po cichu zaakceptowane.
    return {
      value: `Sprzeczne odczyty: ${checked.conflictLabels.join(' / ')}`,
      confidence: Math.min(wordConfidence(checked.words) ?? 1, COMPOSITE_CONFIDENCE_CAP),
      found: true,
      labelBBox: unionBBox(checked.words),
      valueBBox: unionBBox(checked.words)
    };
  }
  if (!checked.option) return { value: '', confidence: null, found: true };
  return {
    value: checked.option.label,
    // Wnioskowanie przez eliminacje (patrz findCheckedOption) to NIE jest
    // bezposrednia obserwacja checkboxa - zawsze cap ponizej progu, zeby
    // uzytkownik i tak potwierdzil, nawet gdy slowa same w sobie mialy
    // wysoka pewnosc OCR.
    confidence: checked.inferredByElimination ? Math.min(wordConfidence(checked.words) ?? 1, COMPOSITE_CONFIDENCE_CAP) : wordConfidence(checked.words),
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

// checkboxAnchorPattern (opcjonalne) - dla pol typu "Izolacja: Tak/Nie |
// Material: Styropian.../Wełna.../Pianka..." gdzie wybor materialu ma sens
// TYLKO gdy "Tak" jest zaznaczone - patrz komentarz przy
// extractSimpleField's checkboxAnchorPattern, ta sama idea.
function extractMaterialField(words, def, rangeStart, rangeEnd) {
  // Bierze PIERWSZE (najblizsze) wystapienie wzorca w zakresie, nie
  // "jakiekolwiek zaznaczone" - patrz komentarz przy extractSimpleField's
  // checkboxAnchorPattern (ta sama poprawka, ten sam realny bug).
  if (def.checkboxAnchorPattern) {
    const end = rangeEnd ?? words.length;
    let anchorFound = false;
    let anchorChecked = false;
    for (let i = rangeStart; i < end; i++) {
      if (!def.checkboxAnchorPattern.test(words[i].text.toUpperCase())) continue;
      const marker = [words[i].text, i > 0 ? words[i - 1].text : ''];
      anchorFound = true;
      anchorChecked = marker.some((t) => CHECKBOX_CHECKED.test(t));
      break;
    }
    if (!anchorFound || !anchorChecked) return { value: '', confidence: null, found: false };
  }
  const checked = findCheckedOption(words, def.options, rangeStart, rangeEnd);
  if (!checked) return { value: '', confidence: null, found: false };
  if (checked.ambiguous) {
    return {
      value: `Sprzeczne odczyty: ${checked.conflictLabels.join(' / ')}`,
      confidence: Math.min(wordConfidence(checked.words) ?? 1, COMPOSITE_CONFIDENCE_CAP),
      found: true,
      labelBBox: unionBBox(checked.words),
      valueBBox: unionBBox(checked.words)
    };
  }
  if (!checked.option) return { value: '', confidence: null, found: true };
  const optionBBox = unionBBox(checked.words);
  // freeText: dla opcji typu "Inny: ......." (np. wariant formularza z
  // Rychwala, gdzie "Ściana fundamentowa" moze byc "Inny: bloczek" -
  // odrecznie wpisane slowo, nie liczba) - collectValueWords zamiast
  // szukania konkretnie liczby.
  if (checked.option.freeText) {
    const textWords = collectValueWords(words, Math.max(...checked.words.map((w) => words.indexOf(w))) + 1, optionBBox, Infinity, []);
    const value = textWords.length ? `${checked.option.label}: ${textWords.map((w) => w.text).join(' ')}` : checked.option.label;
    const conf = Math.min(wordConfidence(checked.words) ?? 1, COMPOSITE_CONFIDENCE_CAP);
    return { value, confidence: conf, found: true, labelBBox: optionBBox, valueBBox: textWords.length ? unionBBox(textWords) : optionBBox };
  }
  const numberWords = collectValueWords(words, Math.max(...checked.words.map((w) => words.indexOf(w))) + 1, optionBBox, Infinity, []);
  const numeric = numberWords.find((w) => /\d/.test(w.text));
  const value = numeric ? `${checked.option.label}, ${numeric.text}` : checked.option.label;
  const conf = Math.min(wordConfidence(checked.words) ?? 1, COMPOSITE_CONFIDENCE_CAP);
  return { value, confidence: conf, found: true, labelBBox: optionBBox, valueBBox: numeric ? bbox(numeric) : optionBBox };
}

// Jak extractMaterialField, ale dla pol WIELOKROTNEGO wyboru gdzie KAZDA
// zaznaczona opcja ma wlasna liczbe (np. "Podloga na gruncie - zaznaczyc
// wystepujace warstwy" - moze byc zaznaczone kilka na raz, kazda z wlasna
// gruboscia).
function extractMultiMaterialField(words, def, rangeStart, rangeEnd) {
  const found = findAllCheckedOptions(words, def.options, rangeStart, rangeEnd);
  if (!found.length) return { value: '', confidence: null, found: false };
  const parts = [];
  const allWords = [];
  for (const f of found) {
    const optionBBox = unionBBox(f.words);
    const numberWords = collectValueWords(words, Math.max(...f.words.map((w) => words.indexOf(w))) + 1, optionBBox, Infinity, []);
    const numeric = numberWords.find((w) => /\d/.test(w.text));
    parts.push(numeric ? `${f.option.label}, ${numeric.text}` : f.option.label);
    allWords.push(...f.words, ...(numeric ? [numeric] : []));
  }
  return {
    value: parts.join(' | '),
    confidence: Math.min(wordConfidence(allWords) ?? 1, COMPOSITE_CONFIDENCE_CAP),
    found: true,
    labelBBox: unionBBox(allWords),
    valueBBox: unionBBox(allWords)
  };
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
  // pageWidth=Infinity (nie prawdziwa szerokosc strony) - wylacza limit
  // "polowa strony" w collectValueWords, ktory mial zapobiegac
  // przeskakiwaniu do SASIEDNIEJ KOLUMNY na prostszych stronach. gapMultiplier
  // 14 (nie domyslne 6) - podniesiony limit odstepu miedzy etykieta a jej
  // wartoscia. Strona 2 tego formularza upakowuje po 2 numerowane pytania w
  // jednym gestym wierszu (np. "13. Cyrkulacja c.w.u.: Tak Nie  14. Pompa
  // cyrkulacji..."), wiec prawdziwa odpowiedz (np. zaznaczone "Nie") wypada
  // daleko na prawo (potwierdzone na realnym pliku: odstep ~10x wysokosci
  // etykiety) i byla odrzucana przez OBA limity (56% szerokosci strony ORAZ
  // limit odstepu 6x) - realny bug zlapany 2026-07-22 (dostepInternet/
  // cyrkulacjaCwu/pompaCyrkulacji/kratkaOdplywowa/reduktorWody i inne
  // wychodzily puste mimo wyraznie zaznaczonego checkboxa na skanie).
  // Bezpieczne mimo usunietych limitow, bo szukamy tylko slowa z
  // KONKRETNEGO, waskiego zestawu `def.choices` (nie dowolnego tekstu) -
  // ten sam wzorzec juz uzywany w MATERIAL_FIELDS' numeric-grab.
  const valueWords = collectValueWords(words, Math.max(...label.indices) + 1, labelBBox, Infinity, ALL_LABEL_PATTERNS, 14);
  for (let i = 0; i < valueWords.length; i++) {
    const text = valueWords[i].text.toUpperCase();
    // Znacznik zaznaczenia bywa 2+ slowa wstecz, nie tylko bezposrednio
    // przed (np. "☑ | Układ | otwarty" - "otwarty" to jest slowo
    // rozrozniajace opcje, ale checkbox jest przy "Układ", 2 pozycje
    // wczesniej) - sprawdzamy do 3 slow wstecz, nie tylko i-1 (realny
    // przypadek zlapany 2026-07-22).
    const nearbyChecked = [text, ...valueWords.slice(Math.max(0, i - 3), i).map((w) => w.text)].some((t) => CHECKBOX_CHECKED.test(t));
    if (!nearbyChecked) continue;
    // Niektore odpowiedzi Vision dzieli na wiele tokenow (np. "3-fazowa"
    // jako trzy osobne slowa "3"/"-"/"fazowa") - sklejamy do 3 kolejnych
    // slow i probujemy dopasowac tez do tego (realny przypadek zlapany
    // 2026-07-22: "3-fazowa" nie dopasowywalo sie do zadnego pojedynczego
    // tokenu).
    const joined = valueWords.slice(i, i + 3).map((w) => w.text).join('').toUpperCase();
    const choice = def.choices.find((c) => c.pattern.test(text) || c.pattern.test(joined));
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
// Heurystyka "czy to wyglada jak prawdziwy odczyt, nie belkot OCR" - bez
// slownika/AI (ta apka ma juz jedyne polaczenie sieciowe w calym Scyzoryku
// - Vision - nie dodajemy kolejnego zaleznosci ani wywolania). Zgloszone
// przez wlasciciela 2026-07-22: przy 100 audytach na raz liczba pol do
// recznego potwierdzenia/wpisania to bedzie najwiekszy koszt czasowy, wiec
// niskopewne odczyty ktore i tak trafiaja do przegladu powinny byc
// pokazywane jako podpowiedz w polu do wpisania TYLKO gdy wygladaja
// sensownie - w przeciwnym razie lepiej pokazac puste pole (uzytkownik i
// tak musi to sprawdzic/wpisac recznie, ale bledna podpowiedz moglaby
// zmylic pochopne "Enter" bez czytania skanu).
// - Pola liczbowe (valueKind:'numeric' - data/kat/grubosc/ilosc/...): musi
//   zawierac przynajmniej jedna cyfre.
// - Pola tekstowe: stosunek samoglosek do wszystkich liter - prawdziwe
//   polskie/angielskie slowo ma jakas naturalna proporcje (np. "Wicher" =
//   2/6 ≈ 33%), przypadkowy belkot OCR typu "sdvnjsv;sjk" ma zero
//   samoglosek. Prog 15% jest celowo permisywny (male ryzyko odrzucenia
//   prawdziwej, ale niefortunnie skroconej wartosci).
const POLISH_VOWELS = /[aeiouyąęó]/gi;
function looksPlausible(text, valueKind) {
  const trimmed = (text || '').trim();
  if (!trimmed) return true; // puste to inna sprawa - needsReview i tak zadziala
  if (valueKind === 'numeric') {
    // Wymaga cyfry NIEPRZYKLEJONEJ do litery przed nia - odrzuca
    // niewypelniona kropkowana linie formularza zlepiona z drukowana
    // jednostka jako jeden token OCR (np. "..m2" dla pustego pola
    // "powierzchnia okien: ....m2") - jedyna "cyfra" to '2' z "m2", ktora
    // nie jest prawdziwa odpowiedzia. Realny przypadek zlapany 2026-07-22
    // przy dodawaniu pol elewacji A-D (strona "OBRYS BUDYNKU"). Prawdziwe
    // wartosci jak "8cm"/"40°"/"100%" nadal przechodza, bo tam cyfra jest
    // na POCZATKU (albo po spacji/nawiasie), nie po literze.
    if (!/(^|[^\p{L}])\d/u.test(trimmed)) return false;
    // Dwie osobne, "gole" liczby (np. "40 0") to zwykle dwa niezalezne,
    // kolidujace odczyty (np. prawdziwa liczba + osobno zmyslony token z
    // odrecznego znaku stopnia), NIE jedna prawdziwa wartosc - prawdziwe
    // pomiary/daty/wymiary maja separator (°, cm, /, x, :, .) miedzy
    // liczbami, nigdy goly odstep. Realny przypadek zlapany 2026-07-22:
    // "40 0" (kat dachu) mial wysoka pewnosc i auto-zatwierdzil sie mimo
    // ze druga liczba to smiec.
    const bareNumberTokens = trimmed.split(/\s+/).filter((t) => /^\d+$/.test(t));
    if (bareNumberTokens.length >= 2) return false;
    return true;
  }
  const letters = trimmed.replace(/[^a-ząćęłńóśźżA-ZĄĆĘŁŃÓŚŹŻ]/g, '');
  if (letters.length < 3) return true; // zbyt krotkie by ocenic sensownie, nie blokuj
  const vowelCount = (letters.match(POLISH_VOWELS) || []).length;
  return vowelCount / letters.length >= 0.15;
}

// found:false znaczy "ta etykieta/checkbox/sekcja NIE wystapila ANI RAZU w
// calym dokumencie" - to pole strukturalnie nie dotyczy TEGO KONKRETNEGO
// formularza (np. pole specyficzne dla wariantu Rzgow na dokumencie z innej
// gminy, albo cala sekcja z drugiej strony formularza ktorej dany szablon
// nie ma) - uzytkownik i tak nie ma czego przepisac ze skanu, wiec NIE
// trafia do kolejki recznego przegladu (needsReview:false, resolved:true od
// razu, puste w Excelu) - odroznione od found:true+value:'' (etykieta
// istnieje, ale nic nie zaznaczono/nie udalo sie odczytac - TO juz jest
// prawdziwy przypadek do przegladu).
function toFieldResult(extracted, pageIndex, valueKind) {
  if (!extracted.found) {
    return { value: '', confidence: null, pageIndex, labelBBox: null, valueBBox: null, needsReview: false, resolved: true };
  }
  let value = extracted.value || '';
  // Belkot OCR nie jest wartosciowa podpowiedzia - czyscimy PRZED
  // needsReview, wiec pole z belkotem zawsze trafia do przegladu z pustym
  // polem do wpisania, nawet jesli surowa pewnosc OCR byla wysoka (Vision
  // bywa bardzo pewny siebie przy zle odczytanym pismie recznym).
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

// Laczy slowa wszystkich stron bloku - fieldExtraction dziala na
// POJEDYNCZEJ stronie na raz (realne formularze nie rozdzielaja jednego
// pola na dwie strony), probujac kazda strone bloku po kolei.
function extractFields(pages, block) {
  const blockPages = pages.slice(block.startPage, block.endPage + 1).filter((p) => p.imagePath && p.ocrWords);
  const result = {};

  const perPageSections = new Map();
  for (const page of blockPages) perPageSections.set(page.pageIndex, findAllSectionStarts(page.ocrWords));

  const perPageLabelPositions = new Map();
  for (const page of blockPages) perPageLabelPositions.set(page.pageIndex, findAllKnownLabelPositions(page.ocrWords));

  function tryEachPage(fn, valueKind) {
    let best = { value: '', confidence: null, found: false };
    let bestPageIndex = null;
    for (const page of blockPages) {
      const extracted = fn(page);
      if (extracted.found && extracted.value) return toFieldResult(extracted, page.pageIndex, valueKind);
      if (extracted.found && !best.found) { best = extracted; bestPageIndex = page.pageIndex; }
    }
    return toFieldResult(best, bestPageIndex, valueKind);
  }

  for (const def of SIMPLE_FIELDS) {
    result[def.key] = tryEachPage((page) => extractSimpleField(page.ocrWords, def, page.width, 0, undefined, perPageLabelPositions.get(page.pageIndex)), def.valueKind);
  }

  for (const def of SECTION_SUBFIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey);
      if (!range) return { value: '', confidence: null, found: false };
      return extractSimpleField(page.ocrWords, def, page.width, range.start, range.end, perPageLabelPositions.get(page.pageIndex));
    }, def.valueKind);
  }

  for (const def of CHECKED_LINE_FIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey);
      if (!range) return { value: '', confidence: null, found: false };
      return extractCheckedLineField(page.ocrWords, def, range.start, range.end);
    });
  }

  for (const def of CHECKBOX_FIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = def.sectionKey ? findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey) : null;
      if (def.sectionKey && !range) return { value: '', confidence: null, found: false };
      return extractCheckboxField(page.ocrWords, def, range?.start, range?.end);
    });
  }

  for (const def of INLINE_CHOICE_FIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = def.sectionKey ? findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey) : null;
      if (def.sectionKey && !range) return { value: '', confidence: null, found: false };
      return extractInlineChoiceField(page.ocrWords, def, page.width, range?.start, range?.end);
    });
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
    result[def.key] = tryEachPage((page) => extractSimpleField(page.ocrWords, def, page.width, 0, undefined, perPageLabelPositions.get(page.pageIndex)));
  }

  for (const def of MULTI_MATERIAL_FIELDS) {
    result[def.key] = tryEachPage((page) => {
      const range = def.sectionKey ? findSectionRange(page.ocrWords, perPageSections.get(page.pageIndex), def.sectionKey) : null;
      if (def.sectionKey && !range) return { value: '', confidence: null, found: false };
      return extractMultiMaterialField(page.ocrWords, def, range?.start, range?.end);
    });
  }

  return result;
}

module.exports = { extractFields, COLUMN_ORDER, COLUMN_LABELS, LOW_CONFIDENCE_THRESHOLD };
