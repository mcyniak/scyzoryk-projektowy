const fs = require('fs');
const path = require('path');

function readDeclaredDependencies(appDir) {
  const packagePath = path.join(appDir, 'package.json');
  if (!fs.existsSync(packagePath)) return null;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const names = [
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.optionalDependencies || {})
    ];
    return [...new Set(names)];
  } catch (err) {
    // Brak pliku i USZKODZONY plik to dwie rozne sytuacje. Brak jest normalny
    // (obsluga jawnej listy z server.js), ale niepoprawny JSON oznacza cicha
    // degradacje do sztywnej listy - musi byc widoczny w logu.
    console.error(`Nie udalo sie odczytac ${packagePath}: ${err && err.message ? err.message : String(err)}`);
    return null;
  }
}

// Audyt v1.0.4, P1-8: sam odczyt "packages" z package-lock.json (lockfileVersion
// 2/3 - npm 7+) wystarcza do sprawdzenia PRZYPIETEJ wersji danej zaleznosci.
// Starszy format (lockfileVersion 1, "dependencies") nie jest tu obslugiwany -
// zwraca null, co powoduje pominiecie kontroli wersji (patrz komentarz w
// hasDependencies nizej) zamiast falszywego alarmu na nieznanym formacie.
function readLockedVersion(appDir, dependency) {
  try {
    const lockPath = path.join(appDir, 'package-lock.json');
    if (!fs.existsSync(lockPath)) return null;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const entry = lock.packages && lock.packages[`node_modules/${dependency}`];
    return (entry && typeof entry.version === 'string') ? entry.version : null;
  } catch (_) {
    return null;
  }
}

function readInstalledVersion(appDir, dependency) {
  try {
    const pkgPath = path.join(appDir, 'node_modules', ...dependency.split('/'), 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch (_) {
    return null;
  }
}

function hasDependencies(appDir, dependencies = []) {
  // Dla prawdziwej aplikacji package.json jest jedynym wiarygodnym źródłem listy
  // paczek. Ręczne listy w supervisorze mogą się zestarzeć po zmianie zależności
  // (np. OCR przeszedł z pdf-parse na pdfjs-dist), co wcześniej powodowało
  // nieskończoną reinstalację mimo poprawnego npm install i działającego health-checka.
  const declaredDependencies = readDeclaredDependencies(appDir);
  const dependenciesToCheck = declaredDependencies || dependencies;

  for (const dependency of dependenciesToCheck) {
    const dependencyDir = path.join(appDir, 'node_modules', ...dependency.split('/'));
    if (!fs.existsSync(dependencyDir)) return false;

    // Sam folder istniejacy na dysku nie znaczy "poprawnie zainstalowany" -
    // jesli nowe wydanie podbilo wersje tej zaleznosci w package-lock.json,
    // a stary folder node_modules przetrwal (np. po aktualizacji, ktora nie
    // dotyka node_modules), byl dotad cicho traktowany jako "OK". Jesli
    // lockfile ma jednoznaczna wersje dla tej zaleznosci i realnie
    // zainstalowana wersja sie z nia rozjezdza - to NIE jest zaleznosc
    // uznana za spelniona.
    const lockedVersion = readLockedVersion(appDir, dependency);
    if (lockedVersion) {
      const installedVersion = readInstalledVersion(appDir, dependency);
      // null = brak albo uszkodzony node_modules/<dep>/package.json. Skoro
      // lockfile podaje jednoznaczna wersje, nieczytelna instalacja NIE moze
      // uchodzic za spelniona zaleznosc.
      if (installedVersion !== lockedVersion) return false;
    }
  }
  return true;
}

module.exports = { hasDependencies, readDeclaredDependencies, readLockedVersion, readInstalledVersion };
