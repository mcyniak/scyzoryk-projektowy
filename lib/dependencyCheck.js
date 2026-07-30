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
  }
  return true;
}

module.exports = { hasDependencies, readDeclaredDependencies };
