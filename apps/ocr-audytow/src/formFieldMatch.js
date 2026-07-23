// Dopasowywanie definicji pol do formFields z Document AI - PRZEPROJEKTOWANE
// 2026-07-22 (od podstaw, nie port z Vision): fieldName jest zwykle krotka,
// kompletna fraza (nie luzny strumien slow do sekwencyjnego dopasowania), wiec
// wystarczy JEDEN regex testowany na calym stringu - prostsze i bardziej
// niezawodne niz poprzednia wersja (tokenizacja + matchSequenceFrom, portowana
// z modelu myslenia zaprojektowanego pod plaska liste slow).
const { CHECKBOX_CHECKED, CHECKBOX_UNCHECKED } = require('./textMatch');

function verticesToRect(vertices) {
  if (!vertices || !vertices.length) return null;
  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Document AI's fieldValue bywa "surowym" stringiem z kropkami niewypelnionej
// linii formularza (np. "....120." dla odpowiedzi "120") i/albo z wieloma
// polaczonymi liniami - usuwa kropki/spacje brzegowe, zamienia wewnetrzne
// nowe linie na spacje.
function cleanFieldValue(text) {
  return (text || '')
    .replace(/\n+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
}

// Geometryczny fallback stanu checkboxa - szuka NAJBLIZSZEGO (ta sama linia,
// na lewo) elementu z visualElements (filled_checkbox/unfilled_checkbox)
// wzgledem danego bbox etykiety. Uzywany, gdy fieldValue nie zawiera zadnego
// glifu checkboxa (Document AI czasem klasyfikuje checkbox jako visualElement,
// ale nie paruje go z wartoscia formField - zweryfikowane na realnym pliku,
// Galewice koc iol: checkbox "25 kW" byl w visualElements z confidence 0.51,
// ale formFields'owa wartosc byla pusta).
function findNearbyVisualElement(labelBBox, visualElements) {
  if (!labelBBox || !visualElements?.length) return null;
  const labelHeight = labelBBox.maxY - labelBBox.minY || 20;
  let best = null;
  let bestDist = Infinity;
  for (const el of visualElements) {
    const xs = el.bbox.map((v) => v.x);
    const ys = el.bbox.map((v) => v.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const midY = (minY + maxY) / 2;
    const labelMidY = (labelBBox.minY + labelBBox.maxY) / 2;
    if (Math.abs(midY - labelMidY) > labelHeight * 0.6) continue;
    if (minX > labelBBox.minX) continue; // checkbox zawsze na lewo od etykiety
    const dist = labelBBox.minX - maxX;
    if (dist < 0 || dist > labelHeight * 4) continue;
    if (dist < bestDist) { bestDist = dist; best = el; }
  }
  return best;
}

// Szuka formField, ktorego fieldName pasuje do `pattern` (JEDEN regex na caly
// string) - zwraca {value, confidence, labelBBox, valueBBox} albo null.
// `valuePattern` (opcjonalny) - niektore etykiety powtarzaja sie identycznie
// kilka razy na tej samej stronie (np. "Przybliżona data montażu" dla
// stolarki/drzwi zewn/drzwi garaz) - PROBOWANE bylo rozroznianie po
// kolejnosci (N-te wystapienie), ale zweryfikowano na realnym pliku, ze
// Document AI NIE zwraca formFields w kolejnosci geometrycznej (J.Drzwi
// garazowe wystapilo PRZED I.Drzwi zewnetrzne w tablicy, mimo ze na stronie
// jest odwrotnie) - kolejnosc jest zawodna. Zamiast tego: kazda z tych
// wartosci ZAWIERA wlasny naglowek sekcji jako prefiks (np. "I. Drzwi
// zewnętrzne:\n2025") - `valuePattern` pozwala wybrac wlasciwe wystapienie
// po TEJ tresci wartosci, nie po pozycji w tablicy.
function findFormField(formFields, pattern, valuePattern = null) {
  for (const field of formFields || []) {
    if (!pattern.test(field.fieldName.toUpperCase())) continue;
    if (valuePattern && !valuePattern.test((field.fieldValue || '').toUpperCase())) continue;
    return {
      value: cleanFieldValue(field.fieldValue),
      confidence: field.valueConfidence,
      labelBBox: verticesToRect(field.fieldNameBBox),
      valueBBox: verticesToRect(field.valueBBox) || verticesToRect(field.fieldNameBBox)
    };
  }
  return null;
}

// Odpowiednik dla grup checkboxowych - kazda opcja ma wlasny `pattern`
// (dopasowywany do fieldName). Sprawdza checked przez (1) glif w fieldValue,
// (2) fallback geometryczny na visualElements. Zwraca {option, confidence,
// labelBBox, valueBBox} / {option:null, ambiguous:true, conflictLabels} /
// {option:null} (znaleziono opcje, nic zaznaczone) / null (brak dopasowania
// w ogole).
function findCheckedFormFieldOption(formFields, options, visualElements) {
  let anyOptionTextFound = false;
  const checkedMatches = [];
  for (const option of options) {
    for (const field of formFields || []) {
      if (!option.pattern.test(field.fieldName.toUpperCase())) continue;
      anyOptionTextFound = true;
      let checked = CHECKBOX_CHECKED.test(field.fieldValue || '');
      // Confidence dla przypadku "sam glif w fieldValue" bierzemy z
      // formField'a (juz oznacza pewnosc TEJ konkretnej wartosci). Ale gdy
      // checked pochodzi z fallbacku geometrycznego na visualElements (glifu
      // NIE bylo wcale w fieldValue), prawdziwym zrodlem pewnosci jest
      // pewnosc TEGO wykrycia (visualElement), nie formField'owa
      // valueConfidence dla PUSTEJ wartosci, ktora bywa myląco wysoka.
      let confidenceOverride = null;
      if (!checked && !CHECKBOX_UNCHECKED.test(field.fieldValue || '')) {
        const nearby = findNearbyVisualElement(verticesToRect(field.fieldNameBBox), visualElements);
        if (nearby?.type === 'filled_checkbox') { checked = true; confidenceOverride = nearby.confidence; }
      }
      if (checked) {
        checkedMatches.push({ option, field, confidenceOverride });
        break;
      }
    }
  }
  if (checkedMatches.length === 1) {
    const m = checkedMatches[0];
    return {
      option: m.option,
      confidence: m.confidenceOverride !== null ? m.confidenceOverride : m.field.valueConfidence,
      valueBBox: verticesToRect(m.field.valueBBox),
      labelBBox: verticesToRect(m.field.fieldNameBBox)
    };
  }
  if (checkedMatches.length > 1) {
    return { option: null, ambiguous: true, conflictLabels: checkedMatches.map((m) => m.option.label) };
  }
  return anyOptionTextFound ? { option: null } : null;
}

module.exports = { findFormField, findCheckedFormFieldOption, findNearbyVisualElement, verticesToRect, cleanFieldValue };
