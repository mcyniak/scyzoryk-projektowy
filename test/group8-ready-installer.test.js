const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

test('OCR odczytuje konfigurację w kolejności env, użytkownik, instalator', async () => {
  const source = await read('apps/ocr-audytow/src/documentAiEngine.js');
  assert.match(source, /const BUNDLED_CONFIG_PATH = path\.join\(__dirname, '\.\.', 'config', 'document-ai\.json'\)/);

  const envIndex = source.indexOf('const envConfig = getEnvironmentConfig()');
  const userIndex = source.indexOf('const userConfig = normalizeFileConfig');
  const bundledIndex = source.indexOf('const bundledConfig = normalizeFileConfig');
  assert.ok(envIndex >= 0 && userIndex > envIndex && bundledIndex > userIndex, 'Nieprawidłowa kolejność źródeł konfiguracji OCR.');
  assert.match(source, /if \(isComplete\(bundledConfig\)\) return bundledConfig/);
  assert.match(source, /BUNDLED_CONFIG_PATH/);
});

test('build instalatora bierze sekret OCR tylko ze środowiska i dodaje go do stagingu', async () => {
  const source = await read('scripts/build-installer.ps1');
  assert.match(source, /OCR_DOCAI_CREDENTIALS_B64/);
  assert.match(source, /Add-OcrConfigurationToStaging/);
  assert.match(source, /FromBase64String/);
  assert.match(source, /service_account/);
  assert.match(source, /Get-ChildItem -Path \$stagingDir -Recurse -File -Filter 'service-account\.json'/);
  assert.match(source, /Eksport repo zawiera zabroniony plik service-account\.json/);
});

test('workflow gotowego instalatora wymaga sekretu i testuje prawdziwy OCR', async () => {
  const workflow = await read('.github/workflows/build-ready-installer.yml');
  assert.match(workflow, /name: Zbuduj gotowy instalator Windows z OCR/);
  assert.match(workflow, /name: Zbuduj instalator/);
  assert.match(workflow, /OCR_DOCAI_CREDENTIALS_B64: \$\{\{ secrets\.OCR_DOCAI_CREDENTIALS_B64 \}\}/);
  assert.match(workflow, /-ExpectBundledOcr/);
  assert.match(workflow, /-TestLiveOcr/);
  assert.match(workflow, /name: Scyzoryk-Projektowy-gotowy-Windows-z-OCR/);
});

test('Pomoc prowadzi do pełnej lokalnej instrukcji, bez starego modala', async () => {
  const panel = await read('public/index.html');
  const script = await read('public/inline-1.js');
  const instruction = await read('public/instrukcja.html');

  assert.match(panel, /id="helpTopLink" href="\/instrukcja\.html"/);
  assert.doesNotMatch(panel, /helpModalOverlay/);
  assert.doesNotMatch(script, /openModal|helpModalOverlay/);
  for (const title of [
    'Drukarka dokumentów',
    'Drukarka projektów',
    'Dokumenty seryjne PDF',
    'Wnioski powykonawcze PDF',
    'Formularze Ecodan',
    'Pieczątki PDF',
    'Karty katalogowe',
    'OCR audytów'
  ]) {
    assert.ok(instruction.includes(title), `Instrukcja nie zawiera sekcji: ${title}`);
  }
  assert.match(instruction, /pierwsze trzy strony/i);
  assert.match(instruction, /nie trzeba ustawiać klucza/i);
});

test('repozytorium nie zawiera śledzonego klucza konta serwisowego', async () => {
  const forbidden = path.join(root, 'apps', 'ocr-audytow', 'config', 'service-account.json');
  await assert.rejects(fs.access(forbidden), { code: 'ENOENT' });
});
