// Rozroznienie pompy gruntowej/powietrznej po tekscie kolumny "Rodzaj pompy" -
// te same wzorce byly do 2026-08-20 niezaleznie zduplikowane w
// apps/tworzenie-folderow/src/excel.js i apps/formularze-varmero/src/excel.js
// (a karty-katalogowe potrzebowalo tego samego rozroznienia dla dodatku
// "dobory" na arkuszu Pomp - Faza 0 planu "Pipeline inwestycji") - wydzielone
// tutaj, zeby nie powstala czwarta niezalezna kopia.
const AIR_SOURCE_PATTERN = /powietrz/i;
const GROUND_SOURCE_PATTERN = /grunt/i;

function isAirSourcePump(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  if (GROUND_SOURCE_PATTERN.test(value)) return false;
  return AIR_SOURCE_PATTERN.test(value);
}

function isGroundSourcePump(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  return GROUND_SOURCE_PATTERN.test(value);
}

module.exports = {
  AIR_SOURCE_PATTERN,
  GROUND_SOURCE_PATTERN,
  isAirSourcePump,
  isGroundSourcePump
};
