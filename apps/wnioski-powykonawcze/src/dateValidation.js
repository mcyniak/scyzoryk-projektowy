// Walidacja daty dokumentacji powykonawczej (audyt v1.0.4, P1-7). Wydzielone
// z server.js do osobnego modulu, zeby dalo sie to przetestowac bez
// uruchamiania calego serwera Express (server.js wywoluje app.listen() na
// poziomie modulu).

// Sprawdza, ze podany dzien/miesiac/rok tworza REALNIE istniejaca date, a nie
// tylko ze napis ma odpowiedni ksztalt cyfr. new Date() w JS po cichu
// "koryguje" niepoprawne wartosci (np. 31.02 staje sie 03.03) zamiast rzucic
// blad - dlatego wynik jest tu jawnie porownywany z tym, co podano (round-trip
// check), zeby np. "31.02.2026", "99.99.2026" czy "2026-15-73" zostaly
// odrzucone, a nie cicho przepuszczone jako "poprawiona" inna data.
function isRealCalendarDate(day, month, year) {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

// `allowEmpty` obsluguje tryb "Bez daty" (brak jakiejkolwiek daty w dokumencie -
// zadna nie zostanie podmieniona, patrz convert-wm.ps1#Replace-AllDates, ktore
// juz wczesniej po cichu pomijaly podmiane przy pustym DateText). Bez tej flagi
// pusty wpis dalej jest bledem - "Bez daty" musi byc swiadomym wyborem w UI,
// nie efektem ubocznym niewypelnionego pola.
function normalizeDate(input, options) {
  const allowEmpty = Boolean(options && options.allowEmpty);
  const raw = String(input || '').trim();
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error('Wpisz datę dokumentacji powykonawczej.');
  }
  const invalidMsg = 'Nieprawidłowa data. Użyj formatu RRRR-MM-DD, DD.MM.RRRR albo MM.RRRR (tylko miesiąc i rok) - i podaj realnie istniejącą datę.';

  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, year, month, day] = m.map(Number);
    if (!isRealCalendarDate(day, month, year)) throw new Error(invalidMsg);
    return `${m[3]}.${m[2]}.${m[1]}`;
  }
  m = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) {
    const [, day, month, year] = m.map(Number);
    if (!isRealCalendarDate(day, month, year)) throw new Error(invalidMsg);
    return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
  }
  m = raw.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw new Error(invalidMsg);
    return `${m[2]}.${m[1]}`;
  }
  m = raw.match(/^(\d{1,2})[.\/-](\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    if (month < 1 || month > 12) throw new Error(invalidMsg);
    return `${m[1].padStart(2, '0')}.${m[2]}`;
  }
  throw new Error(invalidMsg);
}

module.exports = { normalizeDate, isRealCalendarDate };
