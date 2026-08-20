const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

test('geminiFieldEngine odczytuje klucz API w kolejności env, użytkownik (bez wariantu wbudowanego w instalator)', async () => {
  const source = await read('apps/ocr-audytow/src/geminiFieldEngine.js');
  assert.doesNotMatch(source, /BUNDLED_CONFIG_PATH/);
  const envIndex = source.indexOf("process.env.GEMINI_API_KEY");
  const userIndex = source.indexOf('readJsonFile(USER_CONFIG_PATH)');
  assert.ok(envIndex >= 0 && userIndex > envIndex, 'Zmienna srodowiskowa musi miec pierwszenstwo przed plikiem uzytkownika.');
});

test('odinstalowanie usuwa katalog %LOCALAPPDATA%\\Scyzoryk (klucz API Gemini, audyt rozdz. 22/23, P1)', async () => {
  // Klucz API Gemini trafia do %LOCALAPPDATA%\Scyzoryk (patrz
  // src/geminiFieldEngine.js#USER_CONFIG_PATH) - OSOBNEGO katalogu niz zwykle
  // dane robocze aplikacji (%LOCALAPPDATA%\ScyzorykProjektowy). Bez wpisu w
  // [UninstallDelete] prywatny klucz zostawal na dysku uzytkownika po
  // odinstalowaniu, niewidoczny i nieusuwany.
  const source = await read('installer/scyzoryk.iss');
  const engineSource = await read('apps/ocr-audytow/src/geminiFieldEngine.js');

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
  assert.match(engineSource, /path\.join\(\s*[\s\S]*?'Scyzoryk',\s*'gemini-api-key\.json'/, 'sciezka w tescie musi nadal zgadzac sie z src/geminiFieldEngine.js');
});

test('build instalatora nie ma juz zadnej logiki dolaczania sekretu OCR', async () => {
  const source = await read('scripts/build-installer.ps1');
  const gitignore = await read('.gitignore');
  assert.doesNotMatch(source, /OCR_DOCAI/);
  assert.doesNotMatch(source, /Add-OcrConfigurationToStaging/);
  assert.doesNotMatch(source, /service-account\.json/);
  assert.doesNotMatch(gitignore, /apps\/ocr-audytow\/config/);
});

test('workflow wykonuje jeden kontrolowany przebieg z dwoma jobami i publikuje dopiero zweryfikowany EXE (bez sekretu OCR)', async () => {
  const workflow = await read('.github/workflows/build-ready-installer.yml');
  assert.match(workflow, /name: Zbuduj gotowy instalator Windows/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /\.github\/run-ready-installer/);
  assert.doesNotMatch(workflow, /branches: \[main\][\s\S]*- 'public\/\*\*'/);
  assert.doesNotMatch(workflow, /git push|gh workflow run|\[instruction-screenshots\]/);

  assert.match(workflow, /prepare_final:/);
  assert.match(workflow, /verify_final:/);
  assert.doesNotMatch(workflow, /build_preview:|capture_and_test:|build_final:/);
  assert.match(workflow, /name: 1\. Zbuduj, przetestuj i przygotuj finalny instalator/);
  assert.match(workflow, /name: 2\. Zweryfikuj i opublikuj finalny instalator/);
  assert.equal((workflow.match(/uses: actions\/checkout@v4/g) || []).length, 2, 'Kod powinien być pobierany raz na każdy z dwóch jobów.');
  assert.equal((workflow.match(/uses: actions\/download-artifact@v4/g) || []).length, 1, 'Tylko finalny instalator powinien być pobierany między jobami.');

  const previewBuild = workflow.indexOf('name: Zbuduj instalator probny');
  const previewTest = workflow.indexOf('name: Zainstaluj, przetestuj i wykonaj aktualne zrzuty');
  const copyScreenshots = workflow.indexOf('name: Wstaw aktualne zrzuty do instrukcji');
  const finalBuild = workflow.indexOf('name: Zbuduj finalny instalator z aktualnymi zrzutami');
  assert.ok(previewBuild >= 0 && previewBuild < previewTest && previewTest < copyScreenshots && copyScreenshots < finalBuild,
    'Pierwszy job powinien kolejno zbudować wersję próbną, przetestować ją, wstawić zrzuty i zbudować finalny EXE.');

  assert.doesNotMatch(workflow, /OCR_DOCAI/);
  assert.doesNotMatch(workflow, /-ExpectBundledOcr/);
  assert.doesNotMatch(workflow, /-TestLiveOcr/);
  assert.match(workflow, /public\\instrukcja-images/);
  assert.match(workflow, /if: success\(\)[\s\S]*name: Scyzoryk-Projektowy-gotowy-Windows/);
});

test('test świeżej instalacji juz nie rozroznia wariantu z OCR (zaden nie istnieje)', async () => {
  const source = await read('scripts/ci/test-installed-scyzoryk.ps1');
  assert.doesNotMatch(source, /ExpectBundledOcr/);
  assert.doesNotMatch(source, /TestLiveOcr/);
  assert.match(source, /Instalator nie powinien zawierac wbudowanej konfiguracji OCR/);
  assert.match(source, /\$ocr\.ocrConfigured -eq \$false/);
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
    'Zdjęcia do PDF Protokołów',
    'Dokumenty seryjne PDF',
    'Wnioski powykonawcze PDF',
    'Dobory myEcodan',
    'Pieczątki PDF',
    'Przypisywanie plików do folderów',
    'OCR audytów',
    'Dobory Varmero',
    'Nazywarka skanów',
    'Tworzenie folderów'
  ]) {
    assert.ok(fullGuide.includes(title), `Instrukcja nie zawiera sekcji: ${title}`);
  }
  // Audyt 2026-08-17 (redesign + tryb ciemny): stare nazwy modulow zmienione
  // w calym Scyzoryku (Formularze Ecodan -> Dobory myEcodan, Formularze
  // Varmero -> Dobory Varmero) - instrukcja nie moze juz uczyc uzytkownika
  // nazw, ktorych nie ma nigdzie w prawdziwym interfejsie.
  assert.doesNotMatch(fullGuide, /Formularze Ecodan/);
  assert.doesNotMatch(fullGuide, /Formularze Varmero/);
  for (const image of [
    '01-panel.png', '02-drukarka.png', '03-pieczatki.png', '04-formularze.png',
    '05-dokumenty-seryjne.png', '06-wnioski.png', '07-karty.png',
    '08-drukarka-projekty.png', '09-ocr.png',
    '11-varmero.png', '12-nazywarka-skanow.png', '13-tworzenie-folderow.png',
    '14-protokoly.png'
  ]) {
    assert.ok(fullGuide.includes(`/instrukcja-images/${image}`), `Brakuje miejsca na aktualny zrzut: ${image}`);
  }
  assert.doesNotMatch(fullGuide, /10-instrukcja\.png/);
  assert.doesNotMatch(fullGuide, /Panel techniczny/);
  assert.match(fullGuide, /pierwsze trzy strony/i);
  assert.match(fullGuide, /nie trzeba ustawiać klucza/i);
});

test('kazda aplikacja z apps\\ ma wlasna linie node_modules w wariancie "full" instalatora (audyt 2026-08-17: protokoly zapomniana przy dodaniu apki, zlapane na zywym CI)', async () => {
  // server.js jest zrodlem prawdy dla listy aplikacji (patrz CLAUDE.md: "kazda
  // apka ma wlasna, jawna linie" w scyzoryk.iss - Inno Setup nie wspiera
  // wzorca "apps\*\node_modules\*" jako Source). Brak wpisu tu oznacza, ze
  // wariant "full" instalatora NIE zawiera node_modules tej apki wcale -
  // apka pada z MODULE_NOT_FOUND dopiero po instalacji, bo staging (gdzie
  // walidacja node_modules faktycznie dziala) i finalny EXE to inne rzeczy.
  const serverSource = await read('server.js');
  const issSource = await read('installer/scyzoryk.iss');

  const slugMatches = [...serverSource.matchAll(/slug:\s*'([a-z0-9-]+)',\s*dir:\s*path\.join\(ROOT,\s*'apps',/g)];
  const slugs = [...new Set(slugMatches.map((m) => m[1]))];
  assert.ok(slugs.length >= 10, 'Nie udalo sie sparsowac listy aplikacji z server.js - regex mogl przestac pasowac.');

  const missing = slugs.filter((slug) => !issSource.includes(`apps\\${slug}\\node_modules\\*`));
  assert.deepEqual(missing, [], `Brak linii node_modules w scyzoryk.iss dla: ${missing.join(', ')}`);
});
