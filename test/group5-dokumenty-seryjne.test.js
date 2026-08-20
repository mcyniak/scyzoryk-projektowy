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
  assert.match(source, /missingColumns,\s*message: `Arkusz "\$\{sheetName\}"/);
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
