// Biblioteka "znanych wzorow" (per gmina/inwestycja) - patrz plan
// C:\Users\Piotr.Cyniak\.claude\plans\partitioned-exploring-pebble.md. Realny check na
// prawdziwych plikach (2026-07-23) pokazal, ze uklad strony jest piksel w piksel identyczny
// miedzy roznymi adresami TEJ SAMEJ gminy (skany biurowe, nie zdjecia telefonem), ale RoZNE
// gminy uzywaja realnie roznych fizycznych wzorow (inna liczba kolumn/punktow) nawet w tej
// samej kategorii (Pompa ciepla). Wlasciciel potwierdzil, ze nikt nie miesza dwoch gmin w
// jednej paczce - wiec rozpoznanie "to jest wzor X" po naglowku strony (bez dopasowywania
// obrazu) + wyciecie z GORY znanych miejsc pod pola jest bezpieczne.
//
// Regiony przechowywane jako uamki (0-1) szerokosci/wysokosci strony - odporne na inna
// rozdzielczosc skanu (DPI). Kalibracja NIE jest reczna - to harvesting bboxow z juz
// zrecenzowanego przez czlowieka przebiegu (patrz buildTemplateFromReview).
//
// Ekstrakcja przez wzor NIE woloa ponownie zadnego silnika OCR (2026-07-24, przepisane -
// poprzednia wersja wycinala kazde pole/grupe jako osobny obrazek i odpalala na nim SWIEZE
// zapytanie Document AI/Vision, mimo ze CALA strona byla juz raz rozpoznana w
// analyzeDocument). To byl realny, zauwazalny koszt czasu - "Wykorzystuje sprawdzony adres
// jako wzor..." (recalibrate-remaining, server.js) potrafilo isc SEKWENCYJNIE przez 10+
// prawdziwych zapytan sieciowych PER BLOK. Zamiast tego sliceMiniPage nizej po prostu
// FILTRUJE juz-gotowe formFields/tabele/checkboxy calej strony do tych, ktorych srodek
// wypada w znanym (skalibrowanym) regionie - ekstrakcja z wzoru to juz tylko lokalne,
// natychmiastowe obliczenie na danych, ktore i tak juz mamy w pamieci.
const fs = require('fs').promises;
const path = require('path');
const { computeFieldCropRect } = require('./ocrPipeline');
const { FIELD_DEFS, extractField, toFieldResult } = require('./fieldExtraction');

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

function flattenText(text) {
  return String(text || '').replace(/\s+/g, ' ').toUpperCase();
}

function slugify(label) {
  return String(label || 'wzor')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wzor';
}

function fractionRectToPixels(region, pageWidth, pageHeight) {
  const minX = Math.round(region.xFrac * pageWidth);
  const minY = Math.round(region.yFrac * pageHeight);
  const maxX = Math.round((region.xFrac + region.wFrac) * pageWidth);
  const maxY = Math.round((region.yFrac + region.hFrac) * pageHeight);
  return { minX, minY, maxX, maxY };
}

function pixelRectToFraction(rect, pageWidth, pageHeight) {
  return {
    xFrac: rect.minX / pageWidth,
    yFrac: rect.minY / pageHeight,
    wFrac: (rect.maxX - rect.minX) / pageWidth,
    hFrac: (rect.maxY - rect.minY) / pageHeight
  };
}

// Srodek wielokata bbox (lista {x,y}, konwencja Document AI - patrz toPixelVertices
// w documentAiEngine.js) - uzywany zamiast pelnej geometrii przeciecia, bo regiony wzoru
// juz maja spory margines (GROUP_PAD nizej) i pojedyncze pole zwykle lezy solidnie w
// srodku swojego regionu, nie na samej granicy.
function bboxCenter(bbox) {
  if (!bbox || !bbox.length) return null;
  const cx = bbox.reduce((s, v) => s + v.x, 0) / bbox.length;
  const cy = bbox.reduce((s, v) => s + v.y, 0) / bbox.length;
  return { x: cx, y: cy };
}

function centerInRect(bbox, rect) {
  const c = bboxCenter(bbox);
  if (!c) return false;
  return c.x >= rect.minX && c.x <= rect.maxX && c.y >= rect.minY && c.y <= rect.maxY;
}

// "Wycina" z JUZ rozpoznanej calej strony tylko te formFields/wiersze tabel/checkboxy,
// ktorych srodek wypada w podanym regionie - bez zadnego nowego wywolania OCR. `ocrText`
// zostaje NIEPRZEFILTROWANY (caly tekst strony) celowo - existsInPageText w
// fieldExtraction.js uzywa go jako szerszego sygnalu "czy ta etykieta w ogole gdzies
// wystepuje", niezaleznie od tego czy trafila w TEN konkretny region.
function sliceMiniPage(page, rect) {
  const formFields = (page.formFields || []).filter((ff) => centerInRect(ff.valueBBox, rect) || centerInRect(ff.fieldNameBBox, rect));
  const tables = (page.tables || [])
    .map((t) => ({ rows: (t.rows || []).filter((r) => centerInRect(r.bbox, rect)) }))
    .filter((t) => t.rows.length);
  const visualElements = (page.visualElements || []).filter((el) => centerInRect(el.bbox, rect));
  return { pageIndex: page.pageIndex, ocrText: page.ocrText, formFields, tables, visualElements };
}

// --- Wczytywanie i dopasowywanie wzorow ---

async function loadTemplates() {
  let files;
  try {
    files = await fs.readdir(TEMPLATES_DIR);
  } catch (_) {
    return [];
  }
  const templates = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(TEMPLATES_DIR, file), 'utf8');
      templates.push(JSON.parse(raw));
    } catch (err) {
      console.warn(`[templateEngine] pominieto uszkodzony wzor ${file}: ${err.message}`);
    }
  }
  return templates;
}

function matchTemplate(pages, block, templates) {
  for (const tpl of templates) {
    const pageIdx = block.startPage + (tpl.headerPageIndexInBlock || 0);
    const page = pages[pageIdx];
    if (!page) continue;
    let re;
    try { re = new RegExp(tpl.headerPattern, 'i'); } catch (_) { continue; }
    if (re.test(flattenText(page.ocrText))) return tpl;
  }
  return null;
}

// --- Ekstrakcja przez wzor ---

function extractFieldsFromTemplate(pages, block, template, { allowedKeys = null } = {}) {
  const results = {};

  for (const entry of template.textFields || []) {
    if (allowedKeys && !allowedKeys.has(entry.key)) continue;
    const pageIndexAbs = block.startPage + entry.pageIndexInBlock;
    const page = pages[pageIndexAbs];
    const def = FIELD_DEFS.find((f) => f.key === entry.key);
    if (!page || !def) continue;
    const rect = fractionRectToPixels(entry.region, page.width, page.height);
    const miniPage = sliceMiniPage(page, rect);
    const extracted = extractField(miniPage, def);
    const field = toFieldResult(extracted, page.pageIndex, def.valueKind);
    // Realny blad zlapany 2026-07-24 (na zywej sesji wlasciciela): dla pol RECZNIE
    // zaznaczonych (patrz harvestTemplateFields - manual:true), extractTextField czesto
    // trafia w falszywie-pozytywna sciezke "etykieta gdzies na stronie istnieje" (np.
    // "Telefon:" - statyczny naglowek formularza, wystepuje na KAZDYM adresie) i zwraca
    // found:true ale BEZ zadnego bboxa. Bez fallbacku ponizej takie pole traci podglad
    // CALKOWICIE na kazdym kolejnym adresie, mimo ze mamy dokladnie ten sam wycinek strony,
    // ktory uzytkownik juz raz sam zaznaczyl - dokladnie ten objaw, ktory wlasciciel zglosil
    // ("dalej trzeba zaznaczac podglady"). Ten sam fallback juz istnieje ponizej dla
    // groupFields - text/manual entries potrzebuja go tak samo.
    if (!field.labelBBox && !field.valueBBox) field.valueBBox = rect;
    field.fromTemplate = true;
    results[entry.key] = field;
  }

  for (const group of template.groupFields || []) {
    const keys = allowedKeys ? group.keys.filter((k) => allowedKeys.has(k)) : group.keys;
    if (!keys.length) continue;
    const pageIndexAbs = block.startPage + group.pageIndexInBlock;
    const page = pages[pageIndexAbs];
    if (!page) continue;
    const rect = fractionRectToPixels(group.region, page.width, page.height);
    const miniPage = sliceMiniPage(page, rect);
    for (const key of keys) {
      const def = FIELD_DEFS.find((f) => f.key === key);
      if (!def) continue;
      const extracted = extractField(miniPage, def);
      const result = toFieldResult(extracted, page.pageIndex, def.valueKind);
      // Jesli dopasowanie w obrebie regionu nie znalazlo nic konkretnego dla TEGO klucza,
      // nie ma wlasnego bboxa do podgladu - pokaz przynajmniej caly obszar regionu grupy
      // (rect, juz w bezwzglednych wspolrzednych strony), zamiast "nie udalo sie
      // zlokalizowac" mimo ze wiadomo dokladnie, gdzie na stronie szukac.
      if (!result.labelBBox && !result.valueBBox) result.valueBBox = rect;
      result.fromTemplate = true;
      results[key] = result;
    }
  }

  return results;
}

// --- Kalibracja: budowa wzoru z juz zrecenzowanego przebiegu ---

function unionAllBBoxes(boxes) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return null;
  return {
    minX: Math.min(...valid.map((b) => b.minX)),
    minY: Math.min(...valid.map((b) => b.minY)),
    maxX: Math.max(...valid.map((b) => b.maxX)),
    maxY: Math.max(...valid.map((b) => b.maxY))
  };
}

const GROUP_PAD = 130;

// Maksymalna wysokosc (jako uamek wysokosci strony) jednego wspolnego wycinka
// grupy checkboxow/materialow. Realny problem zlapany 2026-07-23: gdy WSZYSTKIE
// pola nie-tekstowe danej strony ladowaly do JEDNEJ grupy niezaleznie od tego
// jak bardzo sa rozrzucone po stronie, powstawal wycinek obejmujacy 67%
// wysokosci strony (9 pol rozsianych od gory nieomal do polowy strony) -
// wlasciciel: "na podgladach czasami nawet po pol strony pokazuje i jak ja mam
// wierzyc ze uzytkownik znajdzie to". Klastrowanie po pozycji Y (zamiast
// "wszystko na tej stronie w jednym worku") dzieli taka grupe na kilka
// mniejszych, kazda wciaz jednym wywolaniem Document AI, ale zdecydowanie
// bardziej skupiona/czytelna dla czlowieka.
const MAX_GROUP_HEIGHT_FRAC = 0.3;

// Zachlanne klastrowanie: sortuje pozycje po Y, dodaje kolejna do biezacego
// klastra dopoki laczna wysokosc (po zsumowaniu z nowa pozycja) miesci sie w
// MAX_GROUP_HEIGHT_FRAC wysokosci strony - inaczej zamyka klaster i zaczyna
// nowy. Kazdy pojedynczy element ZAWSZE trafia do jakiegos klastra (nawet
// jesli SAM przekracza limit wysokosci - np. jedno bardzo wysokie pole) -
// limit dotyczy tylko DOKLADANIA kolejnych pol do juz istniejacego klastra.
function clusterByProximity(items, pageHeight) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.box.minY - b.box.minY);
  const maxHeightPx = MAX_GROUP_HEIGHT_FRAC * pageHeight;
  const clusters = [];
  let current = [sorted[0]];
  let currentUnion = sorted[0].box;
  for (let i = 1; i < sorted.length; i++) {
    const candidateUnion = unionAllBBoxes([currentUnion, sorted[i].box]);
    if (candidateUnion.maxY - candidateUnion.minY <= maxHeightPx) {
      current.push(sorted[i]);
      currentUnion = candidateUnion;
    } else {
      clusters.push(current);
      current = [sorted[i]];
      currentUnion = sorted[i].box;
    }
  }
  clusters.push(current);
  return clusters;
}

function harvestTemplateFields({ pages, block, fields }) {
  const textFields = [];
  const byPageItems = new Map(); // pageIndex -> { pageIndexInBlock, items: [{ key, box }] }

  for (const [key, field] of Object.entries(fields || {})) {
    if (!field || field.pageIndex == null) continue;
    const page = pages[field.pageIndex];
    if (!page) continue;
    const def = FIELD_DEFS.find((f) => f.key === key);
    if (!def) continue;
    const pageIndexInBlock = field.pageIndex - block.startPage;

    // Recznie zaznaczone pole (patrz /api/ocr/mark-field-region, server.js) ZAWSZE
    // dostaje WLASNY, pojedynczy region - niezaleznie od def.kind - zamiast byc
    // klastrowane z sasiednimi checkboxami/materialami jak automatycznie znalezione
    // pola tego samego typu. To, co uzytkownik SAM zaznaczyl, jest juz precyzyjne -
    // nie potrzebuje (i nie powinno) byc rozmywane w szerszy, wspolny wycinek grupy.
    // `manual: true` oznacza tez najwyzszy priorytet przy laczeniu z innymi juz
    // zebranymi wzorami tej samej sesji (patrz mergeHarvestedIntoTemplate, server.js).
    if (def.kind === 'text' || field.manuallyMarked) {
      // Reczny prostokat jest juz dokladny (uzytkownik sam go narysowal) - w
      // odroznieniu od automatycznie znalezionego labelBBox/valueBBox (gdzie duzy
      // domyslny padding ma sens, zeby zlapac wartosc rozciagajaca sie daleko w prawo
      // od etykiety), tu wystarczy male marginesy na niedokladnosc zaznaczenia mysza.
      const padOptions = field.manuallyMarked
        ? { pageWidth: page.width, pageHeight: page.height, padXLeft: 20, padXRight: 20, padYTop: 20, padYBottom: 20 }
        : { pageWidth: page.width, pageHeight: page.height };
      const rect = computeFieldCropRect(field.labelBBox, field.valueBBox, padOptions);
      if (!rect) continue;
      textFields.push({ key, pageIndexInBlock, region: pixelRectToFraction(rect, page.width, page.height), manual: Boolean(field.manuallyMarked) });
    } else {
      const box = field.labelBBox && field.valueBBox
        ? { minX: Math.min(field.labelBBox.minX, field.valueBBox.minX), minY: Math.min(field.labelBBox.minY, field.valueBBox.minY), maxX: Math.max(field.labelBBox.maxX, field.valueBBox.maxX), maxY: Math.max(field.labelBBox.maxY, field.valueBBox.maxY) }
        : (field.valueBBox || field.labelBBox);
      if (!box) continue;
      const entry = byPageItems.get(field.pageIndex) || { pageIndexInBlock, items: [] };
      entry.items.push({ key, box });
      byPageItems.set(field.pageIndex, entry);
    }
  }

  const groupFields = [];
  for (const [pageIndex, entry] of byPageItems.entries()) {
    const page = pages[pageIndex];
    if (!page) continue;
    for (const cluster of clusterByProximity(entry.items, page.height)) {
      const union = unionAllBBoxes(cluster.map((c) => c.box));
      if (!union) continue;
      const padded = {
        minX: Math.max(0, union.minX - GROUP_PAD),
        minY: Math.max(0, union.minY - GROUP_PAD),
        maxX: Math.min(page.width, union.maxX + GROUP_PAD),
        maxY: Math.min(page.height, union.maxY + GROUP_PAD)
      };
      groupFields.push({ pageIndexInBlock: entry.pageIndexInBlock, keys: cluster.map((c) => c.key), region: pixelRectToFraction(padded, page.width, page.height) });
    }
  }

  return { textFields, groupFields };
}

// `buildTemplateFromReview` (zapis trwaly, "Zapisz uklad jako wzor") i
// `recalibrate-remaining` w server.js (uzycie jednorazowe/w pamieci, w
// obrebie tej samej wieloadresowej paczki - patrz plan z 2026-07-23:
// "wykorzystaj jeden sprawdzony adres jako wzor dla pozostalych w TYM SAMYM
// pliku") dziela TA SAMA logike harvestowania (harvestTemplateFields powyzej) -
// rozdzielone, zeby to drugie NIE musialo tworzyc pliku w data/templates/ (nie
// ma tam czego nazwac/dopasowywac po naglowku - stosowane wprost, bez
// przechodzenia przez matchTemplate).
async function buildTemplateFromReview({ pages, block, fields, label, headerPattern, headerPageIndexInBlock = 0 }) {
  const { textFields, groupFields } = harvestTemplateFields({ pages, block, fields });

  const id = `${slugify(label)}-${Date.now()}`;
  const template = { id, label, headerPattern, headerPageIndexInBlock, textFields, groupFields };

  await fs.mkdir(TEMPLATES_DIR, { recursive: true });
  await fs.writeFile(path.join(TEMPLATES_DIR, `${id}.json`), JSON.stringify(template, null, 2), 'utf8');
  return template;
}

module.exports = { loadTemplates, matchTemplate, extractFieldsFromTemplate, buildTemplateFromReview, harvestTemplateFields, TEMPLATES_DIR };
