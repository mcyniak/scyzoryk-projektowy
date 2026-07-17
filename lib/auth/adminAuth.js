// Ochrona panelu administratora - jedno wspolne haslo administratora,
// NIE pelny system kont pracownikow (ci nie loguja sie wcale, patrz
// anonymousSession.js). Haslo trzymane jako hash (scrypt, passwords.js),
// nigdy jawnie. Sesja admina to osobny magazyn/ciasteczko od anonimowej
// sesji roboczej - zeby jedno nigdy przypadkiem nie dawalo uprawnien
// drugiego.
const path = require('path');
const fs = require('fs');
const { readJsonFileNoBom, writeJsonFileNoBom, ensureDir } = require('../hardening');
const { hashPassword, verifyPassword } = require('./passwords');
const { createSessionStore } = require('./genericSessionStore');
const cookies = require('./cookies');

const AUTH_DATA_DIR = process.env.SCYZORYK_DATA_ROOT
  ? path.join(process.env.SCYZORYK_DATA_ROOT, 'auth')
  : path.join(__dirname, '..', '..', 'data', 'auth');
const ADMIN_FILE = path.join(AUTH_DATA_DIR, 'admin.json');

const adminSessions = createSessionStore('admin-sessions', cookies.SESSION_MAX_IDLE_MS);

function hasAdminPassword() {
  return fs.existsSync(ADMIN_FILE);
}

async function setAdminPassword(plainPassword) {
  if (!plainPassword || String(plainPassword).length < 8) {
    throw new Error('Haslo administratora musi miec co najmniej 8 znakow.');
  }
  ensureDir(AUTH_DATA_DIR);
  const passwordHash = await hashPassword(String(plainPassword));
  writeJsonFileNoBom(ADMIN_FILE, { passwordHash, updatedAt: new Date().toISOString() });
}

async function verifyAdminPassword(plainPassword) {
  if (!hasAdminPassword()) return false;
  let record;
  try {
    record = readJsonFileNoBom(ADMIN_FILE);
  } catch (_) {
    return false;
  }
  return verifyPassword(String(plainPassword || ''), record.passwordHash);
}

function createAdminSession() {
  return adminSessions.create();
}

function getAdminSession(sid) {
  return adminSessions.get(sid);
}

function touchAdminSession(sid) {
  adminSessions.touch(sid);
}

function destroyAdminSession(sid) {
  adminSessions.destroy(sid);
}

function startCleanupTimer() {
  return adminSessions.startCleanupTimer();
}

module.exports = {
  ADMIN_FILE,
  hasAdminPassword,
  setAdminPassword,
  verifyAdminPassword,
  createAdminSession,
  getAdminSession,
  touchAdminSession,
  destroyAdminSession,
  startCleanupTimer,
};
