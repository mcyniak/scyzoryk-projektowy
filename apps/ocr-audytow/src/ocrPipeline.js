// Etap 1+2 planu: dla kazdego wgranego PDF-a (funkcja analyzeDocument)
// wyciagamy miniatury stron (do ekranu potwierdzenia podzialu) i pytamy
// Gemini o propozycje podzialu na bloki adresowe (patrz bundleSplit.js) - ale
// NIGDY nie dzielimy automatycznie: wywolujacy (server.js) pokazuje ekran
// potwierdzenia z miniaturami stron, a dopiero zatwierdzone (ewentualnie
// poprawione recznie) bloki tna oryginalny PDF na osobne pliki wyjsciowe
// (funkcja finalizeSplit).
//
// Do 2026-08-12 ten plik odpowiadal tez za caly krok OCR (Document AI per
// strona + reczne skladanie PDF-a z niewidoczna warstwa tekstu) - usuniete
// razem z Document AI (patrz src/geminiFieldEngine.js, pamiec projektu
// 2026-08-12): funkcja przeszukiwalnego PDF-a zostala swiadomie wycofana
// (byla to jedyna pozostala przyczyna trzymania Document AI w tej apce),
// wiec strony wyjsciowe sa teraz zwykla kopia oryginalu (pdf-lib
// `copyPages`) - bez rasteryzacji, bez utraty jakosci skanu (to nawet
// poprawa wzgledem starej wersji, gdzie strony byly przebudowywane z
// rastrowego JPEG-a).
const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { Jimp } = require('jimp');
const { extractPageImages } = require('./pdfImageExtractor');
const { detectBlockBoundaries, boundariesToBlocks } = require('./bundleSplit');

async function inspectDocument(sourcePdfPath) {
  const sourceDoc = await PDFDocument.load(await fs.readFile(sourcePdfPath), { updateMetadata: false });
  return { pageCount: sourceDoc.getPageCount() };
}

// Miniatury stron (JPEG, maly rozmiar) do ekranu potwierdzenia podzialu.
// Strony bez rozpoznanego osadzonego obrazu (rzadkie - patrz
// pdfImageExtractor.js, np. czysto tekstowy PDF bez skanu) nie dostaja
// miniatury, UI pokazuje dla nich zastepczy placeholder.
async function buildThumbnails(pages, thumbDir, { maxWidth = 220, quality = 65 } = {}) {
  await fs.mkdir(thumbDir, { recursive: true });
  const thumbs = [];
  for (const p of pages) {
    if (!p.imagePath) { thumbs.push({ pageIndex: p.pageIndex, available: false }); continue; }
    try {
      const image = await Jimp.read(p.imagePath);
      if (image.bitmap.width > maxWidth) image.resize({ w: maxWidth });
      const fileName = `page-${String(p.pageIndex + 1).padStart(3, '0')}.jpg`;
      await image.write(path.join(thumbDir, fileName), { quality });
      thumbs.push({ pageIndex: p.pageIndex, available: true, file: fileName });
    } catch (_) {
      thumbs.push({ pageIndex: p.pageIndex, available: false });
    }
  }
  return thumbs;
}

// workDir: katalog roboczy analizy (obrazy posrednie, miniatury) - MUSI
// przetrwac az do finalizeSplit (uzytkownik przeglada/poprawia podzial na
// bloki miedzy tymi wywolaniami) - wywolujacy (server.js) sprzata go dopiero
// po finalizacji/wygasnieciu sesji analizy.
async function analyzeDocument({ sourcePdfPath, workDir, inspection = null }) {
  await fs.mkdir(workDir, { recursive: true });

  const inspected = inspection || await inspectDocument(sourcePdfPath);
  const pageCount = inspected.pageCount;
  const warnings = [];

  const { pages: extractedPages } = await extractPageImages(sourcePdfPath, workDir);
  const unimaged = extractedPages.filter((page) => !page.imagePath);
  for (const page of unimaged) {
    warnings.push(`Strona ${page.pageIndex + 1}: brak rozpoznanego obrazu (${page.unsupportedFilter ? 'nieobslugiwany format: ' + page.unsupportedFilter : 'brak osadzonego obrazu'}) - miniatura niedostepna, plik i tak zostanie przetworzony normalnie.`);
  }

  let blocks;
  try {
    const boundaries = await detectBlockBoundaries({ sourcePdfPath, pageCount });
    blocks = boundariesToBlocks(boundaries, pageCount);
  } catch (err) {
    warnings.push(`Nie udalo sie automatycznie rozpoznac podzialu na adresy (${err.message || err}) - caly plik potraktowany jako jeden adres, popraw podzial recznie jesli trzeba.`);
    blocks = [{ startPage: 0, endPage: pageCount - 1 }];
  }
  if (blocks.length > 1) {
    warnings.push(`Wykryto ${blocks.length} prawdopodobne bloki adresowe w jednym pliku (powtarzajacy sie naglowek protokolu) - sprawdz i w razie potrzeby popraw podzial przed pobraniem.`);
  }

  const thumbDir = path.join(workDir, 'thumbs');
  const thumbnails = await buildThumbnails(extractedPages, thumbDir);

  return {
    status: 'ready',
    pageCount,
    warnings,
    blocks,
    thumbnails,
    // Lekka lista (bez adnotacji OCR) - potrzebna tylko do serwowania
    // pelnowymiarowego podgladu oryginalnej strony w UI (patrz trasa
    // /api/analysis/.../files/.../page/:pageIndex w server.js).
    pages: extractedPages.map((p) => ({ pageIndex: p.pageIndex, imagePath: p.imagePath }))
  };
}

// Finalizuje podzial: dla kazdego zatwierdzonego bloku kopiuje odpowiedni
// zakres stron oryginalu do osobnego pliku wyjsciowego.
async function finalizeSplit({ sourcePdfPath, blocks, outPaths }) {
  const sourceBytes = await fs.readFile(sourcePdfPath);
  const sourceDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  for (let i = 0; i < blocks.length; i++) {
    const range = blocks[i];
    const pageIndexes = Array.from({ length: range.endPage - range.startPage + 1 }, (_, j) => range.startPage + j);
    const finalDoc = await PDFDocument.create();
    const copied = await finalDoc.copyPages(sourceDoc, pageIndexes);
    copied.forEach((p) => finalDoc.addPage(p));
    await fs.writeFile(outPaths[i], await finalDoc.save());
  }
}

module.exports = {
  analyzeDocument,
  inspectDocument,
  finalizeSplit,
  buildThumbnails
};
