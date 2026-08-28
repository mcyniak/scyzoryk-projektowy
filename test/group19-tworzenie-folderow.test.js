// Testy tworzenie-folderow: czysta logika (excel.js/folderPlan.js), zero
// dostepu do prawdziwego systemu plikow poza zapisem tymczasowych plikow
// .xlsx uzywanych jako fixture (ten sam wzorzec co test/group11-karty-katalogowe.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// xlsx tylko do ZAPISU fixture'ow testowych (bezpieczne - nie czyta danych
// od uzytkownika) - pozyczone z ocr-audytow, jedynego modulu, ktory nadal
// legalnie trzyma xlsx jako zaleznosc (patrz komentarz w
// apps/ocr-audytow/src/excelExport.js). tworzenie-folderow samo juz go NIE
// uzywa do odczytu (audyt 2026-08-20: migracja na read-excel-file, patrz
// komentarz w src/excel.js).
const XLSX = require('../apps/ocr-audytow/node_modules/xlsx');
const { readTabelaAdresowa, readAddressSheets, classifySheetType, normalizeHeader, isAirSourcePump, isGroundSourcePump } = require('../apps/tworzenie-folderow/src/excel.js');
const { buildFolderPlan, safeSegment, distinctGminas } = require('../apps/tworzenie-folderow/src/folderPlan.js');
const { buildSimpleFolderNames } = require('../apps/tworzenie-folderow/src/simplePlan.js');

async function napiszArkusze(sheets) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tf-xlsx-'));
  const file = path.join(dir, 'dane.xlsx');
  const wb = XLSX.utils.book_new();
  for (const [sheetName, rows] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, file);
  return { dir, file };
}

// =====================================================================
// excel.js
// =====================================================================

test('normalizeHeader: polskie "l z kreska" nie gubi sie pod NFD (ten sam problem co dokumenty-seryjne/formularze-varmero)', () => {
  assert.equal(normalizeHeader('Kotły'), 'kotly');
  assert.equal(normalizeHeader('Rodzaj pompy'), 'rodzaj pompy');
});

test('classifySheetType: rozpoznaje pompy/kolektory/kotly po nazwie arkusza, ignoruje niepasujace', () => {
  assert.equal(classifySheetType('Pompy ciepła'), 'pompy');
  assert.equal(classifySheetType('Pompy'), 'pompy');
  assert.equal(classifySheetType('Solary Paradyż'), 'kolektory');
  assert.equal(classifySheetType('Kolektory'), 'kolektory');
  assert.equal(classifySheetType('Kotły na pellet'), 'kotly');
  assert.equal(classifySheetType('Adresy'), null);
});

test('isAirSourcePump/isGroundSourcePump: te same wzorce co formularze-varmero', () => {
  assert.equal(isGroundSourcePump('Gruntowa'), true);
  assert.equal(isAirSourcePump('Powietrze-woda'), true);
  assert.equal(isAirSourcePump('Gruntowa'), false);
  assert.equal(isGroundSourcePump('Powietrze-woda'), false);
  assert.equal(isAirSourcePump(''), false);
  assert.equal(isGroundSourcePump('cos nieznanego'), false);
});

test('readTabelaAdresowa: odczytuje wiele arkuszy naraz, klasyfikuje kazdy osobno', async (t) => {
  const HEADER_POMPY = ['LP', 'Adres', 'Rodzaj pompy'];
  const HEADER_KOLEKTORY = ['ID', 'Adres'];
  const { dir, file } = await napiszArkusze([
    ['Pompy ciepła', [HEADER_POMPY, ['1', 'Testowa 1', 'Gruntowa'], ['2', 'Testowa 2', 'Powietrze-woda'], ['3', 'Testowa 3', 'nieznany typ']]],
    ['Solary', [HEADER_KOLEKTORY, ['10', 'Kolektorowa 1'], ['11', 'Kolektorowa 2']]],
    ['Notatki', [['cos innego, nie tabela']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const result = await readTabelaAdresowa(file);
  assert.equal(result.sheets.length, 2, 'arkusz "Notatki" nie pasuje do zadnego typu i jest pomijany');

  const pompy = result.sheets.find(s => s.type === 'pompy');
  assert.equal(pompy.records.length, 3);
  assert.equal(pompy.gminaColumnPresent, false);
  assert.equal(pompy.records[0].pumpType, 'grunt');
  assert.equal(pompy.records[1].pumpType, 'powietrzna');
  assert.equal(pompy.records[2].pumpType, null, 'nierozpoznany typ pompy - NIGDY nie zgadujemy');
  assert.equal(pompy.records[0].lpOrId, '1');

  const kolektory = result.sheets.find(s => s.type === 'kolektory');
  assert.equal(kolektory.records.length, 2);
  assert.equal(kolektory.records[0].lpOrId, '10');
});

test('readTabelaAdresowa: kolumna LP obecna ale pusta w wierszach z adresem -> czytelny blad zamiast cichego "0 rekordow" (realny plik, Slupca)', async (t) => {
  const HEADER_POMPY = ['LP', 'Adres', 'Rodzaj pompy'];
  const { dir, file } = await napiszArkusze([
    ['Pompy ciepła', [HEADER_POMPY, ['', 'Testowa 1', 'Powietrze-woda'], ['', 'Testowa 2', 'Powietrze-woda'], ['3', 'Testowa 3', 'Gruntowa']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => readTabelaAdresowa(file), /LP jest pusta.*Pompy ciepła.*2 wierszy/s);
});

test('readTabelaAdresowa: wiersz z danymi, ale pustym Adresem -> czytelny blad zamiast cichego pominiecia (audyt 2026-08-21, symetryczne do brakujacego LP)', async (t) => {
  const HEADER_POMPY = ['LP', 'Adres', 'Rodzaj pompy'];
  const { dir, file } = await napiszArkusze([
    ['Pompy ciepła', [HEADER_POMPY, ['1', '', 'Powietrze-woda'], ['2', 'Testowa 2', 'Gruntowa']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => readTabelaAdresowa(file), /Adres jest pusta.*Pompy ciepła.*1 wiersz/s);
});

test('readTabelaAdresowa: nierozpoznany wiersz naglowka (brak kolumn Adres/LP-ID w pierwszych 20 wierszach) -> czytelny blad zamiast cichego "0 rekordow" (audyt 2026-08-21)', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Pompy ciepła', [['Cos', 'Zupelnie', 'Innego'], ['a', 'b', 'c']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => readTabelaAdresowa(file), /nie znaleziono wiersza nagłówka/i);
});

test('readTabelaAdresowa: kolumna ID (nie LP) tez jest rozpoznawana jako numer wiersza', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Kotły', [['ID', 'Adres'], ['5', 'Testowa 5']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const result = await readTabelaAdresowa(file);
  assert.equal(result.sheets[0].records[0].lpOrId, '5');
});

test('readTabelaAdresowa: naglowek dwuwyrazowy "ID Gminy" (nie samo "ID") tez jest rozpoznawany jako wiersz naglowka (audyt 2026-08-21 - wczesniej findHeaderRowIndex wymagal dopasowania DOKLADNEGO, wiec caly wiersz naglowka nie byl w ogole wykryty)', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Pompy', [['ID Gminy', 'Adres', 'Rodzaj pompy'], ['7', 'Testowa 7', 'Powietrze-woda']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const result = await readTabelaAdresowa(file);
  assert.equal(result.sheets[0].records.length, 1);
  assert.equal(result.sheets[0].records[0].lpOrId, '7');
  assert.equal(result.sheets[0].records[0].pumpType, 'powietrzna');
});

test('readTabelaAdresowa: obecnosc kolumny Gmina jest sygnalem "wiele gmin" (potwierdzone przez wlasciciela)', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Kotły', [['LP', 'Adres', 'Gmina'], ['1', 'Testowa 1', 'Żarnów'], ['2', 'Testowa 2', 'Masłowice']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const result = await readTabelaAdresowa(file);
  assert.equal(result.sheets[0].gminaColumnPresent, true);
  assert.equal(result.sheets[0].records[0].gmina, 'Żarnów');
});

// =====================================================================
// folderPlan.js
// =====================================================================

function pompySheet(records, gminaColumnPresent = false) {
  return { sheets: [{ type: 'pompy', sheetName: 'Pompy', gminaColumnPresent, records }] };
}

test('buildFolderPlan: WM jest zawsze obecny, nawet bez zadnego rozpoznanego arkusza', () => {
  const plan = buildFolderPlan({ sheets: [] });
  assert.deepEqual(plan, ['WM']);
});

test('buildFolderPlan: PC Grunt/PC powietrzne powstaja TYLKO gdy jest przynajmniej jeden pasujacy wiersz', () => {
  const onlyGrunt = buildFolderPlan(pompySheet([{ lpOrId: '1', address: 'A', gmina: '', pumpType: 'grunt' }]));
  assert.ok(onlyGrunt.some(p => p.startsWith('pompy/PC Grunt')));
  assert.ok(!onlyGrunt.some(p => p.startsWith('pompy/PC powietrzne')), 'brak wiersza powietrznego -> brak calego poddrzewa PC powietrzne');

  const neither = buildFolderPlan(pompySheet([{ lpOrId: '1', address: 'A', gmina: '', pumpType: null }]));
  assert.ok(!neither.some(p => p.startsWith('pompy/')), 'nierozpoznany typ pompy nie tworzy ani PC Grunt, ani PC powietrzne');
});

test('buildFolderPlan: PC Grunt dostaje dokladnie 6 potwierdzonych podfolderow (jedna gmina, jeden adres)', () => {
  const plan = buildFolderPlan(pompySheet([{ lpOrId: '1', address: 'Testowa 1', gmina: '', pumpType: 'grunt' }]));
  const pcGrunt = plan.filter(p => p.startsWith('pompy/PC Grunt/'));
  assert.deepEqual(new Set(pcGrunt), new Set([
    'pompy/PC Grunt/audyty',
    'pompy/PC Grunt/dobory',
    'pompy/PC Grunt/OZC/pdf',
    'pompy/PC Grunt/Projekty robót geologicznych',
    'pompy/PC Grunt/projekty',
    'pompy/PC Grunt/projekty/1.Testowa 1/pdf',
    'pompy/PC Grunt/wzór'
  ]));
});

test('buildFolderPlan: kolektory/kotly dostaja TYLKO projekty+wzor, nigdy audyty/dobory/OZC/geologiczne', () => {
  const plan = buildFolderPlan({
    sheets: [
      { type: 'kolektory', sheetName: 'Solary', gminaColumnPresent: false, records: [{ lpOrId: '1', address: 'Kol 1', gmina: '', pumpType: null }] },
      { type: 'kotly', sheetName: 'Kotły', gminaColumnPresent: false, records: [{ lpOrId: '2', address: 'Kot 1', gmina: '', pumpType: null }] }
    ]
  });
  const kolektoryPaths = plan.filter(p => p.startsWith('kolektory/'));
  assert.deepEqual(new Set(kolektoryPaths), new Set(['kolektory/projekty', 'kolektory/projekty/1.Kol 1/pdf', 'kolektory/wzór']));
  const kotlyPaths = plan.filter(p => p.startsWith('kotły/'));
  assert.deepEqual(new Set(kotlyPaths), new Set(['kotły/projekty', 'kotły/projekty/2.Kot 1/pdf', 'kotły/wzór']));
});

test('buildFolderPlan: wiele gmin dodaje poziom gminy dla audyty/dobory/OZC/projekty/geologiczne, ale NIGDY dla wzor', () => {
  const plan = buildFolderPlan(pompySheet([
    { lpOrId: '1', address: 'A1', gmina: 'Żarnów', pumpType: 'grunt' },
    { lpOrId: '2', address: 'A2', gmina: 'Masłowice', pumpType: 'grunt' }
  ], true));
  const pcGrunt = plan.filter(p => p.startsWith('pompy/PC Grunt/'));

  assert.ok(pcGrunt.includes('pompy/PC Grunt/audyty/Żarnów'));
  assert.ok(pcGrunt.includes('pompy/PC Grunt/audyty/Masłowice'));
  assert.ok(pcGrunt.includes('pompy/PC Grunt/OZC/Żarnów/pdf'));
  assert.ok(pcGrunt.includes('pompy/PC Grunt/projekty/Żarnów/1.A1/pdf'));
  assert.ok(pcGrunt.includes('pompy/PC Grunt/projekty/Masłowice/2.A2/pdf'));
  assert.equal(pcGrunt.filter(p => p === 'pompy/PC Grunt/wzór').length, 1);
  assert.ok(!pcGrunt.some(p => p.startsWith('pompy/PC Grunt/wzór/')), 'wzor NIGDY nie dostaje podzialu na gminy');
});

test('buildFolderPlan: jedna gmina (brak kolumny Gmina) -> bez dodatkowego poziomu folderow', () => {
  const plan = buildFolderPlan(pompySheet([{ lpOrId: '1', address: 'A1', gmina: '', pumpType: 'grunt' }], false));
  assert.ok(plan.includes('pompy/PC Grunt/audyty'));
  assert.ok(!plan.some(p => p.startsWith('pompy/PC Grunt/audyty/')));
});

test('safeSegment: neutralizuje probe wyjscia poza folder inwestycji (dane z Excela = dane od klienta)', () => {
  // Wlasciwa gwarancja bezpieczenstwa to brak separatora sciezki (/ lub \) w
  // wyniku - sanitize-filename go USUWA (nie zamienia), wiec np. "a/../../b"
  // staje sie literalnym "a....b" (nieszkodliwa, choc dziwna nazwa folderu,
  // bez zadnego znaczenia "wyjdz wyzej" bez sasiadujacego separatora).
  // Sprawdzanie samego wystapienia podciagu ".." byloby zbyt restrykcyjne -
  // taki string jest bezpieczny mimo ze go zawiera.
  assert.ok(!safeSegment('../../../Windows').includes('/'));
  assert.ok(!safeSegment('a/../../b').includes('/'));
  assert.ok(!safeSegment('a\\..\\..\\b').includes('\\'));
  assert.equal(safeSegment('../../../Windows'), 'Windows', 'wiodace kropki sa obcinane calkowicie');
  assert.equal(safeSegment(''), '_');
});

test('buildFolderPlan: zlosliwa nazwa gminy/adresu z Excela nie wyprowadza sciezki poza baze', () => {
  const plan = buildFolderPlan(pompySheet([
    { lpOrId: '../../etc', address: '../../../Windows', gmina: '../evil', pumpType: 'grunt' }
  ], true));
  for (const relativePath of plan) {
    assert.ok(!relativePath.includes('..'), `sciezka "${relativePath}" nie powinna zawierac ".."`);
  }
});

test('distinctGminas: zachowuje kolejnosc pierwszego wystapienia, bez duplikatow', () => {
  const result = distinctGminas([{ gmina: 'B' }, { gmina: 'A' }, { gmina: 'B' }, { gmina: '' }]);
  assert.deepEqual(result, ['B', 'A']);
});

test('buildFolderPlan: deduplikuje identyczne sciezki (np. dwa wiersze z tym samym LP i adresem)', () => {
  const plan = buildFolderPlan(pompySheet([
    { lpOrId: '1', address: 'Ta sama', gmina: '', pumpType: 'grunt' },
    { lpOrId: '1', address: 'Ta sama', gmina: '', pumpType: 'grunt' }
  ]));
  assert.equal(plan.length, new Set(plan).size);
});

// =====================================================================
// DRUGI TRYB ("same foldery z adresow", 2026-08-28)
// =====================================================================

test('readAddressSheets: zbiera adresy z KAZDEGO arkusza z kolumna "Adres", arkusz bez naglowka dostaje headerFound=false', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['PV_ (filtr adresy z zipa)', [['LP', 'Adres', 'UID'], ['1', 'Przycłapy 11', 'X1'], ['2', '', 'X2'], ['3', 'Łaszew Rządowy 98', 'X3']]],
    ['Notatki', [['cos innego, nie tabela adresowa']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sheets = await readAddressSheets(file);
  assert.equal(sheets.length, 2);

  const pv = sheets.find(s => s.sheetName === 'PV_ (filtr adresy z zipa)');
  assert.equal(pv.headerFound, true);
  assert.deepEqual(pv.addresses, ['Przycłapy 11', 'Łaszew Rządowy 98'], 'pusty adres w komórce jest pomijany');

  const notatki = sheets.find(s => s.sheetName === 'Notatki');
  assert.equal(notatki.headerFound, false);
  assert.deepEqual(notatki.addresses, []);
});

test('readAddressSheets: naglowek "adres" jest case-insensitive i moze byc nie w pierwszym wierszu', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Zestawienie', [['Raport gminy Wierzchlas'], ['', '', ''], ['lp', 'ADRES'], ['a', 'Adres A1']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const sheets = await readAddressSheets(file);
  assert.equal(sheets[0].headerFound, true);
  assert.deepEqual(sheets[0].addresses, ['Adres A1']);
});

test('buildSimpleFolderNames: sanityzacja, deduplikacja case-insensitive, kolejnosc zachowana, liczniki', () => {
  const result = buildSimpleFolderNames([
    'Przycłapy 11',
    'przycłapy 11',
    '  Łaszew Rządowy 98  ',
    '',
    '   ',
    '../../Windows',
    'Przycłapy 11'
  ]);
  assert.deepEqual(result.folders, ['Przycłapy 11', 'Łaszew Rządowy 98', 'Windows']);
  assert.equal(result.duplicates, 2, 'duplikat case-insensitive + powtorka');
  assert.equal(result.skippedEmpty, 2);
});

test('buildSimpleFolderNames: pusta lista -> puste foldery, zero bledow', () => {
  const result = buildSimpleFolderNames([]);
  assert.deepEqual(result.folders, []);
  assert.equal(result.duplicates, 0);
  assert.equal(result.skippedEmpty, 0);
});
