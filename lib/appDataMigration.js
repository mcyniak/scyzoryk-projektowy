const fs = require('fs');
const path = require('path');
const { getAppDataDir } = require('./appPaths');

const LEGACY_MAPPINGS = [
  ['data', 'data'],
  ['uploads', 'uploads'],
  ['output', 'output'],
  ['tmp', 'tmp'],
  ['logs', 'logs'],
  [path.join('data', 'uploads'), 'uploads'],
  [path.join('data', 'output'), 'output'],
  [path.join('data', 'analysis'), 'analysis']
];

function directoryIsEmpty(dir) {
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
}

function copyRecursiveIfDestEmpty(source, destination) {
  if (!fs.existsSync(source) || !directoryIsEmpty(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
  return true;
}

function migrateLegacyDataIfNeeded(apps) {
  for (const app of apps) {
    const destinationRoot = getAppDataDir(app.slug);
    const marker = path.join(destinationRoot, '.migrated');
    if (fs.existsSync(marker)) continue;

    let legacyFound = false;
    for (const [sourceRelative, destinationRelative] of LEGACY_MAPPINGS) {
      const source = path.join(app.dir, sourceRelative);
      if (!fs.existsSync(source)) continue;
      legacyFound = true;
      copyRecursiveIfDestEmpty(source, path.join(destinationRoot, destinationRelative));
    }

    if (legacyFound) fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  }
}

module.exports = {
  copyRecursiveIfDestEmpty,
  migrateLegacyDataIfNeeded
};
