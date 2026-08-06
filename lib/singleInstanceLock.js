const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataRoot } = require('./appPaths');

// Audyt 2026-08-06 (rozdz. 28) + realny incydent u wlasciciela: po restarcie
// komputera Windows moze przydzielic PID starego, juz martwego wlasciciela
// locka zupelnie innemu, niepowiazanemu procesowi (np. msedgewebview2.exe).
// Samo "PID zyje" wtedy klamie i lock nigdy nie zostanie uznany za
// osierocony - launcher w kolko odmawia startu, choc nic nie dziala. Dlatego
// oprocz PID-u sprawdzamy swiezosc heartbeatu wlasciciela.
const HEARTBEAT_INTERVAL_MS = 15000;
const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 4;

function lockPath() {
  const dir = path.join(getDataRoot(), 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'panel.lock');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isOrphaned(existing) {
  if (!existing || !existing.pid) return true;
  if (!isPidAlive(existing.pid)) return true;
  const ts = existing.heartbeatAt || existing.startedAt;
  const age = ts ? Date.now() - Date.parse(ts) : Infinity;
  return !Number.isFinite(age) || age > STALE_AFTER_MS;
}

// Zapis do pliku tymczasowego + atomowa zamiana, zeby drugi proces nigdy nie
// zobaczyl pustej/czesciowo zapisanej tresci locka (audyt rozdz. 21/28).
function writeLockSync(file, payload) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

function releaseIfOwner(file, token) {
  const current = readLockSync(file);
  if (current && current.token === token) {
    try { fs.unlinkSync(file); } catch {}
  }
}

// 'wx' gwarantuje, ze tylko jeden proces wygra tworzenie pliku - to jest
// atomowe przejecie. Rzeczywista tresc jest dopisywana zaraz potem przez
// writeLockSync (tmp+rename), wiec plik nigdy nie jest widoczny "pusty".
function claim(file, payload) {
  fs.closeSync(fs.openSync(file, 'wx'));
  writeLockSync(file, payload);
}

function startOwned(file, token) {
  const timer = setInterval(() => {
    try {
      const current = readLockSync(file);
      if (!current || current.token !== token) return;
      writeLockSync(file, { ...current, heartbeatAt: new Date().toISOString() });
    } catch {}
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    acquired: true,
    release: () => { clearInterval(timer); releaseIfOwner(file, token); }
  };
}

// Zwraca { acquired: true, release } albo { acquired: false, existingPid }.
function acquireSingleInstanceLock() {
  const file = lockPath();
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = {
    pid: process.pid,
    token,
    executablePath: process.execPath,
    startedAt: now,
    heartbeatAt: now
  };

  try {
    claim(file, payload);
    return startOwned(file, token);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = readLockSync(file);
  if (!isOrphaned(existing)) {
    return { acquired: false, existingPid: existing.pid };
  }

  // Osierocony lock usuwamy i probujemy przejac tylko raz, bez petli wyscigu.
  try { fs.unlinkSync(file); } catch {}
  try {
    claim(file, payload);
    return startOwned(file, token);
  } catch {
    const stillThere = readLockSync(file);
    return { acquired: false, existingPid: stillThere ? stillThere.pid : null };
  }
}

module.exports = { acquireSingleInstanceLock };
