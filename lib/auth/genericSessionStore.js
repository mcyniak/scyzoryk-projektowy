// Wspolny, plikowy magazyn efemerycznych sesji (jeden plik JSON na sesje).
// Uzywany przez anonimowe sesje robocze (anonymousSession.js) - utworz/
// odczytaj/odswiez/usun rekord z TTL bezczynnosci, widoczny z kazdego
// procesu-dziecka (nie tylko tego, ktory go utworzyl), stad zapis na dysk
// zamiast Map w pamieci.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readJsonFileNoBom, writeJsonFileNoBom, ensureDir } = require('../hardening');

const SID_PATTERN = /^[0-9a-f-]{16,64}$/i;

function createSessionStore(subdirName, defaultTtlMs) {
  const dataDir = process.env.SCYZORYK_DATA_ROOT
    ? path.join(process.env.SCYZORYK_DATA_ROOT, 'auth')
    : path.join(__dirname, '..', '..', 'data', 'auth');
  const sessionsDir = path.join(dataDir, subdirName);

  function sessionFilePath(sid) {
    // sid pochodzi z ciasteczka klienta - musi przejsc scisla walidacje
    // formatu PRZED zbudowaniem sciezki pliku, inaczej sfabrykowany naglowek
    // Cookie (np. "../../../etc/passwd") pozwolilby czytac/pisac dowolny plik.
    if (!SID_PATTERN.test(String(sid || ''))) return null;
    return path.join(sessionsDir, `${sid}.json`);
  }

  function create(extraFields = {}) {
    ensureDir(sessionsDir);
    const sid = crypto.randomUUID();
    const now = Date.now();
    writeJsonFileNoBom(sessionFilePath(sid), { ...extraFields, createdAt: now, lastActivity: now });
    return sid;
  }

  function get(sid, ttlMs = defaultTtlMs) {
    const filePath = sessionFilePath(sid);
    if (!filePath || !fs.existsSync(filePath)) return null;
    let record;
    try {
      record = readJsonFileNoBom(filePath);
    } catch (_) {
      return null;
    }
    if (!record || typeof record.lastActivity !== 'number') return null;
    if (Date.now() - record.lastActivity > ttlMs) {
      destroy(sid);
      return null;
    }
    return record;
  }

  // touch() jest wolany przy KAZDYM zadaniu z waznym ciasteczkiem sesji -
  // przy pollingu statusu co ~1s podczas dlugotrwalego zadania to setki
  // zapisow (read+write+rename) na karte microSD w ciagu jednej minuty, mimo
  // ze TTL sesji to 12h i kilka minut nieaktualnosci lastActivity nie ma
  // zadnego praktycznego znaczenia. throttleMs pomija sam ZAPIS (najbardziej
  // kosztowna dla flasha operacje), jesli poprzedni zapis byl niedawno.
  const TOUCH_WRITE_THROTTLE_MS = 5 * 60 * 1000;
  function touch(sid) {
    const filePath = sessionFilePath(sid);
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const record = readJsonFileNoBom(filePath);
      if (typeof record.lastActivity === 'number' && Date.now() - record.lastActivity < TOUCH_WRITE_THROTTLE_MS) return;
      record.lastActivity = Date.now();
      writeJsonFileNoBom(filePath, record);
    } catch (_) {
      // Sesja mogla zostac usunieta rownolegle w innym procesie - brak pliku
      // do odswiezenia nie jest bledem.
    }
  }

  function destroy(sid) {
    const filePath = sessionFilePath(sid);
    if (!filePath) return;
    try { fs.unlinkSync(filePath); } catch (_) {}
  }

  function cleanupExpired(ttlMs = defaultTtlMs) {
    if (!fs.existsSync(sessionsDir)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(sessionsDir, entry.name);
      try {
        const record = readJsonFileNoBom(fullPath);
        if (!record || now - record.lastActivity > ttlMs) fs.unlinkSync(fullPath);
      } catch (_) {
        try { fs.unlinkSync(fullPath); } catch (_) {}
      }
    }
  }

  let cleanupTimer = null;
  function startCleanupTimer(intervalMs = 30 * 60 * 1000) {
    if (cleanupTimer) return cleanupTimer;
    cleanupTimer = setInterval(() => cleanupExpired(), intervalMs);
    cleanupTimer.unref?.();
    setTimeout(() => cleanupExpired(), 10000).unref?.();
    return cleanupTimer;
  }

  return { sessionsDir, create, get, touch, destroy, cleanupExpired, startCleanupTimer };
}

module.exports = { createSessionStore };
