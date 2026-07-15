const cookies = require('./cookies');
const anon = require('./anonymousSession');
const admin = require('./adminAuth');

function wantsJson(req) {
  const accept = String((req.headers && req.headers.accept) || req.get?.('accept') || '');
  const path = req.originalUrl || req.url || '';
  return accept.includes('application/json') || path.startsWith('/api/');
}

// --- Anonimowa sesja robocza: NIGDY nie blokuje. Kazda przegladarka, ktora
// trafi na dowolna wlaczona aplikacje, dostaje losowa sesje bez podawania
// jakichkolwiek danych - to tylko izolacja danych roboczych (uploady,
// zadania, kolejki), nie tozsamosc uzytkownika. ---

function resolveAnonymousSessionId(req, res, setCookieFn) {
  const existingSid = cookies.getCookieFromRequest(req, cookies.ANON_SESSION_COOKIE);
  if (existingSid && anon.getAnonymousSession(existingSid)) {
    anon.touchAnonymousSession(existingSid);
    return existingSid;
  }
  const newSid = anon.createAnonymousSession();
  setCookieFn(cookies.buildCookieHeader(cookies.ANON_SESSION_COOKIE, newSid));
  return newSid;
}

function ensureAnonymousSessionExpress(req, res, next) {
  req.sessionId = resolveAnonymousSessionId(req, res, header => res.setHeader('Set-Cookie', header));
  next();
}

function ensureAnonymousSessionHttp(req, res) {
  return resolveAnonymousSessionId(req, res, header => res.setHeader('Set-Cookie', header));
}

// --- Panel administratora: jedno wspolne haslo, osobna sesja/ciasteczko od
// powyzszej. Blokuje - to jedyne miejsce w calym pilocie, ktore faktycznie
// wymaga poswiadczenia. ---

function getAdminSessionFromRequest(req) {
  const sid = cookies.getCookieFromRequest(req, cookies.ADMIN_SESSION_COOKIE);
  if (!sid) return null;
  const session = admin.getAdminSession(sid);
  if (!session) return null;
  admin.touchAdminSession(sid);
  return { sid };
}

function requireAdminAuthHttp(req, res, sendFn) {
  const session = getAdminSessionFromRequest(req);
  if (session) return session;
  if (wantsJson(req)) {
    sendFn(res, 401, JSON.stringify({ ok: false, error: 'Wymagane logowanie administratora.' }), 'application/json; charset=utf-8');
    return null;
  }
  const next = encodeURIComponent(req.url || '/admin');
  res.writeHead(302, { Location: `/admin/login?next=${next}` });
  res.end();
  return null;
}

module.exports = {
  ensureAnonymousSessionExpress,
  ensureAnonymousSessionHttp,
  getAdminSessionFromRequest,
  requireAdminAuthHttp,
  wantsJson,
};
