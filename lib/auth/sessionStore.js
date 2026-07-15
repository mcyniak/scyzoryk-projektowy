const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readJsonFileNoBom, writeJsonFileNoBom, ensureDir } = require('../hardening');
const { SESSION_MAX_IDLE_MS } = require('./cookies');

const AUTH_DATA_DIR = process.env.SCYZORYK_DATA_ROOT
  ? path.join(process.env.SCYZORYK_DATA_ROOT, 'auth')
  : path.join(__dirname, '..', '..', 'data', 'auth');
const SESSIONS_DIR = path.join(AUTH_DATA_DIR, 'sessions');

const SID_PATTERN = /^[0-9a-f-]{16,64}$/i;

function sessionFilePath(sid) {
  // sid pochodzi z ciasteczka klienta - musi przejsc scisla walidacje formatu
  // PRZED zbudowaniem sciezki pliku, inaczej sfabrykowany naglowek Cookie
  // (np. "../../../etc/passwd") pozwolilby czytac/pisac dowolny plik.
  if (!SID_PATTERN.test(String(sid || ''))) return null;
  return path.join(SESSIONS_DIR, `${sid}.json`);
}

function createSession(user) {
  ensureDir(SESSIONS_DIR);
  const sid = crypto.randomUUID();
  const now = Date.now();
  const record = { username: user.username, role: user.role, createdAt: now, lastActivity: now };
  writeJsonFileNoBom(sessionFilePath(sid), record);
  return sid;
}

function getSession(sid) {
  const filePath = sessionFilePath(sid);
  if (!filePath || !fs.existsSync(filePath)) return null;
  let record;
  try {
    record = readJsonFileNoBom(filePath);
  } catch (_) {
    return null;
  }
  if (!record || typeof record.lastActivity !== 'number') return null;
  if (Date.now() - record.lastActivity > SESSION_MAX_IDLE_MS) {
    destroySession(sid);
    return null;
  }
  return record;
}

function touchSession(sid) {
  const filePath = sessionFilePath(sid);
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const record = readJsonFileNoBom(filePath);
    record.lastActivity = Date.now();
    writeJsonFileNoBom(filePath, record);
  } catch (_) {
    // Sesja mogla zostac usunieta rownolegle (np. przez logout w innym
    // procesie-dziecku) - brak pliku do odswiezenia nie jest bledem.
  }
}

function destroySession(sid) {
  const filePath = sessionFilePath(sid);
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function cleanupExpiredSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const now = Date.now();
  for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(SESSIONS_DIR, entry.name);
    try {
      const record = readJsonFileNoBom(fullPath);
      if (!record || now - record.lastActivity > SESSION_MAX_IDLE_MS) fs.unlinkSync(fullPath);
    } catch (_) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
  }
}

let cleanupTimer = null;
function startCleanupTimer() {
  if (cleanupTimer) return cleanupTimer;
  cleanupTimer = setInterval(cleanupExpiredSessions, 30 * 60 * 1000);
  cleanupTimer.unref?.();
  setTimeout(cleanupExpiredSessions, 10000).unref?.();
  return cleanupTimer;
}

module.exports = {
  SESSIONS_DIR,
  createSession,
  getSession,
  touchSession,
  destroySession,
  cleanupExpiredSessions,
  startCleanupTimer,
};
