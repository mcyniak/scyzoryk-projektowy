// Migracja wbudowanej konfiguracji OCR (apps/ocr-audytow/config/*, dodawanej
// tylko przez wewnetrzny build z GitHub Actions Secret) do trwalego profilu
// uzytkownika (%LOCALAPPDATA%/Scyzoryk/ocr-document-ai.json). Bez tego
// publiczne (bez sekretow) instalatory aktualizacyjne nadpisywalyby caly
// folder programu i usuwaly wbudowany klucz OCR bez zostawienia dzialajacej
// konfiguracji.
//
// UWAGA: USER_CONFIG_PATH/BUNDLED_CONFIG_PATH nizej musza pozostac zgodne z
// apps/ocr-audytow/src/documentAiEngine.js. Nie importujemy tamtego modulu
// wprost (wciagalby ciezka zaleznosc @google-cloud/documentai z osobnego
// node_modules tylko po dwie stale sciezek) - test statyczny w
// test/group10-updater.test.js porownuje zrodla obu plikow.
const fs = require('fs');
const path = require('path');
const os = require('os');

function userConfigPath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Scyzoryk', 'ocr-document-ai.json');
}

function bundledConfigDir(appRootDir) {
  return path.join(appRootDir, 'apps', 'ocr-audytow', 'config');
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function resolveKeyFile(rawKeyFile, configDir) {
  const value = String(rawKeyFile || '').trim();
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function isCompleteConfig(config, configDir) {
  if (!config || typeof config !== 'object') return false;
  const keyFile = resolveKeyFile(config.keyFile, configDir);
  return Boolean(
    keyFile && fs.existsSync(keyFile) &&
    String(config.projectId || '').trim() &&
    String(config.location || '').trim() &&
    String(config.processorId || '').trim()
  );
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function atomicCopyFile(sourcePath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(sourcePath, tmpPath);
  fs.renameSync(tmpPath, destPath);
}

// Idempotentna migracja - bezpieczna do wywolania przy kazdym starcie
// serwera. Zwraca { migrated: bool, reason: string }; rzuca tylko dla
// prawdziwych bledow I/O (np. brak uprawnien do zapisu), nigdy dla "nie ma
// nic do migracji".
//
// Zasady:
//  1. Jesli plik uzytkownika jest juz KOMPLETNY - nic nie robimy (nigdy nie
//     nadpisujemy recznie skonfigurowanego OCR).
//  2. Inaczej, jesli wbudowana konfiguracja jest KOMPLETNA - kopiujemy klucz
//     konta serwisowego do trwalego katalogu uzytkownika i piszemy tam nowy
//     plik konfiguracyjny wskazujacy na te kopie (zapis atomowy).
//  3. Inaczej nie ma nic do migracji (zwykla instalacja bez wbudowanego OCR).
// Po potwierdzonej migracji usuwa wbudowana kopie z folderu programu, zeby
// kolejne (publiczne, bez sekretow) aktualizacje nie mialy czego nadpisywac.
function migrateOcrConfigIfNeeded(appRootDir, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const userPath = userConfigPath();
  const userDir = path.dirname(userPath);

  if (isCompleteConfig(readJsonSafe(userPath), userDir)) {
    return { migrated: false, reason: 'user-config-already-complete' };
  }

  const configDir = bundledConfigDir(appRootDir);
  const bundledConfigPath = path.join(configDir, 'document-ai.json');
  const bundledConfig = readJsonSafe(bundledConfigPath);
  if (!isCompleteConfig(bundledConfig, configDir)) {
    return { migrated: false, reason: bundledConfig ? 'bundled-config-incomplete' : 'no-bundled-config' };
  }

  const sourceKeyFile = resolveKeyFile(bundledConfig.keyFile, configDir);
  const destKeyFile = path.join(userDir, 'service-account.json');
  atomicCopyFile(sourceKeyFile, destKeyFile);
  atomicWriteJson(userPath, {
    projectId: String(bundledConfig.projectId).trim(),
    location: String(bundledConfig.location).trim(),
    processorId: String(bundledConfig.processorId).trim(),
    keyFile: 'service-account.json'
  });

  // Nigdy nie logujemy TRESCI klucza - tylko fakt migracji i sciezki plikow
  // (same sciezki nie sa sekretem).
  log('info', 'ocr-config-migrated', { from: bundledConfigPath, to: userPath });

  // Usuwamy wbudowana kopie TYLKO po potwierdzeniu, ze docelowa kopia
  // faktycznie istnieje i jest kompletna - nigdy nie zostajemy bez zadnej
  // dzialajacej konfiguracji przy nieudanym zapisie.
  if (isCompleteConfig(readJsonSafe(userPath), userDir)) {
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch (_) {}
  }

  return { migrated: true, reason: 'migrated-from-bundled' };
}

function isValidServiceAccountJson(parsed) {
  return Boolean(
    parsed && typeof parsed === 'object' &&
    parsed.type === 'service_account' &&
    String(parsed.private_key || '').trim() &&
    String(parsed.project_id || '').trim()
  );
}

// Zapisuje recznie wprowadzona konfiguracje OCR (patrz apps/ocr-audytow
// POST /api/ocr/setup-credentials - ekran "OCR zablokowany" pokazywany, gdy
// isConfigured() zwraca false) do tego samego trwalego katalogu uzytkownika
// co migrateOcrConfigIfNeeded - jedno miejsce definiujace te sciezki, zeby
// nigdy nie rozjechaly sie z documentAiEngine.js#USER_CONFIG_PATH.
// Rzuca czytelny blad po polsku przy pierwszym niespelnionym warunku -
// wywolujacy (route Express) zamienia go bezposrednio na 400 z tym samym
// tekstem, wiec komunikat musi byc juz gotowy do pokazania uzytkownikowi.
function saveUserOcrConfig({ keyFileContent, location, processorId, projectId }) {
  let parsedKey;
  try {
    parsedKey = JSON.parse(keyFileContent);
  } catch (_) {
    throw new Error('Plik klucza nie jest poprawnym JSON-em.');
  }
  if (!isValidServiceAccountJson(parsedKey)) {
    throw new Error('Plik nie wyglada jak poprawny klucz konta serwisowego Google (brak "type": "service_account" albo private_key).');
  }

  const resolvedProjectId = String(projectId || '').trim() || String(parsedKey.project_id || '').trim();
  const resolvedLocation = String(location || '').trim();
  const resolvedProcessorId = String(processorId || '').trim();
  if (!resolvedProjectId) throw new Error('Brak identyfikatora projektu (projectId) - ani podanego, ani odczytanego z pliku klucza.');
  if (!resolvedLocation) throw new Error('Podaj lokalizacje procesora Document AI (np. "eu").');
  if (!resolvedProcessorId) throw new Error('Podaj ID procesora Document AI.');

  const userPath = userConfigPath();
  const userDir = path.dirname(userPath);
  const destKeyFile = path.join(userDir, 'service-account.json');
  atomicWriteJson(destKeyFile, parsedKey);
  atomicWriteJson(userPath, {
    projectId: resolvedProjectId,
    location: resolvedLocation,
    processorId: resolvedProcessorId,
    keyFile: 'service-account.json'
  });

  return { projectId: resolvedProjectId, location: resolvedLocation, processorId: resolvedProcessorId };
}

module.exports = {
  userConfigPath,
  bundledConfigDir,
  isCompleteConfig,
  migrateOcrConfigIfNeeded,
  isValidServiceAccountJson,
  saveUserOcrConfig
};
