// Anonimowa sesja robocza - wystawiana automatycznie kazdej przegladarce,
// bez podawania jakichkolwiek danych logowania (pracownicy nie maja kont).
const ANON_SESSION_COOKIE = 'scyzoryk_pilot_sid';
const SESSION_MAX_IDLE_MS = 12 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

function getCookieFromRequest(req, cookieName) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return cookies[cookieName] || null;
}

// Celowo BEZ atrybutu Domain= - ciasteczko "host-only" jest wysylane do
// kazdego portu na tym samym hoscie (przegladarki scopuja ciasteczka wg
// hosta, nie portu), wiec jeden wspolny, plikowy magazyn sesji (patrz
// genericSessionStore.js) wystarcza, zeby ta sama anonimowa sesja robocza
// byla rozpoznawana na porcie kazdej wlaczonej aplikacji.
function buildCookieHeader(cookieName, sid, options = {}) {
  const maxAgeSec = Math.floor((options.maxAgeMs || SESSION_MAX_IDLE_MS) / 1000);
  const secureFlag = options.secure ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureFlag}`;
}

module.exports = {
  ANON_SESSION_COOKIE,
  SESSION_MAX_IDLE_MS,
  parseCookies,
  getCookieFromRequest,
  buildCookieHeader,
};
