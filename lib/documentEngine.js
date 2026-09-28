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
    // Anulowanie zadania z UI (np. Wnioski powykonawcze trzymaja job.child).
    if (typeof options.onSpawn === 'function') options.onSpawn(child);
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

// --- Generowanie dokumentow bez Worda (Dokumenty seryjne, podglad Kreatora,
//     Wnioski powykonawcze, DOCX->PDF w drukarkach) ------------------------
//
// Przelacznik awaryjny (na jedna wersje, do usuniecia po potwierdzeniu na
// produkcji): SCYZORYK_DOKUMENTY_ENGINE=word wraca do starych skryptow
// PowerShell/Word COM. Domyslnie: nowy silnik, jesli exe jest dostepne.
function isEngineAvailable() {
  try { resolveEnginePath(); return true; } catch (_) { return false; }
}

function getDocumentEngineMode() {
  const forced = String(process.env.SCYZORYK_DOKUMENTY_ENGINE || '').trim().toLowerCase();
  if (forced === 'word') return 'word';
  if (forced === 'openxml') return 'openxml';
  return isEngineAvailable() ? 'openxml' : 'word';
}

// Klucz licencji Syncfusion (renderer PDF bez Worda): zmienna srodowiskowa
// albo plik tekstowy w katalogu danych (zeby dalo sie go wgrac bez
// przebudowy instalatora): <dataRoot>/licencje/syncfusion.txt.
function resolveSyncfusionLicenseKey() {
  const fromEnv = String(process.env.SCYZORYK_SYNCFUSION_LICENSE_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const candidates = [];
  try {
    const { getDataRoot } = require('./appPaths');
    candidates.push(path.join(getDataRoot(), 'licencje', 'syncfusion.txt'));
  } catch (_) { /* brak katalogu danych (np. testy) - zostaje repo */ }
  candidates.push(path.join(REPO_ROOT, 'licencje', 'syncfusion.txt'));
  for (const file of candidates) {
    try {
      const key = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
      if (key) return key;
    } catch (_) { /* plik nie istnieje - szukamy dalej */ }
  }
  return '';
}

// auto | syncfusion | word. "auto": Syncfusion gdy jest klucz, inaczej Word
// (wylacznie do zapisu gotowego DOCX jako PDF).
function getPdfRendererMode() {
  const forced = String(process.env.SCYZORYK_PDF_RENDERER || '').trim().toLowerCase();
  if (forced === 'word' || forced === 'syncfusion') return forced;
  return resolveSyncfusionLicenseKey() ? 'syncfusion' : 'word';
}

// Czy zadanie realnie uruchomi Worda (trzeba wtedy wziac lease z
// lib/wordAutomationCoordinator, jak dotad).
function engineUsesWord() {
  return getDocumentEngineMode() === 'word' || getPdfRendererMode() === 'word';
}

function pdfRendererInput() {
  return { pdfRenderer: getPdfRendererMode(), syncfusionLicenseKey: resolveSyncfusionLicenseKey() || null };
}

// Mail merge ze strumieniem zdarzen: zwraca proces potomny, ktorego stdout
// niesie te same linie JSON co dawny mailmerge-to-pdf.ps1 (server.js
// Dokumentow seryjnych parsuje je bez zmian). Pliki JSON sprzata wywolujacy
// przez cleanup() po zakonczeniu procesu.
function spawnMailMerge(input, options = {}) {
  const enginePath = resolveEnginePath();
  const inputPath = tempJsonPath('docengine-in-mail-merge');
  const outputPath = tempJsonPath('docengine-out-mail-merge');
  writeJsonFileNoBom(inputPath, { ...pdfRendererInput(), ...input });
  const child = spawn(enginePath, ['mail-merge', inputPath, outputPath], {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cleanup = () => {
    try { fs.unlinkSync(inputPath); } catch (_) { /* plik tymczasowy */ }
    try { fs.unlinkSync(outputPath); } catch (_) { /* jw. */ }
  };
  // Sprzatanie niezaleznie od wywolujacego - plik wejsciowy moze zawierac
  // klucz licencji, nie moze zostac w %TEMP%.
  child.on('close', cleanup);
  child.on('error', cleanup);
  return { child, outputPath, cleanup, enginePath };
}

async function renderDocxBatchToPdf(files, options = {}) {
  return runEngineCommand('render-pdf', { ...pdfRendererInput(), files }, { timeoutMs: options.timeoutMs || 10 * 60 * 1000 });
}

async function convertWniosekMaterialowy(input, options = {}) {
  return runEngineCommand('convert-wm', { ...pdfRendererInput(), ...input }, { timeoutMs: options.timeoutMs || 60 * 60 * 1000, onSpawn: options.onSpawn });
}

module.exports = {
  resolveEnginePath,
  scanTemplatePalette,
  scanTemplateCandidates,
  buildSmartTemplate,
  isEngineAvailable,
  getDocumentEngineMode,
  getPdfRendererMode,
  resolveSyncfusionLicenseKey,
  engineUsesWord,
  spawnMailMerge,
  renderDocxBatchToPdf,
  convertWniosekMaterialowy,
  runEngineCommand,
};
