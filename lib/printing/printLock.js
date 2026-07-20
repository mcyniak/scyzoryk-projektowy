// Wiele osobnych procesow Node (drukarka, drukarka-projekty), kazdy z
// wlasnymi sesjami per przegladarka, moze rownolegle wyslac serie zadan do
// CUPS - bez koordynacji dokumenty dwoch uzytkownikow przeplataja sie w
// kolejce fizycznej drukarki (strona z serii A, potem strona z serii B,
// znowu A...). Procesy nie dzielą pamieci, wiec zwykly mutex w JS nie
// pomoze - potrzebna blokada widoczna dla wszystkich procesow na dysku.
// Katalogowa blokada (mkdir jest atomowe i na Linuksie, i na Windows)
// dziala miedzyprocesowo bez dodatkowego brokera/portu.
const fs = require('fs');
const path = require('path');

const LOCK_DIR = process.env.SCYZORYK_PRINT_LOCK_DIR
  || path.join(__dirname, '..', '..', 'data', 'print-queue.lock.d');
const META_FILE = 'owner.json';

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 700;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCK_DIR, META_FILE), 'utf8'));
  } catch (_) {
    return null;
  }
}

function tryAcquireOnce(owner) {
  try {
    fs.mkdirSync(LOCK_DIR);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(path.join(LOCK_DIR, META_FILE), JSON.stringify({ owner, pid: process.pid, acquiredAt: Date.now() }));
  } catch (_) {
    // Metadane sluza tylko do diagnostyki/wykrywania "zawieszonej" blokady -
    // brak mozliwosci zapisu nie powinien uniewazniac juz zdobytej blokady.
  }
  return true;
}

// Jesli proces, ktory trzymal blokade, padl (crash, kill -9, restart hosta),
// katalog blokady zostaje na dysku na zawsze - bez tego wszyscy uzytkownicy
// bylibys trwale zablokowani. Blokada starsza niz staleMs jest uznawana za
// osierocona i usuwana, zeby kolejka mogla ruszyc dalej.
function forceReleaseIfStale(staleMs) {
  const meta = readMeta();
  if (!meta || typeof meta.acquiredAt !== 'number') return;
  if (Date.now() - meta.acquiredAt < staleMs) return;
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
}

// Zwraca funkcje release() po zdobyciu blokady. `onWaiting(meta)` jest
// wywolywane przy kazdej nieudanej probie, zeby wolajacy mogl pokazac w UI
// "czeka na innego uzytkownika" zamiast ciszy przez kilka minut.
async function acquirePrintLock(owner, options = {}) {
  const staleMs = options.staleMs || DEFAULT_STALE_MS;
  const pollMs = options.pollMs || DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const onWaiting = typeof options.onWaiting === 'function' ? options.onWaiting : () => {};
  const startedAt = Date.now();

  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });

  for (;;) {
    if (tryAcquireOnce(owner)) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
      };
    }
    forceReleaseIfStale(staleMs);
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Kolejka drukowania jest zajeta przez innego uzytkownika zbyt dlugo - sprobuj ponownie za chwile.');
    }
    onWaiting(readMeta());
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

module.exports = { acquirePrintLock, LOCK_DIR };
