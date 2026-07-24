// Etap 3 planu: wykrywanie granic blokow wieloadresowych w zbundlowanym pliku
// (np. "Audyt Kazimierz Biskupi 1-4.pdf" - 4 adresy w jednym 20-stronicowym
// PDF-ie, po 5 stron kazdy) na podstawie powtarzajacego sie naglowka
// pierwszej strony kazdego bloku ("PROTOKOL UZGODNIEN MONTAZOWYCH" /
// "SPORZADZONY DNIA"). Dziala na tekscie JUZ rozpoznanym przez silnik OCR
// (kazda strona ma juz `ocrWords` - liste slow w kolejnosci odczytu, patrz
// documentAiEngine.js) - zero dodatkowego przebiegu OCR.
//
// To tylko PROPOZYCJA podzialu. Wlasciciel byl stanowczy: nigdy nie dzielic
// w pelni automatycznie bez przegladu ("czasami trudno odczytac tekst z
// tych audytow") - wywolujacy (server.js) zawsze pokazuje ekran
// potwierdzenia z miniaturami stron, a uzytkownik moze poprawic granice
// przed faktycznym podzialem.

// Kazda para to (pierwsze slowo naglowka, drugie slowo naglowka), ktore w
// PRAWDZIWYM naglowku wystepuja bezposrednio obok siebie ("PROTOKOL
// UZGODNIEN...", "SPORZADZONY DNIA:"). Samo wystapienie obu slow GDZIEKOLWIEK
// na stronie to za slabe kryterium - realna strona z oswiadczeniem/RODO tez
// zawiera oba slowa w zwyklym tekscie akapitu ("Ustalenia zostaly zawarte w
// niniejszym PROTOKOLE" ... "zapoznalem/am sie z UZGODNIENIAMI"), tyle ze
// oddzielone dziesiatkami innych slow - zweryfikowane na realnym pliku
// (Kazimierz Biskupi), gdzie luzne dopasowanie dawalo falszywe granice na
// kazdej stronie z oswiadczeniem (ostatniej stronie kazdego bloku).
const HEADER_PAIR_GROUPS = [
  [/PROTOK/, /UZGODN/],
  [/SPORZ/, /DNIA/]
];
// Dopuszcza maks. 1 obcy token miedzy para (typowy szum OCR na gestym
// formularzu), ale nie dowolna odleglosc na calej stronie.
const ADJACENCY_WINDOW = 2;

function looksLikeBlockHeader(words) {
  return HEADER_PAIR_GROUPS.some(([first, second]) => {
    for (let i = 0; i < words.length; i++) {
      if (!first.test(words[i])) continue;
      for (let j = i + 1; j <= Math.min(i + ADJACENCY_WINDOW, words.length - 1); j++) {
        if (second.test(words[j])) return true;
      }
    }
    return false;
  });
}

// imagedPages: pages.filter(p => p.imagePath), kazda juz ma `ocrWords`
// (patrz analyzeDocument w ocrPipeline.js) - lista {text, ...} w kolejnosci
// odczytu zwroconej przez silnik OCR.
function detectBlockBoundaries({ imagedPages }) {
  const boundaries = [];
  for (const page of imagedPages) {
    const words = (page.ocrWords || []).map((w) => w.text.toUpperCase());
    if (looksLikeBlockHeader(words)) boundaries.push(page.pageIndex);
  }
  if (boundaries[0] !== 0) boundaries.unshift(0);
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

function boundariesToBlocks(boundaries, pageCount) {
  return boundaries.map((start, i) => ({
    startPage: start,
    endPage: i + 1 < boundaries.length ? boundaries[i + 1] - 1 : pageCount - 1
  }));
}

module.exports = { detectBlockBoundaries, boundariesToBlocks };
