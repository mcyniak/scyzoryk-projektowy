const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const readExcelFile = require('read-excel-file/node').default;
const sanitize = require('sanitize-filename');
const archiverModule = require('archiver');
const archiver = typeof archiverModule === 'function' ? archiverModule : (archiverModule.default || archiverModule.create || archiverModule.archiver);
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { setupProcessDiagnostics, applyHttpTimeouts, createSerialQueue, stripBom, writeJsonFileNoBom, readJsonFileNoBom, scheduleCleanup } = require('../../lib/hardening');
const investmentScan = require('./src/investmentScan');
const ozcMatch = require('./src/ozcMatch');


function assertArchiverAvailable() {
  if (typeof archiver !== 'function') {
    throw new Error('Nie udało się przygotować paczki ZIP. Uruchom ponownie instalację zależności.');
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
setupProcessDiagnostics('dokumenty-seryjne', ROOT);
const wordQueue = createSerialQueue('dokumenty-seryjne-word');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const MAX_FILE_MB = Number(process.env.SERYJNE_MAX_FILE_MB || 80);
const MAX_ROWS = Number(process.env.SERYJNE_MAX_ROWS || 500);
const JOB_TTL_MS = Number(process.env.SERYJNE_JOB_TTL_MS || 24 * 60 * 60 * 1000);
const PS_SCRIPT = path.join(ROOT, 'scripts', 'mailmerge-to-pdf.ps1');
const SCAN_SCRIPT = path.join(ROOT, 'scripts', 'scan-placeholders.ps1');

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(dir, { recursive: true });
scheduleCleanup([UPLOAD_DIR, OUTPUT_DIR], JOB_TTL_MS, 60 * 60 * 1000);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};
app.disable('x-powered-by');
app.use((req, res, next) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); next(); });
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Scyzoryk-Request') === '1') return next();
  return res.status(403).json({ ok: false, message: 'Odśwież stronę i spróbuj ponownie.' });
});
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.SERYJNE_API_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  // /api/health i /api/job/:jobId sa odpytywane co kilka sekund (panel glowny) albo co 1s
  // (pasek postepu podczas generowania, ktore realnie trwa kilka minut) - bez wylaczenia stad
  // sam odczyt statusu wyczerpuje limit w ~1 minute i pasek postepu przestaje sie aktualizowac,
  // mimo ze generowanie dalej trwa w tle.
  skip: (req) => req.method === 'GET' && (req.path === '/health' || /^\/job\/[^/]+$/.test(req.path)),
  message: { ok: false, message: 'Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.SERYJNE_HEAVY_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za duzo ciezkich zadan w krotkim czasie. Uruchom mniejsza paczke albo odczekaj chwile.' }
});
app.use('/api', apiLimiter);

app.use(express.static(path.join(ROOT, 'public')));

const jobs = new Map();
const JOBS_INDEX = path.join(DATA_DIR, 'jobs.json');


function persistJobsIndex() {
  try {
    const items = [...jobs.values()].map(job => ({
      id: job.id,
      createdAt: job.createdAt,
      touchedAt: job.touchedAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      status: job.status,
      progress: job.progress,
      result: job.result,
      outputDir: job.outputDir,
      logPath: job.logPath,
      debugJsonPath: job.debugJsonPath,
      template: job.template,
      templateGroups: job.templateGroups,
      excel: job.excel,
      workbook: job.workbook ? {
        sheetNames: job.workbook.sheetNames || [],
        sheetName: job.workbook.sheetName || '',
        columns: job.workbook.columns || [],
        rows: job.workbook.rows || [],
        totalRows: job.workbook.totalRows || 0,
        truncatedAt: job.workbook.truncatedAt || null,
        summaries: job.workbook.summaries || []
      } : null
    }));
    writeJsonFileNoBom(JOBS_INDEX, { savedAt: new Date().toISOString(), jobs: items });
  } catch (err) {
    console.error('[ser-jobs-index]', err?.message || err);
  }
}

function restoreJobsIndex() {
  try {
    if (!fs.existsSync(JOBS_INDEX)) return;
    const data = readJsonFileNoBom(JOBS_INDEX);
    for (const item of data.jobs || []) {
      if (!item?.id || !item.outputDir || !fs.existsSync(item.outputDir)) continue;
      jobs.set(item.id, {
        id: item.id,
        createdAt: Number(item.createdAt || Date.now()),
        touchedAt: Number(item.touchedAt || Date.now()),
        startedAt: item.startedAt || null,
        endedAt: item.endedAt || null,
        template: item.template || null,
        templateGroups: item.templateGroups || null,
        excel: item.excel || null,
        workbook: item.workbook || null,
        outputDir: item.outputDir,
        logPath: item.logPath || path.join(item.outputDir, 'log.txt'),
        debugJsonPath: item.debugJsonPath || path.join(item.outputDir, 'debug-events.jsonl'),
        status: item.status || 'restored',
        progress: item.progress || { phase: 'restored', percent: 100, message: 'Zadanie odtworzone po restarcie.', updatedAt: nowIso() },
        logs: [],
        result: item.result || null,
        child: null
      });
    }
  } catch (err) {
    console.error('[ser-jobs-restore]', err?.message || err);
  }
}
restoreJobsIndex();

function safeName(name, fallback = 'plik') {
  const cleaned = sanitize(String(name || fallback)).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return (cleaned || fallback).slice(0, 140);
}

// Node.js pozwala w surowych naglowkach HTTP tylko na znaki Latin-1. Polskie
// znaki takie jak Z, N, A, L, E, S, Z (poza o/O) wywalaly caly request bledem
// "Invalid character in header content [\"Content-Disposition\"]" przy
// pobieraniu ZIP-a/PDF-a z polskim adresem w nazwie pliku. Budujemy naglowek
// zgodnie z RFC 6266/5987: ASCII-owy fallback w filename= (dla starych
// klientow) i poprawnie zakodowana pelna nazwa w filename*=UTF-8''...
function contentDispositionHeader(disposition, filename) {
  const raw = String(filename || 'plik').replace(/"/g, '');
  const asciiFallback = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_') || 'plik';
  const encoded = encodeURIComponent(raw).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function cleanFilePrefix(prefix) {
  let value = sanitize(String(prefix || '')).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  if (!value) return '';
  return value.slice(0, 80);
}

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

function readHeader(filePath, length = 8) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

function validateOfficeFile(file, expectedExts) {
  const original = decodeOriginalName(file.originalname || '');
  const ext = path.extname(original).toLowerCase();
  if (!expectedExts.includes(ext)) throw new Error(`Nieprawidłowy plik: ${original}`);
  const header = readHeader(file.path, 4).toString('latin1');
  if (!header.startsWith('PK')) throw new Error(`Plik ${original} nie wygląda jak poprawny ${expectedExts.join('/')} .`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = safeName(decodeOriginalName(file.originalname), 'plik');
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${original}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 400 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeOriginalName(file.originalname || '')).toLowerCase();
    if ((file.fieldname === 'template' || file.fieldname === 'templates') && (ext === '.docx' || ext === '.pdf')) return cb(null, true);
    if (file.fieldname === 'excel' && ext === '.xlsx') return cb(null, true);
    return cb(new Error('Wybierz szablony DOCX i tabelę XLSX.'));
  }
});

async function purgeJobArtifacts(job) {
  const paths = [job?.outputDir, job?.template?.path, job?.excel?.path].filter(Boolean);
  for (const p of paths) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
}

async function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt <= JOB_TTL_MS) continue;
    await purgeJobArtifacts(job);
    jobs.delete(id);
    persistJobsIndex();
  }
}
setInterval(() => cleanupOldJobs().catch(err => console.error('[ser-cleanup]', err?.message || err)), 60 * 60 * 1000).unref();

function nowIso() { return new Date().toISOString(); }

function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.touchedAt = Date.now();
  return job;
}

function appendLog(job, level, message, data) {
  const item = { time: nowIso(), level, message, ...(data ? { data } : {}) };
  job.logs.push(item);
  if (job.logs.length > 600) job.logs.splice(0, job.logs.length - 600);
  const line = `[${item.time}] [${level.toUpperCase()}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\r\n`;
  if (job.logPath) {
    try { fs.appendFileSync(job.logPath, line, 'utf8'); } catch {}
  }
  return item;
}

function setProgress(job, patch) {
  job.progress = { ...job.progress, ...patch, updatedAt: nowIso() };
}



function formatExcelDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  const dd = String(value.getDate()).padStart(2, '0');
  const mm = String(value.getMonth() + 1).padStart(2, '0');
  const yyyy = value.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function excelCellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return formatExcelDate(value);
  return String(value).trim();
}

// Arkusze robione recznie przez ludzi czasem maja DWIE kolumny o tej samej
// nazwie (identycznej albo roznej tylko wielkoscia liter, np. "zdjecia" i
// "Zdjecia") - PowerShell przy ConvertFrom-Json jest case-insensitive na
// kluczach i wywala sie na takiej kolizji (widziane realnie: "Cannot convert
// the JSON string because a dictionary... contains the duplicated keys").
// Dopisujemy numer porzadkowy do kazdego powtorzenia (od drugiego), zeby
// nazwy byly naprawde unikalne i zadne dane nie zostaly po cichu nadpisane.
function dedupeColumnNames(columns) {
  const seen = new Map();
  return columns.map(name => {
    const key = String(name).toLowerCase().trim();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}

function worksheetRows(rawRows) {
  const inputRows = Array.isArray(rawRows) ? rawRows : [];
  let headerRowNumber = 0;
  let columns = [];

  for (let i = 0; i < inputRows.length; i += 1) {
    const row = Array.isArray(inputRows[i]) ? inputRows[i] : [];
    const values = row.map(excelCellText);
    if (values.some(value => value)) {
      headerRowNumber = i + 1;
      columns = values.map((value, index) => value || `Kolumna ${index + 1}`);
      columns = dedupeColumnNames(columns);
      break;
    }
  }

  if (!headerRowNumber) return { rows: [], headerRows: [], columns: [] };

  const rows = [];
  for (let i = headerRowNumber; i < inputRows.length; i += 1) {
    const row = Array.isArray(inputRows[i]) ? inputRows[i] : [];
    const obj = {};
    let hasData = false;
    for (let col = 0; col < columns.length; col += 1) {
      const text = excelCellText(row[col]);
      obj[columns[col]] = text;
      if (text) hasData = true;
    }
    if (hasData) rows.push(obj);
  }
  return { rows, headerRows: [columns], columns };
}

function parseSheet(workbook, sheetName) {
  const sheet = workbook?.sheetsData?.[sheetName];
  if (!sheet) throw new Error(`Nie znaleziono arkusza: ${sheetName}`);
  const parsedRows = worksheetRows(sheet.data || []);
  const filtered = parsedRows.rows.filter(row => Object.values(row).some(v => String(v || '').trim() !== ''));
  const columns = Object.keys(filtered[0] || {}).length ? Object.keys(filtered[0]) : parsedRows.columns.map(String).filter(Boolean);
  const previewRows = filtered.slice(0, MAX_ROWS).map((row, index) => ({ _record: index + 1, ...row }));
  return { sheetName, columns, rows: previewRows, totalRows: filtered.length, truncatedAt: filtered.length > MAX_ROWS ? MAX_ROWS : null };
}

function detectPowerFromText(text) {
  const s = String(text || '').replace(',', '.');
  const m = s.match(/(?:^|[^0-9])([0-9]{1,2})(?:\s*|_?)(?:kw|kW|KW)(?:[^0-9]|$)/i);
  return m ? `${Number(m[1])}kW` : '';
}

function pickDefaultSheet(sheetNames, templateName = '') {
  const wanted = detectPowerFromText(templateName);
  if (wanted) {
    const found = sheetNames.find(name => String(name).toLowerCase() === wanted.toLowerCase());
    if (found) return found;
  }
  return sheetNames[0];
}

// Dopasowuje wartosc z kolumny "wariantu" w Excelu do jednego z faktycznie
// wgranych wariantow danej grupy szablonow. Warianty NIE sa juz sztywna
// lista (dawniej ROZMIARY_SZABLONU = ['250','300','400']) - to, co jest
// prawidlowym wariantem, wynika z tego, jakie pliki/podfoldery user
// faktycznie wgral, wiec dziala to dla kazdej wielkosci/nazwy modelu.
// Dwa tryby:
// - Kolektory: komorka ma format "liczba/rozmiar" (np. "2/250") - bierzemy
//   ostatni segment po "/" i porownujemy jako liczbe z kluczami wariantow.
// - PC i podobne: caly tekst komorki to nazwa modelu (np. "Varmero VPM9020"),
//   porownywana z nazwa podfolderu (np. "VARMERO VPM 9020") po znormalizowaniu
//   (male litery, bez spacji) - odporne na rozne zapisy tej samej nazwy.
function resolveVariantKey(rawValue, variantKeys) {
  const raw = String(rawValue ?? '').trim();
  if (!raw || !variantKeys.length) return null;

  const slashParts = raw.split('/').map(s => s.trim()).filter(Boolean);
  const lastPart = slashParts[slashParts.length - 1] || raw;
  const numericMatch = lastPart.match(/^(\d+)$/);
  if (numericMatch && variantKeys.includes(numericMatch[1])) return numericMatch[1];

  const normalize = s => String(s).toLowerCase().replace(/\s+/g, '');
  const normRaw = normalize(raw);
  return variantKeys.find(k => normalize(k) === normRaw) || null;
}

// Grupuje wgrane pliki szablonow po "logicznej nazwie" - usuwa koncowke
// "_250"/"_300"/"_400" (jesli jest), zeby polaczyc np. "Protokol_250.docx",
// "Protokol_300.docx", "Protokol_400.docx" w jedna pozycje do wyboru
// "Protokol" z 3 wariantami w srodku. Szablony bez takiej koncowki (BIOZ,
// pompy, kotly) zostaja jako pojedyncza pozycja bez wariantow.
function classifyDocKind(baseName) {
  const norm = baseName.toLowerCase();
  if (/^st[_\s]/.test(norm)) return 'ST';
  if (norm.includes('bioz')) return 'BIOZ';
  if (norm.includes('opis')) return 'Opis techniczny';
  // Brak rozpoznanego skrotu - uzywamy nazwy bazowej bez koncowych cyfr/kW
  // jako "typu" (np. "Opis_techniczny 20" i "Opis_techniczny 12" i tak
  // trafilyby tu tylko gdyby nie zawieraly slowa "opis" powyzej).
  return baseName.replace(/[\s._-]*\d+\s*(kw)?\s*$/i, '').trim() || baseName;
}

// Grupuje wgrane pliki szablonow w dwa rozne sposoby, zaleznie od tego, GDZIE
// lezal plik wzgledem wybranego folderu:
// - plik lezacy WPROST w wybranym folderze (Kolektory): wariant to sufiks w
//   nazwie pliku ("Protokol_250.docx" -> grupa "Protokol", wariant "250").
// - plik lezacy w PODFOLDERZE (PC i podobne): wariant to nazwa TEGO
//   podfolderu (np. "VARMERO VPM 9020"), a "typ" dokumentu to rozpoznany
//   rodzaj (ST/BIOZ/Opis techniczny) wspolny dla wszystkich podfolderow.
// Dwa pliki tego samego typu w tym samym podfolderze (zdarza sie realnie -
// np. dwa "Opis techniczny" na rozna moc w jednym folderze modelu pompy) NIE
// sa zgadywane - trafiaja do listy "ambiguous" i sa pomijane przy grupowaniu,
// zeby uzytkownik dostal jasny komunikat zamiast cichego zlego dopasowania.
function groupTemplatesByType(templates) {
  const flat = templates.filter(t => !t.relFolder);
  const foldered = templates.filter(t => t.relFolder);
  const groups = new Map();

  for (const t of flat) {
    const base = t.originalName.replace(/\.docx$/i, '');
    const m = base.match(/^(.*)_(\d{2,4})$/);
    const groupName = m ? m[1] : base;
    const variant = m ? m[2] : null;
    if (!groups.has(groupName)) groups.set(groupName, { name: groupName, variants: {}, single: null });
    const g = groups.get(groupName);
    if (variant) g.variants[variant] = t; else g.single = t;
  }

  const byKind = new Map(); // kind -> Map(relFolder -> template)
  const ambiguous = [];
  for (const t of foldered) {
    const base = t.originalName.replace(/\.docx$/i, '');
    const kind = classifyDocKind(base);
    if (!byKind.has(kind)) byKind.set(kind, new Map());
    const perFolder = byKind.get(kind);
    if (perFolder.has(t.relFolder)) {
      ambiguous.push({ kind, relFolder: t.relFolder, files: [perFolder.get(t.relFolder).originalName, t.originalName] });
      continue;
    }
    perFolder.set(t.relFolder, t);
  }
  for (const [kind, perFolder] of byKind) {
    if (!groups.has(kind)) groups.set(kind, { name: kind, variants: {}, single: null });
    const g = groups.get(kind);
    for (const [relFolder, t] of perFolder) g.variants[relFolder] = t;
  }

  const groupList = Array.from(groups.values()).map(g => ({
    name: g.name,
    hasVariants: Object.keys(g.variants).length > 0,
    variants: g.variants,
    single: g.single
  }));
  return { groups: groupList, ambiguous };
}

// Dla kazdej zaznaczonej "logicznej" pozycji buduje liste konkretnych zadan
// generowania: {templatePath, templateOriginalName, rowRecords}. Jesli
// pozycja ma warianty (250/300/400), dzieli wybrane wiersze wg rozmiaru
// odczytanego z kolumny UID kazdego wiersza - kazdy wariant staje sie
// osobnym zadaniem z pasujaca do niego podgrupa wierszy.
function buildGenerationTasks(job, selectedGroupNames, uidColumn, selectedSheet, selectedRowRecords) {
  const tasks = [];
  const skippedRows = [];
  const allRows = selectedSheet.rows || [];
  const rowsForMerge = selectedRowRecords.length ? allRows.filter(r => selectedRowRecords.includes(Number(r._record))) : allRows;

  for (const groupName of selectedGroupNames) {
    const group = (job.templateGroups || []).find(g => g.name === groupName);
    if (!group) continue;
    if (!group.hasVariants) {
      const t = group.single || Object.values(group.variants)[0];
      if (!t) continue;
      tasks.push({ groupName, templatePath: t.path, templateOriginalName: t.originalName, rowRecords: rowsForMerge.map(r => Number(r._record)) });
    } else {
      const variantKeys = Object.keys(group.variants);
      const byVariant = new Map();
      for (const row of rowsForMerge) {
        const cellValue = uidColumn ? row[uidColumn] : '';
        const variant = resolveVariantKey(cellValue, variantKeys);
        if (!variant) {
          skippedRows.push({ record: Number(row._record), reason: `Nierozpoznany wariant ("${cellValue}") dla "${groupName}".` });
          continue;
        }
        if (!byVariant.has(variant)) byVariant.set(variant, []);
        byVariant.get(variant).push(Number(row._record));
      }
      for (const [variant, records] of byVariant) {
        const t = group.variants[variant];
        tasks.push({ groupName, templatePath: t.path, templateOriginalName: t.originalName, rowRecords: records });
      }
    }
  }
  return { tasks, skippedRows };
}

async function loadExcelWorkbook(filePath) {
  const sheets = await readExcelFile(filePath);
  const workbook = { worksheets: [], sheetsData: {} };
  for (const sheet of sheets || []) {
    const name = String(sheet.sheet || '').trim();
    if (!name) continue;
    workbook.worksheets.push({ name });
    workbook.sheetsData[name] = { name, data: sheet.data || [] };
  }
  return workbook;
}

async function parseWorkbook(filePath, preferredSheetName = '') {
  const wb = await loadExcelWorkbook(filePath);
  const sheetNames = wb.worksheets.map(sheet => sheet.name);
  if (!sheetNames.length) throw new Error('Excel nie ma żadnego arkusza.');
  const defaultSheet = preferredSheetName && sheetNames.includes(preferredSheetName) ? preferredSheetName : sheetNames[0];
  const sheets = {};
  const summaries = [];
  for (const name of sheetNames) {
    const parsed = parseSheet(wb, name);
    sheets[name] = parsed;
    summaries.push({ name, totalRows: parsed.totalRows, columns: parsed.columns.length, suggestedAddressColumn: guessAddressColumn(parsed.columns) });
  }
  const selected = sheets[defaultSheet];
  return { sheetNames, sheetName: defaultSheet, columns: selected.columns, rows: selected.rows, totalRows: selected.totalRows, truncatedAt: selected.truncatedAt, sheets, summaries };
}


function getWorkbookSheet(workbook, sheetName) {
  const requested = String(sheetName || workbook.sheetName || '').trim();
  return (requested && workbook.sheets && workbook.sheets[requested]) || (workbook.sheets && workbook.sheets[workbook.sheetName]) || workbook;
}

function guessAddressColumn(columns) {
  const normalized = columns.map(c => ({ original: c, key: String(c).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') }));
  return normalized.find(c => c.key === 'adres')?.original
    || normalized.find(c => c.key.includes('adres'))?.original
    || normalized.find(c => c.key.includes('lokalizacja'))?.original
    || columns[0]
    || 'Adres';
}

// Zgadywanie kolumny UID (potrzebne do rozpoznania wariantu 250/300/400) -
// ta sama idea co guessAddressColumn.
function guessUidColumn(columns) {
  const normalized = columns.map(c => ({ original: c, key: String(c).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') }));
  return normalized.find(c => c.key === 'uid')?.original
    || normalized.find(c => c.key.includes('uid'))?.original
    || '';
}


function cleanTextReplacements(replacements, columns, addressColumn) {
  const allowed = new Set([...(columns || []), addressColumn].filter(Boolean).map(String));
  const result = [];
  if (!Array.isArray(replacements)) return result;
  for (const item of replacements.slice(0, 50)) {
    const find = String(item?.find || '').trim();
    const column = String(item?.column || '').trim();
    const occurrenceRaw = String(item?.occurrence || 'all').trim().toLowerCase();
    if (!find || !column || !allowed.has(column)) continue;
    if (find.length > 120) continue;
    let occurrence = 0;
    if (occurrenceRaw && occurrenceRaw !== 'all' && occurrenceRaw !== 'wszystkie') {
      const n = Number(occurrenceRaw);
      if (Number.isInteger(n) && n > 0 && n <= 200) occurrence = n;
    }
    if (!result.some(r => r.find === find && r.column === column && r.occurrence === occurrence)) {
      result.push({ find, column, occurrence });
    }
  }
  return result;
}

function normalizePowerShellEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj;
}

function handlePowerShellEvent(job, evt) {
  const eventName = String(evt.event || '').toLowerCase();
  if (!eventName) return;
  if (eventName === 'start') {
    setProgress(job, { phase: 'start', current: 0, total: Number(evt.total || 0), percent: 1, message: evt.message || 'Start generowania.' });
    appendLog(job, 'info', evt.message || 'Start generowania.', evt);
  } else if (eventName === 'word-start') {
    setProgress(job, { phase: 'word', message: evt.message || 'Uruchamiam Worda.' });
    appendLog(job, 'info', evt.message || 'Uruchamiam Worda.', evt);
  } else if (eventName === 'template-clean') {
    setProgress(job, { phase: 'prepare', message: evt.message || 'Przygotowuję szablon.' });
    appendLog(job, 'info', evt.message || 'Przygotowuję szablon.', evt);
  } else if (eventName === 'record-start') {
    const current = Number(evt.current || 0);
    const total = Number(evt.total || job.progress.total || 0);
    const percent = total ? Math.max(1, Math.round(((current - 1) / total) * 100)) : job.progress.percent;
    setProgress(job, { phase: 'records', current, total, percent, message: evt.message || `Tworzę rekord ${current}/${total}` });
    appendLog(job, 'info', evt.message || `Tworzę rekord ${current}/${total}`, evt);
  } else if (eventName === 'export-start') {
    const current = Number(evt.current || 0);
    const total = Number(evt.total || job.progress.total || 0);
    const percent = total ? Math.max(1, Math.round(((current - 0.35) / total) * 100)) : job.progress.percent;
    setProgress(job, { phase: 'export', current, total, percent, message: evt.message || `Eksportuję PDF ${current}/${total}` });
    appendLog(job, 'info', evt.message || `Eksportuję PDF ${current}/${total}`, evt);
  } else if (eventName === 'export-done') {
    const current = Number(evt.current || 0);
    const total = Number(evt.total || job.progress.total || 0);
    const percent = total ? Math.max(1, Math.round(((current - 0.1) / total) * 100)) : job.progress.percent;
    setProgress(job, { phase: 'export', current, total, percent, message: evt.message || `PDF wyeksportowany ${current}/${total}` });
    appendLog(job, 'ok', evt.message || `PDF wyeksportowany ${current}/${total}`, evt);
  } else if (eventName === 'record-done') {
    const current = Number(evt.current || 0);
    const total = Number(evt.total || job.progress.total || 0);
    const percent = total ? Math.max(1, Math.round((current / total) * 100)) : job.progress.percent;
    setProgress(job, { phase: 'records', current, total, percent, message: evt.message || `Gotowy rekord ${current}/${total}` });
    appendLog(job, 'ok', evt.message || `Gotowy rekord ${current}/${total}`, evt);
  } else if (eventName === 'record-error') {
    setProgress(job, { phase: 'records', message: evt.message || 'Błąd przy rekordzie.' });
    appendLog(job, 'error', evt.message || 'Błąd przy rekordzie.', evt);
  } else if (eventName === 'finish') {
    setProgress(job, { phase: 'finish', current: Number(evt.total || job.progress.total || 0), total: Number(evt.total || job.progress.total || 0), percent: 100, message: evt.message || 'Zakończono.' });
    appendLog(job, 'ok', evt.message || 'Zakończono.', evt);
  } else if (eventName === 'fatal') {
    setProgress(job, { phase: 'error', message: evt.message || 'Błąd krytyczny.' });
    appendLog(job, 'error', evt.message || 'Błąd krytyczny.', evt);
  } else {
    appendLog(job, 'info', evt.message || eventName, evt);
  }
}

function parseJsonLines(job, chunk, state) {
  state.buffer += chunk.toString('utf8');
  const parts = state.buffer.split(/\r?\n/);
  state.buffer = parts.pop() || '';
  for (const raw of parts) {
    const line = stripBom(raw).trim();
    if (!line) continue;
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const parsed = normalizePowerShellEvent(JSON.parse(line));
        if (parsed?.event) handlePowerShellEvent(job, parsed);
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'ok')) state.final = parsed;
      } catch (err) {
        appendLog(job, 'warn', 'Nie udało się odczytać linii JSON z PowerShell.', { line, error: err.message });
      }
    } else {
      appendLog(job, 'info', line);
    }
  }
}

// Dla wierszy z pasujacym dokumentem OZC/audytu dokleja wyciagniete z niego
// pary etykieta->wartosc jako DODATKOWE wlasciwosci rekordu - TYLKO tam,
// gdzie dana kolumna jeszcze nie istnieje w wierszu Excela, wiec dane z
// Excela zawsze wygrywaja. Get-RecordValue w mailmerge-to-pdf.ps1 dziala juz
// dzis na dowolnych wlasciwosciach rekordu, wiec to nie wymaga zadnych zmian
// po stronie PowerShell. Wyniki dopasowania sa cache'owane w ramach zadania,
// zeby przy kilku grupach szablonow (ST/BIOZ/Opis techniczny) nie czytac i
// nie parsowac tego samego pliku OZC po kilka razy.
async function withOzcFallbackData(job, rows, addressColumn) {
  const ozcFolders = job.ozcFolders || [];
  if (!ozcFolders.length) return rows;
  if (!job._ozcDataCache) job._ozcDataCache = new Map();

  const result = [];
  for (const row of rows) {
    const record = Number(row._record);
    if (!job._ozcDataCache.has(record)) {
      const address = row[addressColumn];
      const idCandidate = row.ID ?? row['ID projektu'] ?? row['LP gmina'] ?? row.F ?? null;
      let ozcData = null;
      try { ozcData = await ozcMatch.getOzcDataForRow(ozcFolders, { id: idCandidate, address }); } catch (_) { ozcData = null; }
      job._ozcDataCache.set(record, ozcData);
    }
    const ozcData = job._ozcDataCache.get(record);
    if (!ozcData) { result.push(row); continue; }
    const merged = { ...row };
    // PowerShellowe ConvertFrom-Json buduje slownik BEZ rozroznienia wielkosci
    // liter w kluczach - "gmina" (z Excela) i "Gmina" (etykieta z OZC) to dla
    // niego ta sama, zduplikowana wartosc i cale parsowanie danych rzuca
    // wyjatkiem. W JS te dwa klucze sa rozne, wiec samo sprawdzenie
    // `merged[k] === undefined` tego nie wylapie - trzeba porownywac po
    // znormalizowanej (malymi literami) nazwie klucza.
    const existingKeysLower = new Set(Object.keys(merged).map(key => key.toLowerCase()));
    for (const [k, v] of Object.entries(ozcData)) {
      if (existingKeysLower.has(k.toLowerCase())) continue;
      merged[k] = v;
      existingKeysLower.add(k.toLowerCase());
    }
    result.push(merged);
  }
  return result;
}

async function startGeneration(job, options) {
  const sheetName = String(options.sheetName || job.workbook.sheetName || '').trim() || job.workbook.sheetName;
  const selectedSheet = getWorkbookSheet(job.workbook, sheetName);
  const addressColumn = String(options.addressColumn || guessAddressColumn(selectedSheet.columns || [])).trim() || 'Adres';
  const selectedRows = Array.isArray(options.selectedRows) ? options.selectedRows.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  const rowsCsv = selectedRows.join(',');
  const visibleWord = options.visibleWord === true;
  const debugMode = options.debugMode === true;
  const filePrefix = cleanFilePrefix(options.filePrefix || '');

  const allRows = selectedSheet.rows || [];
  let rowsForMerge = selectedRows.length ? allRows.filter(row => selectedRows.includes(Number(row._record))) : allRows;
  if (!rowsForMerge.length) throw new Error('Nie wybrano żadnych rekordów do wygenerowania.');
  rowsForMerge = await withOzcFallbackData(job, rowsForMerge, addressColumn);

  const dataJsonPath = path.join(job.outputDir, 'merge-data.json');
  const debugJsonPath = path.join(job.outputDir, 'debug-events.jsonl');
  const replacementJsonPath = path.join(job.outputDir, 'text-replacements.json');
  const textReplacements = cleanTextReplacements(options.textReplacements, selectedSheet.columns || [], addressColumn);
  writeJsonFileNoBom(dataJsonPath, { sheetName, addressColumn, records: rowsForMerge });
  writeJsonFileNoBom(replacementJsonPath, { rules: textReplacements });
  if (!options._keepLog) fs.writeFileSync(job.logPath, '', 'utf8');
  // BUG: brakowalo tu tego samego warunku co przy logPath - debugJsonPath byl
  // czyszczony przy KAZDYM wywolaniu startGeneration, wiec w zadaniu z wieloma
  // szablonami (np. Strona tytulowa + BIOZ) diagnostyka pierwszego szablonu
  // znikala, gdy zaczynal sie drugi (nadpisywala ja pusta zawartosc).
  if (!options._keepLog) fs.writeFileSync(debugJsonPath, '', 'utf8');

  job.status = 'running';
  job.startedAt = job.startedAt || Date.now();
  job.endedAt = null;
  job.logs = options._keepLog ? job.logs : [];
  job.debugJsonPath = debugJsonPath;
  job.progress = { phase: 'queued', current: 0, total: rowsForMerge.length, percent: 0, message: 'Przygotowuję generowanie...', updatedAt: nowIso() };
  appendLog(job, 'info', 'Start zadania.', {
    template: job.template.originalName,
    excel: job.excel.originalName,
    sheetName,
    addressColumn,
    selectedRows: selectedRows.length ? selectedRows : 'all',
    outputDir: job.outputDir,
    visibleWord,
    debugMode,
    filePrefix,
    textReplacements: textReplacements.map(r => ({ find: r.find, column: r.column, occurrence: r.occurrence || 'all' }))
  });

  const args = [
    '-TemplatePath', job.template.path,
    '-ExcelPath', job.excel.path,
    '-OutputDir', job.outputDir,
    '-SheetName', sheetName,
    '-AddressColumn', addressColumn,
    '-DataJson', dataJsonPath,
    '-LogPath', job.logPath,
    '-DebugJsonPath', debugJsonPath,
    '-ReplacementJson', replacementJsonPath
  ];
  if (filePrefix) args.push('-FilePrefix', filePrefix);
  if (rowsCsv) args.push('-RowsCsv', rowsCsv);
  if (visibleWord) args.push('-VisibleWord');
  if (debugMode) args.push('-DebugMode');

  const exe = process.env.POWERSHELL_EXE || 'powershell.exe';
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT, ...args];
  appendLog(job, 'info', 'Uruchamiam PowerShell.', { exe, script: PS_SCRIPT });

  return new Promise(resolveGeneration => {
  const child = spawn(exe, psArgs, {
    cwd: ROOT,
    windowsHide: !visibleWord,
    env: { ...process.env }
  });
  job.child = child;
  const state = { buffer: '', final: null, stderr: '' };

  const timeoutMs = Number(process.env.SERYJNE_TIMEOUT_MS || 60 * 60 * 1000);
  const timer = setTimeout(() => {
    appendLog(job, 'error', 'Przekroczono limit czasu. Zatrzymuję PowerShell.', { timeoutMs });
    try { child.kill(); } catch {}
  }, timeoutMs);

  child.stdout.on('data', data => parseJsonLines(job, data, state));
  child.stderr.on('data', data => {
    const text = data.toString('utf8');
    state.stderr += text;
    for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) appendLog(job, 'error', line);
  });
  child.on('error', err => {
    clearTimeout(timer);
    job.status = 'error';
    job.endedAt = Date.now();
    setProgress(job, { phase: 'error', percent: 100, message: err.message || 'Nie udało się uruchomić PowerShell.' });
    job.result = { ok: false, message: err.message || 'Nie udało się uruchomić PowerShell.', created: [], errors: [] };
    appendLog(job, 'error', job.result.message);
    resolveGeneration(job.result);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (state.buffer.trim()) parseJsonLines(job, '\n', state);
    job.endedAt = Date.now();
    job.child = null;

    const parsed = state.final;
    if (parsed) {
      const files = (parsed.created || []).map(item => ({ ...item, url: `/api/download/${job.id}/${encodeURIComponent(item.file)}` }));
      job.status = parsed.ok ? 'done' : 'error';
      job.result = { ...parsed, created: files, code, logUrl: `/api/download/${job.id}/logs` };
      if (parsed.ok) {
        setProgress(job, { phase: 'done', percent: 100, message: `Gotowe. Utworzono ${files.length} PDF.` });
        appendLog(job, 'ok', `Zadanie zakończone. Utworzono ${files.length} PDF.`, { code });
      persistJobsIndex();
      } else {
        setProgress(job, { phase: 'error', percent: 100, message: parsed.message || 'Zadanie zakończone błędem.' });
        appendLog(job, 'error', parsed.message || 'Zadanie zakończone błędem.', { code });
      persistJobsIndex();
      }
    } else {
      const message = state.stderr || `PowerShell zakończył się bez wyniku JSON. Kod: ${code}`;
      job.status = 'error';
      job.result = { ok: false, message, created: [], errors: [], code, logUrl: `/api/download/${job.id}/logs` };
      setProgress(job, { phase: 'error', percent: 100, message });
      appendLog(job, 'error', message, { code });
      persistJobsIndex();
    }
    resolveGeneration(job.result);
  });
  });
}

// Odpala startGeneration RAZ NA KAZDE zadanie (kazdy wybrany typ dokumentu,
// ew. rozbity na warianty 250/300/400) i skleja wyniki wszystkich w jeden
// koncowy raport. Word i tak robi jeden dokument na raz (wordQueue), wiec
// zadania robimy po kolei, nie rownolegle.
async function runMultiTemplateGeneration(job, tasks, options, skippedRows) {
  const allCreated = [];
  const allErrors = [];
  const originalTemplate = job.template;
  let first = true;
  for (const task of tasks) {
    if (!task.rowRecords.length) continue;
    job.template = { path: task.templatePath, originalName: task.templateOriginalName };
    const taskOptions = { ...options, selectedRows: task.rowRecords, _keepLog: !first, filePrefix: task.groupName };
    try {
      const result = await startGeneration(job, taskOptions);
      if (result && Array.isArray(result.created)) allCreated.push(...result.created);
      if (result && Array.isArray(result.errors)) allErrors.push(...result.errors);
      if (result && result.ok === false && (!result.created || !result.created.length)) {
        allErrors.push({ file: task.templateOriginalName, message: result.message || 'Błąd generowania.' });
      }
    } catch (err) {
      allErrors.push({ file: task.templateOriginalName, message: err.message || String(err) });
    }
    first = false;
  }
  for (const skipped of (skippedRows || [])) {
    allErrors.push({ file: `rekord ${skipped.record}`, message: skipped.reason });
  }
  job.template = originalTemplate;
  const message = `Wygenerowano ${allCreated.length} plik(ów) z ${tasks.length} szablon(ów).` + (allErrors.length ? ` Błędów: ${allErrors.length}.` : '');
  job.result = { ok: allCreated.length > 0, created: allCreated, errors: allErrors, message, logUrl: `/api/download/${job.id}/logs` };
  job.status = allCreated.length > 0 ? 'done' : 'error';
  job.endedAt = Date.now();
  setProgress(job, { phase: job.status === 'done' ? 'done' : 'error', percent: 100, message });
  persistJobsIndex();
  return job.result;
}

const { registerFolderRoutes } = require('./src/folderRoutes');
registerFolderRoutes(app, {
  multer, storage, MAX_FILE_MB, heavyJobLimiter, jobs, OUTPUT_DIR, ROOT, PS_SCRIPT, SCAN_SCRIPT, wordQueue,
  decodeOriginalName, validateOfficeFile, loadExcelWorkbook, parseWorkbook, getWorkbookSheet,
  getJob, persistJobsIndex, setProgress, nowIso, writeJsonFileNoBom, stripBom, archiver, contentDispositionHeader
});

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'dokumenty-seryjne', queue: wordQueue.getState() }));

app.post('/api/upload', heavyJobLimiter, upload.fields([{ name: 'template', maxCount: 1 }, { name: 'templates', maxCount: 60 }, { name: 'excel', maxCount: 1 }]), async (req, res) => {
  try {
    const excel = req.files?.excel?.[0];
    if (!excel) return res.status(400).json({ ok: false, message: 'Dodaj tabelę Excel XLSX.' });
    validateOfficeFile(excel, ['.xlsx']);

    const investmentPath = String(req.body?.investmentPath || '').trim();
    let templateInfos;
    let ozcFolders = [];

    if (investmentPath) {
      // Tryb "folder inwestycji": uzytkownik podaje tylko sciezke, program
      // sam znajduje w niej folder ze wzorami (moze byc kilka - wtedy trzeba
      // wybrac) oraz folder(y) z danymi OZC/audytow do uzupelnienia
      // dodatkowych pol przy generowaniu.
      let stat;
      try { stat = fs.statSync(investmentPath); } catch (_) { stat = null; }
      if (!stat || !stat.isDirectory()) return res.status(400).json({ ok: false, message: 'Nie znaleziono folderu: ' + investmentPath });

      const wzoryFolderChoice = String(req.body?.wzoryFolderChoice || '').trim();
      let chosenWzoryFolder = wzoryFolderChoice;
      if (!chosenWzoryFolder) {
        const wzoryFolders = investmentScan.findWzoryFolders(investmentPath);
        if (!wzoryFolders.length) return res.status(400).json({ ok: false, message: 'Nie znaleziono w tym folderze podfolderu ze wzorami (nazwa zawierająca "wzór"/"wzory").' });
        if (wzoryFolders.length > 1) {
          return res.json({
            ok: true,
            needsWzoryChoice: true,
            wzoryFolderOptions: wzoryFolders.map(f => ({ path: f, label: path.relative(investmentPath, f) }))
          });
        }
        chosenWzoryFolder = wzoryFolders[0];
      }

      templateInfos = investmentScan.collectTemplateFilesFromDisk(chosenWzoryFolder);
      if (!templateInfos.length) return res.status(400).json({ ok: false, message: 'Nie znaleziono plików DOCX w folderze wzorów: ' + chosenWzoryFolder });
      ozcFolders = ozcMatch.findCandidateOzcFolders(investmentPath);
    } else {
      const templateFiles = [...(req.files?.template || []), ...(req.files?.templates || [])];
      if (!templateFiles.length) return res.status(400).json({ ok: false, message: 'Dodaj co najmniej jeden szablon Word DOCX.' });
      for (const t of templateFiles) validateOfficeFile(t, ['.docx']);

      // Podfolder bezposrednio nad kazdym plikiem (np. "VARMERO VPM 9020"),
      // wysylany przez klienta jako JSON tablica rownolegla do pola 'templates'
      // (kolejnosc plikow w tym polu jest zachowana przez multer). Pole
      // 'template' (pojedynczy, starszy sposob uploadu) nie ma podfolderow.
      let relFoldersByTemplatesField = [];
      try { relFoldersByTemplatesField = JSON.parse(req.body?.templateRelFolders || '[]'); } catch (_) { relFoldersByTemplatesField = []; }
      const singleTemplateFiles = req.files?.template || [];
      const multiTemplateFiles = req.files?.templates || [];
      templateInfos = [
        ...singleTemplateFiles.map(t => ({ path: t.path, originalName: decodeOriginalName(t.originalname), relFolder: '' })),
        ...multiTemplateFiles.map((t, i) => ({ path: t.path, originalName: decodeOriginalName(t.originalname), relFolder: String(relFoldersByTemplatesField[i] || '') }))
      ];
    }

    const sheetNames = (await loadExcelWorkbook(excel.path)).worksheets.map(sheet => sheet.name);
    const defaultSheet = pickDefaultSheet(sheetNames, templateInfos[0].originalName);
    const workbook = await parseWorkbook(excel.path, defaultSheet);
    const jobId = crypto.randomUUID();
    const outDir = path.join(OUTPUT_DIR, jobId);
    await fsp.mkdir(outDir, { recursive: true });

    const { groups: templateGroups, ambiguous: ambiguousTemplates } = groupTemplatesByType(templateInfos);

    const job = {
      id: jobId,
      createdAt: Date.now(),
      touchedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      template: templateInfos[0],
      templateGroups,
      ozcFolders,
      excel: { path: excel.path, originalName: decodeOriginalName(excel.originalname) },
      workbook,
      outputDir: outDir,
      logPath: path.join(outDir, 'log.txt'),
      debugJsonPath: path.join(outDir, 'debug-events.jsonl'),
      status: 'uploaded',
      progress: { phase: 'uploaded', current: 0, total: workbook.totalRows, percent: 0, message: 'Pliki wczytane. Możesz rozpocząć generowanie.', updatedAt: nowIso() },
      logs: [],
      result: null,
      child: null
    };
    jobs.set(jobId, job);
    persistJobsIndex();
    appendLog(job, 'info', 'Wczytano pliki.', { templates: templateInfos.map(t => t.originalName), excel: job.excel.originalName, rows: workbook.totalRows, sheet: workbook.sheetName, sheets: workbook.summaries, ozcFolders });
    res.json({
      ok: true,
      jobId,
      workbook,
      suggestedAddressColumn: guessAddressColumn(workbook.columns),
      suggestedUidColumn: guessUidColumn(workbook.columns),
      templateGroups: templateGroups.map(g => ({ name: g.name, hasVariants: g.hasVariants, variants: Object.keys(g.variants) })),
      ambiguousTemplates,
      ozcFoldersFound: ozcFolders.length,
      detectedTemplatePower: detectPowerFromText(templateInfos[0].originalName)
    });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się wczytać plików.' });
  }
});

app.get('/api/sheet/:jobId/:sheetName', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania. Wczytaj pliki ponownie.' });
  const sheetName = req.params.sheetName;
  const sheet = getWorkbookSheet(job.workbook, sheetName);
  if (!sheet || sheet.sheetName !== sheetName) return res.status(404).json({ ok: false, message: 'Nie znaleziono arkusza w Excelu.' });
  res.json({ ok: true, workbook: { ...sheet, sheetNames: job.workbook.sheetNames, summaries: job.workbook.summaries }, suggestedAddressColumn: guessAddressColumn(sheet.columns || []), suggestedUidColumn: guessUidColumn(sheet.columns || []) });
});

app.post('/api/generate/:jobId', heavyJobLimiter, async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania. Wczytaj pliki ponownie.' });
  if (process.platform !== 'win32') return res.status(400).json({ ok: false, message: 'Generowanie przez Word działa tylko na Windows z zainstalowanym Microsoft Office.' });
  if (job.status === 'running' || job.status === 'queued') return res.status(409).json({ ok: false, message: 'To zadanie już trwa albo czeka w kolejce Word.', queue: wordQueue.getState() });

  try {
    await fsp.mkdir(job.outputDir, { recursive: true });
    const body = req.body || {};
    const sheetName = String(body.sheetName || job.workbook.sheetName || '').trim() || job.workbook.sheetName;
    const selectedSheet = getWorkbookSheet(job.workbook, sheetName);
    const selectedRowRecords = Array.isArray(body.selectedRows) ? body.selectedRows.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    const selectedGroups = Array.isArray(body.selectedGroups) ? body.selectedGroups.filter(Boolean) : null;
    const uidColumn = String(body.uidColumn || '').trim();

    let tasks, skippedRows = [];
    if (selectedGroups && selectedGroups.length && job.templateGroups && job.templateGroups.length) {
      const built = buildGenerationTasks(job, selectedGroups, uidColumn, selectedSheet, selectedRowRecords);
      tasks = built.tasks;
      skippedRows = built.skippedRows;
      if (!tasks.length) return res.status(400).json({ ok: false, message: 'Nie znaleziono żadnych pasujących dokumentów do wygenerowania - sprawdź kolumnę UID i wybrane typy dokumentów.' });
    } else {
      tasks = [{ templatePath: job.template.path, templateOriginalName: job.template.originalName, rowRecords: selectedRowRecords.length ? selectedRowRecords : (selectedSheet.rows || []).map(r => Number(r._record)) }];
    }

    job.status = 'queued';
    persistJobsIndex();
    setProgress(job, { phase: 'queued', message: 'Zadanie czeka w kolejce Word. Word robi tylko jeden dokument naraz.', queue: wordQueue.getState() });
    wordQueue.run(() => runMultiTemplateGeneration(job, tasks, body, skippedRows)).catch(err => {
      job.status = 'error';
      job.result = { ok: false, message: err.message || 'Nie udało się uruchomić generowania.', created: [], errors: [] };
      persistJobsIndex();
      setProgress(job, { phase: 'error', percent: 100, message: job.result.message });
      appendLog(job, 'error', job.result.message);
    });
    res.status(202).json({ ok: true, jobId: job.id, status: job.status, progress: job.progress, queue: wordQueue.getState(), message: 'Dodano do kolejki. Word przetwarza zadania pojedynczo.' });
  } catch (err) {
    job.status = 'error';
    job.result = { ok: false, message: err.message || 'Nie udało się uruchomić generowania.', created: [], errors: [] };
    persistJobsIndex();
    setProgress(job, { phase: 'error', percent: 100, message: job.result.message });
    appendLog(job, 'error', job.result.message);
    res.status(500).json({ ok: false, message: job.result.message, result: job.result });
  }
});

app.post('/api/cancel/:jobId', async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  if (job.status !== 'running' || !job.child) return res.json({ ok: true, message: 'Zadanie nie jest uruchomione.', status: job.status });
  appendLog(job, 'warn', 'Użytkownik przerwał generowanie.');
  try { job.child.kill(); } catch {}
  job.status = 'error';
  job.endedAt = Date.now();
  setProgress(job, { phase: 'cancelled', percent: 100, message: 'Generowanie zostało przerwane.' });
  job.result = { ok: false, message: 'Generowanie zostało przerwane.', created: [], errors: [] };
  persistJobsIndex();
  res.json({ ok: true, message: 'Przerwano generowanie.' });
});

app.get('/api/job/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result,
    workbook: job.workbook,
    templateGroups: (job.templateGroups || []).map(g => ({ name: g.name, hasVariants: g.hasVariants, variants: Object.keys(g.variants) })),
    logs: job.logs.slice(-120),
    hasLog: Boolean(job.logPath && fs.existsSync(job.logPath)),
    logUrl: `/api/download/${job.id}/logs`,
    startedAt: job.startedAt,
    endedAt: job.endedAt
  });
});

function listJobPdfFiles(job) {
  if (!job || !job.outputDir || !fs.existsSync(job.outputDir)) return [];
  return fs.readdirSync(job.outputDir)
    .filter(file => /\.pdf$/i.test(file))
    .map(file => ({ file, fullPath: path.join(job.outputDir, file) }))
    .filter(item => fs.existsSync(item.fullPath));
}

function listJobLogFiles(job) {
  if (!job || !job.outputDir || !fs.existsSync(job.outputDir)) return [];
  const names = ['log.txt', 'debug-events.jsonl', 'merge-data.json', 'text-replacements.json'];
  return names
    .map(file => ({ file, fullPath: path.join(job.outputDir, file) }))
    .filter(item => fs.existsSync(item.fullPath));
}

function buildPlainTextDiagnostics(job) {
  const lines = [];
  lines.push('Scyzoryk Projektowy - Dokumenty seryjne PDF');
  lines.push('Diagnostyka zadania: ' + (job?.id || '-'));
  lines.push('Status: ' + (job?.status || '-'));
  lines.push('Start: ' + (job?.startedAt ? new Date(job.startedAt).toISOString() : '-'));
  lines.push('Koniec: ' + (job?.endedAt ? new Date(job.endedAt).toISOString() : '-'));
  lines.push('');
  lines.push('Wynik:');
  try { lines.push(JSON.stringify(job?.result || {}, null, 2)); } catch { lines.push(String(job?.result || '')); }
  lines.push('');
  lines.push('Logi z pamieci aplikacji:');
  for (const item of (job?.logs || [])) {
    lines.push(`[${item.time || '-'}] [${String(item.level || 'info').toUpperCase()}] ${item.message || ''}${item.data ? ' ' + JSON.stringify(item.data) : ''}`);
  }
  return lines.join('\r\n') + '\r\n';
}

function ensureLogFile(job) {
  if (!job || !job.outputDir || !fs.existsSync(job.outputDir)) return null;
  const logPath = job.logPath || path.join(job.outputDir, 'log.txt');
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 0) {
    return { file: 'log.txt', fullPath: logPath };
  }
  try {
    fs.mkdirSync(job.outputDir, { recursive: true });
    fs.writeFileSync(logPath, buildPlainTextDiagnostics(job), 'utf8');
    return { file: 'log.txt', fullPath: logPath };
  } catch {
    return null;
  }
}

function streamZip(res, zipName, files) {
  assertArchiverAvailable();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', zipName));
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).send('Nie udało się przygotować ZIP-a.');
    else res.destroy(err);
  });
  archive.pipe(res);
  for (const item of files) archive.file(item.fullPath, { name: item.file });
  archive.finalize();
}

app.get('/api/download/:jobId/zip', (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!job || !fs.existsSync(job.outputDir)) return res.status(404).send('Nie znaleziono wyników.');
    const pdfFiles = listJobPdfFiles(job);
    if (!pdfFiles.length) return res.status(404).send('Nie ma żadnych gotowych PDF-ów do pobrania. Najpierw utwórz minimum jeden PDF.');
    const zipName = safeName(`dokumenty seryjne ${job.id}.zip`, 'dokumenty-seryjne.zip');
    streamZip(res, zipName, pdfFiles);
  } catch (err) {
    console.error('[ser-download-zip]', err?.message || err);
    if (!res.headersSent) res.status(500).send('Nie udało się przygotować paczki ZIP z PDF-ami.');
  }
});

app.get('/api/download/:jobId/logs', (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!job || !job.outputDir || !fs.existsSync(job.outputDir)) return res.status(404).send('Nie znaleziono logów.');

    // Logi muszą się pobierać zawsze, nawet jeśli ZIP/archiver zawiedzie.
    // Dlatego dla pomocy technicznej zwracamy zwykły log.txt, a nie paczkę ZIP.
    const logFile = ensureLogFile(job);
    if (!logFile) return res.status(404).send('Nie znaleziono plików logów dla tego zadania.');
    return res.download(logFile.fullPath, logFile.file);
  } catch (err) {
    console.error('[ser-download-logs]', err?.message || err);
    if (!res.headersSent) res.status(500).send('Nie udało się przygotować logów do pobrania.');
  }
});

app.get('/api/download/:jobId/:file', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).send('Nie znaleziono zadania.');
  const file = safeName(req.params.file || 'plik.pdf', 'plik.pdf');
  const fullPath = path.join(job.outputDir, file);
  const rel = path.relative(job.outputDir, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(fullPath)) return res.status(404).send('Nie znaleziono pliku.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', file));
  res.sendFile(fullPath);
});

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ ok: false, message: err.message || 'Błąd żądania.' });
  next();
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Dokumenty seryjne: http://${HOST}:${PORT}`);
});
applyHttpTimeouts(server, 'SERYJNE');