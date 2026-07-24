// Etap 1+2+3 planu, przepisane 2026-07-21 na Google Cloud Vision zamiast
// Tesseracta (patrz pamiec projektu/artefakt porownania silnikow OCR z tego
// samego dnia - Tesseract praktycznie nie czytal odrecznych wpisow na tych
// formularzach, Vision czyta wiekszosc poprawnie na kilkunastu realnych
// audytach z rozny inwestycji).
// Dla kazdego wgranego PDF-a (funkcja analyzeDocument):
//   1. jesli PDF juz ma prawdziwa warstwe tekstu (rodzina "FLEXIPOWER") - kopiujemy
//      bez zmian, OCR pominiety, jeden blok (caly plik = jeden adres);
//   2. w przeciwnym razie wyciagamy osadzone obrazy stron, wysylamy KAZDA
//      strone do OCR-u (rownolegle, patrz mapWithConcurrency), a nastepnie
//      sami skladamy PDF z niewidoczna warstwa tekstu (patrz buildOcrPdf) -
//      silnik OCR nie ma wbudowanego trybu "searchable pdf", wiec te warstwe
//      budujemy recznie przez pdf-lib na podstawie wspolrzednych slow.
//      Uwaga (2026-07-24): automatyczne wykrywanie/korygowanie fizycznego
//      obrotu strony zostalo swiadomie USUNIETE (bylo ~40% calkowitego czasu
//      przetwarzania na realnym 20-stronicowym pliku, ~54s z ~134s) - wlasciciel
//      ocenil, ze rownie latwo poprawic orientacje skanu recznie przed
//      wgraniem, wiec program nie musi tego zgadywac. Skany wgrywane fizycznie
//      "do gory nogami" beda miec bledne podglady/zaznaczenia pol - to
//      swiadomy kompromis, nie przeoczenie.
//   3. na podstawie juz rozpoznanego tekstu proponujemy podzial na bloki
//      (adresy) - patrz bundleSplit.js - ale NIGDY nie dzielimy automatycznie:
//      wywolujacy (server.js) pokazuje ekran potwierdzenia z miniaturami stron,
//      a dopiero zatwierdzone (ewentualnie poprawione recznie) bloki tna juz
//      raz zrobiony OCR na osobne pliki wyjsciowe (funkcja assemblePdfRange) -
//      OCR NIGDY nie jest powtarzany dla tego samego dokumentu.
const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { Jimp } = require('jimp');
const { checkTextLayer } = require('./textLayerCheck');
const { extractPageImages } = require('./pdfImageExtractor');
// Silnik OCR podmieniony 2026-07-22: Google Vision -> Google Document AI
// (Form Parser) - ten sam interfejs {ocrImage, isConfigured}, patrz
// documentAiEngine.js dla uzasadnienia migracji. visionEngine.js pozostaje w
// repo jako bezpieczny punkt powrotu (git), nie jest juz uzywany.
const { ocrImage, isConfigured } = require('./documentAiEngine');
const { detectBlockBoundaries, boundariesToBlocks } = require('./bundleSplit');
const { embedUnicodeFont } = require('./textFont');

// Male ograniczenie rownoleglosci zapytan do Vision per dokument - typowy
// audyt ma <=20 stron, wiec to i tak szybciej niz sekwencyjnie, ale nie
// odpalamy np. 20 rownoczesnych zadan HTTPS naraz bez potrzeby.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Realny blad zlapany 2026-07-22 na przegladzie kilkunastu audytow: jeden
// nietypowy/uszkodzony osadzony obraz na jednej stronie ("Bad image data" z
// Vision) wywalal CALE `analyzeDocument` (Promise.all w
// mapWithConcurrency propaguje pierwszy blad, przerywajac wszystkie inne
// strony/adresy w tym samym dokumencie) - jedna zla strona nie powinna
// uniemozliwiac przetworzenia calego pliku. Zamiast przerywac, strona z
// nieudanym OCR-em jest traktowana jak strona bez osadzonego obrazu wcale -
// kopiowana bez OCR, z ostrzezeniem dla uzytkownika (patrz warnings w
// analyzeDocument), reszta dokumentu przetwarza sie normalnie dalej.
//
// Realny problem zlapany 2026-07-24: powyzszy try/catch chroni tylko przed
// ocrImage(), ktore ODRZUCA obietnice - nie chroni przed ocrImage(), ktore
// PO PROSTU NIGDY SIE NIE ROZSTRZYGA (klient Document AI nie ma skonfigurowanego
// zadnego timeoutu - martwe/zresetowane po cichu polaczenie sieciowe czeka
// wiecznie na odpowiedz, ktora nigdy nie nadejdzie). Poniewaz OCR wszystkich
// stron idzie przez mapWithConcurrency (limit 5, jeden Promise.all na cala
// partie), JEDNA zawieszona strona blokuje NA ZAWSZE caly plik, nie tylko
// siebie - obserwowane na zywo jako proces bez wzrostu CPU i bez otwartych
// polaczen sieciowych, trwajacy nieskonczenie dlugo. withTimeout zamienia
// "wiecznie wisi" na normalny, juz obslugiwany ocrError po rozsadnym czasie.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} - przekroczono limit czasu (${Math.round(ms / 1000)}s), prawdopodobnie martwe polaczenie sieciowe`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const OCR_PAGE_TIMEOUT_MS = 90000;

async function ocrPage(page) {
  try {
    const { text, words, formFields, tables, visualElements } = await withTimeout(
      ocrImage(page.imagePath),
      OCR_PAGE_TIMEOUT_MS,
      `Strona ${page.pageIndex + 1}: rozpoznawanie tekstu`
    );
    return { ...page, ocrText: text, ocrWords: words, formFields: formFields || [], tables: tables || [], visualElements: visualElements || [] };
  } catch (err) {
    return { ...page, ocrText: '', ocrWords: [], formFields: [], tables: [], visualElements: [], ocrError: err.message || 'Rozpoznawanie tekstu nie powiodlo sie' };
  }
}

// Sklada plik wyjsciowy z zakresu stron [range.startPage..range.endPage]
// (0-based, wlacznie) - dla stron z rozpoznanym obrazem bierze odpowiadajaca
// strone z JUZ gotowego, calodokumentowego PDF-a po OCR (ocrDoc), dla reszty
// kopiuje 1:1 z oryginalu. ocrPageCursor liczy sie od poczatku CALEGO
// dokumentu (nie od range.startPage), bo strony w ocrDoc odpowiadaja tylko
// stronom z obrazem, w kolejnosci calego pliku - stad przeliczenie offsetu
// przez policzenie stron-z-obrazem PRZED range.startPage.
async function assemblePdfRange({ sourcePdfPath, ocrPdfPath, pages, range, outPath }) {
  const finalDoc = await PDFDocument.create();
  const sourceBytes = await fs.readFile(sourcePdfPath);
  const sourceDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  const ocrDoc = ocrPdfPath ? await PDFDocument.load(await fs.readFile(ocrPdfPath), { updateMetadata: false }) : null;

  const startPage = range?.startPage ?? 0;
  const endPage = range?.endPage ?? pages.length - 1;
  let ocrPageCursor = pages.slice(0, startPage).filter((p) => p.imagePath).length;

  for (let i = startPage; i <= endPage; i++) {
    const info = pages[i];
    if (info.imagePath) {
      const [copied] = await finalDoc.copyPages(ocrDoc, [ocrPageCursor]);
      finalDoc.addPage(copied);
      ocrPageCursor += 1;
    } else {
      const [copied] = await finalDoc.copyPages(sourceDoc, [info.pageIndex]);
      finalDoc.addPage(copied);
    }
  }

  const outBytes = await finalDoc.save();
  await fs.writeFile(outPath, outBytes);
}

// Miniatury stron (JPEG, maly rozmiar) do ekranu potwierdzenia podzialu -
// generowane z JUZ skorygowanych (obroconych) obrazow stron, wiec pokazuja
// dokladnie to, co trafi do OCR-u/wyniku. Strony bez rozpoznanego obrazu
// zrodlowego (rzadkie - patrz pdfImageExtractor.js) nie dostaja miniatury,
// UI pokazuje dla nich zastepczy placeholder.
async function buildThumbnails(pages, thumbDir, { maxWidth = 220, quality = 65 } = {}) {
  await fs.mkdir(thumbDir, { recursive: true });
  const thumbs = [];
  for (const p of pages) {
    if (!p.imagePath) { thumbs.push({ pageIndex: p.pageIndex, available: false }); continue; }
    // Ten sam fizycznie uszkodzony obraz, ktory wywala embedowanie do PDF-a
    // (patrz buildOcrPdf), wywala tez Jimp tutaj - traktujemy identycznie:
    // brak miniatury dla tej JEDNEJ strony, reszta dokumentu dalej.
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

function trySetPixel(image, x, y, colorHex) {
  if (x < 0 || y < 0 || x >= image.bitmap.width || y >= image.bitmap.height) return;
  image.setPixelColor(colorHex, x, y);
}

// x0/y0/x1/y1 juz powinny byc skonczonymi liczbami wewnatrz granic obrazu
// (patrz isValidBBox w buildFieldPreview) - dodatkowy limit ponizej jest
// tylko druga linia obrony na wypadek gdyby jakis przyszly wywolujacy nie
// przefiltrowal wejscia: bez tego zepsuty/astronomiczny zakres (np. NaN
// przechodzacy przez Math.min/max niezauwazenie jako Infinity) zawiesza caly
// request w praktycznie nieskonczonej petli po pikselach - kazda iteracja
// tania, wiec proces wyglada na "zawieszony przy zerowym zuzyciu CPU", nie
// na crash - realny bug zlapany 2026-07-21.
function drawRectOutline(image, x0, y0, x1, y1, colorHex, thickness = 4) {
  const MAX_SPAN = 8000;
  if (![x0, y0, x1, y1].every(Number.isFinite)) return;
  if (x1 - x0 > MAX_SPAN || y1 - y0 > MAX_SPAN) return;
  for (let t = 0; t < thickness; t++) {
    for (let x = x0; x <= x1; x++) { trySetPixel(image, x, y0 + t, colorHex); trySetPixel(image, x, y1 - t, colorHex); }
    for (let y = y0; y <= y1; y++) { trySetPixel(image, x0 + t, y, colorHex); trySetPixel(image, x1 - t, y, colorHex); }
  }
}

// Podglad konkretnego pola do recznej poprawki (patrz src/fieldExtraction.js) -
// przycina hojny obszar wokol etykiety+wartosci ze strony (juz skorygowanej
// pod katem obrotu) i rysuje czerwona ramke dokladnie tam, gdzie wartosc
// powinna sie znajdowac - zwykly uzytkownik od razu widzi, gdzie patrzec,
// bez szukania po calej stronie. Zwraca null, jesli nie mamy ZADNEJ pozycji
// (etykieta tez nie zostala znaleziona - rzadki przypadek, np. caly wiersz
// formularza zgubiony przez OCR) - wywolujacy pokazuje wtedy miniature calej
// strony bez zaznaczenia zamiast tego podgladu.
// Zabezpieczenie przed zepsutym bboxem (np. slowo z Vision o pustej/
// niekompletnej tablicy `vertices` - Math.min()/Math.max() na pustej liscie
// daja Infinity/-Infinity, nie 0) - realny bug zlapany 2026-07-21: taki bbox
// przechodzil przez wszystkie dotychczasowe Math.min/Math.max klamry bez
// wyjatku (Infinity/-Infinity to prawidlowe liczby dla tych funkcji), po
// czym drawRectOutline dostawal wspolrzedne prostokata siegajace Infinity -
// caly request wisial (utkniety w praktycznie nieskonczonej petli rysowania
// pikseli), zero CPU-friendly bo kazda pojedyncza iteracja byla tania, ale
// bylo ich astronomicznie duzo. Walidacja tutaj (nie w fieldExtraction.js)
// bo to jest jedyne miejsce, gdzie zepsuty bbox faktycznie powoduje szkode -
// gdziekolwiek indziej po prostu przechodzi jako wartosc liczbowa.
function isValidBBox(b) {
  return !!b && Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY);
}

// sourceImage (opcjonalny): juz-zdekodowany obraz strony (Jimp) do
// sklonowania, zamiast czytac+dekodowac plik JPEG od nowa - wywolujacy
// (server.js) trzyma jedna zdekodowana kopie per strona i podaje ja tutaj
// dla KAZDEGO pola z tej strony, bo dekodowanie duzego JPEG-a (Jimp, czysty
// JS, bez natywnego kodu) jest najdrozsza czescia tej funkcji, a wiele pol
// czesto patrzy na te sama strone (2026-07-22, przyspieszenie na prosbe
// wlasciciela - poprzednio kazde pole samo od zera Jimp.read() tej samej
// strony, przy 4 adresach x ~20 pol to bylo dziesiatki powtorzonych
// dekodowan tego samego pliku). `.clone()` bo `image.crop()` mutuje w
// miejscu - nie mozna reuzywac tej samej instancji miedzy polami.
// Wspolna geometria kadru pola: unia labelBBox+valueBBox + asymetryczny margines w prawo
// (wartosc na tych formularzach ZAWSZE lezy na prawo od etykiety). Uzywana zarowno przez
// buildFieldPreview (podglad dla czlowieka) jak i przez kalibracje wzorow (templateEngine.js) -
// oba potrzebuja DOKLADNIE tego samego, juz przetestowanego marginesu, zeby wzor kalibrowany
// z jednego adresu pochlaniał roznice w dlugosci odrecznego pisma na innych adresach tej samej gminy.
function computeFieldCropRect(labelBBox, valueBBox, { pageWidth, pageHeight, padXLeft = 140, padXRight = 900, padYTop = 90, padYBottom = 170 } = {}) {
  const safeLabelBBox = isValidBBox(labelBBox) ? labelBBox : null;
  const safeValueBBox = isValidBBox(valueBBox) ? valueBBox : null;
  const refBBox = safeLabelBBox && safeValueBBox
    ? {
        minX: Math.min(safeLabelBBox.minX, safeValueBBox.minX),
        minY: Math.min(safeLabelBBox.minY, safeValueBBox.minY),
        maxX: Math.max(safeLabelBBox.maxX, safeValueBBox.maxX),
        maxY: Math.max(safeLabelBBox.maxY, safeValueBBox.maxY)
      }
    : (safeLabelBBox || safeValueBBox);
  if (!refBBox) return null;

  const minX = Math.max(0, Math.round(refBBox.minX - padXLeft));
  const minY = Math.max(0, Math.round(refBBox.minY - padYTop));
  const maxX = Number.isFinite(pageWidth) ? Math.min(pageWidth, Math.round(refBBox.maxX + padXRight)) : Math.round(refBBox.maxX + padXRight);
  const maxY = Number.isFinite(pageHeight) ? Math.min(pageHeight, Math.round(refBBox.maxY + padYBottom)) : Math.round(refBBox.maxY + padYBottom);
  return { minX, minY, maxX, maxY };
}

async function buildFieldPreview({ pageImagePath, labelBBox, valueBBox, outPath, maxWidth = 1100, sourceImage = null }) {
  const safeValueBBox = isValidBBox(valueBBox) ? valueBBox : null;

  const image = sourceImage ? sourceImage.clone() : await Jimp.read(pageImagePath);
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  const cropRect = computeFieldCropRect(labelBBox, valueBBox, { pageWidth: width, pageHeight: height });
  if (!cropRect) return null;
  const cropX = cropRect.minX;
  const cropY = cropRect.minY;
  const cropW = Math.max(1, cropRect.maxX - cropRect.minX);
  const cropH = Math.max(1, cropRect.maxY - cropRect.minY);
  image.crop({ x: cropX, y: cropY, w: cropW, h: cropH });

  if (safeValueBBox) {
    const rx0 = Math.max(0, Math.round(safeValueBBox.minX - cropX) - 8);
    const ry0 = Math.max(0, Math.round(safeValueBBox.minY - cropY) - 8);
    const rx1 = Math.min(cropW - 1, Math.round(safeValueBBox.maxX - cropX) + 8);
    const ry1 = Math.min(cropH - 1, Math.round(safeValueBBox.maxY - cropY) + 8);
    drawRectOutline(image, rx0, ry0, rx1, ry1, 0xff2222ff);
  }

  if (image.bitmap.width > maxWidth) image.resize({ w: maxWidth });
  await image.write(outPath, { quality: 82 });
  return outPath;
}

// Wycina obszar strony wokol bbox (BEZ czerwonej ramki - to nie podglad dla
// czlowieka, tylko wejscie do ponownego OCR - patrz retryFieldWithCrop w
// server.js) i zapisuje jako osobny plik JPEG. Uzywane, gdy pierwszy przebieg
// OCR dal niepewny/pusty wynik dla pola - proba ponownego rozpoznania
// TYLKO tego fragmentu strony, licząc na to, ze mniejszy, izolowany kadr
// (bez calej reszty gestego formularza dookola) da Document AI czystszy
// wynik. Hojny margines (wiekszy niz w buildFieldPreview) bo tu NIE chodzi o
// czytelnosc dla oka, tylko o to, zeby caly kontekst etykiety+odpowiedzi (i
// ewentualnie sasiedniego checkboxa) zmiescil sie w kadrze.
async function cropPageRegion({ pageImagePath, bbox, outPath, sourceImage = null, padX = 300, padY = 220 }) {
  if (!isValidBBox(bbox)) return null;
  const image = sourceImage ? sourceImage.clone() : await Jimp.read(pageImagePath);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const cropX = Math.max(0, Math.round(bbox.minX - padX));
  const cropY = Math.max(0, Math.round(bbox.minY - padY));
  const cropRight = Math.min(width, Math.round(bbox.maxX + padX));
  const cropBottom = Math.min(height, Math.round(bbox.maxY + padY));
  const cropW = Math.max(1, cropRight - cropX);
  const cropH = Math.max(1, cropBottom - cropY);
  image.crop({ x: cropX, y: cropY, w: cropW, h: cropH });
  await image.write(outPath, { quality: 92 });
  return outPath;
}

// Buduje JEDEN wielostronicowy PDF (tylko dla stron z obrazem) z niewidoczna
// warstwa tekstu - odpowiednik dawnego trybu "pdf" Tesseracta, ktorego Vision
// nie ma wbudowanego. Kazde slowo rysowane jest z opacity:0 dokladnie nad
// swoim prostokatem ograniczajacym (bez uwzgledniania skosu - wystarczajace
// do zaznaczania/wyszukiwania, dokladny ksztalt glifow nie ma znaczenia
// skoro tekst i tak sie nie renderuje wizualnie).
// UWAGA: pdf-lib 1.17.1 (wersja w tym projekcie) NIE OBSLUGUJE opcji
// `renderingMode` w drawText() - jest po cichu ignorowana (zweryfikowane w
// zrodle: PDFPage.prototype.drawText czyta tylko color/opacity/font/size/
// rotate/xSkew/ySkew/x/y/lineHeight/maxWidth/wordBreaks/blendMode). Pierwsza
// wersja tej funkcji uzywala `renderingMode: TextRenderingMode.Invisible`,
// co skutkowalo NORMALNYM, WIDOCZNYM czarnym tekstem rysowanym na obrazie
// (realny bug zlapany przez wlasciciela na prawdziwym wyniku - "dwa teksty
// na sobie"). `opacity: 0` jest prawidlowym rozwiazaniem w tej bibliotece -
// tekst pozostaje prawdziwym obiektem tekstowym PDF-a (zaznaczalny/
// przeszukiwalny), tylko wizualnie w pelni przezroczysty.
// Zwraca tez statystyki pewnosci rozpoznania (Vision zwraca 0-1, tutaj
// przeliczane na 0-100 dla spojnosci z reszta UI).
async function buildOcrPdf({ pages, outPath }) {
  const pdfDoc = await PDFDocument.create();
  const font = await embedUnicodeFont(pdfDoc);
  let confSum = 0;
  let confCount = 0;
  let lowConfCount = 0;

  for (const page of pages) {
    const dpi = page.dpi || 300;
    const scale = 72 / dpi;
    const pageWidthPt = page.width * scale;
    const pageHeightPt = page.height * scale;
    const pdfPage = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

    // Realny blad zlapany 2026-07-22: jeden PLIK mial fizycznie uszkodzone
    // dane osadzonego obrazu na jednej stronie ("SOI not found in JPEG" -
    // brakuje nawet naglowka JPEG, nie da sie tego wczytac) - bez tego
    // try/catch caly wielostronicowy dokument wywalal sie na tej JEDNEJ
    // stronie. Rozmiar strony jest juz znany niezaleznie od tego, czy dane
    // obrazu sa uzywalne (page.width/height pochodza z wczesniejszego kroku
    // ekstrakcji, patrz pdfImageExtractor.js), wiec strona zawsze powstaje
    // w prawidlowym rozmiarze - jesli obrazu nie da sie osadzic, zostaje po
    // prostu biala (bez tresci OCR, bo i tak nie ma tla do podpisania), a
    // reszta dokumentu przetwarza sie normalnie dalej.
    let embeddedImage = null;
    try {
      const imageBytes = await fs.readFile(page.imagePath);
      const ext = path.extname(page.imagePath).toLowerCase();
      embeddedImage = ext === '.png' ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes);
    } catch (_) {
      continue; // strona zostaje biala, bez warstwy tekstu - nic wiecej nie da sie z niej zrobic
    }
    pdfPage.drawImage(embeddedImage, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });

    for (const word of page.ocrWords || []) {
      if (typeof word.confidence === 'number') {
        confSum += word.confidence;
        confCount += 1;
        if (word.confidence < 0.6) lowConfCount += 1;
      }
      const v = word.vertices;
      if (!v || v.length < 4 || !word.text) continue;
      const xs = v.map((p) => p.x * scale);
      const ys = v.map((p) => p.y * scale);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const boxWidth = Math.max(...xs) - left;
      const boxHeight = Math.max(...ys) - top;
      if (boxWidth <= 0 || boxHeight <= 0) continue;
      const fontSize = Math.max(4, boxHeight * 0.85);
      let textWidth = 0;
      try { textWidth = font.widthOfTextAtSize(word.text, fontSize); } catch (_) { textWidth = 0; }
      const finalSize = textWidth > 0 ? Math.min(fontSize * (boxWidth / textWidth), fontSize * 4) : fontSize;
      const pdfY = pageHeightPt - (top + boxHeight);
      try {
        pdfPage.drawText(word.text, { x: left, y: pdfY, size: finalSize, font, opacity: 0 });
      } catch (_) { /* pojedynczy niekodowalny znak nie powinien wywalac calej strony */ }
    }
  }

  const outBytes = await pdfDoc.save();
  await fs.writeFile(outPath, outBytes);
  const avgConfidence = confCount ? (confSum / confCount) * 100 : null;
  const lowConfidenceRatio = confCount ? lowConfCount / confCount : 0;
  return { avgConfidence, lowConfidenceRatio };
}

// workDir: katalog roboczy analizy (obrazy posrednie, miniatury) - MUSI
// przetrwac az do finalizeSplit (uzytkownik przeglada/poprawia podzial na
// bloki miedzy tymi wywolaniami) - wywolujacy (server.js) sprzata go dopiero
// po finalizacji/wygasnieciu sesji analizy.
// Zwraca `pages`+`ocrPdfPath` potrzebne finalizeSplit do pociecia JUZ
// zrobionego OCR-u na finalne pliki (patrz assemblePdfRange) - OCR nigdy nie
// jest powtarzany.
async function analyzeDocument({ sourcePdfPath, workDir }) {
  await fs.mkdir(workDir, { recursive: true });

  const textCheck = await checkTextLayer(sourcePdfPath);
  if (textCheck.hasText) {
    const sourceDoc = await PDFDocument.load(await fs.readFile(sourcePdfPath), { updateMetadata: false });
    const pageCount = sourceDoc.getPageCount();
    return {
      status: 'skipped-already-has-text',
      textLength: textCheck.textLength,
      pageCount,
      pages: null,
      ocrPdfPath: null,
      avgConfidence: null,
      lowConfidenceRatio: 0,
      warnings: [],
      blocks: [{ startPage: 0, endPage: pageCount - 1 }],
      thumbnails: []
    };
  }

  if (!isConfigured()) {
    throw new Error('Brak konfiguracji Google Document AI (OCR_DOCAI_KEY_FILE/OCR_DOCAI_PROJECT_ID/OCR_DOCAI_LOCATION/OCR_DOCAI_PROCESSOR_ID). Ustaw zmienne srodowiskowe i uruchom ponownie.');
  }

  const { pageCount, pages: extractedPages } = await extractPageImages(sourcePdfPath, workDir);
  const warnings = [];
  const skippedPages = extractedPages.filter((p) => !p.imagePath);

  for (const p of skippedPages) {
    warnings.push(`Strona ${p.pageIndex + 1}: brak rozpoznanego obrazu (${p.unsupportedFilter ? 'nieobslugiwany format: ' + p.unsupportedFilter : 'brak osadzonego obrazu'}) - skopiowana bez OCR.`);
  }
  // Rozpoznawanie tekstu KAZDEJ strony z obrazem, rownolegle (patrz
  // mapWithConcurrency) - jedno zadanie na strone. Limit obnizony z 15
  // (Vision) do 5 przy migracji na Document AI (2026-07-22) - Document AI's
  // synchroniczne processDocument ma zazwyczaj nizszy domyslny limit
  // zapytan/min niz Vision; jesli w praktyce (wieksze partie skanow) pojawia
  // sie bledy quota/429, obnizyc dalej.
  const imagedExtracted = extractedPages.filter((p) => p.imagePath);
  const ocrResults = await mapWithConcurrency(imagedExtracted, 5, ocrPage);
  const ocrByIndex = new Map(ocrResults.map((p) => [p.pageIndex, p]));
  let pages = extractedPages.map((p) => ocrByIndex.get(p.pageIndex) || p);
  for (const p of pages) {
    if (p.ocrError) warnings.push(`Strona ${p.pageIndex + 1}: rozpoznawanie tekstu nie powiodlo sie (${p.ocrError}) - strona skopiowana bez OCR.`);
  }

  const imagedPages = pages.filter((p) => p.imagePath);
  if (!imagedPages.length) {
    return {
      status: 'no-ocr-possible',
      textLength: textCheck.textLength,
      pageCount,
      pages,
      ocrPdfPath: null,
      avgConfidence: null,
      lowConfidenceRatio: 0,
      warnings,
      blocks: [{ startPage: 0, endPage: pageCount - 1 }],
      thumbnails: []
    };
  }

  const ocrOutPath = path.join(workDir, 'ocr-output.pdf');
  const { avgConfidence, lowConfidenceRatio } = await buildOcrPdf({ pages: imagedPages, outPath: ocrOutPath });
  if (avgConfidence !== null && avgConfidence < 70) {
    warnings.push(`Niska srednia pewnosc rozpoznania tekstu (${avgConfidence.toFixed(0)}%) - czesc tekstu (np. odreczne wpisy) moze byc rozpoznana niepoprawnie.`);
  }

  const boundaries = detectBlockBoundaries({ imagedPages });
  const blocks = boundariesToBlocks(boundaries, pageCount);
  if (blocks.length > 1) {
    warnings.push(`Wykryto ${blocks.length} prawdopodobne bloki adresowe w jednym pliku (powtarzajacy sie naglowek protokolu) - sprawdz i w razie potrzeby popraw podzial przed pobraniem.`);
  }

  const thumbDir = path.join(workDir, 'thumbs');
  const thumbnails = await buildThumbnails(pages, thumbDir);

  return {
    status: 'ocr-done',
    textLength: textCheck.textLength,
    pageCount,
    pages,
    ocrPdfPath: ocrOutPath,
    avgConfidence,
    lowConfidenceRatio,
    warnings,
    blocks,
    thumbnails
  };
}

// Finalizuje podzial: dla kazdego zatwierdzonego bloku tnie JUZ zrobiony OCR
// (analyzeDocument.ocrPdfPath+pages) na osobny plik wyjsciowy. Dla plikow bez
// OCR-u (skipped-already-has-text / no-ocr-possible, pages===null) kazdy blok
// to zwykla kopia oryginalu (w praktyce zawsze dokladnie jeden blok - patrz
// analyzeDocument powyzej, ale nie zakladamy tego na sztywno).
async function finalizeSplit({ sourcePdfPath, ocrPdfPath, pages, blocks, outPaths }) {
  for (let i = 0; i < blocks.length; i++) {
    const outPath = outPaths[i];
    if (!pages) {
      await fs.copyFile(sourcePdfPath, outPath);
    } else {
      await assemblePdfRange({ sourcePdfPath, ocrPdfPath, pages, range: blocks[i], outPath });
    }
  }
}

module.exports = { analyzeDocument, finalizeSplit, assemblePdfRange, buildThumbnails, buildFieldPreview, cropPageRegion, computeFieldCropRect, withTimeout, OCR_PAGE_TIMEOUT_MS };
