// Wyciaga z kazdej strony PDF-a najwiekszy osadzony obraz (XObject typu /Image) w
// oryginalnej rozdzielczosci, bez ponownego renderowania/rasteryzacji strony (co
// straciloby jakosc). Prawdziwe skany audytow maja dokladnie jeden obraz JPEG na
// strone (potwierdzone na realnych plikach), wiec "najwiekszy obraz na stronie" =
// caly zeskanowany dokument.
const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, PDFName, PDFArray, PDFRawStream } = require('pdf-lib');

const FILTER_EXTENSIONS = {
  DCTDecode: 'jpg',
  JPXDecode: 'jp2',
};

// /Filter w PDF-ie moze byc pojedyncza nazwa (/DCTDecode) ALBO tablica nazw
// ([/DCTDecode] albo lancuch kilku filtrow) - oba warianty spotkane w realnych
// audytach (Slesin/Strzalkowo maja goly PDFName, Kazimierz Biskupi ma PDFArray
// z jednym elementem). Bierzemy OSTATNI filtr w lancuchu, bo to on okresla
// faktyczny format bajtow strumienia (wczesniejsze filtry juz zdekodowane/inne).
function lastFilterName(filterObj) {
  if (!filterObj) return '';
  if (filterObj instanceof PDFArray) {
    const size = filterObj.size();
    if (!size) return '';
    return String(filterObj.lookup(size - 1) || '').replace(/^\//, '');
  }
  return String(filterObj).replace(/^\//, '');
}

function pickPageImage(page) {
  const resources = page.node.Resources();
  const xobjectsDict = resources?.lookup(PDFName.of('XObject'));
  if (!xobjectsDict) return null;

  let best = null;
  for (const key of xobjectsDict.keys()) {
    const xobj = xobjectsDict.lookup(key);
    if (!(xobj instanceof PDFRawStream)) continue;
    const subtype = xobj.dict.get(PDFName.of('Subtype'));
    if (String(subtype) !== '/Image') continue;
    const width = xobj.dict.get(PDFName.of('Width'))?.asNumber?.() || 0;
    const height = xobj.dict.get(PDFName.of('Height'))?.asNumber?.() || 0;
    const filter = lastFilterName(xobj.dict.get(PDFName.of('Filter')));
    const area = width * height;
    if (!best || area > best.area) {
      best = { width, height, filter, bytes: xobj.contents, area };
    }
  }
  return best;
}

// Zwraca liste { pageIndex, imagePath, width, height, rotate } dla stron, ktore maja
// osadzony obraz obslugiwanego formatu (JPEG/JPEG2000 - jedyne realnie spotykane w
// audytach). Strony bez rozpoznanego obrazu (np. czysto tekstowe) sa pomijane -
// wywolujacy decyduje co z nimi zrobic (patrz ocrPipeline.js).
async function extractPageImages(pdfPath, outDir) {
  const bytes = await fs.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdfDoc.getPages();
  const results = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const rotate = page.node.get(PDFName.of('Rotate'))?.asNumber?.() || 0;
    const { width: pageWidthPt, height: pageHeightPt } = page.getSize();
    const image = pickPageImage(page);
    if (!image) {
      results.push({ pageIndex: i, imagePath: null, width: 0, height: 0, rotate });
      continue;
    }
    const ext = FILTER_EXTENSIONS[image.filter] || null;
    if (!ext) {
      results.push({ pageIndex: i, imagePath: null, width: image.width, height: image.height, rotate, unsupportedFilter: image.filter });
      continue;
    }
    const imagePath = path.join(outDir, `page-${String(i + 1).padStart(3, '0')}.${ext}`);
    await fs.writeFile(imagePath, Buffer.from(image.bytes));
    // Efektywne DPI = piksele obrazu / rzeczywisty rozmiar strony (w calach, 72pt=1cal).
    // Realne skany audytow wahaly sie miedzy ~200 a ~300 DPI - lepiej policzyc niz
    // zakladac stala wartosc, Tesseract dziala zauwazalnie gorzej przy zlym --dpi.
    const dpiX = pageWidthPt > 0 ? Math.round(image.width / (pageWidthPt / 72)) : 300;
    const dpiY = pageHeightPt > 0 ? Math.round(image.height / (pageHeightPt / 72)) : 300;
    const dpi = Math.round((dpiX + dpiY) / 2) || 300;
    results.push({ pageIndex: i, imagePath, width: image.width, height: image.height, rotate, dpi });
  }

  return { pageCount: pages.length, pages: results };
}

module.exports = { extractPageImages };
