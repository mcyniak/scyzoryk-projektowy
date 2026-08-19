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
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument } = require('pdf-lib');

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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} - przekroczono limit czasu (${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
        fetch(`${API_BASE}/${MODEL}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

async function pdfSliceToBase64(sourcePdfPath, startPage, endPage) {
  const sourceBytes = await fs.readFile(sourcePdfPath);
  const sourceDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  const sliceDoc = await PDFDocument.create();
  const pageIndexes = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
  const copied = await sliceDoc.copyPages(sourceDoc, pageIndexes);
  copied.forEach((p) => sliceDoc.addPage(p));
  const sliceBytes = await sliceDoc.save();
  return Buffer.from(sliceBytes).toString('base64');
}

const EXTRACTION_PROMPT_HEADER = `Jestes systemem transkrypcji formularzy audytu energetycznego (protokol uzgodnien montazowych).
Odczytuj WYLACZNIE wartosci widoczne w dokumencie (drukowane i odreczne, w tym zaznaczone checkboxy).
Nie uzupelniaj brakujacych wartosci na podstawie wiedzy ani domyslow.
Nie poprawiaj wartosci, nawet jesli wygladaja na bledne technicznie.
Dla pol typu checkbox/wybor zwroc dokladnie jedna z podanych dozwolonych wartosci (lub null jesli nic nie zaznaczono / kilka zaznaczen jednoczesnie w sposob niejednoznaczny).
Dla pol z materialem i gruboscia zwroc jeden string "material, grubosc" (np. "Styropian, 10cm").
Jezeli pole nie wystepuje w dokumencie, jest puste lub nieczytelne, zwroc null.
Zachowuj dokladnie polskie znaki diakrytyczne.
Rozroznij przecinek dziesietny od cyfry 1. Nie przeliczaj jednostek.

Pola do wypelnienia:
`;

function buildSchemaAndPrompt(fieldDefs) {
  const properties = {};
  const required = [];
  const fieldDocs = [];
  for (const def of fieldDefs) {
    properties[def.key] = { type: 'STRING', nullable: true };
    required.push(def.key);
    const optStr = def.options?.length ? ` (dozwolone wartosci: ${def.options.map((o) => o.label).join(' | ')})` : '';
    const noteStr = def.note ? ` (${def.note})` : '';
    fieldDocs.push(`- ${def.key}: ${def.columnLabel}${optStr}${noteStr}`);
  }
  const schema = { type: 'OBJECT', properties, required };
  const prompt = EXTRACTION_PROMPT_HEADER + fieldDocs.join('\n');
  return { schema, prompt };
}

// Wyciaga wartosci WSZYSTKICH pol z fieldDefs (juz odfiltrowanych przez
// wywolujacego wg allowedKeys/kind!=='manual') z jednego bloku (zakres stron
// = jeden adres). Zwraca plaski obiekt { key: value|null }.
async function extractFieldsForBlock({ sourcePdfPath, startPage, endPage, fieldDefs }) {
  if (!fieldDefs.length) return {};
  const { schema, prompt } = buildSchemaAndPrompt(fieldDefs);
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

const BOUNDARY_PROMPT = `Ten PDF moze zawierac JEDEN lub WIELE oddzielnych formularzy "PROTOKOL UZGODNIEN MONTAZOWYCH" (kazdy zaczyna sie naglowkiem zawierajacym oba fragmenty: "PROTOKOL UZGODNIEN..." oraz "SPORZADZONY DNIA:").
Znajdz numer KAZDEJ strony (liczac od 0), na ktorej zaczyna sie NOWY taki formularz - czyli strone z tym naglowkiem NA GORZE.
Strona z samym oswiadczeniem/RODO/podpisem NIE liczy sie jako nowy poczatek.
Zwroc rosnaco posortowana liste numerow stron w polu blockStartPages. Pierwszy formularz zawsze zaczyna sie od strony 0, wiec 0 zawsze powinno byc w liscie.`;

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
