const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const readExcelFile = require('read-excel-file/node').default;
const sanitize = require('sanitize-filename');
// archiver 8.x jest czystym ESM i eksportuje klase ZipArchive, nie stara
// funkcje-fabryke archiver('zip', opts) uzywana ponizej wczesniej - ten kod
// nigdy nie dzialal z archiver 8 (typeof archiverModule !== 'function', wiec
// `archiver` konczyl jako undefined, zlapane dopiero przez assertArchiverAvailable
// przy realnym pobraniu ZIP-a). Do tego synchroniczne require() ESM-owego
// pakietu dziala TYLKO na Node >=20.19/22.12 ("require(esm)") - na starszych,
// wciaz oficjalnie wspieranych wersjach (w tym Node 18.x, deklarowany jako
// minimum w package.json/README) rzuca ERR_REQUIRE_ESM i wywala cala
// aplikacje na starcie. Oba zlapane realnym testem instalacji na Node 20.18.1
// w GitHub Actions. Poprawka: leniwy dynamiczny import() + poprawna klasa
// ZipArchive, ten sam wzorzec co pieczatki-pdf/wnioski-powykonawcze.
let ZipArchiveClass = null;
async function loadZipArchive() {
  if (!ZipArchiveClass) {
    ({ ZipArchive: ZipArchiveClass } = await import('archiver'));
  }
  return ZipArchiveClass;
}
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { setupProcessDiagnostics, applyHttpTimeouts, createSerialQueue, stripBom, writeJsonFileNoBom, readJsonFileNoBom, scheduleCleanup } = require('../../lib/hardening');
const { getAppDataDir } = require('../../lib/appPaths');
const { detectMailMergeSheetBinding, getDocxModifiedTime } = require('./src/mailMergeSheetBinding');
const AdmZip = require('adm-zip');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const APP_DATA_ROOT = getAppDataDir('dokumenty-seryjne');
setupProcessDiagnostics('dokumenty-seryjne', APP_DATA_ROOT);
const wordQueue = createSerialQueue('dokumenty-seryjne-word');
const DATA_DIR = path.join(APP_DATA_ROOT, 'data');
const UPLOAD_DIR = path.join(APP_DATA_ROOT, 'uploads');
const OUTPUT_DIR = path.join(APP_DATA_ROOT, 'output');
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
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://scyzoryk.localhost:3000 http://127.0.0.1:3000; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
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

app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
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
      workbook: job.workbook || null
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
      if (!item?.id || !item.outputDir) continue;
      const interrupted = ['running', 'queued', 'cancelling'].includes(item.status);
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
        status: interrupted ? 'interrupted' : (item.status || 'restored'),
        interruptedReason: interrupted ? 'process-restarted' : item.interruptedReason,
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
  const allRows = filtered.map((row, index) => ({ _record: index + 1, ...row }));
  const previewRows = allRows.slice(0, MAX_ROWS);
  return { sheetName, columns, rows: allRows, previewRows, totalRows: allRows.length, truncatedAt: allRows.length > MAX_ROWS ? MAX_ROWS : null };
}

function detectPowerFromText(text) {
  const s = String(text || '').replace(',', '.');
  const m = s.match(/(?:^|[^0-9])([0-9]{1,2})(?:\s*|_?)(?:kw|kW|KW)(?:[^0-9]|$)/i);
  return m ? `${Number(m[1])}kW` : '';
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Realny przypadek (Wierzchlas PV, 2026-08-19): eksport z Google Sheets
// zostawia w pliku techniczne, UKRYTE arkusze o losowych, wygenerowanych
// nazwach (np. "xkozOZODPeJDCoWaw7hO", "Hjbrrmhj59UDQUVPRwRx") - a kolejnosc,
// w jakiej read-excel-file zwraca arkusze, NIE ma NIC wspolnego z kolejnoscia
// widocznych zakladek w samym Excelu (na tym pliku zwrocilo je w kolejnosci
// wrecz ODWROTNEJ do deklaracji w xl/workbook.xml - PV_, pierwsza prawdziwa
// zakladka, wypadla dopiero na 3. miejscu, ZA obydwoma technicznymi
// arkuszami). Jedyne wiarygodne zrodlo "ktora zakladka jest pierwsza i
// widoczna dla czlowieka" to kolejnosc <sheet> w samym xl/workbook.xml (ten
// sam wzorzec AdmZip co detectMailMergeSheetBinding w
// src/mailMergeSheetBinding.js, tylko dla .xlsx zamiast .docx) - CZYTAMY
// STAMTAD wprost, zamiast filtrowac zawodna kolejnosc z read-excel-file.
function getSheetOrderFromWorkbookXml(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('xl/workbook.xml');
    if (!entry) return null;
    const xml = zip.readAsText(entry, 'utf8');
    const sheetTagRe = /<sheet\b[^>]*\/>/g;
    const wynik = [];
    let m;
    while ((m = sheetTagRe.exec(xml))) {
      const tag = m[0];
      const nameMatch = tag.match(/name="([^"]*)"/);
      if (!nameMatch) continue;
      wynik.push({ name: decodeXmlEntities(nameMatch[1]), hidden: /state="hidden"/.test(tag) });
    }
    return wynik.length ? wynik : null;
  } catch (_) {
    return null;
  }
}

function pickDefaultSheet(sheetNames, templateName = '', sheetOrderFromXml = null) {
  const wanted = detectPowerFromText(templateName);
  if (wanted) {
    const found = sheetNames.find(name => String(name).toLowerCase() === wanted.toLowerCase());
    if (found) return found;
  }
  if (sheetOrderFromXml) {
    const znanaNazwa = new Set(sheetNames);
    const pierwszyWidoczny = sheetOrderFromXml.find(s => !s.hidden && znanaNazwa.has(s.name));
    if (pierwszyWidoczny) return pierwszyWidoczny.name;
    // Wszystkie ukryte (albo xml nie zawieral zadnej znanej nazwy) - lepiej
    // wziac cokolwiek z prawdziwej listy zakladek niz nic.
    const pierwszyZnany = sheetOrderFromXml.find(s => znanaNazwa.has(s.name));
    if (pierwszyZnany) return pierwszyZnany.name;
  }
  // xl/workbook.xml nie dalo sie odczytac - jedyny dostepny fallback to
  // dotychczasowe (zawodne, ale lepsze niz nic) zachowanie sprzed tej poprawki.
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


// RESET 2026-07-24: aplikacja ma dzialac TYLKO dla prawdziwych dokumentow
// korespondencji seryjnej Worda (wzorzec: inwestycja "Rychwal" - folder
// "Wzor" z podfolderami per MOC, kazdy z kompletem kilku typow dokumentow
// jako *_korespondencja.docx), nie dla dowolnych plikow .docx wrzuconych do
// tego samego folderu. Zamiast zgadywac typ/wariant po nazwie pliku albo
// folderu (jak groupTemplatesByType wyzej - zostawione nietkniete na
// pozniej, gdyby trzeba bylo wrocic do trybu Kolektory/PC), uzywamy
// PRAWDZIWEGO powiazania z arkuszem Excela zapisanego przez Worda w
// word/settings.xml (detectMailMergeSheetBinding) - plik BEZ takiego
// powiazania to zwykla robocza kopia do recznej edycji, nie szablon do
// generowania, i jest po cichu pomijany (to jest cala odpowiedz na "ma
// dzialac tylko dla korespondencji seryjnej, a nie dla losowych plikow").

// Buduje wyrazenie regularne usuwajace z nazwy pliku token danego arkusza
// (np. "6kW"), tolerancyjne na spacje miedzy liczba a jednostka - w
// prawdziwych nazwach plikow bywa "6KW" (bez spacji) i "6 kW" (ze spacja),
// oba musza zniknac zeby ten sam dokument dla roznych mocy zgrupowal sie
// pod jednym wspolnym "typem".
function buildSheetTokenRegex(sheetName) {
  const escaped = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(sheetName || '').trim().match(/^(\d+)\s*(\S+)$/);
  if (m) return new RegExp(`${escaped(m[1])}\\s*${escaped(m[2])}`, 'ig');
  return new RegExp(escaped(sheetName), 'ig');
}

// Z nazwy pliku usuwa token mocy (arkusza) i slowo "korespondencja", zeby
// zostal sam "typ" dokumentu wspolny dla wszystkich mocy (np.
// "OT_ZIN_6KW_V1 _korespondencja.docx" i "OT_ZIN_8KW_V1_korespondencja.docx"
// oba daja "OT_ZIN_V1").
function deriveMailMergeKind(originalName, sheetName) {
  let base = String(originalName || '').replace(/\.docx$/i, '');
  base = base.replace(buildSheetTokenRegex(sheetName), ' ');
  base = base.replace(/[\s_-]*korespondencj\w*[\s_-]*/ig, ' ');
  base = base.replace(/[_\s-]{2,}/g, ' ').trim().replace(/^[_-]+|[_-]+$/g, '').trim();
  return base || String(originalName || '').replace(/\.docx$/i, '');
}

// Zamiast grupowac po nazwie/folderze, kazdy plik .docx pytamy WPROST czy
// ma prawdziwe powiazanie mail merge (Word "Wybierz odbiorcow"). Ci co maja
// - grupujemy po "typie" (deriveMailMergeKind), warianty to MOC/arkusz
// (sheetName z samego powiazania, nie zgadywany). Ci co nie maja takiego
// powiazania - to zwykle kopie robocze, pomijamy je calkowicie.
// defaultSheet: gdy szablon NIE ma prawdziwego powiazania Worda (nie przeszedl
// przez "Wybierz odbiorcow"), dawniej byl calkowicie POMIJANY (skipped) - co
// dla POJEDYNCZEGO szablonu (real przypadek: Wierzchlas PV, szablon zrobiony
// recznie/przez ChatGPT bez uzycia Mailings w Wordzie) dawalo mylacy blad
// "zaden plik nie jest prawdziwym dokumentem korespondencji seryjnej", mimo
// ze arkusz do uzycia jest jednoznaczny (ten sam, ktory i tak zostal juz
// wybrany/domyslny dla calego uploadu - patrz defaultSheet w /api/upload).
// Powiazanie Worda ma sens jako WYMOG tylko wtedy, gdy trzeba ROZSTRZYGNAC
// MIEDZY kilkoma arkuszami dla roznych wariantow mocy w jednej paczce
// szablonow - bez niego kazdy szablon bez wlasnego powiazania dostaje po
// prostu defaultSheet jako swoj wariant.
function groupMailMergeTemplates(templateInfos, defaultSheet = null) {
  const groups = new Map();
  const ambiguous = [];
  const skipped = [];
  for (const t of templateInfos) {
    if (path.extname(t.originalName).toLowerCase() !== '.docx') {
      skipped.push({ file: t.originalName, reason: 'nie jest plikiem .docx' });
      continue;
    }
    const binding = detectMailMergeSheetBinding(t.path);
    const sheetName = (binding && binding.sheetName) || defaultSheet;
    if (!sheetName) {
      skipped.push({ file: t.originalName, reason: 'brak prawdziwego powiazania korespondencji seryjnej z arkuszem Excela i brak domyslnego arkusza do ktorego mozna by go przypisac' });
      continue;
    }
    const kind = deriveMailMergeKind(t.originalName, sheetName);
    if (!groups.has(kind)) groups.set(kind, { name: kind, variants: {} });
    const g = groups.get(kind);
    const existing = g.variants[sheetName];
    if (existing) {
      // Realny przypadek (Slesin PC Grunt): dwa pliki z prawdziwym powiazaniem
      // do tej samej mocy/arkusza to zwykle starsza kopia zostawiona w folderze
      // po zapisaniu poprawionej wersji pod inna nazwa (np. "..._korespondencja.docx"
      // i "..._korespondencja_1.docx" po zapisie "Zachowaj obie kopie"), nie dwa
      // naprawde inne dokumenty. Zamiast gubic caly typ dokumentu dla tej mocy,
      // bierzemy ten NOWSZY wg daty zapisu w samym docx (docProps/core.xml,
      // niezalezna od mtime pliku na dysku/po uploadzie) - starszy tylko
      // odnotowujemy w komunikacie dla uzytkownika.
      const existingTime = getDocxModifiedTime(existing.path);
      const newTime = getDocxModifiedTime(t.path);
      const newIsNewer = newTime != null && (existingTime == null || newTime > existingTime);
      const kept = newIsNewer ? t : existing;
      const skippedOne = newIsNewer ? existing : t;
      g.variants[sheetName] = kept;
      ambiguous.push({
        kind,
        sheetName,
        relFolder: `${kind} (${sheetName})`,
        files: [existing.originalName, t.originalName],
        resolved: true,
        keptFile: kept.originalName,
        skippedFile: skippedOne.originalName
      });
      continue;
    }
    g.variants[sheetName] = t;
  }
  // hasVariants zawsze false w tym co idzie do frontendu - wybor "wariantu"
  // (mocy) juz jest dokonany przez wybor arkusza Excela (sheetSelect), nie
  // trzeba wiec dodatkowo pytac uzytkownika o kolumne UID per wiersz jak w
  // starym trybie Kolektory/PC.
  const groupList = Array.from(groups.values()).map(g => ({ name: g.name, hasVariants: false, variants: g.variants, single: null }));
  return { groups: groupList, ambiguous, skipped };
}

// Tabela Excela musi "wygladac jak wzorcowa" (patrz tabela.xlsx z Rychwalu)
// - zamiast po cichu zgadywac dowolne kolumny, wymagamy zeby te
// najwazniejsze (uzywane przez sama aplikacje do nazywania plikow/folderow,
// nie tylko do wypelniania MERGEFIELD) na pewno istnialy, dokladnym
// dopasowaniem (bez diakrytykow/wielkosci liter) do JEDNEJ z kilku znanych,
// realnie wystepujacych nazw - zeby "Numer telefonu" nie zaliczylo sie
// przypadkiem jako "Numer", ale zeby rowniez inaczej nazwane, ale
// rownowazne tabele (np. PV_ z Wierzchlasu: "UID"/"LP" zamiast "ID",
// "Imię i Nazwisko" zamiast "Beneficjent") przechodzily bez zmiany naglowka
// w Excelu. Te same synonimy juz gdzie indziej uznane za rownowazne w tym
// repo - patrz $script:LabelFieldCandidates['uczestnik_projektu'] w
// scripts/mailmerge-to-pdf.ps1 dla "Imie i Nazwisko"/"Beneficjent".
const REQUIRED_REFERENCE_COLUMNS = [
  { label: 'ID', candidates: ['ID', 'UID', 'LP'] },
  { label: 'Adres', candidates: ['Adres'] },
  { label: 'Beneficjent', candidates: ['Beneficjent', 'Imię i Nazwisko', 'Imie i Nazwisko', 'Inwestor'] }
];
function findExactColumn(columns, name) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').trim();
  const target = norm(name);
  return (columns || []).find(c => norm(c) === target) || null;
}
function validateReferenceColumns(columns) {
  return REQUIRED_REFERENCE_COLUMNS
    .filter(req => !req.candidates.some(candidate => findExactColumn(columns, candidate)))
    .map(req => req.label);
}

// Dla kazdej zaznaczonej "logicznej" pozycji buduje liste konkretnych zadan
// generowania: {templatePath, templateOriginalName, rowRecords}. Jesli
// pozycja ma warianty (250/300/400), dzieli wybrane wiersze wg rozmiaru
// odczytanego z kolumny UID kazdego wiersza - kazdy wariant staje sie
// osobnym zadaniem z pasujaca do niego podgrupa wierszy.
function buildGenerationTasks(job, selectedGroupNames, sheetName, selectedSheet, selectedRowRecords) {
  const tasks = [];
  const skippedGroups = [];
  const rowRecords = selectedRowRecords.length ? selectedRowRecords : (selectedSheet.rows || []).map(r => Number(r._record));
  const wantedSheet = String(sheetName || '').trim().toLowerCase();

  for (const groupName of selectedGroupNames) {
    const group = (job.templateGroups || []).find(g => g.name === groupName);
    if (!group) {
      // Nazwa grupy z zaznaczenia UI nie pasuje do zadnej znanej grupy szablonow
      // (np. dane joba zmienily sie miedzy wyborem a generowaniem) - zamiast
      // cicho pominac cala pozycje bez sladu, zglaszamy tak samo jak brak
      // wariantu dla arkusza nizej.
      skippedGroups.push({ groupName, reason: `Nie znaleziono grupy szablonow "${groupName}".` });
      continue;
    }
    const variantKeys = Object.keys(group.variants || {});
    const exactKey = variantKeys.find(k => k === sheetName);
    const looseKey = exactKey || variantKeys.find(k => k.trim().toLowerCase() === wantedSheet);
    const t = looseKey ? group.variants[looseKey] : null;
    if (!t) {
      skippedGroups.push({ groupName, reason: `Brak szablonu "${groupName}" dla arkusza/mocy "${sheetName}".` });
      continue;
    }
    tasks.push({ groupName, templatePath: t.path, templateOriginalName: t.originalName, rowRecords });
  }
  return { tasks, skippedGroups };
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
  return { sheetNames, sheetName: defaultSheet, columns: selected.columns, rows: selected.previewRows, totalRows: selected.totalRows, truncatedAt: selected.truncatedAt, sheets, summaries };
}


function getWorkbookSheet(workbook, sheetName) {
  const requested = String(sheetName || workbook.sheetName || '').trim();
  return (requested && workbook.sheets && workbook.sheets[requested]) || (workbook.sheets && workbook.sheets[workbook.sheetName]) || workbook;
}

function workbookPreview(workbook, sheetName) {
  const sheet = getWorkbookSheet(workbook, sheetName);
  return {
    sheetNames: workbook.sheetNames,
    sheetName: sheet.sheetName,
    columns: sheet.columns,
    rows: sheet.previewRows || sheet.rows?.slice(0, MAX_ROWS) || [],
    totalRows: sheet.totalRows,
    truncatedAt: sheet.truncatedAt,
    summaries: workbook.summaries
  };
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
  const rowsForMerge = selectedRows.length ? allRows.filter(row => selectedRows.includes(Number(row._record))) : allRows;
  if (!rowsForMerge.length) throw new Error('Nie wybrano żadnych rekordów do wygenerowania.');

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
async function runMultiTemplateGeneration(job, tasks, options, skippedGroups) {
  const allCreated = [];
  const allErrors = [];
  const originalTemplate = job.template;
  // Realny blad zlapany przez wlasciciela: pole "Przedrostek nazwy pliku" w
  // UI pokazywalo zywy podglad nazwy, ale ponizej i tak zawsze uzywano
  // task.groupName (automatycznie wykrytej nazwy typu dokumentu) - wpisany
  // przedrostek nigdy nie trafial do prawdziwej nazwy pliku. Teraz wpisany
  // przez uzytkownika przedrostek (jesli niepusty) ZASTEPUJE automatyczna
  // nazwe dla WSZYSTKICH wybranych dokumentow (jeden wspolny przedrostek) -
  // puste pole dalej daje dawne zachowanie (automatyczna nazwa typu).
  const userFilePrefix = cleanFilePrefix(options.filePrefix || '');
  let first = true;
  let cancelledEarly = false;
  for (let i = 0; i < tasks.length; i += 1) {
    // Audyt v1.0.4, P1-2: /api/cancel/:jobId dziala jako OSOBNE, rownolegle
    // zadanie HTTP - zabijalo tylko AKTUALNY proces PowerShell (job.child),
    // ale ta petla nie sprawdzala nic przed przejsciem do KOLEJNEGO szablonu,
    // wiec po "Przerwij" i tak startowal nastepny szablon w paczce. Sprawdzamy
    // job.cancelRequested na poczatku KAZDEJ iteracji, nie tylko raz na starcie.
    if (job.cancelRequested) {
      cancelledEarly = true;
      appendLog(job, 'warn', `Anulowano - pominieto ${tasks.length - i} z ${tasks.length} pozostalych szablonow.`);
      break;
    }
    const task = tasks[i];
    if (!task.rowRecords.length) continue;
    job.template = { path: task.templatePath, originalName: task.templateOriginalName };
    const taskOptions = { ...options, selectedRows: task.rowRecords, _keepLog: !first, filePrefix: userFilePrefix || task.groupName };
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
  if (!cancelledEarly) {
    for (const skipped of (skippedGroups || [])) {
      allErrors.push({ file: skipped.groupName, message: skipped.reason });
    }
  }
  job.template = originalTemplate;
  const message = cancelledEarly
    ? `Przerwano przez użytkownika. Wygenerowano ${allCreated.length} plik(ów) przed przerwaniem.` + (allErrors.length ? ` Błędów: ${allErrors.length}.` : '')
    : `Wygenerowano ${allCreated.length} plik(ów) z ${tasks.length} szablon(ów).` + (allErrors.length ? ` Błędów: ${allErrors.length}.` : '');
  job.result = { ok: allCreated.length > 0, created: allCreated, errors: allErrors, message, logUrl: `/api/download/${job.id}/logs` };
  job.status = cancelledEarly ? 'cancelled' : (allCreated.length > 0 ? 'done' : 'error');
  job.endedAt = Date.now();
  setProgress(job, { phase: job.status === 'done' ? 'done' : job.status, percent: 100, message });
  persistJobsIndex();
  return job.result;
}

const { registerFolderRoutes } = require('./src/folderRoutes');
registerFolderRoutes(app, {
  multer, storage, MAX_FILE_MB, heavyJobLimiter, jobs, OUTPUT_DIR, ROOT, PS_SCRIPT, SCAN_SCRIPT, wordQueue,
  decodeOriginalName, validateOfficeFile, loadExcelWorkbook, parseWorkbook, getWorkbookSheet,
  getJob, persistJobsIndex, setProgress, nowIso, writeJsonFileNoBom, stripBom,
  // folder.html/folderRoutes.js jest martwym, nieosiagalnym z UI kodem (patrz CLAUDE.md) -
  // jego ZIP-owanie juz wczesniej nie dzialalo pod archiver v8 (ta sama stara fabryka
  // archiver('zip',...), ktorej v8 nie eksportuje) i deps.archiver bylo faktycznie
  // undefined rowniez PRZED tym committem, tylko przez inna sciezke (nieudana probaw
  // wykrycia callable factory). Zachowujemy to samo zachowanie (istniejacy guard w
  // folderRoutes.js zwraca czytelny blad 500) zamiast odwolywac sie do usunietej zmiennej.
  archiver: undefined,
  contentDispositionHeader
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'dokumenty-seryjne', queue: wordQueue.getState() }));

app.post('/api/upload', heavyJobLimiter, upload.fields([{ name: 'template', maxCount: 1 }, { name: 'templates', maxCount: 60 }, { name: 'excel', maxCount: 1 }]), async (req, res) => {
  try {
    const excel = req.files?.excel?.[0];
    if (!excel) return res.status(400).json({ ok: false, message: 'Dodaj tabelę Excel XLSX.' });
    validateOfficeFile(excel, ['.xlsx']);

    const templateFiles = [...(req.files?.template || []), ...(req.files?.templates || [])];
    if (!templateFiles.length) return res.status(400).json({ ok: false, message: 'Dodaj co najmniej jeden szablon Word DOCX.' });
    for (const t of templateFiles) validateOfficeFile(t, ['.docx']);

    const singleTemplateFiles = req.files?.template || [];
    const multiTemplateFiles = req.files?.templates || [];
    const templateInfos = [...singleTemplateFiles, ...multiTemplateFiles]
      .map(t => ({ path: t.path, originalName: decodeOriginalName(t.originalname) }));

    const sheetNames = (await loadExcelWorkbook(excel.path)).worksheets.map(sheet => sheet.name);
    // Niektore szablony (np. Slesin) maja na stale podpiety przez Word
    // "Wybierz odbiorcow" konkretny arkusz Excela - to jest pewna informacja,
    // wiec ma pierwszenstwo przed zgadywaniem mocy z nazwy pliku.
    const boundSheet = detectMailMergeSheetBinding(templateInfos[0].path);
    const boundSheetName = boundSheet
      ? sheetNames.find(name => String(name).toLowerCase() === String(boundSheet.sheetName).toLowerCase())
      : null;
    const sheetOrderFromXml = getSheetOrderFromWorkbookXml(excel.path);
    const defaultSheet = boundSheetName || pickDefaultSheet(sheetNames, templateInfos[0].originalName, sheetOrderFromXml);
    const workbook = await parseWorkbook(excel.path, defaultSheet);

    // Tabela musi "wygladac jak wzorcowa" - patrz mem:conventions / komentarz
    // przy REQUIRED_REFERENCE_COLUMNS. Sprawdzamy to od razu, zamiast po
    // cichu generowac dokumenty z pustymi polami dla zle dobranej tabeli.
    const missingColumns = validateReferenceColumns(workbook.columns);
    if (missingColumns.length) {
      return res.status(400).json({
        ok: false,
        message: `Tabela Excel nie ma kolumn wymaganych dla korespondencji seryjnej: ${missingColumns.join(', ')}. Sprawdź, czy arkusz „${workbook.sheetName}” ma taką samą strukturę kolumn jak wzorcowa tabela (ID, Adres, Beneficjent...).`
      });
    }

    const jobId = crypto.randomUUID();
    const outDir = path.join(OUTPUT_DIR, jobId);
    await fsp.mkdir(outDir, { recursive: true });

    const { groups: templateGroups, ambiguous: ambiguousTemplates, skipped: skippedTemplates } = groupMailMergeTemplates(templateInfos, defaultSheet);
    if (!templateGroups.length) {
      return res.status(400).json({
        ok: false,
        message: 'Żaden z wgranych plików .docx nie jest prawdziwym dokumentem korespondencji seryjnej (brak powiązania z arkuszem Excela przez "Wybierz odbiorców" w Wordzie). Ta aplikacja generuje dokumenty tylko z takich plików.'
      });
    }

    const job = {
      id: jobId,
      createdAt: Date.now(),
      touchedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      template: templateInfos[0],
      templateGroups,
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
    appendLog(job, 'info', 'Wczytano pliki.', { templates: templateInfos.map(t => t.originalName), excel: job.excel.originalName, rows: workbook.totalRows, sheet: workbook.sheetName, sheets: workbook.summaries });
    res.json({
      ok: true,
      jobId,
      workbook: workbookPreview(workbook, workbook.sheetName),
      suggestedAddressColumn: guessAddressColumn(workbook.columns),
      suggestedUidColumn: guessUidColumn(workbook.columns),
      templateGroups: templateGroups.map(g => ({ name: g.name, hasVariants: g.hasVariants, variants: Object.keys(g.variants) })),
      ambiguousTemplates,
      skippedTemplatesCount: skippedTemplates.length,
      detectedTemplatePower: boundSheetName || detectPowerFromText(templateInfos[0].originalName)
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
  const missingColumns = validateReferenceColumns(sheet.columns);
  if (missingColumns.length) {
    return res.status(400).json({ ok: false, sheetName, missingColumns, message: `Arkusz "${sheetName}" nie ma wymaganych kolumn: ${missingColumns.join(', ')}.` });
  }
  res.json({ ok: true, workbook: workbookPreview(job.workbook, sheetName), suggestedAddressColumn: guessAddressColumn(sheet.columns || []), suggestedUidColumn: guessUidColumn(sheet.columns || []) });
});

app.get('/api/jobs/:jobId/sheets/:sheetName/rows', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  const sheet = getWorkbookSheet(job.workbook, req.params.sheetName);
  if (!sheet || sheet.sheetName !== req.params.sheetName) return res.status(404).json({ ok: false, message: 'Nie znaleziono arkusza w Excelu.' });
  const missingColumns = validateReferenceColumns(sheet.columns);
  if (missingColumns.length) {
    return res.status(400).json({ ok: false, sheetName: sheet.sheetName, missingColumns, message: `Arkusz "${sheet.sheetName}" nie ma wymaganych kolumn: ${missingColumns.join(', ')}.` });
  }
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json({ ok: true, totalRows: sheet.rows.length, offset, limit, rows: sheet.rows.slice(offset, offset + limit) });
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
    const missingColumns = validateReferenceColumns(selectedSheet?.columns || []);
    if (missingColumns.length) {
      return res.status(400).json({ ok: false, sheetName, missingColumns, message: `Arkusz "${sheetName}" nie ma wymaganych kolumn: ${missingColumns.join(', ')}.` });
    }
    const selectedRowRecords = Array.isArray(body.selectedRows) ? body.selectedRows.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    const selectedGroups = Array.isArray(body.selectedGroups) ? body.selectedGroups.filter(Boolean) : null;

    let tasks, skippedGroups = [];
    if (selectedGroups && selectedGroups.length && job.templateGroups && job.templateGroups.length) {
      const built = buildGenerationTasks(job, selectedGroups, sheetName, selectedSheet, selectedRowRecords);
      tasks = built.tasks;
      skippedGroups = built.skippedGroups;
      if (!tasks.length) return res.status(400).json({ ok: false, message: `Nie znaleziono żadnych szablonów korespondencji seryjnej dla arkusza „${sheetName}” wśród wybranych typów dokumentów.` });
    } else {
      tasks = [{ templatePath: job.template.path, templateOriginalName: job.template.originalName, rowRecords: selectedRowRecords.length ? selectedRowRecords : (selectedSheet.rows || []).map(r => Number(r._record)) }];
    }

    // Audyt rozdz. 12, P0/P1: kolejne "Generuj" na tym samym jobId pisalo do
    // TEGO SAMEGO job.outputDir - PDF-y z POPRZEDNIEGO uruchomienia
    // zostawaly na dysku, wiec ZIP/pobieranie moglo zawierac pliki spoza
    // aktualnego wyboru (np. najpierw wygenerowano A+B, potem zmieniono
    // wybor na samo C -> wynik zawieral A+B+C). Czyscimy katalog wyjsciowy
    // TUZ PRZED faktycznym startem - po wszystkich synchronicznych
    // walidacjach powyzej - zeby nieudana proba (np. brakujace kolumny) NIE
    // kasowala wynikow poprzedniego, udanego uruchomienia bez potrzeby.
    for (const entry of await fsp.readdir(job.outputDir).catch(() => [])) {
      await fsp.rm(path.join(job.outputDir, entry), { recursive: true, force: true }).catch(() => {});
    }
    job.result = null;
    job.status = 'queued';
    persistJobsIndex();
    setProgress(job, { phase: 'queued', message: 'Zadanie czeka w kolejce Word. Word robi tylko jeden dokument naraz.', queue: wordQueue.getState() });
    wordQueue.run(() => runMultiTemplateGeneration(job, tasks, body, skippedGroups)).catch(err => {
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
  if (job.status === 'interrupted') {
    job.status = 'cancelled';
    persistJobsIndex();
    return res.json({ ok: true, message: 'Zadanie oznaczone jako anulowane.', status: job.status });
  }
  if (job.status !== 'running' || !job.child) return res.json({ ok: true, message: 'Zadanie nie jest uruchomione.', status: job.status });
  appendLog(job, 'warn', 'Użytkownik przerwał generowanie.');
  // job.cancelRequested (nie tylko job.status/job.child.kill()) - sprawdzane
  // przez runMultiTemplateGeneration przed KAZDYM kolejnym szablonem w
  // paczce (audyt v1.0.4, P1-2). Samo zabicie biezacego procesu PowerShell
  // nie wystarczylo, bo petla po prostu ruszalaby z nastepnym szablonem.
  job.cancelRequested = true;
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

async function streamZip(res, zipName, files) {
  const ZipArchive = await loadZipArchive();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', zipName));
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).send('Nie udało się przygotować ZIP-a.');
    else res.destroy(err);
  });
  archive.pipe(res);
  for (const item of files) archive.file(item.fullPath, { name: item.file });
  archive.finalize();
}

app.get('/api/download/:jobId/zip', async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!job || !fs.existsSync(job.outputDir)) return res.status(404).send('Nie znaleziono wyników.');
    const pdfFiles = listJobPdfFiles(job);
    if (!pdfFiles.length) return res.status(404).send('Nie ma żadnych gotowych PDF-ów do pobrania. Najpierw utwórz minimum jeden PDF.');
    const zipName = safeName(`dokumenty seryjne ${job.id}.zip`, 'dokumenty-seryjne.zip');
    await streamZip(res, zipName, pdfFiles);
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

// require.main === module: uruchomienie serwera TYLKO gdy plik jest startowany
// bezposrednio (node server.js), nie przy require() z testow (patrz ten sam
// wzorzec w apps/drukarka-projekty/server.js i apps/wnioski-powykonawcze/server.js).
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Dokumenty seryjne: http://${HOST}:${PORT}`);
  });
  applyHttpTimeouts(server, 'SERYJNE');
}

module.exports = {
  app, jobs, getJob,
  pickDefaultSheet, getSheetOrderFromWorkbookXml, validateReferenceColumns, groupMailMergeTemplates
};
