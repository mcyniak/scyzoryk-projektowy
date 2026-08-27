const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'server.js');

test('pełne rekordy są przechowywane, a podgląd jest osobną listą', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  assert.match(source, /const allRows = filtered\.map/);
  assert.match(source, /const previewRows = allRows\.slice\(0, MAX_ROWS\)/);
  assert.match(source, /return \{ sheetName, columns, rows: allRows, previewRows/);
  assert.match(source, /selectedSheet\.rows \|\| \[\]/);
  assert.match(source, /\/api\/jobs\/:jobId\/sheets\/:sheetName\/rows/);
  assert.match(source, /sheet\.rows\.slice\(offset, offset \+ limit\)/);
});

test('wybrany arkusz jest walidowany w podglądzie, paginacji i generowaniu', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  const validations = source.match(/validateReferenceColumns\(/g) || [];
  assert.ok(validations.length >= 5, `wywołania walidacji: ${validations.length}`);
  // Komunikat o brakujacych kolumnach jest teraz jedna wspolna funkcja
  // (audyt 2026-08-21 - hint "to moze byc zla tabela" w jednym miejscu,
  // zamiast 4 rozjezdzajacych sie kopii tego samego stringa).
  assert.match(source, /function komunikatBrakujacychKolumn\(sheetName, missingColumns\)/);
  assert.match(source, /Arkusz "\$\{sheetName\}" nie ma wymaganych kolumn: \$\{missingColumns\.join/);
  const wywolania = source.match(/komunikatBrakujacychKolumn\(/g) || [];
  assert.ok(wywolania.length >= 5, `wywolania komunikatu (1 definicja + min. 4 uzycia): ${wywolania.length}`);
});

test('zadania aktywne po restarcie są przerywane i można je anulować', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  assert.match(source, /\['running', 'queued', 'cancelling'\]\.includes\(item\.status\)/);
  assert.match(source, /status: interrupted \? 'interrupted'/);
  assert.match(source, /interruptedReason: interrupted \? 'process-restarted'/);
  assert.match(source, /if \(job\.status === 'interrupted'\) \{\s*job\.status = 'cancelled'/);
});

test('anulowanie zatrzymuje CALA paczke szablonow, nie tylko biezacy proces (audyt v1.0.4, P1-2)', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  // /api/cancel/:jobId musi ustawiac flage sprawdzana przez petle wielo-
  // szablonowa - samo job.child.kill() zabijalo tylko AKTUALNY proces
  // PowerShell, a petla i tak ruszala z kolejnym szablonem w paczce.
  assert.match(source, /job\.cancelRequested = true;/);
  const cancelRoute = source.match(/app\.post\('\/api\/cancel\/:jobId'[\s\S]*?\n\}\);/);
  assert.ok(cancelRoute, 'nie znaleziono trasy /api/cancel/:jobId');
  assert.match(cancelRoute[0], /job\.cancelRequested = true;/);

  const loopFn = source.match(/async function runMultiTemplateGeneration[\s\S]*?\n\}/);
  assert.ok(loopFn, 'nie znaleziono runMultiTemplateGeneration');
  // Sprawdzenie flagi musi byc W SRODKU petli (przed kazdym kolejnym
  // szablonem), nie tylko raz przed jej rozpoczeciem.
  assert.match(loopFn[0], /for \(let i = 0; i < tasks\.length; i \+= 1\) \{\s*\n\s*\/\/[\s\S]*?if \(job\.cancelRequested\)/);
  assert.match(loopFn[0], /cancelledEarly = true/);
  assert.match(loopFn[0], /job\.status = cancelledEarly \? 'cancelled'/);
});

test('anulowanie OSTATNIEGO/jedynego szablonu w paczce nie ląduje jako "error" (i nie leci jako fałszywe zdarzenie telemetryczne generation-failed)', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  // Realny przypadek zgloszony przez wlasciciela: /api/cancel/:jobId zabija
  // job.child W TRAKCIE await startGeneration(). Jesli to byl OSTATNI
  // (albo jedyny) szablon w paczce, petla juz nigdy nie wraca na gore, wiec
  // sam warunek na POCZATKU petli nigdy by tego nie zlapal - cancelledEarly
  // zostawaloby false, job konczylby jako status='error', a telemetria
  // wysylalaby prawdziwe zdarzenie 'failed'/'generation-failed' mimo ze to
  // bylo celowe przerwanie przez uzytkownika, nie realny blad.
  const loopFn = source.match(/async function runMultiTemplateGeneration[\s\S]*?\n\}/);
  assert.ok(loopFn, 'nie znaleziono runMultiTemplateGeneration');
  const body = loopFn[0];

  // Musi istniec DRUGIE sprawdzenie job.cancelRequested, PO await
  // startGeneration(...) (a wiec i po "first = false;", ktore nastepuje
  // zaraz po try/catch), nie tylko na poczatku petli.
  const firstFalseIndex = body.indexOf('first = false;');
  const afterFirstFalse = body.slice(firstFalseIndex);
  assert.ok(firstFalseIndex >= 0, 'nie znaleziono "first = false;" w petli');
  assert.match(afterFirstFalse, /if \(job\.cancelRequested\) \{\s*\n\s*cancelledEarly = true;/);

  // Wynik nieudanego/zabitego zadania (result.ok===false / rzucony wyjatek)
  // NIE moze byc dopisany do allErrors, gdy to anulowanie - inaczej job
  // konczylby sie jako status='error' (allCreated.length===0) zamiast
  // 'cancelled', mimo poprawionej flagi cancelledEarly.
  assert.match(body, /result\.created \|\| !result\.created\.length\) && !job\.cancelRequested\) \{/);
  assert.match(body, /catch \(err\) \{\s*\n\s*if \(!job\.cancelRequested\) allErrors\.push/);
});

test('generate: wpisany przez uzytkownika przedrostek nazwy pliku faktycznie trafia do wygenerowanych plikow (nie tylko do podgladu)', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  // Zlapane realnie: pole "Przedrostek nazwy pliku" w UI pokazywalo zywy
  // podglad, ale runMultiTemplateGeneration ZAWSZE nadpisywala filePrefix
  // wartoscia task.groupName (automatycznie wykryta nazwa typu dokumentu) -
  // to, co uzytkownik wpisal, nigdy nie trafialo do prawdziwej nazwy pliku.
  // Teraz niepusty wpis uzytkownika ma pierwszenstwo przed automatyczna
  // nazwa (dla wszystkich wybranych dokumentow naraz) - puste pole dalej
  // daje dawne zachowanie (automatyczna nazwa typu per dokument).
  assert.match(source, /const userFilePrefix = cleanFilePrefix\(options\.filePrefix \|\| ''\);/);
  const loopFn = source.match(/async function runMultiTemplateGeneration[\s\S]*?\n\}/);
  assert.ok(loopFn, 'nie znaleziono runMultiTemplateGeneration');
  assert.match(loopFn[0], /filePrefix: userFilePrefix \|\| task\.groupName/);
});

test('generate: kazde uruchomienie czysci poprzedni katalog wyjsciowy PO walidacji, przed faktycznym startem (audyt rozdz. 12, P0/P1)', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  const generateRoute = source.match(/app\.post\('\/api\/generate\/:jobId'[\s\S]*?\n\}\);/);
  assert.ok(generateRoute, "nie znaleziono trasy /api/generate/:jobId");
  const body = generateRoute[0];

  // Czyszczenie musi istniec i uzywac rm z recursive/force (nie zwykle
  // unlink - job.outputDir moze zawierac podkatalogi, np. logi debug).
  assert.match(body, /for \(const entry of await fsp\.readdir\(job\.outputDir\)\.catch\(\(\) => \[\]\)\) \{/);
  assert.match(body, /fsp\.rm\(path\.join\(job\.outputDir, entry\), \{ recursive: true, force: true \}\)/);

  // Kolejnosc w zrodle jest bezposrednim dowodem: walidacje (brakujace
  // kolumny, brak zadan) MUSZA wystapic PRZED czyszczeniem - nieudana proba
  // (np. zle dobrany arkusz) nie moze skasowac wynikow poprzedniego, udanego
  // uruchomienia. Czyszczenie z kolei MUSI wystapic PRZED wordQueue.run -
  // inaczej nowe pliki tworzone przez biezace uruchomienie zostalyby same
  // skasowane zaraz po powstaniu.
  const missingColumnsIndex = body.indexOf('missingColumns.length) {');
  const tasksLengthIndex = body.indexOf('!tasks.length) return');
  const cleanupIndex = body.indexOf('for (const entry of await fsp.readdir(job.outputDir)');
  const wordQueueRunIndex = body.indexOf('wordQueue.run(() => runMultiTemplateGeneration');
  assert.ok(missingColumnsIndex >= 0 && tasksLengthIndex >= 0 && cleanupIndex >= 0 && wordQueueRunIndex >= 0);
  assert.ok(missingColumnsIndex < cleanupIndex, 'walidacja kolumn musi byc przed czyszczeniem');
  assert.ok(tasksLengthIndex < cleanupIndex, 'walidacja zadan musi byc przed czyszczeniem');
  assert.ok(cleanupIndex < wordQueueRunIndex, 'czyszczenie musi byc przed faktycznym startem generowania');

  // job.result tez musi zostac wyzerowany - inaczej stary wynik (odnoszacy
  // sie do wlasnie skasowanych plikow) zostalby pokazany az do zakonczenia
  // nowego uruchomienia.
  assert.match(body, /job\.result = null;[\s\S]{0,40}job\.status = 'queued';/);
});

test('frontend pobiera wszystkie strony rekordów przed renderowaniem', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'public', 'inline-1.js'), 'utf8');
  assert.match(source, /async function loadAllRows/);
  assert.match(source, /offset < Number\(workbook\.totalRows/);
  assert.match(source, /const limit = 500/);
});

test('obsluga zdjec: backend ma endpointy uploadu, podsumowania i walidacji w generate', async () => {
  const source = await fsp.readFile(serverPath, 'utf8');
  assert.match(source, /app\.post\('\/api\/images\/:jobId'/);
  assert.match(source, /app\.post\('\/api\/images\/:jobId\/summary'/);
  const generateRoute = source.match(/app\.post\('\/api\/generate\/:jobId'[\s\S]*?\n\}\);/);
  assert.ok(generateRoute, 'nie znaleziono trasy /api/generate/:jobId');
  assert.match(generateRoute[0], /detectImageMergeFields\(task\.templatePath\)/);
  assert.match(generateRoute[0], /summarizeImages\(/);
  assert.match(generateRoute[0], /summary\.status !== 'complete'/);
  assert.match(source, /'-ImageManifestJson', job\.imageManifestPath/);
});

test('saveWord: opcja "Zapisuj takze do Word (.docx)" jest przekazywana przez UI do PowerShell i zwracana w ZIP-ie', async () => {
  const serverSource = await fsp.readFile(serverPath, 'utf8');
  assert.match(serverSource, /const saveWord = options\.saveWord === true;/);
  assert.match(serverSource, /if \(saveWord\) args\.push\('-SaveWord'\);/);
  assert.ok(serverSource.includes('(/\\.pdf$/i.test(file) || /\\.docx$/i.test(file))'));
  assert.ok(serverSource.includes("contentType = /\\.docx$/i.test(file)"));

  const inlineSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'public', 'inline-1.js'), 'utf8');
  assert.ok(inlineSource.includes("saveWord: $('saveWord') ? $('saveWord').checked : false"));

  const htmlSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'public', 'index.html'), 'utf8');
  assert.ok(htmlSource.includes('id="saveWord"'));
  assert.ok(htmlSource.includes('Zapisuj także do Word (.docx)'));

  const psSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'scripts', 'mailmerge-to-pdf.ps1'), 'utf8');
  assert.ok(psSource.includes('[switch]$SaveWord'));
  assert.ok(psSource.includes('if ($SaveWord)'));
});

test('obsluga zdjec: PowerShell wczytuje manifest i wstawia obrazy przed tekstem', async () => {
  const psPath = path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'scripts', 'mailmerge-to-pdf.ps1');
  const source = await fsp.readFile(psPath, 'utf8');
  assert.match(source, /\[string\]\$ImageManifestJson/);
  assert.match(source, /function Load-ImageManifest/);
  assert.match(source, /function Replace-AllImageMergeFields/);
  assert.match(source, /Replace-AllImageMergeFields \$mergedDoc \$record \$imageFieldDebug/);
  assert.match(source, /\$fieldDebug = Replace-AllMergeFields \$mergedDoc \$record/);
  const indexImage = source.indexOf('Replace-AllImageMergeFields $mergedDoc $record $imageFieldDebug');
  const indexMerge = source.indexOf('$fieldDebug = Replace-AllMergeFields $mergedDoc $record');
  assert.ok(indexImage >= 0 && indexMerge >= 0 && indexImage < indexMerge, 'obrazy musza byc wstawiane przed polami tekstowymi');
});

test('imageMatching.js: dopasowanie zdjec do adresow i pol szablonu', async () => {
  const im = require('../apps/dokumenty-seryjne/src/imageMatching.js');
  assert.strictEqual(im.normalizeAddress('Krążkowice 14A'), 'krazkowice 14a');

  const manifest = {
    root: '/tmp',
    files: [
      { relativePath: 'Adresy/Kraszkowice 14/1.jpg', addressFolder: 'Kraszkowice 14', storedPath: '/tmp/1.jpg', originalName: '1.jpg' },
      { relativePath: 'Adresy/Kraszkowice 14/Zdjecie_2.png', addressFolder: 'Kraszkowice 14', storedPath: '/tmp/2.png', originalName: 'Zdjecie_2.png' }
    ]
  };
  const resolved = im.resolveImagesForAddress('Kraszkowice 14', ['Zdjecie_1', 'Zdjecie_2'], manifest);
  assert.strictEqual(resolved.status, 'complete');
  assert.ok(resolved.matches.Zdjecie_1);
  assert.ok(resolved.matches.Zdjecie_2);

  const missing = im.resolveImagesForAddress('Kraszkowice 14', ['Zdjecie_1'], { root: '/tmp', files: [] });
  assert.strictEqual(missing.status, 'missing');
});

// =====================================================================
// Realny przypadek (Wierzchlas PV, 2026-08-19): eksport z Google Sheets
// zostawia w pliku ukryte, technicznie nazwane arkusze (np. losowy ID) -
// read-excel-file zwracalo je w kolejnosci NIEZALEZNEJ od widocznych zakladek
// w samym Excelu (na prawdziwym pliku zwrocilo ukryty arkusz jako PIERWSZY,
// mimo ze byl OSTATNI w deklaracji xl/workbook.xml, a widoczna pierwsza
// zakladka "PV_" byla trzecia w tej kolejnosci). Upload wybieral wiec
// techniczny arkusz jako domyslny zamiast prawdziwej tabeli danych.
// =====================================================================
{
  const os = require('node:os');
  // xlsx tylko do ZAPISU fixture'ow testowych (bezpieczne) - pozyczone z
  // ocr-audytow, jedynego modulu ktory nadal legalnie trzyma xlsx jako
  // zaleznosc (patrz komentarz w apps/ocr-audytow/src/excelExport.js).
  const XLSX = require(path.join(__dirname, '..', 'apps', 'ocr-audytow', 'node_modules', 'xlsx'));
  const AdmZip = require(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'node_modules', 'adm-zip'));
  const { pickDefaultSheet, getSheetOrderFromWorkbookXml, validateReferenceColumns, groupMailMergeTemplates } = require('../apps/dokumenty-seryjne/server');

  async function makeTempDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'ds-hidden-sheet-'));
  }

  test('getSheetOrderFromWorkbookXml/pickDefaultSheet: arkusz UKRYTY w xl/workbook.xml nigdy nie jest wybierany jako domyslny, nawet gdyby byl pierwszy w kolejnosci nazw', async (t) => {
    const dir = await makeTempDir();
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'losowyIdTechniczny');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['y']]), 'PV_');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['z']]), 'umowa');
    wb.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 0 }, { Hidden: 0 }] };
    const xlsxPath = path.join(dir, 'dane.xlsx');
    XLSX.writeFile(wb, xlsxPath);

    const order = getSheetOrderFromWorkbookXml(xlsxPath);
    assert.deepEqual(order, [
      { name: 'losowyIdTechniczny', hidden: true },
      { name: 'PV_', hidden: false },
      { name: 'umowa', hidden: false }
    ]);

    // sheetNames w KOLEJNOSCI ODWROTNEJ nadmyslnie symuluje read-excel-file
    // (kolejnosc niezalezna od xl/workbook.xml, real przypadek zweryfikowany
    // na prawdziwym pliku Wierzchlas) - mimo to musi wybrac "PV_", nie
    // pierwszy element tej (zawodnej) listy ani ukryty arkusz.
    const sheetNamesFromReadExcelFile = ['umowa', 'PV_', 'losowyIdTechniczny'];
    assert.equal(pickDefaultSheet(sheetNamesFromReadExcelFile, 'jakis_szablon.docx', order), 'PV_');

    // Bez zadnej informacji o mocy w nazwie szablonu i bez xml (np. plik
    // nieczytelny) - fallback na stara logike (pierwszy element listy).
    assert.equal(pickDefaultSheet(sheetNamesFromReadExcelFile, 'jakis_szablon.docx', null), 'umowa');
  });

  test('validateReferenceColumns: akceptuje synonimy realnie wystepujace w innych tabelach (UID/LP zamiast ID, Imię i Nazwisko zamiast Beneficjent) - real przypadek PV_ z Wierzchlasu', () => {
    const pvColumns = ['UID', 'LP', 'Adres', 'Imię i Nazwisko', 'Nr telefonu'];
    assert.deepEqual(validateReferenceColumns(pvColumns), []);

    // Tabela, ktora faktycznie nie ma zadnej z tych kolumn (np. przypadkowo
    // wgrany zupelnie inny arkusz) - dalej musi byc odrzucona.
    assert.deepEqual(validateReferenceColumns(['Numer telefonu', 'Kod pocztowy']), ['ID', 'Adres', 'Beneficjent']);
  });

  function buildMinimalDocx(destPath, { withMailMerge = false } = {}) {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
    zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
    zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>test</w:t></w:r></w:p></w:body></w:document>'));
    const settings = withMailMerge
      ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:mailMerge><w:mainDocumentType w:val="formLetters"/><w:dataType w:val="native"/><w:connectString w:val="Provider=...;Data Source=C:\\dane.xlsx;"/><w:query w:val="SELECT * FROM `PV_$`"/><w:table w:val="\'PV_$\'"/></w:mailMerge></w:settings>'
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';
    zip.addFile('word/settings.xml', Buffer.from(settings));
    zip.writeZip(destPath);
  }

  test('groupMailMergeTemplates: szablon BEZ prawdziwego powiazania Worda ("Wybierz odbiorców") dostaje defaultSheet zamiast bycia pominietym - real przypadek: szablon zrobiony recznie/przez ChatGPT bez uzycia Mailings w Wordzie', async (t) => {
    const dir = await makeTempDir();
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const docxPath = path.join(dir, 'Wzorzec_bez_bindowania.docx');
    buildMinimalDocx(docxPath, { withMailMerge: false });

    const { groups, skipped } = groupMailMergeTemplates(
      [{ path: docxPath, originalName: 'Wzorzec_bez_bindowania.docx' }],
      'PV_'
    );
    assert.deepEqual(skipped, []);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].variants, { PV_: { path: docxPath, originalName: 'Wzorzec_bez_bindowania.docx' } });
  });

  test('groupMailMergeTemplates: bez defaultSheet I bez powiazania Worda - nadal pomijany (zero regresji dla starego zachowania/prawdziwie nieznanego przypadku)', async (t) => {
    const dir = await makeTempDir();
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const docxPath = path.join(dir, 'Nieznany.docx');
    buildMinimalDocx(docxPath, { withMailMerge: false });

    const { groups, skipped } = groupMailMergeTemplates([{ path: docxPath, originalName: 'Nieznany.docx' }], null);
    assert.equal(groups.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /brak prawdziwego powiazania/);
  });

  test('groupMailMergeTemplates: szablon Z prawdziwym powiazaniem Worda dalej dziala jak dotychczas (zero regresji, np. Slesin)', async (t) => {
    const dir = await makeTempDir();
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const docxPath = path.join(dir, 'Slesin_8kW.docx');
    buildMinimalDocx(docxPath, { withMailMerge: true });

    const { groups, skipped } = groupMailMergeTemplates([{ path: docxPath, originalName: 'Slesin_8kW.docx' }], 'jakis_inny_arkusz');
    assert.deepEqual(skipped, []);
    assert.equal(groups.length, 1);
    assert.ok(groups[0].variants['PV_'], 'powiazanie z docx ma pierwszenstwo przed defaultSheet');
  });
}
