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
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const geminiEngine = require('./geminiFieldEngine');
const openaiEngine = require('./openaiFieldEngine');

const PROVIDERS = { gemini: geminiEngine, openai: openaiEngine };
const PROVIDER_LABELS = { gemini: 'Google Gemini', openai: 'OpenAI' };

const PROVIDER_CONFIG_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Scyzoryk',
  'ai-provider.json'
);

function getActiveProvider() {
  try {
    const data = JSON.parse(fsSync.readFileSync(PROVIDER_CONFIG_PATH, 'utf8'));
    if (PROVIDERS[data?.provider]) return data.provider;
  } catch (_) { /* brak pliku/blad odczytu - domyslny nizej */ }
  return 'gemini';
}

function setActiveProvider(provider) {
  if (!PROVIDERS[provider]) throw new Error(`Nieznany dostawca: ${provider}`);
  fsSync.mkdirSync(path.dirname(PROVIDER_CONFIG_PATH), { recursive: true });
  fsSync.writeFileSync(PROVIDER_CONFIG_PATH, JSON.stringify({ provider }, null, 2), 'utf8');
}

function isConfigured() {
  return PROVIDERS[getActiveProvider()].isConfigured();
}

function saveUserApiKey(provider, apiKey) {
  if (!PROVIDERS[provider]) throw new Error(`Nieznany dostawca: ${provider}`);
  const result = PROVIDERS[provider].saveUserApiKey(apiKey);
  setActiveProvider(provider);
  return result;
}

function extractFieldsForBlock(args) {
  return PROVIDERS[getActiveProvider()].extractFieldsForBlock(args);
}

function detectBlockStartPages(args) {
  return PROVIDERS[getActiveProvider()].detectBlockStartPages(args);
}

module.exports = {
  isConfigured,
  saveUserApiKey,
  extractFieldsForBlock,
  detectBlockStartPages,
  getActiveProvider,
  PROVIDER_LABELS
};
