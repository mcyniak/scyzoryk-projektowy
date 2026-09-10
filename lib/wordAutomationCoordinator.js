// Cross-process koordynacja Worda (COM) miedzy child apps - wzorowane na
// lib/printCoordinator.js (ten sam wzorzec pliku-locka: atomowe 'wx',
// heartbeat, wykrywanie osierocenia po martwym PID/przestarzalym heartbeat)
// i lib/singleInstanceLock.js.
//
// Dlaczego to jest potrzebne: `wordQueue = createSerialQueue(...)` w
// dokumenty-seryjne/server.js serializuje uruchomienia Worda TYLKO w obrebie
// jednego procesu. Po dodaniu apps/kreator-wzorow (osobny proces Node, taki
// sam jak kazdy inny child app w tym repo) dwie NIEZALEZNE apki moga
// jednoczesnie uruchomic wlasna instancje Word.Application przez COM -
// Word potrafi to "obsluzyc" technicznie (dwa procesy WINWORD.EXE naraz), ale
// realnie prowadzi do konkurencji o CPU/RAM i mylacych bledow COM (RPC_E_*,
// patrz komentarze w mailmerge-to-pdf.ps1) przy dwoch rownoleglych,
// niepowiazanych automatyzacjach na tym samym komputerze.
//
// Roznica wobec printCoordinator.js: drukowanie odrzuca od razu
// (PrintLeaseBusyError), bo drukarka to zasob z natury krotkotrwaly. Word COM
// jest przeciwnie - pojedyncza paczka generowania potrafi trwac dlugo (wiele
// rekordow), wiec zamiast natychmiast odrzucac drugie zadanie, ono CZEKA na
// zwolnienie (z rozsadnym timeoutem), zgodnie ze specyfikacja Kreatora.
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { getDataRoot } = require('./appPaths');

const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 4;
const READ_RETRY_ATTEMPTS = 5;
const READ_RETRY_DELAY_MS = 40;
const DEFAULT_TIMEOUT_MS = Number(process.env.SCYZORYK_WORD_LOCK_TIMEOUT_MS || 60 * 60 * 1000);
const DEFAULT_POLL_INTERVAL_MS = 3000;

function lockDir() {
  const dir = path.join(getDataRoot(), 'runtime', 'word');
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath() {
  return path.join(lockDir(), 'active.lock');
}

class WordAutomationBusyError extends Error {
  constructor(ownerMeta) {
    super(`Word jest już używany przez inne narzędzie (${ownerMeta && ownerMeta.app || 'nieznane'}${ownerMeta && ownerMeta.operation ? ' - ' + ownerMeta.operation : ''}).`);
    this.code = 'WORD_LOCK_BUSY';
    this.ownerMeta = ownerMeta || null;
  }
}

// Rzucany wylacznie po wyczerpaniu timeoutu OCZEKIWANIA (nie od razu, w
// odroznieniu od PrintLeaseBusyError) - patrz withWordAutomationLease.
class WordAutomationTimeoutError extends Error {
  constructor(ownerMeta, timeoutMs) {
    super(`Word jest używany przez inne narzędzie (${ownerMeta && ownerMeta.app || 'nieznane'}${ownerMeta && ownerMeta.operation ? ' - ' + ownerMeta.operation : ''}) dłużej niż ${Math.round(timeoutMs / 60000)} min - zadanie przerwane. Spróbuj ponownie, gdy inne narzędzie skończy.`);
    this.code = 'WORD_LOCK_TIMEOUT';
    this.ownerMeta = ownerMeta || null;
    this.timeoutMs = timeoutMs;
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
// zamiana pliku tymczasowego) - ten sam wyscig i ta sama poprawka co w
// lib/singleInstanceLock.js/lib/printCoordinator.js.
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
  if (!existing) return true;
  // Zachowawczo: chwilowo nieczytelny (ale ISTNIEJACY) lock NIE jest
  // traktowany jako osierocony - moze byc w trakcie zapisu przez wlasciciela.
  if (existing.unreadable) return false;
  if (!existing.pid) return true;
  if (!isPidAlive(existing.pid)) return true;
  const ts = existing.heartbeatAt || existing.startedAt;
  const age = ts ? Date.now() - Date.parse(ts) : Infinity;
  return !Number.isFinite(age) || age > STALE_AFTER_MS;
}

// Jedna proba przejecia - rzuca WordAutomationBusyError natychmiast, gdy
// zajete przez zywego, nieosieroconego wlasciciela. Wywolujacy z zewnatrz to
// acquireWithWait ponizej (albo test, ktory chce sprawdzic samo "busy" bez
// czekania).
async function tryAcquireOnce(metadata) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = {
    pid: process.pid,
    token,
    app: metadata && metadata.app || 'nieznane',
    operation: metadata && metadata.operation || null,
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
    throw new WordAutomationBusyError({ app: 'nieznane (blokada chwilowo nieczytelna)' });
  }
  if (!isOrphaned(existing)) {
    throw new WordAutomationBusyError(existing);
  }

  // Osierocony lock (martwy PID/przestarzaly heartbeat) nie moze trwale
  // blokowac automatyzacji po awarii wlasciciela.
  await fs.unlink(lockPath()).catch(() => {});
  try {
    await claim(payload);
    return token;
  } catch (err) {
    if (err.code === 'EEXIST') throw new WordAutomationBusyError(await readLock());
    throw err;
  }
}

async function acquireWithWait(metadata, timeoutMs, pollIntervalMs, onWaiting) {
  const deadline = Date.now() + timeoutMs;
  let waitingAnnounced = false;
  for (;;) {
    try {
      return await tryAcquireOnce(metadata);
    } catch (err) {
      if (!(err instanceof WordAutomationBusyError)) throw err;
      if (Date.now() >= deadline) throw new WordAutomationTimeoutError(err.ownerMeta, timeoutMs);
      if (typeof onWaiting === 'function') {
        try { onWaiting(err.ownerMeta, waitingAnnounced); } catch {}
        waitingAnnounced = true;
      }
      await sleep(pollIntervalMs);
    }
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

// Glowne API. `metadata` = { app, operation } (np. { app: 'kreator-wzorow',
// operation: 'scan' }). Czeka na zwolnienie do `options.timeoutMs`
// (domyslnie SCYZORYK_WORD_LOCK_TIMEOUT_MS albo 60 min), zamiast odrzucac
// natychmiast - pojedyncza paczka generowania potrafi legalnie trwac dlugo.
// `options.onWaiting(ownerMeta, alreadyAnnounced)` jest wywolywane za kazdym
// razem, gdy trzeba czekac kolejna probe - wywolujacy moze tym zaktualizowac
// UI/log ("Word jest uzywany przez inne narzedzie - zadanie czeka").
async function withWordAutomationLease(metadata, fn, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  const token = await acquireWithWait(metadata, timeoutMs, pollIntervalMs, options.onWaiting);
  const heartbeatTimer = setInterval(() => { heartbeat(token).catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeatTimer);
    await release(token);
  }
}

// Do wyswietlenia w UI ("Word jest teraz uzywany przez: ..."), bez
// przejmowania locka. Zwraca null gdy nikt nie trzyma (albo lock jest
// osierocony - z punktu widzenia UI to tez "wolne").
async function readWordAutomationState() {
  const existing = await readLock();
  if (isOrphaned(existing)) return null;
  return existing;
}

module.exports = {
  WordAutomationBusyError,
  WordAutomationTimeoutError,
  withWordAutomationLease,
  readWordAutomationState,
  // Prymitywy nizszego poziomu WYLACZNIE do testow (patrz
  // test/group26-kreator-wzorow.test.js) - prawdziwi wywolujacy maja uzywac
  // wylacznie withWordAutomationLease/readWordAutomationState powyzej.
  _test: { tryAcquireOnce, release, readLock, lockPath }
};
