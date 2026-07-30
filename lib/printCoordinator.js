const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { getDataRoot } = require('./appPaths');

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

async function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock() {
  try {
    return JSON.parse(await fs.readFile(lockPath(), 'utf8'));
  } catch {
    return null;
  }
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
    const handle = await fs.open(lockPath(), 'wx');
    await handle.writeFile(JSON.stringify(payload));
    await handle.close();
    return token;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = await readLock();
  if (existing && await isPidAlive(existing.pid)) {
    throw new PrintLeaseBusyError(existing);
  }

  // Osierocony lock nie moze blokowac drukowania po awarii procesu.
  await fs.unlink(lockPath()).catch(() => {});
  try {
    const handle = await fs.open(lockPath(), 'wx');
    await handle.writeFile(JSON.stringify(payload));
    await handle.close();
    return token;
  } catch (err) {
    if (err.code === 'EEXIST') throw new PrintLeaseBusyError(await readLock());
    throw err;
  }
}

async function heartbeat(token, extra = {}) {
  const existing = await readLock();
  if (!existing || existing.token !== token) return;
  existing.heartbeatAt = new Date().toISOString();
  Object.assign(existing, extra);
  await fs.writeFile(lockPath(), JSON.stringify(existing));
}

async function release(token) {
  const existing = await readLock();
  if (existing && existing.token === token) {
    await fs.unlink(lockPath()).catch(() => {});
  }
}

async function withPrintLease(metadata, fn) {
  const token = await tryAcquire(metadata);
  const heartbeatTimer = setInterval(() => { heartbeat(token).catch(() => {}); }, 5000);
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
