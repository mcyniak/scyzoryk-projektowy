const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { getDataRoot } = require('./appPaths');

// Audyt 2026-08-06 (rozdz. 21) + realny incydent u wlasciciela z panel.lock
// (patrz singleInstanceLock.js): PID sam w sobie nie dowodzi, ze wlasciciel
// locka wciaz dziala - Windows moze go ponownie przydzielic zupelnie innemu
// procesowi po tym, jak prawdziwy wlasciciel padnie. Dlatego osierocenie
// locka rozstrzyga swiezosc heartbeatu, nie tylko "PID zyje".
const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 4;
const READ_RETRY_ATTEMPTS = 5;
const READ_RETRY_DELAY_MS = 40;

function lockDir() {
  const dir = path.join(getDataRoot(), 'runtime', 'printing');
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath() {
  return path.join(lockDir(), 'active.lock');
}

class PrintLeaseBusyError extends Error {
  constructor(ownerMeta) {
    super(`Drukowanie jest juz w toku (${ownerMeta?.app || 'inny modul'}).`);
    this.code = 'PRINT_LOCK_BUSY';
    this.ownerMeta = ownerMeta;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ponawia odczyt kilka razy zanim odda "nieczytelny" - lock moze byc chwilowo
// w trakcie zapisu (miedzy utworzeniem pustego pliku przez 'wx' a atomowa
// zamiana pliku tymczasowego). Zwrocenie null w takiej chwili wygladaloby
// jak "brak locka" i pozwolilo innemu procesowi ukrasc go w trakcie druku -
// dokladnie wyscig opisany w audycie.
async function readLock() {
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt++) {
    try {
      const raw = await fs.readFile(lockPath(), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (attempt === READ_RETRY_ATTEMPTS - 1) return { unreadable: true };
      await sleep(READ_RETRY_DELAY_MS);
    }
  }
  return { unreadable: true };
}

async function writeLockAtomic(payload) {
  const target = lockPath();
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload));
  await fs.rename(tmp, target);
}

async function claim(payload) {
  const handle = await fs.open(lockPath(), 'wx');
  await handle.close();
  await writeLockAtomic(payload);
}

function isOrphaned(existing) {
  if (!existing || existing.unreadable || !existing.pid) return false;
  if (!isPidAlive(existing.pid)) return true;
  const ts = existing.heartbeatAt || existing.startedAt;
  const age = ts ? Date.now() - Date.parse(ts) : Infinity;
  return !Number.isFinite(age) || age > STALE_AFTER_MS;
}

async function tryAcquire(meta) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = {
    pid: process.pid,
    token,
    ...meta,
    startedAt: now,
    heartbeatAt: now
  };

  try {
    await claim(payload);
    return token;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = await readLock();
  if (existing && existing.unreadable) {
    // Chwilowo nieczytelny, ale ISTNIEJACY lock - zachowawczo traktujemy to
    // jak trwajacy druk zamiast go kasowac (audyt: "nieczytelna blokada nie
    // moze byc usunieta natychmiast").
    throw new PrintLeaseBusyError({ app: 'nieznany (blokada chwilowo nieczytelna)' });
  }
  if (!isOrphaned(existing)) {
    throw new PrintLeaseBusyError(existing);
  }

  // Osierocony lock nie moze blokowac drukowania po awarii/martwym PID-zie
  // wlasciciela.
  await fs.unlink(lockPath()).catch(() => {});
  try {
    await claim(payload);
    return token;
  } catch (err) {
    if (err.code === 'EEXIST') throw new PrintLeaseBusyError(await readLock());
    throw err;
  }
}

async function heartbeat(token, extra = {}) {
  const existing = await readLock();
  if (!existing || existing.unreadable || existing.token !== token) return;
  await writeLockAtomic({ ...existing, ...extra, heartbeatAt: new Date().toISOString() });
}

async function release(token) {
  const existing = await readLock();
  if (existing && !existing.unreadable && existing.token === token) {
    await fs.unlink(lockPath()).catch(() => {});
  }
}

async function withPrintLease(metadata, fn) {
  const token = await tryAcquire(metadata);
  const heartbeatTimer = setInterval(() => { heartbeat(token).catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeatTimer);
    await release(token);
  }
}

module.exports = {
  PrintLeaseBusyError,
  readLock,
  withPrintLease
};
