// Wiele osobnych procesow Node (drukarka, drukarka-projekty), kazdy z
// wlasnymi sesjami per przegladarka, moze rownolegle wyslac serie zadan do
// CUPS - bez koordynacji dokumenty dwoch uzytkownikow przeplataja sie w
// kolejce fizycznej drukarki (strona z serii A, potem strona z serii B,
// znowu A...). Procesy nie dzielą pamieci, wiec zwykly mutex w JS nie
// pomoze - potrzebna blokada widoczna dla wszystkich procesow na dysku.
// Katalogowa blokada (mkdir jest atomowe i na Linuksie, i na Windows)
// dziala miedzyprocesowo bez dodatkowego brokera/portu.
//
// Blokada jest per DRUKARKA (nie jedna globalna dla calego urzedu) - dwie
// osoby drukujace rownolegle na dwoch RÓZNYCH fizycznych drukarkach nie maja
// zadnego powodu czekac na siebie nawzajem, tylko dwie serie na TA SAMA
// drukarke moglyby sie przeplatac.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOCK_ROOT = process.env.SCYZORYK_PRINT_LOCK_DIR
  || path.join(__dirname, '..', '..', 'data', 'print-queue.lock.d');
const META_FILE = 'owner.json';

// Heartbeat co 15s - jesli nie zaktualizuje sie przez 90s (6 pominietych
// heartbeatow) I proces wlasciciela juz nie zyje, blokade uznajemy za
// osierocona. Zywy PID NIGDY nie jest force-release'owany, niezaleznie jak
// dlugo trwa druk - dlugosc serii nie ma znaczenia, liczy sie tylko czy
// proces faktycznie jeszcze dziala.
const DEFAULT_HEARTBEAT_MS = 15 * 1000;
const DEFAULT_STALE_HEARTBEAT_MS = 90 * 1000;
// Fallback wylacznie na wypadek, gdy proces padnie w wąskim oknie miedzy
// mkdir a zapisem owner.json (wiec nie ma PID-u do sprawdzenia) - wtedy
// jedynym sygnalem jest wiek samego katalogu blokady.
const DEFAULT_ORPHAN_DIR_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 700;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function sanitizeKey(name) {
  const cleaned = String(name || 'default').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}

function lockDirFor(printerName) {
  return path.join(LOCK_ROOT, sanitizeKey(printerName));
}

function metaPath(lockDir) {
  return path.join(lockDir, META_FILE);
}

function readMeta(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(lockDir), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeMeta(lockDir, meta) {
  try { fs.writeFileSync(metaPath(lockDir), JSON.stringify(meta)); return true; } catch (_) { return false; }
}

// Ten proces i wlasciciel blokady zawsze dzialaja na TEJ SAMEJ maszynie
// (drukarka/drukarka-projekty sa dziecmi spawnowanymi lokalnie przez
// korzenny server.js) - sprawdzenie PID-u jest wiec wiarygodnym sygnalem
// "czy wlasciciel na pewno juz nie zyje", nie tylko domyslem z timeoutu.
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // istnieje, ale inny uzytkownik - i tak zywy
  }
}

function dirAgeMs(lockDir) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch (_) {
    return Infinity;
  }
}

// Osobny sygnal od samego PID-u: jesli PID zostal odzyskany przez system i
// przypadkiem przypisany INNEMU, niezwiazanemu procesowi, heartbeat i tak
// nigdy by sie nie odnowil (bo ten nowy proces nic nie wie o naszym pliku
// metadanych) - staly wiek heartbeat wylapuje ten rzadki przypadek nawet
// gdy sam PID "zyje".
function isStale(lockDir, orphanDirMs, staleHeartbeatMs) {
  const meta = readMeta(lockDir);
  if (!meta) return dirAgeMs(lockDir) > orphanDirMs;
  const lastBeat = typeof meta.heartbeatAt === 'number' ? meta.heartbeatAt : meta.acquiredAt;
  const heartbeatFresh = typeof lastBeat === 'number' && (Date.now() - lastBeat) < staleHeartbeatMs;
  if (heartbeatFresh) return false;
  if (meta.host === os.hostname() && isPidAlive(meta.pid)) return false;
  return true;
}

function tryAcquireOnce(lockDir, owner, token) {
  try {
    fs.mkdirSync(lockDir, { recursive: false });
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  const now = Date.now();
  writeMeta(lockDir, { owner, token, pid: process.pid, host: os.hostname(), acquiredAt: now, heartbeatAt: now });
  return true;
}

function forceReclaimIfStale(lockDir, orphanDirMs, staleHeartbeatMs) {
  if (!isStale(lockDir, orphanDirMs, staleHeartbeatMs)) return;
  // Nie sprawdzamy tu tokenu - to jest jedyne miejsce, gdzie WOLNO usunac
  // cudza blokade, i robimy to tylko gdy staleness juz to uzasadnia. Sam
  // mkdirSync w tryAcquireOnce zaraz potem jest atomowy, wiec nawet gdyby
  // dwa oczekujace procesy jednoczesnie doszly tutaj, tylko jeden z nich
  // faktycznie zdobedzie blokade - to naturalnie arbitrazuje wyscig.
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) {}
}

// Zwraca funkcje release() po zdobyciu blokady na konkretna drukarke
// (printerName - pusty/system-default trafia do wspolnego kubelka
// "default"). `onWaiting(meta)` jest wywolywane przy kazdej nieudanej
// probie, zeby wolajacy mogl pokazac w UI "czeka na innego uzytkownika".
async function acquirePrintLock(owner, options = {}) {
  const printerName = options.printerName || '';
  const lockDir = lockDirFor(printerName);
  const heartbeatMs = options.heartbeatMs || DEFAULT_HEARTBEAT_MS;
  const staleHeartbeatMs = options.staleHeartbeatMs || DEFAULT_STALE_HEARTBEAT_MS;
  const orphanDirMs = options.orphanDirMs || DEFAULT_ORPHAN_DIR_MS;
  const pollMs = options.pollMs || DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const onWaiting = typeof options.onWaiting === 'function' ? options.onWaiting : () => {};
  const startedAt = Date.now();

  fs.mkdirSync(LOCK_ROOT, { recursive: true });

  for (;;) {
    const token = crypto.randomUUID();
    if (tryAcquireOnce(lockDir, owner, token)) {
      const heartbeatTimer = setInterval(() => {
        const current = readMeta(lockDir);
        // Jesli miedzy heartbeatami ktos inny przejal blokade (uznal ja za
        // osierocona), NIE nadpisujemy jego metadanych naszymi - to by
        // ukrywalo fakt, ze juz nie jestesmy wlascicielem.
        if (!current || current.token !== token) return;
        writeMeta(lockDir, { ...current, heartbeatAt: Date.now() });
      }, heartbeatMs);
      heartbeatTimer.unref?.();

      let released = false;
      return function release() {
        if (released) return;
        released = true;
        clearInterval(heartbeatTimer);
        const current = readMeta(lockDir);
        // Krytyczne: usuwamy katalog TYLKO jesli metadane nadal nosza NASZ
        // token. Jesli ktos inny w miedzyczasie uznal nasza blokade za
        // osierocona i przejal ja (np. po dlugiej przerwie w event loopie),
        // to jest juz JEGO blokada - nasz release() nie ma prawa jej ruszyc.
        if (current && current.token === token) {
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) {}
        }
      };
    }
    forceReclaimIfStale(lockDir, orphanDirMs, staleHeartbeatMs);
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Kolejka drukowania jest zajeta przez innego uzytkownika zbyt dlugo - sprobuj ponownie za chwile.');
    }
    onWaiting(readMeta(lockDir));
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

module.exports = { acquirePrintLock, LOCK_ROOT };
