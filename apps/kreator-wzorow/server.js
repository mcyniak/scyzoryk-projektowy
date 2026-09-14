// Kreator wzorow seryjnych - przygotowuje zwykly Word DOCX z oznaczonymi
// (dowolnym kolorem) fragmentami do uzycia w Dokumentach seryjnych PDF.
// Patrz CLAUDE.md ("Kreator wzorow seryjnych") dla pelnego opisu przeplywu i
// modelu Smart Template (manifest w Custom XML Part, interpretowany przez
// lib/smartTemplateRules.js).
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const AdmZip = require('adm-zip');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { setupProcessDiagnostics, applyHttpTimeouts, runPowerShell, scheduleCleanup } = require('../../lib/hardening');
const { toAsciiSafe } = require('../../lib/diacritics');
const { getDataRoot, getAppDataDir } = require('../../lib/appPaths');
const { applySecurityHeaders, applyMutationGuard } = require('../../lib/localRequestSecurity');
const { withWordAutomationLease } = require('../../lib/wordAutomationCoordinator');
const { evaluateSmartRecord, validateManifest, collectRequiredColumns } = require('../../lib/smartTemplateRules');
// Migracja Word COM -> Open XML (CLAUDE.md, "Migracja Word COM -> Open XML",
// audyt 2026-09-14): skanowanie/budowanie wzoru nie uzywa juz Worda w ogole -
// patrz lib/documentEngine.js (fasada nad Scyzoryk.DocumentEngine.exe,
// tools/Scyzoryk.DocumentEngine, Open XML SDK). withWordAutomationLease
// zostaje w tym pliku WYLACZNIE dla /preview (nadal renderuje przez
// dokumenty-seryjne/mailmerge-to-pdf.ps1, Word COM - migracja runtime Smart
// Template to kolejny, jeszcze nie wykonany etap, patrz raport koncowy).
const documentEngine = require('../../lib/documentEngine');

const { createJobStore } = require('./src/jobStore');
const { readWorkbook, sheetPreview, uniqueColumnValues } = require('./src/excelWorkbook');
const tm = require('./src/templateManifest');
// Auto-konfiguracja kandydatow (lokalna, deterministyczna - zero AI/sieci),
// patrz PROMPT_CLAUDE_AUTO_KONFIGURACJA_KREATORA.md i src/autoConfigurator.js.
const autoConfigurator = require('./src/autoConfigurator');
const { applyAutoConfiguration } = require('./src/autoConfigApply');
const { createMappingMemory } = require('./src/mappingMemory');

const app = express();
const PORT = Number(process.env.PORT || 3016);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const APP_DATA_ROOT = getAppDataDir('kreator-wzorow');
setupProcessDiagnostics('kreator-wzorow', APP_DATA_ROOT);

const DATA_DIR = path.join(APP_DATA_ROOT, 'data');
const UPLOAD_DIR = path.join(APP_DATA_ROOT, 'uploads');
const OUTPUT_DIR = path.join(APP_DATA_ROOT, 'output');
const MAX_FILE_MB = Number(process.env.KREATOR_MAX_FILE_MB || 80);
const JOB_TTL_MS = Number(process.env.KREATOR_JOB_TTL_MS || 24 * 60 * 60 * 1000);
// Preview (KROK 4A) uzywa DOKLADNIE tego samego runtime co prawdziwe
// generowanie w Dokumentach seryjnych (sekcja 27 specyfikacji) - zamiast
// pisac drugi, niezalezny renderer smart-template, ktory z czasem rozjedzie
// sie z prawdziwym. To jedyne miejsce w repo, gdzie jeden child app siega
// wprost po skrypt INNEGO child app - swiadomy wyjatek od "apki sa
// niezalezne", bo to jest jedyny sposob, zeby podglad NAPRAWDE odpowiadal
// temu, co pozniej zrobi wlasciwy modul.
const DOKUMENTY_SERYJNE_MAILMERGE_SCRIPT = path.join(ROOT, '..', 'dokumenty-seryjne', 'scripts', 'mailmerge-to-pdf.ps1');

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(dir, { recursive: true });
scheduleCleanup([UPLOAD_DIR, OUTPUT_DIR], JOB_TTL_MS, 60 * 60 * 1000);

applySecurityHeaders(app, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://scyzoryk.localhost:3000 http://127.0.0.1:3000; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
applyMutationGuard(app, (req, res) => res.status(403).json({ ok: false, message: 'Odśwież stronę i spróbuj ponownie.' }));
app.use(express.json({ limit: '4mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.KREATOR_API_RATE_LIMIT || 120),
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(req.path),
  message: { ok: false, message: 'Za dużo żądań w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.KREATOR_HEAVY_RATE_LIMIT || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za dużo ciężkich zadań (skan/podgląd/build) w krótkim czasie. Odczekaj chwilę.' }
});
app.use('/api', apiLimiter);

app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
app.use(express.static(path.join(ROOT, 'public')));

const jobStore = createJobStore(DATA_DIR);
// Ten sam katalog data/ co jobs.json (jobStore) - osobny plik
// (auto-config-memory.json), nie osobny appSlug (patrz mappingMemory.js).
const mappingMemory = createMappingMemory(DATA_DIR);

function decodeOriginalName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

function safeName(name, fallback = 'plik') {
  const cleaned = sanitize(String(name || fallback)).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return (cleaned || fallback).slice(0, 140);
}

function contentDispositionHeader(disposition, filename) {
  const raw = String(filename || 'plik').replace(/"/g, '');
  const asciiFallback = toAsciiSafe(raw).replace(/[^\x20-\x7E]/g, '_') || 'plik';
  const encoded = encodeURIComponent(raw).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function readHeader(filePath, length = 8) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

// Walidacja NIE ogranicza sie do rozszerzenia (sekcja 17): naglowek ZIP "PK"
// + realna zawartosc srodka archiwum (DOCX musi miec [Content_Types].xml i
// word/document.xml, XLSX musi miec xl/workbook.xml) - ten sam poziom
// rygoru co apps/dokumenty-seryjne/server.js#validateOfficeFile.
function validateOfficeZip(filePath, originalName, requiredEntries) {
  const header = readHeader(filePath, 4).toString('latin1');
  if (!header.startsWith('PK')) throw new Error(`Plik ${originalName} nie wygląda jak poprawny plik Office (zły nagłówek ZIP).`);
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch (err) {
    throw new Error(`Plik ${originalName} nie daje się otworzyć jako archiwum: ${err.message}`);
  }
  const names = new Set(zip.getEntries().map(e => e.entryName));
  for (const required of requiredEntries) {
    if (!names.has(required)) throw new Error(`Plik ${originalName} nie wygląda jak poprawny dokument Office (brak ${required}).`);
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}-${safeName(decodeOriginalName(file.originalname))}`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeOriginalName(file.originalname || '')).toLowerCase();
    if (file.fieldname === 'template' && ext === '.docx') return cb(null, true);
    if (file.fieldname === 'excel' && ext === '.xlsx') return cb(null, true);
    return cb(new Error('Wybierz wzór Word .docx i przykładową tabelę Excel .xlsx.'));
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'kreator-wzorow' }));

// ---------------------------------------------------------------------------
// KROK 1 - upload
// ---------------------------------------------------------------------------
app.post('/api/jobs', heavyJobLimiter, upload.fields([{ name: 'template', maxCount: 1 }, { name: 'excel', maxCount: 1 }]), async (req, res) => {
  const cleanupUploads = async () => {
    for (const f of [...(req.files?.template || []), ...(req.files?.excel || [])]) {
      await fsp.unlink(f.path).catch(() => {});
    }
  };
  try {
    const templateFile = req.files?.template?.[0];
    const excelFile = req.files?.excel?.[0];
    if (!templateFile) return res.status(400).json({ ok: false, message: 'Dodaj wzór Word (.docx).' });
    if (!excelFile) return res.status(400).json({ ok: false, message: 'Dodaj przykładową tabelę Excel (.xlsx).' });

    const templateOriginalName = decodeOriginalName(templateFile.originalname);
    const excelOriginalName = decodeOriginalName(excelFile.originalname);
    validateOfficeZip(templateFile.path, templateOriginalName, ['[Content_Types].xml', 'word/document.xml']);
    validateOfficeZip(excelFile.path, excelOriginalName, ['xl/workbook.xml']);

    const jobId = crypto.randomUUID();
    const outputDir = path.join(OUTPUT_DIR, jobId);
    await fsp.mkdir(outputDir, { recursive: true });

    // Pracujemy WYLACZNIE na kopii (sekcja 19) - oryginalny upload
    // (UPLOAD_DIR) zostaje nietkniety, kopia robocza w katalogu joba jest tym,
    // co faktycznie otwiera Word (skan i build), i jej hash sluzy do
    // wykrycia "wzor zmienil sie od czasu skanowania" (sekcja 22).
    const workingTemplatePath = path.join(outputDir, 'template.docx');
    await fsp.copyFile(templateFile.path, workingTemplatePath);
    const templateHash = sha256File(workingTemplatePath);

    const excelWorkingPath = path.join(outputDir, 'excel.xlsx');
    await fsp.copyFile(excelFile.path, excelWorkingPath);
    const workbook = await readWorkbook(excelWorkingPath);
    if (!workbook.sheetNames.length) {
      await fsp.rm(outputDir, { recursive: true, force: true });
      return res.status(400).json({ ok: false, message: 'Excel nie ma żadnego arkusza z danymi.' });
    }

    const job = jobStore.createJob(jobId, {
      status: 'uploaded',
      statusMessage: 'Pliki wczytane. Wykryj oznaczenia, żeby zobaczyć paletę kolorów użytych we wzorze.',
      templatePath: workingTemplatePath,
      templateOriginalName,
      templateHash,
      excelPath: excelWorkingPath,
      excelOriginalName,
      outputDir,
      logPath: path.join(outputDir, 'log.txt'),
      workbook,
      markingsPalette: null,
      selectedMarkings: null,
      candidates: null,
      draft: tm.emptyDraft({ templateName: templateOriginalName.replace(/\.docx$/i, ''), preferredSheet: workbook.defaultSheet, addressColumn: '' }),
      lastValidation: null,
      lastPreview: null,
      lastBuild: null
    });

    await cleanupUploads();
    res.json({
      ok: true,
      jobId,
      templateName: templateOriginalName,
      excelName: excelOriginalName,
      workbook: { sheetNames: workbook.sheetNames, defaultSheet: workbook.defaultSheet, columns: workbook.sheets[workbook.defaultSheet]?.columns || [] }
    });
  } catch (err) {
    await cleanupUploads();
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się wczytać plików.' });
  }
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania. Wczytaj pliki ponownie.' });
  res.json({ ok: true, job: publicJob(job) });
});

// Nie zwracamy sciezek na dysku ani pelnej zawartosci workbooka/kandydatow
// bez potrzeby - tylko to, czego UI faktycznie uzywa (sekcja 45: "nigdy nie
// loguj calego rekordu uzytkownika" - ta sama ostroznosc tutaj dla API).
function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    statusMessage: job.statusMessage,
    templateName: job.templateOriginalName,
    excelName: job.excelOriginalName,
    workbook: { sheetNames: job.workbook.sheetNames, defaultSheet: job.workbook.defaultSheet },
    markingsPalette: job.markingsPalette,
    selectedMarkings: job.selectedMarkings,
    candidatesCount: job.candidates ? job.candidates.length : null,
    candidates: job.candidates,
    draft: job.draft,
    lastValidation: job.lastValidation,
    lastPreview: job.lastPreview ? { warnings: job.lastPreview.warnings, errors: job.lastPreview.errors, hasDocx: Boolean(job.lastPreview.docxPath), hasPdf: Boolean(job.lastPreview.pdfPath) } : null,
    lastBuild: job.lastBuild ? { downloadName: job.lastBuild.downloadName } : null
  };
}

app.get('/api/jobs/:jobId/sheets/:sheetName/rows', (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  const sheet = job.workbook.sheets[req.params.sheetName];
  if (!sheet) return res.status(404).json({ ok: false, message: 'Nie znaleziono arkusza.' });
  res.json({ ok: true, columns: sheet.columns, ...sheetPreview(sheet, req.query.offset, req.query.limit) });
});

app.get('/api/jobs/:jobId/sheets/:sheetName/columns/:columnName/values', (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  const sheet = job.workbook.sheets[req.params.sheetName];
  if (!sheet) return res.status(404).json({ ok: false, message: 'Nie znaleziono arkusza.' });
  if (!sheet.columns.includes(req.params.columnName)) return res.status(404).json({ ok: false, message: 'Nie znaleziono kolumny w tym arkuszu.' });
  res.json({ ok: true, values: uniqueColumnValues(sheet, req.params.columnName) });
});

function assertTemplateUnchanged(job) {
  if (!fs.existsSync(job.templatePath) || sha256File(job.templatePath) !== job.templateHash) {
    throw new Error('Wzór zmienił się od czasu wczytania. Wczytaj/skanuj ponownie.');
  }
}

// ---------------------------------------------------------------------------
// KROK 1 (cd.) - paleta oznaczen. Migracja Word COM -> Open XML: bez Worda,
// bez cross-process locka (documentEngine.scanTemplatePalette otwiera plik
// tylko do odczytu przez Open XML SDK) - patrz CLAUDE.md.
// ---------------------------------------------------------------------------
app.post('/api/jobs/:jobId/scan-markings', heavyJobLimiter, async (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  try {
    assertTemplateUnchanged(job);
    jobStore.updateJob(job.id, { status: 'markings_scanning', statusMessage: 'Wykrywam oznaczenia użyte we wzorze...' });
    const result = await documentEngine.scanTemplatePalette(job.templatePath);
    if (!result.ok) throw new Error(result.message || 'Nie udało się wykryć oznaczeń.');
    jobStore.updateJob(job.id, { status: 'configuring', statusMessage: 'Wybierz, które oznaczenia są polami roboczymi.', markingsPalette: result.markings || [] });
    res.json({ ok: true, markings: result.markings || [] });
  } catch (err) {
    jobStore.updateJob(job.id, { status: 'error', statusMessage: err.message || 'Nie udało się wykryć oznaczeń.' });
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się wykryć oznaczeń.' });
  }
});

// ---------------------------------------------------------------------------
// KROK 1 (cd.) - skan wybranych oznaczen -> kandydaci. Migracja Word COM ->
// Open XML: bez Worda, bez cross-process locka.
// ---------------------------------------------------------------------------
app.post('/api/jobs/:jobId/scan', heavyJobLimiter, async (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' });
  const selectedMarkings = Array.isArray(req.body?.selectedMarkings) ? req.body.selectedMarkings.filter(m => typeof m === 'string') : [];
  if (!selectedMarkings.length) return res.status(400).json({ ok: false, message: 'Zaznacz przynajmniej jedno oznaczenie do skanowania.' });
  const sheetName = String(req.body?.sheetName || job.workbook.defaultSheet || '').trim();
  if (sheetName && job.workbook.sheets[sheetName]) job.draft = { ...job.draft, preferredSheet: sheetName };

  try {
    assertTemplateUnchanged(job);
    jobStore.updateJob(job.id, { status: 'scanning', statusMessage: 'Skanuję zaznaczone oznaczenia...' });
    const result = await documentEngine.scanTemplateCandidates(job.templatePath, selectedMarkings);
    if (!result.ok) throw new Error(result.message || 'Nie udało się przeskanować wzoru.');
    const candidates = result.candidates || [];
    const draft = tm.seedCandidates(job.draft, candidates.map(c => c.id));
    jobStore.updateJob(job.id, {
      status: 'configuring',
      statusMessage: `Znaleziono ${candidates.length} kandydatów. Skonfiguruj każdy z nich.`,
      selectedMarkings,
      candidates,
      draft
    });
    res.json({ ok: true, candidates, unresolvedCount: candidates.length });
  } catch (err) {
    jobStore.updateJob(job.id, { status: 'error', statusMessage: err.message || 'Nie udało się przeskanować wzoru.' });
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się przeskanować wzoru.' });
  }
});

// ---------------------------------------------------------------------------
// KROK 2 - konfiguracja kandydatow
// ---------------------------------------------------------------------------
function requireJob(req, res) {
  const job = jobStore.getJob(req.params.jobId);
  if (!job) { res.status(404).json({ ok: false, message: 'Nie znaleziono zadania.' }); return null; }
  if (!job.candidates) { res.status(400).json({ ok: false, message: 'Najpierw zeskanuj wzór.' }); return null; }
  return job;
}

app.post('/api/jobs/:jobId/candidates/:candidateId/constant', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const draft = tm.setCandidateConstant(job.draft, req.params.candidateId, req.body?.text);
  jobStore.updateJob(job.id, { draft });
  res.json({ ok: true, draft });
});

app.post('/api/jobs/:jobId/candidates/:candidateId/manual', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const draft = tm.setCandidateManual(job.draft, req.params.candidateId, req.body?.label);
  jobStore.updateJob(job.id, { draft });
  res.json({ ok: true, draft });
});

app.post('/api/jobs/:jobId/fields', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const body = req.body || {};
  const candidateId = String(body.candidateId || '');
  if (!candidateId) return res.status(400).json({ ok: false, message: 'Brak candidateId.' });
  const label = String(body.label || '').trim();
  if (!label) return res.status(400).json({ ok: false, message: 'Podaj nazwę pola.' });
  const valueSpec = body.valueSpec;
  if (!valueSpec || !['column', 'lookup', 'compose'].includes(valueSpec.type)) {
    return res.status(400).json({ ok: false, message: 'Nieprawidłowy typ wartości pola.' });
  }
  const { draft, fieldId } = tm.createFieldForCandidate(job.draft, candidateId, {
    label,
    required: body.required !== false,
    emptyPolicy: body.emptyPolicy === 'warn' ? 'warn' : 'error',
    unknownPolicy: body.unknownPolicy === 'warn' ? 'warn' : 'error',
    valueSpec
  });
  jobStore.updateJob(job.id, { draft });
  res.json({ ok: true, draft, fieldId });
});

app.post('/api/jobs/:jobId/candidates/:candidateId/assign-field', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  try {
    const draft = tm.assignCandidateToExistingField(job.draft, req.params.candidateId, String(req.body?.fieldId || ''));
    jobStore.updateJob(job.id, { draft });
    res.json({ ok: true, draft });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post('/api/jobs/:jobId/variant-groups', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const label = String(req.body?.label || '').trim();
  const policy = req.body?.policy === 'zeroOrOne' ? 'zeroOrOne' : 'exactlyOne';
  if (!label) return res.status(400).json({ ok: false, message: 'Podaj nazwę grupy wariantów.' });
  const { draft, groupId } = tm.createVariantGroup(job.draft, label, policy);
  jobStore.updateJob(job.id, { draft });
  res.json({ ok: true, draft, groupId });
});

app.post('/api/jobs/:jobId/blocks', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const body = req.body || {};
  const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.filter(Boolean) : (body.candidateId ? [body.candidateId] : []);
  if (!candidateIds.length) return res.status(400).json({ ok: false, message: 'Brak kandydatów do przypisania do bloku.' });
  const label = String(body.label || '').trim();
  if (!label) return res.status(400).json({ ok: false, message: 'Podaj nazwę bloku.' });
  const condition = body.condition;
  if (!condition || typeof condition.column !== 'string' || !condition.column.trim()) {
    return res.status(400).json({ ok: false, message: 'Podaj kolumnę i warunek bloku.' });
  }
  const blockDef = { label, condition, variantGroupId: body.variantGroupId || undefined };
  try {
    let draft, blockId;
    if (candidateIds.length === 1) {
      const created = tm.createBlockForCandidate(job.draft, candidateIds[0], blockDef);
      draft = created.draft;
      blockId = created.blockId;
    } else {
      draft = tm.mergeCandidatesIntoBlock(job.draft, candidateIds, blockDef);
    }
    jobStore.updateJob(job.id, { draft });
    res.json({ ok: true, draft, blockId });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Auto-konfiguracja (lokalny, deterministyczny silnik - zero AI/sieci, patrz
// PROMPT_CLAUDE_AUTO_KONFIGURACJA_KREATORA.md i src/autoConfigurator.js).
// Uzupelnia reczny panel powyzej, nigdy go nie zastepuje - kazda zaakceptowana
// sugestia przechodzi przez TE SAME helpery draftu (tm.*) co reczna decyzja
// (patrz src/autoConfigApply.js). `job.autoConfig` trzymane celowo malo -
// reasons juz ucinane do 5 wewnatrz analyzeAutoConfiguration, zero kopii
// wartosci rekordow z Excela.
// ---------------------------------------------------------------------------
app.post('/api/jobs/:jobId/auto-configure/analyze', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const sheetName = String(req.body?.sheetName || job.draft.preferredSheet || job.workbook.defaultSheet || '').trim();
  const sheet = job.workbook.sheets[sheetName];
  if (!sheet) return res.status(400).json({ ok: false, message: 'Nieznany arkusz. Wybierz arkusz przed analizą.' });
  try {
    const analysis = autoConfigurator.analyzeAutoConfiguration({
      candidates: job.candidates,
      workbook: job.workbook,
      sheetName,
      draft: job.draft,
      mappingMemory,
    });
    jobStore.updateJob(job.id, { autoConfig: { ...analysis, appliedSuggestionIds: [], rejectedSuggestionIds: [] } });
    res.json({ ok: true, analysis, analyzedAt: new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się przeanalizować wzoru.' });
  }
});

app.post('/api/jobs/:jobId/auto-configure/apply', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  if (!job.autoConfig) return res.status(400).json({ ok: false, message: 'Najpierw przeanalizuj wzór.' });
  const body = req.body || {};
  const suggestionIds = Array.isArray(body.suggestionIds) ? body.suggestionIds.filter(id => typeof id === 'string') : [];
  const applyHighConfidence = body.applyHighConfidence === true;
  const result = applyAutoConfiguration(job.draft, job.autoConfig, {
    suggestionIds,
    applyHighConfidence,
    mappingMemory,
    candidates: job.candidates,
  });
  const nextAppliedIds = [...new Set([...(job.autoConfig.appliedSuggestionIds || []), ...result.appliedSuggestionIds])];
  jobStore.updateJob(job.id, { draft: result.draft, autoConfig: { ...job.autoConfig, appliedSuggestionIds: nextAppliedIds } });
  const unresolvedCount = tm.unresolvedCandidateIds(result.draft, job.candidates.map(c => c.id)).length;
  res.json({ ok: true, draft: result.draft, appliedCount: result.appliedCount, appliedSuggestionIds: result.appliedSuggestionIds, unresolvedCount });
});

app.post('/api/jobs/:jobId/auto-configure/reject', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  if (!job.autoConfig) return res.status(400).json({ ok: false, message: 'Najpierw przeanalizuj wzór.' });
  const body = req.body || {};
  const suggestionIds = Array.isArray(body.suggestionIds) ? body.suggestionIds.filter(id => typeof id === 'string') : [];
  const suggestionsById = new Map((job.autoConfig.candidateSuggestions || []).map(s => [s.candidateId, s]));
  const candidatesById = new Map(job.candidates.map(c => [c.id, c]));
  let rejectedCount = 0;
  for (const id of suggestionIds) {
    const suggestion = suggestionsById.get(id);
    const candidate = candidatesById.get(id);
    if (!suggestion || !candidate) continue;
    mappingMemory.recordRejected(mappingMemory.buildContextKey(candidate), null, suggestion.bestColumn);
    rejectedCount++;
  }
  const nextRejectedIds = [...new Set([...(job.autoConfig.rejectedSuggestionIds || []), ...suggestionIds])];
  jobStore.updateJob(job.id, { autoConfig: { ...job.autoConfig, rejectedSuggestionIds: nextRejectedIds } });
  res.json({ ok: true, rejectedCount });
});

// Pelna konfiguracja naraz (kontrakt z sekcji 29 specyfikacji) - alternatywa
// dla granularnych endpointow powyzej, dla klientow ktore chca wyslac caly
// draft jednym zadaniem (np. operacje zbiorcze w UI). Przyjmuje WYLACZNIE
// pola semantyczne (bez mergeFieldName/bookmarkName - te zawsze generuje/
// zachowuje serwer), zeby przestrzen nazw SCY_F_/SCYB_ zawsze byla pod
// kontrola backendu, nigdy klienta.
app.put('/api/jobs/:jobId/config', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const body = req.body || {};
  const candidateIds = new Set(job.candidates.map(c => c.id));

  const nextFields = {};
  for (const [fieldId, def] of Object.entries(body.fields || {})) {
    if (!def || typeof def !== 'object') continue;
    const existing = job.draft.fields[fieldId];
    nextFields[fieldId] = {
      label: def.label,
      required: Boolean(def.required),
      emptyPolicy: def.emptyPolicy === 'warn' ? 'warn' : 'error',
      unknownPolicy: def.unknownPolicy === 'warn' ? 'warn' : 'error',
      valueSpec: def.valueSpec,
      mergeFieldName: (existing && existing.mergeFieldName) || tm.generateMergeFieldName()
    };
  }
  const nextBlocks = {};
  for (const [blockId, def] of Object.entries(body.blocks || {})) {
    if (!def || typeof def !== 'object') continue;
    const existing = job.draft.blocks[blockId];
    nextBlocks[blockId] = {
      label: def.label,
      condition: def.condition,
      variantGroupId: def.variantGroupId || undefined,
      bookmarkName: (existing && existing.bookmarkName) || tm.generateBookmarkName()
    };
  }
  const nextVariantGroups = {};
  for (const [groupId, def] of Object.entries(body.variantGroups || {})) {
    if (!def || typeof def !== 'object') continue;
    nextVariantGroups[groupId] = { label: def.label, policy: def.policy === 'zeroOrOne' ? 'zeroOrOne' : 'exactlyOne' };
  }
  const nextCandidates = {};
  for (const [candidateId, decision] of Object.entries(body.candidates || {})) {
    if (!candidateIds.has(candidateId) || !decision) continue;
    if (decision.status === 'field' && !nextFields[decision.fieldId]) continue;
    if (decision.status === 'block' && !nextBlocks[decision.blockId]) continue;
    nextCandidates[candidateId] = {
      status: tm.CANDIDATE_STATUSES.has(decision.status) ? decision.status : 'unresolved',
      constantText: decision.constantText == null ? null : String(decision.constantText),
      fieldId: decision.fieldId || null,
      blockId: decision.blockId || null,
      label: decision.label || null
    };
  }

  const draft = {
    templateName: String(body.templateName || job.draft.templateName || '').trim() || job.draft.templateName,
    preferredSheet: body.preferredSheet && job.workbook.sheets[body.preferredSheet] ? body.preferredSheet : job.draft.preferredSheet,
    addressColumn: typeof body.addressColumn === 'string' ? body.addressColumn : job.draft.addressColumn,
    candidates: { ...job.draft.candidates, ...nextCandidates },
    fields: nextFields,
    blocks: nextBlocks,
    variantGroups: nextVariantGroups
  };
  jobStore.updateJob(job.id, { draft });
  res.json({ ok: true, draft });
});

// ---------------------------------------------------------------------------
// KROK 3 - walidacja
// ---------------------------------------------------------------------------
function runPreflight(job, sheetName) {
  const errors = [];
  const warnings = [];

  const unresolved = tm.unresolvedCandidateIds(job.draft, job.candidates.map(c => c.id));
  for (const id of unresolved) warnings.push({ candidateId: id, message: 'Kandydat nadal nie ma przypisanej decyzji.' });

  if (!job.draft.addressColumn) errors.push({ message: 'Nie wybrano kolumny adresu (addressColumn).' });

  const manifest = tm.buildManifestFromDraft({ ...job.draft, preferredSheet: sheetName || job.draft.preferredSheet }, job.candidates);
  const manifestValidation = validateManifest(manifest);
  for (const message of manifestValidation.errors) errors.push({ message });

  // UWAGA (migracja Word COM -> Open XML, ETAP 2, jeszcze nie domkniete):
  // poprzednia wersja miala tu numeryczna walidacje nakladania sie zakresow
  // (candidateConfig.js#validateOverlaps) oparta na Range.Start/End z Word
  // COM. Nowy model kandydata (partUri/ordinal/structuralPath, patrz
  // lib/documentEngine.js) nie ma porownywalnej numerycznej pozycji miedzy
  // RUZNYMI mechanizmami (ordinal liczy sie osobno per paletteKey), wiec ta
  // sama walidacja nie da sie 1:1 przeniesc bez dostepu do zywego drzewa
  // OpenXml (ktore ma tylko silnik .NET, w trakcie samego builda). Typowy,
  // zamierzony przypadek ("field w calosci wewnatrz blocku") dziala poprawnie
  // z konstrukcji w BuildTemplateCommand (mutacje na bezposrednich referencjach
  // wezlow, nie na wspolrzednych) - PRAWDZIWA luka to brak wczesnego,
  // czytelnego bledu przy user-error (dwa bloki czesciowo nakladajace sie).
  // Patrz raport migracji w CLAUDE.md.

  let recordErrors = [];
  const sheet = job.workbook.sheets[sheetName || job.draft.preferredSheet];
  if (sheet && errors.length === 0) {
    const missingColumns = collectRequiredColumns(manifest).filter(col => !sheet.columns.includes(col));
    if (missingColumns.length) {
      errors.push({ message: `Wzór wymaga kolumn, których nie ma w arkuszu „${sheet.sheetName || sheetName}": ${missingColumns.join(', ')}.` });
    } else {
      for (const row of sheet.rows) {
        const evaluated = evaluateSmartRecord(manifest, row);
        if (evaluated.errors.length) {
          recordErrors.push({ row: row._record, address: String(row[manifest.addressColumn] || '').trim(), reasons: evaluated.errors.map(e => e.message) });
        }
      }
    }
  }

  return { manifest, errors, warnings, recordErrors, recordErrorsTotal: recordErrors.length, recordErrorsSample: recordErrors.slice(0, 10) };
}

app.post('/api/jobs/:jobId/validate', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const sheetName = String(req.body?.sheetName || job.draft.preferredSheet || job.workbook.defaultSheet || '').trim();
  const preflight = runPreflight(job, sheetName);
  const lastValidation = {
    ok: preflight.errors.length === 0 && preflight.recordErrorsTotal === 0,
    errors: preflight.errors,
    warnings: preflight.warnings,
    recordErrorsTotal: preflight.recordErrorsTotal,
    recordErrorsSample: preflight.recordErrorsSample,
    checkedAt: new Date().toISOString()
  };
  jobStore.updateJob(job.id, { status: 'configuring', lastValidation });
  res.json({ ok: true, validation: lastValidation });
});

// ---------------------------------------------------------------------------
// KROK 4A - podglad (przez runtime Dokumentow seryjnych, sekcja 27)
// ---------------------------------------------------------------------------
app.post('/api/jobs/:jobId/preview', heavyJobLimiter, async (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  if (process.platform !== 'win32') return res.status(400).json({ ok: false, message: 'Podgląd działa tylko na Windows z zainstalowanym Microsoft Word.' });
  const sheetName = String(req.body?.sheetName || job.draft.preferredSheet || job.workbook.defaultSheet || '').trim();
  const recordNumber = Number(req.body?.recordNumber);
  const sheet = job.workbook.sheets[sheetName];
  if (!sheet) return res.status(404).json({ ok: false, message: 'Nie znaleziono arkusza.' });
  const record = sheet.rows.find(r => Number(r._record) === recordNumber) || sheet.rows[0];
  if (!record) return res.status(400).json({ ok: false, message: 'Arkusz nie ma żadnych rekordów do podglądu.' });

  const preflight = runPreflight(job, sheetName);
  if (preflight.errors.length) {
    return res.status(400).json({ ok: false, message: 'Wzór ma błędy konfiguracji - napraw je przed podglądem.', errors: preflight.errors });
  }
  const evaluated = evaluateSmartRecord(preflight.manifest, record);

  try {
    assertTemplateUnchanged(job);
    jobStore.updateJob(job.id, { status: 'previewing', statusMessage: 'Generuję próbkę...' });

    const previewDir = path.join(job.outputDir, 'preview');
    await fsp.rm(previewDir, { recursive: true, force: true });
    await fsp.mkdir(previewDir, { recursive: true });
    const dataJsonPath = path.join(previewDir, 'merge-data.json');
    fs.writeFileSync(dataJsonPath, JSON.stringify({ sheetName, addressColumn: preflight.manifest.addressColumn, records: [evaluated.record] }), 'utf8');

    const args = [
      '-TemplatePath', job.templatePath,
      '-ExcelPath', job.excelPath,
      '-OutputDir', previewDir,
      '-SheetName', sheetName,
      '-AddressColumn', preflight.manifest.addressColumn,
      '-DataJson', dataJsonPath,
      '-LogPath', path.join(previewDir, 'log.txt'),
      '-DebugJsonPath', path.join(previewDir, 'debug-events.jsonl'),
      '-ReplacementJson', path.join(previewDir, 'no-replacements.json'),
      '-FilePrefix', 'podglad',
      '-SmartTemplateMode',
      '-SaveWord'
    ];
    fs.writeFileSync(path.join(previewDir, 'no-replacements.json'), JSON.stringify({ rules: [] }), 'utf8');

    let waitLogged = false;
    const result = await withWordAutomationLease(
      { app: 'kreator-wzorow', operation: `podgląd: ${job.templateOriginalName}` },
      () => runPowerShell(DOKUMENTY_SERYJNE_MAILMERGE_SCRIPT, args, { cwd: path.join(ROOT, '..', 'dokumenty-seryjne'), timeoutMs: Number(process.env.KREATOR_PS_TIMEOUT_MS || 20 * 60 * 1000) }),
      { onWaiting: () => { if (waitLogged) return; waitLogged = true; jobStore.updateJob(job.id, { statusMessage: 'Word jest zajęty przez inne narzędzie - czekam na zwolnienie...' }); } }
    );

    const lines = String(result.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const finalLine = [...lines].reverse().find(l => l.startsWith('{') && l.endsWith('}') && l.includes('"created"'));
    const parsed = finalLine ? JSON.parse(finalLine) : null;
    if (!parsed || !parsed.ok || !(parsed.created || []).length) {
      throw new Error((parsed && parsed.message) || result.stderr || 'Generowanie próbki nie powiodło się.');
    }
    const createdDocx = (parsed.created || []).find(f => String(f.file).toLowerCase().endsWith('.docx'));
    const createdPdf = (parsed.created || []).find(f => String(f.file).toLowerCase().endsWith('.pdf'));

    const lastPreview = {
      docxPath: createdDocx ? createdDocx.path : null,
      pdfPath: createdPdf ? createdPdf.path : null,
      warnings: evaluated.warnings,
      errors: []
    };
    jobStore.updateJob(job.id, { status: 'configuring', statusMessage: 'Podgląd gotowy.', lastPreview });
    res.json({ ok: true, preview: { warnings: evaluated.warnings, hasDocx: Boolean(lastPreview.docxPath), hasPdf: Boolean(lastPreview.pdfPath) } });
  } catch (err) {
    jobStore.updateJob(job.id, { status: 'configuring', statusMessage: err.message || 'Nie udało się wygenerować podglądu.' });
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się wygenerować podglądu.' });
  }
});

// ---------------------------------------------------------------------------
// KROK 4 - build
// ---------------------------------------------------------------------------
app.post('/api/jobs/:jobId/build', heavyJobLimiter, async (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const sheetName = String(req.body?.sheetName || job.draft.preferredSheet || job.workbook.defaultSheet || '').trim();
  const templateName = String(req.body?.templateName || job.draft.templateName || job.templateOriginalName).trim();

  // Nierozwiazany kandydat NIE moze po cichu zostac uznany za staly (sekcja
  // 24) - dla /validate to tylko ostrzezenie ("jeszcze nie skonczyles"), ale
  // przed FINALNYM buildem kazdy kandydat musi miec jawna decyzje, inaczej
  // build-template.ps1 nie wiedzialby, co zrobic z jego oznaczeniem.
  const unresolved = tm.unresolvedCandidateIds(job.draft, job.candidates.map(c => c.id));
  if (unresolved.length) {
    return res.status(400).json({ ok: false, message: `${unresolved.length} kandydatów nadal nie ma przypisanej decyzji (STAŁE/Z EXCELA/WARIANT/WARUNEK/DO PROJEKTANTA) - skonfiguruj wszystkich przed zbudowaniem wzoru.`, unresolvedCandidateIds: unresolved });
  }

  const preflight = runPreflight(job, sheetName);
  if (preflight.errors.length || preflight.recordErrorsTotal > 0) {
    return res.status(400).json({ ok: false, message: 'Wzór ma błędy konfiguracji - popraw je przed zbudowaniem.', errors: preflight.errors, recordErrorsSample: preflight.recordErrorsSample, recordErrorsTotal: preflight.recordErrorsTotal });
  }

  try {
    assertTemplateUnchanged(job);
    jobStore.updateJob(job.id, { status: 'building', statusMessage: 'Buduję wzór...', draft: { ...job.draft, templateName, preferredSheet: sheetName } });

    const manifest = { ...preflight.manifest, templateName };
    const manifestJson = JSON.stringify(manifest);
    fs.writeFileSync(path.join(job.outputDir, 'manifest.json'), manifestJson, 'utf8');
    fs.writeFileSync(path.join(job.outputDir, 'draft.json'), JSON.stringify(job.draft), 'utf8');
    fs.writeFileSync(path.join(job.outputDir, 'candidates.json'), JSON.stringify(job.candidates), 'utf8');

    const outputName = safeName(`${templateName}_seryjny`, 'wzor_seryjny') + '.docx';
    const outputPath = path.join(job.outputDir, outputName);

    // Migracja Word COM -> Open XML: bez Worda, bez cross-process locka
    // (documentEngine.buildSmartTemplate uruchamia Scyzoryk.DocumentEngine.exe,
    // ktory dziala na kopii pliku, nigdy na oryginale job.templatePath).
    const result = await documentEngine.buildSmartTemplate({
      templatePath: job.templatePath,
      outputPath,
      selectedMarkings: job.selectedMarkings || [],
      storedCandidates: job.candidates,
      draft: job.draft,
      manifestJson,
    });
    if (!result.ok) throw new Error(result.message || 'Nie udało się zbudować wzoru.');

    const lastBuild = { templatePath: outputPath, downloadName: outputName, builtAt: new Date().toISOString(), warnings: result.warnings || [] };
    jobStore.updateJob(job.id, { status: 'done', statusMessage: `Wzór gotowy: ${outputName}`, lastBuild });
    res.json({ ok: true, downloadName: outputName, warnings: result.warnings || [] });
  } catch (err) {
    jobStore.updateJob(job.id, { status: 'error', statusMessage: err.message || 'Nie udało się zbudować wzoru.' });
    res.status(400).json({ ok: false, message: err.message || 'Nie udało się zbudować wzoru.' });
  }
});

// ---------------------------------------------------------------------------
// Pobieranie plikow
// ---------------------------------------------------------------------------
app.get('/api/jobs/:jobId/download/template', (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job || !job.lastBuild || !fs.existsSync(job.lastBuild.templatePath)) return res.status(404).json({ ok: false, message: 'Wzór nie został jeszcze zbudowany.' });
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', job.lastBuild.downloadName));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.sendFile(job.lastBuild.templatePath);
});

function downloadPreviewFile(req, res, key, contentType) {
  const job = jobStore.getJob(req.params.jobId);
  const filePath = job && job.lastPreview && job.lastPreview[key];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ ok: false, message: 'Podgląd nie jest jeszcze dostępny.' });
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', path.basename(filePath)));
  res.setHeader('Content-Type', contentType);
  res.sendFile(filePath);
}
app.get('/api/jobs/:jobId/download/preview/docx', (req, res) => downloadPreviewFile(req, res, 'docxPath', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
app.get('/api/jobs/:jobId/download/preview/pdf', (req, res) => downloadPreviewFile(req, res, 'pdfPath', 'application/pdf'));

app.get('/api/jobs/:jobId/download/logs', (req, res) => {
  const job = jobStore.getJob(req.params.jobId);
  if (!job || !job.logPath || !fs.existsSync(job.logPath)) return res.status(404).json({ ok: false, message: 'Brak logu dla tego zadania.' });
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', `log-${job.id}.txt`));
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(job.logPath);
});

jobStore.pruneOlderThan(JOB_TTL_MS, job => {
  fs.rm(job.outputDir, { recursive: true, force: true }, () => {});
});
setInterval(() => {
  jobStore.pruneOlderThan(JOB_TTL_MS, job => { fs.rm(job.outputDir, { recursive: true, force: true }, () => {}); });
}, 60 * 60 * 1000).unref();

// require.main === module: uruchomienie serwera TYLKO gdy plik jest startowany
// bezposrednio (node server.js), nie przy require() z testow (ten sam wzorzec
// co apps/dokumenty-seryjne/server.js i inne apki w tym repo).
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => console.log(`Kreator wzorów seryjnych: http://${HOST}:${PORT}`));
  applyHttpTimeouts(server, 'KREATOR');
}

module.exports = { app, jobStore, publicJob, runPreflight };
