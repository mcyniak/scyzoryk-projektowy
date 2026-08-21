// Logika wspolna dla wszystkich silnikow ekstrakcji pol formularza audytu
// (src/geminiFieldEngine.js, src/openaiFieldEngine.js) - wydzielone
// 2026-08-19 przy dodaniu drugiego dostawcy (OpenAI, obok Gemini - patrz
// src/aiProvider.js), zeby prompt/tresc instrukcji byla JEDNYM zrodlem
// prawdy niezaleznie od tego, ktory dostawca akurat jest aktywny (kazdy
// dostawca ma WLASNY dialekt JSON Schema, wiec SAM SCHEMAT zostaje osobno
// w kazdym silniku - tu jest tylko to, co jest naprawde identyczne).
const fs = require('fs/promises');
const { PDFDocument } = require('pdf-lib');

// Audyt zuzycia RAM/CPU 2026-08-21: gdy zakres OBEJMUJE CALY dokument
// (startPage=0, endPage=totalPages-1 - dokladnie tak wola dzis
// detectBlockStartPages), poprzednia wersja i tak robila
// PDFDocument.load() -> PDFDocument.create() -> copyPages() -> save(), zeby
// wyprodukowac bajt w bajt tę samą zawartosc co oryginal - dla 50-100 MB
// skanu to realny, zbedny pik RAM/CPU. `totalPages` jest OPCJONALNY (istniejace
// wywolania per-blok nie musza go podawac) - fast-path aktywuje sie tylko,
// gdy wywolujacy jawnie potwierdzi, ze to naprawde caly dokument.
async function pdfSliceToBase64(sourcePdfPath, startPage, endPage, totalPages) {
  const sourceBytes = await fs.readFile(sourcePdfPath);
  if (totalPages != null && startPage === 0 && endPage === totalPages - 1) {
    return sourceBytes.toString('base64');
  }
  const sourceDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  const sliceDoc = await PDFDocument.create();
  const pageIndexes = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
  const copied = await sliceDoc.copyPages(sourceDoc, pageIndexes);
  copied.forEach((p) => sliceDoc.addPage(p));
  const sliceBytes = await sliceDoc.save();
  return Buffer.from(sliceBytes).toString('base64');
}

const EXTRACTION_PROMPT_HEADER = `Jestes systemem transkrypcji formularzy audytu energetycznego (protokol uzgodnien montazowych).
Odczytuj WYLACZNIE wartosci widoczne w dokumencie (drukowane i odreczne, w tym zaznaczone checkboxy).
Nie uzupelniaj brakujacych wartosci na podstawie wiedzy ani domyslow.
Nie poprawiaj wartosci, nawet jesli wygladaja na bledne technicznie.
Dla pol typu checkbox/wybor zwroc dokladnie jedna z podanych dozwolonych wartosci (lub null jesli nic nie zaznaczono / kilka zaznaczen jednoczesnie w sposob niejednoznaczny).
Dla pol z materialem i gruboscia zwroc jeden string "material, grubosc" (np. "Styropian, 10cm").
Jezeli pole nie wystepuje w dokumencie, jest puste lub nieczytelne, zwroc null.
Zachowuj dokladnie polskie znaki diakrytyczne.
Rozroznij przecinek dziesietny od cyfry 1. Nie przeliczaj jednostek.

Pola do wypelnienia:
`;

// Sam TEKST promptu (bez schematu - kazdy dostawca ma wlasny dialekt JSON
// Schema, patrz komentarz na gorze pliku) - identyczny niezaleznie od tego,
// ktory silnik go wysyla.
function buildExtractionPrompt(fieldDefs) {
  const fieldDocs = fieldDefs.map((def) => {
    const optStr = def.options?.length ? ` (dozwolone wartosci: ${def.options.map((o) => o.label).join(' | ')})` : '';
    const noteStr = def.note ? ` (${def.note})` : '';
    return `- ${def.key}: ${def.columnLabel}${optStr}${noteStr}`;
  });
  return EXTRACTION_PROMPT_HEADER + fieldDocs.join('\n');
}

const BOUNDARY_PROMPT = `Ten PDF moze zawierac JEDEN lub WIELE oddzielnych formularzy "PROTOKOL UZGODNIEN MONTAZOWYCH" (kazdy zaczyna sie naglowkiem zawierajacym oba fragmenty: "PROTOKOL UZGODNIEN..." oraz "SPORZADZONY DNIA:").
Znajdz numer KAZDEJ strony (liczac od 0), na ktorej zaczyna sie NOWY taki formularz - czyli strone z tym naglowkiem NA GORZE.
Strona z samym oswiadczeniem/RODO/podpisem NIE liczy sie jako nowy poczatek.
Zwroc rosnaco posortowana liste numerow stron w polu blockStartPages. Pierwszy formularz zawsze zaczyna sie od strony 0, wiec 0 zawsze powinno byc w liscie.`;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} - przekroczono limit czasu (${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { pdfSliceToBase64, buildExtractionPrompt, BOUNDARY_PROMPT, withTimeout, sleep };
