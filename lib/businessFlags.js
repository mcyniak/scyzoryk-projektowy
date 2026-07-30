const AFFIRMATIVE_VALUES = new Set(['tak', 'yes', 'x', '+', '1', 'true', 'prawda', 'rezygnacja']);
const NEGATIVE_VALUES = new Set(['nie', 'no', '0', '-', 'false', 'brak', 'nie dotyczy', '']);

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isAffirmativeFlag(value) {
  const normalized = normalize(value);
  if (!normalized || NEGATIVE_VALUES.has(normalized)) return false;
  if (AFFIRMATIVE_VALUES.has(normalized)) return true;
  // Nieznana wartosc nie moze po cichu wykluczyc klienta z przetwarzania.
  return false;
}

module.exports = { isAffirmativeFlag };
