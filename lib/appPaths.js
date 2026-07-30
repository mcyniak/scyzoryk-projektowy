const fs = require('fs');
const path = require('path');

function getDataRoot() {
  const override = process.env.SCYZORYK_DATA_ROOT;
  const localData = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!override && !localData) {
    throw new Error('Brak SCYZORYK_DATA_ROOT, LOCALAPPDATA i APPDATA - nie mozna wyznaczyc katalogu danych.');
  }

  const root = path.resolve(override || path.join(localData, 'ScyzorykProjektowy', 'Data'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function getAppDataDir(appSlug) {
  const safeSlug = String(appSlug || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(safeSlug)) {
    throw new Error(`Nieprawidlowy slug katalogu danych: ${safeSlug || '(pusty)'}`);
  }

  const dir = path.join(getDataRoot(), safeSlug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { getDataRoot, getAppDataDir };
