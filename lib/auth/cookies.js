const SESSION_COOKIE = 'scyzoryk_pilot_sid';
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

function getSidFromRequest(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return cookies[SESSION_COOKIE] || null;
}

// Celowo BEZ atrybutu Domain= - ciasteczko "host-only" jest wysylane do
// kazdego portu na tym samym hoscie (przegladarki scopuja ciasteczka wg
// hosta, nie portu), wiec jedno logowanie w panelu glownym wystarcza dla
// wszystkich dzieci-aplikacji na innych portach tego samego urzadzenia.
function buildSessionCookieHeader(sid, options = {}) {
  const maxAgeSec = Math.floor((options.maxAgeMs || SESSION_MAX_IDLE_MS) / 1000);
  const secureFlag = options.secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureFlag}`;
}

function buildClearCookieHeader(options = {}) {
  const secureFlag = options.secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`;
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_IDLE_MS,
  parseCookies,
  getSidFromRequest,
  buildSessionCookieHeader,
  buildClearCookieHeader,
};
