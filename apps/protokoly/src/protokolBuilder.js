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

// name moze byc relatywna sciezka z podfolderem kategorii (patrz
// listAddressFolders ponizej) - adres wyliczamy zawsze z OSTATNIEGO segmentu
// (nazwy samego folderu adresu), nie z calej sciezki.
function addressFromFolderName(name) {
  return path.basename(String(name || "")).replace(/^\d+\.\s*/, "").trim();
}

// Prawdziwe foldery adresow zawsze zaczynaja sie od numeru (np. "47.Ul.
// Poludniowa 30, Bielawy", "41 - Zarnow, ul. Spacerowa") - foldery kategorii
// (np. "Wyslane do gminy", "Gotowe do druku") nigdy. Audyt na zywo
// 2026-08-14 (Kazimierz Biskupi, folder bazowy "Projekty" - kategoria WYZEJ
// niz adresy): bez tego rozroznienia baseFolder z samymi podfolderami
// kategorii listowal TE kategorie jako "adresy", a nastepne skanowanie zdjec
// (rekurencyjne, patrz findProtocolPhotos) chwytalo WSZYSTKIE zdjecia ze
// WSZYSTKICH adresow pod dana kategoria (dziesiatki/setki) i laczylo je w
// jeden falszywy "protokol" pod nazwa kategorii zamiast pokazac osobne
// adresy. Szukamy wiec teraz prawdziwych folderow adresu takze w
// podfolderach kategorii, do ograniczonej glebokosci (ten sam wzorzec co
// ADDRESS_FOLDER_SEARCH_MAX_DEPTH w drukarce-projektow).
const ADDRESS_FOLDER_PATTERN = /^\d/;
const CATEGORY_SEARCH_MAX_DEPTH = 3;

// Realny przypadek zlapany na zywo 2026-08-14: sam numer na poczatku nazwy
// nie wystarcza - "0.Gotowe do wyslania" tez zaczyna sie od cyfry, ale w
// srodku ma 11 KOLEJNYCH numerowanych folderow adresu (kolejny "koszyk"
// kategorii, nie pojedynczy adres). Folder, ktory sam zawiera KILKA (2+)
// innych numerowanych podfolderow, jest wiec traktowany jako kolejna
// kategoria do przeszukania dalej, a nie jako lisc/adres.
function looksLikeAddressContainer(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch (_err) {
    return false;
  }
  return entries.filter(e => ADDRESS_FOLDER_PATTERN.test(e.name.trim())).length >= 2;
}

function listAddressFolders(baseFolder) {
  if (!fs.existsSync(baseFolder) || !fs.statSync(baseFolder).isDirectory()) {
    throw new Error(`Folder bazowy nie istnieje: ${baseFolder}`);
  }
  const results = [];
  function walk(currentPath, relPath, depth) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true }).filter(e => e.isDirectory());
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      const rel = relPath ? path.join(relPath, entry.name) : entry.name;
      const full = path.join(currentPath, entry.name);
      const isAddressLike = ADDRESS_FOLDER_PATTERN.test(entry.name.trim()) && !looksLikeAddressContainer(full);
      if (isAddressLike) {
        results.push(rel);
      } else if (depth < CATEGORY_SEARCH_MAX_DEPTH) {
        walk(full, rel, depth + 1);
      }
    }
  }
  walk(baseFolder, "", 0);
  return results.sort((a, b) => a.localeCompare(b, "pl", { numeric: true, sensitivity: "base" }));
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
//
// Audyt na zywo 2026-08-14: przy niedoswietlonym zdjeciu (slabe oswietlenie w
// terenie) sam contrast(0.35) na juz-ciemnych pikselach pcha je jeszcze
// bardziej w czern zamiast rozjasnic - stad skargi na "cale czarne, mało
// wyrazne" wydruki. Rozciagniecie histogramu (patrz applyPercentileLevels
// nizej) do pelnego zakresu 0-255 na podstawie faktycznej jasnosci kadru NIE
// ma tej samej wady co brightness() w tej wersji i naprawia zarowno
// niedoswietlone, jak i normalnie doswietlone zdjecia bez recznego strojenia -
// wywolane PRZED greyscale/contrast, wiec dziala na oryginalnych kolorach.
// (Pierwotnie byl to wbudowany img.normalize() - zastapiony 2026-08-17
// wariantem percentylowym, patrz audyt przy applyPercentileLevels: surowy
// normalize() lapal sie na blasku/odbiciu flesza jako falszywym punkcie
// bieli.)
const CONTRAST = Number(process.env.PROTOKOLY_CONTRAST || 0.35);
// Prawdziwy protokol na A4 jest zawsze w pionie - jesli po przycieciu do
// samej kartki wynik jest WYRAZNIE szerszy niz wyzszy, kartka lezala bokiem
// wzgledem aparatu (fizyczny obrot kartki na stole, nie telefonu - to drugie
// juz koryguje EXIF przy dekodowaniu). Nie da sie stad wywnioskowac W KTORA
// strone obrocic (mogla lezec bokiem w dowolnym z dwoch kierunkow) - zgadujemy
// w prawo (90), a reczny przycisk "obroc" w podgladzie UI pozwala doprecyzowac
// jesli zgadlismy zla strone albo trafil sie przypadek "do gory nogami" (180,
// ktorego proporcje boku nie zdradzaja - to jedyny niezawodny sposob bez OCR,
// ten sam kompromis co swiadoma decyzja o braku auto-rotacji w ocr-audytow).
const SIDEWAYS_ASPECT_RATIO = Number(process.env.PROTOKOLY_SIDEWAYS_ASPECT_RATIO || 1.15);
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

// Audyt na zywo 2026-08-14 (realny plik: "47.Ul. Poludniowa 30, Bielawy" -
// zdjecie robione telefonem rzuca WYRAZNY cien wlasnej reki/aparatu w
// poprzek kartki): normalize() rozciaga histogram GLOBALNIE, wiec nie
// naprawia CIENIA (lokalnego przyciemnienia jednej czesci kartki) - dla
// normalize() cien i tak jest po prostu "najciemniejszym punktem kadru", a
// reszta kartki i tak juz jest jasna, wiec globalne rozciagniecie niewiele
// zmienia w cieniu samym. Cien przy druku czarno-bialym wychodzi jako gruba
// czarna plama, marnujac tusz i psujac czytelnosc.
//
// Poprawka: wyrownanie lokalnego oswietlenia (flat-fielding) - szacujemy MAPE
// TLA kartki przez agresywne pomniejszenie obrazu (do SHADING_BG_WIDTH px) i
// ponowne powiekszenie z powrotem (dziala jak bardzo duzy blur/low-pass -
// tanszy obliczeniowo niz prawdziwy gaussian blur o porownywalnym promieniu).
// Kazdy piksel dzielimy przez odpowiadajaca mu wartosc tej mapy tla i
// skalujemy do sredniej jasnosci calego tla - miejsca w cieniu (nizsza
// wartosc mapy tla) dostaja WIEKSZE wzmocnienie niz miejsca juz jasne,
// wyrownujac oswietlenie na calej kartce. Realny tekst/checkboxy (ciemne
// kreski na jasnym tle) zostaja WZGLEDEM lokalnego tla ciemne niezaleznie od
// tego, w cieniu czy nie, wiec czytelnosc tresci nie cierpi - zweryfikowane
// wizualnie na dwoch prawdziwych zdjeciach z cieniem (jedno z gestym szkicem
// odrecznym), SHADING_BG_WIDTH=12 usuwalo cien niemal calkowicie bez
// zauwazalnej utraty tekstu; wieksze wartosci (25, 50) zostawialy widoczny
// cien. Zbyt MALA wartosc (blur zbyt waski wzgledem realnych blokow gestego
// tekstu) grozi odwrotnym efektem - tekst zlapany jako "czesc tla" i
// wybielony - stad SHADING_BG_WIDTH pozostaje jawnie skonfigurowalny.
const SHADING_BG_WIDTH = Number(process.env.PROTOKOLY_SHADING_BG_WIDTH || 12);

// Audyt na zywo 2026-08-17 (dalszy ciag skargi "czarne wydruki" po
// applyShadingCorrection): telefon robiacy zdjecie protokolu w slabo
// oswietlonym pomieszczeniu czesto uzywa lampy blyskowej, ktora daje ostry,
// niewielki BLASK/odbicie na kartce (np. na laminowanej oklejce czy zaginajacym
// sie rogu). img.normalize() rozciaga histogram na podstawie SUROWEGO min/max
// calego kadru - ten pojedynczy jasny punkt staje sie punktem bieli dla calej
// reszty strony, wiec normalize() nie ma juz zapasu, zeby podniesc realnie
// ciemna wiekszosc kartki. Zweryfikowane empirycznie na syntetycznym obrazie:
// ta sama niedoswietlona kartka (bez blasku) konczyla pipeline ze srednia
// jasnoscia ~235/255 (dobrze), ale Z blaskiem od flesza spadala do ~107/255 -
// dokladnie ten "czarny/ciemny wydruk", na ktory skarzy sie uzytkownik.
// Naprawa: rozciaganie oparte na PERCENTYLACH histogramu zamiast surowego
// min/max (ten sam pomysl co "Levels" w edytorach zdjec) - punkty czerni/bieli
// sa tam, gdzie faktycznie lezy wiekszosc tresci kartki, wiec kilka procent
// odstajacych pikseli (blask, ale tez odwrotnie: ciemny cien w samym rogu) nie
// psuje rozciagniecia dla reszty. Ten sam test na tych samych syntetycznych
// obrazach z blaskiem: wynik ~233-235/255 niezaleznie od tego, czy blask byl
// duzy czy maly - PROTOKOLY_LEVELS_LOW_PCT/HIGH_PCT pozostaja konfigurowalne
// na wypadek innego realnego przypadku, tak jak SHADING_BG_WIDTH wyzej.
const LEVELS_LOW_PCT = Number(process.env.PROTOKOLY_LEVELS_LOW_PCT || 2);
const LEVELS_HIGH_PCT = Number(process.env.PROTOKOLY_LEVELS_HIGH_PCT || 98);

function applyPercentileLevels(img, lowPct = LEVELS_LOW_PCT, highPct = LEVELS_HIGH_PCT) {
  const { width, height } = img.bitmap;
  const hist = new Array(256).fill(0);
  let total = 0;
  img.scan(0, 0, width, height, function (x, y, idx) {
    const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
    hist[Math.round(0.299 * r + 0.587 * g + 0.114 * b)] += 1;
    total += 1;
  });
  const lowCount = total * (lowPct / 100);
  const highCount = total * (highPct / 100);
  let cum = 0, black = 0, white = 255;
  for (let v = 0; v < 256; v += 1) { cum += hist[v]; if (cum > lowCount) { black = v; break; } }
  cum = 0;
  for (let v = 255; v >= 0; v -= 1) { cum += hist[v]; if (cum > total - highCount) { white = v; break; } }
  if (white <= black) white = black + 1;
  const range = white - black;
  img.scan(0, 0, width, height, function (x, y, idx) {
    for (let c = 0; c < 3; c += 1) {
      const v = ((this.bitmap.data[idx + c] - black) / range) * 255;
      this.bitmap.data[idx + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  });
  return img;
}

// Audyt na zywo 2026-08-17 (realny plik "17.Wieruszew 3", zdjecie protokolu
// trzymanego na desce z klipsem na tle sciany z czerwonej cegly): przycinanie
// do bounding-boxa (findPageBoundingBox) jest prostokatem, a kartka na zdjeciu
// prawie zawsze lezy pod lekkim katem wzgledem aparatu - w rogach/na krawedzi
// prostokata zostaje wiec kawalek prawdziwego tla (cegla, sciana), ktore po
// konwersji na czarno-bialy drukuje sie jako spory, ciemny/teksturowany
// obszar i marnuje tusz. Zmierzone na tym realnym zdjeciu: czysta cegla ma
// jasnosc ~74/255, czysta kartka (nawet w cieniu) ~163/255 - wystarczajaco
// duza roznica, zeby to odroznic od tresci kartki.
//
// Detekcja: "zalewanie" (flood fill) od brzegu kadru przez piksele
// CIEMNIEJSZE niz darkThreshold - wszystko, co da sie osiagnac z brzegu
// obrazu bez przejscia przez jasna kartke, jest tlem. Realny tekst/checkboxy
// na kartce (ciemne kreski/X-y) NIE sa zagrozone - sa odizolowanymi ciemnymi
// wyspami otoczonymi jasna kartka, wiec zalewanie od brzegu nigdy do nich nie
// dotrze, o ile sama kartka nie dotyka brzegu kadru (CROP_PADDING wyzej
// celowo zostawia waski pasek tla dookola kartki na wypadek tej metody).
// Zweryfikowane na zywo: threshold=110 usuwa cegle w 100% bez naruszenia
// jednej litery/checkboxa na kartce.
//
// Audyt na zywo 2026-08-17 (drugie realne zdjecie z tej samej paczki,
// "53.link.124303.jpg"): metalowy klips na gorze i postrzepiona krawedz stosu
// luznych kartek pod spodem tworza mnostwo WASKICH, odizolowanych kieszeni tla
// (kilka pikseli szerokosci) - sam flood fill od brzegu NIE dociera do nich,
// bo po drodze przebiega przez piksele odrobine jasniejsze niz threshold
// (rozmycie przy skalowaniu/JPEG). Naprawa: po flood-fillu domykamy male
// przerwy prostym wielokrotnym rozrostem maski (dylatacja) - kilkanascie
// przebiegow domyka wszystkie takie przerwy.
//
// Audyt na zywo 2026-08-17 (proba #1, ZANIECHANA - opis dla przyszlych zmian):
// pierwsza wersja tej poprawki TWARDO wybielala wykryte tlo na 255 juz PRZED
// applyShadingCorrection. To dzialalo na pojedynczych przykladach, ale
// wprowadzalo OSTRA krawedz (realna tresc <-> sztuczna biel) tam, gdzie
// wczesniej byl plynny gradient - a applyShadingCorrection estymuje lokalne
// tlo przez mocno agresywny blur (resize w dol do SHADING_BG_WIDTH=12 i z
// powrotem), ktory na takiej ostrej krawedzi wpada w "dzwonienie" (ringing) i
// psuje jasnosc calego zdjecia (zweryfikowane empirycznie na syntetycznym
// obrazie - luznie przycieta kartka konczyla z widoczna winieta zamiast
// rownej bieli, srednia jasnosc spadala ze ~230 do ~161).
//
// Naprawa #2 (aktualna): zamiast TWARDO wybielac tlo przed korekta,
// "rozciagamy" na nie NAJBLIZSZY piksel prawdziwej kartki (inpaintBackgroundFromEdges,
// wielozrodlowy BFS) - kazdy piksel tla dostaje kolor najblizszego piksela
// kartki, wiec nie ma juz ZADNEJ sztucznej ostrej krawedzi dla nastepujacego
// po tym blura. Prawdziwe (twarde, biale) wybielenie tla robimy dopiero NA
// SAMYM KONCU (po greyscale+contrast), gdy juz nic wiecej nie bluruje wynik.
//
// Audyt na zywo 2026-08-17 (trzecie realne zdjecie, "54.link.124310.jpg",
// dwa osobne problemy):
// 1) Czesc tla bywa jasniejsza niz MASK_DARK_THRESHOLD (np. ~120-160) - nie
//    zostaje wykryta w pierwszym przebiegu (na surowych kolorach), a mimo to
//    applyPercentileLevels+contrast i tak spychaja ja w czern (bo to nadal
//    duzo ciemniejsze od bialej kartki) - lity czarny klin w rogu zdjecia.
//    Naprawa: DRUGI przebieg detekcji na samym koncu (po contrast), gdzie
//    prawdziwe tlo kartki jest juz blisko bieli (>180), wiec nizszy prog (90)
//    bezpiecznie lapie WSZYSTKO nadal wyraznie ciemne, niezaleznie od przyczyny.
// 2) Ten drugi (koncowy) przebieg detekcji, puszczony BEZ ograniczen,
//    potrafil "przeciekac" wzdluz waskiego, przypadkowego kanalu ciemnych
//    pikseli (np. wzdluz postrzepionego rozdarcia papieru blisko gory kadru)
//    daleko w glab kartki i wybielic fragment prawdziwego tytulu strony.
//    Naprawa: koncowy przebieg dostaje allowedRegion (pierwotna maska
//    tla, mocno zdylatowana o MASK_SEARCH_MARGIN_PX) i moze wykrywac tlo
//    WYLACZNIE w tym obszarze - wystarczajaco duzo, zeby zlapac defekt TUZ
//    PRZY oryginalnym tle (jak ten rog), ale flood fill fizycznie nie moze
//    juz tunelowac daleko w glab kartki przez przypadkowy kanal.
// Zweryfikowane na zywo na wszystkich trzech zdjeciach z tej paczki (cegla,
// klips+rozdarcie, klin w rogu) jednoczesnie, bez utraty jakiejkolwiek tresci.
const MASK_DARK_THRESHOLD = Number(process.env.PROTOKOLY_MASK_DARK_THRESHOLD || 110);
const MASK_GAP_CLOSE_PASSES = Number(process.env.PROTOKOLY_MASK_GAP_CLOSE_PASSES || 12);
const FINAL_MASK_DARK_THRESHOLD = Number(process.env.PROTOKOLY_FINAL_MASK_DARK_THRESHOLD || 90);
const MASK_SEARCH_MARGIN_PX = Number(process.env.PROTOKOLY_MASK_SEARCH_MARGIN_PX || 100);

// Wykrywa tlo: flood fill od brzegu kadru przez piksele ciemniejsze niz
// darkThreshold, potem domyka male przerwy (gapClosePasses przebiegow
// dylatacji). Jesli podano allowedRegion (Uint8Array tej samej dlugosci co
// liczba pikseli), zarowno flood fill, jak i sam test "czy piksel jest
// ciemny" dzialaja WYLACZNIE wewnatrz tego obszaru - piksele poza nim nigdy
// nie zostana uznane za tlo, niezaleznie od jasnosci.
function detectBackgroundMask(img, darkThreshold, gapClosePasses, allowedRegion = null) {
  const { width, height, data } = img.bitmap;
  const total = width * height;
  const isDark = new Uint8Array(total);
  for (let p = 0; p < total; p += 1) {
    if (allowedRegion && !allowedRegion[p]) continue;
    const idx = p * 4;
    const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    isDark[p] = lum < darkThreshold ? 1 : 0;
  }
  let mask = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0, qTail = 0;
  function tryPush(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const p = y * width + x;
    if (mask[p] || !isDark[p]) return;
    mask[p] = 1;
    queue[qTail] = p;
    qTail += 1;
  }
  for (let x = 0; x < width; x += 1) { tryPush(x, 0); tryPush(x, height - 1); }
  for (let y = 0; y < height; y += 1) { tryPush(0, y); tryPush(width - 1, y); }
  while (qHead < qTail) {
    const p = queue[qHead];
    qHead += 1;
    const x = p % width, y = (p / width) | 0;
    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }
  return dilateMask(mask, width, height, gapClosePasses);
}

// Rozrasta (dylatuje) binarna maske o `passes` pikseli - kazdy piksel
// stykajacy sie z juz-maska w danym przebiegu sam staje sie maska. Uzywana
// zarowno do domykania waskich przerw po flood-fillu, jak i do wyliczenia
// "dozwolonego obszaru poszukiwan" dla koncowego przebiegu detekcji.
function dilateMask(mask, width, height, passes) {
  let m = mask;
  for (let iter = 0; iter < passes; iter += 1) {
    const next = new Uint8Array(m);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        if (m[p]) continue;
        const touchesBg = (x > 0 && m[p - 1]) || (x < width - 1 && m[p + 1]) ||
          (y > 0 && m[p - width]) || (y < height - 1 && m[p + width]);
        if (touchesBg) next[p] = 1;
      }
    }
    m = next;
  }
  return m;
}

// Wielozrodlowy BFS: kazdy piksel tla (mask=1) dostaje kolor NAJBLIZSZEGO
// piksela prawdziwej kartki (mask=0) - "rozciaga" krawedz kartki na tlo bez
// wprowadzania zadnej sztucznej, ostrej granicy (patrz audyt wyzej -
// applyShadingCorrection nie znosi ostrych krawedzi w danych wejsciowych).
function inpaintBackgroundFromEdges(img, mask) {
  const { width, height, data } = img.bitmap;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0, qTail = 0;
  for (let p = 0; p < total; p += 1) { if (!mask[p]) visited[p] = 1; }
  function propagate(fromP, x, y) {
    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const np = ny * width + nx;
      if (!mask[np] || visited[np]) continue;
      visited[np] = 1;
      const idx = np * 4, srcIdx = fromP * 4;
      data[idx] = data[srcIdx]; data[idx + 1] = data[srcIdx + 1]; data[idx + 2] = data[srcIdx + 2];
      queue[qTail] = np;
      qTail += 1;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (mask[p]) continue;
      propagate(p, x, y);
    }
  }
  while (qHead < qTail) {
    const p = queue[qHead];
    qHead += 1;
    propagate(p, p % width, (p / width) | 0);
  }
  return img;
}

function whitenMask(img, mask) {
  const { data } = img.bitmap;
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const idx = p * 4;
    data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255;
  }
  return img;
}

function applyShadingCorrection(img) {
  const { width, height } = img.bitmap;
  const bg = img.clone().resize({ w: SHADING_BG_WIDTH }).resize({ w: width, h: height });
  let sum = 0, count = 0;
  bg.scan(0, 0, width, height, function (x, y, idx) { sum += this.bitmap.data[idx]; count += 1; });
  const targetMean = sum / count;
  img.scan(0, 0, width, height, function (x, y, idx) {
    const bgVal = Math.max(1, bg.bitmap.data[idx]);
    for (let c = 0; c < 3; c += 1) {
      const corrected = (this.bitmap.data[idx + c] / bgVal) * targetMean;
      this.bitmap.data[idx + c] = Math.max(0, Math.min(255, Math.round(corrected)));
    }
  });
  return img;
}

// Przetwarza jedno zdjecie protokolu: przycina do samej kartki, prostuje,
// rozjasnia i konwertuje na czarno-bialy z podbitym kontrastem. Korekta
// orientacji EXIF (zdjecia robione "na boku" telefonem) jest stosowana
// automatycznie przez dekoder Jimp/jpeg - nie trzeba jej robic recznie
// (zweryfikowane na realnym zdjeciu z Orientation=8). manualRotateDeg (0/90/
// 180/270) to DODATKOWY obrot na zyczenie uzytkownika z UI podgladu, stosowany
// PO automatycznym prostowaniu - pozwala poprawic zgadniete-w-zla-strone
// "bokiem" albo doprecyzowac "do gory nogami", ktorego auto-wykrycie nie
// odroznia od normalnej orientacji (proporcje strony sie nie zmieniaja).
async function processPhoto(photoPath, { manualRotateDeg = 0 } = {}) {
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
  if (img.bitmap.width > img.bitmap.height * SIDEWAYS_ASPECT_RATIO) {
    img.rotate(90);
  }
  if (manualRotateDeg % 360 !== 0) img.rotate(manualRotateDeg);
  if (img.bitmap.width > MAX_OUTPUT_WIDTH) img.resize({ w: MAX_OUTPUT_WIDTH });

  const originalMask = detectBackgroundMask(img, MASK_DARK_THRESHOLD, MASK_GAP_CLOSE_PASSES);
  inpaintBackgroundFromEdges(img, originalMask);
  applyShadingCorrection(img);
  applyPercentileLevels(img);
  img.greyscale();
  img.contrast(CONTRAST);

  const searchRegion = dilateMask(originalMask, img.bitmap.width, img.bitmap.height, MASK_SEARCH_MARGIN_PX);
  const finalMask = detectBackgroundMask(img, FINAL_MASK_DARK_THRESHOLD, MASK_GAP_CLOSE_PASSES, searchRegion);
  whitenMask(img, finalMask);
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

// rotations: obiekt { [indeks_zdjecia]: stopnie(0/90/180/270) } - reczne
// poprawki obrotu z podgladu UI dla pojedynczych zdjec, ktorych auto-
// prostowanie nie zgadlo (patrz processPhoto).
//
// Audyt na zywo 2026-08-14 (JOZWIN 15A, zdjecie 426.link.085515.jpg):
// strukturalnie poprawny JPEG (prawidlowe SOI/EOI, normalny naglowek JFIF/
// Exif) potrafi mimo to wywrocic czysto-JS dekoder Jimpa ("unexpected
// marker: ffd9") - zapewne telefon zakodowal go w wariancie, ktorego ten
// minimalny dekoder nie obsluguje w pelni, mimo ze prawdziwa przegladarka
// otwiera go bez problemu. Przed ta poprawka JEDNO takie zdjecie wywalalo
// CALY PDF calego adresu (i podglad, i zapis) - uzytkownik widzial blad, a
// potem "wywalone" okno podgladu (bo iframe probowal wyswietlic strone bledu
// serwera, co samo w sobie lamalo CSP frame-ancestors). Zamiast tego
// pojedyncze nieudane zdjecie jest teraz POMIJANE (nie przerywa reszty) - PDF
// powstaje z pozostalych stron, a wywolujacy dostaje liste pominietych plikow
// (nieenumerowalna wlasciwosc na zwroconym Bufferze, ten sam wzorzec co
// "warnings" w scanFilesRecursive) do pokazania uzytkownikowi.
//
// Audyt na zywo 2026-08-14: to samo zdjecie (426.link.085515.jpg) 5/5 razy
// pod rzad przetworzylo sie PRAWIDLOWO w kolejnym teście, mimo ze chwile
// wczesniej rzucalo "unexpected marker: ffd9" - blad jest wiec PRZEJSCIOWY
// (albo rzadka scieżka w rownoleglym dekodowaniu JPEG-a przez pure-JS
// dekoder Jimpa, albo chwilowa awaria odczytu z dysku sieciowego, ten sam
// wzorzec co retry w folderMatch.js#readDirWithRetry), nie trwale uszkodzony
// plik. Ponawiamy wiec przetwarzanie pojedynczego zdjecia PARE razy przed
// ostatecznym uznaniem go za nieczytelne - w wiekszosci przypadkow to
// wystarczy, zeby w ogole nie trzeba bylo niczego pomijac.
const PHOTO_RETRY_ATTEMPTS = Number(process.env.PROTOKOLY_PHOTO_RETRY_ATTEMPTS || 2);
const PHOTO_RETRY_DELAY_MS = Number(process.env.PROTOKOLY_PHOTO_RETRY_DELAY_MS || 300);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function buildProtocolPdf(photoPaths, rotations = {}) {
  const jpegBuffers = new Array(photoPaths.length);
  const failures = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < photoPaths.length) {
      const idx = nextIndex++;
      const manualRotateDeg = Number(rotations[idx]) || 0;
      let lastErr;
      let done = false;
      for (let attempt = 1; attempt <= 1 + PHOTO_RETRY_ATTEMPTS && !done; attempt += 1) {
        try {
          const img = await processPhoto(photoPaths[idx], { manualRotateDeg });
          jpegBuffers[idx] = await img.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });
          done = true;
        } catch (err) {
          lastErr = err;
          if (attempt <= PHOTO_RETRY_ATTEMPTS) await sleep(PHOTO_RETRY_DELAY_MS);
        }
      }
      if (!done) {
        failures.push({ index: idx, path: photoPaths[idx], message: lastErr?.message || String(lastErr) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROCESS_CONCURRENCY, photoPaths.length) }, worker));

  const usableBuffers = jpegBuffers.filter(Boolean);
  if (!usableBuffers.length) {
    throw new Error("Zadnego zdjecia nie udalo sie przetworzyc (wszystkie sa nieczytelne albo uszkodzone).");
  }

  const pdfDoc = await PDFDocument.create();
  for (const jpegBuffer of usableBuffers) {
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
  const pdfBytes = Buffer.from(await pdfDoc.save());
  if (failures.length) {
    Object.defineProperty(pdfBytes, 'photoFailures', { value: failures, enumerable: false });
  }
  return pdfBytes;
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
  applyPercentileLevels,
  detectBackgroundMask,
  dilateMask,
  inpaintBackgroundFromEdges,
  whitenMask,
  processPhoto,
  buildProtocolPdf,
  outputFileName,
  targetSaveDir
};
