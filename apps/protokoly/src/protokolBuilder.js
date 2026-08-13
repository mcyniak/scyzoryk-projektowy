const fs = require("fs");
const path = require("path");
const { Jimp, JimpMime } = require("jimp");
const { PDFDocument } = require("pdf-lib");

// Skaner/aparat zapisuje zdjecia protokolu jako "NNN.link.HHMMSS.jpg" (albo
// .jpeg/.png) - ten wzorzec byl obecny w kazdym sprawdzonym folderze
// realnych danych, zawsze obok tych samych stalych nazw brandingowych
// (Herb/Logo/Logotypy), ktore NIE maja tego wzorca. Odroznia zdjecia
// protokolu od innych obrazkow bez potrzeby zgadywania po tresci.
const LINK_PHOTO_PATTERN = /^(\d+)\.link\.(\d+)\.(jpe?g|png)$/i;
const MAX_SCAN_DEPTH = 4;
// pdf-lib addPage() bierze wymiary w PUNKTACH (72/cal), nie pikselach - A4
// to standardowe 595.28 x 841.89 pt.
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

function addressFromFolderName(name) {
  return String(name || "").replace(/^\d+\.\s*/, "").trim();
}

function listAddressFolders(baseFolder) {
  if (!fs.existsSync(baseFolder) || !fs.statSync(baseFolder).isDirectory()) {
    throw new Error(`Folder bazowy nie istnieje: ${baseFolder}`);
  }
  return fs.readdirSync(baseFolder, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, "pl", { numeric: true, sensitivity: "base" }));
}

// Rekurencyjnie znajduje zdjecia protokolu w folderze adresu - moga lezec
// bezposrednio w folderze adresu albo w dowolnym podfolderze (np.
// "<adres>-pdf", albo przypadkowo zagniezdzonym podfolderze o TEJ SAMEJ
// nazwie co folder adresu - realny przypadek "19.Ul. Reja 5, Posada" w tej
// samej inwestycji, ktory nie ma zadnego podfolderu z "-pdf" w nazwie).
// Zwraca posortowane chronologicznie po znaczniku czasu w nazwie pliku
// (kolejnosc robienia zdjec = kolejnosc stron protokolu).
function findProtocolPhotos(addressFolderPath) {
  const found = [];
  function walk(currentPath, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(currentPath, entry.name);
      if (entry.isFile()) {
        const m = entry.name.match(LINK_PHOTO_PATTERN);
        if (m) {
          found.push({ path: full, dir: currentPath, seq: Number(m[1]), time: m[2] });
        }
      } else if (entry.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }
  walk(addressFolderPath, 0);
  found.sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq);
  return found;
}

// Znajduje bounding-box jasnego obszaru (kartka) na tle ciemnego stolu/blatu -
// dla kazdego wiersza/kolumny liczymy odsetek pikseli jasniejszych niz
// brightThreshold; jesli przekracza minFraction, wiersz/kolumna nalezy do
// kartki. Audyt na zywo 2026-08-13: usuniecie ciemnego tla to najwiekszy
// pojedynczy oszczedzacz tuszu przy druku (wiecej niz sama konwersja na
// czarno-bialy) - dziala dobrze wlasnie dlatego, ze te zdjecia sa robione na
// ciemnym stole/blacie, wiec kontrast kartka/tlo jest bardzo duzy.
function findPageBoundingBox(image, brightThreshold, minFraction) {
  const { width, height } = image.bitmap;
  const rowBright = new Array(height).fill(0);
  const colBright = new Array(width).fill(0);
  image.scan(0, 0, width, height, function (x, y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum > brightThreshold) { rowBright[y]++; colBright[x]++; }
  });
  let top = 0, bottom = height - 1, left = 0, right = width - 1;
  for (let y = 0; y < height; y++) { if (rowBright[y] / width > minFraction) { top = y; break; } }
  for (let y = height - 1; y >= 0; y--) { if (rowBright[y] / width > minFraction) { bottom = y; break; } }
  for (let x = 0; x < width; x++) { if (colBright[x] / height > minFraction) { left = x; break; } }
  for (let x = width - 1; x >= 0; x--) { if (colBright[x] / height > minFraction) { right = x; break; } }
  return { left, top, width: Math.max(1, right - left + 1), height: Math.max(1, bottom - top + 1) };
}

const BRIGHT_THRESHOLD = Number(process.env.PROTOKOLY_BRIGHT_THRESHOLD || 90);
const MIN_FRACTION = Number(process.env.PROTOKOLY_MIN_FRACTION || 0.4);
// Zweryfikowane recznie na zywo 2026-08-13 na dwoch prawdziwych zdjeciach
// protokolow (jedno z nich wymagalo korekty orientacji EXIF) - greyscale +
// contrast(0.35) BEZ brightness() daje czysty, jasny, czytelny wynik.
// Jimp.brightness() w tej wersji (1.6.1) paradoksalnie PRZYCIEMNIA obraz
// zamiast go rozjasnic (zweryfikowane empirycznie, nie tylko z dokumentacji)
// - celowo pominiete w tym pipeline.
const CONTRAST = Number(process.env.PROTOKOLY_CONTRAST || 0.35);
const CROP_PADDING = Number(process.env.PROTOKOLY_CROP_PADDING || 10);
const THUMBNAIL_WIDTH = 400;
const JPEG_QUALITY = Number(process.env.PROTOKOLY_JPEG_QUALITY || 82);
// Audyt na zywo 2026-08-13: Jimp (1.6.1) dekoduje/koduje JPEG w czystym JS
// (@jimp/js-jpeg, bez natywnych bindingow) - na pelnej rozdzielczosci
// zdjecia z telefonu (~3000x4000, 12MP) samo przetworzenie jednego zdjecia
// zajmowalo realnie ~10s, co przy 5 zdjeciach na adres i uzytkowniku
// czekajacym na wynik NA ZYWO bylo stanowczo za wolne. Do wydruku
// czarno-bialego wystarczy znacznie mniejsza rozdzielczosc (~1700px
// szerokosci to ~200 DPI dla strony A4) - pomniejszenie TUZ PO przycięciu,
// PRZED greyscale/contrast/zapisem JPEG, redukuje liczbe pikseli
// przetwarzanych przez wszystkie kolejne kroki (w tym powolny czysty-JS
// enkoder), nie tylko sam zapis.
const MAX_OUTPUT_WIDTH = Number(process.env.PROTOKOLY_MAX_OUTPUT_WIDTH || 1700);

// Przetwarza jedno zdjecie protokolu: przycina do samej kartki, konwertuje
// na czarno-bialy z podbitym kontrastem. Korekta orientacji EXIF (zdjecia
// robione "na boku") jest stosowana automatycznie przez dekoder Jimp/jpeg -
// nie trzeba jej robic recznie (zweryfikowane na realnym zdjeciu z
// Orientation=8).
async function processPhoto(photoPath) {
  const img = await Jimp.read(photoPath);
  const small = img.clone().resize({ w: THUMBNAIL_WIDTH });
  const scale = img.bitmap.width / small.bitmap.width;
  const box = findPageBoundingBox(small, BRIGHT_THRESHOLD, MIN_FRACTION);
  // Prawa/dolna krawedz liczona i przycinana do granic obrazu NIEZALEZNIE od
  // lewej/gornej, a szerokosc/wysokosc dopiero z roznicy - liczenie samej
  // szerokosci z osobnym Math.min(img.width, ...) (bez uwzglednienia left)
  // potrafilo dac left+width > img.width (realny blad zlapany na zywo:
  // "offset out of range" przy Jimp.crop na prawdziwym zdjeciu z Reja 5).
  const rawLeft = Math.max(0, Math.round(box.left * scale) - CROP_PADDING);
  const rawTop = Math.max(0, Math.round(box.top * scale) - CROP_PADDING);
  const rawRight = Math.min(img.bitmap.width, Math.round((box.left + box.width) * scale) + CROP_PADDING);
  const rawBottom = Math.min(img.bitmap.height, Math.round((box.top + box.height) * scale) + CROP_PADDING);
  const fullBox = {
    left: rawLeft,
    top: rawTop,
    width: Math.max(1, rawRight - rawLeft),
    height: Math.max(1, rawBottom - rawTop)
  };
  img.crop({ x: fullBox.left, y: fullBox.top, w: fullBox.width, h: fullBox.height });
  if (img.bitmap.width > MAX_OUTPUT_WIDTH) img.resize({ w: MAX_OUTPUT_WIDTH });
  img.greyscale();
  img.contrast(CONTRAST);
  return img;
}

// Zdjecia sa czytane z dysku sieciowego (Google Drive) - odczyt pliku jest
// asynchroniczny (nieblokujacy watek zdarzen), wiec przetwarzanie kilku
// zdjec NA RAZ (ten sam wzorzec CONCURRENCY co w
// apps/drukarka-projekty/server.js#matchOneAddress) nakłada się w czasie
// oczekiwania na sieciowe I/O, mimo ze samo przeksztalcanie pikseli w Jimp
// jest jednowatkowe. Kolejnosc stron w PDF-ie jest zachowana (bufory
// zbierane do tablicy po indeksie, strony dodawane sekwencyjnie na koncu),
// niezaleznie od kolejnosci w jakiej faktycznie skoncza sie poszczegolne
// zadania.
const PROCESS_CONCURRENCY = Number(process.env.PROTOKOLY_CONCURRENCY || 3);

async function buildProtocolPdf(photoPaths) {
  const jpegBuffers = new Array(photoPaths.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < photoPaths.length) {
      const idx = nextIndex++;
      const img = await processPhoto(photoPaths[idx]);
      jpegBuffers[idx] = await img.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROCESS_CONCURRENCY, photoPaths.length) }, worker));

  const pdfDoc = await PDFDocument.create();
  for (const jpegBuffer of jpegBuffers) {
    const jpgImage = await pdfDoc.embedJpg(jpegBuffer);
    // Realny blad zlapany na zywo 2026-08-13: strona byla tworzona w
    // wymiarach PIKSELI obrazu, ale pdf-lib interpretuje addPage() jako
    // PUNKTY (72/cal) - strona 1700x2200 "pikseli" stawala sie stronica
    // 1700x2200 PUNKTOW (~23.6 x 30.6 cala), kompletnie nie-A4, ktora
    // drukarki skaluja/przycinaja nieprzewidywalnie. Strona ma teraz zawsze
    // realny rozmiar A4, a obraz jest dopasowywany (zachowujac proporcje,
    // wyśrodkowany) do jej wnetrza - jesli proporcje zdjecia nie pasuja
    // dokladnie do A4, zostaje watki biały margines z jednej pary bokow,
    // zamiast rozciagac/przycinac tresc.
    const page = pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    const imgAspect = jpgImage.width / jpgImage.height;
    const pageAspect = A4_WIDTH_PT / A4_HEIGHT_PT;
    const drawWidth = imgAspect > pageAspect ? A4_WIDTH_PT : A4_HEIGHT_PT * imgAspect;
    const drawHeight = imgAspect > pageAspect ? A4_WIDTH_PT / imgAspect : A4_HEIGHT_PT;
    page.drawImage(jpgImage, {
      x: (A4_WIDTH_PT - drawWidth) / 2,
      y: (A4_HEIGHT_PT - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight
    });
  }
  return Buffer.from(await pdfDoc.save());
}

// Nazwa musi zawierac "protokół" i "uzgodnień", zeby drukarka-projekty
// (apps/drukarka-projekty/src/folderMatch.js#guessKeywordsForAttachment,
// wyzwalacz KEYWORD_MAP ["protok","uzgodni"]) automatycznie rozpoznala ten
// plik jako Protokol uzgodnien projektowych, bez potrzeby OCR-owania tresci
// (ten PDF sklada sie z samych obrazow, wiec nie ma w nim wyszukiwalnego
// tekstu).
function outputFileName(addressFolderName) {
  const adres = addressFromFolderName(addressFolderName);
  return `Protokół uzgodnień projektowych - ${adres}.pdf`;
}

// Wybiera folder docelowy do zapisu - TEN SAM podfolder, w ktorym faktycznie
// znaleziono najwiecej zdjec (nie zakladamy z gory konwencji nazwy "-pdf" -
// realny przypadek Reja 5, Posada: zdjecia leza w podfolderze o nazwie
// identycznej jak folder adresu, bez "-pdf" w nazwie).
function targetSaveDir(addressFolderPath, photos) {
  if (!photos.length) return addressFolderPath;
  const counts = new Map();
  for (const p of photos) counts.set(p.dir, (counts.get(p.dir) || 0) + 1);
  let best = addressFolderPath, bestCount = -1;
  for (const [dir, count] of counts) { if (count > bestCount) { best = dir; bestCount = count; } }
  return best;
}

module.exports = {
  LINK_PHOTO_PATTERN,
  addressFromFolderName,
  listAddressFolders,
  findProtocolPhotos,
  findPageBoundingBox,
  processPhoto,
  buildProtocolPdf,
  outputFileName,
  targetSaveDir
};
