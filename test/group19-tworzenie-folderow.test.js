// Testy tworzenie-folderow: czysta logika (excel.js/folderPlan.js), zero
// dostepu do prawdziwego systemu plikow poza zapisem tymczasowych plikow
// .xlsx uzywanych jako fixture (ten sam wzorzec co test/group11-karty-katalogowe.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('../apps/tworzenie-folderow/node_modules/xlsx');
const { readTabelaAdresowa, classifySheetType, normalizeHeader, isAirSourcePump, isGroundSourcePump } = require('../apps/tworzenie-folderow/src/excel.js');
const { buildFolderPlan, safeSegment, distinctGminas } = require('../apps/tworzenie-folderow/src/folderPlan.js');

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

  const result = readTabelaAdresowa(file);
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

test('readTabelaAdresowa: kolumna ID (nie LP) tez jest rozpoznawana jako numer wiersza', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Kotły', [['ID', 'Adres'], ['5', 'Testowa 5']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const result = readTabelaAdresowa(file);
  assert.equal(result.sheets[0].records[0].lpOrId, '5');
});

test('readTabelaAdresowa: obecnosc kolumny Gmina jest sygnalem "wiele gmin" (potwierdzone przez wlasciciela)', async (t) => {
  const { dir, file } = await napiszArkusze([
    ['Kotły', [['LP', 'Adres', 'Gmina'], ['1', 'Testowa 1', 'Żarnów'], ['2', 'Testowa 2', 'Masłowice']]]
  ]);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const result = readTabelaAdresowa(file);
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
