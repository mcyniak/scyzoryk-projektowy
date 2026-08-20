// Silnik ekstrakcji pol formularza audytu przez Google Gemini (schema-guided
// JSON) - zastapil 2026-08-12 Google Document AI (Form Parser) +
// geometryczne dopasowanie etykieta->wartosc (patrz src/fieldExtraction.js,
// git history dla starej wersji). Powod migracji: test porownawczy na 7
// realnych audytach (patrz pamiec projektu) pokazal 76% pustych pol dla
// starego silnika wobec ~18% dla Gemini na tym samym zestawie, plus co
// najmniej jeden przypadek, gdzie stary silnik wsadzil wartosc w ZLE pole
// (dopasowanie geometryczne "najblizsza etykieta" pomylilo sasiednie pola).
//
// Model dostaje caly blok (zakres stron jednego adresu) jako PDF NA RAZ i sam
// semantycznie przypisuje wartosci do pol wedlug schematu - w odroznieniu od
// starego podejscia nie ma tu wlasnej logiki "znajdz etykiete, we wartosc z
// sasiedztwa". Prompt jest celowo konserwatywny (nie zgaduj, nie poprawiaj,
// zwroc null jesli niepewne) - zweryfikowane w testach, ze bez tego model
// czasem "poprawia" nielogicznie wygladajaca odreczna wartosc zamiast wiernie
// ja przepisac.
//
// Konfiguracja (kolejnosc jak w dawnym documentAiEngine.js, uproszczona do
// JEDNEGO sekretu zamiast pliku service-account.json + 3 zmiennych):
//   1. zmienna srodowiskowa GEMINI_API_KEY,
//   2. plik uzytkownika %LOCALAPPDATA%/Scyzoryk/gemini-api-key.json ({ apiKey }).
//
// 2026-08-19: prompt/BOUNDARY_PROMPT/pdfSliceToBase64/withTimeout/sleep
// przeniesione do src/aiEngineShared.js (wspolne z nowym src/openaiFieldEngine.js,
// patrz src/aiProvider.js) - tu zostaje TYLKO to, co jest specyficzne dla
// Gemini (adres API, dialekt schematu, parsowanie odpowiedzi).
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { pdfSliceToBase64, buildExtractionPrompt, BOUNDARY_PROMPT, withTimeout, sleep } = require('./aiEngineShared');

const USER_CONFIG_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Scyzoryk',
  'gemini-api-key.json'
);

const MODEL = 'gemini-flash-latest';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = Number(process.env.OCR_GEMINI_TIMEOUT_MS || 90000);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 4000;

function readJsonFile(filePath) {
  try { return JSON.parse(fsSync.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function getApiKey() {
  const fromEnv = String(process.env.GEMINI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const fromFile = readJsonFile(USER_CONFIG_PATH);
  const fromFileKey = String(fromFile?.apiKey || '').trim();
  return fromFileKey || null;
}

function isConfigured() {
  return Boolean(getApiKey());
}

function saveUserApiKey(apiKey) {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) throw new Error('Podaj klucz API Gemini.');
  fsSync.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
  fsSync.writeFileSync(USER_CONFIG_PATH, JSON.stringify({ apiKey: trimmed }, null, 2), 'utf8');
  return { saved: true };
}

// Retry na 429 (limit zapytan) i 503 (chwilowe przeciazenie) - oba realnie
// wystapily w testach porownawczych na tej samej garstce plikow, wiec to nie
// jest teoretyczne ryzyko. Inne bledy (400/401/404...) NIE sa retry'owane -
// to sygnal zlej konfiguracji/promptu, ponawianie nic by nie dalo.
async function callGemini(body) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Brak skonfigurowanego klucza API Gemini. Ustaw zmienna GEMINI_API_KEY albo wpisz klucz w ustawieniach narzedzia.');

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await withTimeout(
        // Klucz w naglowku (x-goog-api-key), nie w URL query (?key=...) -
        // audyt 2026-08-20: URL z sekretem latwiej trafia do logow proxy/
        // diagnostyki niz naglowek, mimo ze samo polaczenie i tak jest
        // szyfrowane HTTPS. Naglowek to aktualnie udokumentowany przez
        // Google sposob autoryzacji REST.
        fetch(`${API_BASE}/${MODEL}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body)
        }),
        REQUEST_TIMEOUT_MS,
        'Zapytanie do Gemini'
      );
    } catch (err) {
      lastError = err;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    if (res.ok) return res.json();
    const data = await res.json().catch(() => null);
    const status = data?.error?.status;
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES - 1) {
      lastError = new Error(data?.error?.message || `Gemini ${status || res.status}`);
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    throw new Error(data?.error?.message || `Gemini zwrocilo blad ${res.status}`);
  }
  throw lastError || new Error('Gemini: nie udalo sie uzyskac odpowiedzi po kilku probach.');
}

function extractJsonText(response) {
  const text = response?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) throw new Error('Gemini nie zwrocilo tresci odpowiedzi.');
  return JSON.parse(text);
}

function buildSchema(fieldDefs) {
  const properties = {};
  const required = [];
  for (const def of fieldDefs) {
    properties[def.key] = { type: 'STRING', nullable: true };
    required.push(def.key);
  }
  return { type: 'OBJECT', properties, required };
}

// Wyciaga wartosci WSZYSTKICH pol z fieldDefs (juz odfiltrowanych przez
// wywolujacego wg allowedKeys/kind!=='manual') z jednego bloku (zakres stron
// = jeden adres). Zwraca plaski obiekt { key: value|null }.
async function extractFieldsForBlock({ sourcePdfPath, startPage, endPage, fieldDefs }) {
  if (!fieldDefs.length) return {};
  const schema = buildSchema(fieldDefs);
  const prompt = buildExtractionPrompt(fieldDefs);
  const base64 = await pdfSliceToBase64(sourcePdfPath, startPage, endPage);
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'application/pdf', data: base64 } }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
  };
  const response = await callGemini(body);
  return extractJsonText(response);
}

const BOUNDARY_SCHEMA = {
  type: 'OBJECT',
  properties: { blockStartPages: { type: 'ARRAY', items: { type: 'INTEGER' } } },
  required: ['blockStartPages']
};

// Lekkie, tanie wywolanie (maly schemat wyjsciowy) - tylko PROPOZYCJA
// podzialu na bloki adresowe do zatwierdzenia/poprawienia przez uzytkownika
// (ekran 2 w UI) - nigdy nie dzieli automatycznie bez przegladu, zgodnie z
// dotychczasowym zachowaniem aplikacji.
async function detectBlockStartPages({ sourcePdfPath, pageCount }) {
  if (pageCount <= 1) return [0];
  const base64 = await pdfSliceToBase64(sourcePdfPath, 0, pageCount - 1);
  const body = {
    contents: [{ parts: [{ text: BOUNDARY_PROMPT }, { inline_data: { mime_type: 'application/pdf', data: base64 } }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: BOUNDARY_SCHEMA }
  };
  const response = await callGemini(body);
  const parsed = extractJsonText(response);
  const pages = Array.isArray(parsed.blockStartPages) ? parsed.blockStartPages.filter((n) => Number.isInteger(n) && n >= 0 && n < pageCount) : [];
  if (!pages.includes(0)) pages.unshift(0);
  return [...new Set(pages)].sort((a, b) => a - b);
}

module.exports = {
  isConfigured,
  saveUserApiKey,
  extractFieldsForBlock,
  detectBlockStartPages,
  USER_CONFIG_PATH
};
