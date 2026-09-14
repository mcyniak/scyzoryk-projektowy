// Slownik pojec domenowych dla auto-konfiguracji Kreatora (autoConfigurator.js).
// Kazde pojecie to lista alternatywnych sformulowan, jakich moze uzyc: (a)
// kontekst w Wordzie ("Adres instalacji:"), (b) naglowek kolumny w Excelu
// ("Adres inwestycji"). Alias NIE jest wiazany z jedna konkretna kolumna -
// sluzy wylacznie do podniesienia score, gdy oba teksty (kontekst i naglowek)
// pasuja do tego samego pojecia mimo innego sformulowania. Latwe do
// rozszerzenia - nowe pojecie to nowy wpis, bez zmian w logice scoringu.
const { normalizeValue, tokenize } = require('./textNormalize');

const CONCEPTS = {
  ADDRESS: ['adres', 'adres instalacji', 'adres obiektu', 'adres inwestycji', 'lokalizacja'],
  PV_POWER: ['moc', 'moc pv', 'moc instalacji', 'moc zestawu', 'moc projektowa', 'moc projektowanej instalacji'],
  MODULE_COUNT: ['liczba modulow', 'ilosc modulow', 'moduly', 'liczba paneli'],
  INVERTER: ['falownik', 'inwerter'],
  STORAGE_CAPACITY: ['magazyn energii', 'pojemnosc magazynu', 'pojemnosc me'],
  PV_LOCATION: ['miejsce montazu', 'miejsce montazu pv', 'lokalizacja pv'],
  ROOF_COVER: ['pokrycie', 'pokrycie dachowe', 'rodzaj pokrycia'],
};

// Prekomputacja tokenow aliasow raz przy starcie modulu (nie per-wywolanie).
const CONCEPT_ALIAS_TOKENS = Object.fromEntries(
  Object.entries(CONCEPTS).map(([concept, aliases]) => [
    concept,
    aliases.map((alias) => tokenize(normalizeValue(alias))).filter((tokens) => tokens.length > 0),
  ])
);

// Zwraca liste kluczy pojec, ktorych PELNA fraza aliasu (wszystkie jej
// tokeny) wystepuje w tekscie. Celowo wymaga calej frazy, nie pojedynczego
// tokenu, zeby np. samo slowo "moc" w niezwiazanym zdaniu nie trafialo w
// PV_POWER tak samo mocno jak jawne "moc instalacji".
function findConceptsForText(text) {
  const textTokens = tokenize(normalizeValue(text));
  if (!textTokens.length) return [];
  const textTokenSet = new Set(textTokens);

  const matched = [];
  for (const [concept, aliasTokenLists] of Object.entries(CONCEPT_ALIAS_TOKENS)) {
    const hit = aliasTokenLists.some((aliasTokens) => aliasTokens.every((t) => textTokenSet.has(t)));
    if (hit) matched.push(concept);
  }
  return matched;
}

module.exports = { CONCEPTS, findConceptsForText };
