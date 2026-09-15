// Slownik pojec domenowych dla auto-konfiguracji Kreatora (autoConfigurator.js).
// Kazde pojecie to lista alternatywnych sformulowan, jakich moze uzyc: (a)
// kontekst w Wordzie ("Adres instalacji:"), (b) naglowek kolumny w Excelu
// ("Adres inwestycji"). Alias NIE jest wiazany z jedna konkretna kolumna -
// sluzy wylacznie do podniesienia score, gdy oba teksty (kontekst i naglowek)
// pasuja do tego samego pojecia mimo innego sformulowania. Latwe do
// rozszerzenia - nowe pojecie to nowy wpis, bez zmian w logice scoringu.
const { normalizeValue, tokenize, stemToken } = require('./textNormalize');

// Kazdy alias ma wage 0-1 (hardening sekcja 16: "aliasy ogolne maja mniejsza
// wage") - fraza wieloslowna i jednoznaczna ("moc instalacji") jest prawie
// zawsze prawdziwym sygnalem tego pojecia, ale POJEDYNCZE, bardzo ogolne
// slowo ("moc" samo w sobie) pasuje tez do zupelnie innych kontekstow
// technicznych (moc pompy ciepla, moc przylaczeniowa, moc umowna...) - stara
// wersja traktowala oba przypadki identycznie (jeden bit: pasuje/nie pasuje),
// co dawalo falszywe DOMAIN_ALIAS_MATCH tam, gdzie w tekscie padlo tylko
// ogolne slowo bez zadnego dopasowania frazowego.
const CONCEPTS = {
  ADDRESS: [
    { phrase: 'adres instalacji', weight: 1.0 },
    { phrase: 'adres obiektu', weight: 1.0 },
    { phrase: 'adres inwestycji', weight: 1.0 },
    { phrase: 'lokalizacja inwestycji', weight: 0.9 },
    { phrase: 'adres', weight: 0.4 },
    { phrase: 'lokalizacja', weight: 0.3 },
  ],
  PV_POWER: [
    { phrase: 'moc instalacji', weight: 1.0 },
    { phrase: 'moc pv', weight: 1.0 },
    { phrase: 'moc zestawu', weight: 0.9 },
    { phrase: 'moc projektowanej instalacji', weight: 1.0 },
    { phrase: 'moc projektowa', weight: 0.8 },
    { phrase: 'moc', weight: 0.25 },
  ],
  MODULE_COUNT: [
    { phrase: 'liczba modulow', weight: 1.0 },
    { phrase: 'ilosc modulow', weight: 1.0 },
    { phrase: 'liczba paneli', weight: 0.9 },
    { phrase: 'moduly', weight: 0.3 },
  ],
  INVERTER: [
    { phrase: 'falownik', weight: 0.9 },
    { phrase: 'inwerter', weight: 0.9 },
  ],
  STORAGE_CAPACITY: [
    { phrase: 'magazyn energii', weight: 1.0 },
    { phrase: 'pojemnosc magazynu', weight: 1.0 },
    { phrase: 'pojemnosc me', weight: 0.9 },
    { phrase: 'magazyn', weight: 0.35 },
  ],
  PV_LOCATION: [
    { phrase: 'miejsce montazu pv', weight: 1.0 },
    { phrase: 'miejsce montazu', weight: 0.6 },
    { phrase: 'lokalizacja pv', weight: 0.9 },
  ],
  ROOF_COVER: [
    { phrase: 'pokrycie dachowe', weight: 1.0 },
    { phrase: 'rodzaj pokrycia', weight: 1.0 },
    { phrase: 'pokrycie', weight: 0.4 },
  ],
};

// Prekomputacja RDZENI (nie surowych tokenow) aliasow raz przy starcie
// modulu - dopasowanie idzie po stemToken (lekka odmiana polska, patrz
// textNormalize.js), zeby "moc instalacji" w slowniku pasowalo tez do
// realnego tekstu wzoru "o mocy instalacji ..." (dopelniacz), nie tylko do
// identycznej mianownikowej formy.
const CONCEPT_ALIAS_STEMS = Object.fromEntries(
  Object.entries(CONCEPTS).map(([concept, aliases]) => [
    concept,
    aliases
      .map((a) => ({ stems: tokenize(normalizeValue(a.phrase)).map(stemToken), weight: a.weight }))
      .filter((a) => a.stems.length > 0),
  ])
);

// Zwraca liste { concept, weight } dla pojec, ktorych PRZYNAJMNIEJ JEDNA
// pelna fraza aliasu (wszystkie jej rdzenie) wystepuje w tekscie - z wага
// NAJSILNIEJSZEGO trafionego aliasu dla danego pojecia (jesli tekst zawiera
// zarowno "moc instalacji" jak i samo "moc", liczy sie mocniejszy, 1.0, nie
// slabszy 0.25).
function findConceptsForText(text) {
  const textTokens = tokenize(normalizeValue(text));
  if (!textTokens.length) return [];
  const textStemSet = new Set(textTokens.map(stemToken));

  const matched = [];
  for (const [concept, aliasList] of Object.entries(CONCEPT_ALIAS_STEMS)) {
    let bestWeight = 0;
    for (const alias of aliasList) {
      if (alias.stems.every((s) => textStemSet.has(s))) bestWeight = Math.max(bestWeight, alias.weight);
    }
    if (bestWeight > 0) matched.push({ concept, weight: bestWeight });
  }
  return matched;
}

// Znaczniki domenowe (hardening sekcja 17: "negative domain tokens") - skroty
// uzywane w tej branzy do jednoznacznego rozroznienia RODZAJU instalacji.
// NIE sa to nazwy konkretnych kolumn z jednego projektu (celowo, zeby nie
// przewiazac sie do jednego szablonu) - to ogolne markery domeny: jesli
// kontekst kandydata jednoznacznie mowi o fotowoltaice (PV/falownik/moduly),
// a nazwa kolumny jednoznacznie mowi o pompie ciepla (PC/pompa ciepla), to
// jest to sygnal KONFLIKTU domenowego, nawet jesli oba teksty zawieraja
// wspolne ogolne slowo typu "moc".
const DOMAIN_MARKERS = {
  PV: ['pv', 'fotowoltaiczna', 'fotowoltaiczny', 'falownik', 'inwerter', 'modul', 'panel'],
  PC: ['pc', 'pompa ciepla', 'pompy ciepla', 'pompa', 'grzewcza', 'grzewczy'],
  ME: ['magazyn energii', 'magazyn', 'akumulator'],
};

const DOMAIN_MARKER_STEMS = Object.fromEntries(
  Object.entries(DOMAIN_MARKERS).map(([domain, phrases]) => [
    domain,
    phrases.map((p) => tokenize(normalizeValue(p)).map(stemToken)).filter((s) => s.length > 0),
  ])
);

function findDomainMarkersForText(text) {
  const textTokens = tokenize(normalizeValue(text));
  if (!textTokens.length) return [];
  const textStemSet = new Set(textTokens.map(stemToken));
  const matched = [];
  for (const [domain, phraseStemLists] of Object.entries(DOMAIN_MARKER_STEMS)) {
    const hit = phraseStemLists.some((stems) => stems.every((s) => textStemSet.has(s)));
    if (hit) matched.push(domain);
  }
  return matched;
}

// True jesli kontekst i kolumna WYRAZNIE naleza do RÓŻNYCH, WZAJEMNIE
// WYKLUCZAJACYCH SIE domen (np. kontekst mowi o PV, kolumna o PC) - konflikt
// tylko gdy KAZDA strona ma WYLACZNIE markery jednej domeny i sa to RÓŻNE
// domeny; brak markerow po ktorejkolwiek stronie -> brak konfliktu (nie
// zgadujemy na podstawie nieobecnosci sygnalu).
function hasDomainConflict(contextText, columnText) {
  const ctxDomains = findDomainMarkersForText(contextText);
  const colDomains = findDomainMarkersForText(columnText);
  if (!ctxDomains.length || !colDomains.length) return false;
  return !ctxDomains.some((d) => colDomains.includes(d));
}

module.exports = { CONCEPTS, findConceptsForText, findDomainMarkersForText, hasDomainConflict };
