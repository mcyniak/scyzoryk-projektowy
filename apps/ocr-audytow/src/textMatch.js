// Niskopoziomowe, czyste funkcje dopasowywania sekwencji slow/geometrii,
// wspoldzielone przez fieldExtraction.js (dopasowanie na plaskiej liscie
// ocrWords) i formFieldMatch.js (dopasowanie na ustrukturyzowanych
// formFields z Document AI) - wydzielone 2026-07-22 przy migracji na
// Document AI, zeby uniknac cyklu importow (fieldExtraction.js potrzebuje
// formFieldMatch.js, ktory z kolei potrzebowalby tych samych funkcji z
// fieldExtraction.js).

const ADJACENCY_WINDOW = 2;
const CHECKBOX_CHECKED = /[☑☒✓✔]/;
// Niezaznaczony checkbox - UWAGA: celowo NIE laczymy tego z CHECKBOX_CHECKED
// w jeden "glif checkboxa" - patrz uzasadnienie w fieldExtraction.js przy
// uzyciu CHECKBOX_UNCHECKED (extractInlineChoiceField wymaga, zeby
// zaznaczone "☑Tak"/"☒Nie" nadal przechodzily przez collectValueWords).
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
// etykiety - nie ze etykieta zaczyna sie "gdzies niedaleko idx" (patrz
// dlugi komentarz w fieldExtraction.js przy oryginalnym miejscu tej funkcji).
function startsAnyLabel(words, idx, allLabelPatterns) {
  return allLabelPatterns.some((patterns) => patterns[0].test(words[idx].text.toUpperCase()) && matchSequenceFrom(words, patterns, idx) !== null);
}

// Tokenizuje dowolny tekst (np. `formField.fieldName`'s polaczona tresc z
// Document AI) na "slowa" w tym samym sensie co ocrWords[].text - dzieli po
// bialych znakach, zachowuje interpunkcje jako osobne tokeny tam gdzie juz
// jest oddzielona spacja (Document AI zwraca fieldName jako jeden string,
// nie liste slow, wiec potrzebujemy tej samej "tablicy slow", zeby reuzyc
// matchSequenceFrom bez zmian).
function tokenizeText(text) {
  return (text || '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ text: t }));
}

module.exports = {
  ADJACENCY_WINDOW,
  CHECKBOX_CHECKED,
  CHECKBOX_UNCHECKED,
  bbox,
  unionBBox,
  matchSequenceFrom,
  findLabel,
  startsAnyLabel,
  tokenizeText
};
