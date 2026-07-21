// Osadza font Unicode (potrzebny do polskich znakow w warstwie tekstowej
// PDF-a - standardowe fonty pdf-lib maja tylko kodowanie WinAnsi, bez
// polskich diakrytykow). Ten sam wzorzec co apps/pieczatki-pdf/server.js:
// font czytany na zywo z systemu Windows/Linux, NIE wendorowany w repo.
// Tutaj, w odroznieniu od pieczatki-pdf, brak fontu jest bledem krytycznym
// (nie ma sensownego fallbacku z transliteracja - to byloby cichym
// uszkodzeniem tresci warstwy tekstowej, ktora ma byc dokladnym
// odwzorowaniem rozpoznanego tekstu, nie przyblizeniem).
const fsp = require('fs/promises');
const fontkit = require('@pdf-lib/fontkit');

const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
];

async function embedUnicodeFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  for (const candidate of FONT_CANDIDATES) {
    try {
      const bytes = await fsp.readFile(candidate);
      return await pdfDoc.embedFont(bytes, { subset: true });
    } catch (_) { /* probuj kolejny kandydat */ }
  }
  throw new Error('Nie znaleziono fontu Unicode (Arial/DejaVu Sans) potrzebnego do zapisania polskich znakow w warstwie tekstowej PDF-a.');
}

module.exports = { embedUnicodeFont };
