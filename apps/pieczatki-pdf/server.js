const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib.default || rateLimitLib;
const express = require('express');
const multer = require('multer');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const archiverModule = require('archiver');
const archiver = typeof archiverModule === 'function' ? archiverModule : (archiverModule.default || archiverModule.create || archiverModule.archiver);
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { setupProcessDiagnostics, applyHttpTimeouts, scheduleCleanup } = require('../../lib/hardening');
const { ensureAnonymousSessionExpress } = require('../../lib/auth/middleware');


function assertArchiverAvailable() {
  if (typeof archiver !== 'function') {
    throw new Error('Nie udało się przygotować paczki ZIP. Uruchom ponownie instalację zależności.');
  }
}

const app = express();
setupProcessDiagnostics('pieczatki-pdf', __dirname);
const PORT = process.env.PORT || 3000;
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const OUTPUT_DIR = path.join(ROOT, 'output');
const TMP_DIR = path.join(ROOT, 'tmp');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 80);
const MAX_FILES = Number(process.env.MAX_FILES || 30);
const MAX_STAMPS = Number(process.env.MAX_STAMPS || 20);
const MAX_PAGES_PER_PDF = Number(process.env.MAX_PAGES_PER_PDF || 300);

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
scheduleCleanup([UPLOAD_DIR, OUTPUT_DIR, TMP_DIR], 24 * 60 * 60 * 1000, 60 * 60 * 1000);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeBase = path.basename(file.originalname || 'plik', ext)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'plik';
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${safeBase}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    files: MAX_FILES,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const isPdf = ext === '.pdf' || file.mimetype === 'application/pdf';
    if (file.fieldname === 'pdfs' && isPdf) return cb(null, true);
    cb(new Error('Dozwolone sa tylko pliki PDF do ostemplowania.'));
  },
});

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};
app.disable('x-powered-by');
app.use((req, res, next) => { for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value); next(); });
// Pracownicy NIE musza sie logowac - to tylko anonimowa izolacja danych
// roboczych miedzy przegladarkami (req.sessionId), NIGDY nie blokuje
// zadania. SCYZORYK_PILOT_MODE jest ustawiane przez korzenny server.js na
// podstawie aktywnego profilu (SCYZORYK_PROFILE) - profil "windows" nigdy
// go nie ustawia, wiec ten sam kod dziala bez zmian rowniez poza pilotem.
// /api/health jest pominiete celowo - korzenny supervisor pyta o nie co
// kilka-kilkanascie sekund tylko po to, zeby sprawdzic czy proces zyje, i
// nie powinno to tworzyc/odswiezac prawdziwej sesji roboczej.
if (process.env.SCYZORYK_PILOT_MODE === '1') {
  app.use((req, res, next) => (req.path === '/api/health' ? next() : ensureAnonymousSessionExpress(req, res, next)));
}
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Scyzoryk-Request') === '1') return next();
  res.status(403).json({ error: 'Brak zabezpieczonego naglowka zadania. Odśwież stronę i spróbuj ponownie.' });
});
app.use('/pdfjs', express.static(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build')));
app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json({ limit: '4mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PIECZATKI_API_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za duzo zadan w krotkim czasie. Odczekaj chwile i sprobuj ponownie.' }
});
const heavyJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PIECZATKI_HEAVY_RATE_LIMIT || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Za duzo ciezkich zadan w krotkim czasie. Uruchom mniejsza paczke albo odczekaj chwile.' }
});
app.use('/api', apiLimiter);



function readHeader(filePath, length = 8) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function validateUploadedPdfFile(file) {
  const header = readHeader(file.path, 8);
  const ascii = header.toString('latin1');
  if (!ascii.startsWith('%PDF-')) throw new Error(`Plik ${file.originalname || file.filename} nie wygląda jak poprawny PDF.`);
}

function parseNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function cleanText(value) {
  return String(value || '').replace(/[^\S\n]+/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
}

function pageMatches(index, pageCount, mode, customPages) {
  if (mode === 'first') return index === 0;
  if (mode === 'last') return index === pageCount - 1;
  if (mode === 'custom') return customPages.has(index + 1);
  return true;
}

function parseCustomPages(input, pageCount) {
  const result = new Set();
  const raw = String(input || '').replace(/\s+/g, '');
  if (!raw) return result;

  for (const part of raw.split(',')) {
    if (!part) continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(n => Number(n));
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      const from = Math.max(1, Math.min(a, b));
      const to = Math.min(pageCount, Math.max(a, b));
      for (let i = from; i <= to; i++) result.add(i);
    } else {
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1 && n <= pageCount) result.add(n);
    }
  }
  return result;
}

function normalizePageOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [pageKey, value] of Object.entries(raw)) {
    const pageNumber = Number(pageKey);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 10000) continue;
    if (!value || typeof value !== 'object') continue;
    result[String(pageNumber)] = {
      xPct: parseNumber(value.xPct, 70, 0, 100),
      yPct: parseNumber(value.yPct, 75, 0, 100),
      widthPct: parseNumber(value.widthPct, 20, 1, 100),
      heightPct: parseNumber(value.heightPct, 10, 1, 100),
      rotation: parseNumber(value.rotation, 0, -360, 360),
    };
  }
  return result;
}

function optionsForPage(opts, pageNumber) {
  const override = opts.pageOverrides?.[String(pageNumber)];
  if (!override) return opts;
  return { ...opts, ...override };
}

function safeOutputName(originalName) {
  const ext = path.extname(originalName || '.pdf') || '.pdf';
  const base = path.basename(originalName || 'plik.pdf', ext)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'plik';
  return `${base} - ostemplowany.pdf`;
}

function normalizeHexColor(hex, fallback = '#d40000') {
  return /^#[0-9a-f]{6}$/i.test(String(hex || '')) ? String(hex) : fallback;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex).replace('#', '');
  return rgb(
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
  );
}

function ensureFontkit(doc) {
  if (doc.__fontkitRegistered) return;
  doc.registerFontkit(fontkit);
  doc.__fontkitRegistered = true;
}

function stripUnsupportedText(text) {
  const polish = {
    'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ż': 'z', 'ź': 'z',
    'Ą': 'A', 'Ć': 'C', 'Ę': 'E', 'Ł': 'L', 'Ń': 'N', 'Ó': 'O', 'Ś': 'S', 'Ż': 'Z', 'Ź': 'Z',
  };
  return String(text || '')
    .replace(/[ąćęłńóśżźĄĆĘŁŃÓŚŻŹ]/g, ch => polish[ch] || ch)
    .replace(/[^\n\x20-\x7E]/g, '?');
}

async function loadTextFont(doc) {
  let font;
  let isCustom = false;
  const fontPaths = [
    'C:\\Windows\\Fonts\\arialbd.ttf',
    'C:\\Windows\\Fonts\\Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  for (const p of fontPaths) {
    try {
      const bytes = await fsp.readFile(p);
      ensureFontkit(doc);
      font = await doc.embedFont(bytes);
      isCustom = true;
      break;
    } catch (e) {}
  }
  if (!font) {
    font = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  return { font, isCustom };
}

async function prepareStamp(doc, opts) {
  if (!opts.text) return null;
  const { font, isCustom } = await loadTextFont(doc);
  const text = isCustom ? opts.text : stripUnsupportedText(opts.text);
  return {
    type: 'text',
    embedded: font,
    naturalWidth: 1000,
    naturalHeight: 360,
    text,
    color: hexToRgb(opts.textColor),
    border: opts.textBorder,
    fontSize: opts.fontSize,
  };
}

function visualPageSize(page) {
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const width = page.getWidth();
  const height = page.getHeight();
  if (rotation === 90 || rotation === 270) {
    return { width: height, height: width, rotation, pageWidth: width, pageHeight: height };
  }
  return { width, height, rotation, pageWidth: width, pageHeight: height };
}

function mapVisualBottomLeftToPdf(page, visualX, visualY) {
  const { rotation, pageWidth, pageHeight } = visualPageSize(page);
  if (rotation === 90) return { x: pageWidth - visualY, y: visualX, rotation };
  if (rotation === 180) return { x: pageWidth - visualX, y: pageHeight - visualY, rotation };
  if (rotation === 270) return { x: visualY, y: pageHeight - visualX, rotation };
  return { x: visualX, y: visualY, rotation };
}

function normalizeStampOptions(raw, index) {
  const pageMode = ['all', 'first', 'last', 'custom'].includes(raw.pageMode) ? raw.pageMode : 'all';
  return {
    name: cleanText(raw.name || `Pieczatka ${index + 1}`).slice(0, 80) || `Pieczatka ${index + 1}`,
    xPct: parseNumber(raw.xPct, 70, 0, 100),
    yPct: parseNumber(raw.yPct, 75, 0, 100),
    widthPct: parseNumber(raw.widthPct, 20, 1, 100),
    heightPct: parseNumber(raw.heightPct, 10, 1, 100),
    rotation: parseNumber(raw.rotation, 0, -360, 360),
    opacity: parseNumber(raw.opacity, 0.85, 0.05, 1),
    pageMode,
    customPages: raw.customPages || '',
    excludedPages: Array.isArray(raw.excludedPages) ? raw.excludedPages.join(',') : (raw.excludedPages || ''),
    pageOverrides: normalizePageOverrides(raw.pageOverrides),
    text: cleanText(raw.stampText || raw.text),
    textColor: raw.textColor || '#d40000',
    textBorder: parseBoolean(raw.textBorder),
    fontSize: parseNumber(raw.fontSize, 0, 0, 96),
  };
}

function parseStampsFromRequest(body) {
  let rawStamps = [];
  if (body.stamps) {
    try {
      const parsed = JSON.parse(body.stamps);
      if (Array.isArray(parsed)) rawStamps = parsed;
    } catch (e) {
      throw new Error('Niepoprawna lista pieczatek.');
    }
  }

  if (!rawStamps.length) {
    rawStamps = [{
      xPct: body.xPct,
      yPct: body.yPct,
      widthPct: body.widthPct,
      heightPct: body.heightPct,
      rotation: body.rotation,
      opacity: body.opacity,
      pageMode: body.pageMode,
      customPages: body.customPages,
      excludedPages: body.excludedPages,
      stampText: body.stampText,
      textColor: body.textColor,
      textBorder: body.textBorder,
      fontSize: body.fontSize,
    }];
  }

  const stamps = rawStamps.slice(0, MAX_STAMPS).map((stamp, index) => normalizeStampOptions(stamp, index));
  return stamps.filter(stamp => Boolean(stamp.text));
}

function drawPreparedStampOnPage(page, preparedStamp, opts) {
  const visual = visualPageSize(page);
  const visualWidth = visual.width;
  const visualHeight = visual.height;

  const stampWidth = Math.max(8, visualWidth * opts.widthPct / 100);
  const stampHeight = Math.max(8, visualHeight * opts.heightPct / 100);

  const visualX = visualWidth * opts.xPct / 100;
  const visualTop = visualHeight * opts.yPct / 100;
  const visualY = visualHeight - visualTop - stampHeight;
  const mapped = mapVisualBottomLeftToPdf(page, visualX, visualY);
  const drawRotation = (((mapped.rotation + opts.rotation) % 360) + 360) % 360;

  if (preparedStamp.border) {
    page.drawRectangle({
      x: mapped.x,
      y: mapped.y,
      width: stampWidth,
      height: stampHeight,
      borderColor: preparedStamp.color,
      borderWidth: Math.max(1, stampWidth * 0.018),
      opacity: opts.opacity,
      rotate: degrees(drawRotation),
    });
  }
  const lines = preparedStamp.text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8);
  const fontSize = Math.max(6, Math.min(stampHeight / Math.max(lines.length, 1) * 0.55, stampWidth / 10, preparedStamp.fontSize || 28));
  const lineHeight = fontSize * 1.18;
  const totalHeight = lineHeight * lines.length;
  const firstY = mapped.y + (stampHeight - totalHeight) / 2 + totalHeight - fontSize;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const textWidth = preparedStamp.embedded.widthOfTextAtSize(line, fontSize);
    page.drawText(line, {
      x: mapped.x + Math.max(4, (stampWidth - textWidth) / 2),
      y: firstY - li * lineHeight,
      size: fontSize,
      font: preparedStamp.embedded,
      color: preparedStamp.color,
      opacity: opts.opacity,
      rotate: degrees(drawRotation),
    });
  }
}

async function stampPdf(inputFile, stamps, jobDir) {
  const bytes = await fsp.readFile(inputFile.path);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  if (pages.length > MAX_PAGES_PER_PDF) {
    throw new Error(`PDF ${inputFile.originalname} ma za duzo stron (${pages.length}). Limit: ${MAX_PAGES_PER_PDF}.`);
  }

  const prepared = [];
  for (const stamp of stamps) {
    const preparedStamp = await prepareStamp(doc, stamp);
    if (!preparedStamp) {
      throw new Error(`Brak poprawnej pieczatki: ${stamp.name}.`);
    }
    prepared.push({
      opts: stamp,
      preparedStamp,
      customPages: parseCustomPages(stamp.customPages, pages.length),
      excludedPages: parseCustomPages(stamp.excludedPages, pages.length),
    });
  }

  for (const item of prepared) {
    for (let i = 0; i < pages.length; i++) {
      if (!pageMatches(i, pages.length, item.opts.pageMode, item.customPages)) continue;
      if (item.excludedPages.has(i + 1)) continue;
      drawPreparedStampOnPage(pages[i], item.preparedStamp, optionsForPage(item.opts, i + 1));
    }
  }

  const outputBytes = await doc.save({ useObjectStreams: true });
  const outPath = path.join(jobDir, safeOutputName(inputFile.originalname));
  await fsp.writeFile(outPath, outputBytes);
  return outPath;
}

async function zipFiles(files, zipPath) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    assertArchiverAvailable();
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    for (const file of files) {
      archive.file(file, { name: path.basename(file) });
    }
    archive.finalize();
  });
}

async function removeFiles(files) {
  for (const file of files.filter(Boolean)) {
    await fsp.rm(file, { force: true, recursive: true }).catch(() => {});
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'pdf-stamper-standalone' });
});

app.post('/api/stamp', heavyJobLimiter, upload.array('pdfs', MAX_FILES), async (req, res) => {
  const uploadedPdfs = req.files || [];
  const cleanup = uploadedPdfs.map(f => f.path);
  const jobId = crypto.randomUUID();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  const zipPath = path.join(OUTPUT_DIR, `${jobId}.zip`);

  try {
    if (!uploadedPdfs.length) {
      // Wczesny return bez sprzatania zostawialby wgrane pliki (np. same
      // pieczatki bez zadnego PDF-a) na dysku az do okresowego
      // scheduleCleanup (do 24h) zamiast usunac je od razu.
      await removeFiles(cleanup);
      return res.status(400).json({ error: 'Dodaj przynajmniej jeden plik PDF.' });
    }
    for (const file of uploadedPdfs) validateUploadedPdfFile(file);

    const stamps = parseStampsFromRequest(req.body);
    if (!stamps.length) {
      await removeFiles(cleanup);
      return res.status(400).json({ error: 'Dodaj przynajmniej jedna pieczatke z tekstem.' });
    }

    await fsp.mkdir(jobDir, { recursive: true });
    const outputs = [];
    for (const pdf of uploadedPdfs) {
      outputs.push(await stampPdf(pdf, stamps, jobDir));
    }

    if (outputs.length === 1) {
      res.download(outputs[0], path.basename(outputs[0]), async () => {
        await removeFiles([...cleanup, jobDir]);
      });
    } else {
      await zipFiles(outputs, zipPath);
      res.download(zipPath, 'ostemplowane-pdf.zip', async () => {
        await removeFiles([...cleanup, jobDir, zipPath]);
      });
    }
  } catch (err) {
    await removeFiles([...cleanup, jobDir, zipPath]);
    console.error(err);
    res.status(500).json({ error: err.message || 'Nie udalo sie ostemplowac PDF.' });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Blad przesylania plikow.' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`PDF Stamper dziala tylko lokalnie: http://${HOST}:${PORT}`);
});
applyHttpTimeouts(server, 'PIECZATKI');
