// Wykrywanie obrotu strony (2026-07-21, przepisane po zamianie silnika OCR na
// Google Cloud Vision) - NIE uzywa juz osobnego wywolania Tesseract OSD.
// Zamiast tego czyta geometrie wierzcholkow slow, ktore Vision i tak zwraca w
// kazdej odpowiedzi `DOCUMENT_TEXT_DETECTION` - zero dodatkowego wywolania
// API/silnika.
//
// Zweryfikowane na realnym pliku (Kazimierz Biskupi, strona fizycznie
// obrocona o 180 stopni, bez flagi PDF /Rotate): pierwsze slowo w kolejnosci
// odczytu ("Ksztalt") mialo wierzcholki [(555,800),(526,799),(526,790),
// (555,791)] - wektor od wierzcholka 0 do 1 wskazuje w lewo (ujemne dx),
// co odpowiada tekstowi czytanemu "do gory nogami" w surowym obrazie -
// Vision poprawnie rozpoznaje kolejnosc/tresc mimo obrotu, ale wspolrzedne
// wciaz sa podane w ukladzie ORYGINALNEGO (niepoprawionego) obrazu.
//
// Konwencja zwracanej wartosci "rotate" (zgodna z reszta pipeline'u, patrz
// ocrPipeline.js): liczba stopni, o jaka trzeba obrocic obraz ZGODNIE z
// ruchem wskazowek zegara, zeby go wyprostowac. Jimp.rotate() dla dodatnich
// wartosci obraca PRZECIWNIE do ruchu wskazowek - stad przeliczenie
// `(360 - rotate) % 360` przy faktycznym wywolaniu Jimp (patrz ocrPipeline.js).

function angleToRotation(thetaDeg) {
  const norm = ((thetaDeg % 360) + 360) % 360;
  if (norm < 45 || norm >= 315) return 0;
  if (norm < 135) return 270;
  if (norm < 225) return 180;
  return 90;
}

// Zwraca { rotate, votes, total }: "rotate" to obrot z najwieksza liczba
// glosow spord wszystkich slow strony (0 jesli wiekszosc/wszystkie slowa sa
// juz uprosne), "votes"/"total" pozwalaja wywolujacemu ocenic pewnosc tego
// wykrycia (np. strona ze szkicem odrecznym i niewielka iloscia tekstu bedzie
// miala niskie "total" - patrz wiekszosciowe glosowanie partii skanow w
// ocrPipeline.js).
function detectRotationFromWords(words) {
  const counts = { 0: 0, 90: 0, 180: 0, 270: 0 };
  for (const word of words || []) {
    const v = word.vertices;
    if (!v || v.length < 2) continue;
    const dx = v[1].x - v[0].x;
    const dy = v[1].y - v[0].y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    const theta = Math.atan2(dy, dx) * (180 / Math.PI);
    counts[angleToRotation(theta)] += 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return { rotate: 0, votes: 0, total: 0 };
  const [rotate, votes] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { rotate: Number(rotate), votes, total };
}

// Przelicza wierzcholek (x,y) z ukladu oryginalnego obrazu (szerokosc w,
// wysokosc h) na uklad obrazu fizycznie obroconego o "rotate" stopni ZGODNIE
// z ruchem wskazowek zegara - ta sama konwencja/kierunek co przy faktycznym
// obracaniu pikseli przez Jimp w ocrPipeline.js (wolanym z tym samym
// "rotate"). Uzywane, zeby wspolrzedne slow z Vision (policzone na
// oryginalnym, jeszcze nieobroconym obrazie) dalej trafialy we wlasciwe
// miejsce PO fizycznym wyprostowaniu strony.
function rotatePoint(x, y, w, h, rotate) {
  switch (rotate) {
    case 90: return { x: h - y, y: x };
    case 180: return { x: w - x, y: h - y };
    case 270: return { x: y, y: w - x };
    default: return { x, y };
  }
}

module.exports = { detectRotationFromWords, angleToRotation, rotatePoint };
