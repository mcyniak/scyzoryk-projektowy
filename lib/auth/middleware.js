const cookies = require('./cookies');
const sessionStore = require('./sessionStore');

// UWAGA: NIE uzywac tu process.env.PORT jako fallbacku - wewnatrz procesu
// aplikacji-dziecka (np. pieczatki-pdf) PORT to WLASNY port tego dziecka,
// nie port panelu glownego. Korzenny server.js jawnie ustawia
// SCYZORYK_PANEL_PORT w srodowisku kazdego dziecka wlasnie po to, zeby to
// rozroznic.
const PANEL_PORT = Number(process.env.SCYZORYK_PANEL_PORT || 3000);

function getSessionFromRequest(req) {
  const sid = cookies.getSidFromRequest(req);
  if (!sid) return null;
  const session = sessionStore.getSession(sid);
  if (!session) return null;
  sessionStore.touchSession(sid);
  return { sid, username: session.username, role: session.role };
}

function panelHostname(req) {
  const rawHost = String((req.headers && req.headers.host) || req.hostname || 'localhost');
  return rawHost.split(':')[0];
}

function buildPanelLoginUrl(req, nextPath) {
  const host = panelHostname(req);
  const next = encodeURIComponent(nextPath || '/');
  return `http://${host}:${PANEL_PORT}/login?next=${next}`;
}

// Zadania z fetch()/XHR (JS frontendu) powinny dostac czysty JSON 401 zamiast
// przekierowania - inaczej fetch() dostalby tresc strony logowania jako
// "sukces" i uzytkownik zobaczylby myslacy komunikat zamiast "zaloguj sie
// ponownie".
function wantsJson(req) {
  const accept = String((req.headers && req.headers.accept) || req.get?.('accept') || '');
  const path = req.originalUrl || req.url || '';
  return accept.includes('application/json') || path.startsWith('/api/');
}

function requireAuthExpress(req, res, next) {
  const session = getSessionFromRequest(req);
  if (session) {
    req.user = { username: session.username, role: session.role };
    req.sid = session.sid;
    return next();
  }
  if (wantsJson(req)) {
    return res.status(401).json({ ok: false, error: 'Wymagane logowanie. Odśwież stronę i zaloguj się ponownie.' });
  }
  res.redirect(302, buildPanelLoginUrl(req, req.originalUrl));
}

// Wariant dla surowego http.Server (uzywany przez korzenny server.js, ktory
// celowo nie uzywa Express). Zwraca sesje jesli autoryzacja przeszla; w
// przeciwnym razie SAMA wysyla odpowiedz (redirect/401) i zwraca null - wolajacy
// ma wtedy po prostu przerwac dalsze przetwarzanie zadania.
function requireAuthHttp(req, res, sendFn) {
  const session = getSessionFromRequest(req);
  if (session) return session;
  if (wantsJson(req)) {
    sendFn(res, 401, JSON.stringify({ ok: false, error: 'Wymagane logowanie.' }), 'application/json; charset=utf-8');
    return null;
  }
  res.writeHead(302, { Location: buildPanelLoginUrl(req, req.url) });
  res.end();
  return null;
}

module.exports = {
  PANEL_PORT,
  getSessionFromRequest,
  buildPanelLoginUrl,
  requireAuthExpress,
  requireAuthHttp,
};
