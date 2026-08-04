// Stempel "DOKUMENTACJA POWYKONAWCZA" w prawym gornym rogu kazdej strony -
// uzywane tylko gdy uzytkownik zaznaczy "Drukuj jako dokumentacje
// powykonawcza" w drukarce projektow. Logika obliczania pozycji z
// uwzglednieniem obrotu strony jest skopiowana/zaadaptowana z
// apps/pieczatki-pdf/server.js (visualPageSize/mapVisualBottomLeftToPdf) -
// ten sam wzorzec, celowo zvendorowany a nie dzielony przez wspolny modul
// (patrz CLAUDE.md: male moduly kopiujemy, nie robimy przedwczesnej
// abstrakcji miedzy apkami).
const fs = require("fs/promises");
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");

const STAMP_LINES = ["DOKUMENTACJA", "POWYKONAWCZA"];
const STAMP_COLOR = rgb(0, 0, 0); // czarny - drukarka docelowa jest czarno-biala
const STAMP_X_PCT = 62; // lewy brzeg boxu stempla - box siega az do ~96% szerokosci
const STAMP_RIGHT_MARGIN_PCT = 4;
const STAMP_TOP_MARGIN_PCT = 3;
const STAMP_HEIGHT_PCT = 9;
const MAX_FONT_SIZE = 22; // rozmiar rzedu domyslnego w Pieczatkach PDF dla dwoch linii tekstu

function visualPageSize(page) {
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const width = page.getWidth();
  const height = page.getHeight();
  if (rotation === 90 || rotation === 270) {
    return { width: height, height: width, rotation, pageWidth: width, pageHeight: height };
  }
  return { width, height, rotation, pageWidth: width, pageHeight: height };
}

function mapVisualBottomLeftToPdf(page, visualX, visualY) {
  const { rotation, pageWidth, pageHeight } = visualPageSize(page);
  if (rotation === 90) return { x: pageWidth - visualY, y: visualX, rotation };
  if (rotation === 180) return { x: pageWidth - visualX, y: pageHeight - visualY, rotation };
  if (rotation === 270) return { x: visualY, y: pageHeight - visualX, rotation };
  return { x: visualX, y: visualY, rotation };
}

// Tekst stempla ("DOKUMENTACJA POWYKONAWCZA") jest wylacznie ASCII - w
// odroznieniu od pieczatki-pdf (gdzie tekst wpisuje uzytkownik i moze
// zawierac polskie znaki) nie potrzeba tu wlasnej czcionki TTF/fontkit,
// wbudowana czcionka standardowa pdf-lib wystarcza i jest szybsza (bez I/O
// na plik czcionki).
async function loadStampFont(doc) {
  return doc.embedFont(StandardFonts.HelveticaBold);
}

function drawStampOnPage(page, font) {
  const visual = visualPageSize(page);
  const stampWidth = Math.max(8, visual.width * (100 - STAMP_X_PCT - STAMP_RIGHT_MARGIN_PCT) / 100);
  const stampHeight = Math.max(8, visual.height * STAMP_HEIGHT_PCT / 100);
  const visualX = visual.width * STAMP_X_PCT / 100;
  const visualTop = visual.height * STAMP_TOP_MARGIN_PCT / 100;
  const visualY = visual.height - visualTop - stampHeight;
  const mapped = mapVisualBottomLeftToPdf(page, visualX, visualY);

  const fontSize = Math.max(6, Math.min(stampHeight / STAMP_LINES.length * 0.6, stampWidth / 9, MAX_FONT_SIZE));
  const lineHeight = fontSize * 1.18;
  const totalHeight = lineHeight * STAMP_LINES.length;
  const firstY = mapped.y + (stampHeight - totalHeight) / 2 + totalHeight - fontSize;

  STAMP_LINES.forEach((line, li) => {
    const textWidth = font.widthOfTextAtSize(line, fontSize);
    page.drawText(line, {
      x: mapped.x + Math.max(0, (stampWidth - textWidth) / 2),
      y: firstY - li * lineHeight,
      size: fontSize,
      font,
      color: STAMP_COLOR,
      rotate: degrees(mapped.rotation),
    });
  });
}

// Ostemplowuje WSZYSTKIE strony pliku PDF pod podana sciezka (w miejscu) -
// nadpisuje oryginal. Wolane tylko dla plikow, ktore juz sa/staly sie PDF-em
// (rysunki od zawsze, strona tytulowa/opis techniczny po konwersji z DOCX).
async function stampAllPages(pdfPath) {
  const bytes = await fs.readFile(pdfPath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await loadStampFont(doc);
  for (const page of doc.getPages()) drawStampOnPage(page, font);
  await fs.writeFile(pdfPath, await doc.save());
}

module.exports = { stampAllPages, drawStampOnPage, visualPageSize, mapVisualBottomLeftToPdf };
