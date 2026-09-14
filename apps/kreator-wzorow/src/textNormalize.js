// Pomocnicze funkcje tekstowe dla auto-konfiguracji Kreatora
// (autoConfigurator.js/domainAliases.js/mappingMemory.js). Czysty modul, bez
// zaleznosci npm, bez zadnej wiedzy o ksztalcie kandydata/arkusza - operuje
// wylacznie na stringach/tablicach.

const TRIVIAL_VALUES = new Set(['', '-', '—', 'x', 'tak', 'nie', '0', '1', '2', 'brak', 'n/a']);

// Liczba (z przecinkiem lub kropka) z opcjonalna jednostka, np.
// "5,52 kWp" / "5.52kWp" / "10". Grupa 1 = liczba, grupa 2 = jednostka (moze
// byc pusta). Celowo NIE obsluguje separatorow tysiecy (spacja/kropka w roli
// tysiecy) - w danych projektowych tej skali (moc/liczba modulow/pojemnosc)
// nie wystepuja, a proba ich rozpoznania zwiekszalaby ryzyko falszywych
// dopasowan liczb calkowicie innego rzedu wielkosci.
const NUMERIC_UNIT_RE = /^(-?\d+(?:[.,]\d+)?)\s*([a-ząćęłńóśźż%°²³/]*)$/i;

function stripDiacritics(s) {
  // "l" (U+0142) NIE rozklada sie w NFD tak jak pozostale polskie znaki -
  // zamiana jawna PRZED NFD (ten sam problem/rozwiazanie co
  // apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1#Normalize-Name).
  const swapped = s.replace(/ł/g, 'l').replace(/Ł/g, 'L');
  const COMBINING_MARKS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
  return swapped.normalize('NFD').replace(COMBINING_MARKS_RE, '');
}

function splitNumericUnit(raw) {
  const s = String(raw ?? '').trim();
  const m = NUMERIC_UNIT_RE.exec(s);
  if (!m) return null;
  const numeric = Number.parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(numeric)) return null;
  return { value: numeric, unit: m[2].toLowerCase() };
}

// Kanoniczna forma do porownan exact-match: liczby (z jednostka albo bez)
// sprowadzone do samej wartosci liczbowej jako string ("5,52 kWp" i "5.52"
// dadza to samo "5.52"), reszta - zwykla normalizacja tekstu (trim/lowercase/
// collapse spaces/diakrytyki). Bez obliczen - to WYLACZNIE porownanie
// tekstowe dwoch juz istniejacych wartosci, nigdy wyprowadzanie nowej.
function normalizeValue(raw) {
  if (raw === null || raw === undefined) return '';
  const collapsed = stripDiacritics(String(raw)).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const numeric = splitNumericUnit(collapsed);
  if (numeric) return String(numeric.value);
  return collapsed;
}

function tokenize(normalized) {
  const s = stripDiacritics(String(normalized ?? '')).toLowerCase();
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

function isTrivialValue(normalized) {
  const v = String(normalized ?? '').trim();
  if (!v) return true;
  if (TRIVIAL_VALUES.has(v)) return true;
  return v.length === 1;
}

function jaccardSimilarity(tokensA, tokensB) {
  const a = new Set(tokensA || []);
  const b = new Set(tokensB || []);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const BOOLEAN_LIKE = new Set(['tak', 'nie', '0', '1', 'prawda', 'falsz', 'fałsz', 'x', '']);

function guessValueType(normalized) {
  const v = String(normalized ?? '').trim();
  if (!v) return null;
  if (BOOLEAN_LIKE.has(v)) return 'boolean-like';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'numeric';
  return 'free-text';
}

module.exports = {
  normalizeValue,
  tokenize,
  splitNumericUnit,
  isTrivialValue,
  jaccardSimilarity,
  guessValueType,
};
