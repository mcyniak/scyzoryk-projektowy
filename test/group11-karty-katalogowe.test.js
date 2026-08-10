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
const { przetworzArkusz, adresPasujeDoFolderu, parseIdFolderu } = require('../apps/karty-katalogowe/server');

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

test('adresPasujeDoFolderu: kod pocztowy w adresie z Excela nie blokuje dopasowania (real bug zlapany na produkcji z prawdziwego raportu)', () => {
  // Audyt: kod pocztowy + gmina na koncu adresu z Excela ("26-330 Zarnow")
  // dokladaly tokeny, ktore NIGDY nie wystepuja w nazwie folderu - to
  // podnosilo wymagany prog dopasowania (60% z wiekszej liczby tokenow) na
  // tyle, ze w prawdziwym raporcie uzytkownika niemal KAZDY wiersz z kodem
  // pocztowym w adresie dostawal falszywy "mozliwy konflikt numeracji",
  // mimo ze ulica+numer w pelni sie zgadzaly z folderem (np. "Nadole 21A" vs
  // folder "Nadole 21a").
  assert.equal(adresPasujeDoFolderu('Nadole 21A, 26-330 Zarnow', '10 - Nadole 21a'), true);
  assert.equal(adresPasujeDoFolderu('Paszkowice 86, 26-330 Zarnow', '12 - Paszkowice 86'), true);
  // Faktyczny numeracyjny konflikt (rozna ulica) nadal musi zostac wykryty -
  // usuwanie kodu pocztowego nie moze uczynic dopasowania zbyt tolerancyjnym.
  assert.equal(adresPasujeDoFolderu('Inna Wies 5, 26-330 Zarnow', '10 - Nadole 21a'), false);
});

test('adresPasujeDoFolderu: adnotacja "korekta adresu" ze STARYM adresem nadal pasuje do jeszcze-nieprzemianowanego folderu (real bug zlapany na produkcji)', () => {
  // Audyt: "Przylek 72B (korekta adresu ul. Polna 12 Przylek)" - stary adres
  // w nawiasie WCIAZ pasuje do folderu, ktory jeszcze nie zostal
  // przemianowany po korekcie (normalny, oczekiwany stan) - ale slowa samej
  // adnotacji ("korekta", "adresu") liczyly sie jako dodatkowe tokeny,
  // podnoszac wymagany prog dopasowania na tyle, ze prawdziwe trafienie
  // (ulica+numer starego adresu) przestawalo wystarczac.
  assert.equal(
    adresPasujeDoFolderu('Przylek 72B (korekta adresu ul. Polna 12 Przylek)', '10 - Przylek, ul. Polna 12'),
    true
  );
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
