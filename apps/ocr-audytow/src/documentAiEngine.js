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
// Konfiguracja jest czytana w tej kolejnosci:
//   1. zmienne srodowiskowe OCR_DOCAI_*,
//   2. plik uzytkownika:
//      %LOCALAPPDATA%/Scyzoryk/ocr-document-ai.json.
//
// Plik konfiguracyjny ma postac:
// {
//   "projectId": "...",
//   "location": "eu",
//   "processorId": "...",
//   "keyFile": "service-account.json"
// }
// Sciezka keyFile wzgledna jest rozwiazywana wzgledem katalogu konfiguracji.
// Sam plik konta serwisowego NIGDY nie powinien trafic do zwyklego commita.
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

const USER_CONFIG_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Scyzoryk',
  'ocr-document-ai.json'
);
const MIME_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
});

let cachedClient = null;
let cachedClientSignature = null;

function readJsonFile(filePath) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function normalizeFileConfig(configPath, value) {
  if (!value || typeof value !== 'object') return null;
  const configDir = path.dirname(configPath);
  const rawKeyFile = String(value.keyFile || '').trim();
  const keyFile = rawKeyFile
    ? (path.isAbsolute(rawKeyFile) ? rawKeyFile : path.resolve(configDir, rawKeyFile))
    : '';

  return {
    source: configPath,
    keyFile,
    projectId: String(value.projectId || '').trim(),
    location: String(value.location || '').trim(),
    processorId: String(value.processorId || '').trim()
  };
}

function getEnvironmentConfig() {
  return {
    source: 'environment',
    keyFile: String(process.env.OCR_DOCAI_KEY_FILE || '').trim(),
    projectId: String(process.env.OCR_DOCAI_PROJECT_ID || '').trim(),
    location: String(process.env.OCR_DOCAI_LOCATION || '').trim(),
    processorId: String(process.env.OCR_DOCAI_PROCESSOR_ID || '').trim()
  };
}

function isComplete(config) {
  return Boolean(
    config?.keyFile &&
    config?.projectId &&
    config?.location &&
    config?.processorId &&
    fsSync.existsSync(config.keyFile)
  );
}

function getConfiguration() {
  const envConfig = getEnvironmentConfig();
  if (isComplete(envConfig)) return envConfig;

  const fileConfig = normalizeFileConfig(USER_CONFIG_PATH, readJsonFile(USER_CONFIG_PATH));
  if (isComplete(fileConfig)) return fileConfig;

  return null;
}

function isConfigured() {
  return Boolean(getConfiguration());
}

function getConfigurationStatus() {
  const config = getConfiguration();
  return {
    configured: Boolean(config),
    source: config?.source || null,
    projectId: config?.projectId || null,
    location: config?.location || null,
    processorId: config?.processorId || null,
    keyFileExists: Boolean(config?.keyFile && fsSync.existsSync(config.keyFile))
  };
}

function getClient(config) {
  const signature = `${config.keyFile}|${config.location}`;
  if (cachedClient && cachedClientSignature === signature) return cachedClient;

  cachedClient = new DocumentProcessorServiceClient({
    keyFilename: config.keyFile,
    apiEndpoint: `${config.location}-documentai.googleapis.com`
  });
  cachedClientSignature = signature;
  return cachedClient;
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
// juz-w-pikselach na ta sama konwencje co Vision's word.vertices (4 punkty w
// pikselach). Uwaga: te wspolrzedne sa w WLASNEJ, wewnetrznie skorygowanej
// ("logicznej") ramce Document AI, nie w ramce surowego, fizycznie obroconego
// obrazu wejsciowego - patrz notatka w ocrPipeline.js (2026-07-24) o swiadomym
// usunieciu automatycznego wykrywania/korygowania fizycznego obrotu strony.
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
//    zeby bundleSplit.js/buildOcrPdf/buildThumbnails i
//    cala dotychczasowa logika dopasowywania w fieldExtraction.js dzialaly
//    bez zadnych zmian (uzywane jako FALLBACK gdy formFields nie pomoga),
//  - formFields: lista {fieldName, fieldNameBBox, fieldValue, valueConfidence,
//    valueBBox} z document.pages[].formFields - NOWA, ustrukturyzowana
//    para pole-wartosc z gotowym parowaniem checkboxow, konsumowana przez
//    formFieldMatch.js jako preferowana sciezka ekstrakcji.
async function ocrImage(imagePath) {
  const config = getConfiguration();
  if (!config) {
    throw new Error('Brak konfiguracji Google Document AI. Zainstaluj wewnetrzny instalator z konfiguracja OCR albo ustaw plik %LOCALAPPDATA%\\Scyzoryk\\ocr-document-ai.json.');
  }

  const client = getClient(config);
  const name = `projects/${config.projectId}/locations/${config.location}/processors/${config.processorId}`;
  const content = (await fs.readFile(imagePath)).toString('base64');
  const mimeType = resolveMimeType(imagePath);

  const [result] = await client.processDocument({
    name,
    rawDocument: { content, mimeType }
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

  const visualElements = [];
  for (const el of page?.visualElements || []) {
    if (el.type !== 'filled_checkbox' && el.type !== 'unfilled_checkbox') continue;
    const bbox = toPixelVertices(el.layout?.boundingPoly, pageWidth, pageHeight);
    if (bbox.length < 4) continue;
    visualElements.push({ type: el.type, confidence: typeof el.layout?.confidence === 'number' ? el.layout.confidence : null, bbox });
  }

  return { text: fullText, words, formFields, tables, visualElements };
}

function resolveMimeType(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  const mimeType = MIME_TYPES[extension];
  if (mimeType) return mimeType;
  if (extension === '.jp2' || extension === '.jpx') {
    throw new Error('Google Document AI nie obsluguje obrazow JPEG 2000 (JP2/JPX). Ta strona zostanie skopiowana bez OCR.');
  }
  throw new Error(`Nieobslugiwany format obrazu OCR: ${extension || 'brak rozszerzenia'}.`);
}

module.exports = { isConfigured, getConfigurationStatus, ocrImage, resolveMimeType };
