const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createRequire } = require('module');
const { setupProcessDiagnostics, applyHttpTimeouts, appendJsonLine, sanitizeForLog } = require('./lib/hardening');
const { acquireSingleInstanceLock } = require('./lib/singleInstanceLock');
const { recordChildFailure } = require('./lib/childRestartPolicy');
const { getDataRoot, getAppDataDir } = require('./lib/appPaths');
const { migrateLegacyDataIfNeeded } = require('./lib/appDataMigration');
const { hasDependencies } = require('./lib/dependencyCheck');
const { getInstalledVersion } = require('./lib/updateBuildInfo');
const { createUpdateService } = require('./lib/updateService');

const ROOT = __dirname;
const PANEL_DATA_ROOT = getAppDataDir('panel');
// Realny blad zlapany 2026-07-24: sprawdzenie Chromium w appHasDependencies() (nizej)
// czyta process.env.PLAYWRIGHT_BROWSERS_PATH, zeby wiedziec, GDZIE playwright trzyma
// swoja przegladarke (wspolna z tym, co child-procesy dostaja przy starcie - patrz
// startChild). Jesli ktos uruchomi `node server.js` bezposrednio, bez wczesniejszego
// `set PLAYWRIGHT_BROWSERS_PATH=0` w powloce (jak robia to STARTUJ-SCYZORYK*.cmd),
// zmienna byla pusta - sprawdzenie patrzylo w zly (globalny, ~/.cache) folder, uznawalo
// realnie zainstalowanego Chromium za "brakujacego" i wywolywalo zbedna, wieloninutowa
// reinstalacje/ponowne pobranie przy KAZDYM starcie. Ustawiane tu wprost (ten sam wzorzec
// obronny co install-all.js), zeby caly proces (sprawdzenie ORAZ dzieci) mial spojna,
// gwarantowana wartosc niezaleznie od tego, jak server.js zostal uruchomiony.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
if (process.env.SCYZORYK_SKIP_DATA_MIGRATION !== '1') {
  migrateLegacyDataIfNeeded([{ slug: 'panel', dir: ROOT }]);
}
const diagnostics = setupProcessDiagnostics('panel-glowny', PANEL_DATA_ROOT);
const CHILDREN_LOG_FILE = path.join(PANEL_DATA_ROOT, 'logs', 'children.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared-styles');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';

// --- Aktualizacje przez GitHub Releases (lib/updateService.js) ---
// Domyslnie WLACZONE, ALE: jesli SCYZORYK_UPDATE_ENABLED nie jest ustawione
// wprost, dziedziczymy wylaczenie z SCYZORYK_SKIP_CHILD_START (flaga uzywana
// przez istniejace testy tras panelu, patrz test/group1-supervisor.test.js) -
// bez tego kazdy test spawnujacy server.js zaczalby po 3s wykonywac
// prawdziwe zapytanie do api.github.com, co jest niepotrzebnym zewnetrznym
// zaleznieniem i zrodlem flaki testow w piaskownicy bez internetu. Testy
// dedykowane samemu aktualizatorowi wlaczaja to jawnie (SCYZORYK_UPDATE_ENABLED=1)
// razem z SCYZORYK_UPDATE_API_BASE_URL wskazujacym na lokalny mock.
const UPDATE_ENABLED = process.env.SCYZORYK_UPDATE_ENABLED != null
  ? process.env.SCYZORYK_UPDATE_ENABLED !== '0'
  : process.env.SCYZORYK_SKIP_CHILD_START !== '1';
const UPDATE_REPOSITORY = process.env.SCYZORYK_UPDATE_REPOSITORY || 'mcyniak/scyzoryk-projektowy';
const UPDATE_CHECK_INTERVAL_MS = Number(process.env.SCYZORYK_UPDATE_CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000);
// SCYZORYK_UPDATE_API_BASE_URL / SCYZORYK_UPDATE_DRY_RUN / SCYZORYK_UPDATE_ROOT
// sa czytane WYLACZNIE ze zmiennych srodowiskowych procesu (nigdy z requestu
// przegladarki) - sluza testom i lokalnemu uruchamianiu, nie sa i nie moga
// byc wystawione przez zaden endpoint HTTP.
function resolveUpdateRoot() {
  if (process.env.SCYZORYK_UPDATE_ROOT) return path.resolve(process.env.SCYZORYK_UPDATE_ROOT);
  const localData = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!localData) throw new Error('Brak SCYZORYK_UPDATE_ROOT, LOCALAPPDATA i APPDATA - nie mozna wyznaczyc katalogu aktualizacji.');
  return path.join(localData, 'ScyzorykProjektowy', 'Updates');
}
const UPDATE_DRY_RUN = process.env.SCYZORYK_UPDATE_DRY_RUN === '1';
const updateServiceDeps = UPDATE_DRY_RUN ? {
  // Tryb wylacznie do testow/lokalnego sprawdzania: prawdziwe sprawdzenie
  // GitHub, prawdziwe pobieranie i weryfikacja SHA-256 przechodza normalnie,
  // ale FAKTYCZNE odpalenie instalatora jest tylko zalogowane, nigdy nie
  // uruchamiamy prawdziwego PowerShella/Inno Setup w tym trybie.
  spawnUpdaterProcess(invocation) {
    diagnostics.log('info', 'update-dry-run-spawn', { exe: invocation.exe, args: invocation.args });
    return null;
  }
} : {};
const updateService = createUpdateService({
  rootDir: ROOT,
  getInstalledVersion: () => getInstalledVersion(ROOT),
  repo: UPDATE_REPOSITORY,
  updateRoot: resolveUpdateRoot(),
  enabled: UPDATE_ENABLED,
  apiBaseUrl: process.env.SCYZORYK_UPDATE_API_BASE_URL || undefined,
  log: diagnostics.log,
  deps: updateServiceDeps
});

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};

const apps = [
  { slug: 'drukarka', name: 'Drukarka', description: 'Kolejkowanie i drukowanie dokumentow z lokalnego panelu.', dir: path.join(ROOT, 'apps', 'drukarka'), port: Number(process.env.DRUKARKA_PORT || 3001), healthPath: '/api/health' },
  { slug: 'pieczatki-pdf', name: 'Pieczatki PDF', description: 'Dodawanie pieczatki do plikow PDF i pobieranie wynikow.', dir: path.join(ROOT, 'apps', 'pieczatki-pdf'), port: Number(process.env.PIECZATKI_PORT || 3002), healthPath: '/api/health' },
  { slug: 'formularze-ecodan', name: 'Dobory myEcodan', description: 'Generator raportow/formularzy na podstawie danych z Excela.', dir: path.join(ROOT, 'apps', 'formularze-ecodan'), port: Number(process.env.FORMULARZE_PORT || 3003), healthPath: '/api/health', extraEnv: { HEADLESS: process.env.HEADLESS || 'true', BATCH_CONCURRENCY: process.env.BATCH_CONCURRENCY || '1', BATCH_RESTART_EVERY: process.env.BATCH_RESTART_EVERY || '5', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' } },
  { slug: 'dokumenty-seryjne', name: 'Dokumenty seryjne PDF', description: 'Tworzenie osobnego PDF-a dla kazdego adresu z korespondencji Word + Excel.', dir: path.join(ROOT, 'apps', 'dokumenty-seryjne'), port: Number(process.env.SERYJNE_PORT || 3004), healthPath: '/api/health' },
  { slug: 'wnioski-powykonawcze', name: 'Wnioski powykonawcze PDF', description: 'Zamiana wnioskow materialowych Word na dokumentacje powykonawcza PDF.', dir: path.join(ROOT, 'apps', 'wnioski-powykonawcze'), port: Number(process.env.WNIOSKI_PORT || 3005), healthPath: '/api/health' },
  { slug: 'karty-katalogowe', name: 'Karty katalogowe', description: 'Automatyczny dobor i kopiowanie kart katalogowych do folderow klientow na podstawie kolumny UID w Excelu.', dir: path.join(ROOT, 'apps', 'karty-katalogowe'), port: Number(process.env.KARTY_PORT || 3006), healthPath: '/api/health' },
  { slug: 'drukarka-projekty', name: 'Drukarka projekty', description: 'Automatyczne przygotowanie i druk dokumentacji projektowej na podstawie arkusza inwestycji.', dir: path.join(ROOT, 'apps', 'drukarka-projekty'), port: Number(process.env.DRUKARKA_PROJEKTY_PORT || 3010), healthPath: '/api/health' },
  { slug: 'ocr-audytow', name: 'OCR audytów', description: 'Rozpoznawanie tekstu (w tym pisma recznego) na zeskanowanych audytach, z podzialem zbundlowanych plikow na adresy.', dir: path.join(ROOT, 'apps', 'ocr-audytow'), port: Number(process.env.OCR_AUDYTOW_PORT || 3011), healthPath: '/api/health' },
  { slug: 'nazywarka-skanow', name: 'Nazywarka skanów', description: 'Zmiana nazw zeskanowanych PDF-ow w miejscu, na sieciowym udziale skanera.', dir: path.join(ROOT, 'apps', 'nazywarka-skanow'), port: Number(process.env.NAZYWARKA_SKANOW_PORT || 3007), healthPath: '/api/health' },
  { slug: 'formularze-varmero', name: 'Dobory Varmero', description: 'Automatyczne zgloszenia do kalkulatora doboru pompy ciepla Varmero na podstawie tabeli adresowej, z odbiorem kart wynikowych mailem.', dir: path.join(ROOT, 'apps', 'formularze-varmero'), port: Number(process.env.FORMULARZE_VARMERO_PORT || 3012), healthPath: '/api/health', extraEnv: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' } },
  { slug: 'tworzenie-folderow', name: 'Tworzenie folderów', description: 'Automatyczne tworzenie struktury podfolderow (WM/pompy/kolektory/kotly) w istniejacym folderze inwestycji, na podstawie tabeli adresowej.', dir: path.join(ROOT, 'apps', 'tworzenie-folderow'), port: Number(process.env.TWORZENIE_FOLDEROW_PORT || 3013), healthPath: '/api/health' },
  { slug: 'protokoly', name: 'Zdjęcia do PDF Protokołów', description: 'Sklada zdjecia protokolow (z folderow adresow, tak jak w drukarce projektow) w przyciete, czarno-biale PDF-y gotowe do druku.', dir: path.join(ROOT, 'apps', 'protokoly'), port: Number(process.env.PROTOKOLY_PORT || 3014), healthPath: '/api/health' }
];


const dependencyChecks = [
  { slug: 'drukarka', dir: path.join(ROOT, 'apps', 'drukarka'), deps: ['express', 'multer', 'express-rate-limit', 'pdf-lib'] },
  { slug: 'pieczatki-pdf', dir: path.join(ROOT, 'apps', 'pieczatki-pdf'), deps: ['express', 'multer', 'pdf-lib', 'archiver', '@pdf-lib/fontkit', 'pdfjs-dist', 'express-rate-limit'] },
  { slug: 'formularze-ecodan', dir: path.join(ROOT, 'apps', 'formularze-ecodan'), deps: ['express', 'playwright', 'read-excel-file', 'pdf-parse', 'pdf-lib', 'multer', 'sanitize-filename', 'archiver', 'express-rate-limit'], playwright: true },
  { slug: 'dokumenty-seryjne', dir: path.join(ROOT, 'apps', 'dokumenty-seryjne'), deps: ['express', 'multer', 'read-excel-file', 'sanitize-filename', 'archiver', 'express-rate-limit'] },
  { slug: 'wnioski-powykonawcze', dir: path.join(ROOT, 'apps', 'wnioski-powykonawcze'), deps: ['express', 'multer', 'sanitize-filename', 'archiver', 'express-rate-limit'] },
  { slug: 'karty-katalogowe', dir: path.join(ROOT, 'apps', 'karty-katalogowe'), deps: ['express', 'multer', 'read-excel-file', 'sanitize-filename', 'express-rate-limit'] },
  { slug: 'drukarka-projekty', dir: path.join(ROOT, 'apps', 'drukarka-projekty'), deps: ['express', 'multer', 'express-rate-limit', 'xlsx', 'mammoth', 'pdf-parse', 'pdf-lib', 'sanitize-filename'] },
  { slug: 'ocr-audytow', dir: path.join(ROOT, 'apps', 'ocr-audytow'), deps: ['express', 'multer', 'express-rate-limit', 'pdf-lib', 'pdf-parse', 'jimp', 'sanitize-filename', 'xlsx', 'exceljs'] },
  { slug: 'nazywarka-skanow', dir: path.join(ROOT, 'apps', 'nazywarka-skanow'), deps: ['express', 'express-rate-limit'] },
  { slug: 'formularze-varmero', dir: path.join(ROOT, 'apps', 'formularze-varmero'), deps: ['express', 'playwright', 'multer', 'sanitize-filename', 'express-rate-limit', 'xlsx', 'imapflow', 'mailparser'], playwright: true },
  { slug: 'tworzenie-folderow', dir: path.join(ROOT, 'apps', 'tworzenie-folderow'), deps: ['express', 'multer', 'sanitize-filename', 'express-rate-limit', 'xlsx'] },
  { slug: 'protokoly', dir: path.join(ROOT, 'apps', 'protokoly'), deps: ['express', 'express-rate-limit', 'jimp', 'pdf-lib'] }
];

function appHasDependencies(app) {
  // Sprawdzamy istnienie folderu pakietu w node_modules, NIE probujemy go
  // faktycznie zaimportowac (require.resolve). Rozne pakiety maja rozne,
  // czasem bardzo restrykcyjne pola "exports" w swoim package.json (np.
  // express-rate-limit nie eksportuje wlasnego package.json, read-excel-file
  // nie ma glownego eksportu dla zwyklego require) - to psulo probe
  // resolve() mimo ze pakiet byl poprawnie zainstalowany. Samo istnienie
  // folderu jest dużo prostszym i pewniejszym sygnalem "czy jest zainstalowany".
  if (!hasDependencies(app.dir, app.deps)) return false;
  // Realny problem zlapany 2026-07-24 (pytanie wlasciciela przy testowaniu autostartu):
  // folder node_modules/playwright moze istniec (npm install sie udal), a mimo to sam
  // BINARNY Chromium moze nie byc pobrany (osobny krok, `npm run install-browsers` w
  // scripts/install-all.js) - np. jesli ten krok kiedys zawiodl/zostal przerwany, albo
  // Chromium zostal recznie usuniety. Bez tego sprawdzenia formularze-ecodan wygladaloby
  // na "zainstalowane" i auto-instalacja NIGDY by go nie naprawila - krytyczne przy
  // cichym autostarcie (Scyzoryk.exe --autostart, patrz launcher/Scyzoryk.Launcher),
  // gdzie nikt nie zobaczy bledu na zywo, zeby recznie uruchomic NAPRAW-ZALEZNOSCI.cmd.
  if (app.playwright) {
    try {
      const requireFromApp = createRequire(path.join(app.dir, 'server.js'));
      const { chromium } = requireFromApp('playwright');
      if (!fs.existsSync(chromium.executablePath())) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

function ensureDependenciesBeforeStart() {
  if (process.env.SCYZORYK_SKIP_AUTO_INSTALL === '1') return;
  const missing = dependencyChecks.filter(app => fs.existsSync(path.join(app.dir, 'server.js')) && !appHasDependencies(app));
  if (missing.length === 0) return;

  console.log('');
  console.log('Wykryto brak paczek npm dla: ' + missing.map(app => app.slug).join(', '));
  console.log('Uruchamiam automatyczna instalacje zaleznosci. To moze potrwac kilka minut przy pierwszym starcie.');
  console.log('');

  const installer = path.join(ROOT, 'scripts', 'install-all.js');
  const result = spawnSync(process.execPath, [installer], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' },
    windowsHide: false
  });

  if (result.error || result.status !== 0) {
    console.error('');
    console.error('Nie udalo sie automatycznie zainstalowac paczek npm.');
    if (result.error) console.error(result.error.message || String(result.error));
    console.error('Uruchom STARTUJ-SCYZORYK.cmd albo NAPRAW-ZALEZNOSCI.cmd i wklej blad z instalacji, jesli dalej wystapi.');
    process.exit(result.status || 1);
  }

  const stillMissing = dependencyChecks.filter(app => fs.existsSync(path.join(app.dir, 'server.js')) && !appHasDependencies(app));
  if (stillMissing.length > 0) {
    console.error('');
    console.error('Instalacja zakonczona, ale nadal brakuje paczek dla: ' + stillMissing.map(app => app.slug).join(', '));
    console.error('Uruchom NAPRAW-ZALEZNOSCI.cmd i wklej pelny blad z instalacji.');
    process.exit(1);
  }

  console.log('Zaleznosci npm sa gotowe. Startuje aplikacje.');
  console.log('');
}

const children = new Map();
const childMeta = new Map();

function logLine(app, type, data) {
  const text = String(data || '').split(/\r?\n/).filter(Boolean);
  for (const line of text) console.log(`[${app.slug}:${type === 'err' ? 'ERR' : 'LOG'}] ${line}`);
}

function getChildMeta(slug) {
  if (!childMeta.has(slug)) {
    childMeta.set(slug, {
      restarts: 0,
      failures: 0,
      lastExit: null,
      lastError: null,
      startedAt: null,
      nextRestartAt: null,
      failureTimestamps: [],
      circuitOpen: false,
      circuitReason: null
    });
  }
  return childMeta.get(slug);
}

function startChild(app, attempt = 0) {
  if (!fs.existsSync(path.join(app.dir, 'server.js'))) return console.warn(`[${app.slug}] Brak server.js w: ${app.dir}`);
  const meta = getChildMeta(app.slug);
  meta.startedAt = Date.now();
  meta.nextRestartAt = null;
  const child = spawn(process.execPath, ['server.js'], { cwd: app.dir, env: { ...process.env, ...(app.extraEnv || {}), PORT: String(app.port), SCYZORYK_HOST: HOST }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', err => {
    meta.lastError = { at: Date.now(), message: err.message || String(err) };
    appendJsonLine(CHILDREN_LOG_FILE, { level: 'error', app: app.slug, event: 'child-error', message: err.message, stack: err.stack });
    console.error(`[${app.slug}] Nie udalo sie uruchomic procesu: ${err.message}`);
  });
  children.set(app.slug, child);
  child.stdout.on('data', data => logLine(app, 'out', data));
  child.stderr.on('data', data => logLine(app, 'err', data));
  child.on('exit', (code, signal) => {
    children.delete(app.slug);
    meta.failures += 1;
    meta.lastExit = { at: Date.now(), code: code ?? null, signal: signal ?? null };
    console.log(`[${app.slug}] Proces zakonczony. code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    if (code === 0 && signal === null) return;

    if (recordChildFailure(meta)) {
      appendJsonLine(CHILDREN_LOG_FILE, { level: 'error', app: app.slug, event: 'circuit-open', reason: meta.circuitReason });
      console.error(`[${app.slug}] Circuit breaker OTWARTY: ${meta.circuitReason}. Nie restartuje automatycznie.`);
      return;
    }

    const delay = Math.min(30000, 1000 * Math.max(1, attempt + 1));
    meta.restarts += 1;
    meta.nextRestartAt = Date.now() + delay;
    appendJsonLine(CHILDREN_LOG_FILE, { level: 'warn', app: app.slug, event: 'child-restart-scheduled', code, signal, delay });
    setTimeout(() => startChild(app, attempt + 1), delay).unref();
  });
}

function stopChildren() { for (const child of children.values()) { try { child.kill(); } catch (_) {} } }
process.on('SIGINT', () => { stopChildren(); process.exit(0); });
process.on('SIGTERM', () => { stopChildren(); process.exit(0); });
process.on('exit', stopChildren);

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), 'application/json; charset=utf-8');
}

// Panel (w odroznieniu od aplikacji-dzieci oparych o Express) nie mial do tej
// pory ZADNEGO endpointu POST, wiec brakuje mu odbioru body zadania. Trasy
// aktualizacji nie potrzebuja zadnych danych od klienta (patrz komentarz przy
// isTrustedMutation) - ta funkcja tylko bezpiecznie "wyciska" body z limitem
// rozmiaru, zeby nigdy nie zawiesic polaczenia i nie przyjac gigantycznego
// zadania, nawet jesli jego trec i tak jest ignorowana.
function drainRequestBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('Zadanie jest za duze.')); }
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
}

// Dozwolone originy dla mutujacych zadan panelu (aktualizacje) - lokalny
// adres IP/localhost oraz przyjazna nazwa hosta scyzoryk.localhost (domena
// .localhost, RFC 6761 - zawsze rozwiazuje sie do loopbacku, bez pliku hosts,
// patrz launcher\Scyzoryk.Launcher\InstallPaths.cs), zawsze na porcie tego
// panelu. Brak naglowka Origin jest dopuszczony: przegladarka wysylajaca POST
// z WLASNEJ strony panelu i tak nie moze dolozyc naglowka X-Scyzoryk-Request
// bez wywolania CORS preflightu, ktorego ten serwer nigdy nie potwierdza
// (brak Access-Control-Allow-*) - to jest glowna, samodzielnie wystarczajaca
// ochrona; sprawdzenie Origin to dodatkowa warstwa.
function isTrustedOrigin(origin) {
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch (_) { return false; }
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `scyzoryk.localhost:${PORT}`]);
  return allowed.has(host);
}

function requireTrustedMutation(req, res) {
  if (req.headers['x-scyzoryk-request'] !== '1') {
    sendJson(res, 403, { ok: false, message: 'Brak zabezpieczonego naglowka zadania. Odswiez strone i sprobuj ponownie.' });
    return false;
  }
  if (!isTrustedOrigin(req.headers.origin)) {
    sendJson(res, 403, { ok: false, message: 'Zadanie z niedozwolonego adresu.' });
    return false;
  }
  return true;
}

function readStaticFile(filePath, res, baseDir = PUBLIC_DIR, extraHeaders = {}) {
  const safePath = path.normalize(filePath);
  const relative = path.relative(baseDir, safePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return send(res, 403, 'Forbidden');
  fs.readFile(safePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(safePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png' };
    send(res, 200, data, types[ext] || 'application/octet-stream', extraHeaders);
  });
}

function checkHealth(app) {
  return new Promise(resolve => {
    const started = Date.now();
    const req = http.get({ hostname: HOST, port: app.port, path: app.healthPath || '/api/health', timeout: 1600 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
      res.on('end', () => {
        let payload = null;
        try { payload = body && body.trim().startsWith('{') ? JSON.parse(body) : null; } catch {}
        const expectedName = app.healthName || app.slug;
        const healthy = res.statusCode === 200 && payload?.ok === true && payload?.name === expectedName;
        resolve({ ok: healthy, statusCode: res.statusCode, ms: Date.now() - started, payload });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true, ms: Date.now() - started }); });
    req.on('error', err => resolve({ ok: false, error: err.message, ms: Date.now() - started }));
  });
}

function safePanelHostname(req) {
  const raw = String(req?.headers?.host || '').split(':')[0].toLowerCase();
  if (raw === 'localhost' || raw === '127.0.0.1' || raw === '[::1]' || raw === '::1') return raw.replace(/[\[\]]/g, '');
  return HOST;
}

function dirSizeSafe(dir, limitFiles = 2000) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < limitFiles) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(p);
        else if (entry.isFile()) { total += fs.statSync(p).size; files += 1; }
      } catch {}
      if (files >= limitFiles) break;
    }
  }
  return { bytes: total, files, truncated: files >= limitFiles };
}

async function getAppsStatus(req) {
  const hostname = safePanelHostname(req);
  const statuses = await Promise.all(apps.map(async app => {
    const health = await checkHealth(app);
    const meta = getChildMeta(app.slug);
    return {
      slug: app.slug,
      name: app.name,
      description: app.description,
      port: app.port,
      url: `http://${hostname}:${app.port}`,
      running: Boolean(health.ok),
      processAlive: children.has(app.slug),
      health,
      queue: health.payload?.queue || null,
      child: {
        restarts: meta.restarts,
        failures: meta.failures,
        lastExit: meta.lastExit,
        lastError: meta.lastError,
        startedAt: meta.startedAt,
        nextRestartAt: meta.nextRestartAt,
        circuitOpen: meta.circuitOpen,
        circuitReason: meta.circuitReason
      }
    };
  }));
  return { ok: true, mainPort: PORT, host: HOST, version: getInstalledVersion(ROOT).version, uptimeSec: Math.round(process.uptime()), memory: process.memoryUsage(), storage: dirSizeSafe(getDataRoot()), apps: statuses };
}





function safeDecodePathname(rawPathname) {
  try { return decodeURIComponent(rawPathname); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return send(res, 400, 'Bad Request'); }
  const decodedPath = safeDecodePathname(url.pathname);
  if (decodedPath === null) return send(res, 400, 'Bad Request');
  if (decodedPath === '/api/apps' || decodedPath === '/api/health') return send(res, 200, JSON.stringify(await getAppsStatus(req), null, 2), 'application/json; charset=utf-8');

  if (decodedPath === '/api/update/status') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, message: 'Metoda niedozwolona.' });
    // Nigdy nie odpytuje GitHuba - zwraca tylko ostatni znany, juz policzony
    // stan (patrz lib/updateService.js getStatusPayload).
    return sendJson(res, 200, updateService.getStatusPayload());
  }
  if (decodedPath === '/api/update/check') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metoda niedozwolona.' });
    try { await drainRequestBody(req); } catch (_) { return sendJson(res, 400, { ok: false, message: 'Nieprawidlowe zadanie.' }); }
    if (!requireTrustedMutation(req, res)) return;
    updateService.checkForUpdate({ manual: true }).catch(() => {});
    return sendJson(res, 202, { ok: true, message: 'Sprawdzanie aktualizacji rozpoczete.' });
  }
  if (decodedPath === '/api/update/install') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metoda niedozwolona.' });
    try { await drainRequestBody(req); } catch (_) { return sendJson(res, 400, { ok: false, message: 'Nieprawidlowe zadanie.' }); }
    if (!requireTrustedMutation(req, res)) return;
    // Wszystkie dane (ktora wersja, jaki URL) pochodza WYLACZNIE ze
    // zweryfikowanego stanu backendu (lib/updateService.js) - przegladarka
    // nie przekazuje tu ani wersji, ani adresu, ani sciezki.
    const result = updateService.startInstall();
    return sendJson(res, result.statusCode, { ok: result.started, message: result.message });
  }
  if (decodedPath === '/api/update/acknowledge-result') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metoda niedozwolona.' });
    try { await drainRequestBody(req); } catch (_) { return sendJson(res, 400, { ok: false, message: 'Nieprawidlowe zadanie.' }); }
    if (!requireTrustedMutation(req, res)) return;
    // Audyt rozdz. 4, P2: bez tego okno z wynikiem ostatniej proby
    // aktualizacji wyskakiwalo ponownie po kazdym powrocie do panelu, mimo
    // ze uzytkownik juz je zamknal - patrz lib/updateService.js.
    return sendJson(res, 200, updateService.acknowledgeLastResult());
  }

  if (decodedPath === '/' || decodedPath === '/index.html') return readStaticFile(path.join(PUBLIC_DIR, 'index.html'), res);
  if (decodedPath.startsWith('/shared/')) return readStaticFile(path.join(SHARED_DIR, decodedPath.slice('/shared/'.length)), res, SHARED_DIR);
  // Zrzuty ekranow narzedzi sa tez osadzane cross-origin we wlasnej stronie
  // pomoc.html kazdej apki (inny port) - domyslny Cross-Origin-Resource-Policy:
  // same-origin z SECURITY_HEADERS blokowalby to ladowanie w przegladarce.
  if (decodedPath.startsWith('/instrukcja-images/')) {
    return readStaticFile(path.join(PUBLIC_DIR, decodedPath.replace(/^\/+/, '')), res, PUBLIC_DIR, { 'Cross-Origin-Resource-Policy': 'cross-origin' });
  }
  readStaticFile(path.join(PUBLIC_DIR, decodedPath.replace(/^\/+/, '')), res);
});

const instanceLock = acquireSingleInstanceLock();
if (!instanceLock.acquired) {
  const reason = instanceLock.unreadable
    ? 'blokada instancji jest chwilowo nieczytelna (prawdopodobnie inny proces wlasnie startuje)'
    : `PID ${instanceLock.existingPid}`;
  console.error(`Scyzoryk juz dziala (${reason}). Otwieram przegladarke zamiast startowac druga instancje.`);
  process.exit(0);
}
process.on('exit', () => instanceLock.release());

applyHttpTimeouts(server, 'SCYZORYK');
ensureDependenciesBeforeStart();
if (process.env.SCYZORYK_SKIP_DATA_MIGRATION !== '1') {
  migrateLegacyDataIfNeeded(apps);
}
// Flaga sluzy testom prawdziwych tras panelu bez uruchamiania osmiu procesow potomnych.
if (process.env.SCYZORYK_SKIP_CHILD_START !== '1') {
  for (const app of apps) startChild(app);
}
// Pierwsze sprawdzenie aktualizacji leci asynchronicznie (3s po starcie, patrz
// scheduleAutoChecks) i NIE blokuje startu panelu - awaria GitHuba/brak
// internetu nie moze zatrzymac Scyzoryka.
updateService.scheduleAutoChecks(UPDATE_CHECK_INTERVAL_MS);

server.listen(PORT, HOST, () => { console.log('Scyzoryk Projektowy dziala tylko lokalnie:'); console.log(`http://${HOST}:${PORT}`); for (const app of apps) console.log(`- ${app.name}: http://${HOST}:${app.port}`); });
