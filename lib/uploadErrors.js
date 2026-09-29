'use strict';

// Wspolny, polski komunikat dla bledow przesylania (multer) i typowych bledow
// systemu plikow - zamiast surowego "Too many files" / "EBUSY: resource busy
// or locked" w interfejsie (przeglad 2026-09-29).
const BY_CODE = {
  LIMIT_FILE_COUNT: 'Za dużo plików naraz - wybierz mniej plików.',
  LIMIT_FILE_SIZE: 'Plik jest za duży.',
  LIMIT_FIELD_VALUE: 'Lista plików jest za długa - wybierz mniej plików.',
  LIMIT_UNEXPECTED_FILE: 'Nieoczekiwany plik w formularzu.',
  EBUSY: 'Plik jest otwarty w innym programie (np. Excel, Acrobat). Zamknij go i spróbuj ponownie.',
  EPERM: 'Brak uprawnień albo plik jest otwarty w innym programie. Zamknij go i spróbuj ponownie.',
  EACCES: 'Brak uprawnień do pliku lub folderu.',
  ENOSPC: 'Brak miejsca na dysku.',
  ENAMETOOLONG: 'Ścieżka lub nazwa pliku jest za długa.',
};

function polishErrorMessage(err, fallback = 'Błąd przetwarzania.') {
  if (!err) return fallback;
  if (err.code && BY_CODE[err.code]) return BY_CODE[err.code];
  return err.message || String(err) || fallback;
}

module.exports = { polishErrorMessage };
