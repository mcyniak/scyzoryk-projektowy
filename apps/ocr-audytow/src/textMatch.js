// Wspoldzielone przez fieldExtraction.js/formFieldMatch.js/tableMatch.js - glify
// checkboxow uzywane wszedzie do sprawdzania "zaznaczone/niezaznaczone".
//
// (Ten plik kiedys zawieral tez sekwencyjne dopasowywanie slow
// (matchSequenceFrom/findLabel/startsAnyLabel/tokenizeText/bbox/unionBBox) z
// czasow architektury opartej na plaskiej liscie ocrWords - usuniete
// 2026-07-23 jako martwy kod: po przejsciu na dopasowywanie przez
// tables/formFields Document AI (fieldExtraction.js, formFieldMatch.js,
// tableMatch.js) nic juz tego nie importowalo.)
const CHECKBOX_CHECKED = /[☑☒✓✔]/;
// Niezaznaczony checkbox - UWAGA: celowo NIE laczymy tego z CHECKBOX_CHECKED
// w jeden "glif checkboxa" - patrz uzasadnienie w fieldExtraction.js przy
// uzyciu CHECKBOX_UNCHECKED (extractInlineChoiceField wymaga, zeby
// zaznaczone "☑Tak"/"☒Nie" nadal przechodzily przez collectValueWords).
const CHECKBOX_UNCHECKED = /[☐□]/;

// Bylo zduplikowane bajt-w-bajt w formFieldMatch.js i tableMatch.js (2026-07-24,
// znalezione przy przegladzie kodu) - jeden wspolny helper zamiast dwoch kopii.
function verticesToRect(vertices) {
  if (!vertices || !vertices.length) return null;
  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

module.exports = { CHECKBOX_CHECKED, CHECKBOX_UNCHECKED, verticesToRect };
