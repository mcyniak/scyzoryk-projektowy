const path = require('path');
const fs = require('fs');
const { readJsonFileNoBom, writeJsonFileNoBom, ensureDir } = require('../hardening');
const { hashPassword, verifyPassword } = require('./passwords');

// SCYZORYK_DATA_ROOT pozwala trzymac dane logowania poza katalogiem repo
// (np. /var/lib/scyzoryk na Raspberry Pi) - domyslnie ladujemy je we
// wlasnym drzewie repo (data/auth), tak jak reszta narzedzi w tym projekcie
// trzyma swoje dane robocze w apps/*/data.
const AUTH_DATA_DIR = process.env.SCYZORYK_DATA_ROOT
  ? path.join(process.env.SCYZORYK_DATA_ROOT, 'auth')
  : path.join(__dirname, '..', '..', 'data', 'auth');
const USERS_FILE = path.join(AUTH_DATA_DIR, 'users.json');

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{2,40}$/;
const VALID_ROLES = new Set(['admin', 'user']);

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function loadUsers() {
  ensureDir(AUTH_DATA_DIR);
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    const data = readJsonFileNoBom(USERS_FILE);
    return Array.isArray(data.users) ? data.users : [];
  } catch (_) {
    return [];
  }
}

function saveUsers(users) {
  ensureDir(AUTH_DATA_DIR);
  writeJsonFileNoBom(USERS_FILE, { users });
}

function findUser(username) {
  const norm = normalizeUsername(username);
  return loadUsers().find(u => normalizeUsername(u.username) === norm) || null;
}

async function createUser(username, plainPassword, role = 'user', options = {}) {
  const norm = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(norm)) {
    throw new Error('Nazwa uzytkownika moze zawierac tylko litery, cyfry, kropke, myslnik i podkreslenie (2-40 znakow).');
  }
  if (!VALID_ROLES.has(role)) throw new Error(`Nieprawidlowa rola: ${role}`);
  if (!plainPassword || String(plainPassword).length < 8) {
    throw new Error('Haslo musi miec co najmniej 8 znakow.');
  }

  const users = loadUsers();
  const existingIndex = users.findIndex(u => normalizeUsername(u.username) === norm);
  if (existingIndex >= 0 && !options.force) {
    throw new Error(`Uzytkownik "${norm}" juz istnieje. Uzyj --force, zeby nadpisac haslo/role.`);
  }

  const passwordHash = await hashPassword(String(plainPassword));
  const record = {
    username: norm,
    passwordHash,
    role,
    createdAt: existingIndex >= 0 ? users[existingIndex].createdAt : new Date().toISOString(),
    disabled: false,
  };

  if (existingIndex >= 0) users[existingIndex] = record;
  else users.push(record);
  saveUsers(users);
  return { username: record.username, role: record.role, createdAt: record.createdAt, disabled: record.disabled };
}

async function verifyLogin(username, plainPassword) {
  const user = findUser(username);
  if (!user || user.disabled) return null;
  const ok = await verifyPassword(String(plainPassword || ''), user.passwordHash);
  if (!ok) return null;
  return { username: user.username, role: user.role };
}

function setDisabled(username, disabled) {
  const users = loadUsers();
  const norm = normalizeUsername(username);
  const index = users.findIndex(u => normalizeUsername(u.username) === norm);
  if (index === -1) throw new Error(`Nie znaleziono uzytkownika "${norm}".`);
  users[index].disabled = Boolean(disabled);
  saveUsers(users);
}

function listUsersSafe() {
  return loadUsers().map(u => ({ username: u.username, role: u.role, createdAt: u.createdAt, disabled: u.disabled }));
}

function hasAnyUser() {
  return loadUsers().length > 0;
}

module.exports = {
  AUTH_DATA_DIR,
  USERS_FILE,
  createUser,
  verifyLogin,
  findUser,
  setDisabled,
  listUsersSafe,
  hasAnyUser,
};
