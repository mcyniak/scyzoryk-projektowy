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

// Zadane na zywo 2026-08-24: napis w JEDNEJ linii ("DOKUMENTACJA
// POWYKONAWCZA" obok siebie, zamiast jedna nad druga - nic nie zasloni),
// czcionka 10 pt (wczesniej efektywnie 9) i blizej gornej krawedzi strony.
const STAMP_TEXT = "DOKUMENTACJA POWYKONAWCZA";
const STAMP_COLOR = rgb(0, 0, 0); // czarny - drukarka docelowa jest czarno-biala
// Margines w PUNKTACH (nie w %) - dosuniecie "milimetrowe" do samego rogu ma
// wygladac tak samo niezaleznie od rozmiaru/proporcji strony (A4, rysunek,
// karta katalogowa itd.), a % marginesu skalowalby sie z rozmiarem strony.
// 1mm = 2.83465pt.
const STAMP_MARGIN_PT = 3; // ok. 1mm
const STAMP_FONT_SIZE = 10; // o 1 punkt wiecej niz poprzednie efektywne 9

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
  // Szerokosc napisu liczona z PRAWDZIWEJ metryki czcionki (zamiast boxa
  // 20% szerokosci strony jak wczesniej) - napis zawsze konczy sie dokladnie
  // przy STAMP_MARGIN_PT od prawej krawedzi, niezaleznie od rozmiaru strony.
  const textWidth = font.widthOfTextAtSize(STAMP_TEXT, STAMP_FONT_SIZE);
  const visualBoxX = visual.width - STAMP_MARGIN_PT - textWidth;
  // Blizej gornej krawedzi: baseline tekstu tuż pod marginesem (wczesniej
  // napis byl wycentrowany w pionowym boxie 6% wysokosci strony, przez co
  // pierwsza linia zaczynala sie ~15 pt nizej).
  const visualY = visual.height - STAMP_MARGIN_PT - STAMP_FONT_SIZE;

  // WAZNE: dla stron obroconych (90/270 st.) "prawo"/"dol" w ukladzie
  // wizualnym NIE sa tym samym co +x/-y w ukladzie PDF-a (patrz
  // mapVisualBottomLeftToPdf) - mapowanie na PDF robimy jako ostatni krok,
  // na wspolrzednych policzonych w ukladzie WIZUALNYM (visualX/visualY).
  const mapped = mapVisualBottomLeftToPdf(page, visualBoxX, visualY);
  page.drawText(STAMP_TEXT, {
    x: mapped.x,
    y: mapped.y,
    size: STAMP_FONT_SIZE,
    font,
    color: STAMP_COLOR,
    rotate: degrees(mapped.rotation),
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
