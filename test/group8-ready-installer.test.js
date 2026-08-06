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

test('odinstalowanie usuwa klucz OCR z osobnego katalogu %LOCALAPPDATA%\\Scyzoryk (audyt rozdz. 22/23, P1)', async () => {
  // Klucz konta serwisowego OCR migruje do %LOCALAPPDATA%\Scyzoryk (patrz
  // lib/ocrConfigMigration.js#userConfigPath) - OSOBNEGO katalogu niz zwykle
  // dane robocze aplikacji (%LOCALAPPDATA%\ScyzorykProjektowy). Bez wpisu w
  // [UninstallDelete] prywatny klucz zostawal na dysku uzytkownika po
  // odinstalowaniu, niewidoczny i nieusuwany.
  const source = await read('installer/scyzoryk.iss');
  const migrationSource = await read('lib/ocrConfigMigration.js');

  // Wycinamy tresc sekcji recznie (nie jednym zachlannym regexem z $) -
  // "^...$" z flaga /m dopasowuje $ na KAZDYM koncu linii, wiec lazy
  // [\s\S]*? zatrzymywalby sie natychmiast po nagłówku. Trzeba tez zaczac
  // dokladnie od naglowka sekcji na poczatku linii, nie od przypadkowego
  // wystapienia tekstu "[UninstallDelete]" w komentarzu gdzie indziej w
  // pliku (np. w [UninstallRun] jest taki komentarz).
  const startMatch = source.match(/^\[UninstallDelete\]\r?\n/m);
  assert.ok(startMatch, 'nie znaleziono sekcji [UninstallDelete]');
  const rest = source.slice(startMatch.index + startMatch[0].length);
  const nextSectionMatch = rest.match(/^\[/m);
  const section = nextSectionMatch ? rest.slice(0, nextSectionMatch.index) : rest;

  assert.match(section, /Type:\s*filesandordirs;\s*Name:\s*"\{localappdata\}\\Scyzoryk"/);
  // {localappdata}\ScyzorykProjektowy to INNY, zwykly katalog danych - nie
  // wolno pomylic tych dwoch sciezek w tescie ani w skrypcie.
  assert.doesNotMatch(section, /"\{localappdata\}\\ScyzorykProjektowy"/);
  assert.match(migrationSource, /path\.join\(base, 'Scyzoryk', 'ocr-document-ai\.json'\)/, 'sciezka w tescie musi nadal zgadzac sie z lib/ocrConfigMigration.js');
});

test('build instalatora bierze sekret OCR tylko ze środowiska i dodaje go do stagingu', async () => {
  const source = await read('scripts/build-installer.ps1');
  const gitignore = await read('.gitignore');
  assert.match(source, /OCR_DOCAI_CREDENTIALS_B64/);
  assert.match(source, /Add-OcrConfigurationToStaging/);
  assert.match(source, /FromBase64String/);
  assert.match(source, /service_account/);
  assert.match(source, /Get-ChildItem -Path \$stagingDir -Recurse -File -Filter 'service-account\.json'/);
  assert.match(source, /Eksport repo zawiera zabroniony plik service-account\.json/);
  assert.match(source, /Dolaczono gotowa konfiguracje Google Document AI do instalatora/);
  assert.match(gitignore, /apps\/ocr-audytow\/config\/document-ai\.json/);
  assert.match(gitignore, /apps\/ocr-audytow\/config\/service-account\.json/);
});

test('workflow wykonuje jeden kontrolowany przebieg z dwoma jobami i publikuje dopiero zweryfikowany EXE', async () => {
  const workflow = await read('.github/workflows/build-ready-installer.yml');
  assert.match(workflow, /name: Zbuduj gotowy instalator Windows z OCR/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /\.github\/run-ready-installer/);
  assert.doesNotMatch(workflow, /branches: \[ui-redesign-v1\][\s\S]*- 'public\/\*\*'/);
  assert.doesNotMatch(workflow, /git push|gh workflow run|\[instruction-screenshots\]/);

  assert.match(workflow, /prepare_final:/);
  assert.match(workflow, /verify_final:/);
  assert.doesNotMatch(workflow, /build_preview:|capture_and_test:|build_final:/);
  assert.match(workflow, /name: 1\. Zbuduj, przetestuj i przygotuj finalny instalator/);
  assert.match(workflow, /name: 2\. Zweryfikuj i opublikuj finalny instalator/);
  assert.equal((workflow.match(/uses: actions\/checkout@v4/g) || []).length, 2, 'Kod powinien być pobierany raz na każdy z dwóch jobów.');
  assert.equal((workflow.match(/uses: actions\/download-artifact@v4/g) || []).length, 1, 'Tylko finalny instalator powinien być pobierany między jobami.');

  const previewBuild = workflow.indexOf('name: Zbuduj instalator probny z OCR');
  const previewTest = workflow.indexOf('name: Zainstaluj, przetestuj i wykonaj aktualne zrzuty');
  const copyScreenshots = workflow.indexOf('name: Wstaw aktualne zrzuty do instrukcji');
  const finalBuild = workflow.indexOf('name: Zbuduj finalny instalator z OCR i aktualnymi zrzutami');
  assert.ok(previewBuild >= 0 && previewBuild < previewTest && previewTest < copyScreenshots && copyScreenshots < finalBuild,
    'Pierwszy job powinien kolejno zbudować wersję próbną, przetestować ją, wstawić zrzuty i zbudować finalny EXE.');

  assert.match(workflow, /OCR_DOCAI_CREDENTIALS_B64: \$\{\{ secrets\.OCR_DOCAI_CREDENTIALS_B64 \}\}/);
  assert.match(workflow, /public\\instrukcja-images/);
  assert.match(workflow, /-ExpectBundledOcr/);
  assert.match(workflow, /-TestLiveOcr/);
  assert.match(workflow, /if: success\(\)[\s\S]*name: Scyzoryk-Projektowy-gotowy-Windows-z-OCR/);
});

test('test świeżej instalacji rozróżnia zwykły i gotowy instalator OCR', async () => {
  const source = await read('scripts/ci/test-installed-scyzoryk.ps1');
  assert.match(source, /\[switch\]\$ExpectBundledOcr/);
  assert.match(source, /\[switch\]\$TestLiveOcr/);
  assert.match(source, /Prawdziwe polaczenie z Google Document AI bez konfiguracji po instalacji/);
  assert.match(source, /\[bool\]\$ocr\.ocrConfigured -eq \[bool\]\$ExpectBundledOcr/);
});

test('Pomoc prowadzi do rozbudowanej lokalnej instrukcji z aktualnymi zrzutami', async () => {
  const panel = await read('public/index.html');
  const panelScript = await read('public/inline-1.js');
  const instruction = await read('public/instrukcja.html');
  const loader = await read('public/instrukcja.js');
  const sections = await Promise.all([
    'public/instrukcja-sections/01-start.html',
    'public/instrukcja-sections/02-documents-stamps.html',
    'public/instrukcja-sections/03-printing-projects.html',
    'public/instrukcja-sections/04-ecodan-wnioski.html',
    'public/instrukcja-sections/05-karty-ocr-pomoc.html'
  ].map(read));
  const fullGuide = instruction + loader + sections.join('\n');

  assert.match(panel, /id="helpTopLink" href="\/instrukcja\.html"/);
  assert.doesNotMatch(panel, /helpModalOverlay/);
  assert.doesNotMatch(panelScript, /openModal|helpModalOverlay/);
  assert.match(loader, /instrukcja-sections\/01-start\.html/);

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
    assert.ok(fullGuide.includes(title), `Instrukcja nie zawiera sekcji: ${title}`);
  }
  for (const image of [
    '01-panel.png', '02-drukarka.png', '03-pieczatki.png', '04-formularze.png',
    '05-dokumenty-seryjne.png', '06-wnioski.png', '07-karty.png',
    '08-drukarka-projekty.png', '09-ocr.png'
  ]) {
    assert.ok(fullGuide.includes(`/instrukcja-images/${image}`), `Brakuje miejsca na aktualny zrzut: ${image}`);
  }
  assert.doesNotMatch(fullGuide, /10-instrukcja\.png/);
  assert.doesNotMatch(fullGuide, /Panel techniczny/);
  assert.match(fullGuide, /pierwsze trzy strony/i);
  assert.match(fullGuide, /nie trzeba ustawiać klucza/i);
});
