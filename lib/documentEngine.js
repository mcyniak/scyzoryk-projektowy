// Node-owa fasada nad Scyzoryk.DocumentEngine.exe (tools/Scyzoryk.DocumentEngine,
// C#/.NET 8, Microsoft Open XML SDK) - silnik strukturalnych operacji na DOCX
// dzialajacy BEZ Word/COM/WINWORD.EXE (patrz CLAUDE.md, "Migracja Word COM ->
// Open XML", audyt zaczety 2026-09-14 po naprawie skanera Kreatora
// - commit 1e69ade).
//
// Wywolanie helpera: jeden plik JSON wejsciowy, jeden wyjsciowy (sekcja 2
// promptu migracji - "nie przez duze argumenty CLI"), exit code 0/1. Ta
// fasada nie wie NIC o Open XML/OOXML - apps/kreator-wzorow ma znac tylko
// scanTemplatePalette/scanTemplateCandidates/buildSmartTemplate.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readJsonFileNoBom, writeJsonFileNoBom } = require('./hardening');

const REPO_ROOT = path.join(__dirname, '..');

// Kolejnosc szukania exe (pierwszy istniejacy wygrywa):
//   1) override na potrzeby testow/CI,
//   2) uklad instalatora - Scyzoryk.DocumentEngine.exe stoi obok Scyzoryk.exe
//      w katalogu instalacji (patrz scripts/build-installer.ps1),
//   3) uklad deweloperski - po recznym uruchomieniu
//      scripts/build-document-engine.ps1 (patrz tam - stale, znane miejsce
//      wyjsciowe, NIE domyslna, zagniezdzona sciezka `dotnet publish`).
function resolveEnginePath() {
  const candidates = [
    process.env.SCYZORYK_DOCUMENT_ENGINE_PATH,
    path.join(REPO_ROOT, 'Scyzoryk.DocumentEngine.exe'),
    path.join(REPO_ROOT, 'tools', 'Scyzoryk.DocumentEngine', 'publish', 'Scyzoryk.DocumentEngine.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Sekcja 3 promptu migracji: "W dev brak helpera ma dawac czytelny
  // komunikat jak go zbudowac, a nie surowy ENOENT."
  throw new Error(
    'Nie znaleziono Scyzoryk.DocumentEngine.exe (silnik Open XML do obslugi DOCX). ' +
    'Zbuduj go poleceniem: powershell -File scripts/build-document-engine.ps1 ' +
    '(wymaga .NET SDK 8 - https://dotnet.microsoft.com/download/dotnet/8.0). ' +
    `Szukano w: ${candidates.join(', ')}`
  );
}

function tempJsonPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
}

// Uruchamia jedno polecenie helpera: zapisuje input do pliku tymczasowego,
// czeka na zakonczenie procesu, czyta output. NIGDY nie rzuca na exit code
// != 0 samo z siebie - zwraca cokolwiek helper zapisal w OutputJson (ktore
// samo niesie {ok:false, message:...} dla kontrolowanych bledow), zeby
// wywolujacy mogl pokazac czytelny polski komunikat zamiast surowego kodu
// wyjscia. Rzuca WYLACZNIE gdy proces nie da sie w ogole uruchomic/nie
// zapisal poprawnego JSON-a (awaria samego helpera, nie logiki biznesowej).
function runEngineCommand(command, input, options = {}) {
  const enginePath = resolveEnginePath();
  const timeoutMs = Number(options.timeoutMs || 2 * 60 * 1000);
  const inputPath = tempJsonPath(`docengine-in-${command}`);
  const outputPath = tempJsonPath(`docengine-out-${command}`);
  writeJsonFileNoBom(inputPath, input);

  return new Promise((resolve, reject) => {
    const child = spawn(enginePath, [command, inputPath, outputPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) { /* proces mogl juz zakonczyc sie miedzyczasie */ }
      reject(new Error(`Silnik dokumentow (${command}) przekroczyl limit czasu ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();

    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Nie udalo sie uruchomic silnika dokumentow: ${err.message}`));
    });

    child.on('close', () => {
      clearTimeout(timer);
      let output;
      try {
        output = readJsonFileNoBom(outputPath);
      } catch (err) {
        reject(new Error(`Silnik dokumentow (${command}) nie zwrocil poprawnego wyniku JSON.${stderr ? ' ' + stderr.trim() : ''}`));
        return;
      } finally {
        try { fs.unlinkSync(inputPath); } catch (_) { /* plik tymczasowy - brak sprzatania nie jest krytyczny */ }
        try { fs.unlinkSync(outputPath); } catch (_) { /* jw. */ }
      }
      resolve(output);
    });
  });
}

// --- API dla apps/kreator-wzorow (ETAP 2 migracji) --------------------------

async function scanTemplatePalette(templatePath) {
  return runEngineCommand('scan-palette', { templatePath });
}

async function scanTemplateCandidates(templatePath, selectedMarkings) {
  return runEngineCommand('scan-candidates', { templatePath, selectedMarkings });
}

// draft = { candidates: {id: {status, constantText, fieldId, blockId}},
//           fields: {id: {mergeFieldName, ...}}, blocks: {id: {bookmarkName, ...}} }
async function buildSmartTemplate({ templatePath, outputPath, selectedMarkings, storedCandidates, draft, manifestJson }) {
  const candidateDecisions = {};
  for (const [id, decision] of Object.entries(draft.candidates || {})) {
    candidateDecisions[id] = {
      status: decision.status,
      constantText: decision.constantText ?? null,
      fieldId: decision.fieldId ?? null,
      blockId: decision.blockId ?? null,
    };
  }
  const fields = {};
  for (const [id, def] of Object.entries(draft.fields || {})) {
    fields[id] = { mergeFieldName: def.mergeFieldName };
  }
  const blocks = {};
  for (const [id, def] of Object.entries(draft.blocks || {})) {
    blocks[id] = { bookmarkName: def.bookmarkName };
  }

  return runEngineCommand('build-template', {
    templatePath,
    outputPath,
    selectedMarkings,
    storedCandidates,
    candidateDecisions,
    fields,
    blocks,
    manifestJson,
  }, { timeoutMs: Number(process.env.SCYZORYK_DOCUMENT_ENGINE_BUILD_TIMEOUT_MS || 5 * 60 * 1000) });
}

module.exports = {
  resolveEnginePath,
  scanTemplatePalette,
  scanTemplateCandidates,
  buildSmartTemplate,
};
