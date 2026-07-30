// Sprawdza, czy PDF juz ma prawdziwa warstwe tekstowa (np. audyty z rodziny
// "FLEXIPOWER" - eksport z aplikacji, 4-7 tys. znakow/plik) - takie pliki juz
// spelniaja cel (mozna zaznaczac/wyszukiwac tekst) i NIE powinny isc przez OCR.
// Prog dobrany z duzym zapasem ponizej realnych wartosci dla obu rodzin dokumentow
// zaobserwowanych w danych (patrz analiza realnych plikow audytow), zeby nie
// pomylic np. pojedynczego numeru strony/metadanych z prawdziwa warstwa tekstu.
const fs = require('fs/promises');

const MIN_TEXT_LENGTH = 300;
let pdfJsPromise = null;

function getPdfJs() {
  if (!pdfJsPromise) pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfJsPromise;
}

async function checkTextLayerByPage(pdfPath) {
  const buffer = await fs.readFile(pdfPath);
  const pdfJs = await getPdfJs();
  let document = null;
  try {
    document = await pdfJs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      useSystemFonts: true
    }).promise;
  } catch (_) {
    return [];
  }

  const pages = [];
  for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
    let text = '';
    try {
      const page = await document.getPage(pageIndex + 1);
      const content = await page.getTextContent({ normalizeWhitespace: true });
      text = (content.items || []).map((item) => item.str || '').join(' ');
    } catch (_) {
      text = '';
    }
    const textLength = text.replace(/\s+/g, ' ').trim().length;
    pages.push({ pageIndex, hasTextLayer: textLength >= MIN_TEXT_LENGTH, textLength });
  }
  await document.destroy?.();
  return pages;
}

async function checkTextLayer(pdfPath) {
  const pages = await checkTextLayerByPage(pdfPath);
  const textLength = pages.reduce((sum, page) => sum + page.textLength, 0);
  return { hasText: pages.length > 0 && pages.every((page) => page.hasTextLayer), textLength };
}

module.exports = { checkTextLayer, checkTextLayerByPage };
