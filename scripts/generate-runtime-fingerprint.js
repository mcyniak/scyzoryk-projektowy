// Liczy "fingerprint" runtime Scyzoryka (portable Node + node_modules
// wszystkich aplikacji) - kombinuje wersje Node z hashami wszystkich
// package-lock.json. Uzywany przez:
//   - scripts/build-installer.ps1: zapisuje runtime-fingerprint.txt do
//     stagingu KAZDEGO wariantu instalatora (pelny i aktualizacyjny), zeby
//     po zainstalowaniu na dysku uzytkownika bylo widac, jaki runtime
//     faktycznie tam jest;
//   - lib/updateService.js: porownuje fingerprint zainstalowany lokalnie z
//     tym opublikowanym w najnowszym wydaniu (przez manifest.json) - gdy sie
//     zgadzaja, aktualizacja pobiera maly instalator (bez node_modules), gdy
//     nie - pelny (bo wersja Node albo ktoras zaleznosc npm faktycznie sie
//     zmienila).
// Fingerprint NIE jest kryptograficznym dowodem integralnosci (do tego sluzy
// SHA-256 samego pobranego instalatora, patrz lib/updateDownload.js) -
// to tylko odcisk "czy runtime jest wciaz ten sam", zeby uniknac
// niepotrzebnego pobierania ~1,2 GB node_modules/Chromium przy kazdej
// drobnej aktualizacji kodu aplikacji.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function listAppDirs(root = ROOT) {
  const appsDir = path.join(root, 'apps');
  return fs.readdirSync(appsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Deterministyczny fingerprint: wersja Node + hash kazdego package-lock.json
// (posortowane po nazwie apki, zeby kolejnosc odczytu katalogu nigdy nie
// wplywala na wynik). Brak ktoregokolwiek package-lock.json jest bledem
// twardym - bez niego fingerprint bylby cichym klamstwem (wygladalby na
// "runtime bez zmian", mimo ze jedna z aplikacji nie ma znanej,
// zaklockowanej wersji zaleznosci).
function computeRuntimeFingerprint(nodeVersion, root = ROOT) {
  if (!nodeVersion || typeof nodeVersion !== 'string') {
    throw new Error('computeRuntimeFingerprint: brak wersji Node.');
  }
  const hash = crypto.createHash('sha256');
  hash.update(`node:${nodeVersion}\n`);
  for (const app of listAppDirs(root)) {
    const lockPath = path.join(root, 'apps', app, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
      throw new Error(`Brak apps/${app}/package-lock.json - fingerprint runtime nie moze byc policzony.`);
    }
    hash.update(`${app}:${hashFile(lockPath)}\n`);
  }
  return hash.digest('hex');
}

function main() {
  const nodeVersion = process.argv[2];
  const outputPath = process.argv[3];
  if (!nodeVersion) {
    console.error('Uzycie: node scripts/generate-runtime-fingerprint.js <wersja-node> [plik-wyjsciowy]');
    process.exit(1);
  }
  const fingerprint = computeRuntimeFingerprint(nodeVersion);
  if (outputPath) {
    fs.writeFileSync(outputPath, fingerprint + '\n', 'utf8');
  }
  console.log(fingerprint);
}

if (require.main === module) main();

module.exports = { computeRuntimeFingerprint, listAppDirs };
