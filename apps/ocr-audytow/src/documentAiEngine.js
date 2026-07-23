// Cienki wrapper na Google Document AI (Form Parser processor) - zastapil
// visionEngine.js (2026-07-22) po realnym tescie na trudnych plikach rodziny
// Kotly/Solary (woj. lodzkie): Document AI rozpoznaje checkbox jako WLASNY
// TYP BYTU i sam go paruje z etykieta (document.pages[].formFields), zamiast
// zwracac losowy znak Unicode do recznego dopasowania geometrycznego jak
// Vision - eliminuje cala klase bledow (przemieszana kolejnosc slow w
// tablicy), ktora zmuszala do kruchych, recznych heurystyk w
// fieldExtraction.js. Koszt: ~20x wyzszy niz Vision ($30 vs $1,50/1000
// stron) - swiadoma decyzja wlasciciela, patrz plan migracji.
//
// W odroznieniu od Vision (prosty klucz API), Document AI wymaga
// uwierzytelnienia przez konto serwisowe (OAuth2) - stad uzycie oficjalnej
// biblioteki klienta (@google-cloud/documentai), nie surowego HTTPS jak w
// visionEngine.js.
//
// Wymaga 4 zmiennych srodowiskowych:
//   OCR_DOCAI_KEY_FILE    - sciezka do pliku JSON konta serwisowego (NIGDY
//                           nie kopiowac tego pliku do repo)
//   OCR_DOCAI_PROJECT_ID  - id projektu GCP (np. "scyzoryk-ocr-test")
//   OCR_DOCAI_LOCATION    - region procesora (np. "eu")
//   OCR_DOCAI_PROCESSOR_ID - id utworzonego procesora typu Form Parser
const fs = require('fs/promises');
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  cachedClient = new DocumentProcessorServiceClient({
    keyFilename: process.env.OCR_DOCAI_KEY_FILE,
    apiEndpoint: `${process.env.OCR_DOCAI_LOCATION}-documentai.googleapis.com`
  });
  return cachedClient;
}

function isConfigured() {
  return Boolean(
    process.env.OCR_DOCAI_KEY_FILE &&
    process.env.OCR_DOCAI_PROJECT_ID &&
    process.env.OCR_DOCAI_LOCATION &&
    process.env.OCR_DOCAI_PROCESSOR_ID
  );
}

// Document AI's textAnchor.content bywa PUSTY nawet gdy textSegments maja
// realne indeksy (zaobserwowane na tokenach - dziala inaczej niz na
// formFields, gdzie .content zazwyczaj jest juz wypelnione) - trzeba wtedy
// samemu wyciac tekst z pelnego `document.text` na podstawie
// startIndex/endIndex (zwracane jako STRINGI, nie liczby, przez klienta).
function resolveTextAnchor(textAnchor, fullText) {
  if (textAnchor?.content) return textAnchor.content;
  const segments = textAnchor?.textSegments || [];
  return segments.map((seg) => fullText.slice(Number(seg.startIndex || 0), Number(seg.endIndex || 0))).join('');
}

// Konwertuje wierzcholki znormalizowane (0-1, wzgledem wymiarow strony) albo
// juz-w-pikselach na ta sama konwencje co Vision's word.vertices - 4 punkty
// w pikselach ORYGINALNEGO (jeszcze nieobroconego) obrazu wejsciowego, zeby
// rotationDetect.js/rotatePoint dzialaly bez zadnych zmian.
function toPixelVertices(boundingPoly, pageWidth, pageHeight) {
  if (boundingPoly?.vertices?.length) {
    return boundingPoly.vertices.map((v) => ({ x: v.x || 0, y: v.y || 0 }));
  }
  if (boundingPoly?.normalizedVertices?.length) {
    return boundingPoly.normalizedVertices.map((v) => ({ x: (v.x || 0) * pageWidth, y: (v.y || 0) * pageHeight }));
  }
  return [];
}

// Rozpoznaje tekst na jednej stronie (obraz JPEG) - zwraca:
//  - text: pelny tekst strony,
//  - words: lista {text, confidence, vertices} w kolejnosci tokenow Document
//    AI, DOKLADNIE w takim samym ksztalcie jak visionEngine.js's ocrImage,
//    zeby rotationDetect.js/bundleSplit.js/buildOcrPdf/buildThumbnails i
//    cala dotychczasowa logika dopasowywania w fieldExtraction.js dzialaly
//    bez zadnych zmian (uzywane jako FALLBACK gdy formFields nie pomoga),
//  - formFields: lista {fieldName, fieldNameBBox, fieldValue, valueConfidence,
//    valueBBox} z document.pages[].formFields - NOWA, ustrukturyzowana
//    para pole-wartosc z gotowym parowaniem checkboxow, konsumowana przez
//    formFieldMatch.js jako preferowana sciezka ekstrakcji.
async function ocrImage(imagePath) {
  if (!isConfigured()) throw new Error('Brak konfiguracji Google Document AI (OCR_DOCAI_KEY_FILE/OCR_DOCAI_PROJECT_ID/OCR_DOCAI_LOCATION/OCR_DOCAI_PROCESSOR_ID).');
  const client = getClient();
  const name = `projects/${process.env.OCR_DOCAI_PROJECT_ID}/locations/${process.env.OCR_DOCAI_LOCATION}/processors/${process.env.OCR_DOCAI_PROCESSOR_ID}`;
  const content = (await fs.readFile(imagePath)).toString('base64');

  const [result] = await client.processDocument({
    name,
    rawDocument: { content, mimeType: 'image/jpeg' }
  });
  const document = result.document;
  const fullText = document.text || '';
  const page = document.pages?.[0];
  const pageWidth = page?.dimension?.width || 0;
  const pageHeight = page?.dimension?.height || 0;

  const words = [];
  for (const token of page?.tokens || []) {
    const text = resolveTextAnchor(token.layout?.textAnchor, fullText).trim();
    if (!text) continue;
    const vertices = toPixelVertices(token.layout?.boundingPoly, pageWidth, pageHeight);
    if (vertices.length < 4) continue;
    words.push({ text, confidence: typeof token.layout?.confidence === 'number' ? token.layout.confidence : null, vertices });
  }

  const formFields = [];
  for (const field of page?.formFields || []) {
    const fieldName = resolveTextAnchor(field.fieldName?.textAnchor, fullText).trim();
    const fieldValue = resolveTextAnchor(field.fieldValue?.textAnchor, fullText).trim();
    if (!fieldName) continue;
    const fieldNameBBox = toPixelVertices(field.fieldName?.boundingPoly, pageWidth, pageHeight);
    const valueBBox = toPixelVertices(field.fieldValue?.boundingPoly, pageWidth, pageHeight);
    formFields.push({
      fieldName,
      fieldNameBBox,
      fieldValue,
      valueConfidence: typeof field.fieldValue?.confidence === 'number' ? field.fieldValue.confidence : null,
      valueBBox
    });
  }

  // Tabele - Document AI rozpoznaje niektore sekcje formularza (listy opcji
  // checkboxowych typu "material sciany zewnetrznej: Cegla/Bloczki/Pustak...")
  // jako PRAWDZIWA tabele z wierszami/komorkami - zweryfikowane na realnym
  // pliku (Kazimierz Biskupi): kazdy wiersz to JEDEN, poprawnie zgrupowany
  // string (checkbox+etykieta+wartosc razem, we wlasciwej kolejnosci) - zero
  // przemieszania, w odroznieniu od plaskiej listy tokenow. NIE kazda sekcja
  // formularza wychodzi jako tabela (zweryfikowane: dziala dobrze dla
  // Kazimierz Biskupi, NIE dla Kotly'ego "Moc kotla") - dlatego to jedno z
  // KILKU zrodel probowanych po kolei (patrz tableMatch.js), nie jedyne.
  const tables = [];
  for (const table of page?.tables || []) {
    const rows = [];
    for (const row of table.bodyRows || []) {
      const cells = (row.cells || []).map((c) => resolveTextAnchor(c.layout?.textAnchor, fullText).trim());
      const bbox = toPixelVertices(row.cells?.[0]?.layout?.boundingPoly, pageWidth, pageHeight);
      rows.push({ cells, text: cells.join(' '), bbox });
    }
    tables.push({ rows });
  }

  // visualElements - Document AI klasyfikuje kazdy checkbox jako osobny,
  // ustrukturyzowany byt (typ filled_checkbox/unfilled_checkbox) z wlasnym
  // bbox+confidence, NIEZALEZNIE od tego czy w tekscie tokenow/formFields
  // pojawil sie glif Unicode - zweryfikowane na realnym pliku (Galewice
  // kociol): checkbox przy "25 kW" byl obecny tu (confidence 0.51) mimo ze
  // formFields go nie sparowalo z wartoscia w ogole. Uzywane jako ostatnia
  // deska ratunku, gdy ani tabela ani formFields nie dalo checked/unchecked.
  const visualElements = [];
  for (const el of page?.visualElements || []) {
    if (el.type !== 'filled_checkbox' && el.type !== 'unfilled_checkbox') continue;
    const bbox = toPixelVertices(el.layout?.boundingPoly, pageWidth, pageHeight);
    if (bbox.length < 4) continue;
    visualElements.push({ type: el.type, confidence: typeof el.layout?.confidence === 'number' ? el.layout.confidence : null, bbox });
  }

  return { text: fullText, words, formFields, tables, visualElements };
}

module.exports = { isConfigured, ocrImage };
