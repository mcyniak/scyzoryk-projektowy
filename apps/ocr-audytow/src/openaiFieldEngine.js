// Silnik ekstrakcji pol formularza audytu przez OpenAI (Responses API,
// schema-guided JSON) - dodany 2026-08-19 jako alternatywa dla Gemini
// (src/geminiFieldEngine.js), na wyrazna prosbe wlasciciela: klucz Gemini
// dostepny wtedy mial darmowy limit (429 "Quota exceeded... free_tier_requests,
// limit: 20"), ktory realnie blokowal przetwarzanie paczek po kilkanascie
// plikow, podczas gdy firma ma praktycznie nielimitowany dostep do API
// OpenAI. Sam prompt/logika pol sa WSPOLNE z Gemini (src/aiEngineShared.js) -
// tu jest TYLKO to, co jest specyficzne dla OpenAI: adres API, dialekt JSON
// Schema (Structured Outputs), ksztalt zapytania/odpowiedzi Responses API.
//
// Zweryfikowane bezposrednio w dokumentacji OpenAI (2026-08-19, live docs,
// nie z pamieci - API i model sie zmienialy):
//   - POST https://api.openai.com/v1/responses, PDF jako czesc `input_file`
//     (`file_data: "data:application/pdf;base64,<...>"`) obok `input_text`
//     w tej samej wiadomosci - model z vision (gpt-4o+) dostaje tekst I
//     obrazy stron. Limit 50MB/request.
//   - Structured Outputs w Responses API idzie przez `text.format`
//     (`{type:'json_schema', name, schema, strict:true}`), NIE
//     `response_format` (to stary endpoint Chat Completions). W trybie
//     strict KAZDA wlasciwosc musi byc w `required`, `additionalProperties:
//     false` na obiekcie, a "opcjonalnosc" (null) idzie przez
//     `type: ["string","null"]` - standardowy JSON Schema, nie dialekt
//     Gemini (`nullable: true`).
//   - Odczyt wyniku: `response.output_text` (caly tekst) - z defensywnym
//     fallbackiem po `response.output[].content[].text`, gdyby ksztalt
//     odpowiedzi na prawdziwym wywolaniu okazal sie inny niz w dokumentacji.
//
// Konfiguracja (ten sam wzorzec co Gemini, OSOBNY plik - oba klucze moga
// wspolistniec na dysku niezaleznie, patrz src/aiProvider.js):
//   1. zmienna srodowiskowa OPENAI_API_KEY,
//   2. plik uzytkownika %LOCALAPPDATA%/Scyzoryk/openai-api-key.json ({ apiKey }).
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { pdfSliceToBase64, buildExtractionPrompt, BOUNDARY_PROMPT, withTimeout, sleep } = require('./aiEngineShared');

const USER_CONFIG_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Scyzoryk',
  'openai-api-key.json'
);

// Cena nieistotna wg wlasciciela ("bez limitu") - Sol (najmocniejszy tier
// rodziny GPT-5.6, GA 2026-07-09) jako domyslny wybor jakosci, nie kosztu.
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
const API_BASE = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = Number(process.env.OCR_OPENAI_TIMEOUT_MS || 90000);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 4000;

function readJsonFile(filePath) {
  try { return JSON.parse(fsSync.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function getApiKey() {
  const fromEnv = String(process.env.OPENAI_API_KEY || '').trim();
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
  if (!trimmed) throw new Error('Podaj klucz API OpenAI.');
  fsSync.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
  fsSync.writeFileSync(USER_CONFIG_PATH, JSON.stringify({ apiKey: trimmed }, null, 2), 'utf8');
  return { saved: true };
}

// Retry na 429 (limit zapytan) i 5xx (chwilowe problemy serwera) - ten sam
// wzorzec co callGemini w geminiFieldEngine.js. Inne bledy (400/401/404...)
// NIE sa retry'owane - to sygnal zlej konfiguracji/promptu.
async function callOpenAi(body) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Brak skonfigurowanego klucza API OpenAI. Ustaw zmienna OPENAI_API_KEY albo wpisz klucz w ustawieniach narzedzia.');

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await withTimeout(
        fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body)
        }),
        REQUEST_TIMEOUT_MS,
        'Zapytanie do OpenAI'
      );
    } catch (err) {
      lastError = err;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    if (res.ok) return res.json();
    const data = await res.json().catch(() => null);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES - 1) {
      lastError = new Error(data?.error?.message || `OpenAI ${res.status}`);
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    throw new Error(data?.error?.message || `OpenAI zwrocilo blad ${res.status}`);
  }
  throw lastError || new Error('OpenAI: nie udalo sie uzyskac odpowiedzi po kilku probach.');
}

// `output_text` to udokumentowany, wygodny skrot - fallback po
// `output[].content[].text` na wypadek, gdyby na prawdziwym wywolaniu
// odpowiedz nie zawierala tego pola (np. inna wersja API).
function extractJsonText(response) {
  let text = response?.output_text;
  if (!text) {
    for (const item of response?.output || []) {
      const part = item?.content?.find((p) => p?.text);
      if (part) { text = part.text; break; }
    }
  }
  if (!text) throw new Error('OpenAI nie zwrocilo tresci odpowiedzi.');
  return JSON.parse(text);
}

function buildSchema(fieldDefs) {
  const properties = {};
  const required = [];
  for (const def of fieldDefs) {
    properties[def.key] = { type: ['string', 'null'] };
    required.push(def.key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function buildInput(promptText, base64Pdf) {
  return [{
    role: 'user',
    content: [
      { type: 'input_file', filename: 'blok.pdf', file_data: `data:application/pdf;base64,${base64Pdf}` },
      { type: 'input_text', text: promptText }
    ]
  }];
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
    model: MODEL,
    input: buildInput(prompt, base64),
    text: { format: { type: 'json_schema', name: 'pola_audytu', schema, strict: true } }
  };
  const response = await callOpenAi(body);
  return extractJsonText(response);
}

const BOUNDARY_SCHEMA = {
  type: 'object',
  properties: { blockStartPages: { type: 'array', items: { type: 'integer' } } },
  required: ['blockStartPages'],
  additionalProperties: false
};

// Lekkie, tanie wywolanie (maly schemat wyjsciowy) - tylko PROPOZYCJA
// podzialu na bloki adresowe do zatwierdzenia/poprawienia przez uzytkownika
// (ekran 2 w UI) - nigdy nie dzieli automatycznie bez przegladu, zgodnie z
// dotychczasowym zachowaniem aplikacji (ten sam kontrakt co Gemini).
async function detectBlockStartPages({ sourcePdfPath, pageCount }) {
  if (pageCount <= 1) return [0];
  const base64 = await pdfSliceToBase64(sourcePdfPath, 0, pageCount - 1);
  const body = {
    model: MODEL,
    input: buildInput(BOUNDARY_PROMPT, base64),
    text: { format: { type: 'json_schema', name: 'podzial_na_adresy', schema: BOUNDARY_SCHEMA, strict: true } }
  };
  const response = await callOpenAi(body);
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
