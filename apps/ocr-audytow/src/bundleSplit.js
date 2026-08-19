// Wykrywanie granic blokow wieloadresowych w zbundlowanym pliku (np. "Audyt
// Kazimierz Biskupi 1-4.pdf" - 4 adresy w jednym 20-stronicowym PDF-ie, po 5
// stron kazdy) na podstawie powtarzajacego sie naglowka pierwszej strony
// kazdego bloku ("PROTOKOL UZGODNIEN MONTAZOWYCH" / "SPORZADZONY DNIA").
//
// Do 2026-08-12 to dzialalo na tekscie JUZ rozpoznanym przez Document AI
// (kazda strona miala `ocrWords`, patrz git history) - regex na parach slow
// w bliskim sasiedztwie, zeby odroznic prawdziwy naglowek od przypadkowego
// wystapienia obu slow w tekscie oswiadczenia/RODO. Zastapione przez
// model jezykowy (Gemini albo, od 2026-08-19, OpenAI - patrz
// src/aiProvider.js#detectBlockStartPages): widzi caly PDF na
// raz i sam wskazuje strony z naglowkiem - drukowany tekst byl bezblednie
// odczytywany we WSZYSTKICH testach porownawczych tej migracji (jedyne
// realne trudnosci dotyczyly pisma odrecznego), wiec to powinno byc
// rownie niezawodne albo lepsze niz dawny regex, bez utrzymywania wlasnej
// listy wzorcow naglowka w dwoch miejscach.
//
// To nadal tylko PROPOZYCJA podzialu. Wlasciciel byl stanowczy: nigdy nie
// dzielic w pelni automatycznie bez przegladu ("czasami trudno odczytac
// tekst z tych audytow") - wywolujacy (server.js) zawsze pokazuje ekran
// potwierdzenia z miniaturami stron, a uzytkownik moze poprawic granice
// przed faktycznym podzialem.
const { detectBlockStartPages } = require('./aiProvider');

async function detectBlockBoundaries({ sourcePdfPath, pageCount }) {
  const boundaries = await detectBlockStartPages({ sourcePdfPath, pageCount });
  return boundaries;
}

function boundariesToBlocks(boundaries, pageCount) {
  return boundaries.map((start, i) => ({
    startPage: start,
    endPage: i + 1 < boundaries.length ? boundaries[i + 1] - 1 : pageCount - 1
  }));
}

module.exports = { detectBlockBoundaries, boundariesToBlocks };
