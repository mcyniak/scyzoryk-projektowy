const crypto = require("crypto");

const SESSION_COOKIE = "scyzoryk_sid";
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

function sessionMiddleware(defaultDataFactory) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies[SESSION_COOKIE];
    if (!sid || !sessions.has(sid)) {
      sid = crypto.randomUUID();
      sessions.set(sid, { data: defaultDataFactory(), lastActivity: Date.now() });
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_IDLE_MS / 1000)}`);
    }
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
    if (entry.data && entry.data.printing) continue; // nigdy nie usuwaj aktywnie drukujacej sesji
    if (now - entry.lastActivity > SESSION_MAX_IDLE_MS) sessions.delete(sid);
  }
}
const cleanupTimer = setInterval(cleanupOldSessions, 30 * 60 * 1000);
cleanupTimer.unref?.();

module.exports = { sessionMiddleware, SESSION_COOKIE };
