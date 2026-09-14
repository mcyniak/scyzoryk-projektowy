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

// Lekkie "aliasy koncowek" polskiej odmiany (sekcja 56 promptu auto-konfiguracji:
// "Dodaj lekkie aliasy koncowek, ale NIE pelny stemming/morfologie... nie
// twórz generatora odmiany"). Realny problem znaleziony na zywym dokumencie:
// tekst wzoru mowi "o MOCY 5,28 kWp" (dopelniacz), a naglowek kolumny w Excelu
// to "MOC zestawu..." (mianownik) - bez tego zadne dopasowanie kontekstu ani
// aliasu domenowego nigdy by sie nie trafilo, mimo ze to oczywiscie to samo
// pojecie. Lista jawna, sprawdzana od najdluzszej koncowki (zeby "ami"/"iej"
// nie zostalo przypadkiem "zjedzone" przez krotsza "i"/"a" najpierw), ucina
// TYLKO jesli zostanie co najmniej 3 znaki rdzenia - krotkie slowa (np. samo
// "moc", 3 znaki) nigdy nie sa obcinane.
const COMMON_POLISH_SUFFIXES = ['ami', 'ach', 'owi', 'ego', 'iej', 'ymi', 'imi', 'ow', 'em', 'a', 'e', 'i', 'u', 'y'];
const STEM_MIN_REMAINING = 3;

function stemToken(token) {
  const t = String(token || '');
  for (const suffix of COMMON_POLISH_SUFFIXES) {
    if (t.length - suffix.length >= STEM_MIN_REMAINING && t.endsWith(suffix)) {
      return t.slice(0, t.length - suffix.length);
    }
  }
  return t;
}

// Jak jaccardSimilarity, ale porownuje RDZENIE tokenow (po stemToken), nie
// tokeny 1:1 - uzywana WYLACZNIE tam, gdzie tolerowanie odmiany jest pozadane
// (CONTEXT_HEADER_SIMILARITY w scoreCandidateColumn), nie w miejscach
// wymagajacych scislej rownosci (np. dopasowanie WARTOSCI rekordu).
function fuzzyJaccardSimilarity(tokensA, tokensB) {
  const a = new Set((tokensA || []).map(stemToken));
  const b = new Set((tokensB || []).map(stemToken));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Jaki ulamek RDZENI kolumny (nie kontekstu) wystepuje w kontekscie - w
// odroznieniu od fuzzyJaccardSimilarity NIE jest karany dlugoscia kontekstu.
// Realny problem znaleziony na zywym dokumencie: kontekst kandydata to czesto
// cale zdanie techniczne (30+ tokenow, wymiary modulow, numery katalogowe...),
// a Jaccard (dzielony przez SUME obu zbiorow) topil sygnal w szumie. Nazwa
// kolumny jest zwykle krotka (2-6 tokenow) - liczenie wzgledem NIEJ, nie
// wzgledem calego zdania, daje sensowny wynik niezaleznie od tego, ile
// dodatkowych, niezwiazanych slow jest w kontekscie.
function columnTokenCoverage(contextTokens, columnTokens) {
  const columnStems = new Set((columnTokens || []).map(stemToken));
  if (columnStems.size === 0) return 0;
  const contextStems = new Set((contextTokens || []).map(stemToken));
  let hits = 0;
  for (const stem of columnStems) if (contextStems.has(stem)) hits++;
  return hits / columnStems.size;
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
  fuzzyJaccardSimilarity,
  columnTokenCoverage,
  stemToken,
  guessValueType,
};
