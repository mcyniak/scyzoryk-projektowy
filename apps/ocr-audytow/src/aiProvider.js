// Router miedzy silnikami ekstrakcji pol (src/geminiFieldEngine.js,
// src/openaiFieldEngine.js) - dodany 2026-08-19 razem z drugim silnikiem.
// server.js importuje WYLACZNIE ten modul (nie konkretny silnik
// bezposrednio), zeby przelaczanie dostawcy nie wymagalo zadnych zmian w
// server.js poza tym plikiem.
//
// Ktory dostawca jest AKTYWNY jest zapisywane w OSOBNYM, malym pliku
// (nie w kluczu API) - zapisanie nowego klucza (saveUserApiKey) automatycznie
// USTAWIA jego dostawce jako aktywnego (wybor klucza = wybor silnika, jeden
// prosty krok dla uzytkownika). Domyslny dostawca (brak pliku) to 'gemini' -
// kompatybilnosc wsteczna, kto juz mial skonfigurowany klucz Gemini i nigdy
// nie dotknie tego ekranu ponownie, dziala dokladnie jak przed ta zmiana.
//
// 2026-08-19 (ten sam dzien): dodano 'manual' - ani Gemini (darmowy limit),
// ani OpenAI (firma jeszcze nie ma wykupionego dostepu do API - to inny
// produkt niz subskrypcja ChatGPT) nie byly realnie uzywalne, wiec
// wlasciciel chcial zawsze dostepna, bezkluczowa opcje: uzytkownik sam
// czyta wartosci z podgladu strony i wpisuje je recznie. To NIE jest
// prawdziwy silnik (PROVIDERS mapa), tylko no-op obsluzony wprost w kazdej
// z 4 funkcji ponizej - logika jest za prosta, zeby byl sens osobnego
// pliku "manualFieldEngine.js".
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const geminiEngine = require('./geminiFieldEngine');
const openaiEngine = require('./openaiFieldEngine');

const PROVIDERS = { gemini: geminiEngine, openai: openaiEngine };
const PROVIDER_LABELS = { gemini: 'Google Gemini', openai: 'OpenAI', manual: 'Ręcznie (bez AI)' };
const VALID_PROVIDERS = new Set([...Object.keys(PROVIDERS), 'manual']);

const PROVIDER_CONFIG_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Scyzoryk',
  'ai-provider.json'
);

function getActiveProvider() {
  try {
    const data = JSON.parse(fsSync.readFileSync(PROVIDER_CONFIG_PATH, 'utf8'));
    if (VALID_PROVIDERS.has(data?.provider)) return data.provider;
  } catch (_) { /* brak pliku/blad odczytu - domyslny nizej */ }
  return 'gemini';
}

function setActiveProvider(provider) {
  if (!VALID_PROVIDERS.has(provider)) throw new Error(`Nieznany dostawca: ${provider}`);
  fsSync.mkdirSync(path.dirname(PROVIDER_CONFIG_PATH), { recursive: true });
  fsSync.writeFileSync(PROVIDER_CONFIG_PATH, JSON.stringify({ provider }, null, 2), 'utf8');
}

function isConfigured() {
  const provider = getActiveProvider();
  if (provider === 'manual') return true; // nie potrzeba zadnego klucza
  return PROVIDERS[provider].isConfigured();
}

function saveUserApiKey(provider, apiKey) {
  if (!VALID_PROVIDERS.has(provider)) throw new Error(`Nieznany dostawca: ${provider}`);
  if (provider === 'manual') {
    setActiveProvider('manual');
    return { saved: true };
  }
  const result = PROVIDERS[provider].saveUserApiKey(apiKey);
  setActiveProvider(provider);
  return result;
}

function extractFieldsForBlock(args) {
  const provider = getActiveProvider();
  if (provider === 'manual') return Promise.resolve({}); // wszystkie pola -> needsReview:true (patrz buildFieldsFromExtraction)
  return PROVIDERS[provider].extractFieldsForBlock(args);
}

function detectBlockStartPages(args) {
  const provider = getActiveProvider();
  if (provider === 'manual') return Promise.resolve([0]); // jeden blok = caly plik, dzielenie recznie (przyciski +/✂ na ekranie 2)
  return PROVIDERS[provider].detectBlockStartPages(args);
}

module.exports = {
  isConfigured,
  saveUserApiKey,
  extractFieldsForBlock,
  detectBlockStartPages,
  getActiveProvider,
  PROVIDER_LABELS
};
