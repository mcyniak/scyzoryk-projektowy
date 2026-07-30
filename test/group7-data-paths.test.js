const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { getDataRoot } = require('../lib/appPaths');
const { migrateLegacyDataIfNeeded } = require('../lib/appDataMigration');
const { hasDependencies } = require('../lib/dependencyCheck');

function withEnvironment(values, body) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('getDataRoot obsluguje override i domyslny LOCALAPPDATA', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-paths-'));
  try {
    const override = path.join(tempRoot, 'override');
    withEnvironment({ SCYZORYK_DATA_ROOT: override }, () => {
      assert.equal(getDataRoot(), path.resolve(override));
      assert.equal(fs.existsSync(override), true);
    });

    const localAppData = path.join(tempRoot, 'local');
    withEnvironment({ SCYZORYK_DATA_ROOT: undefined, LOCALAPPDATA: localAppData, APPDATA: undefined }, () => {
      const expected = path.join(localAppData, 'ScyzorykProjektowy', 'Data');
      assert.equal(getDataRoot(), path.resolve(expected));
      assert.equal(fs.existsSync(expected), true);
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('migracja kopiuje stare dane, zachowuje oryginal i jest idempotentna', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-migration-'));
  const legacyApp = path.join(tempRoot, 'program', 'apps', 'test-app');
  const legacyData = path.join(legacyApp, 'data');
  const newRoot = path.join(tempRoot, 'nowe-dane');
  fs.mkdirSync(legacyData, { recursive: true });
  fs.writeFileSync(path.join(legacyData, 'stan.json'), 'stary', 'utf8');

  try {
    withEnvironment({ SCYZORYK_DATA_ROOT: newRoot }, () => {
      migrateLegacyDataIfNeeded([{ slug: 'test-app', dir: legacyApp }]);
      const copied = path.join(newRoot, 'test-app', 'data', 'stan.json');
      assert.equal(fs.readFileSync(copied, 'utf8'), 'stary');
      assert.equal(fs.readFileSync(path.join(legacyData, 'stan.json'), 'utf8'), 'stary');

      fs.writeFileSync(copied, 'nowy', 'utf8');
      fs.writeFileSync(path.join(legacyData, 'stan.json'), 'zmieniony-stary', 'utf8');
      migrateLegacyDataIfNeeded([{ slug: 'test-app', dir: legacyApp }]);
      assert.equal(fs.readFileSync(copied, 'utf8'), 'nowy');
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('wspolny check zaleznosci nie odczytuje package.json przez exports', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-deps-'));
  try {
    const packageDir = path.join(tempRoot, 'node_modules', 'express-rate-limit');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'express-rate-limit',
      exports: { '.': './index.js' }
    }), 'utf8');
    assert.equal(hasDependencies(tempRoot, ['express-rate-limit']), true);
    assert.equal(hasDependencies(tempRoot, ['express-rate-limit', 'brak']), false);

    const root = path.resolve(__dirname, '..');
    const supervisor = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const installer = fs.readFileSync(path.join(root, 'scripts', 'install-all.js'), 'utf8');
    assert.match(supervisor, /require\('\.\/lib\/dependencyCheck'\)/);
    assert.match(installer, /require\('\.\.\/lib\/dependencyCheck'\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('wariant deweloperski nie zawiera OCR, a gotowy instalator pakuje go tylko z sekretu Actions', () => {
  const root = path.resolve(__dirname, '..');
  const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-installer.ps1'), 'utf8');
  const developerWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-internal-installer.yml'), 'utf8');
  const readyWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-ready-installer.yml'), 'utf8');
  const installedTest = fs.readFileSync(path.join(root, 'scripts', 'ci', 'test-installed-scyzoryk.ps1'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'apps', 'ocr-audytow', 'src', 'documentAiEngine.js'), 'utf8');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

  assert.match(buildScript, /function Add-OcrConfigurationToStaging/);
  assert.match(buildScript, /OCR_DOCAI_CREDENTIALS_B64/);
  assert.match(buildScript, /Get-ChildItem -Path \$stagingDir -Recurse -File -Filter 'service-account\.json'/);
  assert.match(buildScript, /Eksport repo zawiera zabroniony plik service-account\.json/);

  assert.match(developerWorkflow, /name: Zbuduj instalator deweloperski bez OCR/);
  assert.doesNotMatch(developerWorkflow, /secrets\.OCR_DOCAI_CREDENTIALS_B64/);

  assert.match(readyWorkflow, /name: Zbuduj gotowy instalator Windows z OCR/);
  assert.match(readyWorkflow, /OCR_DOCAI_CREDENTIALS_B64: \$\{\{ secrets\.OCR_DOCAI_CREDENTIALS_B64 \}\}/);
  assert.match(readyWorkflow, /-ExpectBundledOcr/);
  assert.match(readyWorkflow, /-TestLiveOcr/);

  assert.match(installedTest, /\[switch\]\$ExpectBundledOcr/);
  assert.match(installedTest, /Prawdziwe polaczenie z Google Document AI bez konfiguracji po instalacji/);
  assert.match(engine, /const BUNDLED_CONFIG_PATH/);
  assert.match(engine, /if \(isComplete\(bundledConfig\)\) return bundledConfig/);

  assert.match(gitignore, /apps\/ocr-audytow\/config\/service-account\.json/);
  assert.match(gitignore, /apps\/ocr-audytow\/config\/document-ai\.json/);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'ocr-document-ai.example.json')), true);
});
