const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createRequire } = require('module');
const { setupProcessDiagnostics, applyHttpTimeouts, appendJsonLine, sanitizeForLog, readJsonFileNoBom } = require('./lib/hardening');
const authUsers = require('./lib/auth/users');
const authSessions = require('./lib/auth/sessionStore');
const authCookies = require('./lib/auth/cookies');
const authMiddleware = require('./lib/auth/middleware');
const authRateLimit = require('./lib/auth/rateLimiter');

const ROOT = __dirname;
const diagnostics = setupProcessDiagnostics('panel-glowny', ROOT);
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.SCYZORYK_HOST || '127.0.0.1';
// HOST ma dwie ROZNE role, ktore na pilotowej instalacji linuksowej sie
// rozjezdzaja: adres, na ktorym nasluchujemy (moze byc 0.0.0.0, zeby byc
// widocznym w calej sieci LAN) i adres, pod ktorym odpytujemy WLASNE dzieci
// (zawsze wystarczy loopback - proces-rodzic i tak zawsze gada sam ze soba
// na tej samej maszynie, nie potrzebuje wychodzic przez interfejs LAN).
const CHILD_HEALTHCHECK_HOST = '127.0.0.1';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};

const ALL_APPS = [
  { slug: 'drukarka', name: 'Drukarka', description: 'Kolejkowanie i drukowanie dokumentow z lokalnego panelu.', dir: path.join(ROOT, 'apps', 'drukarka'), port: Number(process.env.DRUKARKA_PORT || 3001), healthPath: '/api/status' },
  { slug: 'pieczatki', name: 'Pieczatki PDF', description: 'Dodawanie pieczatki do plikow PDF i pobieranie wynikow.', dir: path.join(ROOT, 'apps', 'pieczatki-pdf'), port: Number(process.env.PIECZATKI_PORT || 3002), healthPath: '/api/health' },
  { slug: 'formularze', name: 'Formularze Ecodan', description: 'Generator raportow/formularzy na podstawie danych z Excela.', dir: path.join(ROOT, 'apps', 'formularze-ecodan'), port: Number(process.env.FORMULARZE_PORT || 3003), healthPath: '/api/version', extraEnv: { HEADLESS: process.env.HEADLESS || 'true', BATCH_CONCURRENCY: process.env.BATCH_CONCURRENCY || '1', BATCH_RESTART_EVERY: process.env.BATCH_RESTART_EVERY || '5', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' } },
  { slug: 'dokumenty-seryjne', name: 'Dokumenty seryjne PDF', description: 'Tworzenie osobnego PDF-a dla kazdego adresu z korespondencji Word + Excel.', dir: path.join(ROOT, 'apps', 'dokumenty-seryjne'), port: Number(process.env.SERYJNE_PORT || 3004), healthPath: '/api/health' },
  { slug: 'wnioski-powykonawcze', name: 'Wnioski powykonawcze PDF', description: 'Zamiana wnioskow materialowych Word na dokumentacje powykonawcza PDF.', dir: path.join(ROOT, 'apps', 'wnioski-powykonawcze'), port: Number(process.env.WNIOSKI_PORT || 3005), healthPath: '/api/health' },
  { slug: 'karty-katalogowe', name: 'Karty katalogowe', description: 'Automatyczny dobor i kopiowanie kart katalogowych do folderow klientow na podstawie kolumny UID w Excelu.', dir: path.join(ROOT, 'apps', 'karty-katalogowe'), port: Number(process.env.KARTY_PORT || 3006), healthPath: '/api/health' },
  { slug: 'drukarka-projekty', name: 'Drukarka projekty', description: 'Automatyczne przygotowanie i druk dokumentacji projektowej na podstawie arkusza inwestycji.', dir: path.join(ROOT, 'apps', 'drukarka-projekty'), port: Number(process.env.DRUKARKA_PROJEKTY_PORT || 3010), healthPath: '/api/status' }
];

const ALL_DEPENDENCY_CHECKS = [
  { slug: 'drukarka', dir: path.join(ROOT, 'apps', 'drukarka'), deps: ['express', 'multer', 'express-rate-limit'] },
  { slug: 'pieczatki', dir: path.join(ROOT, 'apps', 'pieczatki-pdf'), deps: ['express', 'multer', 'pdf-lib', 'archiver', '@pdf-lib/fontkit', 'pdfjs-dist', 'express-rate-limit'] },
  { slug: 'formularze', dir: path.join(ROOT, 'apps', 'formularze-ecodan'), deps: ['express', 'playwright', 'read-excel-file', 'pdf-parse', 'pdf-lib', 'multer', 'sanitize-filename', 'archiver', 'express-rate-limit'] },
  { slug: 'dokumenty-seryjne', dir: path.join(ROOT, 'apps', 'dokumenty-seryjne'), deps: ['express', 'multer', 'read-excel-file', 'sanitize-filename', 'archiver', 'express-rate-limit'] },
  { slug: 'wnioski-powykonawcze', dir: path.join(ROOT, 'apps', 'wnioski-powykonawcze'), deps: ['express', 'multer', 'sanitize-filename', 'archiver', 'express-rate-limit'] },
  { slug: 'karty-katalogowe', dir: path.join(ROOT, 'apps', 'karty-katalogowe'), deps: ['express', 'multer', 'read-excel-file', 'sanitize-filename', 'express-rate-limit'] },
  { slug: 'drukarka-projekty', dir: path.join(ROOT, 'apps', 'drukarka-projekty'), deps: ['express', 'multer', 'express-rate-limit', 'xlsx', 'mammoth', 'pdf-parse', 'pdf-lib', 'sanitize-filename'] }
];

// SCYZORYK_PROFILE steruje tym, ktore aplikacje w ogole istnieja z punktu
// widzenia tego procesu - wylaczona aplikacja nie jest spawnowana, nie jest
// health-checkowana, nie pojawia sie w /api/apps ani nie jest restartowana.
// Brak zmiennej = profil "windows" = dokladnie dzisiejsze zachowanie (wszystkie
// 7 aplikacji), zeby instalacja Windows nigdy nie zmienila zachowania przez
// przypadek.
function loadActiveProfile() {
  const profileName = process.env.SCYZORYK_PROFILE || 'windows';
  let profiles = {};
  try {
    profiles = readJsonFileNoBom(path.join(ROOT, 'config', 'profiles.json'));
  } catch (err) {
    console.error(`Nie udalo sie wczytac config/profiles.json (${err.message}) - uzywam profilu "windows" ze wszystkimi aplikacjami.`);
    profiles = { windows: { enabledApps: ALL_APPS.map(a => a.slug) } };
  }
  const profile = profiles[profileName] || profiles.windows;
  if (!profile) throw new Error(`Nieznany profil "${profileName}" i brak profilu domyslnego "windows" w config/profiles.json.`);
  return { profileName, enabledSlugs: new Set(profile.enabledApps || []) };
}

const { profileName: ACTIVE_PROFILE, enabledSlugs: ENABLED_APP_SLUGS } = loadActiveProfile();
const apps = ALL_APPS.filter(a => ENABLED_APP_SLUGS.has(a.slug));
const dependencyChecks = ALL_DEPENDENCY_CHECKS.filter(a => ENABLED_APP_SLUGS.has(a.slug));

function appHasDependencies(app) {
  // Sprawdzamy istnienie folderu pakietu w node_modules, NIE probujemy go
  // faktycznie zaimportowac (require.resolve). Rozne pakiety maja rozne,
  // czasem bardzo restrykcyjne pola "exports" w swoim package.json (np.
  // express-rate-limit nie eksportuje wlasnego package.json, read-excel-file
  // nie ma glownego eksportu dla zwyklego require) - to psulo probe
  // resolve() mimo ze pakiet byl poprawnie zainstalowany. Samo istnienie
  // folderu jest dużo prostszym i pewniejszym sygnalem "czy jest zainstalowany".
  for (const dep of app.deps) {
    const depDir = path.join(app.dir, 'node_modules', ...dep.split('/'));
    if (!fs.existsSync(depDir)) return false;
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
    childMeta.set(slug, { restarts: 0, failures: 0, lastExit: null, lastError: null, startedAt: null, nextRestartAt: null });
  }
  return childMeta.get(slug);
}

function startChild(app, attempt = 0) {
  if (!fs.existsSync(path.join(app.dir, 'server.js'))) return console.warn(`[${app.slug}] Brak server.js w: ${app.dir}`);
  const meta = getChildMeta(app.slug);
  meta.startedAt = Date.now();
  meta.nextRestartAt = null;
  // AUTH_REQUIRED jest zdefiniowane nizej w pliku, ale ta funkcja jest
  // faktycznie wywolywana dopiero na samym koncu (po zaladowaniu profilu),
  // wiec w momencie wywolania zmienna jest juz zainicjowana.
  const child = spawn(process.execPath, ['server.js'], { cwd: app.dir, env: { ...process.env, ...(app.extraEnv || {}), PORT: String(app.port), SCYZORYK_HOST: HOST, SCYZORYK_AUTH_REQUIRED: AUTH_REQUIRED ? '1' : '0', SCYZORYK_PANEL_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', err => {
    meta.lastError = { at: Date.now(), message: err.message || String(err) };
    appendJsonLine(path.join(ROOT, 'logs', 'children.jsonl'), { level: 'error', app: app.slug, event: 'child-error', message: err.message, stack: err.stack });
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
    const delay = Math.min(30000, 1000 * Math.max(1, attempt + 1));
    meta.restarts += 1;
    meta.nextRestartAt = Date.now() + delay;
    appendJsonLine(path.join(ROOT, 'logs', 'children.jsonl'), { level: 'warn', app: app.slug, event: 'child-restart-scheduled', code, signal, delay });
    setTimeout(() => startChild(app, attempt + 1), delay).unref();
  });
}

function stopChildren() { for (const child of children.values()) { try { child.kill(); } catch (_) {} } }
process.on('SIGINT', () => { stopChildren(); process.exit(0); });
process.on('SIGTERM', () => { stopChildren(); process.exit(0); });
process.on('exit', stopChildren);

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readStaticFile(filePath, res) {
  const safePath = path.normalize(filePath);
  const relative = path.relative(PUBLIC_DIR, safePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return send(res, 403, 'Forbidden');
  fs.readFile(safePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(safePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png' };
    send(res, 200, data, types[ext] || 'application/octet-stream');
  });
}

function checkHealth(app) {
  return new Promise(resolve => {
    const started = Date.now();
    const req = http.get({ hostname: CHILD_HEALTHCHECK_HOST, port: app.port, path: app.healthPath || '/', timeout: 1600 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
      res.on('end', () => {
        let payload = null;
        try { payload = body && body.trim().startsWith('{') ? JSON.parse(body) : null; } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode, ms: Date.now() - started, payload });
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
      child: { restarts: meta.restarts, failures: meta.failures, lastExit: meta.lastExit, lastError: meta.lastError, startedAt: meta.startedAt, nextRestartAt: meta.nextRestartAt }
    };
  }));
  return { ok: true, mainPort: PORT, host: HOST, uptimeSec: Math.round(process.uptime()), memory: process.memoryUsage(), storage: dirSizeSafe(path.join(ROOT, 'apps')), apps: statuses };
}



function readLastLines(filePath, maxLines = 80, maxBytes = 250000) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch (err) {
    return [`Nie udalo sie odczytac logu: ${err.message || err}`];
  }
}

function safeDecodePathname(rawPathname) {
  try { return decodeURIComponent(rawPathname); } catch { return null; }
}

function readJsonBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Zadanie zbyt duze.')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Niepoprawny JSON.')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

// Logowanie ma sens tylko dla profili innych niz "windows" (pilot linuksowy
// i ewentualne przyszle profile) - profil "windows" ma pozostac dokladnie
// takim samym doswiadczeniem jak dzisiaj (bez ekranu logowania), zeby ta
// sama galaz kodu dala sie bezpiecznie uruchomic tez z profilem windows.
const AUTH_REQUIRED = ACTIVE_PROFILE !== 'windows';
const PUBLIC_PATHS = new Set(['/login', '/login.html']);
if (AUTH_REQUIRED) authSessions.startCleanupTimer();

// Ten sam wzorzec co w kazdej aplikacji-dziecku: zadania modyfikujace stan
// musza niesc naglowek X-Scyzoryk-Request, ktorego zwykly <form> (bez JS) nie
// potrafi ustawic, a przegladarka nie pozwoli ustawic go w zadaniu
// miedzydomenowym bez zgody CORS, ktorej ten serwer nigdy nie daje.
function isSameOriginRequest(req) {
  return req.headers['x-scyzoryk-request'] === '1';
}

async function handleAuthLogin(req, res) {
  if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }), 'application/json; charset=utf-8');
  if (!isSameOriginRequest(req)) return send(res, 403, JSON.stringify({ ok: false, error: 'Brak zabezpieczonego naglowka zadania. Odswiez strone i sprobuj ponownie.' }), 'application/json; charset=utf-8');
  const ip = clientIp(req);
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return send(res, 400, JSON.stringify({ ok: false, error: err.message }), 'application/json; charset=utf-8'); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (authRateLimit.isRateLimited(ip, username)) {
    appendJsonLine(path.join(ROOT, 'logs', 'auth.jsonl'), { level: 'warn', event: 'login-rate-limited', ip, username: sanitizeForLog(username, 60) });
    return send(res, 429, JSON.stringify({ ok: false, error: 'Za duzo nieudanych prob logowania. Sprobuj ponownie za kilkanascie minut.' }), 'application/json; charset=utf-8');
  }
  const user = await authUsers.verifyLogin(username, password);
  if (!user) {
    authRateLimit.recordFailedAttempt(ip, username);
    appendJsonLine(path.join(ROOT, 'logs', 'auth.jsonl'), { level: 'warn', event: 'login-failed', ip, username: sanitizeForLog(username, 60) });
    return send(res, 401, JSON.stringify({ ok: false, error: 'Nieprawidlowa nazwa uzytkownika lub haslo.' }), 'application/json; charset=utf-8');
  }
  authRateLimit.recordSuccess(ip, username);
  const sid = authSessions.createSession(user);
  appendJsonLine(path.join(ROOT, 'logs', 'auth.jsonl'), { level: 'info', event: 'login-success', ip, username: user.username });
  res.setHeader('Set-Cookie', authCookies.buildSessionCookieHeader(sid));
  send(res, 200, JSON.stringify({ ok: true, user: { username: user.username, role: user.role } }), 'application/json; charset=utf-8');
}

function handleAuthLogout(req, res) {
  if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }), 'application/json; charset=utf-8');
  if (!isSameOriginRequest(req)) return send(res, 403, JSON.stringify({ ok: false, error: 'Brak zabezpieczonego naglowka zadania. Odswiez strone i sprobuj ponownie.' }), 'application/json; charset=utf-8');
  const sid = authCookies.getSidFromRequest(req);
  if (sid) authSessions.destroySession(sid);
  res.setHeader('Set-Cookie', authCookies.buildClearCookieHeader());
  send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
}

function handleAuthWhoami(req, res) {
  const session = authMiddleware.getSessionFromRequest(req);
  if (!session) return send(res, 200, JSON.stringify({ ok: false }), 'application/json; charset=utf-8');
  send(res, 200, JSON.stringify({ ok: true, user: { username: session.username, role: session.role } }), 'application/json; charset=utf-8');
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return send(res, 400, 'Bad Request'); }
  const decodedPath = safeDecodePathname(url.pathname);
  if (decodedPath === null) return send(res, 400, 'Bad Request');

  if (decodedPath === '/auth/login') return handleAuthLogin(req, res);
  if (decodedPath === '/auth/logout') return handleAuthLogout(req, res);
  if (decodedPath === '/auth/whoami') return handleAuthWhoami(req, res);

  let session = null;
  if (AUTH_REQUIRED && !PUBLIC_PATHS.has(decodedPath)) {
    session = authMiddleware.requireAuthHttp(req, res, send);
    if (!session) return; // requireAuthHttp juz wyslal odpowiedz (redirect/401)
  }

  if (decodedPath === '/api/admin/logs') {
    if (AUTH_REQUIRED && session?.role !== 'admin') return send(res, 403, JSON.stringify({ ok: false, error: 'Wymagana rola administratora.' }), 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify({ ok: true, lines: readLastLines(path.join(ROOT, 'logs', 'children.jsonl'), 100) }, null, 2), 'application/json; charset=utf-8');
  }
  if (decodedPath === '/api/apps' || decodedPath === '/api/health') return send(res, 200, JSON.stringify(await getAppsStatus(req), null, 2), 'application/json; charset=utf-8');
  if (decodedPath === '/login' || decodedPath === '/login.html') return readStaticFile(path.join(PUBLIC_DIR, 'login.html'), res);
  if (decodedPath === '/' || decodedPath === '/index.html') return readStaticFile(path.join(PUBLIC_DIR, 'index.html'), res);
  if (decodedPath === '/admin' || decodedPath === '/admin.html') return readStaticFile(path.join(PUBLIC_DIR, 'admin.html'), res);
  readStaticFile(path.join(PUBLIC_DIR, decodedPath.replace(/^\/+/, '')), res);
});

applyHttpTimeouts(server, 'SCYZORYK');
ensureDependenciesBeforeStart();
for (const app of apps) startChild(app);
server.listen(PORT, HOST, () => {
  console.log(`Scyzoryk Projektowy - profil: ${ACTIVE_PROFILE}${AUTH_REQUIRED ? ' (wymaga logowania)' : ''}`);
  console.log(`http://${HOST}:${PORT}`);
  for (const app of apps) console.log(`- ${app.name}: http://${HOST}:${app.port}`);
  if (AUTH_REQUIRED && !authUsers.hasAnyUser()) {
    console.log('');
    console.log('UWAGA: nie ma jeszcze zadnego konta. Utworz pierwszego administratora:');
    console.log('  node scripts/create-admin.js --username=... --password=...');
  }
});
