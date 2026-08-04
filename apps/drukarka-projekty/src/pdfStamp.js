// Stempel "DOKUMENTACJA POWYKONAWCZA" w lewym gornym rogu kazdej strony -
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
// Margines w PUNKTACH (nie w %) - dosuniecie "milimetrowe" do samego rogu ma
// wygladac tak samo niezaleznie od rozmiaru/proporcji strony (A4, rysunek,
// karta katalogowa itd.), a % marginesu skalowalby sie z rozmiarem strony.
// 1mm = 2.83465pt.
const STAMP_MARGIN_PT = 3; // ok. 1mm
const STAMP_WIDTH_PCT = 20;
const STAMP_HEIGHT_PCT = 6;
const MAX_FONT_SIZE = 9; // maly, nienarzucajacy sie napis - nie ma zasłaniac tresci dokumentu

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
  const stampWidth = Math.max(8, visual.width * STAMP_WIDTH_PCT / 100);
  const stampHeight = Math.max(8, visual.height * STAMP_HEIGHT_PCT / 100);
  const visualBoxX = STAMP_MARGIN_PT;
  const visualBoxY = visual.height - STAMP_MARGIN_PT - stampHeight;

  const fontSize = Math.max(6, Math.min(stampHeight / STAMP_LINES.length * 0.6, stampWidth / 9, MAX_FONT_SIZE));
  const lineHeight = fontSize * 1.18;
  const totalHeight = lineHeight * STAMP_LINES.length;
  const firstVisualY = visualBoxY + (stampHeight - totalHeight) / 2 + totalHeight - fontSize;

  // WAZNE: dla stron obroconych (90/270 st.) "prawo"/"dol" w ukladzie
  // wizualnym NIE sa tym samym co +x/-y w ukladzie PDF-a (patrz
  // mapVisualBottomLeftToPdf). Wczesniej centrowanie kazdej linii w poziomie
  // dodawalo offset PROSTO do juz-zmapowanego mapped.x w przestrzeni PDF-a -
  // dla stron z rotacja to przesuwalo kotwice w NIEWLASCIWYM kierunku i przy
  // wystarczajaco duzym offsecie wypychalo caly tekst poza widoczna strone
  // (niewidoczny stempel na stronach "bokiem", mimo poprawnej pozycji samego
  // boxu). Naprawa: policz pozycje KAZDEJ linii w ukladzie WIZUALNYM
  // (visualX/visualY), a mapowanie na PDF zrob jako ostatni krok, osobno dla
  // kazdej linii (bo kazda ma inna szerokosc tekstu, wiec inny offset).
  STAMP_LINES.forEach((line, li) => {
    const textWidth = font.widthOfTextAtSize(line, fontSize);
    const lineVisualX = visualBoxX + Math.max(0, (stampWidth - textWidth) / 2);
    const lineVisualY = firstVisualY - li * lineHeight;
    const mapped = mapVisualBottomLeftToPdf(page, lineVisualX, lineVisualY);
    page.drawText(line, {
      x: mapped.x,
      y: mapped.y,
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
