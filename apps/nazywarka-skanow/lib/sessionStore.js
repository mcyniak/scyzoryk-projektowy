const crypto = require("crypto");

// Nazwa MUSI byc unikalna miedzy aplikacjami - ciasteczka na 127.0.0.1 NIE
// sa rozdzielane wedlug portu (tylko Domain+Path), wiec dwie apki na tym
// samym hoscie ale innym porcie dzielilyby jedna sesje (i nadpisywaly sobie
// nawzajem sid), gdyby uzywaly tej samej nazwy ciasteczka. Kazda apka z
// sesja ma wlasny, w pelni zdedykowany prefiks (patrz audyt v1.0.8, P3).
const SESSION_COOKIE = "scyzoryk_nazywarka_skanow_sid";
const SESSION_MAX_IDLE_MS = 12 * 60 * 60 * 1000;

const sessions = new Map();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

function issueSessionCookie(res, sid) {
  // Ustawiane PRZY KAZDYM zadaniu (nie tylko przy tworzeniu sesji) - inaczej
  // Max-Age liczy sie od pierwszego wydania ciasteczka, wiec ktos pracujacy
  // ciagle dluzej niz SESSION_MAX_IDLE_MS traci sesje w polowie pracy, mimo
  // ze serwerowe okno bezczynnosci (lastActivity) jest w rzeczywistosci
  // przesuwane przy kazdym zadaniu.
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_IDLE_MS / 1000)}`);
}

function sessionMiddleware(defaultDataFactory) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies[SESSION_COOKIE];
    if (!sid || !sessions.has(sid)) {
      sid = crypto.randomUUID();
      sessions.set(sid, { data: defaultDataFactory(), lastActivity: Date.now() });
    }
    issueSessionCookie(res, sid);
    const entry = sessions.get(sid);
    entry.lastActivity = Date.now();
    req.session = entry.data;
    req.sid = sid;
    next();
  };
}

function cleanupOldSessions() {
  const now = Date.now();
  for (const [sid, entry] of sessions.entries()) {
    if (now - entry.lastActivity > SESSION_MAX_IDLE_MS) sessions.delete(sid);
  }
}
const cleanupTimer = setInterval(cleanupOldSessions, 30 * 60 * 1000);
cleanupTimer.unref?.();

module.exports = { sessionMiddleware, SESSION_COOKIE };
