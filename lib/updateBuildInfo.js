// Odczyt informacji o zainstalowanej wersji Scyzoryka.
//
// scripts/build-installer.ps1 generuje build-info.json w katalogu instalacji
// przy KAZDYM budowaniu instalatora (patrz ten skrypt) - to jest zrodlo
// prawdy dla wersji NA ZAINSTALOWANYM komputerze uzytkownika. W repo
// deweloperskim (node server.js z klonu/eksportu repo, bez przejscia przez
// instalator) tego pliku nie ma - fallback na wersje z package.json, zeby
// updater dzialal (i byl testowalny) rowniez lokalnie.
const fs = require('fs');
const path = require('path');
const { stripBom } = require('./hardening');

function readBuildInfo(rootDir) {
  const filePath = path.join(rootDir, 'build-info.json');
  try {
    const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
    const data = JSON.parse(raw);
    if (!data || typeof data.version !== 'string' || !data.version.trim()) return null;
    return {
      version: data.version.trim(),
      commit: typeof data.commit === 'string' ? data.commit : null,
      builtAt: typeof data.builtAt === 'string' ? data.builtAt : null,
      source: 'build-info.json'
    };
  } catch (_) {
    return null;
  }
}

function readPackageVersion(rootDir) {
  const filePath = path.join(rootDir, 'package.json');
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const data = JSON.parse(raw);
  if (!data || typeof data.version !== 'string' || !data.version.trim()) {
    throw new Error('package.json nie ma poprawnego pola "version".');
  }
  return { version: data.version.trim(), commit: null, builtAt: null, source: 'package.json' };
}

// Preferuje build-info.json (prawdziwa wersja zainstalowana), w wersji
// deweloperskiej wraca do package.json. Nigdy nie zwraca null - brak
// package.json w korzeniu repo jest bledem konfiguracji, nie stanem do
// tolerowania w cichym fallbacku.
function getInstalledVersion(rootDir) {
  return readBuildInfo(rootDir) || readPackageVersion(rootDir);
}

module.exports = { readBuildInfo, readPackageVersion, getInstalledVersion };
