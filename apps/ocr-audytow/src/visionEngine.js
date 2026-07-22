// Cienki wrapper na Google Cloud Vision API (`DOCUMENT_TEXT_DETECTION`) -
// zastapil Tesseracta jako silnik rozpoznawania tekstu (2026-07-21). Powod:
// realne testy na kilkunastu prawdziwych audytach pokazaly, ze Tesseract
// praktycznie nie czyta odrecznych wpisow w tych formularzach (Vision czyta
// wiekszosc poprawnie, przy porownywalnym lub lepszym czasie - patrz pamiec
// projektu/artefakt z porownaniem silnikow OCR z tego samego dnia).
//
// Wymaga klucza API w zmiennej srodowiskowej OCR_VISION_API_KEY (nigdy nie
// zapisywac klucza w kodzie/repo). Region europejski (opcjonalny) przez
// OCR_VISION_REGION=eu.
const fs = require('fs/promises');
const https = require('https');

function apiKey() {
  return process.env.OCR_VISION_API_KEY || '';
}

function isConfigured() {
  return Boolean(apiKey());
}

function endpointHost() {
  return process.env.OCR_VISION_REGION === 'eu' ? 'eu-vision.googleapis.com' : 'vision.googleapis.com';
}

function requestJson(hostname, requestPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path: requestPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: Number(process.env.OCR_VISION_TIMEOUT_MS || 30000)
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(chunks); } catch (_) {
            return reject(new Error('Nieprawidlowa odpowiedz Google Cloud Vision.'));
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new Error(parsed?.error?.message || `Blad Google Cloud Vision (HTTP ${res.statusCode}).`));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Przekroczono czas oczekiwania na odpowiedz Google Cloud Vision.')));
    req.on('error', (err) => reject(new Error(`Nie udalo sie polaczyc z Google Cloud Vision: ${err.message}`)));
    req.write(data);
    req.end();
  });
}

// Rozpoznaje tekst na jednej stronie (obraz JPEG/PNG). Zwraca pelny tekst
// strony oraz liste slow w kolejnosci odczytu, kazde z:
//  - text: rozpoznany ciag znakow,
//  - confidence: pewnosc 0-1 (Vision) lub null jesli nie podana,
//  - vertices: 4 wierzcholki wielokata otaczajacego slowo, W PIKSELACH
//    ORYGINALNEGO (niepoprawionego pod katem obrotu) obrazu wejsciowego -
//    ich kolejnosc/geometria sluzy tez do wykrywania obrotu strony, patrz
//    rotationDetect.js.
async function ocrImage(imagePath) {
  if (!isConfigured()) throw new Error('Brak klucza API Google Cloud Vision (zmienna OCR_VISION_API_KEY).');
  const content = (await fs.readFile(imagePath)).toString('base64');
  const body = {
    requests: [
      {
        image: { content },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['pl'] }
      }
    ]
  };

  const data = await requestJson(endpointHost(), `/v1/images:annotate?key=${apiKey()}`, body);
  const resp = data.responses?.[0];
  if (resp?.error) throw new Error(resp.error.message || 'Blad rozpoznawania tekstu (Google Cloud Vision).');

  const fta = resp?.fullTextAnnotation;
  const words = [];
  for (const page of fta?.pages || []) {
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const text = (word.symbols || []).map((s) => s.text).join('');
          if (!text) continue;
          // Rzadki przypadek zaobserwowany na realnym pliku 2026-07-22:
          // Vision czasem zwraca slowo BEZ boundingBox w ogole (pusta tablica
          // vertices) - takie slowo jest bezuzyteczne dla dopasowania
          // przestrzennego (etykieta/wartosc na podstawie polozenia) i co
          // gorsza, Math.min()/Math.max() na pustej liscie w bbox()
          // (fieldExtraction.js) dawaly Infinity/-Infinity zamiast bledu -
          // taki "zepsuty" bbox przechodzil niezauwazony przez kolejne
          // klamry Math.min/max (Infinity to prawidlowa liczba dla nich) az
          // do rysowania podgladu pola, gdzie zawieszal caly request.
          // Pomijamy takie slowo calkowicie - i tak nie da sie go geometrycznie
          // dopasowac do niczego.
          const vertices = word.boundingBox?.vertices || [];
          if (vertices.length < 4) continue;
          words.push({
            text,
            confidence: typeof word.confidence === 'number' ? word.confidence : null,
            vertices: vertices.map((v) => ({ x: v.x || 0, y: v.y || 0 }))
          });
        }
      }
    }
  }

  return { text: fta?.text || '', words };
}

module.exports = { isConfigured, ocrImage };
