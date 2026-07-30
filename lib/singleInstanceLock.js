const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataRoot } = require('./appPaths');

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

function releaseIfOwner(file, token) {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.token === token) fs.unlinkSync(file);
  } catch {}
}

// Zwraca { acquired: true, release } albo { acquired: false, existingPid }.
function acquireSingleInstanceLock() {
  const file = lockPath();
  const token = crypto.randomUUID();
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    executablePath: process.execPath,
    startedAt: new Date().toISOString()
  });

  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return { acquired: true, release: () => releaseIfOwner(file, token) };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    existing = null;
  }

  if (existing && isPidAlive(existing.pid)) {
    return { acquired: false, existingPid: existing.pid };
  }

  // Osierocony lock usuwamy i probujemy przejac tylko raz, bez petli wyscigu.
  try { fs.unlinkSync(file); } catch {}
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return { acquired: true, release: () => releaseIfOwner(file, token) };
  } catch {
    return { acquired: false, existingPid: existing ? existing.pid : null };
  }
}

module.exports = { acquireSingleInstanceLock };
