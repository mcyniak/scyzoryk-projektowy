const cookies = require('./cookies');
const anon = require('./anonymousSession');

// Anonimowa sesja robocza: NIGDY nie blokuje. Kazda przegladarka, ktora
// trafi na dowolna wlaczona aplikacje, dostaje losowa sesje bez podawania
// jakichkolwiek danych - to tylko izolacja danych roboczych (uploady,
// zadania, kolejki), nie tozsamosc uzytkownika.

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

module.exports = {
  ensureAnonymousSessionExpress,
  ensureAnonymousSessionHttp,
};
