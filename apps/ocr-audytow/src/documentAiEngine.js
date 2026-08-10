// Cienki wrapper na Google Document AI (Form Parser processor).
//
// Konfiguracja jest czytana w tej kolejnosci:
//   1. zmienne srodowiskowe OCR_DOCAI_*,
//   2. plik uzytkownika %LOCALAPPDATA%/Scyzoryk/ocr-document-ai.json,
//   3. konfiguracja wbudowana w poufny instalator wewnetrzny:
//      apps/ocr-audytow/config/document-ai.json.
//
// Wersja wbudowana pozwala przekazac pracownikowi jeden gotowy instalator bez
// recznego kopiowania kluczy. Pliki konfiguracyjne sa tworzone tylko podczas
// bezpiecznego builda z GitHub Actions Secret i nigdy nie trafiaja do repo.
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
const BUNDLED_CONFIG_PATH = path.join(__dirname, '..', 'config', 'document-ai.json');
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

  const userConfig = normalizeFileConfig(USER_CONFIG_PATH, readJsonFile(USER_CONFIG_PATH));
  if (isComplete(userConfig)) return userConfig;

  const bundledConfig = normalizeFileConfig(BUNDLED_CONFIG_PATH, readJsonFile(BUNDLED_CONFIG_PATH));
  if (isComplete(bundledConfig)) return bundledConfig;

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

// Audyt: /api/ocr/setup-credentials dotad ODBLOKOWYWAL OCR (isConfigured()
// zaczynalo zwracac true) tylko dlatego, ze wszystkie 4 pola byly niepuste,
// nigdy faktycznie nie sprawdzajac, czy dane sie ze soba zgadzaja - zlapane
// realnie: zly region ("UE" zamiast "eu") przeszedl caly formularz i
// "odblokowal" OCR, a dopiero PIERWSZA prawdziwa proba rozpoznawania tekstu
// (na realnym dokumencie uzytkownika, potencjalnie duzo pozniej) ujawniala
// "12 UNIMPLEMENTED: HTTP 404" bez zadnej wskazowki, co jest nie tak.
//
// Pierwsza wersja tego testu uzywala getProcessor() (samo pobranie metadanych,
// bez dokumentu) - WYGLADALO na najlzejsze mozliwe sprawdzenie, ale zlapane
// realnie zaraz po wdrozeniu: getProcessor() wymaga uprawnienia
// "documentai.processors.get", ktorego NIE MA (i celowo nie powinno miec)
// prawidlowo, minimalnie skonfigurowane konto serwisowe z rola "Document AI
// API User" (roles/documentai.apiUser) - ta rola daje tylko processOnline/
// processBatch (uzywanie procesora), nie viewer-owe .get (przegladanie jego
// metadanych). Efekt: poprawnie, bezpiecznie skonfigurowany uzytkownik
// (dokladnie tak jak instrukcja w komunikacie bledu kazala mu zrobic)
// dostawal falszywy PERMISSION_DENIED i nigdy nie mogl odblokowac OCR.
// Test musi wiec uzyc DOKLADNIE tego samego uprawnienia co prawdziwe OCR
// (ocrImage() nizej, processDocument()) - jedynym sposobem jest realne,
// minimalne wywolanie processDocument() na maciupkim (1x1 px) obrazku.
// Koszt to jedna strona wg cennika Document AI (ulamek centa) - akceptowalna
// cena za realne potwierdzenie dzialania PRZED zapisaniem konfiguracji jako
// aktywnej, zamiast dowiadywania sie dopiero przy prawdziwym audycie.
const BLANK_TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function verifyConnection({ credentials, projectId, location, processorId }) {
  const testClient = new DocumentProcessorServiceClient({
    credentials,
    apiEndpoint: `${location}-documentai.googleapis.com`
  });
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  try {
    await testClient.processDocument({
      name,
      rawDocument: { content: BLANK_TEST_IMAGE_BASE64, mimeType: 'image/png' }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: explainDocumentAiError(err) };
  } finally {
    try { await testClient.close(); } catch (_) {}
  }
}

function explainDocumentAiError(err) {
  const code = err?.code;
  const raw = String(err?.message || err || '').trim();
  if (code === 5) {
    return `Nie znaleziono procesora o podanym ID w tym projekcie/regionie - sprawdz projectId, location i processorId (${raw}).`;
  }
  if (code === 7) {
    return `Brak uprawnien do tego procesora - sprawdz, czy konto serwisowe ma rola "Uzytkownik interfejsu API Document AI" w tym projekcie (${raw}).`;
  }
  if (code === 16) {
    return `Nie udalo sie uwierzytelnic - sprawdz, czy plik klucza jest poprawny i nalezy do tego projektu (${raw}).`;
  }
  if (code === 12 || raw.includes('UNIMPLEMENTED') || raw.includes('404')) {
    return `Zla lokalizacja (region) procesora - sprawdz, czy to na pewno region, w ktorym utworzono procesor w Google Cloud Console (male litery, np. "eu" albo "us") (${raw}).`;
  }
  if (code === 3) {
    return `Niepoprawne dane (projectId/location/processorId) - sprawdz kazde z osobna w Google Cloud Console (${raw}).`;
  }
  return `Nie udalo sie polaczyc z Document AI: ${raw}`;
}

function resolveTextAnchor(textAnchor, fullText) {
  if (textAnchor?.content) return textAnchor.content;
  const segments = textAnchor?.textSegments || [];
  return segments.map((seg) => fullText.slice(Number(seg.startIndex || 0), Number(seg.endIndex || 0))).join('');
}

function toPixelVertices(boundingPoly, pageWidth, pageHeight) {
  if (boundingPoly?.vertices?.length) {
    return boundingPoly.vertices.map((v) => ({ x: v.x || 0, y: v.y || 0 }));
  }
  if (boundingPoly?.normalizedVertices?.length) {
    return boundingPoly.normalizedVertices.map((v) => ({ x: (v.x || 0) * pageWidth, y: (v.y || 0) * pageHeight }));
  }
  return [];
}

async function ocrImage(imagePath) {
  const config = getConfiguration();
  if (!config) {
    throw new Error('Brak konfiguracji Google Document AI. Uzyj gotowego instalatora wewnetrznego z OCR albo ustaw plik %LOCALAPPDATA%\\Scyzoryk\\ocr-document-ai.json.');
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

module.exports = {
  isConfigured,
  getConfigurationStatus,
  ocrImage,
  resolveMimeType,
  verifyConnection,
  USER_CONFIG_PATH,
  BUNDLED_CONFIG_PATH
};
