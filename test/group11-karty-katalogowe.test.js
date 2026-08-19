const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// xlsx (SheetJS) nie jest zaleznoscia karty-katalogowe (uzywa tylko read-excel-file
// do ODCZYTU), ale jest juz zaleznoscia drukarka-projekty w tym repo - wykorzystujemy
// jej node_modules do ZAPISU prawdziwego pliku .xlsx na potrzeby testu (ten sam wzorzec
// co test/group3-ocr.test.js requirujacy exceljs z node_modules ocr-audytow).
const XLSX = require('../apps/drukarka-projekty/node_modules/xlsx');
const readXlsxFile = require('../apps/karty-katalogowe/node_modules/read-excel-file/node');
const AdmZip = require('../apps/karty-katalogowe/node_modules/adm-zip');
const {
  app: kkApp,
  przetworzArkusz,
  przetworzArkuszPomp,
  adresPasujeDoFolderu,
  parseIdFolderu,
  rozpoznajArkuszSolarow,
  parseModelPompy,
  rozpoznajArkuszPomp,
  znajdzPlikiPoAdresie,
  sparsujPlikSchematu,
  zbudujIndeksSchematow,
  znajdzSchemat,
  rozpoznajFaze,
  zbierzPlikiPdf,
  dopasujISkopiujDodatek,
  dopasujFolderPoAdresie
} = require('../apps/karty-katalogowe/server');

const HEADER = ['LP gminy', 'Adres', 'UID', 'Rezygnacja'];

// Plik .xlsx zyje w SWOIM WLASNYM katalogu tymczasowym, ODDZIELNYM od "root"
// (folderow projektow/kart). Zlapane realnie na Node 20 (dokladnie wersja
// uzywana w CI): read-excel-file trzyma otwarty uchwyt pliku .xlsx dlugo po
// tym, jak jego Promise sie rozwiazuje - na Windows to blokuje usuniecie
// katalogu (EPERM/ENOTEMPTY) przez wiele sekund. Rozdzielenie katalogow
// oznacza, ze sprzatanie "root" (gdzie faktycznie sprawdzamy wyniki) nigdy
// nie zalezy od tego, czy uchwyt .xlsx zdazyl juz zostac zwolniony.
async function napiszArkusz(sheetName, rows) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-xlsx-'));
  const file = path.join(dir, 'dane.xlsx');
  const ws = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, file);
  return { file, dir };
}

// Sprzatanie katalogu .xlsx jest "best effort" (nie wplywa na wynik testu) -
// w najgorszym razie zostawia kilka bajtow w %TEMP%, co i tak posprzata system.
function usunPozniej(dir) {
  fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

async function przygotujRoot({ foldery, kartyPliki }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-'));
  const kartyDir = path.join(root, 'karty');
  await fsp.mkdir(kartyDir, { recursive: true });
  for (const nazwa of kartyPliki) await fsp.writeFile(path.join(kartyDir, nazwa), 'tresc');

  const projektyDir = path.join(root, 'Projekty', 'Zarnow');
  await fsp.mkdir(projektyDir, { recursive: true });
  for (const nazwa of foldery) await fsp.mkdir(path.join(projektyDir, nazwa), { recursive: true });

  return { root, projektyDir };
}

const WYMAGANE_KARTY = ['Grupa pompowa.pdf', 'Kolektor KSG 21GT.pdf', 'Zasobnik SGW(S)B 250.pdf'];

test('adresPasujeDoFolderu: zgodny adres przechodzi, niezgodny (konflikt numeracji) odrzuca', () => {
  assert.equal(adresPasujeDoFolderu('ul. Spacerowa 5, Zarnow', '41 - Zarnow, ul. Spacerowa'), true);
  assert.equal(adresPasujeDoFolderu('ul. Kwiatowa 3, Kamiensk', '41 - Zarnow, ul. Spacerowa'), false);
  // Audyt rozdz. 16, P0/P1: pusty adres w Excelu juz NIE przepuszcza samego
  // LP - odwrotnosc dawnego zachowania ("nie ma z czym porownac, ufam LP"),
  // ktore pozwalalo skopiowac karty do niewlasciwego klienta.
  assert.equal(adresPasujeDoFolderu('', '41 - Zarnow, ul. Spacerowa'), false);
  assert.equal(adresPasujeDoFolderu('   ', '41 - Zarnow, ul. Spacerowa'), false);
});

test('adresPasujeDoFolderu: przy 2 tokenach sam numer domu nie wystarcza, sama nazwa ulicy - tak (audyt rozdz. 16, P0/P1)', () => {
  // "15" jako jedyne trafienie (numer bez ulicy) - folder to zupelnie inny
  // adres, ktory przypadkiem tez ma "15" gdzies w nazwie.
  assert.equal(adresPasujeDoFolderu('Polna 15', '41 - Zarnow, Kwiatowa 15'), false);
  // Sama nazwa ulicy trafiona (folder nie ma numeru domu w nazwie - typowy
  // realny przypadek) - to musi dalej dzialac, inaczej wiekszosc prawdziwych
  // folderow zaczelaby wymagac recznej kontroli bez powodu.
  assert.equal(adresPasujeDoFolderu('Kwiatowa 15', '41 - Zarnow, ul. Kwiatowa'), true);
  // Oba tokeny trafione - jednoznacznie ok.
  assert.equal(adresPasujeDoFolderu('Kwiatowa 15', '41 - Zarnow, ul. Kwiatowa 15'), true);
});

test('parseIdFolderu: liczba calkowita (w tym zapisana jako X.0) przechodzi, prawdziwy ulamek (X.9) jest bledem (audyt rozdz. 16, P1)', () => {
  assert.equal(parseIdFolderu(78), '78');
  assert.equal(parseIdFolderu('78'), '78');
  assert.equal(parseIdFolderu(78.0), '78');
  assert.equal(parseIdFolderu('78.0'), '78');
  // To jest sedno poprawki: 78.9 NIE moze cicho stac sie "78" (dopasowanie
  // do niewlasciwego folderu).
  assert.equal(parseIdFolderu(78.9), null);
  assert.equal(parseIdFolderu('78.9'), null);
  assert.equal(parseIdFolderu(''), null);
  assert.equal(parseIdFolderu(null), null);
  assert.equal(parseIdFolderu('abc'), null);
});

test('przetworzArkusz: konflikt numeracji miedzy inwestycjami - adres z Excela nie pasuje do znalezionego folderu -> blad, brak kopiowania', async (t) => {
  // Dwie rozne inwestycje maja folder zaczynajacy sie od tego samego numeru "41" -
  // dokladnie scenariusz szkody z audytu zewnetrznego.
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    // Adres w wierszu wskazuje na CALKIEM INNA miejscowosc/ulice niz folder "41 - Zarnow, ul. Spacerowa".
    [41, 'ul. Kwiatowa 3, Kamiensk', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'blad');
  assert.match(wyniki[0].komunikat, /nie zawiera adresu z Excela/);
  assert.match(wyniki[0].komunikat, /konflikt numeracji/);

  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  const skopiowane = await fsp.readdir(folderKlienta);
  assert.deepEqual(skopiowane, []); // nic nie zostalo skopiowane do obcego folderu
});

test('przetworzArkusz: zgodny adres -> normalne kopiowanie, zero regresji', async (t) => {
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    [41, 'ul. Spacerowa 5, Zarnow', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');

  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  const skopiowane = (await fsp.readdir(folderKlienta)).sort();
  assert.deepEqual(skopiowane, [...WYMAGANE_KARTY].sort());
});

test('przetworzArkusz: pusty adres w Excelu blokuje kopiowanie mimo trafionego LP (audyt rozdz. 16, P0/P1)', async (t) => {
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    [41, '', '2/250', ''] // adres pusty - tylko LP wskazuje na folder
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'blad');
  assert.match(wyniki[0].komunikat, /brak adresu/);

  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  assert.deepEqual(await fsp.readdir(folderKlienta), []);
});

test('przetworzArkusz: brak JEDNEJ karty zrodlowej blokuje CALY komplet - zero czesciowego kopiowania (audyt rozdz. 16, P1)', async (t) => {
  // Tylko 2 z 3 wymaganych kart faktycznie istnieja w folderze zrodlowym
  // "karty" - brakuje "Zasobnik SGW(S)B 250.pdf".
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: ['Grupa pompowa.pdf', 'Kolektor KSG 21GT.pdf']
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    [41, 'ul. Spacerowa 5, Zarnow', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'blad');
  assert.match(wyniki[0].komunikat, /brak plikow zrodlowych/);
  assert.match(wyniki[0].komunikat, /Zasobnik SGW\(S\)B 250\.pdf/);

  // Zaden z DWOCH istniejacych zrodel tez nie zostal skopiowany - komplet albo nic.
  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  assert.deepEqual(await fsp.readdir(folderKlienta), []);
});

// =====================================================================
// Audyt 2026-08-18 (real bug, zlapany przez wlasciciela na inwestycji
// Kamiensk): zakladka arkusza nazwana dokladnie "Solary" (bez nazwy gminy)
// pokazywala 0 dopasowan bez zadnego bledu - gminaZNazwyArkusza (teraz
// rozpoznajArkuszSolarow) wymagala "Solary <gmina>". Ta sekcja pokrywa
// zarowno rozpoznawanie nazwy zakladki, jak i pelny przebieg bez warstwy
// gminy w strukturze folderow.
// =====================================================================

test('rozpoznajArkuszSolarow: "Solary" (bez gminy) i "Solary <gmina>" oba rozpoznawane, inne zakladki - nie', () => {
  assert.deepEqual(rozpoznajArkuszSolarow('Solary'), { gmina: '' });
  assert.deepEqual(rozpoznajArkuszSolarow('  solary  '), { gmina: '' }); // wielkosc liter/spacje bez znaczenia
  assert.deepEqual(rozpoznajArkuszSolarow('Solary Zarnow'), { gmina: 'Zarnow' });
  assert.equal(rozpoznajArkuszSolarow('Pompy ciepła'), null);
  assert.equal(rozpoznajArkuszSolarow('Kotły'), null);
  assert.equal(rozpoznajArkuszSolarow('obręby'), null);
});

test('przetworzArkusz: zakladka "Solary" bez nazwy gminy - foldery klientow wprost pod Projekty/, bez posredniej warstwy gminy', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-bare-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const kartyDir = path.join(root, 'karty');
  await fsp.mkdir(kartyDir, { recursive: true });
  for (const nazwa of WYMAGANE_KARTY) await fsp.writeFile(path.join(kartyDir, nazwa), 'tresc');

  // BRAK warstwy gminy - folder klienta wprost pod Projekty/.
  const projektyDir = path.join(root, 'Projekty');
  const folderKlienta = path.join(projektyDir, '41 - Kamiensk, ul. Sucharskiego 8');
  await fsp.mkdir(folderKlienta, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkusz('Solary', [
    [41, 'Kamieńsk, ul. Sucharskiego 8', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');
  const skopiowane = (await fsp.readdir(folderKlienta)).sort();
  assert.deepEqual(skopiowane, [...WYMAGANE_KARTY].sort());
});

test('przetworzArkusz: folder zrodlowy nazwany "wzór" dziala tak samo jak "karty", gdy "karty" nie istnieje', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-wzor-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  // Celowo "wzór", NIE "karty".
  const wzorDir = path.join(root, 'wzór');
  await fsp.mkdir(wzorDir, { recursive: true });
  for (const nazwa of WYMAGANE_KARTY) await fsp.writeFile(path.join(wzorDir, nazwa), 'tresc');

  const projektyDir = path.join(root, 'Projekty', 'Zarnow');
  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  await fsp.mkdir(folderKlienta, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    [41, 'ul. Spacerowa 5, Zarnow', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');
  const skopiowane = (await fsp.readdir(folderKlienta)).sort();
  assert.deepEqual(skopiowane, [...WYMAGANE_KARTY].sort());
});

// =====================================================================
// Audyt 2026-08-19 (real bug, Kamiensk): realny arkusz "Solary" ma kolumne
// identyfikujaca zestaw nazwana "Rodzaj zestawu", nie "UID" - findColumn(['uid'])
// nigdy tego nie znajdowal, wiec caly arkusz konczyl sie "nie znaleziono kolumn: UID."
// =====================================================================

test('przetworzArkusz: kolumna "Rodzaj zestawu" (zamiast "UID") jest rozpoznawana jako identyfikator zestawu', async (t) => {
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-xlsx-rodzaj-'));
  const file = path.join(dir, 'dane.xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['LP gminy', 'Adres', 'Rodzaj zestawu', 'Rezygnacja'],
    [41, 'ul. Spacerowa 5, Zarnow', '2/250', '']
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Solary Zarnow');
  XLSX.writeFile(wb, file);
  t.after(() => usunPozniej(dir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');
  assert.equal(wyniki[0].uid, '2/250');

  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  const skopiowane = (await fsp.readdir(folderKlienta)).sort();
  assert.deepEqual(skopiowane, [...WYMAGANE_KARTY].sort());
});

// =====================================================================
// Karty katalogowe dla pomp powietrznych Varmero (nowa funkcja, 2026-08-18) -
// arkusz "Pompy ciepła", kolumna "Model pompy" (VPM<cyfry> - inne wartosci
// jak "Basic 270l"/CWU albo puste komorki sa pomijane cicho), zrodlo
// PC powietrzne/wzór/<MODEL albo INWESTYCJA_MODEL>/Karty katalogowe.pdf.
// =====================================================================

const HEADER_POMPY = ['LP gminy', 'Adres', 'Model pompy'];

async function napiszArkuszPomp(sheetName, rows) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-xlsx-pomp-'));
  const file = path.join(dir, 'dane.xlsx');
  const ws = XLSX.utils.aoa_to_sheet([HEADER_POMPY, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, file);
  return { file, dir };
}

test('parseModelPompy: rozpoznaje VPM<cyfry> (dowolna wielkosc liter), odrzuca inne modele i puste wartosci', () => {
  assert.equal(parseModelPompy('VPM9012'), 'VPM9012');
  assert.equal(parseModelPompy('vpm9008'), 'VPM9008');
  assert.equal(parseModelPompy('  VPM9020  '), 'VPM9020');
  assert.equal(parseModelPompy('Basic 270l'), null); // pompa CWU, nie powietrzna Varmero
  assert.equal(parseModelPompy(''), null);
  assert.equal(parseModelPompy(null), null);
});

test('rozpoznajArkuszPomp: dopasowuje po rdzeniu "pomp" (wielkosc liter bez znaczenia), inne zakladki - nie', () => {
  assert.equal(rozpoznajArkuszPomp('Pompy ciepła'), true);
  assert.equal(rozpoznajArkuszPomp('POMPY'), true);
  assert.equal(rozpoznajArkuszPomp('Solary'), false);
  assert.equal(rozpoznajArkuszPomp('Kotły'), false);
});

test('przetworzArkuszPomp: dopasowanie po samej nazwie modelu (podfolder "VPM9012")', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-pomp-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const folderModelu = path.join(root, 'PC powietrzne', 'wzór', 'VPM9012');
  await fsp.mkdir(folderModelu, { recursive: true });
  await fsp.writeFile(path.join(folderModelu, 'Karty katalogowe.pdf'), 'tresc');

  const projektyDir = path.join(root, 'PC powietrzne', 'Projekty');
  const folderKlienta = path.join(projektyDir, '17.Wieruszew 3');
  await fsp.mkdir(folderKlienta, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkuszPomp('Pompy ciepła', [
    [17, 'Wieruszew 3', 'VPM9012']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkuszPomp({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');
  assert.equal(wyniki[0].model, 'VPM9012');
  assert.deepEqual(await fsp.readdir(folderKlienta), ['Karty katalogowe.pdf']);
});

test('przetworzArkuszPomp: dopasowanie po sufiksie nazwy podfolderu ("ZAGOROW_VPM9008")', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-pomp-sufiks-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const folderModelu = path.join(root, 'PC powietrzne', 'wzór', 'ZAGOROW_VPM9008');
  await fsp.mkdir(folderModelu, { recursive: true });
  await fsp.writeFile(path.join(folderModelu, 'Karty katalogowe.pdf'), 'tresc');

  const projektyDir = path.join(root, 'PC powietrzne', 'Projekty');
  const folderKlienta = path.join(projektyDir, '18.Daninów 6');
  await fsp.mkdir(folderKlienta, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkuszPomp('Pompy ciepła', [
    [18, 'Daninów 6', 'VPM9008']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkuszPomp({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');
  assert.deepEqual(await fsp.readdir(folderKlienta), ['Karty katalogowe.pdf']);
});

test('przetworzArkuszPomp: wiersze bez pompy powietrznej Varmero (CWU/"Basic", puste) sa pomijane cicho - zero wynikow, zero bledow', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-pomp-brak-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  // Folder wzorow/projektow musi istniec (inaczej dostalibysmy inny, wczesniejszy
  // blad "nie znaleziono folderu ze wzorami") - test sprawdza, ze wiersze BEZ
  // pompy Varmero (rozpoznanej po "Model pompy") nigdy nie docieraja do zadnego
  // dopasowania, nie ze caly arkusz jest niepoprawny.
  await fsp.mkdir(path.join(root, 'PC powietrzne', 'wzór'), { recursive: true });
  await fsp.mkdir(path.join(root, 'PC powietrzne', 'Projekty'), { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkuszPomp('Pompy ciepła', [
    [1, 'Adres 1', 'Basic 270l'],
    [2, 'Adres 2', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkuszPomp({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.deepEqual(wyniki, []);
});

test('przetworzArkuszPomp: arkusz "Solary" jest ignorowany (nie dotyczy pomp)', async (t) => {
  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    [41, 'ul. Spacerowa 5, Zarnow', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkuszPomp({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: os.tmpdir(), dryRun: false });

  assert.deepEqual(wyniki, []);
});

// =====================================================================
// Audyt 2026-08-19 (realny test na inwestycji Kamiensk, wlasciciel):
// 1) Solary - karty NIE leza plasko w jednym folderze, tylko w podfolderach
//    per rozmiar zestawu ("2.300", "3.400"), a pliki w srodku sa recznie
//    numerowane ("1. ...", "2. ...", "3. ...") z TRESCIA po numerze rozna
//    nawet miedzy rozmiarami tej samej inwestycji.
// 2) Pompy - sciezka wzoru bywa "PC\wzór" zamiast "PC powietrzne\wzór"
//    (caly folder "PC" obejmuje wtedy wszystkie pompy, nie tylko powietrzne).
// 3) Pompy - ten sam model VPM moze miec kilka wariantow folderu wzoru z
//    dodatkowym zrodlem ciepla ("VARMERO VPM 9008 + Kocioł gazowy" itp.) -
//    narzedzie NIE MOZE zgadywac, ktory wybrac.
// =====================================================================

test('przetworzArkusz: podfolder rozmiaru z numerowanymi plikami (nowsza konwencja, Kamiensk) - rozna tresc nazwy pliku "2." miedzy rozmiarami dalej dziala', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-solary-podfoldery-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const wzorDir = path.join(root, 'wzór');
  const folder300 = path.join(wzorDir, '2.300');
  const folder400 = path.join(wzorDir, '3.400');
  await fsp.mkdir(folder300, { recursive: true });
  await fsp.mkdir(folder400, { recursive: true });
  await fsp.writeFile(path.join(folder300, '1. Karta katalogowa kolektora słonecznego.pdf'), 'x');
  await fsp.writeFile(path.join(folder300, '2. Zasobnik A klasa 300.pdf'), 'x');
  await fsp.writeFile(path.join(folder300, '3. Grupa pompowa.pdf'), 'x');
  // Pliki, ktore NIE sa numerowanymi kartami - nie moga zostac skopiowane.
  await fsp.writeFile(path.join(folder300, 'Opis techniczny 2.300.pdf'), 'x');
  await fsp.writeFile(path.join(folder300, 'Symulacja_Kamieńsk_2_300.pdf'), 'x');
  // "2." w 400 ma INNA kolejnosc slow niz w 300 - to jest sedno testu.
  await fsp.writeFile(path.join(folder400, '1. Karta katalogowa kolektora słonecznego.pdf'), 'x');
  await fsp.writeFile(path.join(folder400, '2. Zasobnik 400 A klasa.pdf'), 'x');
  await fsp.writeFile(path.join(folder400, '3. Grupa pompowa.pdf'), 'x');

  const projektyDir = path.join(root, 'Projekty');
  const folderKlienta300 = path.join(projektyDir, '2 - Kamiensk, ul. Pierwsza');
  const folderKlienta400 = path.join(projektyDir, '3 - Kamiensk, ul. Druga');
  await fsp.mkdir(folderKlienta300, { recursive: true });
  await fsp.mkdir(folderKlienta400, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkusz('Solary', [
    [2, 'Kamiensk, ul. Pierwsza', '2/300', ''],
    [3, 'Kamiensk, ul. Druga', '3/400', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 2);
  assert.ok(wyniki.every((w) => w.status === 'skopiowano'), JSON.stringify(wyniki));

  const skopiowane300 = (await fsp.readdir(folderKlienta300)).sort();
  assert.deepEqual(skopiowane300, [
    '1. Karta katalogowa kolektora słonecznego.pdf',
    '2. Zasobnik A klasa 300.pdf',
    '3. Grupa pompowa.pdf'
  ].sort(), 'tylko 3 numerowane karty, bez opisu technicznego/symulacji');

  const skopiowane400 = (await fsp.readdir(folderKlienta400)).sort();
  assert.deepEqual(skopiowane400, [
    '1. Karta katalogowa kolektora słonecznego.pdf',
    '2. Zasobnik 400 A klasa.pdf',
    '3. Grupa pompowa.pdf'
  ].sort(), 'rozna tresc nazwy "2." dla innego rozmiaru - dopasowanie po numerze, nie po tresci');
});

test('przetworzArkusz: bez podfolderu rozmiaru dalej dziala stara, plaska konwencja (zero regresji dla juz zweryfikowanych inwestycji)', async (t) => {
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    [41, 'ul. Spacerowa 5, Zarnow', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');
  const skopiowane = (await fsp.readdir(path.join(projektyDir, '41 - Zarnow, ul. Spacerowa'))).sort();
  assert.deepEqual(skopiowane, [...WYMAGANE_KARTY].sort());
});

test('przetworzArkuszPomp: "PC powietrzne" nie istnieje - spada na "PC\\wzór" (Kamiensk: caly folder PC obejmuje wszystkie pompy)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-pomp-pc-fallback-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const folderModelu = path.join(root, 'PC', 'wzór', 'VARMERO VPM 9008');
  await fsp.mkdir(folderModelu, { recursive: true });
  await fsp.writeFile(path.join(folderModelu, 'Karty katalogowe.pdf'), 'x');

  const projektyDir = path.join(root, 'PC', 'Projekty');
  const folderKlienta = path.join(projektyDir, '17.Wieruszew 3');
  await fsp.mkdir(folderKlienta, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkuszPomp('Pompy ciepła', [
    [17, 'Wieruszew 3', 'VPM9008']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkuszPomp({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano', JSON.stringify(wyniki));
  assert.deepEqual(await fsp.readdir(folderKlienta), ['Karty katalogowe.pdf']);
});

test('przetworzArkuszPomp: "VARMERO VPM 9008" (ze spacja) rozpoznawane - dawne dopasowanie po tekscie nigdy by nie trafilo', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-pomp-spacja-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const folderModelu = path.join(root, 'PC powietrzne', 'wzór', 'VARMERO VPM 9012');
  await fsp.mkdir(folderModelu, { recursive: true });
  await fsp.writeFile(path.join(folderModelu, 'Karty katalogowe.pdf'), 'x');

  const projektyDir = path.join(root, 'PC powietrzne', 'Projekty');
  const folderKlienta = path.join(projektyDir, '5.Testowo 1');
  await fsp.mkdir(folderKlienta, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkuszPomp('Pompy ciepła', [
    [5, 'Testowo 1', 'VPM9012']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkuszPomp({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano', JSON.stringify(wyniki));
});

test('przetworzArkuszPomp: model z kilkoma wariantami folderu wzoru (np. + Kocioł gazowy/stałopalny) - blad zamiast zgadywania', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-pomp-warianty-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const wzorDir = path.join(root, 'PC powietrzne', 'wzór');
  for (const nazwa of [
    'VARMERO VPM 9008',
    'VARMERO VPM 9008 + Kocioł gazowy',
    'VARMERO VPM 9008 + Kocioł stałopalny (UO)',
    'VARMERO VPM 9008 + Kocioł stałopalny (UZ)'
  ]) {
    const folder = path.join(wzorDir, nazwa);
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, 'Karty katalogowe.pdf'), 'x');
  }

  const projektyDir = path.join(root, 'PC powietrzne', 'Projekty');
  const folderKlienta = path.join(projektyDir, '9.Wielowariantowo 2');
  await fsp.mkdir(folderKlienta, { recursive: true });

  const { file, dir: xlsxDir } = await napiszArkuszPomp('Pompy ciepła', [
    [9, 'Wielowariantowo 2', 'VPM9008']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkuszPomp({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'blad');
  assert.match(wyniki[0].komunikat, /kilka pasujących wariantów/);
  assert.deepEqual(await fsp.readdir(folderKlienta), [], 'nic nie moglo zostac skopiowane przy niejednoznacznym dopasowaniu');
});

// =====================================================================
// Audyty PV / dokumenty seryjne (dopasowanie po adresie) i schematy
// (dopasowanie po mocy) - dolaczane do folderu klienta OBOK kart
// katalogowych, 2026-08-19. Nazwy plikow w testach wzorowane 1:1 na
// prawdziwych zipach dostarczonych przez wlasciciela (PV-....zip,
// SCHEMAT-....zip) - patrz komentarze przy funkcjach w server.js.
// =====================================================================

test('sparsujPlikSchematu: "liczba,liczba [1F|3F].pdf" (bez rozszerzenia) rozpoznawane, cokolwiek innego (np. log narzedzia) - null', () => {
  assert.deepEqual(sparsujPlikSchematu('2,85 3F'), { moc: 2.85, faza: '3F' });
  assert.deepEqual(sparsujPlikSchematu('2,85 1F'), { moc: 2.85, faza: '1F' });
  assert.deepEqual(sparsujPlikSchematu('11,875'), { moc: 11.875, faza: null });
  assert.deepEqual(sparsujPlikSchematu('3,8'), { moc: 3.8, faza: null });
  assert.equal(sparsujPlikSchematu('plot'), null, 'plot.log (bez rozszerzenia .pdf, bo wchodzi juz bez niej) nie jest schematem');
  assert.equal(sparsujPlikSchematu('rozne rzeczy'), null);
});

test('rozpoznajFaze: "Trójfazowe"/"Jednofazowe" (prawdziwa wartosc z kolumny) rozpoznawane, nieznana wartosc - null (nie zgadujemy)', () => {
  assert.equal(rozpoznajFaze('Trójfazowe'), '3F');
  assert.equal(rozpoznajFaze('Jednofazowe'), '1F');
  assert.equal(rozpoznajFaze(''), null);
  assert.equal(rozpoznajFaze(null), null);
  assert.equal(rozpoznajFaze('cos innego'), null);
});

test('znajdzSchemat: dopasowanie po mocy z tolerancja, ujednoznacznienie przez faze gdy trzeba, niejednoznaczne gdy faza nieznana', () => {
  const indeks = zbudujIndeksSchematow([
    { nazwa: '2,85 1F.pdf', sciezka: 'a', nazwaBezRozszerzenia: '2,85 1F' },
    { nazwa: '2,85 3F.pdf', sciezka: 'b', nazwaBezRozszerzenia: '2,85 3F' },
    { nazwa: '3,8.pdf', sciezka: 'c', nazwaBezRozszerzenia: '3,8' },
    { nazwa: 'plot.pdf', sciezka: 'd', nazwaBezRozszerzenia: 'plot' } // niepasujacy wzorzec - pominiety przez zbudujIndeksSchematow
  ]);
  assert.equal(indeks.length, 3, 'plot.pdf nie jest schematem, nie wchodzi do indeksu');

  // Jedna, jednoznaczna moc - faza bez znaczenia.
  assert.deepEqual(znajdzSchemat(3.8, null, indeks).map(s => s.nazwa), ['3,8.pdf']);
  // Dwa warianty tej samej mocy - faza z Excela rozstrzyga.
  assert.deepEqual(znajdzSchemat(2.85, '3F', indeks).map(s => s.nazwa), ['2,85 3F.pdf']);
  assert.deepEqual(znajdzSchemat(2.85, '1F', indeks).map(s => s.nazwa), ['2,85 1F.pdf']);
  // Faza nieznana - niejednoznaczne (oba warianty), nigdy nie zgadujemy.
  assert.equal(znajdzSchemat(2.85, null, indeks).length, 2);
  // Brak dopasowania mocy.
  assert.equal(znajdzSchemat(99, null, indeks).length, 0);
  // Tolerancja na szum zmiennoprzecinkowy (0.1 + 0.2 !== 0.3 w JS).
  assert.deepEqual(znajdzSchemat(0.1 + 0.2, null, zbudujIndeksSchematow([{ nazwa: '0,3.pdf', sciezka: 'x', nazwaBezRozszerzenia: '0,3' }])).map(s => s.nazwa), ['0,3.pdf']);
});

test('znajdzPlikiPoAdresie: nazwa pliku audytu/dokumentu seryjnego zawierajaca adres (z "ul.", inna kolejnosc) dalej pasuje do adresu z Excela (bez "ul.")', () => {
  const pliki = [
    { nazwa: 'Wierzchlas, ul. Częstochowska 26_PV.pdf', sciezka: 'a', nazwaBezRozszerzenia: 'Wierzchlas, ul. Częstochowska 26_PV' },
    { nazwa: 'Przycłapy, 11_PV.pdf', sciezka: 'b', nazwaBezRozszerzenia: 'Przycłapy, 11_PV' },
    { nazwa: 'Krzeczów, ul. Wschodnia 8_PV.pdf', sciezka: 'c', nazwaBezRozszerzenia: 'Krzeczów, ul. Wschodnia 8_PV' }
  ];
  // Prawdziwa wartosc kolumny "Adres" (bez "ul.", patrz real dane Wierzchlas).
  assert.deepEqual(znajdzPlikiPoAdresie('Wierzchlas, Częstochowska 26', pliki).map(p => p.nazwa), ['Wierzchlas, ul. Częstochowska 26_PV.pdf']);
  assert.deepEqual(znajdzPlikiPoAdresie('Przycłapy 11', pliki).map(p => p.nazwa), ['Przycłapy, 11_PV.pdf']);
  assert.equal(znajdzPlikiPoAdresie('Zupelnie inny adres 99', pliki).length, 0);
});

test('zbierzPlikiPdf: rekurencyjnie zbiera .pdf (dowolna glebokosc), ignoruje inne rozszerzenia (np. plot.log)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-pdf-scan-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'a.pdf'), 'x');
  await fsp.writeFile(path.join(dir, 'plot.log'), 'x');
  const nested = path.join(dir, 'PV');
  await fsp.mkdir(nested);
  await fsp.writeFile(path.join(nested, 'b.pdf'), 'x');

  const pliki = await zbierzPlikiPdf(dir);
  assert.deepEqual(pliki.map(p => p.nazwa).sort(), ['a.pdf', 'b.pdf']);
  assert.ok(pliki.every(p => p.nazwaBezRozszerzenia === p.nazwa.slice(0, -4)));
});

test('dopasujISkopiujDodatek: brak/niejednoznaczne/juz-jest/podglad/kopiowanie', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-dodatek-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const zrodloDir = path.join(dir, 'zrodlo');
  const folderKlienta = path.join(dir, 'klient');
  await fsp.mkdir(zrodloDir, { recursive: true });
  await fsp.mkdir(folderKlienta, { recursive: true });
  const plikZrodlowy = path.join(zrodloDir, 'audyt.pdf');
  await fsp.writeFile(plikZrodlowy, 'tresc-audytu');

  assert.deepEqual(await dopasujISkopiujDodatek({ trafienia: [], folderKlienta, istniejace: new Set(), dryRun: false }), { status: 'brak' });

  const wieloznaczne = await dopasujISkopiujDodatek({
    trafienia: [{ nazwa: 'a.pdf' }, { nazwa: 'b.pdf' }],
    folderKlienta, istniejace: new Set(), dryRun: false
  });
  assert.equal(wieloznaczne.status, 'wieloznaczne');
  assert.deepEqual(wieloznaczne.kandydaci, ['a.pdf', 'b.pdf']);

  const trafienie = { nazwa: 'audyt.pdf', sciezka: plikZrodlowy };
  const podglad = await dopasujISkopiujDodatek({ trafienia: [trafienie], folderKlienta, istniejace: new Set(), dryRun: true });
  assert.deepEqual(podglad, { status: 'do-skopiowania', plik: 'audyt.pdf' });
  assert.deepEqual(await fsp.readdir(folderKlienta), [], 'dryRun nigdy nie kopiuje');

  const skopiowano = await dopasujISkopiujDodatek({ trafienia: [trafienie], folderKlienta, istniejace: new Set(), dryRun: false });
  assert.deepEqual(skopiowano, { status: 'skopiowano', plik: 'audyt.pdf' });
  assert.equal(await fsp.readFile(path.join(folderKlienta, 'audyt.pdf'), 'utf8'), 'tresc-audytu');

  const jużJest = await dopasujISkopiujDodatek({ trafienia: [trafienie], folderKlienta, istniejace: new Set(['audyt.pdf']), dryRun: false });
  assert.deepEqual(jużJest, { status: 'pominieto-juz-sa', plik: 'audyt.pdf' });
});

const HEADER_PV = ['LP gminy', 'Adres', 'UID', 'Rezygnacja', 'Moc zestawu uwzględniająca moc modułów (biuro)', 'Instalacja 3 fazowa'];
async function napiszArkuszPV(sheetName, rows) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-xlsx-pv-'));
  const file = path.join(dir, 'dane.xlsx');
  const ws = XLSX.utils.aoa_to_sheet([HEADER_PV, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, file);
  return { file, dir };
}

test('przetworzArkusz: audyt/dokument seryjny/schemat sa dolaczane NIEZALEZNIE od siebie i od kart - brak jednego nie blokuje reszty (decyzja wlasciciela 2026-08-19)', async (t) => {
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Wierzchlas, Częstochowska 26', '42 - Wierzchlas, Krótka 3'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const audytyPliki = await zbierzPlikiPdf(await (async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-audyty-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.writeFile(path.join(dir, 'Wierzchlas, ul. Częstochowska 26_PV.pdf'), 'audyt-1');
    // Zadnego pliku dla adresu "Krótka 3" - musi dac ostrzezenie 'brak', nie blad.
    return dir;
  })());

  const schematyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-schematy-'));
  t.after(() => fsp.rm(schematyDir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(schematyDir, '2,85.pdf'), 'schemat-2,85');
  const schematyIndeks = zbudujIndeksSchematow(await zbierzPlikiPdf(schematyDir));

  const { file, dir: xlsxDir } = await napiszArkuszPV('Solary Zarnow', [
    [41, 'Wierzchlas, Częstochowska 26', '2/250', '', 2.85, 'Trójfazowe'],
    [42, 'Wierzchlas, Krótka 3', '2/250', '', 4.75, 'Trójfazowe'] // 4,75 nie istnieje w schematyDir -> 'brak'
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({
    sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false,
    audytyPliki, dokumentySeryjnePliki: null, schematyIndeks
  });

  assert.equal(wyniki.length, 2);
  const [w1, w2] = wyniki;

  // Wiersz 1: karty + audyt + schemat wszystkie sie udaly.
  assert.equal(w1.status, 'skopiowano');
  assert.deepEqual(w1.audyt, { status: 'skopiowano', plik: 'Wierzchlas, ul. Częstochowska 26_PV.pdf' });
  assert.equal(w1.dokumentSeryjny, undefined, 'zrodlo nie podane (null) - pole w ogole nie istnieje w wyniku');
  assert.deepEqual(w1.schemat, { status: 'skopiowano', plik: '2,85.pdf' });
  assert.ok(fs.existsSync(path.join(projektyDir, '41 - Wierzchlas, Częstochowska 26', 'Wierzchlas, ul. Częstochowska 26_PV.pdf')));
  assert.ok(fs.existsSync(path.join(projektyDir, '41 - Wierzchlas, Częstochowska 26', '2,85.pdf')));

  // Wiersz 2: karty nadal sie kopiuja mimo braku audytu i schematu dla tego adresu.
  assert.equal(w2.status, 'skopiowano', 'brak audytu/schematu NIE blokuje kart (decyzja wlasciciela)');
  assert.deepEqual(w2.audyt, { status: 'brak' });
  assert.deepEqual(w2.schemat, { status: 'brak' });
});

test('przetworzArkusz: schemat z dwoma wariantami fazowymi bez znanej fazy w Excelu -> "wieloznaczne", nigdy nie zgaduje', async (t) => {
  const { root } = await przygotujRoot({
    foldery: ['41 - Wierzchlas, Częstochowska 26'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const schematyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-schematy-faza-'));
  t.after(() => fsp.rm(schematyDir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(schematyDir, '2,85 1F.pdf'), 'x');
  await fsp.writeFile(path.join(schematyDir, '2,85 3F.pdf'), 'x');
  const schematyIndeks = zbudujIndeksSchematow(await zbierzPlikiPdf(schematyDir));

  // Arkusz BEZ kolumny fazy w ogole (falszywa nazwa naglowka, kolumna nie zostanie znaleziona).
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-xlsx-nofaza-'));
  const file = path.join(dir, 'dane.xlsx');
  const header = ['LP gminy', 'Adres', 'UID', 'Rezygnacja', 'Moc zestawu uwzględniająca moc modułów (biuro)'];
  const ws = XLSX.utils.aoa_to_sheet([header, [41, 'Wierzchlas, Częstochowska 26', '2/250', '', 2.85]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Solary Zarnow');
  XLSX.writeFile(wb, file);
  t.after(() => usunPozniej(dir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({
    sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false,
    audytyPliki: null, dokumentySeryjnePliki: null, schematyIndeks
  });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano', 'karty sie kopiuja mimo niejednoznacznego schematu');
  assert.equal(wyniki[0].schemat.status, 'wieloznaczne');
  assert.deepEqual(wyniki[0].schemat.kandydaci.sort(), ['2,85 1F.pdf', '2,85 3F.pdf']);
});

test('POST /api/run: zip z audytami/schematami/dokumentami seryjnymi (wgrane pliki, nie sciezki) - rozpakowywane i dolaczane do wyniku, bez "too many files" (audyt 2026-08-19: files:3 w multerze zostal w tyle, gdy dolozono dokumentySeryjneZip jako 4. pole)', async (t) => {
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Wierzchlas, Częstochowska 26'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-http-zip-'));
  t.after(() => fsp.rm(workDir, { recursive: true, force: true }));

  const audytyZip = new AdmZip();
  audytyZip.addFile('PV/Wierzchlas, ul. Częstochowska 26_PV.pdf', Buffer.from('audyt-tresc'));
  const audytyZipPath = path.join(workDir, 'audyty.zip');
  audytyZip.writeZip(audytyZipPath);

  const schematyZip = new AdmZip();
  schematyZip.addFile('SCHEMAT/2,85.pdf', Buffer.from('schemat-tresc'));
  schematyZip.addFile('SCHEMAT/plot.log', Buffer.from('log'));
  const schematyZipPath = path.join(workDir, 'schematy.zip');
  schematyZip.writeZip(schematyZipPath);

  const dokumentySeryjneZip = new AdmZip();
  dokumentySeryjneZip.addFile('DS/Wierzchlas, ul. Częstochowska 26_DS.pdf', Buffer.from('dokument-seryjny-tresc'));
  const dokumentySeryjneZipPath = path.join(workDir, 'dokumenty-seryjne.zip');
  dokumentySeryjneZip.writeZip(dokumentySeryjneZipPath);

  const { file: excelFile, dir: xlsxDir } = await napiszArkuszPV('Solary Zarnow', [
    [41, 'Wierzchlas, Częstochowska 26', '2/250', '', 2.85, 'Trójfazowe']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const server = kkApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const form = new FormData();
  form.append('excel', new Blob([await fsp.readFile(excelFile)]), 'dane.xlsx');
  form.append('audytyZip', new Blob([await fsp.readFile(audytyZipPath)]), 'audyty.zip');
  form.append('schematyZip', new Blob([await fsp.readFile(schematyZipPath)]), 'schematy.zip');
  form.append('dokumentySeryjneZip', new Blob([await fsp.readFile(dokumentySeryjneZipPath)]), 'dokumenty-seryjne.zip');
  form.append('rootPath', root);
  form.append('typ', 'solary');
  form.append('dryRun', 'false');

  const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.wyniki.length, 1);
  assert.equal(data.wyniki[0].status, 'skopiowano');
  assert.deepEqual(data.wyniki[0].audyt, { status: 'skopiowano', plik: 'Wierzchlas, ul. Częstochowska 26_PV.pdf' });
  assert.deepEqual(data.wyniki[0].schemat, { status: 'skopiowano', plik: '2,85.pdf' });
  assert.deepEqual(data.wyniki[0].dokumentSeryjny, { status: 'skopiowano', plik: 'Wierzchlas, ul. Częstochowska 26_DS.pdf' });

  const folderKlienta = path.join(projektyDir, '41 - Wierzchlas, Częstochowska 26');
  assert.equal(await fsp.readFile(path.join(folderKlienta, 'Wierzchlas, ul. Częstochowska 26_PV.pdf'), 'utf8'), 'audyt-tresc');
  assert.equal(await fsp.readFile(path.join(folderKlienta, '2,85.pdf'), 'utf8'), 'schemat-tresc');
  assert.equal(await fsp.readFile(path.join(folderKlienta, 'Wierzchlas, ul. Częstochowska 26_DS.pdf'), 'utf8'), 'dokument-seryjny-tresc');
});

test('POST /api/run: typ="audyty" jest osobnym trybem (jak Solary/Pompy) - dziala BEZ folderu "karty" (0 kart kopiowanych), status wiersza to wprost status audytu (audyt 2026-08-19: wlasciciel chcial osobnej opcji per dodatek, nie wspolnego formularza z 3 zipami)', async (t) => {
  // Root CELOWO bez folderu "karty" - dowod, ze tryb "tylko audyty" nie
  // wymaga w ogole zrodla kart katalogowych.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-audyty-only-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const projektyDir = path.join(root, 'Projekty', 'Zarnow');
  await fsp.mkdir(path.join(projektyDir, '41 - Wierzchlas, Częstochowska 26'), { recursive: true });

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-http-audyty-only-'));
  t.after(() => fsp.rm(workDir, { recursive: true, force: true }));
  const audytyZip = new AdmZip();
  audytyZip.addFile('PV/Wierzchlas, ul. Częstochowska 26_PV.pdf', Buffer.from('audyt-tresc'));
  const audytyZipPath = path.join(workDir, 'audyty.zip');
  audytyZip.writeZip(audytyZipPath);

  const { file: excelFile, dir: xlsxDir } = await napiszArkuszPV('Solary Zarnow', [
    // UID celowo nierozpoznawalny jako rozmiar zasobnika ("brak" zamiast
    // 250/300/400) - w trybie "tylko audyty" to NIE moze blokowac wiersza,
    // bo rozmiar zasobnika dotyczy wylacznie kart katalogowych.
    [41, 'Wierzchlas, Częstochowska 26', 'brak', '', 2.85, 'Trójfazowe']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const server = kkApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const form = new FormData();
  form.append('excel', new Blob([await fsp.readFile(excelFile)]), 'dane.xlsx');
  form.append('audytyZip', new Blob([await fsp.readFile(audytyZipPath)]), 'audyty.zip');
  form.append('rootPath', root);
  form.append('typ', 'audyty');
  form.append('dryRun', 'false');

  const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.wyniki.length, 1);
  assert.equal(data.wyniki[0].status, 'skopiowano', 'status wiersza pochodzi wprost od dodatku, nie od (nieuzywanych tu) kart');
  assert.deepEqual(data.wyniki[0].audyt, { status: 'skopiowano', plik: 'Wierzchlas, ul. Częstochowska 26_PV.pdf' });

  const folderKlienta = path.join(projektyDir, '41 - Wierzchlas, Częstochowska 26');
  assert.equal(await fsp.readFile(path.join(folderKlienta, 'Wierzchlas, ul. Częstochowska 26_PV.pdf'), 'utf8'), 'audyt-tresc');
  // Zero innych plikow w folderze klienta - zadna karta katalogowa nie zostala skopiowana.
  const wszystkiePliki = await fsp.readdir(folderKlienta);
  assert.deepEqual(wszystkiePliki, ['Wierzchlas, ul. Częstochowska 26_PV.pdf']);
});

test('POST /api/run: typ="audyty" bez podania zrodla (ani zip, ani sciezka) zwraca czytelny blad zamiast cichego 0 wynikow', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-audyty-brak-zrodla-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await fsp.mkdir(path.join(root, 'Projekty', 'Zarnow'), { recursive: true });

  const { file: excelFile, dir: xlsxDir } = await napiszArkuszPV('Solary Zarnow', [
    [41, 'Wierzchlas, Częstochowska 26', '2/250', '', 2.85, 'Trójfazowe']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const server = kkApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const form = new FormData();
  form.append('excel', new Blob([await fsp.readFile(excelFile)]), 'dane.xlsx');
  form.append('rootPath', root);
  form.append('typ', 'audyty');
  form.append('dryRun', 'false');

  const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.match(data.message, /audyty/);
});

test('POST /api/sheets: zwraca liste nazw arkuszy z wgranego pliku, bez zadnego przetwarzania', async (t) => {
  const { file: excelFile, dir: xlsxDir } = await napiszArkuszPV('PV_', [
    [41, 'Wierzchlas, Częstochowska 26', '2/250', '', 2.85, 'Trójfazowe']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const server = kkApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const form = new FormData();
  form.append('excel', new Blob([await fsp.readFile(excelFile)]), 'dane.xlsx');
  const res = await fetch(`${base}/api/sheets`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.deepEqual(data.sheets, ['PV_']);
});

test('POST /api/run: sheetName jawnie wybrany dziala dla arkusza nazwanego "PV_" (realny przypadek Wierzchlas - automatyczne rozpoznawanie po nazwie "Solary" nigdy by go nie zlapalo)', async (t) => {
  // Budowane recznie (nie przygotujRoot, ktore zawsze wklada gmine "Zarnow"
  // miedzy Projekty a foldery klientow) - sheetName "PV_" wymusza plaska
  // konwencje (gmina: '', patrz przetworzArkusz#wymuszony), wiec foldery
  // klientow leza WPROST pod Projekty/, bez posredniej warstwy gminy.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-pv-podkreslnik-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const kartyDir = path.join(root, 'karty');
  await fsp.mkdir(kartyDir, { recursive: true });
  for (const nazwa of WYMAGANE_KARTY) await fsp.writeFile(path.join(kartyDir, nazwa), 'tresc');
  const projektyDir = path.join(root, 'Projekty');
  await fsp.mkdir(path.join(projektyDir, '41 - Wierzchlas, Częstochowska 26'), { recursive: true });

  // Arkusz celowo nazwany "PV_" (nie "Solary"/"Solary <gmina>") - bez
  // jawnego sheetName rozpoznajArkuszSolarow('PV_') zwrocilby null i cala
  // tabela zostalaby cicho pominieta (0 wynikow).
  const { file: excelFile, dir: xlsxDir } = await napiszArkuszPV('PV_', [
    [41, 'Wierzchlas, Częstochowska 26', '2/250', '', 2.85, 'Trójfazowe']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const server = kkApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const form = new FormData();
  form.append('excel', new Blob([await fsp.readFile(excelFile)]), 'dane.xlsx');
  form.append('sheetName', 'PV_');
  form.append('rootPath', root);
  form.append('typ', 'solary');
  form.append('dryRun', 'false');

  const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.wyniki.length, 1);
  assert.equal(data.wyniki[0].status, 'skopiowano');
  assert.equal(data.wyniki[0].gmina, '', 'arkusz spoza konwencji nazewnictwa -> plaska konwencja (bez gminy)');

  const folderKlienta = path.join(projektyDir, '41 - Wierzchlas, Częstochowska 26');
  assert.ok(fs.existsSync(path.join(folderKlienta, 'Grupa pompowa.pdf')));
});

test('POST /api/run: sheetName wskazujacy na nieistniejacy arkusz zwraca czytelny blad', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-zly-arkusz-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await fsp.mkdir(path.join(root, 'Projekty'), { recursive: true });

  const { file: excelFile, dir: xlsxDir } = await napiszArkuszPV('PV_', [
    [41, 'Wierzchlas, Częstochowska 26', '2/250', '', 2.85, 'Trójfazowe']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const server = kkApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const form = new FormData();
  form.append('excel', new Blob([await fsp.readFile(excelFile)]), 'dane.xlsx');
  form.append('sheetName', 'Nie-istnieje');
  form.append('rootPath', root);
  form.append('typ', 'solary');
  form.append('dryRun', 'false');

  const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.match(data.message, /Nie-istnieje/);
});

test('POST /api/run: typ="audyty" dziala dla folderu BEZ wrappera "Projekty" i BEZ numeru ID w nazwie (realny przypadek zgloszony przez wlasciciela 2026-08-19 - eksport plaskich folderow adresowych "Broników 28" itp. wprost pod rootPath)', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-plaski-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  // Foldery adresowe WPROST pod rootPath - zaden "Projekty", zaden numer ID.
  await fsp.mkdir(path.join(root, 'Broników 28'), { recursive: true });
  await fsp.mkdir(path.join(root, 'Jajczaki 11a'), { recursive: true });

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-http-plaski-'));
  t.after(() => fsp.rm(workDir, { recursive: true, force: true }));
  const audytyZip = new AdmZip();
  audytyZip.addFile('PV/Broników 28_PV.pdf', Buffer.from('audyt-tresc'));
  const audytyZipPath = path.join(workDir, 'audyty.zip');
  audytyZip.writeZip(audytyZipPath);

  const { file: excelFile, dir: xlsxDir } = await napiszArkuszPV('PV_', [
    [1, 'Broników 28', '2/250', '', 2.85, 'Trójfazowe'],
    [2, 'Jajczaki 11a', '2/250', '', 2.85, 'Trójfazowe'] // brak audytu dla tego adresu -> 'brak', nie blad
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const server = kkApp.listen(0, '127.0.0.1');
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const form = new FormData();
  form.append('excel', new Blob([await fsp.readFile(excelFile)]), 'dane.xlsx');
  form.append('audytyZip', new Blob([await fsp.readFile(audytyZipPath)]), 'audyty.zip');
  form.append('sheetName', 'PV_');
  form.append('rootPath', root);
  form.append('typ', 'audyty');
  form.append('dryRun', 'false');

  const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.wyniki.length, 2);
  assert.equal(data.wyniki[0].status, 'skopiowano');
  assert.equal(data.wyniki[1].status, 'brak');

  assert.equal(await fsp.readFile(path.join(root, 'Broników 28', 'Broników 28_PV.pdf'), 'utf8'), 'audyt-tresc');
});

test('dopasujFolderPoAdresie: dokladnie jedno trafienie zwraca folder, zero -> "brak", kilka -> "wieloznaczne" (nigdy nie zgaduje)', () => {
  const foldery = ['Broników 28', 'Jajczaki 11a', 'Jajczaki 1A'];
  assert.deepEqual(dopasujFolderPoAdresie('Broników 28', foldery), { folder: 'Broników 28' });
  assert.deepEqual(dopasujFolderPoAdresie('Nieistniejąca 99', foldery), { blad: 'brak' });
  const wynik = dopasujFolderPoAdresie('Jajczaki', foldery);
  assert.equal(wynik.blad, 'wieloznaczne');
  assert.deepEqual(wynik.kandydaci.sort(), ['Jajczaki 11a', 'Jajczaki 1A'].sort());
});
