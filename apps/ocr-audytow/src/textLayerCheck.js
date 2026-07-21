// Sprawdza, czy PDF juz ma prawdziwa warstwe tekstowa (np. audyty z rodziny
// "FLEXIPOWER" - eksport z aplikacji, 4-7 tys. znakow/plik) - takie pliki juz
// spelniaja cel (mozna zaznaczac/wyszukiwac tekst) i NIE powinny isc przez OCR.
// Prog dobrany z duzym zapasem ponizej realnych wartosci dla obu rodzin dokumentow
// zaobserwowanych w danych (patrz analiza realnych plikow audytow), zeby nie
// pomylic np. pojedynczego numeru strony/metadanych z prawdziwa warstwa tekstu.
const pdfParse = require('pdf-parse');
const fs = require('fs/promises');

const MIN_TEXT_LENGTH = 300;

async function checkTextLayer(pdfPath) {
  const buffer = await fs.readFile(pdfPath);
  let text = '';
  try {
    const result = await pdfParse(buffer);
    text = result.text || '';
  } catch (_) {
    text = '';
  }
  const trimmedLength = text.replace(/\s+/g, ' ').trim().length;
  return { hasText: trimmedLength >= MIN_TEXT_LENGTH, textLength: trimmedLength };
}

module.exports = { checkTextLayer, MIN_TEXT_LENGTH };
