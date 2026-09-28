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

// Pliki tymczasowe silnika w %TEMP%: JSON-y wejscia/wyjscia (dane adresowe
// z Excela) i katalogi robocze konwertera PDF (Pdf/PdfRenderers.cs). Normalnie
// sprzata je ten, kto je zalozyl - zostaja tylko po twardym zabiciu procesu
// (restart komputera w trakcie, zabicie drzewa procesow). Dlatego raz na
// proces Node, przy pierwszym uzyciu silnika, usuwamy takie pozostalosci
// starsze niz maxAgeMs (dluzej niz najdluzszy limit czasu zadania).
const STALE_TEMP_PATTERNS = [
  /^docengine-(in|out)-[a-z-]+-\d+-[0-9a-f]{12}\.json$/i,
  /^scyzoryk_x2t_[0-9a-f]{32}$/i,
  /^scyzoryk_pdf_[0-9a-f]{32}\.docx$/i,
  /^scyzoryk_fonts_[0-9a-f]{32}\.docbuilder$/i,
];
const STALE_TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function cleanupStaleEngineTempFiles(options = {}) {
  const dir = options.dir || os.tmpdir();
  const maxAgeMs = Number(options.maxAgeMs ?? STALE_TEMP_MAX_AGE_MS);
  const now = Number(options.now ?? Date.now());
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const removed = [];
  for (const name of entries) {
    if (!STALE_TEMP_PATTERNS.some(re => re.test(name))) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch (_) { /* plik w uzyciu albo juz usuniety - sprobujemy przy nastepnym starcie */ }
  }
  return removed;
}

let staleTempSwept = false;
function sweepStaleTempOnce() {
  if (staleTempSwept) return;
  staleTempSwept = true;
  try { cleanupStaleEngineTempFiles(); } catch (_) { /* sprzatanie nigdy nie blokuje zadania */ }
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
  sweepStaleTempOnce();
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
// Stare skrypty PowerShell/Word COM (mailmerge-to-pdf.ps1, convert-wm.ps1,
// docx-to-pdf.ps1) zostaly usuniete - silnik jest jedyna sciezka, a Word
// pojawia sie juz tylko jako awaryjny renderer PDF (patrz nizej), gdy na
// komputerze brak konwertera ONLYOFFICE x2t.
function isEngineAvailable() {
  try { resolveEnginePath(); return true; } catch (_) { return false; }
}

// Katalog konwertera PDF bez Worda: ONLYOFFICE x2t.exe (AGPL v3, osobny,
// niezmodyfikowany program - patrz scripts/fetch-onlyoffice-x2t.ps1 i
// tools/Scyzoryk.DocumentEngine/Pdf/PdfRenderers.cs). Kolejnosc szukania
// (pierwszy katalog z x2t.exe wygrywa):
//   1) SCYZORYK_ONLYOFFICE_DIR (testy/CI, reczne wskazanie),
//   2) uklad instalatora - <katalog instalacji>/onlyoffice obok
//      Scyzoryk.DocumentEngine.exe (scripts/build-installer.ps1),
//   3) uklad deweloperski - tools/onlyoffice (po fetch-onlyoffice-x2t.ps1).
// Pusty string = brak konwertera (PDF zapisze wtedy Word, jesli jest).
function resolveOnlyOfficeDir() {
  const candidates = [
    process.env.SCYZORYK_ONLYOFFICE_DIR,
    path.join(REPO_ROOT, 'onlyoffice'),
    path.join(REPO_ROOT, 'tools', 'onlyoffice'),
  ].filter(value => typeof value === 'string' && value.trim());
  for (const candidate of candidates) {
    const dir = path.resolve(candidate.trim());
    if (fs.existsSync(path.join(dir, 'x2t.exe'))) return dir;
  }
  return '';
}

// onlyoffice | word. Domyslnie ONLYOFFICE x2t, gdy jest dostepny; inaczej
// Word (wylacznie do zapisu gotowego DOCX jako PDF). SCYZORYK_PDF_RENDERER
// wymusza tryb - "onlyoffice" bez x2t konczy sie czytelnym bledem silnika
// zamiast cichego powrotu do Worda.
function getPdfRendererMode() {
  const forced = String(process.env.SCYZORYK_PDF_RENDERER || '').trim().toLowerCase();
  if (forced === 'word' || forced === 'onlyoffice') return forced;
  return resolveOnlyOfficeDir() ? 'onlyoffice' : 'word';
}

// Czy zadanie realnie uruchomi Worda (trzeba wtedy wziac lease z
// lib/wordAutomationCoordinator, jak dotad) - wylacznie gdy PDF zapisuje Word.
function engineUsesWord() {
  return getPdfRendererMode() === 'word';
}

// Pola wejscia silnika wybierajace renderer PDF (MailMergeInput,
// RenderPdfInput, ConvertWmInput w C#: PdfRenderer + OnlyOfficeDir).
function pdfRendererInput() {
  return { pdfRenderer: getPdfRendererMode(), onlyOfficeDir: resolveOnlyOfficeDir() || null };
}

// Mail merge ze strumieniem zdarzen: zwraca proces potomny, ktorego stdout
// niesie te same linie JSON co dawny mailmerge-to-pdf.ps1 (server.js
// Dokumentow seryjnych parsuje je bez zmian). Pliki JSON sprzata wywolujacy
// przez cleanup() po zakonczeniu procesu.
function spawnMailMerge(input, options = {}) {
  const enginePath = resolveEnginePath();
  sweepStaleTempOnce();
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
  // Sprzatanie niezaleznie od wywolujacego - plik wejsciowy niesie dane
  // adresowe z Excela, nie moze zostac w %TEMP%.
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
  getPdfRendererMode,
  resolveOnlyOfficeDir,
  pdfRendererInput,
  engineUsesWord,
  spawnMailMerge,
  renderDocxBatchToPdf,
  convertWniosekMaterialowy,
  runEngineCommand,
  cleanupStaleEngineTempFiles,
};
